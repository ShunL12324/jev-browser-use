#!/bin/sh
# Starts the bridge for the tester with the Jev key read from a local env
# file (JEV_KEY_FILE, default /tmp/jev-tester/typesafe.env) containing one
# line TYPESAFE_API_KEY=... . The file must be owned by you with mode 0600.
# Only that variable is read; the file is never sourced or printed.
set -eu
key_file="${JEV_KEY_FILE:-/tmp/jev-tester/typesafe.env}"
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  [ -f "$key_file" ] || { echo "start-bridge: key file $key_file not found" >&2; exit 1; }
  mode=$(stat -c %a "$key_file")
  [ "$mode" = "600" ] || [ "$mode" = "400" ] || { echo "start-bridge: $key_file must be mode 0600" >&2; exit 1; }
  TYPESAFE_API_KEY=$(sed -n 's/^\(export \)\{0,1\}TYPESAFE_API_KEY=//p' "$key_file" | head -n 1 | tr -d "\"'\r")
  [ -n "$TYPESAFE_API_KEY" ] || { echo "start-bridge: no TYPESAFE_API_KEY in $key_file" >&2; exit 1; }
  export TYPESAFE_API_KEY
fi
exec node "$(dirname "$0")/../../packages/bridge/dist/index.js"
