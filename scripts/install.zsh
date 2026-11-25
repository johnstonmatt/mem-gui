#!/usr/bin/env zsh
# Install a built MemGui.app to /Applications, replacing any existing copy.
# Usage: install.zsh <path to MemGui.app> [pid of the running app]
# The app is moved there, not copied.
#
# Run by `deno task install` after building from source, and by the in-app
# updater with a downloaded release; it ships inside the app as
# Contents/Resources/install.zsh. The updater passes its own pid and exits;
# without a pid, a running copy is asked to quit. It's relaunched afterwards
# if it was running.
set -euo pipefail

APP_NAME="Mem GUI"
BUNDLE_ID="dev.johnstonmatt.mem-gui"
SOURCE="${1:?Usage: install.zsh <path to MemGui.app> [pid]}"
APP_PID="${2:-}"
DEST="/Applications/MemGui.app"

# Every `deno desktop` app's executable is laufey_webview, so match on the
# bundle path rather than the process name.
is_running() {
  if [[ -n $APP_PID ]]; then
    kill -0 "$APP_PID" 2>/dev/null
  else
    pgrep -qf "^$DEST/Contents/MacOS/"
  fi
}
wait_for_quit() {
  for _ in {1..40}; do
    is_running || return 0
    sleep 0.25
  done
  ! is_running
}

# The updater discards this script's output, so keep a log it can be debugged from.
if [[ -n $APP_PID ]]; then
  LOG="${TMPDIR:-/tmp}/mem-gui-install.log"
  exec >>"$LOG" 2>&1
  print -r -- "--- $(date) installing $SOURCE"
fi

was_running=false
if is_running; then
  was_running=true
  if [[ -n $APP_PID ]]; then
    print "Waiting for $APP_NAME to quit…"
  else
    print "Quitting running $APP_NAME…"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  fi
  if ! wait_for_quit; then
    print -u2 "$APP_NAME did not quit. Nothing was installed. The new build is at $SOURCE."
    exit 1
  fi
fi

# Move the new app next to the destination first, so a failed move never
# leaves /Applications without the app.
STAGING="/Applications/.MemGui.app.installing"
rm -rf "$STAGING"
mv "$SOURCE" "$STAGING"
rm -rf "$DEST"
mv "$STAGING" "$DEST"
print "Installed $DEST"

if $was_running; then open "$DEST"; fi
