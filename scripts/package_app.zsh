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

rm -rf "$APP"
deno task build:mac
# build:mac's --output relies on deno appending ".app"; if that changes, the
# bundle lands elsewhere and every step after this one would miss it.
[[ -d $APP ]] || { print -u2 "deno desktop produced no $APP. Found: $(ls dist)"; exit 1; }

# Ships with the app so the updater installs a release with that release's own
# install steps.
cp scripts/install.zsh "$APP/Contents/Resources/install.zsh"

# Re-sign the bundle so CodeResources covers install.zsh. No --deep: the
# nested Mach-Os (laufey_webview, libruntime.dylib) keep deno's signatures.
if [[ $IDENTITY != "-" ]]; then
  # deno signs with the Hardened Runtime but attaches no entitlements to a
  # webview app (denoland/deno#36421), and without allow-jit V8 can't reserve
  # its CodeRange and aborts at launch. CFBundleExecutable is laufey_webview,
  # the process that hosts V8, so signing the bundle puts it there.
  codesign --force --options runtime --timestamp \
    --entitlements .github/entitlements.plist --sign "$IDENTITY" "$APP"
else
  # Ad-hoc: no Hardened Runtime, so no entitlements are needed, and
  # --timestamp needs a real identity.
  codesign --force --sign - "$APP"
fi
print "Built $APP ($(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist"))"
