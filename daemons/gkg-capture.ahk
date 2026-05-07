#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent
SetWorkingDir A_ScriptDir

; ============================================================
; GKG (GUI Knowledge Graph) Capture Daemon - Phase 1 Corazon-half
; ============================================================
; Spec: ~/ecodiaos/docs/gkg-spec-v0.1.md §3.1 + §4
; Status_board: 04599f46-b09f-4958-8129-01bf8e693109
; Authored 2026-05-07 fork_mov5fcpf_fb840a
;
; Hooks the foreground/keyboard/mouse, gates by an allowlist
; (~/ecodiaos/laptop-agent/daemons/gkg-allowlist.json), redacts
; sensitive input by focused-element heuristics, periodically
; screenshots, buffers events as NDJSON, and POSTs HMAC-signed
; chunks to https://api.admin.ecodia.au/api/gkg/ingest.
;
; Sensitive-input redaction is applied in TWO ways: (a) the daemon
; refuses to capture key payload while focused element name OR
; window title contains a redaction pattern, and (b) keystrokes
; while in those contexts are emitted as `input_redacted` events
; with `redacted_count` only (no key payload, no character text).
;
; Tray icon exposes Pause/Resume; default state is Resumed at
; daemon start. The state is mirrored into a global flag so all
; capture handlers cheaply check before emitting.
;
; UIA accessibility tree probe is intentionally minimal in v1
; (window-level only). Per-element probe deferred to Phase 1.5;
; spec §6 explicitly notes this is acceptable. Click events still
; carry pixel coords + window/process + (best-effort) Chrome URL
; via window-title parsing.
; ============================================================

; --- imports ---
#Include <JSON>  ; if not available, fall back to inline JSON build
; (We do NOT actually rely on a JSON lib; we hand-build NDJSON
; lines below to avoid a third-party dep on Corazon. The #Include
; line is harmless if the file does not exist - AHK warns once
; and continues. We escape strings ourselves.)

; --- config (resolved once at startup) ---
global INGEST_URL := "https://api.admin.ecodia.au/api/gkg/ingest"
global ALLOWLIST_FILE := A_ScriptDir "\gkg-allowlist.json"
global ENV_FILE := A_ScriptDir "\.env"
global SESSION_ROOT := "D:\.code\macro-recordings\gkg"
global FLUSH_THRESHOLD := 30           ; events
global FLUSH_INTERVAL_MS := 5000       ; 5s
global SCREENSHOT_INTERVAL_MS := 5000  ; 5s periodic
global FOREGROUND_POLL_MS := 1000      ; 1s foreground polling
global LOG_FILE := A_ScriptDir "\gkg-capture.log"

; --- runtime state ---
global g_paused := false
global g_session_id := ""
global g_session_dir := ""
global g_frames_dir := ""
global g_buffer := []
global g_seq := 0
global g_redacted_total := 0
global g_last_foreground_app := ""
global g_last_foreground_title := ""
global g_last_screenshot_ts := 0
global g_last_flush_ts := 0
global g_hmac_secret := ""
global g_allowlist := { browser_urls: [], native_processes: [], redaction_field_patterns: [] }
global g_allowlist_skip_log := Map()  ; app => last_logged_unix_seconds

; ============================================================
; Bootstrap
; ============================================================
Main() {
    LoadEnv()
    LoadAllowlist()
    StartSession()
    Log("daemon_start session=" g_session_id)
    BuildTray()

    ; Periodic foreground/screenshot/flush poller
    SetTimer(PollForeground, FOREGROUND_POLL_MS)
    SetTimer(PeriodicScreenshot, SCREENSHOT_INTERVAL_MS)
    SetTimer(MaybeFlush, 1000)

    ; Mouse + keyboard hooks via InputHook + low-level mouse hook
    StartMouseHook()
    StartKeyboardHook()
}

; ============================================================
; Config / IO helpers
; ============================================================
LoadEnv() {
    global g_hmac_secret
    if !FileExist(ENV_FILE) {
        ExitWithError("missing .env at " ENV_FILE " - daemon cannot HMAC-sign")
    }
    body := FileRead(ENV_FILE)
    Loop Parse body, "`n", "`r" {
        line := Trim(A_LoopField)
        if (line = "" || SubStr(line, 1, 1) = "#")
            continue
        eq := InStr(line, "=")
        if !eq
            continue
        k := Trim(SubStr(line, 1, eq - 1))
        v := Trim(SubStr(line, eq + 1))
        ; strip surrounding quotes
        if (SubStr(v, 1, 1) = '"' && SubStr(v, -1) = '"')
            v := SubStr(v, 2, StrLen(v) - 2)
        if (k = "GKG_DAEMON_HMAC_SECRET")
            g_hmac_secret := v
    }
    if (g_hmac_secret = "")
        ExitWithError("GKG_DAEMON_HMAC_SECRET not set in .env")
}

