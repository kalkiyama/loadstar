#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${HOME}/.loadstar/install-path"
if [ -x "$DIR/scripts/loadstar-stop.sh" ]; then
  exec "$DIR/scripts/loadstar-stop.sh"
elif [ -f "$STATE" ] && [ -x "$(cat "$STATE")/scripts/loadstar-stop.sh" ]; then
  exec "$(cat "$STATE")/scripts/loadstar-stop.sh"
else
  printf '\n  ✗ This shortcut cannot find Loadstar.\n\n'
  printf '  Run "Start Loadstar" once from inside the Loadstar folder you cloned.\n\n'
  read -r -p "  Press Enter to close. " _
  exit 1
fi
