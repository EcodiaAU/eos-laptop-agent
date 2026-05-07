#Requires AutoHotkey v2.0
; ============================================================================
; macro-recorder.ahk : EcodiaOS macro recorder v2 (Worker B1 deliverable)
; ----------------------------------------------------------------------------
; Hotkey: Ctrl+Shift+R toggles record / stop.
; Output: D:\.code\macro-recordings\<session_id>\events.jsonl + manifest.json + frames\
; Privacy: D:\.code\eos-laptop-agent\macros\privacy-denylist.json (loaded at record-start)
; Sibling tools (graceful degradation if missing):
;   D:\.code\eos-laptop-agent\macros\uia-probe.ps1     -- B2 (UIA tree walker)
;   D:\.code\eos-laptop-agent\macros\post-process.bat  -- B3 (recipe emitter)
; ============================================================================

#SingleInstance Force
SendMode "Input"
SetWorkingDir A_ScriptDir
Persistent

; ---------- Globals ----------
global g_Recording        := false
global g_SessionId        := ""
global g_SessionDir       := ""
global g_FramesDir        := ""
global g_EventsFile       := ""
global g_ManifestFile     := ""
global g_EventIndex       := 0
global g_DenylistHits     := 0
global g_StartIso         := ""
global g_DenyExe          := []
global g_DenyUrlSubstr    := []
global g_DenyTitleSubstr  := []
global g_AhkVersion       := A_AhkVersion
global g_ScreenW          := A_ScreenWidth
global g_ScreenH          := A_ScreenHeight

global g_DenylistPath     := "D:\.code\eos-laptop-agent\macros\privacy-denylist.json"
global g_RecordingsRoot   := "D:\.code\macro-recordings"
global g_UiaProbePath     := "D:\.code\eos-laptop-agent\macros\uia-probe.ps1"
global g_PostProcessPath  := "D:\.code\eos-laptop-agent\macros\post-process.bat"

; ---------- Hotkey ----------
^+r::ToggleRecording()

; ---------- Toggle ----------
ToggleRecording() {
    global g_Recording
    if (g_Recording) {
        StopRecording()
    } else {
        StartRecording()
    }
}

; ---------- Start ----------
StartRecording() {
    global g_Recording, g_SessionId, g_SessionDir, g_FramesDir, g_EventsFile,
        g_ManifestFile, g_EventIndex, g_DenylistHits, g_StartIso

    ; Build session id YYYY-MM-DD-HHMM-<random6>
    rand := RandomString6()
    sessionId := FormatTime(A_Now, "yyyy-MM-dd-HHmm") . "-" . rand
    sessionDir := g_RecordingsRoot . "\" . sessionId
    framesDir  := sessionDir . "\frames"

    DirCreate(framesDir)

    g_SessionId    := sessionId
    g_SessionDir   := sessionDir
    g_FramesDir    := framesDir
    g_EventsFile   := sessionDir . "\events.jsonl"
    g_ManifestFile := sessionDir . "\manifest.json"
    g_EventIndex   := 0
    g_DenylistHits := 0
    g_StartIso     := IsoNow()

    LoadDenylist()

    ; record_start meta
    AppendJsonLine(BuildMetaEvent("record_start", Map(
        "session_id", sessionId,
        "screen_resolution", g_ScreenW . "x" . g_ScreenH,
        "ahk_version", g_AhkVersion
    )))

    g_Recording := true

    ; Hooks: capture mouse + selected keys
    Hotkey "~LButton", OnLeftClick, "On"
    Hotkey "~RButton", OnRightClick, "On"
    InstallKeyHooks(true)

    TrayTip "Macro Recorder", "Recording started: " . sessionId, 1
    SoundBeep 800, 120
}