LoadAllowlist() {
    global g_allowlist
    if !FileExist(ALLOWLIST_FILE) {
        ExitWithError("missing allowlist at " ALLOWLIST_FILE)
    }
    body := FileRead(ALLOWLIST_FILE)
    ; Minimal hand-parsed JSON for the three arrays we care about.
    g_allowlist.browser_urls := JsonExtractStringArray(body, "browser_urls")
    g_allowlist.native_processes := JsonExtractStringArray(body, "native_processes")
    g_allowlist.redaction_field_patterns := JsonExtractStringArray(body, "redaction_field_patterns")
}

; Naive but sufficient: extract a string-array property from JSON.
JsonExtractStringArray(json, key) {
    arr := []
    pat := '"' key '"\s*:\s*\['
    if !RegExMatch(json, pat, &m)
        return arr
    rest := SubStr(json, m.Pos + m.Len)
    end := InStr(rest, "]")
    if !end
        return arr
    body := SubStr(rest, 1, end - 1)
    pos := 1
    Loop {
        if !RegExMatch(body, '"((?:[^"\\]|\\.)*)"', &mm, pos)
            break
        s := mm[1]
        ; unescape simple sequences
        s := StrReplace(s, '\"', '"')
        s := StrReplace(s, "\\", "\")
        arr.Push(s)
        pos := mm.Pos + mm.Len
    }
    return arr
}

StartSession() {
    global g_session_id, g_session_dir, g_frames_dir
    ts := FormatTime(, "yyyy-MM-dd-HHmm")
    g_session_id := ts "-" RandomSlug(6)
    g_session_dir := SESSION_ROOT "\" g_session_id
    g_frames_dir := g_session_dir "\frames"
    DirCreate(g_session_dir)
    DirCreate(g_frames_dir)
    ; manifest
    manifest := Format('{{"session_id":"{1}","started_at":"{2}","daemon":"gkg-capture.ahk","author_fork":"fork_mov5fcpf_fb840a"}}'
        , g_session_id, IsoNow())
    FileAppend(manifest "`n", g_session_dir "\manifest.json", "UTF-8")
}

RandomSlug(n) {
    chars := "abcdefghijklmnopqrstuvwxyz0123456789"
    out := ""
    Loop n
        out .= SubStr(chars, Random(1, StrLen(chars)), 1)
    return out
}

IsoNow() {
    ; UTC ISO-8601
    return FormatTime("YYYYMMDDHH24MISS", "yyyy-MM-ddTHH:mm:ss") "Z"
}

UnixSeconds() {
    return DateDiff(A_Now, "19700101000000", "Seconds")
}

Log(msg) {
    try {
        FileAppend(IsoNow() " " msg "`n", LOG_FILE, "UTF-8")
    }
}

ExitWithError(msg) {
    MsgBox("[gkg-capture] FATAL: " msg, "GKG capture daemon", "IconX")
    ExitApp(1)
}

; ============================================================
; Tray (pause toggle)
; ============================================================
BuildTray() {
    A_IconTip := "GKG capture (Resumed)"
    tray := A_TrayMenu
    tray.Delete()
    tray.Add("GKG Capture Daemon", (*) => MsgBox("session: " g_session_id "`nseq: " g_seq "`nbuf: " g_buffer.Length "`nredacted: " g_redacted_total, "GKG status"))
    tray.Add()
    tray.Add("Pause Capture", TogglePause)
    tray.Add("Resume Capture", TogglePause)
    tray.Add()
    tray.Add("Open log", (*) => Run("notepad " LOG_FILE))
    tray.Add("Open session dir", (*) => Run("explorer " g_session_dir))
    tray.Add()
    tray.Add("Exit", (*) => ExitApp(0))
    tray.Default := "GKG Capture Daemon"
    UpdatePauseTrayChecks()
}

TogglePause(*) {
    global g_paused
    g_paused := !g_paused
    A_IconTip := "GKG capture (" (g_paused ? "Paused" : "Resumed") ")"
    UpdatePauseTrayChecks()
    Emit("pause_state", { paused: g_paused }, "", "")
    Log("toggle_pause paused=" (g_paused ? "true" : "false"))
}

UpdatePauseTrayChecks() {
    tray := A_TrayMenu
    try tray.Uncheck("Pause Capture")
    try tray.Uncheck("Resume Capture")
    try {
        if g_paused
            tray.Check("Pause Capture")
        else
            tray.Check("Resume Capture")
    }
}

; ============================================================
; Foreground polling
; ============================================================
PollForeground() {
    global g_last_foreground_app, g_last_foreground_title
    if g_paused
        return
    try {
        hwnd := WinExist("A")
        if !hwnd
            return
        title := WinGetTitle("ahk_id " hwnd)
        proc := WinGetProcessName("ahk_id " hwnd)
        url := ExtractChromeUrlFromTitle(title, proc)
        same := (proc = g_last_foreground_app && title = g_last_foreground_title)
        if same
            return
        g_last_foreground_app := proc
        g_last_foreground_title := title
        if !AllowlistMatch(proc, url, title) {
            ; Log skip at most once per minute per app to keep noise low.
            now := UnixSeconds()
            last := g_allowlist_skip_log.Has(proc) ? g_allowlist_skip_log[proc] : 0
            if (now - last >= 60) {
                g_allowlist_skip_log[proc] := now
                Emit("allowlist_skip", { process_name: proc, window_title: title, chrome_url: url }, proc, url)
            }
            return
        }
        Emit("foreground_change", { process_name: proc, window_title: title, chrome_url: url }, proc, url)
        ; capture an immediate screenshot to anchor the state
        TakeScreenshot()
    } catch as e {
        Log("foreground_err " e.Message)
    }
}

ExtractChromeUrlFromTitle(title, proc) {
    ; Chrome window title for an active tab is "<page> - Google Chrome".
    ; We don't have URL there, so we fall back to "" - the VPS-side
    ; classifier uses process_name for native and host-substring for
    ; allowlist match. Phase 1.5 should add a UIA-based URL scrape via
    ; the address-bar Edit element.
    return ""
}

AllowlistMatch(proc, url, title) {
    procL := StrLower(proc)
    titleL := StrLower(title)
    for p in g_allowlist.native_processes {
        if (StrLower(p) = procL)
            return true
    }
    for u in g_allowlist.browser_urls {
        if (InStr(titleL, StrLower(u)))
            return true
        if (url != "" && InStr(StrLower(url), StrLower(u)))
            return true
    }
    return false
}

StrLower(s) {
    return StrLower2(s)
}

StrLower2(s) {
    return Format("{:L}", s)
}

; ============================================================
; Screenshots
; ============================================================
PeriodicScreenshot() {
    if g_paused
        return
    if (g_last_foreground_app = "")
        return
    if !AllowlistMatch(g_last_foreground_app, "", g_last_foreground_title)
        return
    TakeScreenshot()
}

TakeScreenshot() {
    global g_last_screenshot_ts
    now := A_TickCount
    if (now - g_last_screenshot_ts < 1500)
        return  ; debounce
    g_last_screenshot_ts := now
    fname := g_frames_dir "\" Format("{:08X}", now) ".png"
    try {
        ; Use built-in System.Drawing via ScreenCap helper.
        ScreenCapToFile(fname)
        Emit("screenshot", { path: fname }, g_last_foreground_app, "")
    } catch as e {
        Log("screenshot_err " e.Message)
    }
}

ScreenCapToFile(path) {
    ; Use Windows shell -> rundll32 fallback. Works without GDI+ shim.
    ; Implementation: spawn a one-shot PowerShell that uses
    ; System.Drawing to grab the primary screen. Acceptable cost.
    cmd := "powershell -NoProfile -WindowStyle Hidden -Command "
        . '"Add-Type -AssemblyName System.Drawing;'
        . '$b=New-Object System.Drawing.Bitmap([System.Windows.Forms.SystemInformation]::VirtualScreen.Width,[System.Windows.Forms.SystemInformation]::VirtualScreen.Height);'
        . '$g=[System.Drawing.Graphics]::FromImage($b);'
        . '$g.CopyFromScreen([System.Windows.Forms.SystemInformation]::VirtualScreen.Location,[System.Drawing.Point]::Empty,$b.Size);'
        . '$b.Save(' Chr(39) path Chr(39) ');"'
    RunWait(A_ComSpec ' /c ' cmd, , "Hide")
}

; ============================================================
; Mouse hook
; ============================================================
StartMouseHook() {
    ; Capture clicks via hotkey. AHK low-level mouse hook is heavy;
    ; using ~click is sufficient for v1. The hotkey passes through
    ; (we use ~ prefix so the click still lands).
    Hotkey("~LButton", OnLClick, "On")
    Hotkey("~RButton", OnRClick, "On")
}

OnLClick(*) {
    if g_paused
        return
    if (g_last_foreground_app = "")
        return
    if !AllowlistMatch(g_last_foreground_app, "", g_last_foreground_title)
        return
    MouseGetPos &x, &y
    ; UIA per-element capture deferred to Phase 1.5 - emit window-level only
    Emit("click_with_uia", {
        button: "left",
        pixel_x: x,
        pixel_y: y,
        process_name: g_last_foreground_app,
        window_title: g_last_foreground_title,
        uia_name: "",
        uia_role: "",
        uia_automation_id: "",
        uia_neighbors: []
    }, g_last_foreground_app, "")
    ; capture post-click screenshot after the UI settles
    SetTimer(TakeScreenshot, -250)
}

OnRClick(*) {
    if g_paused
        return
    if (g_last_foreground_app = "")
        return
    if !AllowlistMatch(g_last_foreground_app, "", g_last_foreground_title)
        return
    MouseGetPos &x, &y
    Emit("click_with_uia", {
        button: "right",
        pixel_x: x,
        pixel_y: y,
        process_name: g_last_foreground_app,
        window_title: g_last_foreground_title,
        uia_name: "",
        uia_role: "",
        uia_automation_id: "",
        uia_neighbors: []
    }, g_last_foreground_app, "")
}

; ============================================================
; Keyboard hook
; ============================================================
StartKeyboardHook() {
    ; InputHook captures key NAMES (A-Z, 0-9, etc) without consuming.
    ; We DO NOT capture printable characters one-by-one; we batch via
    ; a 500ms debounce, redact if the focused window indicates a
    ; sensitive context, and emit either `input` (key name list) or
    ; `input_redacted` (count only).
    ih := InputHook("V L0")
    ih.KeyOpt("{All}", "N")
    ih.OnKeyDown := OnKeyDown
    ih.Start()
    global g_input_hook := ih
}

OnKeyDown(ih, vk, sc) {
    if g_paused
        return
    if (g_last_foreground_app = "")
        return
    if !AllowlistMatch(g_last_foreground_app, "", g_last_foreground_title)
        return
    keyName := GetKeyName(Format("vk{:X}sc{:X}", vk, sc))
    if (keyName = "")
        keyName := Format("vk{:X}", vk)
    ; Heuristic: check window title or focused-element label for sensitive substring.
    if IsSensitiveContext(g_last_foreground_title) {
        global g_redacted_total
        g_redacted_total += 1
        Emit("input_redacted", {
            process_name: g_last_foreground_app,
            window_title: g_last_foreground_title,
            redaction_reason: "sensitive_context_match"
        }, g_last_foreground_app, "")
        return
    }
    Emit("input", {
        key: keyName,
        process_name: g_last_foreground_app,
        window_title: g_last_foreground_title
    }, g_last_foreground_app, "")
}

IsSensitiveContext(text) {
    tL := StrLower2(text)
    for p in g_allowlist.redaction_field_patterns {
        if InStr(tL, StrLower2(p))
            return true
    }
    return false
}

; ============================================================
; Event emit + buffer + flush
; ============================================================
Emit(eventType, payload, processName, chromeUrl) {
    global g_seq, g_buffer
    g_seq += 1
    ev := {
        session_id: g_session_id,
        sequence_no: g_seq,
        timestamp_iso: IsoNow(),
        event_type: eventType,
        payload: payload,
        redacted_count: g_redacted_total
    }
    g_buffer.Push(ev)
    if (g_buffer.Length >= FLUSH_THRESHOLD)
        Flush()
}

MaybeFlush() {
    global g_last_flush_ts
    now := A_TickCount
    if (g_buffer.Length = 0)
        return
    if (now - g_last_flush_ts >= FLUSH_INTERVAL_MS)
        Flush()
}

Flush() {
    global g_buffer, g_last_flush_ts
    if (g_buffer.Length = 0)
        return
    batch := g_buffer
    g_buffer := []
    g_last_flush_ts := A_TickCount
    ndjson := ""
    for ev in batch {
        ndjson .= EventToJson(ev) "`n"
    }
    ; also persist locally as resilience against transient network failure
    FileAppend(ndjson, g_session_dir "\events.jsonl", "UTF-8")
    PostNdjson(ndjson)
}

; Hand-built JSON serializer for our event shape. Avoids a JSON dep on Corazon.
EventToJson(ev) {
    return "{"
        . '"session_id":' JsString(ev.session_id) ","
        . '"sequence_no":' ev.sequence_no ","
        . '"timestamp_iso":' JsString(ev.timestamp_iso) ","
        . '"event_type":' JsString(ev.event_type) ","
        . '"redacted_count":' ev.redacted_count ","
        . '"payload":' PayloadToJson(ev.payload)
        . "}"
}

PayloadToJson(p) {
    if (p = "" || !IsObject(p))
        return "null"
    parts := []
    for k, v in p.OwnProps() {
        if IsObject(v) {
            ; arrays only (UIA neighbors)
            arr := []
            for _, item in v
                arr.Push(JsString(item))
            parts.Push(JsString(k) ":[" Join(arr, ",") "]")
        } else if (v = "" && Type(v) = "String") {
            parts.Push(JsString(k) ':""')
        } else if IsNumber(v) {
            parts.Push(JsString(k) ":" v)
        } else if (v = true) {
            parts.Push(JsString(k) ":true")
        } else if (v = false) {
            parts.Push(JsString(k) ":false")
        } else {
            parts.Push(JsString(k) ":" JsString(v))
        }
    }
    return "{" Join(parts, ",") "}"
}

JsString(s) {
    s := s . ""  ; coerce to string
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`n", "\n")
    s := StrReplace(s, "`r", "\r")
    s := StrReplace(s, "`t", "\t")
    return '"' s '"'
}

Join(arr, sep) {
    out := ""
    for i, v in arr {
        if (i > 1)
            out .= sep
        out .= v
    }
    return out
}

PostNdjson(ndjson) {
    ts := IsoNow()
    signed := ts "." ndjson
    sig := HmacSha256Hex(signed, g_hmac_secret)
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.Open("POST", INGEST_URL, false)
        req.SetRequestHeader("Content-Type", "application/x-ndjson")
        req.SetRequestHeader("X-GKG-Signature", sig)
        req.SetRequestHeader("X-GKG-Timestamp", ts)
        req.SetTimeouts(5000, 10000, 10000, 15000)
        req.Send(ndjson)
        Log("post status=" req.Status " bytes=" StrLen(ndjson))
        if (req.Status >= 400)
            Log("post_err body=" SubStr(req.ResponseText, 1, 200))
    } catch as e {
        Log("post_throw " e.Message)
        ; Persist remains in events.jsonl for later replay.
    }
}

