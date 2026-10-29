Option Explicit

' OneCast launcher: opens onecast.html in a chromeless app window.
' Edit nothing here. Move the whole folder together if you relocate it.

Dim fso, sh, base, pagePath, url, exePath, list, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
pagePath = base & "\onecast.html"

If Not fso.FileExists(pagePath) Then
  MsgBox "onecast.html was not found next to this launcher." & vbCrLf & vbCrLf & _
         "Keep the launcher and onecast.html in the same folder.", 16, "OneCast"
  WScript.Quit 1
End If

url = "file:///" & Replace(pagePath, "\", "/")

list = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe" )

exePath = ""
For i = 0 To UBound(list)
  If fso.FileExists(list(i)) Then
    exePath = list(i)
    Exit For
  End If
Next

If exePath <> "" Then
  sh.Run """" & exePath & """ --app=""" & url & """", 1, False
Else
  ' No Edge or Chrome found: fall back to the default browser.
  sh.Run """" & url & """", 1, False
End If
