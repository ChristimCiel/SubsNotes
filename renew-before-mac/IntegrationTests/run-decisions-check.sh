#!/bin/bash
# Isolated native fixture. Never points production storage or Gmail at the owner's records.
set -euo pipefail
cd "$(dirname "$0")/.."
check_dir=$(mktemp -d -t renew-decisions-flow)
check_id="org.renewbefore.qa.decisions.$(uuidgen | tr '[:upper:]' '[:lower:]')"
check_app="$check_dir/Decisions Flow QA.app"
mkdir -p "$check_app/Contents/MacOS" "$check_dir/results"
mkdir -p "$check_app/Contents/Resources"
for language in Core/Resources/*.lproj; do
  ditto "$language" "$check_app/Contents/Resources/$(basename "$language")"
done
ditto Core/Resources/ServiceLogos "$check_app/Contents/Resources/ServiceLogos"
cp Core/Resources/service-logo-catalog.json "$check_app/Contents/Resources/"
python3 - "$check_dir" "$check_id" <<'PY'
from pathlib import Path
import plistlib, sys
root = Path(sys.argv[1])
source = Path('App/MacApp.swift').read_text()
start = source.index('@main\nstruct RenewBeforeApplication')
end = source.index('@MainActor\nfinal class PanelOptions')
(root / 'MacAppWithoutMain.swift').write_text(source[:start] + source[end:])
info = {'CFBundleIdentifier':sys.argv[2], 'CFBundleExecutable':'DecisionsFlowCheck',
        'CFBundleName':'Decisions Flow QA', 'CFBundlePackageType':'APPL',
        'CFBundleVersion':'1', 'LSUIElement':True, 'NSHighResolutionCapable':True}
with (root/'Decisions Flow QA.app/Contents/Info.plist').open('wb') as f:
    plistlib.dump(info, f)
PY
app_sources=()
for source in App/*.swift; do
  [[ "$source" == "App/MacApp.swift" ]] || app_sources+=("$source")
done
swiftc -parse-as-library -o "$check_app/Contents/MacOS/DecisionsFlowCheck" \
  Core/*.swift "${app_sources[@]}" "$check_dir/MacAppWithoutMain.swift" IntegrationTests/DecisionsFlowCheck.swift
codesign --force --sign - "$check_app" >/dev/null
"$check_app/Contents/MacOS/DecisionsFlowCheck" "$check_dir/results" "$@"
