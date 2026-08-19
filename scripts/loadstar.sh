#!/usr/bin/env bash
# Loadstar launcher — macOS and Linux share this file.
#
# WHY: JMeter ships a .bat/.sh, and that is why people who are not developers can
# run it. "git clone, docker compose up -d, remember --build when files change,
# then open a URL" is a developer workflow and a wall for the audience the README
# targets.
#
# WHAT IT WILL NOT DO: install Docker. A script that silently downloads a
# multi-gigabyte system tool needing admin rights and a licence acceptance is one
# nobody should trust, and it cannot be done honestly anyway — the correct version
# is OS-dependent (macOS 12 must have 4.41.2; 4.42+ refuses to run there). It
# detects, checks, and says what to do. STARTING an already-installed app is a
# different matter and is automatic.
#
# WHY IT REMEMBERS ITS PATH: a thing called a shortcut should survive being moved.
# Resolving the install from $0 alone breaks the moment someone copies this to
# their Desktop — which is exactly what they will do. First successful run records
# the install directory; after that this file works from anywhere.
set -uo pipefail

URL="http://localhost:8080"
API_TIMEOUT=120
STATE_DIR="${HOME}/.loadstar"
STATE_FILE="${STATE_DIR}/install-path"

say()  { printf '\n  %s\n' "$*"; }
fail() { printf '\n  ✗ %s\n\n' "$*"; read -r -p "  Press Enter to close. " _ </dev/tty 2>/dev/null || true; exit 1; }

open_browser() {
  if   command -v open     >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  else say "Open this in your browser: $1"; fi
}

# Resolve symlinks so a macOS alias or a `ln -s` still finds the real file.
SELF="$0"
while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"

printf '\n  Loadstar\n  ────────\n'

# ---- 0. Where is Loadstar installed? ----------------------------------------
INSTALL=""
FIRST_RUN=0
for cand in "$SELF_DIR" "$SELF_DIR/.."; do
  if [ -f "$cand/docker-compose.yml" ]; then INSTALL="$(cd "$cand" && pwd)"; break; fi
done
if [ -n "$INSTALL" ]; then
  [ -f "$STATE_FILE" ] || FIRST_RUN=1
  mkdir -p "$STATE_DIR" && printf '%s\n' "$INSTALL" > "$STATE_FILE"
elif [ -f "$STATE_FILE" ]; then
  INSTALL="$(cat "$STATE_FILE")"
  [ -f "$INSTALL/docker-compose.yml" ] || fail "Loadstar was installed at:
      $INSTALL
  …but it is not there any more (moved or deleted?).

  Run this file once from inside the Loadstar folder to point it at the new location."
else
  fail "This copy does not know where Loadstar is installed yet.

  Run it ONCE from inside the Loadstar folder you cloned — after that you can
  copy this file anywhere: your Desktop, your dock, wherever you like."
fi
cd "$INSTALL" || fail "Could not enter $INSTALL"

# ---- 1. Docker present? -----------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ]; then
    MACVER_FULL="$(sw_vers -productVersion 2>/dev/null || echo '')"
    MACVER_MAJ="$(printf '%s' "$MACVER_FULL" | cut -d. -f1)"
    EXTRA=""
    if [ -n "$MACVER_MAJ" ] && [ "$MACVER_MAJ" -le 12 ] 2>/dev/null; then
      EXTRA="
  NOTE: you are on macOS ${MACVER_FULL}. Docker Desktop 4.42 and later require
  macOS 13.3. You need 4.41.2 — the last version that supports your macOS."
    fi
    fail "Docker is not installed.

  Get Docker Desktop: https://www.docker.com/products/docker-desktop/${EXTRA}

  Install it, then run this again."
  else
    fail "Docker is not installed.

  Install guide: https://docs.docker.com/engine/install/
  Then run this again."
  fi
fi

# ---- 2. Docker running? Start it if installed but asleep. -------------------
if ! docker info >/dev/null 2>&1; then
  say "Docker is installed but not running — starting it…"
  if [ "$(uname -s)" = "Darwin" ]; then
    open -a Docker 2>/dev/null || fail "Could not start Docker Desktop. Start it yourself, then run this again."
  else
    systemctl --user start docker-desktop 2>/dev/null || sudo systemctl start docker 2>/dev/null || true
  fi
  printf '  Waiting for Docker'
  for i in $(seq 1 90); do
    docker info >/dev/null 2>&1 && break
    [ "$i" -eq 90 ] && { printf '\n'; fail "Docker did not start within 90s. Start it yourself, then run this again."; }
    printf '.'; sleep 1
  done
  printf '\n'
fi

# ---- 3. Compose v2? `docker-compose` (v1) is a different, older tool. -------
docker compose version >/dev/null 2>&1 || fail "This needs Docker Compose v2 — the 'docker compose' subcommand.
  Your Docker is too old. Update Docker Desktop, then run this again."

# ---- 4. .env ----------------------------------------------------------------
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  say "Created .env — add ANTHROPIC_API_KEY there if you want AI analysis (optional)."
fi

# ---- 5. Up. A first run BUILDS, and six silent minutes look like a hang. ----
# `docker compose ps ... | grep -q loadstar` LOOKS right and is broken under
  # `set -o pipefail`: grep -q exits at the first match, closing the pipe, so
  # compose dies on SIGPIPE and pipefail propagates that failure. The stack was
  # running and both scripts reported it stopped. Capture, then match.
  PS_OUT="$(docker compose ps --status running 2>/dev/null || true)"
