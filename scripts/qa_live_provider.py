#!/usr/bin/env python3
"""Audit one locally exported live-provider PDF without exposing its contents.

Unlike synthetic fixtures, this tool cannot access provider sessions. The
operator must compare the source conversation with the PDF and explicitly
record manual verdicts. Only anonymous counts and fixed check names are
printed/saved; private text, local paths, URLs and screenshots are never stored.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from qa_pdf_audit import audit_pdf

SCENARIO_CHECKS = {
    "short": ("turns", "layout"),
    "long": ("turns", "layout", "history"),
    "rtl": ("turns", "layout", "rtl"),
    "rich": ("turns", "layout", "math", "tables"),
    "media": ("turns", "layout", "uploads"),
    "project": ("turns", "layout", "history"),
    "share": ("turns", "layout"),
    "virtualized": ("turns", "layout", "history"),
    "temporary": ("turns", "layout", "temporary"),
    "retry": ("turns", "layout", "recovery"),
    "stop": ("stop",),
}
ALL_CHECKS = set().union(*map(set, SCENARIO_CHECKS.values()))
CHECK_VALUES = {"pass", "fail", "not-checked"}
PROVIDERS = ("chatgpt", "claude", "gemini")


def parse_checks(values: list[str]) -> dict[str, str]:
    checks: dict[str, str] = {}
    for item in values:
        name, separator, value = item.partition("=")
        if separator != "=" or name not in ALL_CHECKS or value not in CHECK_VALUES:
            raise ValueError(
                "Invalid --check; expected NAME=pass|fail|not-checked. "
                "Names: " + ", ".join(sorted(ALL_CHECKS))
            )
        if name in checks:
            raise ValueError("A manual check may only be supplied once.")
        checks[name] = value
    return checks


def create_report(
    *, provider: str, scenario: str, pdf: Path | None,
    source_turns: int | None, source_uploads: int | None,
    manual_checks: dict[str, str]
) -> dict:
    if provider not in PROVIDERS or scenario not in SCENARIO_CHECKS:
        raise ValueError("Invalid provider or scenario.")
    if source_turns is not None and source_turns < 1:
        raise ValueError("Source turns must be positive.")
    if source_uploads is not None and source_uploads < 0:
        raise ValueError("Source upload count must be nonnegative.")
    if scenario == "stop" and pdf is not None:
        raise ValueError("Stop scenario must not provide a PDF; verify absence manually.")
    if scenario != "stop" and pdf is None:
        raise ValueError("This scenario requires an exported local --pdf.")
    required = SCENARIO_CHECKS[scenario]
    if any(name not in required for name in manual_checks):
        raise ValueError("The supplied manual check is not required by this scenario.")

    metrics = audit_pdf(pdf) if pdf is not None else None
    checks = {key: manual_checks.get(key, "not-checked") for key in required}
    blockers = []
    review = []
    if metrics is not None:
        if metrics["pages"] == 0 or metrics["pages_with_selectable_text"] == 0:
            blockers.append("The PDF has no searchable text pages.")
        if metrics["a4_portrait_pages"] != metrics["pages"]:
            review.append("Not every page is A4 portrait.")
        if metrics["near_empty_pages"]:
            review.append("Inspect near-empty pages locally; image-only pages can be valid.")
        if scenario == "media" and (source_uploads or 0) > 0 and metrics["embedded_image_instances"] == 0:
            review.append("No raster PDF images detected; verify uploads visually.")
        if source_turns is None:
            review.append("A source turn count is needed to complete acceptance.")
    if any(value == "fail" for value in checks.values()) or blockers:
        verdict = "fail"
    elif any(value != "pass" for value in checks.values()) or (scenario != "stop" and source_turns is None):
        verdict = "pending"
    else:
        verdict = "pass"

    return {
        "schema_version": 1,
        "provider": provider,
        "scenario": scenario,
        "source_turn_count": source_turns,
        "source_upload_count": source_uploads,
        "required_manual_checks": checks,
        "pdf_metrics": metrics,
        "verdict": verdict,
        "blockers": blockers,
        "review_warnings": review,
        "live_provider_confirmed": verdict == "pass",
        "note": "Manual checks compare the real source to its local PDF; PDF metrics alone cannot prove completeness.",
    }


def save_report(path: Path, report: dict) -> None:
    # Save only sanitized, enum/count-only findings. Reject symlink destinations.
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", required=True, choices=PROVIDERS)
    parser.add_argument("--scenario", required=True, choices=tuple(SCENARIO_CHECKS))
    parser.add_argument("--pdf", type=Path, help="Private local PDF; omit for stop scenario")
    parser.add_argument("--source-turns", type=int, help="Count user+assistant turns from the original service")
    parser.add_argument("--source-uploads", type=int, help="Number of uploaded images verified in source")
    parser.add_argument(
        "--check", action="append", default=[], metavar="NAME=pass|fail|not-checked",
        help="Operator's source-vs-PDF comparison; repeat for relevant checks"
    )
    parser.add_argument("--output", type=Path, help="Optional private local path to write counts-only JSON")
    args = parser.parse_args()
    try:
        report = create_report(
            provider=args.provider, scenario=args.scenario, pdf=args.pdf,
            source_turns=args.source_turns, source_uploads=args.source_uploads,
            manual_checks=parse_checks(args.check),
        )
        if args.output:
            save_report(args.output, report)
    except (ValueError, RuntimeError, OSError) as error:
        # Never echo a private PDF path or its contents into copied logs.
        parser.exit(2, "QA input or local PDF could not be evaluated: " + type(error).__name__ + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return {"pass": 0, "fail": 1, "pending": 3}[report["verdict"]]


if __name__ == "__main__":
    raise SystemExit(main())
