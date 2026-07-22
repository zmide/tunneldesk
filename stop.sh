#!/data/data/com.termux/files/usr/bin/sh
cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"

PID_FILE="${1:-data/web.pid}"
URL_FILE="data/web.url"
INFO_FILE="data/web.json"

kill_by_name() {
  count=0
  for pattern in "$ROOT_DIR/dist/server.js" "$ROOT_DIR/desktop/main.js" "node dist/server.js" "electron ." "TunnelDesk"; do
    if command -v pgrep >/dev/null 2>&1; then
      for pid in $(pgrep -f "$pattern" 2>/dev/null); do
        if [ "$pid" != "$$" ] && kill -0 "$pid" 2>/dev/null; then
          kill "$pid" 2>/dev/null && count=$((count + 1))
        fi
      done
    else
      ps -ef 2>/dev/null | grep "$pattern" | grep -v grep | while read -r _ pid _; do
        [ "$pid" = "$$" ] && continue
        kill "$pid" 2>/dev/null
      done
    fi
  done
  echo "Stopped processes by name: $count"
  rm -f "$PID_FILE" "$URL_FILE" "$INFO_FILE"
}

if [ ! -f "$PID_FILE" ]; then
  echo "PID file not found: $PID_FILE"
  kill_by_name
  exit 0
fi

PID="$(cat "$PID_FILE")"
URL="http://127.0.0.1:${TUNNEL_WEB_PORT:-8088}"
if [ -f "$URL_FILE" ]; then
  URL="$(cat "$URL_FILE")"
fi

case "$PID" in
  ''|*[!0-9]*)
    echo "Invalid PID file: $PID_FILE"
    kill_by_name
    exit 0
    ;;
esac

if command -v node >/dev/null 2>&1; then
  if node -e "fetch(process.argv[1] + '/api/shutdown', { method: 'POST' }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$URL"; then
    echo "Stopped TunnelDesk gracefully, pid=$PID"
    kill_by_name
    exit 0
  fi
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped TunnelDesk, pid=$PID"
else
  echo "Process is not running, removing stale PID file"
fi

rm -f "$PID_FILE"
rm -f "$URL_FILE"
rm -f "$INFO_FILE"
kill_by_name
