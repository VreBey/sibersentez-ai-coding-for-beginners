#!/bin/bash
# The packaged Linux app (plan G2), hidden, with a temporary hub, data folder and project: the same QA mode the
# Windows checks use (tools/electron-qa.ps1, docs/release.md). Builds nothing; run after
#   npx electron-builder --linux AppImage
# Usage: bash tools/linux-qa.sh [path to the AppImage]   (needs a display: xvfb-run on a server or in CI)
# Writes qa/linux-qa-main.log and qa/linux-qa-shot.png; exits 1 when a check fails.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${1:-$(ls "$ROOT"/dist/SiberSentez-*.AppImage 2>/dev/null | head -1)}
[ -x "$APP" ] || { echo "[qa] no AppImage (build it first: npx electron-builder --linux AppImage)"; exit 1; }
Q=$(mktemp -d /tmp/sibersentez-qa-XXXXXX)
mkdir -p "$Q/hub" "$Q/data" "$Q/proj" "$Q/home" "$ROOT/qa"
echo '<!doctype html><title>qa</title>' > "$Q/proj/index.html"
# A home of its own: no AI tool's real records are read, nothing is written into the person's home
export HOME="$Q/home"
export SIBERSENTEZ_HUB="$Q/hub" SIBERSENTEZ_DATA_DIR="$Q/data" SIBERSENTEZ_QA_SHOT="$Q/shot.png" SIBERSENTEZ_QA_DELAY_MS=6000
export SIBERSENTEZ_QA_QUIT_MS=60000 SIBERSENTEZ_QA_PROBES=1 SIBERSENTEZ_QA_PROJECT_DIR="$Q/proj" SIBERSENTEZ_QA_HIDDEN=1
# Chromium's sandbox needs a setuid helper or user namespaces an AppImage run as a test may not have: off for this
# run only (the person's own start keeps it)
cd "$Q"
# The AppImage unpacks itself into TMPDIR: into this run's own folder, removed with it
export TMPDIR="$Q"
timeout 90 "$APP" --appimage-extract-and-run --qa --no-sandbox > "$Q/stdout.txt" 2>&1
CODE=$?
LOG=$(find "$Q/data" -name main.log | head -1)
cp "$LOG" "$ROOT/qa/linux-qa-main.log" 2>/dev/null
cp "$Q/shot.png" "$ROOT/qa/linux-qa-shot.png" 2>/dev/null
FAIL=0
check() {
  if grep -q -- "$2" "$LOG" 2>/dev/null; then echo "[PASS] $1"; else echo "[FAIL] $1"; FAIL=1; fi
}
[ "$CODE" = 0 ] && echo "[PASS] exit code 0" || { echo "[FAIL] exit code $CODE"; FAIL=1; }
check 'the server is ready' 'server ready: http://127.0.0.1:'
check 'the window loaded the page' 'window loaded: http://127.0.0.1:'
check 'hidden: the window stays hidden, no tray icon' 'QA probe hidden: {"hidden":true,"visible":false,"tray":false}'
check 'the bridge has its ten functions' 'QA probe bridge: createIdeaProject:function,openLogs:function,pickLibraryFolder:function,pickProjectFolder:function,reportError:function,saveProjectIdea:function,setActionsMode:function,setAttention:function,setLanguage:function,setTheme:function$'
check 'the kit is in the package' 'QA probe kit folder: {"packaged":true,"resourcesKit":true}'
check 'a project folder is added' 'QA probe project-add: {"ok":true'
check 'the embedded terminal runs a command (node-pty built for Linux)' 'QA probe terminal: {"unpacked":true,"loaded":true,"exitCode":0,"echoed":true}'
check 'a screenshot was taken' 'QA: screenshot saved'
check 'the server stopped with the app' 'server exited (code 0'
rm -rf "$Q" 2>/dev/null
[ "$FAIL" = 0 ] && echo "[qa] all checks passed" || echo "[qa] a check failed: qa/linux-qa-main.log"
exit "$FAIL"
