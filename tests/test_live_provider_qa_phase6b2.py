"""Phase 6B2: validate privacy-safe report and mandatory manual live QA gates.

The only PDF in this test is synthetic. No provider sessions, uploaded chats,
cookies or external network access are used.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

import fitz

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "qa_live_provider.py"


def run(*args: str) -> tuple[subprocess.CompletedProcess[str], dict | None]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    data = json.loads(result.stdout) if result.stdout.strip() else None
    return result, data


with TemporaryDirectory(prefix="chatfolio-phase6b2-") as temp:
    local = Path(temp)
    private_pdf = local / "SECRET_PRIVATE_CONVERSATION.pdf"
    secret_text = "PRIVATE_PERSONAL_CONVERSATION_TOKEN_9271"
    with fitz.open() as pdf:
        first = pdf.new_page(width=595.28, height=841.89)
        first.insert_text((60, 90), "Private synthetic payload " + secret_text, fontsize=12)
        first.insert_text((60, 130), "Second page intentionally not needed", fontsize=11)
        pdf.save(private_pdf)

    def basic(provider="chatgpt", scenario="short"):
        return (
            "--provider", provider, "--scenario", scenario,
            "--pdf", str(private_pdf), "--source-turns", "2",
        )

    success, report = run(
        *basic(), "--check", "turns=pass", "--check", "layout=pass",
        "--output", str(local / "counts.json"),
    )
    assert success.returncode == 0, (success.stdout, success.stderr)
    assert report["verdict"] == "pass" and report["live_provider_confirmed"] is True
    assert report["pdf_metrics"]["pages"] == 1
    assert report["pdf_metrics"]["a4_portrait_pages"] == 1
    assert report["pdf_metrics"]["pages_with_selectable_text"] == 1
    assert report["source_turn_count"] == 2
    saved = (local / "counts.json").read_text(encoding="utf-8")
    assert json.loads(saved) == report
    assert secret_text not in saved and private_pdf.name not in saved and str(private_pdf) not in saved
    assert secret_text not in success.stdout and secret_text not in success.stderr

    pending, pending_data = run(*basic(provider="claude"), "--check", "layout=pass")
    assert pending.returncode == 3 and pending_data["verdict"] == "pending"
    assert pending_data["live_provider_confirmed"] is False

    missing_count, count_report = run(
        "--provider", "gemini", "--scenario", "short",
        "--pdf", str(private_pdf),
        "--check", "turns=pass", "--check", "layout=pass",
    )
    assert missing_count.returncode == 3 and count_report["verdict"] == "pending"

    rejected, rejected_data = run(
        *basic(provider="gemini"), "--check", "turns=fail",
        "--check", "layout=pass",
    )
    assert rejected.returncode == 1 and rejected_data["verdict"] == "fail"

    rich_pending, rich_data = run(
        *basic(scenario="rich"), "--check", "turns=pass",
        "--check", "layout=pass",
    )
    assert rich_pending.returncode == 3
    assert rich_data["required_manual_checks"]["math"] == "not-checked"
    assert rich_data["required_manual_checks"]["tables"] == "not-checked"

    media, media_data = run(
        *basic(scenario="media"), "--source-uploads", "2",
        "--check", "turns=pass", "--check", "layout=pass",
        "--check", "uploads=pass",
    )
    assert media.returncode == 0
    assert any("raster PDF images" in warning for warning in media_data["review_warnings"])
    # The image count is a heuristic, never confused with human-confirmed fidelity.

    stop, stop_data = run(
        "--provider", "chatgpt", "--scenario", "stop", "--check", "stop=pass",
    )
    assert stop.returncode == 0 and stop_data["pdf_metrics"] is None

    stop_with_pdf, stop_error = run(*basic(scenario="stop"), "--check", "stop=pass")
    assert stop_with_pdf.returncode == 2 and stop_error is None
    assert str(private_pdf) not in stop_with_pdf.stderr

    bad_check, bad_data = run(*basic(), "--check", "turns=unknown")
    assert bad_check.returncode == 2 and bad_data is None
    assert str(private_pdf) not in bad_check.stderr

    absent, absent_data = run(
        "--provider", "chatgpt", "--scenario", "short",
        "--pdf", str(local / "sensitive_missing.pdf"), "--source-turns", "2",
    )
    assert absent.returncode == 2 and absent_data is None
    assert "sensitive_missing" not in absent.stderr

print("PASS: all three provider verdicts, privacy-safe counts, mandatory checks, abort and invalid-input gates")
