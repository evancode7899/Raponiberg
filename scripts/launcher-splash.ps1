# The loading window start-local-server.ps1 shows while it updates, builds and starts the
# app. Dot-sourced by the launcher.
#
# The window runs on its own thread (a separate runspace with its own message loop): the
# launcher's steps block its thread for minutes at a time, which would freeze a window
# living there. The two share one synchronized hashtable. The launcher writes which stage
# it's in, the slice of the bar that stage owns, how long the stage took last time, and
# any real progress it has seen (build milestones); the window animates the bar inside
# that slice on its own, so it keeps moving while a step is busy.

$SplashWindowScript = {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    # Crisp text on scaled displays (125%, 150%) instead of a blurry stretched bitmap.
    try {
      Add-Type -Namespace Raponiberg -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
      [void][Raponiberg.Dpi]::SetProcessDPIAware()
    } catch {}
    [System.Windows.Forms.Application]::EnableVisualStyles()

    # Same palette as the app (src/app/globals.css), following Windows' light/dark setting.
    $dark = $false
    try {
      $dark = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" -ErrorAction Stop).AppsUseLightTheme -eq 0
    } catch {}
    $p = if ($dark) {
      @{ Bg = "#1a1a19"; Fg = "#f4f4f1"; Muted = "#a3a29a"; Track = "#2c2c2a"; Line = "#45453f"; Accent = "#f08a4b" }
    } else {
      @{ Bg = "#ffffff"; Fg = "#111110"; Muted = "#6b6a66"; Track = "#ececea"; Line = "#c9c9c3"; Accent = "#c2410c" }
    }
    $color = @{}
    foreach ($k in $p.Keys) { $color[$k] = [System.Drawing.ColorTranslator]::FromHtml($p[$k]) }

    $form = New-Object System.Windows.Forms.Form
    $form.SuspendLayout()
    $form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
    $form.AutoScaleMode = "Dpi"
    $form.FormBorderStyle = "None"
    $form.StartPosition = "CenterScreen"
    $form.ClientSize = New-Object System.Drawing.Size(460, 142)
    $form.BackColor = $color.Bg
    $form.ForeColor = $color.Fg
    $form.ShowInTaskbar = $true
    $form.Text = "Raponiberg - starting"
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    if ($iconPath -and (Test-Path $iconPath)) { $form.Icon = New-Object System.Drawing.Icon $iconPath }
    $form.Add_Paint({
      param($s, $e)
      $pen = New-Object System.Drawing.Pen $color.Line
      $e.Graphics.DrawRectangle($pen, 0, 0, $s.ClientSize.Width - 1, $s.ClientSize.Height - 1)
      $pen.Dispose()
    })

    function New-Label($Text, $X, $Y, $W, $H, $Font, $Fore, $Align = "TopLeft") {
      $l = New-Object System.Windows.Forms.Label
      $l.Text = $Text
      $l.Location = New-Object System.Drawing.Point($X, $Y)
      $l.Size = New-Object System.Drawing.Size($W, $H)
      $l.Font = $Font
      $l.ForeColor = $Fore
      $l.BackColor = $color.Bg
      $l.TextAlign = $Align
      $l.AutoEllipsis = $true
      $form.Controls.Add($l)
      return $l
    }

    if ($iconPath -and (Test-Path $iconPath)) {
      $pic = New-Object System.Windows.Forms.PictureBox
      $pic.Location = New-Object System.Drawing.Point(24, 24)
      $pic.Size = New-Object System.Drawing.Size(32, 32)
      $pic.SizeMode = "Zoom"
      $pic.Image = (New-Object System.Drawing.Icon($iconPath, 64, 64)).ToBitmap()
      $form.Controls.Add($pic)
    }
    $title = New-Label "Raponiberg" 68 20 250 22 (New-Object System.Drawing.Font("Segoe UI Semibold", 11)) $color.Fg
    $headline = New-Label $sync.Headline 68 42 300 20 (New-Object System.Drawing.Font("Segoe UI", 9.5)) $color.Fg
    $step = New-Label "" 300 22 136 18 $form.Font $color.Muted "TopRight"
    $detail = New-Label $sync.Detail 24 100 340 20 $form.Font $color.Muted
    $pct = New-Label "0%" 366 100 70 20 $form.Font $color.Muted "TopRight"

    $track = New-Object System.Windows.Forms.Panel
    $track.Location = New-Object System.Drawing.Point(24, 82)
    $track.Size = New-Object System.Drawing.Size(412, 6)
    $track.BackColor = $color.Track
    $fill = New-Object System.Windows.Forms.Panel
    $fill.Location = New-Object System.Drawing.Point(0, 0)
    $fill.Size = New-Object System.Drawing.Size(0, 6)
    $fill.BackColor = $color.Accent
    $track.Controls.Add($fill)
    $form.Controls.Add($track)

    # Hides the window only; the launcher carries on and the browser still opens.
    $close = New-Label ([string][char]0x2715) 436 4 20 20 $form.Font $color.Muted "MiddleCenter"
    $close.Cursor = [System.Windows.Forms.Cursors]::Hand
    $close.Add_Click({ $form.Hide() })
    $form.ResumeLayout()

    $script:shown = 0.0
    $script:jokeStart = $null
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 40
    $timer.Add_Tick({
      $now = [DateTime]::UtcNow
      # A launcher that died without closing the window must not leave it up forever.
      if ($sync.Close -or ($now - $sync.Started).TotalMinutes -gt 20) {
        $timer.Stop()
        $form.Close()
        return
      }
      # Inside its slice the bar eases toward the stage's usual length (80% of the slice
      # at the usual time, never past 95%), and never falls behind real progress (Floor).
      $t = ($now - $sync.StageStart).TotalSeconds
      $usual = [Math]::Max(1.0, [double]$sync.Seconds)
      $byTime = [Math]::Min(0.95, 1 - [Math]::Exp(-1.6 * $t / $usual))
      $frac = [Math]::Max($byTime, [double]$sync.Floor)
      $target = [double]$sync.From + ([double]$sync.To - [double]$sync.From) * $frac
      if ($target -gt $script:shown) { $script:shown += [Math]::Max(0.001, ($target - $script:shown) * 0.12) }
      if ($script:shown -gt $target) { $script:shown = $target }
      $fill.Width = [int]($track.ClientSize.Width * $script:shown)
      $pct.Text = "{0}%" -f [int][Math]::Floor($script:shown * 100)
      if ($headline.Text -ne $sync.Headline) { $headline.Text = $sync.Headline }
      # The build's joke line takes over the commentary for a few seconds once the bar
      # passes JokeAt, then the real commentary comes back. It looks exactly like the real
      # commentary on purpose: deadpan is funnier than a line that announces it's a joke.
      $jokeOn = $false
      if ($sync.Joke -and $script:shown -ge [double]$sync.JokeAt) {
        if (-not $script:jokeStart) { $script:jokeStart = $now }
        $jokeOn = ($now - $script:jokeStart).TotalSeconds -lt 6
      }
      $text = if ($jokeOn) { $sync.Joke } else { $sync.Detail }
      if ($detail.Text -ne $text) { $detail.Text = $text }
      $elapsed = [int]($now - $sync.Started).TotalSeconds
      $clock = "{0}:{1:00}" -f [Math]::Floor($elapsed / 60), ($elapsed % 60)
      $stepText = if ($sync.Step) { "$($sync.Step)  $([char]0x00B7)  $clock" } else { $clock }
      if ($step.Text -ne $stepText) { $step.Text = $stepText }
    })
    # Windows won't let a hidden background process take the foreground (the window would
    # open behind whatever you're looking at), so it stays on top; drag it aside, or the x
    # hides it.
    $form.TopMost = $true
    $script:dragFrom = $null
    $onDown = { param($s, $e) if ($e.Button -eq "Left") { $script:dragFrom = [System.Windows.Forms.Cursor]::Position; $script:formFrom = $form.Location } }
    $onMove = {
      if ($script:dragFrom) {
        $c = [System.Windows.Forms.Cursor]::Position
        $form.Location = New-Object System.Drawing.Point(($script:formFrom.X + $c.X - $script:dragFrom.X), ($script:formFrom.Y + $c.Y - $script:dragFrom.Y))
      }
    }
    $onUp = { $script:dragFrom = $null }
    foreach ($ctl in @($form) + @($form.Controls | Where-Object { $_ -ne $close })) {
      $ctl.Add_MouseDown($onDown)
      $ctl.Add_MouseMove($onMove)
      $ctl.Add_MouseUp($onUp)
    }
    $form.Add_Shown({
      $form.Activate()
      $sync.Shown = $true
      $timer.Start()
    })
    [System.Windows.Forms.Application]::Run($form)
  } catch {
    $sync.Error = "$_"
  }
}