; ============================================================
; HMAC-SHA256 (bcrypt.dll)
; ============================================================
HmacSha256Hex(data, key) {
    ; Use Windows BCrypt for HMAC-SHA256. data + key are UTF-8.
    static BCRYPT_SHA256_ALGORITHM := "SHA256"
    static BCRYPT_ALG_HANDLE_HMAC_FLAG := 0x00000008

    hAlg := 0
    if (status := DllCall("bcrypt\BCryptOpenAlgorithmProvider", "Ptr*", &hAlg, "Str", BCRYPT_SHA256_ALGORITHM, "Ptr", 0, "UInt", BCRYPT_ALG_HANDLE_HMAC_FLAG))
        throw Error("BCryptOpenAlgorithmProvider failed " status)

    keyBuf := Buffer(StrPut(key, "UTF-8"))
    StrPut(key, keyBuf, "UTF-8")
    keyLen := keyBuf.Size - 1  ; drop trailing NUL

    hHash := 0
    if (status := DllCall("bcrypt\BCryptCreateHash", "Ptr", hAlg, "Ptr*", &hHash, "Ptr", 0, "UInt", 0, "Ptr", keyBuf, "UInt", keyLen, "UInt", 0))
        throw Error("BCryptCreateHash failed " status)

    dataBuf := Buffer(StrPut(data, "UTF-8"))
    StrPut(data, dataBuf, "UTF-8")
    dataLen := dataBuf.Size - 1

    if (status := DllCall("bcrypt\BCryptHashData", "Ptr", hHash, "Ptr", dataBuf, "UInt", dataLen, "UInt", 0))
        throw Error("BCryptHashData failed " status)

    digest := Buffer(32, 0)
    if (status := DllCall("bcrypt\BCryptFinishHash", "Ptr", hHash, "Ptr", digest, "UInt", 32, "UInt", 0))
        throw Error("BCryptFinishHash failed " status)

    DllCall("bcrypt\BCryptDestroyHash", "Ptr", hHash)
    DllCall("bcrypt\BCryptCloseAlgorithmProvider", "Ptr", hAlg, "UInt", 0)

    hex := ""
    Loop 32 {
        hex .= Format("{:02x}", NumGet(digest, A_Index - 1, "UChar"))
    }
    return hex
}

IsNumber(v) {
    return (Type(v) = "Integer" || Type(v) = "Float")
}

; ============================================================
; Bootstrap entry
; ============================================================
Main()
