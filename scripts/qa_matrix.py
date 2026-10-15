#!/usr/bin/env python3
"""Privacy-safe Phase 8A progress matrix for the 22 real-provider QA scenarios.

Only fixed expected filenames in a private, ignored local QA directory are
checked. No PDF opens, no provider access, no uploads, no private data printed.
An apparently "pass" report is PASS only if rc_readiness.verify_qa_report_file
accepts it under the exact final release gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from rc_readiness import REQUIRED_SCENARIOS, verify_qa_report_file

STATUSES = ("pass", "pending", "fail", "invalid", "not-run")


def inspect_report(directory: Path, provider: str, scenario: str) -> str:
    path = directory / (provider + "-" + scenario + ".json")
    # Never follow a symlink to a user's unrelated local file.
    if path.is_symlink():
        return "invalid"
    if not path.exists():
        return "not-run"
    try:
        verify_qa_report_file(path, provider, scenario)
        return "pass"
    except (OSError, ValueError):
        pass

    # Classify a nonpassing report only when it is a small, regular JSON file
    # that matches this exact expected provider/scenario/schema. Neither its
    # arbitrary contents nor its user-supplied text are ever returned.
    try:
        if not path.is_file() or path.stat().st_size > 64 * 1024:
            return "invalid"
        data = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(data, dict) or data.get("schema_version") != 1 or
                data.get("provider") != provider or data.get("scenario") != scenario):
            return "invalid"
        verdict = data.get("verdict")
        if verdict == "fail":
            return "fail"
        if verdict == "pending":
            return "pending"
        return "invalid"
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "invalid"


def matrix(directory: Path) -> dict:
    items = []
    counts = {name: 0 for name in STATUSES}
    for provider, scenarios in REQUIRED_SCENARIOS.items():
        for scenario in scenarios:
            status = inspect_report(directory, provider, scenario)
            items.append({"provider": provider, "scenario": scenario, "status": status})
            counts[status] += 1
    total = len(items)
    return {
        "schema_version": 1,
        "summary": {
            "total": total,
            "passed": counts["pass"],
            "pending": counts["pending"],
            "failed": counts["fail"],
            "invalid": counts["invalid"],
            "not_run": counts["not-run"],
            "ready_for_manual_rc_review": counts["pass"] == total,
        },
        "scenarios": items,
        "warning": (
            "PASS means a local counts-only report satisfies the RC schema; "
            "the operator must still personally verify original chat versus PDF. "
            "These files are not independent proof of real-provider QA."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--qa-dir", type=Path, default=Path(".chatfolio-qa"),
        help="Private local QA report directory (default: .chatfolio-qa)",
    )
    parser.add_argument("--json", action="store_true", help="Show counts-only JSON")
    parser.add_argument(
        "--require-ready", action="store_true",
        help="Return exit 3 until every mandatory provider/scenario is PASS",
    )
    args = parser.parse_args()
    result = matrix(args.qa_dir)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        for case in result["scenarios"]:
            print(f"{case['provider']:<9} {case['scenario']:<12} {case['status'].upper()}")
        s = result["summary"]
        print(
            f"Summary: {s['passed']}/{s['total']} passed; "
            f"{s['pending']} pending; {s['failed']} failed; "
            f"{s['invalid']} invalid; {s['not_run']} not run."
        )
        if not s["ready_for_manual_rc_review"]:
            print("RC blocked: complete the remaining real-provider QA comparisons locally.")
        else:
            print("All report gates pass; manual source-vs-PDF evidence is still required.")
    return 3 if args.require_ready and not result["summary"]["ready_for_manual_rc_review"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
