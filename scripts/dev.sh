#!/usr/bin/env bash
# Shopz – start the whole demo locally: demo stores, browser controller, agent + control panel.
#
#   bash scripts/dev.sh            start everything and open the panel window on the right
#   bash scripts/dev.sh --no-open  start everything, do not open a browser window
#
# This script loads no secrets. From .env it only reads BROWSER_MODE, CONTROLLER_URL and the
# port settings, with a plain line parser (the file is never sourced). Each server reads its own
# credentials. Ctrl+C stops every process this script started. Works on macOS and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OPEN_PANEL=1
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_PANEL=0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then C_DIM=$'\033[2m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_OFF=$'\033[0m'
else C_DIM=''; C_YEL=''; C_RED=''; C_GRN=''; C_OFF=''; fi
log()  { printf '%s[dev]%s %s\n' "$C_YEL" "$C_OFF" "$*"; }
warn() { printf '%s[dev] warning:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
die()  { printf '%s[dev] error:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- settings (.env read safely)
# env_file_value KEY → prints the value of KEY from .env. Never evaluates anything.
env_file_value() {
  local key="$1" file="$ROOT/.env" line val found=1
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"   # trim leading whitespace
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    case "$line" in
      "$key="*) val="${line#"$key="}"; found=0 ;;
    esac
  done < "$file"
  [ "$found" -eq 0 ] || return 1
  val="${val#"${val%%[![:space:]]*}"}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
    *) val="${val%%[[:space:]]#*}"; val="${val%"${val##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$val"
}
# setting NAME DEFAULT → value from the environment, else from .env, else DEFAULT
setting() {
  local name="$1" def="$2" val
  val="${!name:-}"
  [ -n "$val" ] || val="$(env_file_value "$name" || true)"
  [ -n "$val" ] || val="$def"
  printf '%s' "$val"
}
is_port() { case "$1" in ''|*[!0-9]*) return 1 ;; *) [ "$1" -ge 1 ] && [ "$1" -le 65535 ] ;; esac; }

AGENT_PORT="$(setting AGENT_PORT 3000)"
RUNHUB_PORT="$(setting RUNHUB_PORT 4001)"
DAILYCART_PORT="$(setting DAILYCART_PORT 4002)"
CONTROLLER_URL="$(setting CONTROLLER_URL http://localhost:4100)"
BROWSER_MODE="$(setting BROWSER_MODE playwright | tr '[:upper:]' '[:lower:]')"
for p in "$AGENT_PORT" "$RUNHUB_PORT" "$DAILYCART_PORT"; do is_port "$p" || die "Invalid port setting: '$p'"; done
CONTROLLER_PORT="${CONTROLLER_URL#*://}"; CONTROLLER_PORT="${CONTROLLER_PORT%%/*}"; CONTROLLER_PORT="${CONTROLLER_PORT##*:}"
is_port "$CONTROLLER_PORT" || CONTROLLER_PORT=4100
case "$BROWSER_MODE" in
  nova|playwright|headless) ;;
  *) warn "Unknown BROWSER_MODE '$BROWSER_MODE' – using playwright."; BROWSER_MODE=playwright ;;
esac
export AGENT_PORT RUNHUB_PORT DAILYCART_PORT BROWSER_MODE

command -v node >/dev/null 2>&1 || die "node not found (Node.js 18.17 or newer is required)."
[ -f apps/merchants/server.js ] || die "apps/merchants/server.js not found."
[ -f apps/agent/server.js ] || die "apps/agent/server.js not found."
HAVE_CURL=0; command -v curl >/dev/null 2>&1 && HAVE_CURL=1

port_open() { (exec 3<>"/dev/tcp/localhost/$1") >/dev/null 2>&1; }
for p in "$AGENT_PORT" "$RUNHUB_PORT" "$DAILYCART_PORT"; do
  if port_open "$p"; then die "Port $p is already in use – is another dev.sh still running? Stop it first."; fi
done

