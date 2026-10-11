# Starts the local production server with no visible console window and opens the browser.
# Run directly: powershell -ExecutionPolicy Bypass -File scripts\start-local-server.ps1
# Or via scripts\start-local-server.vbs, which launches this hidden (used by the desktop
# shortcut and the logon scheduled task).
#
# Pass -NoBrowser to start the server without opening a browser tab (used at Windows logon).
#
# When the server isn't already running it first pulls the latest code from GitHub (see
# Test-ShouldUpdate), then brings the install up to date, doing only what changed:
# reinstall dependencies when package.json/lock changed,
# apply migrations when prisma/ changed, rebuild when the source changed. While it works a
# loading window (launcher-splash.ps1) shows each stage with a progress bar - or, at Windows
# logon (-NoBrowser), a tray notification when there's an update to apply. Every step logs
# to data\logs\ (launcher.log has the summary).

param(
  [switch]$NoBrowser,
  # Set by a launcher that just pulled an update which changed the launcher itself: it hands
  # over to the new code (see the update step) rather than finishing the start as old code.
  [switch]$JustUpdated
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectRoot "data\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LauncherLog = Join-Path $LogDir "launcher.log"
$Port = 3000
# 127.0.0.1, not localhost: the server binds IPv4 loopback only, and "localhost" resolves to
# ::1 first, where each probe hangs until its timeout, so the launcher never saw the server
# as ready (no browser tab, and a false "did not start" error after three minutes).
$Url = "http://127.0.0.1:$Port"

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
. (Join-Path $PSScriptRoot "launcher-splash.ps1")
$script:Splash = $null

function Write-Log([string]$Text) {
  Add-Content -Path $LauncherLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Text"
}

$script:Tray = $null
function Show-Progress([string]$Text) {
  if (-not $script:Tray) {
    $script:Tray = New-Object System.Windows.Forms.NotifyIcon
    $icon = Join-Path $PSScriptRoot "assets\app-icon.ico"
    $script:Tray.Icon = if (Test-Path $icon) { New-Object System.Drawing.Icon $icon } else { [System.Drawing.SystemIcons]::Information }
    $script:Tray.Text = "Personal Finance"
    $script:Tray.Visible = $true
  }
  $script:Tray.BalloonTipTitle = "Personal Finance"
  $script:Tray.BalloonTipText = $Text
  $script:Tray.ShowBalloonTip(10000)
}
function Hide-Progress {
  if ($script:Tray) {
    $script:Tray.Visible = $false
    $script:Tray.Dispose()
    $script:Tray = $null
  }
}

function Show-Message([string]$Text, [string]$Icon = "Error") {
  Write-Log "Message shown: $($Text -replace "`n", ' | ')"
  Hide-Progress
  Stop-Splash $script:Splash
  $script:Splash = $null
  [System.Windows.Forms.MessageBox]::Show($Text, "Personal Finance Web App", "OK", $Icon) | Out-Null
}

# A quick TCP check first: with nothing listening, Windows takes about 2 seconds to refuse a
# loopback connection, which held up every cold start (and the loading window) by that much.
function Test-ServerUp {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    if (-not $tcp.ConnectAsync("127.0.0.1", $Port).Wait(300)) { return $false }
  } catch {
    return $false
  } finally {
    $tcp.Close()
  }
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

# The demo (npm run demo, or "demo" typed on the lock screen) is a second copy of this app
# on port 3001. One left running holds the build folder and the database engine open, so
# it is stopped before updating. Only a listener started from this app folder is stopped.
function Stop-Demo {
  $conns = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
  foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and $cmd -like "*$ProjectRoot*") {
      Write-Log "Stopping the demo left running (process $procId)"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Open-App {
  if (-not $NoBrowser) {
    Start-Process $Url
  }
}

# Closes the loading window, after a pause long enough to read its last line.
function Close-Splash([int]$AfterMs = 0) {
  if (-not $script:Splash) { return }
  if ($AfterMs) { Start-Sleep -Milliseconds $AfterMs }
  Stop-Splash $script:Splash
  $script:Splash = $null
}

Set-Location $ProjectRoot
Write-Log "Launcher started"

# Nothing may fail silently: a hidden launcher that dies without a word looks like
# "the app won't open".
trap {
  Write-Log "Unexpected error: $_ ($($_.InvocationInfo.PositionMessage -replace "`n", ' '))"
  Show-Message "The launcher hit an unexpected error:`n$_`n`nFull logs: $LogDir"
  exit 1
}

# The window opens first thing, so a double-click gets an answer straight away, even when
# the app turns out to be running already.
if (-not $NoBrowser) {
  try {
    $script:Splash = Start-Splash (Join-Path $PSScriptRoot "assets\app-icon.ico")
    Set-SplashDetail $script:Splash "Checking whether Raponiberg is already running"
  } catch {
    Write-Log "Loading window could not open: $_"
  }
}

if (Test-ServerUp) {
  Write-Log "Server already running"
  Set-SplashStage $script:Splash "Already running" "Opening Raponiberg in your browser" 1.0 1.0 1.0
  Open-App
  Close-Splash 800
  exit 0
}

Stop-Demo

# One launcher at a time: a second double-click while the first is still updating would
# otherwise race it (two installs/builds into the same folders). The second one just
# waits for the server the first one is bringing up.
$mutex = New-Object System.Threading.Mutex($false, "Local\PersonalFinanceWebAppLauncher")
try {
  $gotLock = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # A previous launcher was killed while holding the lock; it's ours now.
  $gotLock = $true
}
if (-not $gotLock) {
  Write-Log "Another launcher is already starting the app; waiting for it"
  # That launcher's window is already showing the progress.
  Close-Splash
  for ($i = 0; $i -lt 600; $i++) {
    Start-Sleep -Seconds 1
    if (Test-ServerUp) {
      Open-App
      exit 0
    }
  }
  exit 0
}

# The loading window walks through the stages below. Each stage owns a slice of the bar
# sized by how long it took on recent launches (data\launcher\timings.json, seeded with
# typical times), so a quick start fills fast and a full rebuild paces itself over minutes.
# At logon (-NoBrowser) there's no window, but the timings are still learned.
$TimingsFile = Join-Path $ProjectRoot "data\launcher\timings.json"
New-Item -ItemType Directory -Force -Path (Split-Path $TimingsFile) | Out-Null
$script:Timings = @{ check = 4.0; install = 20.0; restore = 30.0; backup = 5.0; migrate = 10.0; build = 100.0; server = 4.0 }
try {
  foreach ($prop in (Get-Content $TimingsFile -Raw -ErrorAction Stop | ConvertFrom-Json).PSObject.Properties) {
    if ($script:Timings.ContainsKey($prop.Name)) { $script:Timings[$prop.Name] = [double]$prop.Value }
  }
} catch {}
$script:Stage = $null
$script:Slices = @{ check = @(0.0, 0.06) }
$script:Steps = @("check")

function Enter-Stage([string]$Key, [string]$Headline, [string]$Detail) {
  Exit-Stage
  $script:Stage = @{ Key = $Key; Start = Get-Date }
  if ($script:Splash -and $script:Slices.ContainsKey($Key)) {
    $slice = $script:Slices[$Key]
    # The step count isn't known until the plan is (Set-StagePlan fills it in then).
    $n = [array]::IndexOf($script:Steps, $Key) + 1
    $step = if ($script:Steps.Count -gt 1) { "Step $n of $($script:Steps.Count)" } else { "" }
    Set-SplashStage $script:Splash $Headline $Detail $slice[0] $slice[1] $script:Timings[$Key] $step
  }
}

# Records how long the finished stage took, averaged with earlier launches so one unusually
# slow start doesn't throw off the next estimate.
function Exit-Stage {
  if (-not $script:Stage) { return }
  $k = $script:Stage.Key
  $secs = ((Get-Date) - $script:Stage.Start).TotalSeconds
  $script:Timings[$k] = [Math]::Round(($script:Timings[$k] + $secs) / 2, 1)
  $script:Stage = $null
  try { $script:Timings | ConvertTo-Json | Set-Content -Path $TimingsFile } catch {}
}

# Once it's known which stages this launch runs, splits the rest of the bar between them.
function Set-StagePlan([string[]]$Keys) {
  $total = 0.0
  foreach ($k in $Keys) { $total += [Math]::Max(1.0, $script:Timings[$k]) }
  $at = $script:Slices["check"][1]
  foreach ($k in $Keys) {
    $next = $at + (1.0 - $script:Slices["check"][1]) * [Math]::Max(1.0, $script:Timings[$k]) / $total
    $script:Slices[$k] = @($at, $next)
    $at = $next
  }
  $script:Steps = @("check") + $Keys
  if ($script:Splash) { $script:Splash.Step = "Step 1 of $($script:Steps.Count)" }
}

# One joke per build, picked at random from scripts\assets\loading-lines.txt; the window
# shows it for a few seconds once the bar is halfway through the build.
function Set-BuildJoke {
  if (-not $script:Splash -or -not $script:Slices.ContainsKey("build")) { return }
  $lines = @(Get-Content (Join-Path $PSScriptRoot "assets\loading-lines.txt") -Encoding UTF8 -ErrorAction SilentlyContinue |
    Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith("#") })
  if (-not $lines.Count) { return }
  $build = $script:Slices["build"]
  $script:Splash.JokeAt = $build[0] + ($build[1] - $build[0]) / 2
  $script:Splash.Joke = (Get-Random -InputObject $lines).Trim()
}

