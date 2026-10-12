# ChatFolio 1.8.4 - Temporary ChatGPT regression

1. Do not refresh the original Temporary Chat tab before testing (temporary chat content may be lost).
2. Disable the earlier unpacked 1.8.3 extension (do not delete the preserved ZIP).
3. Load the extracted 1.8.4 folder via `chrome://extensions` > Developer mode > Load unpacked.
4. In the original tab, run Export full chat. The extension probes potential thread scrollports by visible message movement.
5. Inspect the PDF: total exchanges, actual assistant paragraphs (not only "ChatGPT said:"), images at reader-friendly scale, no skipped messages, correct order.
6. If it fails, copy the **full error string**, especially the `Scrollers:` part. That contains only scroll-element metadata, no message content, and helps identify the live layout.
7. Do not publish this test version to GitHub until verified on the real Temporary Chat and on Claude/Gemini.

## Developer regression suite

Run `python tests/test_grouped_renderer.py`, `python tests/test_scroller_184.py`, and `python tests/test_scanner_legacy_regression.py` (Python Playwright + system Chromium).
