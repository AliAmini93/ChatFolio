# ChatFolio v1.9.0 — stable release notes (2026-10-20)

This is the first stabilized release after the multi-phase architectural refactoring. It includes the integrated Phase 8D ChatGPT Rich UI history recovery from PR #24.

## Highlights

- Modular ChatGPT, Claude and Gemini provider adapters; explicit data contracts, media pipeline and PDF renderer.
- Safer HTML sanitization and print-transfer recovery, bounded resources, deterministic Chrome extension packaging, and release integrity checks.
- Better fidelity for long ChatGPT conversations using confidently matched rendered historical answers from virtualized DOM while retaining authenticated API ordering and text.
- Faster attachment/signature matching on large conversations: the observed matching time dropped from approximately 13.3s to 2.4s in a 122-turn real ChatGPT test.
- Explicit abort instead of a silently incomplete Rich UI capture if the ChatGPT source tab becomes hidden during scanning.

## Evidence and artifact

- Ubuntu verification of the integrated code and version 1.9.0: 85/85 unit tests, 38/38 browser regressions on the prior verified candidate, 12 checked runtime ZIP files, and reproducible byte-identical archive.
- Real foreground ChatGPT conversation: 122 API turns, 29/29 mounted conversation groups traversed, 14 rich assistant matches, 74 pages and 57 clickable PDF links.
- Expected distributable: `chatfolio-1.9.0-chrome.zip` (115,230 bytes).
- Expected ZIP SHA-256: `dd1b55870995b36140a251d3efe8d8bc21c40ce3954ec4d357a45187db2f7f3f`.

## Known limitations and deliberately accepted release exceptions

- **Intermittent ChatGPT assistant preview images — [issue #25](https://github.com/AliAmini93/ChatFolio/issues/25):** delayed thumbnail/preview hydration can leave circular loading placeholders in PDF, despite complete message/text/link coverage. Different exports of the same chat have shown 11 versus 15 raster image appearances. This can affect content images and must not be described as perfect visual parity. Planned to investigate and correct in a **v1.9.1** patch.
- **Keep the ChatGPT tab visible:** historical Rich UI recovery does not resume automatically after the tab enters the background. The exporter fails with a clear error rather than delivering a silently incomplete PDF.
- **Live-provider QA coverage:** the full 22-scenario manual acceptance matrix across ChatGPT, Claude, and Gemini is **not completely verified**. Automated tests and selected real-provider examples are confirmed, but the remaining scenarios must not be reported as passing. The maintainer explicitly accepted this disclosure and the resulting release risk on **2026-10-20**. This decision is a release exception, not a retroactive change to QA verdicts.

## Installation and upgrade

Download the attached `chatfolio-1.9.0-chrome.zip`, verify the published SHA-256, extract to a permanent directory, and use Chrome `chrome://extensions` -> Developer mode -> Load unpacked. Disable an older unpacked ChatFolio copy before adding another to avoid confusion. Keep the original source tab visible during exports.

No personal conversations, user screenshots, tokens or private PDFs are part of this repository or the release ZIP.

## Follow-up

Track image preview stabilization under [issue #25](https://github.com/AliAmini93/ChatFolio/issues/25), target version **v1.9.1**. Continue the remaining real-provider acceptance scenarios without inflating their status.