; ---------- Stop ----------
StopRecording() {
    global g_Recording, g_EventsFile, g_ManifestFile, g_EventIndex,
        g_DenylistHits, g_StartIso, g_SessionId, g_AhkVersion, g_ScreenW, g_ScreenH

    if (!g_Recording)
        return

    g_Recording := false

    Hotkey "~LButton", "Off"
    Hotkey "~RButton", "Off"
    InstallKeyHooks(false)

    endIso := IsoNow()

    AppendJsonLine(BuildMetaEvent("record_stop", Map(
        "session_id", g_SessionId,
        "event_count", g_EventIndex,
        "denylist_hits", g_DenylistHits
    )))

    manifest := Map(
        "session_id",        g_SessionId,
        "start_ts",          g_StartIso,
        "end_ts",            endIso,
        "event_count",       g_EventIndex,
        "denylist_hits",     g_DenylistHits,
        "ahk_version",       g_AhkVersion,
        "platform",          "win32",
        "screen_resolution", g_ScreenW . "x" . g_ScreenH
    )
    FileAppend JsonStringify(manifest), g_ManifestFile, "UTF-8"

    TrayTip "Macro Recorder", "Recording saved: " . g_SessionId . " (" . g_EventIndex . " events)", 1
    SoundBeep 500, 120

    ; Optional: B3 post-processor
    if FileExist(g_PostProcessPath) {
        try Run('cmd.exe /c "' . g_PostProcessPath . '" "' . g_SessionDir . '"', , "Hide")
    }
}

; ---------- Mouse handlers ----------
OnLeftClick(*) {
    HandleClick("click_left", "left")
}
OnRightClick(*) {
    HandleClick("click_right", "right")
}

HandleClick(eventType, button) {
    global g_Recording, g_EventIndex, g_FramesDir, g_DenylistHits, g_UiaProbePath, g_SessionId
    if (!g_Recording)
        return

    MouseGetPos &mx, &my
    info := GetForegroundInfo()

    if DenylistMatch(info) {
        g_DenylistHits++
        AppendJsonLine(BuildMetaEvent("denylist_skip", Map(
            "x", mx, "y", my,
            "foreground_app_exe", info["exe"],
            "foreground_window_title", info["title"],
            "denylist_match", info["denyMatch"]
        )))
        return
    }

    idx := g_EventIndex
    g_EventIndex++

    framePre  := "frames\" . idx . "-pre.png"
    framePost := "frames\" . idx . "-post.png"
    framePreAbs  := g_FramesDir . "\" . idx . "-pre.png"
    framePostAbs := g_FramesDir . "\" . idx . "-post.png"

    ; Pre-click screenshot (synchronous)
    CaptureScreenPng(framePreAbs)

    ; Fire-and-forget UIA probe (B2 sibling)
    if FileExist(g_UiaProbePath) {
        cmd := 'pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "' . g_UiaProbePath
            . '" -X ' . mx . ' -Y ' . my . ' -EventIndex ' . idx . ' -SessionId ' . g_SessionId
        try Run(cmd, , "Hide")
    }

    ev := Map(
        "event_index",              idx,
        "timestamp",                IsoNow(),
        "event_type",               eventType,
        "x",                        mx,
        "y",                        my,
        "button",                   button,
        "key",                      "",
        "foreground_window_title",  info["title"],
        "foreground_app_exe",       info["exe"],
        "screenshot_pre_path",      framePre,
        "screenshot_post_path",     framePost
    )
    AppendJsonLine(JsonStringify(ev))

    ; Post-click screenshot scheduled (async sleep + capture + meta)
    SetTimer(PostCaptureFor.Bind(idx, framePostAbs, framePost), -200)
}

PostCaptureFor(idx, absPath, relPath) {
    CaptureScreenPng(absPath)
    AppendJsonLine(BuildMetaEvent("post_capture", Map(
        "event_index", idx,
        "screenshot_post_path", relPath
    )))
}

; ---------- Keyboard handlers ----------
; We capture: F1-F12, Esc, Tab, Enter, and Ctrl/Alt/Win combos.
; We deliberately SKIP raw alphanumerics (privacy + replay irrelevance).

InstallKeyHooks(on) {
    ; NOTE: ^+r intentionally absent; it is the recorder toggle. Recording it would skip the stop event.
    static keys := [
        "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
        "Escape","Tab","Enter",
        "^a","^c","^v","^x","^z","^y","^s","^f","^l","^r","^t","^w","^n","^p","^e","^g","^b","^o","^h","^k","^q","^u","^,","^.",
        "+!a","+!c","+!v","+!x","+!z","+!s","+!f","+!l","+!t",
        "^+a","^+c","^+v","^+x","^+z","^+s","^+f","^+l","^+t","^+n","^+p","^+w","^+e","^+i","^+m",
        "!Tab","!F4","!Space","!Enter",
        "#l","#d","#e","#r","#s","#tab"
    ]
    state := on ? "On" : "Off"
    for k in keys {
        try Hotkey "~" . k, OnTrackedKey, state
    }
}

