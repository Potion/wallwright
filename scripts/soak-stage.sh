#!/usr/bin/env bash
# Push everything a soak run needs onto HQ-PROTO-MINI-2, then run the pre-flight.
#
# Deliberately stops short of starting the run. Staging is reversible and starting
# is not: a 72-hour run commits somebody else's machine for three days, and the
# first attempt died because that commitment was never communicated. So this
# leaves the stage ready and prints the one command that begins T0.
#
# Usage:
#   scripts/soak-stage.sh path/to/Wallwright-0.1.1-x64.zip
#
set -euo pipefail

ZIP="${1:-}"
HOST="${SOAK_HOST:-100.98.111.111}"
USER="${SOAK_USER:-proto}"
KEY="${SOAK_KEY:-$HOME/.ssh/fcat_wall_deploy_ed25519}"
STAGE='C:\Users\proto\wallwright-soak'
STAGE_POSIX='wallwright-soak'

if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "usage: $0 <path to Wallwright-*-x64.zip>" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$USER@$HOST")
SCP=(scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY")

say() { printf '\n=== %s\n' "$1"; }

say "Target"
# </dev/null on every ssh call: without it a read loop in this script would
# consume its own stdin, which is a footgun the runbook calls out by name.
"${SSH[@]}" 'hostname && ver' </dev/null

say "Making the stage"
"${SSH[@]}" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path '$STAGE\\mock' | Out-Null\"" </dev/null

say "Copying the build"
"${SCP[@]}" "$ZIP" "$USER@$HOST:$STAGE_POSIX/"

say "Copying the harness"
# soak.js and soak-stats.js import nothing from src/, which is what makes this
# two files rather than a checkout.
"${SCP[@]}" \
  "$REPO/src/dev/soak.js" \
  "$REPO/src/dev/soak-stats.js" \
  "$REPO/src/dev/mock-server.js" \
  "$REPO/scripts/soak-proc.ps1" \
  "$REPO/scripts/soak-grab.ps1" \
  "$REPO/scripts/soak-setup.ps1" \
  "$REPO/scripts/soak-teardown.ps1" \
  "$USER@$HOST:$STAGE_POSIX/"

say "Copying the panel pages"
# Only the two soak pages, not the whole mock directory: the other pages are
# dev fixtures and have no business on a machine under measurement.
"${SCP[@]}" \
  "$REPO/src/dev/mock/soak-static.html" \
  "$REPO/src/dev/mock/soak-heavy.html" \
  "$USER@$HOST:$STAGE_POSIX/mock/"

say "Copying the config"
"${SCP[@]}" "$REPO/config/soak-72h.json" "$USER@$HOST:$STAGE_POSIX/soak-config.json"

say "Verifying the build survived the transfer"
LOCAL_SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
REMOTE_SHA="$("${SSH[@]}" "powershell -NoProfile -Command \"(Get-FileHash '$STAGE\\$(basename "$ZIP")' -Algorithm SHA256).Hash\"" </dev/null | tr -d '\r' | tr 'A-Z' 'a-z')"
echo "  local  $LOCAL_SHA"
echo "  remote $REMOTE_SHA"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "  MISMATCH: the zip did not survive the copy. Not proceeding." >&2
  exit 1
fi
echo "  match"

say "Pre-flight (changes nothing)"
"${SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -File $STAGE\\soak-setup.ps1 -PreflightOnly" </dev/null

cat <<EOF

Staged. Nothing is running yet.

Before starting, confirm HQ-PROTO-MINI-2 is free for three full days and that
whoever else uses it knows. That is not a formality: it is the only reason the
first run produced no verdict.

To start T0:

  ssh -o BatchMode=yes -o IdentitiesOnly=yes -i $KEY $USER@$HOST \\
      "powershell -NoProfile -ExecutionPolicy Bypass -File $STAGE\\soak-setup.ps1" </dev/null

EOF
