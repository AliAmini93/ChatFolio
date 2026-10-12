# ChatFolio 1.8.7 - print-layout regression tests

This release is based directly on the user's 1.8.6 source archive. It does not change the scanner, provider adapters, message identity, cancellation, or print job transport logic.

## Verified in local Chromium (synthetic DOM and PDF fixtures)

- `python tests/test_print_polish_187.py` produced a four-page A4 PDF.
  - Chrome browser-added `about:blank`, date/time, extension URL and default page numbers were absent even with Chromium's `display_header_footer=True`.
  - A three-row short table was placed entirely on page 2 (instead of splitting).
  - The header of a 60-row long table was repeated on each of its three pages. All 60 rows retained exactly once.
  - The test deliberately supplied the long table's initial `TH` cells inside `TBODY` and verified the print clone promoted them into a semantic `THEAD`.
  - The citation favicon + original source link appeared as a compact clickable source chip; source text and product image were preserved.
- `python tests/test_layout_186.py` preserved 856 extractable characters with no lost content; source CSS sanitization from 1.8.6 remains effective.
- `python tests/test_grouped_renderer.py` passed grouped ChatGPT response capture, media and label-only protections.
- `python tests/test_negative_scroll_185.py` passed reverse-scroll regression, with 56 virtualized messages captured in order.
- `python tests/test_scroller_184.py` passed real and portal-style scroll-container discovery.
- `python tests/test_scanner_legacy_regression.py` passed safe error/backup regression scenarios.

## Limitations and manual acceptance

- The genuine 11-page PDF named `خرید ست لطافه(2).pdf` was inspected to identify the layout issues, but its original full web DOM is not contained in the PDF. It is not possible to regenerate exactly that PDF with the new exporter using only the PDF attachment.
- Re-export the original conversation from ChatGPT and verify 16 messages (8 user / 8 assistant), images, table content, source references, text searchability and practical page breaks.
- Modern Chromium supports CSS `@page` margin boxes. Older Chromium/other browsers may still need Print > Headers and footers OFF.
- No claim is made about further page reduction (the already accepted 1.8.6 export reduced 15 to 11 pages).
- In Temporary Chat, do NOT reload/refresh the browser tab just to install a new unpacked extension.
