#!/bin/bash
# Package a previously built app into a read-only macOS disk image.
set -euo pipefail
cd "$(dirname "$0")/.."
require_gmail=false
if [[ "${1:-}" == "--require-gmail" ]]; then require_gmail=true; shift; fi
[[ $# -le 1 ]] || { echo 'Usage: ./Scripts/package.sh [--require-gmail] [output.dmg]' >&2; exit 2; }
app=$(./Scripts/build.sh --print-app-path)
[[ -d "$app" ]] || ./Scripts/build.sh
codesign --verify --deep --strict "$app"
if [[ "$require_gmail" == true ]]; then
  client="$app/Contents/Resources/GmailDesktopClient.json"
  [[ -s "$client" ]] && plutil -extract installed.client_id raw "$client" 2>/dev/null | /usr/bin/grep -Eq '^[[:alnum:].-]+\.apps\.googleusercontent\.com$' || {
    echo 'The built app needs a Google Desktop OAuth client. Configure the publisher client and rebuild before packaging.' >&2
    exit 1
  }
fi
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
output="${1:-$PWD/dist/Renew-Before-$version-macOS.dmg}"
[[ "$output" = /* ]] || output="$PWD/$output"
[[ ! -e "$output" ]] || { echo "Choose a new output path; a file already exists." >&2; exit 1; }
mkdir -p "$(dirname "$output")"
work=$(mktemp -d)
trap 'rm -r "$work"' EXIT
mkdir "$work/volume"
ditto "$app" "$work/volume/Renew Before.app"
ln -s /Applications "$work/volume/Applications"
hdiutil create -quiet -volname "Renew Before" -srcfolder "$work/volume" -format UDZO "$work/renew.dmg"
hdiutil verify -quiet "$work/renew.dmg"
mv -n "$work/renew.dmg" "$output"
[[ ! -e "$work/renew.dmg" ]] || { echo "Output path is occupied." >&2; exit 1; }
echo "Packaged $output"