if printf '%s' "$PS_OUT" | grep -q loadstar; then
  say "Loadstar is already running."
else
  if ! docker image inspect loadstar-v01-api >/dev/null 2>&1; then
    say "First run: building images. About 5–10 minutes."
    say "Every run after this starts in seconds."
  else
    say "Starting…"
  fi
  # LOADSTAR_WORKERS lets someone run distributed tests without remembering
  # `--scale`. Read from .env so it survives restarts. The controller is itself a
  # worker AND BLOCKS while coordinating, so N shards need N+1 workers — see
  # migration 019. On ONE machine extra generators contend for the same cores and
  # add no capacity; this exists so the feature is reachable, not because it makes
  # a laptop faster.
  WORKERS="$(grep -E '^LOADSTAR_WORKERS=[0-9]+' .env 2>/dev/null | tail -1 | cut -d= -f2)"
  # "${WORKERS:-1}" substitutes the default INTO THE TEST ONLY — the variable stays
  # empty, so the '' pattern never matched and the -lt below compared an empty
  # string as an integer. Every default run printed two "integer expression
  # expected" errors and worked anyway, which is the worst kind of broken.
  # Assign the default, do not merely test with it.
  [ -z "$WORKERS" ] && WORKERS=1
  case "$WORKERS" in *[!0-9]*) WORKERS=1 ;; esac
  [ "$WORKERS" -lt 1 ] && WORKERS=1
  if [ "$WORKERS" -gt 1 ]; then
    say "Starting with $WORKERS load generators (LOADSTAR_WORKERS in .env)."
    docker compose up -d --scale worker="$WORKERS" || fail "Docker could not start Loadstar — the output above says why."
  else
    docker compose up -d || fail "Docker could not start Loadstar — the output above says why."
  fi
fi

# ---- 6. Wait for the API to ANSWER, not merely for containers to exist. -----
printf '\n  Waiting for Loadstar'
for i in $(seq 1 "$API_TIMEOUT"); do
  if curl -fsS "$URL/api/config" >/dev/null 2>&1; then
    printf '\n'
    open_browser "$URL"
    say "Ready — Loadstar is at $URL"
    if [ "$FIRST_RUN" = "1" ]; then
      printf '\n  ────────────────────────────────────────────────────────────\n'
      printf '  Loadstar is installed at:\n    %s\n' "$INSTALL"
      printf '  This file now works from anywhere — it remembers that path.\n'
      printf '  ────────────────────────────────────────────────────────────\n'
      # ASK, never assume. Writing to somebody's Desktop uninvited is what
      # unwanted software does. One keypress, defaulting to yes because they
      # have to be reading this to answer at all.
      DESKTOP=""
      for d in "$HOME/Desktop" "$(xdg-user-dir DESKTOP 2>/dev/null || true)"; do
        [ -n "$d" ] && [ -d "$d" ] && { DESKTOP="$d"; break; }
      done
      if [ -n "$DESKTOP" ] && [ -t 0 ]; then
        printf '\n  Put a shortcut on your Desktop? [Y/n] '
        read -r ANSWER </dev/tty 2>/dev/null || ANSWER=""
        case "${ANSWER:-y}" in
          [Nn]*) say "No shortcut made — copy this file wherever you like." ;;
          *)
            SHORTCUT_SRC="$SELF"
            case "$SELF" in *scripts/loadstar.sh) [ -f "$INSTALL/Start Loadstar.command" ] && SHORTCUT_SRC="$INSTALL/Start Loadstar.command" ;; esac
            # BOTH shortcuts, always. Copying only Start while the script tells
            # the user to "use Stop Loadstar" leaves them hunting for a file that
            # is not where they were told to look.
            if cp "$SHORTCUT_SRC" "$DESKTOP/Start Loadstar.command" 2>/dev/null; then
              chmod +x "$DESKTOP/Start Loadstar.command" 2>/dev/null
              say "Added: $DESKTOP/Start Loadstar.command"
              if [ -f "$INSTALL/Stop Loadstar.command" ] && cp "$INSTALL/Stop Loadstar.command" "$DESKTOP/Stop Loadstar.command" 2>/dev/null; then
                chmod +x "$DESKTOP/Stop Loadstar.command" 2>/dev/null
                say "Added: $DESKTOP/Stop Loadstar.command"
              fi
              if [ "$(uname -s)" = "Darwin" ]; then
                say "macOS will block it the first time (unsigned). Right-click it → Open,"
                say "then click Open in the dialog. Only needed once."
              fi
              say "Move it anywhere you prefer — it will still work."
            else
              say "Could not write to $DESKTOP — copy this file there yourself if you want to."
            fi ;;
        esac
      else
        say "Copy this file anywhere you like — Desktop, dock, wherever."
      fi
    else
      say "Tip: this file works from anywhere — copy it to your Desktop if you like."
    fi
    say "To stop Loadstar, use 'Stop Loadstar'."
    printf '\n'
    exit 0
  fi
  printf '.'; sleep 1
done
printf '\n'
fail "Loadstar started but did not answer within ${API_TIMEOUT}s.
  See what happened:  cd '$INSTALL' && docker compose logs --tail=40 api"
