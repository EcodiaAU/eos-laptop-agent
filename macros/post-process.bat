@echo off
REM post-process.bat
REM
REM Corazon-side trigger sibling for B1's AHK recorder. The AHK invokes this
REM script (if it exists on the user's PATH or alongside the recorder) once a
REM recording session ends, so the post-processing pipeline on the VPS can
REM start without a human round-trip.
REM
REM MVP scope (Worker B3, 6 May 2026):
REM   - Append a marker line to D:\.code\eos-laptop-agent\macros\post-process.log
REM   - Optionally: curl the VPS endpoint to trigger recording-to-recipe.js
REM     This URL is intentionally NOT hardcoded - the conductor / fork that
REM     orchestrates v2 will set %ECODIAOS_POSTPROCESS_URL% in the laptop-agent
REM     environment OR fold this into a tailscale ssh + node command.
REM
REM Args:
REM   %1 = session_id   (e.g. session-20260506T0541Z)
REM   %2 = session_dir  (e.g. D:\.code\eos-laptop-agent\macros\captures\_raw\session-20260506T0541Z)
REM
REM B4's job: doctrine + integration tests around this trigger, including a
REM watcher cron on the VPS that picks up new session dirs and dispatches
REM recording-to-recipe.js.

setlocal
set SESSION_ID=%~1
set SESSION_DIR=%~2
set LOG_FILE=D:\.code\eos-laptop-agent\macros\post-process.log

if not exist "D:\.code\eos-laptop-agent\macros" (
  mkdir "D:\.code\eos-laptop-agent\macros"
)

for /f "tokens=*" %%a in ('powershell -NoProfile -Command "Get-Date -Format o"') do set NOW=%%a
echo [%NOW%] post-process triggered session_id=%SESSION_ID% session_dir=%SESSION_DIR% >> "%LOG_FILE%"

if not "%ECODIAOS_POSTPROCESS_URL%"=="" (
  echo [%NOW%] curl POST %ECODIAOS_POSTPROCESS_URL% >> "%LOG_FILE%"
  curl -s -X POST -H "Content-Type: application/json" ^
    -d "{\"session_id\":\"%SESSION_ID%\",\"session_dir\":\"%SESSION_DIR%\"}" ^
    "%ECODIAOS_POSTPROCESS_URL%" >> "%LOG_FILE%" 2>&1
)

endlocal
exit /b 0
