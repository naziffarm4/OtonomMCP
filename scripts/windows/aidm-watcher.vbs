' Starts the aidm watcher hidden (no console window). Usage:
'   wscript.exe aidm-watcher.vbs "D:\path\to\project1;D:\path\to\project2"
' Uses the IdP/LLM settings from the user's environment (AIDM_IDP_URL, AIDM_IDP_CLIENT_TOKEN, ...).
Option Explicit
Dim sh, fso, here, js, roots
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
js = fso.GetAbsolutePathName(fso.BuildPath(here, "..\..\packages\core\dist\mcp\aidm-watcher.js"))
If WScript.Arguments.Count > 0 Then roots = WScript.Arguments(0) Else roots = sh.ExpandEnvironmentStrings("%AIDM_WATCH_ROOTS%")
sh.Environment("PROCESS")("AIDM_WATCH_ROOTS") = roots
' 0 = hidden window, False = do not wait
sh.Run "node """ & js & """", 0, False
