' chat-window-agent.vbs — double-click launcher: opens the settings window
' (src/gui.js) with no console/terminal window. Equivalent to "run.bat gui".
' First run may take a minute while dependencies install (hidden); the
' settings window opens in your browser when ready.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c run.bat gui", 0, False
