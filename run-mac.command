#!/bin/zsh
set -eu
AMERICANO_PROJECT_DIR="${0:A:h}"
cd "$AMERICANO_PROJECT_DIR"
export AMERICANO_USER_DATA="$AMERICANO_PROJECT_DIR/.runtime"
export TMPDIR="/Users/hyunminseo/Projects/.tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
mkdir -p "$AMERICANO_USER_DATA" "$TMPDIR"
exec "$AMERICANO_PROJECT_DIR/dist/mac-arm64/Americano.app/Contents/MacOS/Americano"