OnTrackedKey(thisHotkey) {
    global g_Recording, g_EventIndex, g_FramesDir, g_DenylistHits, g_SessionId
    if (!g_Recording)
        return

    info := GetForegroundInfo()
    if DenylistMatch(info) {
        g_DenylistHits++
        AppendJsonLine(BuildMetaEvent("denylist_skip", Map(
            "key", PrettyHotkey(thisHotkey),
            "foreground_app_exe", info["exe"],
            "foreground_window_title", info["title"],
            "denylist_match", info["denyMatch"]
        )))
        return
    }

    idx := g_EventIndex
    g_EventIndex++

    framePre  := "frames\" . idx . "-pre.png"
    framePostRel := "frames\" . idx . "-post.png"
    framePreAbs  := g_FramesDir . "\" . idx . "-pre.png"
    framePostAbs := g_FramesDir . "\" . idx . "-post.png"

    CaptureScreenPng(framePreAbs)

    eventType := InStr(thisHotkey, "+") || InStr(thisHotkey, "^") || InStr(thisHotkey, "!") || InStr(thisHotkey, "#")
        ? "key_combo" : "key_down"

    ev := Map(
        "event_index",              idx,
        "timestamp",                IsoNow(),
        "event_type",               eventType,
        "x",                        "",
        "y",                        "",
        "button",                   "",
        "key",                      PrettyHotkey(thisHotkey),
        "foreground_window_title",  info["title"],
        "foreground_app_exe",       info["exe"],
        "screenshot_pre_path",      framePre,
        "screenshot_post_path",     framePostRel
    )
    AppendJsonLine(JsonStringify(ev))

    SetTimer(PostCaptureFor.Bind(idx, framePostAbs, framePostRel), -200)
}

