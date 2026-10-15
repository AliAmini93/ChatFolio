"""Phase 6A: a REAL loaded MV3 extension + worker -> print tab smoke test.

Unlike the unit and synthetic-page browser fixtures, this test never stubs
chrome.runtime, chrome.tabs or chrome.storage. A new disposable browser profile
loads the unpacked extension as Chrome does in development. No provider login,
network access or user chat data is needed.

This test is intentionally an integration smoke for the *transport and print
page*, not a claim that a live provider's entire conversation was captured.
"""
from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
assert (ROOT / "manifest.json").exists()
assert (ROOT / "background.js").exists()
assert (ROOT / "print.html").exists()
assert (ROOT / "print.js").exists()

SAFE_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9f03sAAAAASUVORK5CYII="
)
DOCUMENT = (
    '<!doctype html><html lang="fa" dir="rtl"><head>'
    '<meta charset="utf-8"><title>ChatFolio Phase 6A</title>'
    '<style>body{font-family:Arial,sans-serif}</style></head><body>'
    '<main><h1>PHASE_6A_MV3_REAL_WORKER</h1>'
    '<p dir="rtl">سلام، آزمایش انتقال واقعی اکستنشن.</p>'
    '<table><thead><tr><th>Metric</th><th>Value</th></tr></thead>'
    '<tbody><tr><td>Voltage</td><td>2.5</td></tr></tbody></table>'
    '<img alt="safe-image" src="' + SAFE_PNG + '">'
    '</main></body></html>'
)

def send(page, message):
    return page.evaluate("""async (data) => {
      return await chrome.runtime.sendMessage(data);
    }""", message)

with TemporaryDirectory(prefix="chatfolio-real-mv3-") as profile:
    with sync_playwright() as p:
        launch = {
            "user_data_dir": profile,
            "headless": True,
            # Full Chromium (new headless mode), not chrome-headless-shell:
            # headless shell disables normal unpacked MV3 extensions.
            "channel": "chromium",
            "args": [
                "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-extensions-except=" + str(ROOT),
                "--load-extension=" + str(ROOT),
            ],
        }
        if os.environ.get("CHATFOLIO_CHROMIUM"):
            launch["executable_path"] = os.environ["CHATFOLIO_CHROMIUM"]
        context = p.chromium.launch_persistent_context(**launch)
        try:
            worker = (
                context.service_workers[0] if context.service_workers
                else context.wait_for_event("serviceworker", timeout=20000)
            )
            extension_id = urlparse(worker.url).netloc
            assert len(extension_id) == 32, f"Extension worker not loaded: {worker.url!r}"
            assert worker.url.endswith("/background.js"), worker.url

            # A tab with the extension's popup acts as a synthetic source.
            # Requests go through real chrome.runtime messaging and tab APIs.
            source = context.new_page()
            source.goto(f"chrome-extension://{extension_id}/popup.html", wait_until="load")
            assert source.evaluate("chrome.runtime.id") == extension_id
            assert source.locator("#exportBtn").count() == 1

            job_id = "phase-6a-real-runtime"
            response = send(source, {
                "type": "CHATFOLIO_PRINT_BEGIN",
                "jobId": job_id,
                "title": "Phase 6A real MV3 printable document",
                "platform": "chatgpt",
                "platformName": "ChatGPT",
                "totalChunks": 2
            })
            assert response["ok"] and isinstance(response["printTabId"], int), response
            print_url = (
                f"chrome-extension://{extension_id}/print.html?job={job_id}"
            )
            print_page = next(
                (page for page in context.pages if page.url == print_url),
                None,
            )
            assert print_page is not None, (
                f"Real background did not open print tab: {[p.url for p in context.pages]}"
            )

            # Deliberately send chunks out of order to verify the real MV3
            # worker/Port/iframe pipeline reassembles them by index.
            midway = len(DOCUMENT) // 2
            parts = [DOCUMENT[:midway], DOCUMENT[midway:]]
            assert send(source, {
                "type": "CHATFOLIO_PRINT_CHUNK",
                "jobId": job_id, "index": 1, "data": parts[1],
            })["ok"]
            assert send(source, {
                "type": "CHATFOLIO_PRINT_CHUNK",
                "jobId": job_id, "index": 0, "data": parts[0],
            })["ok"]
            assert send(source, {
                "type": "CHATFOLIO_PRINT_END", "jobId": job_id
            })["ok"]

            print_page.wait_for_function(
                "() => document.body.classList.contains('ready')",
                timeout=20000,
            )
            body = print_page.frame_locator("#preview").locator("body")
            body.wait_for(timeout=10000)
            rendered = body.inner_text()
            assert "PHASE_6A_MV3_REAL_WORKER" in rendered, rendered[:400]
            assert "سلام" in rendered, rendered[:400]
            assert "Voltage" in rendered and "2.5" in rendered, rendered[:400]
            image_src = print_page.frame_locator("#preview").locator("img").get_attribute("src")
            assert image_src == SAFE_PNG
            assert print_page.locator("#printAgain").is_visible()
            assert print_page.title() == "Phase 6A real MV3 printable document"

            # The preview consumes the complete job and the background should
            # no longer report it as an active or restorable transfer.
            print_page.wait_for_timeout(350)
            status = send(source, {
                "type": "CHATFOLIO_PRINT_STATUS", "jobId": job_id
            })
            assert not status.get("ok"), status
            print_page.close()
            source.close()
        finally:
            context.close()

print("PASS: real unpacked MV3, extension worker, chunks, print Port, PDF-ready frame and cleanup")
