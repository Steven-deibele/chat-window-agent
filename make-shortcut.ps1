# make-shortcut.ps1 — creates a Desktop shortcut that opens the settings GUI
# (run.bat gui) with a MINIMIZED console. Replaces the old chat-window-agent.vbs:
# VBScript spawning a hidden command shell is a classic malware-dropper pattern
# and endpoint protection (CrowdStrike Falcon, ...) blocks it.
# Run once, visibly:  powershell -File make-shortcut.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'chat-window-agent.lnk'
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $root 'run.bat'
$sc.Arguments = 'gui'
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7  # minimized console
$sc.Description = 'chat-window-agent settings window'
$sc.Save()
Write-Host "created $lnk"
