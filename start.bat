@echo off
REM ===========================================================================
REM  APEX MVP launcher — double-click this file.
REM  Opens the server + a public tunnel, then shows you the URL to paste in Vapi.
REM ===========================================================================
cd /d "%~dp0"

echo.
echo   Starting APEX MVP...
echo.

REM --- 1) Start the Node server (its own window; keep it open) ---------------
start "APEX server (keep open)" cmd /k "node server.js"

REM give the server a moment to bind port 5174
timeout /t 2 /nobreak >nul

REM --- 2) Find cloudflared (PATH first, then the winget install location) ----
set "CF=cloudflared"
where cloudflared >nul 2>nul
if errorlevel 1 set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"

REM --- 3) Start the public tunnel (its own window; URL is shown there) -------
start "APEX tunnel (PUBLIC URL IS HERE)" "%CF%" tunnel --url http://localhost:5174

echo   ============================================================
echo    Two windows just opened:
echo      1) "APEX server"  - leave it running
echo      2) "APEX tunnel"  - look for the line:
echo            https://something-words.trycloudflare.com
echo   ============================================================
echo.
echo    In Vapi, set the Custom LLM URL to THAT address + /vapi
echo      e.g.  https://something-words.trycloudflare.com/vapi
echo.
echo    The URL is new every time you run this. Re-paste it into Vapi.
echo.
echo    To stop everything: close both windows.
echo.
pause
