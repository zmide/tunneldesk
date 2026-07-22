#!/data/data/com.termux/files/usr/bin/sh
cd "$(dirname "$0")"

TERMUX_ANDROID_NDK_PATH=""
if [ "$(uname -o 2>/dev/null)" = "Android" ] && [ -n "$PREFIX" ]; then
  TERMUX_ANDROID_NDK_PATH="${npm_config_android_ndk_path:-$PREFIX}"
fi

npm_install() {
  if [ -n "$TERMUX_ANDROID_NDK_PATH" ]; then
    npm_config_android_ndk_path="$TERMUX_ANDROID_NDK_PATH" npm install --include=dev
  else
    npm install --include=dev
  fi
}

has_gui() {
  [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ] || { [ "$(uname 2>/dev/null)" = "Darwin" ] && [ -z "$SSH_CONNECTION" ] && [ -z "$SSH_TTY" ]; }
}

is_windows_shell() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

pid_is_running() {
  pid="$1"
  if is_windows_shell && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "try { Get-Process -Id $pid -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }" >/dev/null 2>&1
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

process_command() {
  pid="$1"
  if is_windows_shell && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "try { \$p=Get-CimInstance Win32_Process -Filter 'ProcessId=$pid' -ErrorAction Stop; Write-Output ((\$p.Name + ' ' + \$p.CommandLine).Trim()) } catch {}" 2>/dev/null
  else
    ps -p "$pid" -o command= 2>/dev/null || true
  fi
}

if [ -f data/web.pid ]; then
  PID="$(cat data/web.pid 2>/dev/null || true)"
  case "$PID" in
    ''|*[!0-9]*) ;;
    *)
      if pid_is_running "$PID"; then
        PROCESS_COMMAND="$(process_command "$PID")"
        if [ -n "$PROCESS_COMMAND" ] && ! printf '%s' "$PROCESS_COMMAND" | grep -Eiq '(tunneldesk|dist/server\.js|electron)'; then
          echo "Ignoring stale TunnelDesk PID file that now belongs to pid=$PID."
        else
          WEB_URL="$(cat data/web.url 2>/dev/null || true)"
          echo "TunnelDesk is already running, pid=$PID"
          [ -n "$WEB_URL" ] && echo "Open $WEB_URL"
          if [ -f data/web.json ] && command -v node >/dev/null 2>&1; then
            node -e "try{const d=require('fs').readFileSync('data/web.json','utf8'); const j=JSON.parse(d); for(const u of (j.lan_urls||[])) console.log('  '+u)}catch{}"
          fi
          if [ "$TUNNELDESK_WEB_ONLY" != "1" ] && has_gui && printf '%s' "$PROCESS_COMMAND" | grep -Eiq '(electron|tunneldesk)'; then
            if [ -x node_modules/.bin/electron ]; then
              npm run desktop:run >/dev/null 2>&1 &
              echo "The existing desktop window has been brought to the foreground."
            else
              echo "The existing desktop process is active; Electron is not installed in this checkout."
            fi
          else
            echo "The existing headless service remains active; no second process was started."
          fi
          exit 0
        fi
      fi
      ;;
  esac
fi

if [ ! -f node_modules/@xterm/xterm/lib/xterm.js ] || [ ! -f node_modules/@xterm/addon-fit/lib/addon-fit.js ] || [ ! -x node_modules/.bin/tsc ]; then
  npm_install || exit 1
fi
if [ "$TUNNELDESK_WEB_ONLY" != "1" ] && [ ! -x node_modules/.bin/electron ]; then
  npm_install || exit 1
fi
npm run build >/dev/null || exit 1

mkdir -p data
SERVER_ARGS="$@"
SHOW_LAN_URLS=""
parse_server_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host)
        TUNNEL_WEB_HOST="$2"
        [ "$2" = "0.0.0.0" ] && SHOW_LAN_URLS=1
        shift 2
        ;;
      --port)
        TUNNEL_WEB_PORT="$2"
        shift 2
        ;;
      *) shift ;;
    esac
  done
  export TUNNEL_WEB_HOST TUNNEL_WEB_PORT
}
parse_server_args "$@"
case " $SERVER_ARGS " in
  *" --host 0.0.0.0 "*) SHOW_LAN_URLS=1 ;;
