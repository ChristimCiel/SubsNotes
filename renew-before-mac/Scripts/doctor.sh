#!/bin/bash
# Read-only diagnostics. Does not open receipts, request permission or change login items.
set -eu
cd "$(dirname "$0")/.."
app="${1:-$HOME/Applications/Renew Before.app}"
if [[ ! -d "$app" && $# -eq 0 ]]; then app="$(./Scripts/build.sh --print-app-path)"; fi
printf 'macOS %s (%s)\n' "$(sw_vers -productVersion)" "$(uname -m)"
if ! xcodebuild -version 2>/dev/null; then printf 'Full Xcode is needed to build from source.\n'; fi
[[ -d "$app" ]] || { printf 'App not found: %s\nBuild it with ./Scripts/build.sh\n' "$app"; exit 1; }
printf 'Bundle: %s\n' "$app"
codesign --verify --deep --strict "$app"
printf 'Bundle signature: intact (not a notarization check)\n'
widget="$app/Contents/PlugIns/RenewBeforeWidget.appex"
[[ -x "$widget/Contents/MacOS/RenewBeforeWidget" ]] || { echo 'Missing widget extension'; exit 1; }
printf 'Embedded widget: present\n'
if [[ -s "$app/Contents/Resources/GmailDesktopClient.json" ]]; then
  echo 'Gmail: publisher client included (live consent is a separate check)'
else
  echo 'Gmail: no bundled publisher client'
fi
g1=$(/usr/libexec/PlistBuddy -c 'Print :RenewBeforeAppGroup' "$app/Contents/Info.plist")
g2=$(/usr/libexec/PlistBuddy -c 'Print :RenewBeforeAppGroup' "$widget/Contents/Info.plist")
[[ "$g1" == "$g2" ]] || { echo 'App and widget use different storage groups'; exit 1; }
if [[ -n "$g1" ]]; then echo 'Storage mode: matching team app group'; else echo 'Storage mode: local development folder'; fi
echo 'To check actual scheduling: Settings → Enable notifications → Test notification.'
echo 'To check widget data: add the widget, save a confirmed plan, then compare its name and last-verified date.'
