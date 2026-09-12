#!/bin/zsh
set -eu
unset ELECTRON_RUN_AS_NODE
# A successful user quit writes this atomically before child shutdown. Updates
# use a separate reason and must remain restartable by the watchdog.
intentional_stop="$HOME/Library/Application Support/NODO/intentional-stop.json"
if [[ -f "$intentional_stop" ]] && /usr/bin/grep -Eq '"intentional"[[:space:]]*:[[:space:]]*true' "$intentional_stop" && /usr/bin/grep -Eq '"reason"[[:space:]]*:[[:space:]]*"user"' "$intentional_stop"; then
  exit 0
fi
# Stable installed slot; never fall back to a development build and never kill.
nodo_app="$HOME/Applications/NODO.app"
[[ -d "$nodo_app" ]] || { print -u2 'Installed NODO is missing; use Rescue.'; exit 1; }
/usr/bin/codesign --verify --deep --strict "$nodo_app"
# open reuses a running app. A hung runtime requires a verified drain via Rescue.
exec /usr/bin/open "$nodo_app"