esac
if [ "$TUNNELDESK_LAN" = "1" ]; then
  SERVER_ARGS="--host 0.0.0.0 $SERVER_ARGS"
  TUNNEL_WEB_HOST="0.0.0.0"
  export TUNNEL_WEB_HOST
  SHOW_LAN_URLS=1
fi

rm -f data/web.url data/web.json

open_url() {
  [ "$TUNNELDESK_NO_BROWSER" = "1" ] && return 0
  if command -v termux-open-url >/dev/null 2>&1; then termux-open-url "$1" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 &
  fi
}

check_web_api() {
  url="${1%/}/api/connections"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && { echo "Web API OK."; return 0; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$url" >/dev/null 2>&1 && { echo "Web API OK."; return 0; }
  else
    return 0
  fi
  echo "Web API health check warning: $url is not ready yet."
  return 0
}

wait_for_url() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [ -f data/web.url ]; then
      WEB_URL="$(cat data/web.url)"
      echo "Open $WEB_URL"
      check_web_api "$WEB_URL"
      if [ -f data/web.json ] && command -v node >/dev/null 2>&1; then
        node -e "try{const data=require('fs').readFileSync('data/web.json','utf8'); const urls=JSON.parse(data).lan_urls||[]; if(urls.length){ console.log('LAN access:'); for(const url of urls) console.log('  '+url)}}catch{}"
      fi
      [ "$1" = "open_browser" ] && open_url "$WEB_URL"
      echo "Use ./stop.sh to stop TunnelDesk and SSH tunnels."
      return 0
    fi
    sleep 1
  done
  echo "TunnelDesk started, but the web URL file is not ready yet."
  echo "Check data/web.log and data/startup-status.json for the startup error."
  echo "The configured port may have moved automatically when it was occupied."
  echo "Use ./stop.sh to stop TunnelDesk and SSH tunnels."
  return 1
}

if [ "$1" = "--foreground" ]; then
  shift
  node dist/server.js "$@"
  exit $?
fi

if [ "$TUNNELDESK_WEB_ONLY" != "1" ] && has_gui && [ -x node_modules/.bin/electron ]; then
  if ! node -e "try{const fs=require('fs'); const electron=require('electron'); process.exit(typeof electron==='string' && fs.existsSync(electron) ? 0 : 1)}catch{process.exit(1)}" >/dev/null 2>&1; then
    echo "Downloading Electron binary..."
    npx install-electron --no >/dev/null 2>&1 || true
    if ! node -e "try{const fs=require('fs'); const electron=require('electron'); process.exit(typeof electron==='string' && fs.existsSync(electron) ? 0 : 1)}catch{process.exit(1)}" >/dev/null 2>&1; then
      echo "Default Electron download failed. Trying mirror: https://npmmirror.com/mirrors/electron/"
      ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" npx install-electron --no >/dev/null 2>&1 || true
    fi
  fi
  if node -e "try{const fs=require('fs'); const electron=require('electron'); process.exit(typeof electron==='string' && fs.existsSync(electron) ? 0 : 1)}catch{process.exit(1)}" >/dev/null 2>&1; then
    npm run desktop:run -- "$@" >/dev/null 2>&1 &
    echo "TunnelDesk desktop is starting."
    echo "Mode: desktop. Web log: data/web.log"
    echo "Set TUNNELDESK_WEB_ONLY=1 to force background Web mode."
    wait_for_url
    exit 0
  fi
  echo "Electron binary download failed. Started Web mode instead."
fi

if command -v setsid >/dev/null 2>&1; then
  setsid node dist/server.js $SERVER_ARGS > data/web.log 2>&1 < /dev/null &
elif command -v nohup >/dev/null 2>&1; then
  nohup node dist/server.js $SERVER_ARGS > data/web.log 2>&1 < /dev/null &
else
  node dist/server.js $SERVER_ARGS > data/web.log 2>&1 < /dev/null &
fi

echo "TunnelDesk is starting in the background."
if [ "$TUNNELDESK_WEB_ONLY" = "1" ]; then
  echo "Mode: Web-only requested by TUNNELDESK_WEB_ONLY=1."
else
  echo "Mode: Web fallback or headless environment."
fi
echo "Web log: data/web.log"
wait_for_url open_browser
