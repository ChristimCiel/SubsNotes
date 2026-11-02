#!/usr/bin/env python3
"""Offline integrity check. No downloads, credentials, or third-party Python dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
from urllib.parse import parse_qs, urlsplit


def check(resources):
    catalog = json.loads((resources / "service-logo-catalog.json").read_text())
    checked = set()
    for service in catalog["services"]:
        source = service.get("source") or ""
        assert not {"sig", "signature", "token", "key", "access_token"}.intersection(parse_qs(urlsplit(source).query)), service["name"]
        asset = service.get("asset")
        if not asset or asset in checked:
            continue
        assert re.fullmatch(r"service-logo-[0-9a-f]{64}", asset), asset
        path = resources / "ServiceLogos" / (asset + ".png")
        if not path.exists():
            path = resources / (asset + ".png")  # SwiftPM and native builds may flatten resources.
        data = path.read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", asset
        width, height = struct.unpack(">II", data[16:24])
        assert 0 < width <= 128 and 0 < height <= 128, asset
        assert hashlib.sha256(data).hexdigest() == asset.removeprefix("service-logo-"), asset
        checked.add(asset)
    assert len(checked) == catalog["snapshot"]["uniquePNGFiles"]
    print(f"PASS {resources}: {len(checked):,} offline PNGs, checksums and catalog sources")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--app", type=Path, help="Also verify the built host app and its widget extension")
args = parser.parse_args()
check(Path(__file__).resolve().parent.parent / "Core/Resources")
if args.app:
    check(args.app / "Contents/Resources")
    check(args.app / "Contents/PlugIns/RenewBeforeWidget.appex/Contents/Resources")
