#!/usr/bin/env bash
# Stop Loadstar.
#
# WHY THIS IS A SEPARATE SHORTCUT AND NOT TIED TO THE BROWSER: closing a tab sends
# no signal to anything, and a user who closes one of two tabs — or checks their
# email mid-run — should not lose a fifteen-minute load test. Shutting down is a
# decision, so it gets a button.
#
# It WARNS about work in flight rather than refusing. Refusing would be its own
# annoyance; the user knows things this script does not.
set -uo pipefail

STATE_FILE="${HOME}/.loadstar/install-path"

say()  { printf '\n  %s\n' "$*"; }
fail() { printf '\n  ✗ %s\n\n' "$*"; read -r -p "  Press Enter to close. " _ </dev/tty 2>/dev/null || true; exit 1; }

SELF="$0"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"

printf '\n  Loadstar — stop\n  ───────────────\n'

INSTALL=""
for cand in "$SELF_DIR" "$SELF_DIR/.."; do
  [ -f "$cand/docker-compose.yml" ] && { INSTALL="$(cd "$cand" && pwd)"; break; }
done
[ -z "$INSTALL" ] && [ -f "$STATE_FILE" ] && INSTALL="$(cat "$STATE_FILE")"
[ -n "$INSTALL" ] && [ -f "$INSTALL/docker-compose.yml" ] || fail "Cannot find Loadstar.
  Run 'Start Loadstar' once from inside the Loadstar folder first."
cd "$INSTALL" || fail "Could not enter $INSTALL"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed — nothing to stop."
docker info >/dev/null 2>&1 || { say "Docker is not running — Loadstar is already stopped."; printf '\n'; exit 0; }

# `docker compose ps ... | grep -q loadstar` LOOKS right and is broken under
  # `set -o pipefail`: grep -q exits at the first match, closing the pipe, so
  # compose dies on SIGPIPE and pipefail propagates that failure. The stack was
  # running and both scripts reported it stopped. Capture, then match.
  PS_OUT="$(docker compose ps --status running 2>/dev/null || true)"
if ! printf '%s' "$PS_OUT" | grep -q loadstar; then
  say "Loadstar is not running."
  printf '\n'
  exit 0
fi

# ---- Is anything in flight? -------------------------------------------------
# A load test that is mid-run has no way to resume; stopping the worker loses it.
# 'analyzing' counts too — the load is done but the AI verdict is still being
# written, and killing it now means a report with no analysis.
ACTIVE=""
if printf '%s' "$PS_OUT" | grep -q loadstar-v01-db; then
  ACTIVE="$(docker compose exec -T db psql -U loadstar -d loadstar -A -t -c \
    "select count(*) from runs where status in ('running','queued','coordinating','analyzing');" 2>/dev/null | tr -d '[:space:]')"
fi

case "${ACTIVE:-0}" in ''|*[!0-9]*) ACTIVE=0 ;; esac

if [ "$ACTIVE" -gt 0 ]; then
  printf '\n  ⚠  %s test%s still running.\n' "$ACTIVE" "$( [ "$ACTIVE" = "1" ] && echo '' || echo 's' )"
  printf '     Stopping now loses %s — a run cannot be resumed.\n' "$( [ "$ACTIVE" = "1" ] && echo 'it' || echo 'them' )"
  if [ -t 0 ]; then
    printf '\n  Stop anyway? [y/N] '
    read -r ANSWER </dev/tty 2>/dev/null || ANSWER=""
    case "${ANSWER}" in
      [Yy]*) say "Stopping." ;;
      *) say "Left running. Loadstar is still at http://localhost:8080"; printf '\n'; exit 0 ;;
    esac
  else
    fail "Refusing to stop while $ACTIVE test(s) are running (no terminal to ask)."
  fi
fi

# Mark in-flight runs cancelled BEFORE the stack goes down. Killing the worker
# leaves the row at `running` with a null finished_at and nobody left to change
# it — the report then counts elapsed time forever, implying a test is alive when
# its process died minutes ago. The user has just explicitly accepted losing these
# runs, so saying so is honest, not presumptuous. `cancelled` is already handled
# correctly everywhere: excluded from comparisons, never counted as a pass.
if [ "$ACTIVE" -gt 0 ]; then
  docker compose exec -T db psql -U loadstar -d loadstar -q -c \
    "update runs set status='cancelled', finished_at=now(),
            error=coalesce(error, 'Stopped when Loadstar was shut down. Anything the run had already written is kept; a run killed before its first summary has no metrics.')
     where status in ('running','queued','coordinating','analyzing');" >/dev/null 2>&1 \
    && say "Marked $ACTIVE interrupted run(s) as cancelled." \
    || say "Could not mark the interrupted run(s) — they may show as still running."
fi

say "Stopping Loadstar…"
docker compose down || fail "Docker could not stop Loadstar — the output above says why."
say "Stopped. Your tests, runs and reports are kept — 'Start Loadstar' brings it all back."
printf '\n'
