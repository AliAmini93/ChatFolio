#!/usr/bin/env python3
"""Release artifact gate: reproducibility, version alignment and strict ZIP contents.

Run after 'npm run build'. This does not publish a tag/release and does NOT
claim real-provider QA has been completed. Uses only stdlib + existing build.py.
Never reads user conversations or any path outside the 12-file runtime list.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import zipfile

from build import ROOT, RUNTIME_FILES, FIXED_DATE, build


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_versions(root: Path = ROOT) -> str:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid manifest version.")
    if package.get("version") != version:
        raise ValueError("Manifest and package.json versions differ.")
    if manifest.get("manifest_version") != 3:
        raise ValueError("Expected a Manifest V3 extension.")
    if manifest.get("background", {}).get("service_worker") != "background.js":
        raise ValueError("Unexpected background worker.")
    return version


def inspect_archive(path: Path, hashes: dict[str, str]) -> tuple[int, str]:
    if set(hashes) != set(RUNTIME_FILES):
        raise ValueError("Builder file list differs from the release allowlist.")
    archive_bytes = path.read_bytes()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if [entry.filename for entry in entries] != list(RUNTIME_FILES):
            raise ValueError("Archive contains missing, duplicate, reordered or extra files.")
        for item in entries:
            if item.is_dir() or item.date_time != FIXED_DATE:
                raise ValueError("Unexpected ZIP member type or non-reproducible timestamp.")
            if (item.external_attr >> 16) != 0o100644:
                raise ValueError("Unexpected ZIP member permissions.")
            if sha256(archive.read(item)) != hashes[item.filename]:
                raise ValueError("Archive does not match validated runtime source.")
    return len(archive_bytes), sha256(archive_bytes)


def verify_release_artifact(archive: Path, *, expected_version: str | None = None) -> dict:
    version = validate_versions()
    if expected_version is not None and version != expected_version:
        raise ValueError("Requested release version differs from manifest.")
    # Keep independently compiled copies outside dist/ so build output and
    # previous user files are never overwritten during reproducibility tests.
    with TemporaryDirectory(prefix="chatfolio-release-gate-") as directory:
        first = Path(directory) / "repro-a.zip"
        second = Path(directory) / "repro-b.zip"
        hashes1 = build(first)
        hashes2 = build(second)
        if hashes1 != hashes2:
            raise ValueError("Runtime source hashes changed between builds.")
        first_size, first_hash = inspect_archive(first, hashes1)
        second_size, second_hash = inspect_archive(second, hashes2)
        actual_size, actual_hash = inspect_archive(archive, hashes1)
        if first_hash != second_hash or first_hash != actual_hash:
            raise ValueError("ZIP is not byte-for-byte reproducible from current source.")
        if first_size != second_size or first_size != actual_size:
            raise ValueError("ZIP sizes differ across builds.")
    return {
        "version": version,
        "runtime_files_verified": len(RUNTIME_FILES),
        "zip_size_bytes": actual_size,
        "zip_sha256": actual_hash,
        "byte_reproducible": True,
        "note": "Artifact integrity only. Real-provider manual QA and release approval are separate.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Built ZIP (defaults to dist/chatfolio-VERSION-chrome.zip)")
    parser.add_argument("--expected-version", help="Require an exact semantic version")
    args = parser.parse_args()
    try:
        version = validate_versions()
        archive = args.archive or ROOT / "dist" / f"chatfolio-{version}-chrome.zip"
        result = verify_release_artifact(archive, expected_version=args.expected_version)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        # Error messages are static, not content from any local private file.
        parser.exit(2, f"RELEASE GATE FAIL: {type(error).__name__}: {error}\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