PrettyHotkey(hk) {
    ; Single-pass tokenizer. Splits AHK hotkey prefix chars (^+!#~) from the keyname.
    ; Avoids cascade bugs where StrReplace("^","Ctrl+") then StrReplace("+","Shift+") double-substitutes.
    parts := []
    i := 1
    while (i <= StrLen(hk)) {
        c := SubStr(hk, i, 1)
        if (c = "~") {
            i++
            continue
        } else if (c = "^") {
            parts.Push("Ctrl")
            i++
        } else if (c = "+") {
            parts.Push("Shift")
            i++
        } else if (c = "!") {
            parts.Push("Alt")
            i++
        } else if (c = "#") {
            parts.Push("Win")
            i++
        } else {
            ; remainder is the keyname
            parts.Push(SubStr(hk, i))
            break
        }
    }
    return JoinArr(parts, "+")
}

; ---------- Foreground inspection ----------
GetForegroundInfo() {
    title := ""
    exe := ""
    try {
        hwnd := WinGetID("A")
        if hwnd {
            title := WinGetTitle("ahk_id " . hwnd)
            try exe := ProcessExeForHwnd(hwnd)
        }
    }
    return Map("title", title, "exe", exe, "denyMatch", "")
}

ProcessExeForHwnd(hwnd) {
    try {
        pid := WinGetPID("ahk_id " . hwnd)
        if !pid
            return ""
        ; Use ProcessGetName via WMI fallback through tasklist: keep simple
        return ProcessGetName(pid)
    }
    return ""
}

; ---------- Denylist ----------
LoadDenylist() {
    global g_DenyExe, g_DenyUrlSubstr, g_DenyTitleSubstr, g_DenylistPath
    g_DenyExe := []
    g_DenyUrlSubstr := []
    g_DenyTitleSubstr := []
    if !FileExist(g_DenylistPath)
        return
    try {
        text := FileRead(g_DenylistPath, "UTF-8")
        ; lightweight parse: pull each blocklist array via simple regex
        g_DenyExe         := ExtractStringArray(text, "foreground_exe_blocklist")
        g_DenyUrlSubstr   := ExtractStringArray(text, "url_substring_blocklist")
        g_DenyTitleSubstr := ExtractStringArray(text, "window_title_substring_blocklist")
    } catch as e {
        ; non-fatal: keep empty lists
    }
}

ExtractStringArray(text, key) {
    out := []
    ; find "key": [ ... ]  -- (?s) makes . cross newlines
    if !RegExMatch(text, '(?s)"' . key . '"\s*:\s*\[(.*?)\]', &m)
        return out
    body := m[1]
    pos := 1
    while RegExMatch(body, '"((?:[^"\\]|\\.)*)"', &mm, pos) {
        val := mm[1]
        val := StrReplace(val, '\"', '"')
        val := StrReplace(val, "\\", "\")
        out.Push(val)
        pos := mm.Pos + mm.Len
    }
    return out
}

DenylistMatch(info) {
    global g_DenyExe, g_DenyTitleSubstr, g_DenyUrlSubstr
    exe   := info["exe"]
    title := info["title"]

    for e in g_DenyExe {
        if (exe != "" && StrLower(exe) = StrLower(e)) {
            info["denyMatch"] := "exe:" . e
            return true
        }
    }
    for t in g_DenyTitleSubstr {
        if (title != "" && InStr(title, t)) {
            info["denyMatch"] := "title:" . t
            return true
        }
    }
    for u in g_DenyUrlSubstr {
        ; Browser windows tend to surface the URL/title together; substring match is enough for v0.
        if (title != "" && InStr(title, u)) {
            info["denyMatch"] := "url_substr:" . u
            return true
        }
    }
    return false
}

; ---------- Helpers ----------
RandomString6() {
    chars := "abcdefghijklmnopqrstuvwxyz0123456789"
    out := ""
    Loop 6 {
        n := Random(1, StrLen(chars))
        out .= SubStr(chars, n, 1)
    }
    return out
}

IsoNow() {
    ; UTC ISO 8601 with millisecond zero
    t := A_NowUTC
    return FormatTime(t, "yyyy-MM-dd'T'HH:mm:ss") . ".000Z"
}

AppendJsonLine(line) {
    global g_EventsFile
    try FileAppend line . "`n", g_EventsFile, "UTF-8"
}

BuildMetaEvent(metaType, payload) {
    obj := Map(
        "event_index", "",
        "timestamp",   IsoNow(),
        "event_type",  "meta",
        "meta_type",   metaType,
        "meta_payload", payload
    )
    return JsonStringify(obj)
}

CaptureScreenPng(absPath) {
    ; Screen capture via PowerShell System.Drawing. Synchronous, ~150-300ms typical.
    ps := "
(
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $bmp.Size);
$bmp.Save('PATH', [System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose(); $bmp.Dispose();
)"
    ps := StrReplace(ps, "PATH", absPath)
    cmd := 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' . StrReplace(ps, "`r`n", " ") . '"'
    try RunWait(cmd, , "Hide")
}

; ---------- Minimal JSON stringifier (Map/Array/string/number) ----------
JsonStringify(v) {
    if (v is Map)
        return MapToJson(v)
    if (v is Array)
        return ArrayToJson(v)
    if IsNumber(v)
        return v . ""
    if (v = "")
        return '""'
    return JsonString(v)
}

MapToJson(m) {
    parts := []
    for k, val in m
        parts.Push(JsonString(k) . ":" . JsonStringify(val))
    return "{" . JoinArr(parts, ",") . "}"
}

ArrayToJson(a) {
    parts := []
    for v in a
        parts.Push(JsonStringify(v))
    return "[" . JoinArr(parts, ",") . "]"
}

JsonString(s) {
    s := s . ""
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r", "\r")
    s := StrReplace(s, "`n", "\n")
    s := StrReplace(s, "`t", "\t")
    return '"' . s . '"'
}

JoinArr(arr, sep) {
    out := ""
    first := true
    for v in arr {
        if !first
            out .= sep
        out .= v
        first := false
    }
    return out
}

; ---------- Tray ----------
A_IconTip := "EcodiaOS Macro Recorder (Ctrl+Shift+R)"
TrayTip "Macro Recorder", "Loaded. Press Ctrl+Shift+R to start.", 1
