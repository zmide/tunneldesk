@echo off
setlocal
cd /d "%~dp0"

set "URL_FILE=data\web.url"
set "INFO_FILE=data\web.json"
set "PID_FILE=data\web.pid"
call :check_existing_instance
if not errorlevel 1 goto already_running
if exist "%URL_FILE%" del "%URL_FILE%" >nul 2>nul
if exist "%INFO_FILE%" del "%INFO_FILE%" >nul 2>nul
set "SERVER_ARGS=%*"
set "SHOW_LAN_URLS="
set "LAN_FLAG=%TUNNELDESK_LAN: =%"
call :parse_server_args %*
echo %SERVER_ARGS% | findstr /c:"--host 0.0.0.0" >nul 2>nul
if not errorlevel 1 set "SHOW_LAN_URLS=1"
if "%LAN_FLAG%"=="1" (
  set "SERVER_ARGS=--host 0.0.0.0 %*"
  set "TUNNEL_WEB_HOST=0.0.0.0"
  set "SHOW_LAN_URLS=1"
)

if not exist "node_modules\@xterm\xterm\lib\xterm.js" goto install_deps
if not exist "node_modules\.bin\tsc.cmd" goto install_deps
if not exist "node_modules\.bin\electron.cmd" goto install_deps_done
goto build_app

:install_deps
echo Installing dependencies...
call npm install --include=dev
if errorlevel 1 goto failed
goto build_app

:install_deps_done
if not "%TUNNELDESK_WEB_ONLY%"=="1" (
  echo Electron is not installed. Installing desktop dependencies...
  call npm install --include=dev
  if errorlevel 1 goto failed
)

:build_app
call npm run build
if errorlevel 1 goto failed

if not "%TUNNELDESK_WEB_ONLY%"=="1" (
  if exist "node_modules\.bin\electron.cmd" (
    call :ensure_electron
    if errorlevel 1 goto start_web
    call :start_desktop_detached
    if errorlevel 1 goto start_web
    echo TunnelDesk desktop is starting.
    echo Mode: desktop. Logs: data\web.log and data\desktop-error.log
    set "DESKTOP_MODE=1"
    goto wait_url
  )
)

:start_web
node scripts\start-detached.js web %SERVER_ARGS%
if errorlevel 1 goto failed
echo TunnelDesk is starting in the background.
if "%TUNNELDESK_WEB_ONLY%"=="1" (
  echo Mode: Web-only requested by TUNNELDESK_WEB_ONLY=1.
) else (
  echo Mode: Web fallback. Desktop runtime is unavailable.
)
echo Web log: data\web.log
goto wait_url

:ensure_electron
node -e "try{const fs=require('fs');const electron=require('electron');process.exit(typeof electron==='string'&&fs.existsSync(electron)?0:1)}catch{process.exit(1)}" >nul 2>nul
if not errorlevel 1 exit /b 0
echo Downloading Electron binary...
call npx install-electron --no
node -e "try{const fs=require('fs');const electron=require('electron');process.exit(typeof electron==='string'&&fs.existsSync(electron)?0:1)}catch{process.exit(1)}" >nul 2>nul
if not errorlevel 1 exit /b 0
echo Default Electron download failed. Trying mirror: https://npmmirror.com/mirrors/electron/
set "OLD_ELECTRON_MIRROR=%ELECTRON_MIRROR%"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npx install-electron --no
if defined OLD_ELECTRON_MIRROR (set "ELECTRON_MIRROR=%OLD_ELECTRON_MIRROR%") else set "ELECTRON_MIRROR="
node -e "try{const fs=require('fs');const electron=require('electron');process.exit(typeof electron==='string'&&fs.existsSync(electron)?0:1)}catch{process.exit(1)}" >nul 2>nul
if errorlevel 1 (
  echo Electron binary download failed. You can run: npm config set electron_mirror https://npmmirror.com/mirrors/electron/
  exit /b 1
)
exit /b 0