function Start-Splash([string]$IconPath) {
  $now = [DateTime]::UtcNow
  $sync = [hashtable]::Synchronized(@{
    Headline = "Starting up"; Detail = "Getting ready"; Step = ""
    From = 0.0; To = 0.0; Seconds = 1.0; Floor = 0.0
    StageStart = $now; Started = $now; Close = $false
  })
  $rs = [runspacefactory]::CreateRunspace()
  $rs.ApartmentState = "STA"
  $rs.ThreadOptions = "ReuseThread"
  $rs.Open()
  $rs.SessionStateProxy.SetVariable("sync", $sync)
  $rs.SessionStateProxy.SetVariable("iconPath", $IconPath)
  $ps = [powershell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($SplashWindowScript.ToString())
  $sync.Async = $ps.BeginInvoke()
  $sync.PowerShell = $ps
  return $sync
}

# Moves the window to a new stage: its own slice of the bar [From, To], how many seconds
# it usually takes, and what to say.
function Set-SplashStage($Sync, [string]$Headline, [string]$Detail, [double]$From, [double]$To, [double]$Seconds, [string]$Step = "") {
  if (-not $Sync) { return }
  $Sync.Floor = 0.0
  $Sync.From = $From
  $Sync.To = $To
  $Sync.Seconds = $Seconds
  $Sync.StageStart = [DateTime]::UtcNow
  $Sync.Headline = $Headline
  $Sync.Detail = $Detail
  $Sync.Step = $Step
}

# Real progress within the current stage (0..1) and/or new commentary.
function Set-SplashDetail($Sync, [string]$Detail, [double]$Floor = -1) {
  if (-not $Sync) { return }
  if ($Detail) { $Sync.Detail = $Detail }
  if ($Floor -ge 0 -and $Floor -gt [double]$Sync.Floor) { $Sync.Floor = [Math]::Min(1.0, $Floor) }
}

function Stop-Splash($Sync) {
  if (-not $Sync) { return }
  $Sync.Close = $true
  try {
    if ($Sync.Async.AsyncWaitHandle.WaitOne(3000)) { $Sync.PowerShell.EndInvoke($Sync.Async) | Out-Null }
    $Sync.PowerShell.Runspace.Close()
    $Sync.PowerShell.Dispose()
  } catch {}
}
