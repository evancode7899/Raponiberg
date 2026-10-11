# Stops the local server by finding whatever process is listening on port 3000, and the
# demo (port 3001) when it was started from this app folder.
# Run directly: powershell -ExecutionPolicy Bypass -File scripts\stop-local-server.ps1
# (npm run app:stop) A fallback for when the app won't load; normally use the power button
# in the app.

$ErrorActionPreference = "Stop"
$Port = 3000

function Show-Message([string]$Text) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  [System.Windows.Forms.MessageBox]::Show($Text, "Personal Finance Web App", "OK", "Information") | Out-Null
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$demo = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
foreach ($procId in ($demo | Select-Object -ExpandProperty OwningProcess -Unique)) {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
  if ($cmd -and $cmd -like "*$ProjectRoot*") { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
}

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
  Show-Message "The server was not running."
  exit 0
}

$connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
  Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
}

Show-Message "Server stopped."
