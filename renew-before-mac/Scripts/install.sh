#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
src=$(./Scripts/build.sh --print-app-path)
target="$HOME/Applications/Renew Before.app"
[[ -d "$src" ]] || ./Scripts/build.sh
codesign --verify --deep --strict "$src"
if [[ -e "$target" || -L "$target" ]]; then
  echo "An app already exists at $target. Quit it and move it aside to install this build." >&2
  exit 1
fi
mkdir -p "$HOME/Applications"
stage=$(mktemp -d "$HOME/Applications/.renewbefore-install.XXXXXX")
trap 'rm -r "$stage"' EXIT
staged="$stage/Renew Before.app"
/usr/bin/ditto "$src" "$staged"
codesign --verify --deep --strict "$staged"
mv -n "$staged" "$HOME/Applications/"
[[ ! -e "$staged" ]] || { echo "Another app already occupies $target." >&2; exit 1; }
codesign --verify --deep --strict "$target"
open "$target"
printf 'Installed %s\n' "$target"