# ---------------------------------------------------------------- process bookkeeping
CHILDREN=""      # "name:pid name:pid …"
PROFILE_DIR=""   # temporary browser profile of the panel window
CLEANED=0

cleanup() {
  local code=$? entry pid i alive
  [ "$CLEANED" -eq 1 ] && return
  CLEANED=1
  trap - INT TERM
  if [ -n "$CHILDREN" ]; then
    echo
    log "Stopping…"
    for entry in $CHILDREN; do kill -TERM "${entry#*:}" 2>/dev/null || true; done
    i=0
    while [ "$i" -lt 20 ]; do
      alive=0
      for entry in $CHILDREN; do kill -0 "${entry#*:}" 2>/dev/null && alive=1; done
      [ "$alive" -eq 0 ] && break
      sleep 0.25; i=$((i + 1))
    done
    for entry in $CHILDREN; do kill -KILL "${entry#*:}" 2>/dev/null || true; done
  fi
  if [ -n "$PROFILE_DIR" ]; then
    pkill -f -- "--user-data-dir=$PROFILE_DIR" 2>/dev/null || true
    sleep 0.3
    rm -rf "$PROFILE_DIR" 2>/dev/null || true
  fi
  [ -n "$CHILDREN" ] && log "All stopped."
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

prefix() { awk -v tag="$1" '{ print tag " " $0; fflush() }'; }

# start NAME COMMAND… → runs in the background with prefixed output, sets LAST_PID
start() {
  local name="$1"; shift
  "$@" > >(prefix "${C_DIM}[$name]${C_OFF}") 2>&1 &
  LAST_PID=$!
  CHILDREN="$CHILDREN $name:$LAST_PID"
}
forget() { # forget NAME → stop tracking a child that is gone
  local entry keep=""
  for entry in $CHILDREN; do [ "${entry%%:*}" = "$1" ] || keep="$keep $entry"; done
  CHILDREN="$keep"
}

# wait_ready URL PORT SECONDS PID → 0 ready · 1 timeout · 2 process exited
wait_ready() {
  local url="$1" port="$2" secs="$3" pid="$4" i=0
  while [ "$i" -lt $((secs * 4)) ]; do
    if [ "$HAVE_CURL" -eq 1 ]; then
      curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null && return 0
    else
      port_open "$port" && return 0
    fi
    kill -0 "$pid" 2>/dev/null || return 2
    sleep 0.25; i=$((i + 1))
  done
  return 1
}

py_has() { python3 -c 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)' "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 1. demo stores
log "Starting demo stores (RunHub :$RUNHUB_PORT, DailyCart :$DAILYCART_PORT)…"
start merchants node apps/merchants/server.js
MERCHANTS_PID=$LAST_PID
for p in "$RUNHUB_PORT" "$DAILYCART_PORT"; do
  rc=0; wait_ready "http://localhost:$p/" "$p" 30 "$MERCHANTS_PID" || rc=$?
  [ "$rc" -eq 0 ] || die "Demo stores did not come up on port $p (see [merchants] output above)."
done

# ---------------------------------------------------------------- 2. browser controller (optional)
CONTROLLER_STATE="skipped"
start_controller() {
  local mode="$BROWSER_MODE" rc secs
  if [ ! -f apps/browser/controller.py ]; then warn "apps/browser/controller.py not found – skipping the browser controller."; return; fi
  if ! command -v python3 >/dev/null 2>&1; then warn "python3 not found – skipping the browser controller."; return; fi
  if ! py_has playwright; then
    warn "Python package 'playwright' is missing – skipping the browser controller."
    warn "Install the controller's Python dependencies (see apps/browser) to get the live browser window."
    return
  fi
  if [ "$mode" = nova ] && ! py_has nova_act; then
    warn "BROWSER_MODE=nova but the 'nova_act' package is missing – starting the controller in playwright mode."
    mode=playwright
  fi
  if port_open "$CONTROLLER_PORT"; then warn "Port $CONTROLLER_PORT is already in use – not starting another browser controller."; CONTROLLER_STATE="already running"; return; fi
  log "Starting browser controller (mode $mode, :$CONTROLLER_PORT)…"
  start controller env BROWSER_MODE="$mode" python3 apps/browser/controller.py
  secs=40; [ "$mode" = nova ] && secs=90
  rc=0; wait_ready "http://localhost:$CONTROLLER_PORT/health" "$CONTROLLER_PORT" "$secs" "$LAST_PID" || rc=$?
  case "$rc" in
    0) CONTROLLER_STATE="mode $mode" ;;
    1) warn "Browser controller not healthy after ${secs}s – the agent may use direct page reads."; CONTROLLER_STATE="starting (not healthy yet)" ;;
    *) warn "Browser controller exited (see [controller] output) – the agent falls back to direct page reads."; forget controller; CONTROLLER_STATE="exited" ;;
  esac
}
start_controller