:start_desktop_detached
node scripts\start-detached.js desktop %SERVER_ARGS%
exit /b %errorlevel%

:wait_url
for /l %%i in (1,1,12) do (
  if exist "%URL_FILE%" goto url_ready
  ping -n 2 127.0.0.1 >nul 2>nul
)
echo TunnelDesk started, but the web URL file is not ready yet.
echo Check data\web.log and data\startup-status.json for the startup error.
echo The configured port may have moved automatically when it was occupied.
set "EXIT_CODE=1"
goto done

:url_ready
set /p WEB_URL=<"%URL_FILE%"
echo Open %WEB_URL%
call :check_web_api "%WEB_URL%"
call :print_lan_urls
if not defined DESKTOP_MODE if not "%TUNNELDESK_NO_BROWSER%"=="1" start "" "%WEB_URL%"
goto done

:check_web_api
powershell -NoProfile -Command "$url='%~1'.TrimEnd('/') + '/api/connections'; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Web API health check warning: %~1/api/connections is not ready yet.
) else (
  echo Web API OK.
)
exit /b 0

:print_lan_urls
if exist "%INFO_FILE%" (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $info=Get-Content '%INFO_FILE%' -Raw | ConvertFrom-Json; $urls=@($info.lan_urls); if($urls.Count){ 'LAN access:'; $urls | ForEach-Object { '  ' + $_ } } } catch {}"`) do echo %%i
  exit /b 0
)
for /f "tokens=1" %%i in ('powershell -NoProfile -Command "$port=[int]($env:TUNNEL_WEB_PORT -as [int]); if (-not $port -and (Test-Path 'data\runtime-settings.json')) { try { $port=[int]((Get-Content 'data\runtime-settings.json' -Raw | ConvertFrom-Json).listen_port) } catch {} }; if (-not $port) { $port=8088 }; Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Sort-Object InterfaceAlias,IPAddress | ForEach-Object { 'http://' + $_.IPAddress + ':' + $port }" 2^>nul') do echo   %%i
exit /b 0

:check_existing_instance
if not exist "%PID_FILE%" exit /b 1
set "WEB_PID="
set /p WEB_PID=<"%PID_FILE%"
if not defined WEB_PID exit /b 1
powershell -NoProfile -Command "try { $p=Get-CimInstance Win32_Process -Filter 'ProcessId=%WEB_PID%' -ErrorAction Stop; $cmd=($p.CommandLine + ' ' + $p.Name).ToLower(); if($cmd.Contains('tunneldesk') -or $cmd.Contains('dist\\server.js')){ exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
exit /b %errorlevel%

:already_running
set "WEB_URL="
if exist "%URL_FILE%" set /p WEB_URL=<"%URL_FILE%"
echo TunnelDesk is already running, pid=%WEB_PID%.
if defined WEB_URL echo Open %WEB_URL%
call :print_lan_urls
if not "%TUNNELDESK_WEB_ONLY%"=="1" if exist "node_modules\.bin\electron.cmd" (
  node scripts\start-detached.js desktop >nul 2>nul
  echo The existing desktop window has been brought to the foreground.
) else (
  echo The existing headless service remains active; no second process was started.
)
goto done

:parse_server_args
if "%~1"=="" exit /b 0
if "%~1"=="--host" (
  set "TUNNEL_WEB_HOST=%~2"
  if "%~2"=="0.0.0.0" set "SHOW_LAN_URLS=1"
  shift
  shift
  goto parse_server_args
)
if "%~1"=="--port" (
  set "TUNNEL_WEB_PORT=%~2"
  shift
  shift
  goto parse_server_args
)
shift
goto parse_server_args

:failed
echo TunnelDesk failed to start.
set "EXIT_CODE=%errorlevel%"
if not "%TUNNELDESK_NO_PAUSE%"=="1" pause

:done
echo Use stop.bat to stop TunnelDesk and SSH tunnels.
if "%TUNNELDESK_KEEP_WINDOW%"=="1" pause
if defined EXIT_CODE exit /b %EXIT_CODE%
