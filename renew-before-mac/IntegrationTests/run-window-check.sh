#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
check_dir=$(mktemp -d -t renew-window-check)
check_app="$check_dir/Window QA.app"
mkdir -p "$check_app/Contents/MacOS" "$check_app/Contents/Resources"
python3 - "$check_dir" <<'PY'
from pathlib import Path
import plistlib, sys, uuid
root=Path(sys.argv[1])
source=Path('App/MacApp.swift').read_text()
start=source.index('@main\nstruct RenewBeforeApplication')
end=source.index('@MainActor\nfinal class PanelOptions')
(root/'WindowCheck.swift').write_text(source[:start]+source[end:]+'\n'+Path('IntegrationTests/WindowReopenCheck.swift').read_text())
with (root/'Window QA.app/Contents/Info.plist').open('wb') as f:
 plistlib.dump({'CFBundleIdentifier':'org.renewbefore.qa.reopen.'+str(uuid.uuid4()),'CFBundleName':'Window QA','CFBundleExecutable':'WindowCheck','CFBundlePackageType':'APPL','LSUIElement':False},f)
PY
for language in Core/Resources/*.lproj; do ditto "$language" "$check_app/Contents/Resources/$(basename "$language")"; done
sources=()
for source in App/*.swift; do [[ "$source" == "App/MacApp.swift" ]] || sources+=("$source"); done
swiftc -parse-as-library Core/*.swift "${sources[@]}" "$check_dir/WindowCheck.swift" -o "$check_app/Contents/MacOS/WindowCheck"
codesign --force --sign - "$check_app" >/dev/null
"$check_app/Contents/MacOS/WindowCheck" "$check_dir"
