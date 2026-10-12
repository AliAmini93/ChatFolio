# ChatFolio v1.8.8 (Pre-release)

This pre-release upgrades ChatFolio 1.8.0 with fixes for full-chat extraction and PDF page layout.

### Highlights
- Improved ChatGPT Temporary Chat traversal, including negative `scrollTop` layouts and misleading scroll containers.
- Safer failure handling: avoid silently generating incomplete PDF exports; Visual Backup remains manually available.
- Better grouped ChatGPT assistant message extraction, image sizing, and removal of inherited web-layout whitespace.
- More readable A4 printing: tighter layouts, repeatable table headings, compact source citations, role-label page-break protection and `page / pages` footers in recent Chromium.
- No automatic reload of Temporary Chat tabs after extension updates.

### Validation
- A real 16-message ChatGPT Temporary Chat exported into an 11-page searchable PDF, with image and link preservation checked across iterations.
- Automated synthetic Chromium tests cover multiple scroll layouts, 60-turn virtualization, grouped answers, RTL pagination, long tables and citations.
- Claude and Gemini remain supported through existing adapters, but this change set has not been field-tested against current live sessions from those services.

### Install
Download `chatfolio-1.8.8-chrome.zip`, extract it, then open `chrome://extensions`, enable Developer mode and use **Load unpacked** on the extracted folder. Disable previous unpacked ChatFolio versions first. Do not refresh an open Temporary Chat just to update the extension.

### Known limitations
Provider DOM/API changes may affect extraction. `page / pages` margin box counters depend on recent Chromium print support. Visual Backup produces an image-based archive rather than selectable text.
