"""Phase 8A: 22 live QA cases, fail-closed overview, no personal data leaks.

Only synthetic counts-only fixtures are generated in a temporary directory.
The matrix and the final RC validator must agree on every PASS outcome.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from qa_live_provider import SCENARIO_CHECKS
from qa_matrix import matrix, inspect_report
from rc_readiness import REQUIRED_SCENARIOS, verify_local_qa

MARKER = "PRIVATE_CHAT_CONTENT_MUST_NOT_BE_DISPLAYED"

with TemporaryDirectory(prefix="chatfolio-phase8a-qa-") as temporary:
    folder = Path(temporary)
    empty = matrix(folder)
    assert empty["summary"]["total"] == 22
    assert empty["summary"]["not_run"] == 22
    assert not empty["summary"]["ready_for_manual_rc_review"]
    assert inspect_report(folder, "chatgpt", "short") == "not-run"

    def report_for(provider: str, scenario: str) -> dict:
        return {
            "schema_version": 1,
            "provider": provider,
            "scenario": scenario,
            "source_turn_count": None if scenario == "stop" else 14,
            "source_upload_count": 1 if scenario == "media" else None,
            "required_manual_checks": {
                name: "pass" for name in SCENARIO_CHECKS[scenario]
            },
            "pdf_metrics": (
                None if scenario == "stop" else
                {"pages": 2, "pages_with_selectable_text": 2,
                 "a4_portrait_pages": 2}
            ),
            "verdict": "pass",
            "blockers": [],
            "live_provider_confirmed": True,
        }

    cases = []
    for provider, scenarios in REQUIRED_SCENARIOS.items():
        for scenario in scenarios:
            path = folder / f"{provider}-{scenario}.json"
            data = report_for(provider, scenario)
            path.write_text(json.dumps(data), encoding="utf-8")
            cases.append((provider, scenario, path, data))

    assert matrix(folder)["summary"]["passed"] == 22
    assert matrix(folder)["summary"]["ready_for_manual_rc_review"]
    assert verify_local_qa(folder)["report_count"] == 22

    def break_report(provider, scenario, changes, expected):
        path = folder / f"{provider}-{scenario}.json"
        original = path.read_text(encoding="utf-8")
        data = json.loads(original)
        changes(data)
        path.write_text(json.dumps(data), encoding="utf-8")
        try:
            found = inspect_report(folder, provider, scenario)
            assert found == expected, (provider, scenario, found, expected)
            assert not matrix(folder)["summary"]["ready_for_manual_rc_review"]
            try:
                verify_local_qa(folder)
                raise AssertionError("Final RC gate approved a nonpassing report")
            except ValueError:
                pass
        finally:
            path.write_text(original, encoding="utf-8")

    break_report("chatgpt", "long", lambda d: d.update(verdict="pending"), "pending")
    break_report("gemini", "rich", lambda d: d.update(verdict="fail"), "fail")
    break_report("claude", "media", lambda d: d.update(source_upload_count=0), "invalid")
    break_report("chatgpt", "short", lambda d: d.update(source_turn_count=None), "invalid")
    break_report("gemini", "stop", lambda d: d.update(pdf_metrics={"pages": 1}), "invalid")
    break_report("claude", "rtl", lambda d: d["required_manual_checks"].update(rtl="not-checked"), "invalid")
    break_report("chatgpt", "project", lambda d: d.update(provider="other"), "invalid")

    unsafe = folder / "chatgpt-short.json"
    raw = unsafe.read_text(encoding="utf-8")
    unsafe.write_text("{invalid json" + MARKER, encoding="utf-8")
    assert inspect_report(folder, "chatgpt", "short") == "invalid"
    unsafe.write_text(raw, encoding="utf-8")

    no_follow = folder / "chatgpt-share.json"
    original = no_follow.read_text(encoding="utf-8")
    no_follow.unlink()
    private = folder / "PRIVATE_UNRELATED_FILE.json"
    private.write_text('{"secret": "' + MARKER + '"}', encoding="utf-8")
    no_follow.symlink_to(private)
    try:
        assert inspect_report(folder, "chatgpt", "share") == "invalid"
        assert matrix(folder)["summary"]["invalid"] == 1
    finally:
        no_follow.unlink()
        no_follow.write_text(original, encoding="utf-8")

    script = ROOT / "scripts" / "qa_matrix.py"
    result = subprocess.run(
        [sys.executable, str(script), "--qa-dir", str(folder),
         "--json", "--require-ready"],
        capture_output=True, text=True, timeout=20, cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["summary"]["passed"] == 22
    assert MARKER not in result.stdout and str(folder) not in result.stdout
    assert str(private) not in result.stderr
    assert not any("PRIVATE_UNRELATED_FILE" in item["scenario"]
                   for item in json.loads(result.stdout)["scenarios"])

    # Fail-closed CLI exit code with no private user data disclosure.
    no_follow.unlink()
    try:
        not_ready = subprocess.run(
            [sys.executable, str(script), "--qa-dir", str(folder),
             "--require-ready"],
            capture_output=True, text=True, timeout=20, cwd=ROOT,
        )
        assert not_ready.returncode == 3
        assert "21/22 passed" in not_ready.stdout
        assert MARKER not in not_ready.stdout + not_ready.stderr
    finally:
        no_follow.write_text(original, encoding="utf-8")

print("PASS: 22-case live QA matrix, strict RC gate parity, unsafe/missing/pending/failed reports")