Enter-Stage "check" "Checking for updates" "Asking GitHub for the latest version"

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCommand) {
  Show-Message "npm was not found on PATH. Install Node.js, then try again."
  exit 1
}

# Updates arrive on a cold start: closing the app with its power button and opening it
# again pulls the latest code from GitHub, and the steps below install, migrate and
# rebuild whatever changed. Fast-forward only, so local work is never overwritten; offline,
# a failed pull or a skipped update all just start the version already here.
# Pulls only on main with no uncommitted edits to tracked files, so work in progress in this
# folder is never moved; RAPONIBERG_NO_UPDATE=1 stays on the current version. Skips are logged.
function Test-ShouldUpdate {
  if ($env:RAPONIBERG_NO_UPDATE) { Write-Log "Update: skipped (RAPONIBERG_NO_UPDATE is set)"; return $false }
  $branch = (& $git.Source -C $ProjectRoot rev-parse --abbrev-ref HEAD 2>$null)
  if ($branch -ne "main") { Write-Log "Update: skipped (on branch '$branch', not main)"; return $false }
  $dirty = (& $git.Source -C $ProjectRoot status --porcelain --untracked-files=no 2>$null)
  if ($dirty) { Write-Log "Update: skipped (uncommitted changes to tracked files)"; return $false }
  return $true
}

