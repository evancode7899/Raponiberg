# Creates the one Desktop shortcut, "Raponiberg": it starts the local server with no console
# window (pulling the latest code first when the server isn't running) and opens the app in
# your browser. The app's power button shuts it down. Shortcuts from older versions (Start /
# Stop / Update) are removed.
# Run from PowerShell: powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartVbsPath = Join-Path $PSScriptRoot "start-local-server.vbs"
$IconPath = Join-Path $PSScriptRoot "assets\app-icon.ico"
$WScriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
$Desktop = [Environment]::GetFolderPath("Desktop")

foreach ($old in @("Personal Finance Web App.lnk", "Personal Finance Web App - Stop.lnk", "Personal Finance Web App - Update.lnk")) {
  $path = Join-Path $Desktop $old
  if (Test-Path $path) {
    Remove-Item $path -Force
    Write-Host "Removed: $path"
  }
}

$WshShell = New-Object -ComObject WScript.Shell
$ShortcutPath = Join-Path $Desktop "Raponiberg.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $WScriptPath
$Shortcut.Arguments = "`"$StartVbsPath`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.IconLocation = "$IconPath,0"
$Shortcut.Description = "Open Raponiberg (updates from GitHub when it starts; close it with the app's power button)"
$Shortcut.Save()

Write-Host "Created: $ShortcutPath"
