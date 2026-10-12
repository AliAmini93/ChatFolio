# ChatFolio 1.8.8 - Print pagination verification

Build is based on ChatFolio 1.8.7. Semantic extraction, provider adapters, scroller selection, and cancellation are unchanged.

## Changes
- Message metadata and the first semantic content fragment form a single `message-opening` print unit, even through nested provider containers. The rest of a long response can still flow to later pages. Source cards are treated as one linked item, rather than splitting their logo from hostname.
- Print CSS `@page @bottom-center` inserts `page / total pages`, with direction forced LTR for Persian/Arabic/Hebrew conversations. Existing empty margin boxes suppress browser-generated headers and footers.
- Source overflow markers such as `+2` get a small gap/divider inside their compact source chip while preserving the original label and link.

## Tests executed (synthetic fixtures)
- `python tests/test_print_188.py`: 8 independent near-end-page cases with nested first image, numbered pages in English and Persian, source overflow count and link preserved.
- `python tests/test_print_polish_187.py`: no browser headers/footers; long THEAD repeated; short table intact; 60 table rows and links preserved.
- `python tests/test_layout_186.py`: responsive provider CSS absent and first-page density improved.
- `python tests/test_grouped_renderer.py`: grouped assistant answers/media/table and empty-answer safeguards.
- `python tests/test_scanner_183.py`, `python tests/test_scroller_184.py`, `python tests/test_negative_scroll_185.py`: scanner, stuck-stop and reversed scroll fixtures.
- `node --check` for content.js, popup.js, background.js, print.js; manifest parsed with Python JSON.

## Manual validation still needed
- Export the actual 16-message Lattafa Temporary Chat and visually compare with its v1.8.7 PDF; real provider DOM and installed browser settings are not available in our synthetic tests.
- Verify in ChatGPT, Claude and Gemini with longer chats, images and tables before a public store release.
- CSS margin-box pagination requires a recent Chromium version. If unsupported, page counters may be absent; all conversation text should still print.