$script:Updated = $false
$git = Get-Command git -ErrorAction SilentlyContinue
if ($JustUpdated) {
  # The previous launcher already pulled (and is handing over); the backup before the
  # update still needs to happen, here.
  Write-Log "Update: continuing in the updated launcher"
  $script:Updated = $true
  Set-SplashDetail $script:Splash "Downloaded the latest version"
} elseif ($git -and (Test-Path (Join-Path $ProjectRoot ".git")) -and (Test-ShouldUpdate)) {
  $env:GIT_TERMINAL_PROMPT = "0"
  $before = (& $git.Source rev-parse HEAD 2>$null)
  $pull = Start-Process -FilePath $git.Source -ArgumentList "pull", "--ff-only" -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "update.out.log") -RedirectStandardError (Join-Path $LogDir "update.err.log")
  $null = $pull.Handle  # keeps ExitCode readable after the process ends
  if (-not $pull.WaitForExit(60000)) {
    Stop-Process -Id $pull.Id -Force -ErrorAction SilentlyContinue
    Write-Log "Update: git pull took over 60 seconds; starting the version already here"
    Set-SplashDetail $script:Splash "GitHub didn't answer in time; starting the version already here"
  } elseif ($pull.ExitCode -ne 0) {
    Write-Log "Update: git pull failed (exit $($pull.ExitCode)); starting the version already here (see update.err.log)"
    Set-SplashDetail $script:Splash "Couldn't reach GitHub; starting the version already here"
  } else {
    $after = (& $git.Source rev-parse HEAD 2>$null)
    if ($after -ne $before) {
      Write-Log "Update: $before -> $after"
      $script:Updated = $true
      Set-SplashDetail $script:Splash "Downloaded the latest version"
      # This script is already loaded, so finishing the start would run the old launcher
      # and leave the new one's changes (its loading window, the first time) for the next
      # start. When the update touched the launcher, start the new one and step aside; the
      # new window comes up over this one before this one closes.
      $launcherChanged = & $git.Source -C $ProjectRoot diff --name-only $before $after -- `
        "scripts/start-local-server.ps1" "scripts/launcher-splash.ps1" 2>$null
      # A new launcher that doesn't even parse would die without a word, so that one is
      # skipped and this start carries on as the old code.
      $parseErrors = 0
      foreach ($f in @($PSCommandPath, (Join-Path $PSScriptRoot "launcher-splash.ps1"))) {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs) | Out-Null
        $parseErrors += @($errs).Count
      }
      if ($launcherChanged -and $parseErrors) {
        Write-Log "Update: the new launcher has $parseErrors parse error(s); finishing this start with the old one"
      } elseif ($launcherChanged) {
        Write-Log "Update: the launcher changed; restarting it"
        $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$PSCommandPath`"", "-JustUpdated")
        if ($NoBrowser) { $relaunch += "-NoBrowser" }
        $mutex.ReleaseMutex()
        Start-Process -FilePath "powershell.exe" -ArgumentList $relaunch -WindowStyle Hidden
        Close-Splash 1500
        exit 0
      }
    } else {
      Write-Log "Update: already up to date"
      Set-SplashDetail $script:Splash "Already on the latest version"
    }
  }
} else {
  Set-SplashDetail $script:Splash "Skipping the update check; using the version already here"
}

