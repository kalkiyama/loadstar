#!/usr/bin/env bash
# Double-clickable on macOS. Finder opens Terminal in $HOME, not here, so this
# resolves its own location rather than trusting the working directory.
#
# AND it must survive being COPIED — to the Desktop, or anywhere else. A copy has
# no scripts/ beside it, so falling back to the remembered install path is not a
# nicety: without it, the Desktop shortcut fails on the first double-click with
# "No such file or directory", which is exactly what happened the first time.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${HOME}/.loadstar/install-path"

if [ -x "$DIR/scripts/loadstar.sh" ]; then
  exec "$DIR/scripts/loadstar.sh"
elif [ -f "$STATE" ] && [ -x "$(cat "$STATE")/scripts/loadstar.sh" ]; then
  exec "$(cat "$STATE")/scripts/loadstar.sh"
else
  printf '\n  ✗ This shortcut cannot find Loadstar.\n\n'
  printf '  Run "Start Loadstar" once from inside the Loadstar folder you cloned.\n'
  printf '  After that, this copy will work from anywhere.\n\n'
  read -r -p "  Press Enter to close. " _
  exit 1
fi
