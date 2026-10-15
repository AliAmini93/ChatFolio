"""Phase 7B: an RC preview must be SHA-pinned and live-QA gated.

All QA reports here are SYNTHETIC and are destroyed after the test. This
fixture cannot attest that real provider sessions were actually validated.
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
from rc_readiness import (
    REQUIRED_SCENARIOS, prepare_rc, verify_candidate_identity, verify_local_qa,
)
from release_gate import validate_versions

version = validate_versions()
sha = subprocess.run(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True,
    capture_output=True, check=True,
).stdout.strip()
tag = "v" + version + "-rc.1"

identity = verify_candidate_identity(tag, sha)
assert identity["source_sha"] == sha
assert identity["version"] == version
assert identity["tag"] == tag

for incorrect in ("v1.9.0", "1.9.0-rc.1", "v1.9.0-rc.0",
                  "v1.9.0-rc.foo", "v1.9.0-rc.1;echo bad"):
    try:
        verify_candidate_identity(incorrect, sha)
        raise AssertionError("Unsafe/unsupported candidate tag was accepted")
    except ValueError:
        pass

try:
    verify_candidate_identity(tag, "0" * 40)
    raise AssertionError("Unapproved commit SHA was accepted")
except ValueError:
    pass
try:
    verify_candidate_identity(tag, sha[:-1] + "Z")
    raise AssertionError("Malformed SHA was accepted")
except ValueError:
    pass

if version != "1.9.0":
    try:
        verify_candidate_identity("v1.9.0-rc.1", sha)
        raise AssertionError("Candidate version mismatch was accepted")
    except ValueError:
        pass

try:
    prepare_rc(tag, sha)
    raise AssertionError("RC preview could proceed with no manual QA approval")
except ValueError:
    pass

attested = prepare_rc(tag, sha, qa_attested=True)
assert attested["creates_tag"] is False and attested["publishes_release"] is False
assert "not validated in CI" in attested["qa"]["manual_live_qa"]

with TemporaryDirectory(prefix="chatfolio-rc-qa-synthetic-") as dirname:
    qa = Path(dirname)
    fixtures = {}
    for provider, scenarios in REQUIRED_SCENARIOS.items():
        for scenario in scenarios:
            report = {
                "schema_version": 1,
                "provider": provider,
                "scenario": scenario,
                "source_turn_count": 12 if scenario != "stop" else None,
                "source_upload_count": 2 if scenario == "media" else None,
                "required_manual_checks": {
                    name: "pass" for name in SCENARIO_CHECKS[scenario]
                },
                "pdf_metrics": (
                    {"pages": 3, "pages_with_selectable_text": 3,
                     "a4_portrait_pages": 3}
                    if scenario != "stop" else None
                ),
                "verdict": "pass",
                "blockers": [],
                "live_provider_confirmed": True,
            }
            path = qa / (provider + "-" + scenario + ".json")
            path.write_text(json.dumps(report), encoding="utf-8")
            fixtures[(provider, scenario)] = (path, report)

    clean = verify_local_qa(qa)
    assert clean["report_count"] == 22, clean
    prepared = prepare_rc(tag, sha, qa_dir=qa)
    assert prepared["qa"]["report_count"] == 22
    assert prepared["action"] == "build an RC preview artifact only"

    def must_fail(provider, scenario, change):
        path, original = fixtures[(provider, scenario)]
        broken = json.loads(json.dumps(original))
        change(broken)
        path.write_text(json.dumps(broken), encoding="utf-8")
        try:
            verify_local_qa(qa)
            raise AssertionError("Invalid QA report was accepted")
        except ValueError:
            pass
        path.write_text(json.dumps(original), encoding="utf-8")

    must_fail("chatgpt", "short", lambda r: r.update(verdict="pending"))
    must_fail("claude", "long", lambda r: r["required_manual_checks"].update(history="not-checked"))
    must_fail("gemini", "media", lambda r: r.update(source_upload_count=0))
    must_fail("chatgpt", "short", lambda r: r.update(source_turn_count=None))
    must_fail("chatgpt", "stop", lambda r: r.update(pdf_metrics={"pages": 1}))
    must_fail("gemini", "short", lambda r: r.update(blockers=["Synthetic blocker"]))
    must_fail("chatgpt", "long", lambda r: r.update(live_provider_confirmed=False))

    missing, original = fixtures[("gemini", "virtualized")]
    missing.unlink()
    try:
        verify_local_qa(qa)
        raise AssertionError("Missing provider-specific QA scenario was accepted")
    except ValueError:
        pass


# The manual Actions workflow must remain an unpublished read-only preview.
workflow = (ROOT / ".github/workflows/rc-preview.yml").read_text(encoding="utf-8")
assert "workflow_dispatch:" in workflow
assert "pull_request:" not in workflow and "push:" not in workflow
assert "contents: read" in workflow and "persist-credentials: false" in workflow
assert 'refs/heads/main' in workflow
assert "name: chatfolio-rc-preview-unpublished" in workflow
assert "python scripts/rc_readiness.py" in workflow
assert "python scripts/release_gate.py" in workflow
for forbidden in ("gh release create", "git push", "create-release", "contents: write"):
    assert forbidden not in workflow

print("PASS: exact SHA and RC tag, 22 synthetic QA gates, incomplete/failed/missing reports blocked")
