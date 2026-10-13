#!/usr/bin/env python3
"""Build and validate the unpacked Chrome extension from an explicit allowlist.

No downloads, private fixtures, or development files enter the distributable ZIP.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "print.html",
    "print.js",
    "icons/icon128.png",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
)
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build(destination: Path) -> dict[str, str]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected a Chrome Manifest V3 extension")
    if not isinstance(manifest.get("version"), str):
        raise ValueError("manifest.json is missing a version")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.resolve()
    hashes: dict[str, str] = {}
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in RUNTIME_FILES:
            path = ROOT / name
            if not path.is_file() or path.is_symlink():
                raise FileNotFoundError(f"Missing or symlinked required runtime asset: {name}")
            data = path.read_bytes()
            hashes[name] = sha256(data)
            entry = zipfile.ZipInfo(name, FIXED_DATE)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100644 << 16)
            archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(destination) as archive:
        if archive.namelist() != list(RUNTIME_FILES):
            raise AssertionError("Unexpected extension ZIP entries")
        for name in RUNTIME_FILES:
            if sha256(archive.read(name)) != hashes[name]:
                raise AssertionError(f"ZIP verification failed: {name}")
    return hashes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Output ZIP path (default: dist/chatfolio-VERSION-chrome.zip)")
    parser.add_argument("--hashes", action="store_true", help="Print SHA-256 for every bundled runtime file")
    args = parser.parse_args()
    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    target = args.out or ROOT / "dist" / f"chatfolio-{version}-chrome.zip"
    hashes = build(target)
    print(f"Built {target} ({target.stat().st_size:,} bytes, {len(hashes)} verified files)")
    if args.hashes:
        print(json.dumps(hashes, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
