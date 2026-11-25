#!/usr/bin/env zsh
# Build dist/MemGui.app and finish the bundle `deno desktop` leaves incomplete.
#
# Signs ad-hoc by default, for local use. Set CODESIGN_IDENTITY to a
# "Developer ID Application: …" identity (as the release workflow does) to sign
# for distribution, which adds the Hardened Runtime, a secure timestamp and the
# entitlements in .github/entitlements.plist.
set -euo pipefail
cd "${0:A:h}/.."
IDENTITY="${CODESIGN_IDENTITY:--}"
APP="dist/MemGui.app"

if [[ $IDENTITY != "-" ]]; then
  # deno desktop reads the identity only from deno.jsonc. Restore the committed
  # file afterwards so a local signed build leaves no diff behind.
  cp deno.jsonc deno.jsonc.orig
  trap 'mv deno.jsonc.orig deno.jsonc' EXIT
  deno run --allow-read=deno.jsonc --allow-write=deno.jsonc \
    scripts/set_codesign_identity.ts "$IDENTITY"
fi

rm -rf "$APP" "$APP.app"
deno task build:mac
# deno 2.9.8 appends .app to --output even when it already ends in .app.
if [[ -d "$APP.app" ]]; then mv "$APP.app" "$APP"; fi
[[ -d $APP ]] || { print -u2 "deno desktop produced no $APP."; exit 1; }

# deno desktop hardcodes CFBundleShortVersionString to "1.0". The updater reads
# this to check what it downloaded, and Finder shows it in Get Info.
VERSION="$(sed -nE 's/^[[:space:]]*"version": "([^"]+)".*/\1/p' deno.jsonc)"
[[ -n $VERSION ]] || { print -u2 "No version in deno.jsonc."; exit 1; }
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"

# Ships with the app so the updater installs a release with that release's own
# install steps.
cp scripts/install.zsh "$APP/Contents/Resources/install.zsh"

# Re-sign the bundle so CodeResources covers the finished tree: the edits
# above, and the icon deno desktop copies in after it signs. No --deep: the
# nested Mach-Os (laufey_webview, libruntime.dylib) keep their own signatures.
if [[ $IDENTITY != "-" ]]; then
  # CFBundleExecutable is laufey_webview, the process that hosts V8, so this
  # puts allow-jit where the Hardened Runtime checks for it.
  codesign --force --options runtime --timestamp \
    --entitlements .github/entitlements.plist --sign "$IDENTITY" "$APP"
else
  # Ad-hoc: no Hardened Runtime, so no entitlements are needed, and
  # --timestamp needs a real identity.
  codesign --force --sign - "$APP"
fi
print "Built $APP ($VERSION)"