# ---------------------------------------------------------------- 3. agent + panel
log "Starting agent + panel (:$AGENT_PORT)…"
start agent node apps/agent/server.js
AGENT_PID=$LAST_PID
rc=0; wait_ready "http://localhost:$AGENT_PORT/api/audit/verify?session=boot" "$AGENT_PORT" 40 "$AGENT_PID" || rc=$?
[ "$rc" -eq 0 ] || die "Agent did not come up on port $AGENT_PORT (see [agent] output above)."

PANEL_URL="http://localhost:$AGENT_PORT"
echo
printf '  %sShopz is running%s\n' "$C_GRN" "$C_OFF"
printf '    Panel        %s\n' "$PANEL_URL"
printf '    RunHub       http://localhost:%s\n' "$RUNHUB_PORT"
printf '    DailyCart    http://localhost:%s\n' "$DAILYCART_PORT"
printf '    Controller   http://localhost:%s/health  (%s)\n' "$CONTROLLER_PORT" "$CONTROLLER_STATE"
printf '  Hold Space in the panel to talk · press ? there for operator keys · Ctrl+C here stops everything\n\n'

# ---------------------------------------------------------------- 4. panel window (right side)
panel_instructions() {
  log "Open the panel yourself: Chrome or Chromium with"
  log "  --app=$PANEL_URL --window-position=1180,0 --window-size=740,1050 --user-data-dir=<empty temp dir>"
}
open_panel() {
  local bin app
  PROFILE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shopz-panel.XXXXXX")"
  set -- --app="$PANEL_URL" --window-position=1180,0 --window-size=740,1050 --user-data-dir="$PROFILE_DIR" \
         --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required
  case "$(uname -s)" in
    Darwin)
      for app in "Google Chrome" "Chromium"; do
        if open -na "$app" --args "$@" >/dev/null 2>&1; then log "Panel window opened ($app)."; return 0; fi
      done
      ;;
    *)
      if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        warn "No graphical display found – not opening a window."
      else
        for bin in google-chrome google-chrome-stable chromium chromium-browser; do
          if command -v "$bin" >/dev/null 2>&1; then
            "$bin" "$@" >/dev/null 2>&1 &
            log "Panel window opened ($bin)."
            return 0
          fi
        done
      fi
      ;;
  esac
  rm -rf "$PROFILE_DIR"; PROFILE_DIR=""
  return 1
}
if [ "$OPEN_PANEL" -eq 1 ]; then
  open_panel || { warn "Chrome/Chromium not found."; panel_instructions; }
else
  panel_instructions
fi

# ---------------------------------------------------------------- 5. watch the children
while :; do
  for entry in $CHILDREN; do
    name="${entry%%:*}"; pid="${entry#*:}"
    if ! kill -0 "$pid" 2>/dev/null; then
      if [ "$name" = controller ]; then
        warn "Browser controller stopped – the agent falls back to direct page reads."
        forget controller
      else
        warn "$name exited – stopping everything."
        exit 1
      fi
    fi
  done
  sleep 1
done
