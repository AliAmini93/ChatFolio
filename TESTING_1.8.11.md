# ChatFolio 1.8.11: Gemini long opening / PDF whitespace

## Scope

A Gemini export with 8 messages and one correctly embedded user screenshot previously left roughly half the first A4 page empty before the fourth reply. The previous 1.8.10 layout kept the *entire first content unit* (often one very long paragraph) inseparable from the message badge. This is too strict for long text blocks.

The 1.8.11 change is limited to Gemini text-only opening fragments exceeding 520 normalized characters. Such fragments may now fragment across pages, while the author label retains `break-after: avoid-page`. Short openings, media-first openings, tables and other platforms keep the previous behavior. No scanner, uploaded-media retrieval or scrolling logic changed.

## Browser PDF fixtures

`python tests/test_gemini_print_whitespace_191.py` in headless Chromium:

- Long first paragraph, long first DIV, nested long paragraph, and rich-text long paragraph: PASSED, each flows onto first A4 page and continues on the next.
- First-page lowest substantive content line exceeded 635 PDF points in each fixture, rather than leaving an empty lower half.
- Repeating current/total page numbering: PASSED.
- Short opening fragment, media-first Gemini opening: still grouped with badge. PASSED.
- Long Claude opening: no new `message-opening-flow` class. PASSED.

## Other regression tests

- `test_print_188.py` — PASS, author label kept with image in 8 cases, RTL page numbering.
- `test_print_polish_187.py` — PASS, long/short table page breaks, repeated THEAD, citations.
- `test_layout_186.py` — PASS, layout normalization and text preservation.
- `test_gemini_offscreen_190.py` — PASS, protected Gemini image captured and scroller restored.
- `test_upload_images_189.py` — PASS, Claude/Gemini user-upload media and adjacent images.
- `test_negative_scroll_185.py` — PASS, negative-scroll ChatGPT virtualized history.
- `test_grouped_renderer.py` — PASS, grouping/assistant response capture.

## Pending real-world confirmation

Re-export the original Gemini 8-message conversation with its user-uploaded image. Verify all eight messages, the image in user message 5, and useful content on page 1 after message 3. Do not publish private sample PDFs in the repository.
