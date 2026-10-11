' Launches start-local-server.ps1 with no visible console window.
' Any arguments passed to this script (e.g. -NoBrowser) are forwarded to the PowerShell script.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psPath = scriptDir & "\start-local-server.ps1"

extraArgs = ""
For i = 0 To WScript.Arguments.Count - 1
  extraArgs = extraArgs & " " & WScript.Arguments(i)
Next

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & psPath & Chr(34) & extraArgs
shell.Run cmd, 0, False
