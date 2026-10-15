"""Phase 7A: release gate verifies exact 12-file deterministic Chrome ZIP.

All inputs are existing public runtime assets or newly created tiny synthetic
fixtures. No provider session or chat fixture is read.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build import RUNTIME_FILES, build
from release_gate import inspect_archive, validate_versions, verify_release_artifact

version = validate_versions()
assert version == "1.8.11", "This milestone deliberately retains stable 1.8.11"
assert len(RUNTIME_FILES) == 12
assert "Previous Chats" not in " ".join(RUNTIME_FILES)

with TemporaryDirectory(prefix="chatfolio-7a-") as directory:
    root = Path(directory)
    artifact = root / "candidate.zip"
    hashes = build(artifact)
    assert len(hashes) == 12
    size, digest = inspect_archive(artifact, hashes)
    assert size > 20000 and len(digest) == 64
    report = verify_release_artifact(artifact, expected_version=version)
    assert report["version"] == version
    assert report["byte_reproducible"]
    assert report["runtime_files_verified"] == 12
    assert report["zip_sha256"] == digest

    try:
        verify_release_artifact(artifact, expected_version="9.9.9")
        raise AssertionError("Wrong declared version was accepted.")
    except ValueError:
        pass

    # Test version skew independently; never edit real package.json.
    metadata = root / "mock-repo"
    metadata.mkdir()
    (metadata / "manifest.json").write_text(json.dumps({
        "manifest_version":3,"version":"1.8.11",
        "background":{"service_worker":"background.js"}
    }),encoding="utf-8")
    (metadata / "package.json").write_text(json.dumps({"version":"1.8.12"}),encoding="utf-8")
    try:
        validate_versions(metadata)
        raise AssertionError("Manifest/package version mismatch was accepted.")
    except ValueError:
        pass

    # A ZIP with any extra entry must fail; use a synthetic filename with
    # no local private files or exported chats involved.
    with zipfile.ZipFile(artifact, "a") as candidate:
        candidate.writestr("unexpected-local-file.txt", "synthetic marker")
    try:
        inspect_archive(artifact, hashes)
        raise AssertionError("Extra entry was accepted.")
    except ValueError:
        pass

    # Tampering with a single runtime file must also fail.
    tampered = root / "tampered.zip"
    with zipfile.ZipFile(tampered, "w") as dest:
        with zipfile.ZipFile(root / "candidate.zip") as source:
            for item in source.infolist():
                if item.filename == "unexpected-local-file.txt":
                    continue
                content = source.read(item.filename)
                if item.filename == "manifest.json":
                    content = content + b" "
                dest.writestr(item, content)
    try:
        inspect_archive(tampered, hashes)
        raise AssertionError("Modified runtime byte was accepted.")
    except ValueError:
        pass

print("PASS: reproducible 12-file ZIP, exact versions, no extra files or tampering")
