# Registers a scheduled task to start the local server (no console window, no browser
# popup) when you sign in to Windows. Open the app any time via the desktop shortcut,
# or by visiting http://127.0.0.1:3000.
# Run from PowerShell: powershell -ExecutionPolicy Bypass -File scripts\register-logon-task.ps1
# To remove: Unregister-ScheduledTask -TaskName "PersonalFinanceLocalServer" -Confirm:$false

$ErrorActionPreference = "Stop"
$TaskName = "PersonalFinanceLocalServer"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartVbsPath = Join-Path $PSScriptRoot "start-local-server.vbs"
$WScriptPath = Join-Path $env:WINDIR "System32\wscript.exe"

if (-not (Test-Path $StartVbsPath)) {
  throw "Missing: $StartVbsPath"
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction -Execute $WScriptPath -Argument "`"$StartVbsPath`" -NoBrowser" -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null

Write-Host "Registered scheduled task: $TaskName (runs at logon for $env:USERNAME, no browser popup)"
Write-Host "Task Scheduler: taskschd.msc -> find $TaskName to disable or edit."
