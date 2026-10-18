#!/bin/bash
# Restart the whole PDS stack: backend, frontend, beneficiary app (Expo), IoT bridge.
#   ./restart-all.sh         stop anything running, then start all four
#   ./restart-all.sh stop    stop all four
# Logs: logs/<service>.log    PIDs: .run/<service>.pid
# Follow everything: tail -f logs/*.log

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs"
RUN_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR" "$RUN_DIR"

BACKEND_PORT=5055
FRONTEND_PORT=5173
EXPO_PORT=8081

stop_port() {
  local port=$1 label=$2 pids
  pids=$(lsof -ti :"$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    sleep 1
    pids=$(lsof -ti :"$port" 2>/dev/null)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    echo "  stopped $label (port $port)"
  fi
}

stop_bridge() {
  # Match node processes whose working directory is iot-bridge.
  local pid
  for pid in $(pgrep -f "node src/index.js" 2>/dev/null); do
    if lsof -a -p "$pid" -d cwd 2>/dev/null | grep -q "$ROOT/iot-bridge"; then
      kill "$pid" 2>/dev/null && echo "  stopped IoT bridge (pid $pid)"
    fi
  done
}

stop_all() {
  echo "== Stopping PDS services =="
  stop_port "$BACKEND_PORT" "backend"
  stop_port "$FRONTEND_PORT" "frontend"
  stop_port "$EXPO_PORT" "beneficiary app"
  stop_bridge
  rm -f "$RUN_DIR"/*.pid
}

start_service() {
  local name=$1 dir=$2 cmd=$3
  (
    cd "$ROOT/$dir" || exit 1
    nohup bash -c "$cmd" > "$LOG_DIR/$name.log" 2>&1 &
    echo $! > "$RUN_DIR/$name.pid"
  )
  echo "  started $name  (log: logs/$name.log)"
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  echo "Done."
  exit 0
fi

stop_all
sleep 1

echo "== Starting PDS services =="
start_service backend     pds-backend       "npm run dev"
start_service frontend    pds-frontend      "npm run dev -- --port $FRONTEND_PORT"
start_service beneficiary pds-beneficiary   "CI=1 npx expo start --port $EXPO_PORT"
start_service bridge      iot-bridge        "npm start"

echo
echo "== Waiting for backend =="
for i in $(seq 1 30); do
  if curl -s -m 2 "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
    echo "  backend healthy on http://localhost:$BACKEND_PORT"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "  backend not healthy after 30s - see logs/backend.log"
  fi
  sleep 1
done

echo
echo "Frontend:    http://localhost:$FRONTEND_PORT"
echo "Backend:     http://localhost:$BACKEND_PORT"
echo "Beneficiary: Expo on port $EXPO_PORT (QR code in logs/beneficiary.log)"
echo "Bridge:      logs/bridge.log (needs the ESP32 plugged in)"
echo
echo "Follow all logs: tail -f logs/*.log"
echo "Stop all:        ./restart-all.sh stop"
