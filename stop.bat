@echo off
setlocal
cd /d "%~dp0"

set "PID_FILE=%~1"
if "%PID_FILE%"=="" set "PID_FILE=data\web.pid"
set "URL_FILE=data\web.url"
set "INFO_FILE=data\web.json"

if not exist "%PID_FILE%" (
  echo PID file not found: %PID_FILE%
  goto kill_by_name
)

set /p WEB_PID=<"%PID_FILE%"
if "%WEB_PID%"=="" (
  echo Invalid PID file: %PID_FILE%
  goto kill_by_name
)

set "PORT=%TUNNEL_WEB_PORT%"
if "%PORT%"=="" set "PORT=8088"
set "WEB_URL=http://127.0.0.1:%PORT%"
if exist "%URL_FILE%" set /p WEB_URL=<"%URL_FILE%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Uri '%WEB_URL%/api/shutdown' -Method Post -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo Stopped TunnelDesk gracefully, pid=%WEB_PID%
  set "EXIT_CODE=0"
  goto kill_by_name
)

echo Graceful shutdown failed, stopping process directly...
taskkill /PID %WEB_PID% /T >nul 2>nul
if errorlevel 1 (
  echo Process is not running, removing stale PID file
) else (
  echo Stopped TunnelDesk, pid=%WEB_PID%
)

del "%PID_FILE%" >nul 2>nul
del "%URL_FILE%" >nul 2>nul
del "%INFO_FILE%" >nul 2>nul
set "EXIT_CODE=0"
goto kill_by_name

:kill_by_name
echo Trying to stop TunnelDesk by program name and project path...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path '.').Path.ToLower(); $targets=Get-CimInstance Win32_Process | Where-Object { $cmd=($_.CommandLine + '').ToLower(); ($_.Name -in @('node.exe','electron.exe','TunnelDesk.exe')) -and ($cmd.Contains($root.ToLower()) -or $cmd.Contains('dist\\server.js') -or $cmd.Contains('dist/server.js') -or $cmd.Contains('tunneldesk')) }; $count=0; foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $count++ } catch {} }; Write-Output \"Stopped processes by name: $count\"; exit 0"
del "%PID_FILE%" >nul 2>nul
del "%URL_FILE%" >nul 2>nul
del "%INFO_FILE%" >nul 2>nul
set "EXIT_CODE=0"

:done
if not "%TUNNELDESK_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
