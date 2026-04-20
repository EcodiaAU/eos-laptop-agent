#Requires AutoHotkey v2.0
; Description: Open a new Chrome tab and navigate to {{url}}
WinActivate "ahk_class Chrome_WidgetWin_1"
WinWaitActive "ahk_class Chrome_WidgetWin_1",, 3
Send "^t"
Sleep 500
Send "{{url}}"
Send "{Enter}"
Sleep 2000