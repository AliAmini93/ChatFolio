# Phase 6B1: Long PDF integrity and local-only audit

Status: **synthetic automation**, not a completed live-provider acceptance test.
The published `v1.8.11` extension/tag remains unchanged.

## Automated long-conversation acceptance

Run `CHATFOLIO_CHROMIUM=/usr/bin/google-chrome-stable "$PY" scripts/test.py --pattern test_long_pdf_phase6b1.py`.

The fixture creates 120 synthetic ordered turns, mixed Persian/English text, 60 message exchanges, occasional real tables, KaTeX/MathML, code samples, and embedded PNG image data. It calls the production bundled `buildPrintableDocument`, prints with headless Chromium, and checks:

- All 120 trace tokens occur **exactly once**, in source order, in the searchable PDF text.
- All tokens exist exactly once in the generated HTML before printing (helps distinguish renderer loss from PDF text extraction loss).
- All pages are A4 portrait and contain selectable content; page counter numbering remains correct.
- At least one embedded image makes it into the PDF; safe table/code text remains searchable; HTML remains Persian/RTL where appropriate.
- The output is kept in a temporary directory and automatically deleted. No private conversations are accessed or committed.

This tests the rendering stress path. It **does not validate** that any provider exposed all 120 actual authored turns to the extraction engine.

## Private local PDF auditing

Run this **on your own computer**; no PDF data is sent to GitHub, CI or ChatGPT:

```bash
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"
"$PY" scripts/qa_pdf_audit.py "/absolute/path/to/your/export.pdf"
```

The script reports only page count, number of portrait A4 pages, selectable character count, embedded image occurrences, and page numbers with unexpectedly little text. It prints **no text from the PDF** and does not retain copies. Blank-page warnings can be false positives for intentionally image-heavy pages. PDFs with text may still miss source turns, images or equations: manually inspect those against the original chat.

Do not place your private PDF or `Previous Chats/` inside git history, test fixtures, CI logs or GitHub artifacts. Keep the local folder excluded and never commit it.

## Live-provider release gate still outstanding

Complete the matrix in [phase6-real-provider-checklist.md](phase6-real-provider-checklist.md) for ChatGPT, Claude and Gemini with the **experimental extension** and your own logged-in browser. Check a short and a long conversation, RTL, math, tables, protected user images, Stop and Temporary Chat safety. Record only redacted pass/fail metrics, not chat content. The real-provider result must be explicit before a `v1.9.0-rc.1` release.