# Runs one hidden npm step with its own log files; on failure shows the error lines and
# exits (or, with -AllowFailure, returns $false). Files locked by another running copy of
# the app (a dev server, an old server that didn't stop) are the usual cause, so that
# gets a specific hint.
# -Watch, if given, is called with the output log's path every half second while it runs.
function Invoke-Npm([string]$Step, [string[]]$NpmArgs, [string]$Failure, [switch]$AllowFailure, [scriptblock]$Watch) {
  $out = Join-Path $LogDir "$Step.out.log"
  $err = Join-Path $LogDir "$Step.err.log"
  Write-Log "Step '$Step': npm $($NpmArgs -join ' ')"
  $p = Start-Process -FilePath $npmCommand.Source -ArgumentList $NpmArgs `
    -WorkingDirectory $ProjectRoot -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  $null = $p.Handle  # keeps ExitCode readable after the process ends
  while (-not $p.WaitForExit(500)) {
    if ($Watch) { & $Watch $out }
  }
  if ($p.ExitCode -ne 0) {
    Write-Log "Step '$Step' failed with exit code $($p.ExitCode)"
    if ($AllowFailure) { return $false }
    $tail = @()
    foreach ($f in @($err, $out)) {
      if (Test-Path $f) { $tail += Get-Content $f -Tail 12 }
    }
    $text = ($tail | Where-Object { $_.Trim() }) -join "`n"
    $hint = ""
    if ($text -match "EPERM|EBUSY|operation not permitted|being used by another process") {
      $hint = "`n`nSome files are in use by another copy of the app (e.g. a dev server or an old server). Use the 'Stop' shortcut or close it, then try again."
    }
    Show-Message "$Failure$hint`n`nLast lines of the log:`n$text`n`nFull logs: $LogDir"
    exit 1
  }
  Write-Log "Step '$Step' done"
  return $true
}

