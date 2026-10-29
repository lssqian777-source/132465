Option Explicit

' Creates a desktop shortcut for OneCast (with the bundled icon).
' Safe to run more than once; it simply overwrites the shortcut.

Dim fso, sh, base, launcher, desktop, lnk

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = base & "\OneCast.vbs"

If Not fso.FileExists(launcher) Then
  MsgBox "Launcher not found. Keep all files in the same folder.", 16, "OneCast"
  WScript.Quit 1
End If

desktop = sh.SpecialFolders("Desktop")
Set lnk = sh.CreateShortcut(desktop & "\OneCast.lnk")

lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & launcher & """"
lnk.WorkingDirectory = base
lnk.IconLocation = base & "\onecast.ico,0"
lnk.Description = "OneCast"
lnk.WindowStyle = 1
lnk.Save

MsgBox "Desktop shortcut created: OneCast", 64, "OneCast"
