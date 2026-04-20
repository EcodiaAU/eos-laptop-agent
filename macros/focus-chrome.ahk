#Requires AutoHotkey v2.0
; Description: Bring Chrome window to foreground
WinActivate "ahk_class Chrome_WidgetWin_1"
WinWaitActive "ahk_class Chrome_WidgetWin_1",, 3