# Deletes a folder, retrying for a while: files can stay locked for a few seconds after a
# server stops, or while OneDrive syncs a fresh build. `rmdir` also copes with OneDrive's
# cloud-placeholder reparse points, which Remove-Item and Node's rm can trip on.
function Remove-Folder([string]$Dir) {
  for ($try = 0; ($try -lt 15) -and (Test-Path $Dir); $try++) {
    cmd.exe /c "rmdir /s /q `"$Dir`" 2>nul" | Out-Null
    if (Test-Path $Dir) { Start-Sleep -Seconds 2 }
  }
  return -not (Test-Path $Dir)
}

# Fingerprint (file count + newest write time) of a set of files and folders. Files are
# read directly: `Get-ChildItem -Path package.json -Recurse` would treat the name as a
# filter and crawl all of node_modules, which made every launch take minutes.
function Get-Stamp([string[]]$Paths) {
  $files = foreach ($p in $Paths) {
    $full = Join-Path $ProjectRoot $p
    if (Test-Path -LiteralPath $full -PathType Leaf) {
      Get-Item -LiteralPath $full
    } elseif (Test-Path -LiteralPath $full -PathType Container) {
      Get-ChildItem -LiteralPath $full -Recurse -File -ErrorAction SilentlyContinue
    }
  }
  $newest = ($files | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
  return "$($files.Count)|$($newest.Ticks)"
}

# The production build lives in its own folder (next.config.ts reads NEXT_BUILD_DIR), so a
# dev server working in this folder (which uses .next) and the app you open never
# overwrite each other. Every npm step below, including `next start`, inherits this.
$AppBuildName = ".next-app"
$AppBuildDir = Join-Path $ProjectRoot $AppBuildName
$env:NEXT_BUILD_DIR = $AppBuildName

$StampDir = Join-Path $ProjectRoot "data\launcher"
New-Item -ItemType Directory -Force -Path $StampDir | Out-Null
function Test-Stamp([string]$Name, [string]$Value) {
  $f = Join-Path $StampDir "$Name.stamp"
  return (Test-Path $f) -and ((Get-Content $f -Raw).Trim() -eq $Value)
}
function Save-Stamp([string]$Name, [string]$Value) {
  Set-Content -Path (Join-Path $StampDir "$Name.stamp") -Value $Value
}

# Dependencies are fingerprinted by content: `npm install` rewrites package-lock.json
# (same content, new timestamp), which would otherwise force a reinstall on every launch.
function Get-ContentStamp([string[]]$Paths) {
  ($Paths | ForEach-Object {
    $full = Join-Path $ProjectRoot $_
    if (Test-Path -LiteralPath $full -PathType Leaf) { (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash } else { "missing" }
  }) -join "|"
}

$depsStamp = Get-ContentStamp @("package.json", "package-lock.json")
$schemaStamp = Get-Stamp @("prisma")
$sourceStamp = "$depsStamp|$(Get-Stamp @("next.config.ts", "prisma", "src", "scripts\seed-categories.mjs"))"

$needInstall = -not (Test-Path (Join-Path $ProjectRoot "node_modules\.bin\next.cmd")) -or -not (Test-Stamp "deps" $depsStamp)
$needMigrate = $needInstall -or -not (Test-Stamp "schema" $schemaStamp)
$needBuild = $needMigrate -or -not (Test-Path (Join-Path $AppBuildDir "BUILD_ID")) -or -not (Test-Stamp "build" $sourceStamp)
Write-Log "Up to date? dependencies: $(-not $needInstall), database: $(-not $needMigrate), build: $(-not $needBuild)"

# No database means a restore from the backup, which in turn needs a migrate and a build.
$needRestore = -not (Test-Path (Join-Path $ProjectRoot "data\finance.db"))
$plan = @()
if ($needInstall) { $plan += "install" }
if ($needRestore) { $plan += "restore" }
if ($script:Updated -and -not $needRestore) { $plan += "backup" }
if ($needMigrate -or $needRestore) { $plan += "migrate" }
if ($needBuild -or $needRestore) { $plan += "build" }
Set-StagePlan ($plan + "server")
Set-BuildJoke

if (($needInstall -or $needMigrate -or $needBuild) -and -not $script:Splash) {
  Show-Progress "Updating the app after a change - this takes a couple of minutes. Your browser opens when it's ready."
}

if ($needInstall) {
  Enter-Stage "install" "Installing dependencies" "Running npm install - the app's packages changed"
  Invoke-Npm "install" @("install") "Installing dependencies (npm install) failed." | Out-Null
  Save-Stamp "deps" $depsStamp
}
# A new or wiped computer: create .env, and bring the data back from the OneDrive backup
# before the first migration would create an empty database. No backup folder or no
# snapshot is not an error (a brand-new install starts empty); a broken one stops here.
if (-not (Test-Path (Join-Path $ProjectRoot ".env"))) {
  Copy-Item (Join-Path $ProjectRoot ".env.example") (Join-Path $ProjectRoot ".env")
  Write-Log "Created .env from .env.example"
}
if ($needRestore) {
  Enter-Stage "restore" "Restoring your data" "Copying the latest backup from OneDrive"
  if (-not $script:Splash) { Show-Progress "Restoring your data from the OneDrive backup - your browser opens when it's ready." }
  Invoke-Npm "restore" @("run", "restore", "--", "--yes", "--if-available", "--no-migrate") "Restoring your data from the OneDrive backup failed. Nothing was changed." | Out-Null
  $needMigrate = $true
  $needBuild = $true
}
if ($script:Updated -and (Test-Path (Join-Path $ProjectRoot "data\finance.db"))) {
  # Back up before the new code (and its migrations) touch the data. A failed backup
  # doesn't block the start; the reason is in data\logs\backup.err.log.
  Write-Log "Backing up before the update"
  Enter-Stage "backup" "Backing up your data" "Saving a copy before the new version touches the database"
  try {
    Start-Process -FilePath (Get-Command node).Source -WorkingDirectory $ProjectRoot -WindowStyle Hidden -Wait `
      -ArgumentList @("--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts\backup.ts", "--reason", "before-update") `
      -RedirectStandardOutput (Join-Path $LogDir "backup.log") -RedirectStandardError (Join-Path $LogDir "backup.err.log")
  } catch {
    Write-Log "Backup before the update could not run: $_"
  }
}
if ($needMigrate) {
  # Applies only pending migrations, then refreshes the Prisma client.
  Enter-Stage "migrate" "Updating the database" "Applying any pending database changes"
  Invoke-Npm "migrate" @("run", "db:refresh") "Updating the database (prisma migrate deploy) failed." | Out-Null
  Save-Stamp "schema" $schemaStamp
}
# `next build` prints its milestones as it goes. Each one becomes the window's commentary
# and the least the bar may show for the build (At, a share of the build stage), so the bar
# follows the real build rather than only the clock.
$BuildMilestones = @(
  @{ Find = "Creating an optimized production build"; At = 0.02; Say = "Compiling the app's code" },
  @{ Find = "Compiled successfully|Compiled with warnings"; At = 0.42; Say = "Compiled; checking the code next" },
  @{ Find = "Linting and checking validity of types|Checking validity of types"; At = 0.44; Say = "Checking the code for type errors" },
  @{ Find = "Collecting page data"; At = 0.72; Say = "Collecting page data" },
  @{ Find = "Generating static pages"; At = 0.78; Say = "Pre-rendering pages" },
  @{ Find = "Finalizing page optimization"; At = 0.93; Say = "Finalizing page optimization" },
  @{ Find = "Collecting build traces"; At = 0.96; Say = "Collecting build traces" }
)
function Watch-Build([string]$LogPath) {
  if (-not $script:Splash) { return }
  # Opened for reading while npm still has it open for writing.
  try {
    $fs = [System.IO.File]::Open($LogPath, "Open", "Read", "ReadWrite")
    try { $text = (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)).ReadToEnd() } finally { $fs.Dispose() }
  } catch { return }
  $latest = $null
  $latestAt = -1
  foreach ($m in $BuildMilestones) {
    $hits = [regex]::Matches($text, $m.Find)
    if ($hits.Count -and $hits[$hits.Count - 1].Index -gt $latestAt) {
      $latestAt = $hits[$hits.Count - 1].Index
      $latest = $m
    }
  }
  if (-not $latest) { return }
  $at = $latest.At
  $say = $latest.Say
  $pages = [regex]::Matches($text, "Generating static pages \((\d+)/(\d+)\)")
  if ($latest.Find -eq "Generating static pages" -and $pages.Count) {
    $done = [int]$pages[$pages.Count - 1].Groups[1].Value
    $of = [int]$pages[$pages.Count - 1].Groups[2].Value
    if ($of -gt 0) {
      $at += 0.14 * $done / $of
      $say = "Pre-rendering pages ($done of $of)"
    }
  }
  Set-SplashDetail $script:Splash $say $at
}

if ($needBuild) {
  # Build into an empty staging folder and only swap it in when the build succeeds. Code
  # that's mid-edit (this folder is also where changes are being worked on) then can't
  # take the app away: a failed build keeps serving the last working version. Building
  # into an empty folder also avoids OneDrive's cloud-placeholder files from an old build,
  # which made `next build` die with "EINVAL: invalid argument, readlink".
  $StagingName = "$AppBuildName-staging"
  $StagingDir = Join-Path $ProjectRoot $StagingName
  if (-not (Remove-Folder $StagingDir)) {
    Show-Message "Could not clear the build staging folder. Close anything using it, or wait for OneDrive to finish syncing, and try again:`n$StagingDir"
    exit 1
  }
  # `next build` directly rather than `npm run build`: the Prisma client is regenerated by
  # the migrate step whenever the schema changes, and regenerating it here would fail
  # while any dev server in this folder has the Prisma engine loaded.
  $env:NEXT_BUILD_DIR = $StagingName
  Enter-Stage "build" "Building the app" "Starting the build - this is the long part"
  $built = Invoke-Npm "build" @("exec", "--", "next", "build") "Building the app (next build) failed." -AllowFailure -Watch ${function:Watch-Build}
  $env:NEXT_BUILD_DIR = $AppBuildName
  $hasPrevious = Test-Path (Join-Path $AppBuildDir "BUILD_ID")

  if ($built) {
    Write-Log "Swapping the new build into $AppBuildName"
    if (-not (Remove-Folder $AppBuildDir)) {
      Show-Message "Could not replace the old build folder. Close anything using it, or wait for OneDrive to finish syncing, and try again:`n$AppBuildDir"
      exit 1
    }
    Rename-Item -LiteralPath $StagingDir -NewName $AppBuildName
    Save-Stamp "build" $sourceStamp
  } elseif ($hasPrevious) {
    # Leave the stamp alone so the next launch tries the new code again.
    Write-Log "Build failed; starting the last working build instead"
    Set-SplashDetail $script:Splash "The new code doesn't build yet; opening the last working version"
    Remove-Folder $StagingDir | Out-Null
    $script:BuildFailedNotice = "Opened the last working version. The latest code changes don't build yet (details: $LogDir\build.out.log)."
  } else {
    $tail = (Get-Content (Join-Path $LogDir "build.out.log") -Tail 12 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }) -join "`n"
    Show-Message "Building the app (next build) failed, and there is no earlier working build to fall back on.`n`nLast lines of the log:`n$tail`n`nFull logs: $LogDir"
    exit 1
  }
}

Write-Log "Starting server"
Enter-Stage "server" "Starting the server" "Waiting for the app to answer at $Url"
Start-Process -FilePath $npmCommand.Source -ArgumentList "run", "start" `
  -WorkingDirectory $ProjectRoot -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir "server.out.log") `
  -RedirectStandardError (Join-Path $LogDir "server.err.log") | Out-Null

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-ServerUp) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Write-Log "Server did not answer within 60 seconds"
  $err = Join-Path $LogDir "server.err.log"
  $tail = if (Test-Path $err) { (Get-Content $err -Tail 12) -join "`n" } else { "" }
  Show-Message "The server did not start within 60 seconds.`n`n$tail`n`nFull logs: $LogDir"
  exit 1
}

Write-Log "Server ready"
Exit-Stage
Set-SplashStage $script:Splash "Ready" "Opening Raponiberg in your browser" 1.0 1.0 1.0
Open-App
# Long enough to see the bar finish before the browser comes up over it.
Close-Splash 1200
if ($script:BuildFailedNotice) {
  Show-Progress $script:BuildFailedNotice
  Start-Sleep -Seconds 8
}
Hide-Progress
$mutex.ReleaseMutex()
