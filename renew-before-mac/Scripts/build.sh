#!/bin/bash
# Build locally, without contacting the Apple Developer portal. No third-party tools required.
set -euo pipefail
cd "$(dirname "$0")/.."
repo_key=$(pwd -P | shasum -a 256 | cut -c1-16)
out="${RENEW_BUILD_DIR:-$HOME/Library/Caches/org.renewbefore.mac/$repo_key/build}"
[[ "$out" = /* ]] || out="$PWD/$out"
if [[ "${1:-}" == "--print-app-path" ]]; then
  printf '%s\n' "$out/Release/Renew Before.app"
  exit 0
elif [[ $# -ne 0 ]]; then
  echo 'Usage: ./Scripts/build.sh [--print-app-path]' >&2; exit 2
fi
mode="${RENEW_SIGNING:-auto}"
settings=()
if [[ "$mode" != "adhoc" && "$mode" != "auto" ]]; then
  echo 'RENEW_SIGNING accepts auto or adhoc.' >&2; exit 2
fi
if [[ "$mode" == "auto" ]]; then
  identity=$(security find-identity -v -p codesigning | awk '/"Apple Development:/ && !found {print $2; found=1}')
  if [[ -n "$identity" ]]; then
    # Match the fingerprint before reading the OU. The value in the CN can differ from the team ID.
    certdir=$(mktemp -d)
    trap 'rm -r "$certdir"' EXIT
    security find-certificate -a -c 'Apple Development' -p | awk -v root="$certdir" '
      /BEGIN CERTIFICATE/ { ++n; output = root "/" n ".pem" }
      output { print > output }
      /END CERTIFICATE/ { close(output); output="" }'
    team=""
    for cert in "$certdir"/*.pem; do
      fingerprint=$(/usr/bin/openssl x509 -in "$cert" -fingerprint -sha1 -noout | sed 's/.*=//;s/://g')
      if [[ "$identity" == "$fingerprint" ]]; then
        team=$(/usr/bin/openssl x509 -in "$cert" -noout -subject -nameopt multiline | awk -F' = ' '/organizationalUnitName/ {print $NF; exit}')
        break
      fi
    done
    if [[ ! "$team" =~ ^[A-Z0-9]{10}$ ]]; then
      echo 'Could not determine the local signing team. Set RENEW_SIGNING=adhoc for a local-only build.' >&2; exit 1
    fi
    settings+=("CODE_SIGN_IDENTITY=$identity" "RENEW_STORAGE_MODE=Signed" "RENEW_APP_GROUP=$team.org.renewbefore.mac")
    echo 'Using the installed Apple Development certificate and a team-scoped macOS app group.'
  fi
fi
if [[ ${#settings[@]} -eq 0 ]]; then
  settings+=("CODE_SIGN_IDENTITY=-" "RENEW_STORAGE_MODE=Local" "RENEW_APP_GROUP=")
  echo 'Using local ad-hoc signing and the dedicated per-user development folder.'
fi
xcodebuild -quiet -project RenewBefore.xcodeproj -scheme RenewBefore -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath "$out/DerivedData" \
  "CONFIGURATION_BUILD_DIR=$out/Release" "${settings[@]}" build
app="$out/Release/Renew Before.app"
codesign --verify --deep --strict "$app"
test -x "$app/Contents/PlugIns/RenewBeforeWidget.appex/Contents/MacOS/RenewBeforeWidget"
printf 'Built %s\n' "$app"
