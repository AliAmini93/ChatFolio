#!/usr/bin/env python3
"""Validate an RC *preview* request. Never create Git tags or publish releases.

Locally, --qa-dir checks counts-only reports produced by qa_live_provider.py.
In GitHub Actions, --qa-attested can record human signoff without uploading
those reports. Attestation is a human assertion, NOT remote proof of live QA.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from qa_live_provider import SCENARIO_CHECKS
from release_gate import ROOT, validate_versions

RC_RE = re.compile(r"^v([0-9]+\.[0-9]+\.[0-9]+)-rc\.([1-9][0-9]*)$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

REQUIRED_SCENARIOS = {
    "chatgpt": ("short", "long", "rtl", "rich", "media", "stop",
                "project", "temporary", "share"),
    "claude": ("short", "long", "rtl", "rich", "media", "stop"),
    "gemini": ("short", "long", "rtl", "rich", "media", "stop",
               "virtualized"),
}


def verify_candidate_identity(tag: str, expected_sha: str, *, root: Path = ROOT) -> dict:
    match = RC_RE.fullmatch(tag)
    if not match:
        raise ValueError("RC tag must match vMAJOR.MINOR.PATCH-rc.N (N >= 1).")
    version = validate_versions(root)
    if match.group(1) != version:
        raise ValueError("RC tag version does not match manifest/package version.")
    if not SHA_RE.fullmatch(expected_sha):
        raise ValueError("Expected commit must be exactly 40 lowercase hexadecimal characters.")
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True,
        text=True, check=True,
    )
    actual_sha = completed.stdout.strip()
    if actual_sha != expected_sha:
        raise ValueError("Checked-out HEAD is not the approved commit SHA.")
    return {"tag": tag, "version": version, "source_sha": actual_sha}


def verify_local_qa(qa_dir: Path) -> dict:
    # Only known fixed filenames are read. No conversation PDFs, browser state,
    # user-supplied paths or arbitrary JSON files are inspected or uploaded.
    count = 0
    for provider, scenarios in REQUIRED_SCENARIOS.items():
        for scenario in scenarios:
            expected = qa_dir / (provider + "-" + scenario + ".json")
            if expected.is_symlink() or not expected.is_file():
                raise ValueError("Missing or unsupported local QA report for " +
                                 provider + "/" + scenario + ".")
            if expected.stat().st_size > 64 * 1024:
                raise ValueError("QA report exceeds the small metadata-only limit.")
            try:
                report = json.loads(expected.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                raise ValueError("Could not read a counts-only QA report.") from None
            if not isinstance(report, dict) or report.get("schema_version") != 1:
                raise ValueError("QA report schema is not supported.")
            if (report.get("provider") != provider or
                    report.get("scenario") != scenario or
                    report.get("verdict") != "pass" or
                    report.get("live_provider_confirmed") is not True):
                raise ValueError("QA report not explicitly passed: " + provider + "/" + scenario + ".")
            checks = report.get("required_manual_checks")
            if not isinstance(checks, dict) or set(checks) != set(SCENARIO_CHECKS[scenario]):
                raise ValueError("QA report is missing required manual checks.")
            if any(value != "pass" for value in checks.values()):
                raise ValueError("QA report includes unchecked or failed source comparison.")
            if report.get("blockers"):
                raise ValueError("QA report contains release blockers.")
            if scenario != "stop":
                turns = report.get("source_turn_count")
                metrics = report.get("pdf_metrics")
                if type(turns) is not int or turns < 1:
                    raise ValueError("QA report has no verified source turn count.")
                if not isinstance(metrics, dict):
                    raise ValueError("QA report lacks PDF metadata.")
                pages = metrics.get("pages")
                text_pages = metrics.get("pages_with_selectable_text")
                if (type(pages) is not int or pages < 1 or
                        type(text_pages) is not int or text_pages < 1):
                    raise ValueError("QA report has no searchable PDF pages.")
                if scenario == "media":
                    uploads = report.get("source_upload_count")
                    if type(uploads) is not int or uploads < 1:
                        raise ValueError("Media QA requires at least one verified source upload.")
            elif report.get("pdf_metrics") is not None:
                raise ValueError("Stop QA must not include a PDF.")
            count += 1
    return {
        "report_count": count,
        "providers": sorted(REQUIRED_SCENARIOS),
        "manual_live_qa": "locally checked (not independently authenticated)",
    }


def prepare_rc(
    candidate_tag: str, expected_sha: str, *,
    qa_dir: Path | None = None, qa_attested: bool = False,
    root: Path = ROOT
) -> dict:
    identity = verify_candidate_identity(candidate_tag, expected_sha, root=root)
    if qa_dir is not None:
        qa = verify_local_qa(qa_dir)
    elif qa_attested:
        qa = {
            "report_count": None,
            "providers": sorted(REQUIRED_SCENARIOS),
            "manual_live_qa": "human-attested in manual workflow, not validated in CI",
        }
    else:
        raise ValueError("Real-provider QA is unconfirmed; use --qa-dir locally or explicit human attestation.")
    return {
        **identity, "qa": qa, "action": "build an RC preview artifact only",
        "creates_tag": False, "publishes_release": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-tag", required=True)
    parser.add_argument("--expected-sha", required=True)
    choices = parser.add_mutually_exclusive_group(required=True)
    choices.add_argument("--qa-dir", type=Path, help="Private local directory with counts-only QA reports")
    choices.add_argument(
        "--qa-attested", choices=("true",), metavar="true",
        help="Human confirmation for non-publishing GitHub Actions preview only",
    )
    args = parser.parse_args()
    try:
        summary = prepare_rc(
            args.candidate_tag, args.expected_sha,
            qa_dir=args.qa_dir, qa_attested=args.qa_attested == "true",
        )
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        # Error strings from this module never echo private text/file paths.
        parser.exit(2, "RC PREVIEW BLOCKED: " + type(exc).__name__ +
                    (": " + str(exc) if isinstance(exc, ValueError) else "") + "\n")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
