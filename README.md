# ChatFolio

Current release: **1.8.11**. This version includes validated ChatGPT, Claude, and Gemini PDF export improvements.

ChatFolio is a Chrome extension for exporting ChatGPT, Claude, and Gemini conversations to printable, searchable PDF documents when semantic extraction is available. When it isn't, the extension offers an assisted screenshot-based Visual Backup.

## Installation

1. Extract `chatfolio-1.8.11-chrome.zip`.
2. Open `chrome://extensions/` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked**, and select the extracted `chatfolio-1.8.11` folder containing `manifest.json`.
4. Open a supported conversation and choose **Export full chat** from the ChatFolio popup.
5. In the Chrome print dialog, choose **Save as PDF**. Recent Chromium versions suppress their default page headers/footers through ChatFolio print CSS. If your browser still shows them, disable **Headers and footers**.

**Temporary Chat safety:** Do not refresh a still-open Temporary Chat tab just to update ChatFolio. Disable the older extension and load the new unpacked directory. ChatFolio 1.8.11 will not automatically reload Temporary Chat pages when an old content script is detected.

## Supported services

- ChatGPT (including shared-chat routes where full data is accessible)
- Claude
- Gemini

## Export paths

- **ChatGPT data-first:** first attempts to read the selected conversation branch using ChatGPT's existing authenticated, first-party interface. This route can be unavailable for temporary conversations.
- **Semantic DOM fallback:** traverses the browser's chat DOM, resolves authored messages/media, and preserves text selectability.
- **Assisted Visual Backup:** a separate user-selected mode for cases in which semantic extraction is unavailable. It captures visible screens as an image-based archive while you scroll manually. A failed normal export now shows an error instead of opening this mode unexpectedly.

## What is new in 1.8.11 (Gemini PDF white-space / pagination)

- Allow long, text-only opening fragments in Gemini replies to span printable pages rather than moving a whole paragraph to the next page.
- Retain author labels with the first actual lines, while leaving short openings, tables, images, and other platforms unchanged.
- Verified with synthetic Chrome/PDF fixtures and a real 8-message Gemini export; the final output retains the uploaded screenshot and uses the formerly empty first-page space.

## Fixes in 1.8.10 (Gemini off-screen image capture)

- For protected Gemini uploads on `googleusercontent.com`, prefer capturing the image displayed in the authenticated browser tab instead of re-fetching an inaccessible redirect from `chrome-extension://` and raising a CORS error.
- If Gemini's history scan has scrolled past an uploaded photo, temporarily scroll that *image* into view, wait for lazy-load, capture only its rectangle, and restore all original scroll positions in `finally`.
- Preserve Claude's already-working upload embedding and ChatGPT's scanner/Stop/print implementation unchanged.
- Retain explicit failure if an image cannot actually be captured; no silent missing uploads.
- New Chromium fixtures verify both nested and adjacent off-screen Googleusercontent uploads, crop pixel colors, no duplicate media, no additional fetches, and exact scroll restoration. **Live Gemini upload confirmation completed in version 1.8.11.**

## Fixes in 1.8.9 (Claude / Gemini user images)

- Preserve uploaded photos and screenshots when Claude or Gemini renders them in adjacent sibling containers instead of inside the authored text element. This also supports `<canvas>` and visible CSS background image previews.
- Embed image bytes directly in the printable document: first try the live provider resource, then the existing extension-origin provider-media fetch, then a tightly cropped `captureVisibleTab` of a fully visible loaded picture when browser protections prevent re-fetching.
- Avoid copying the entire conversation as a screenshot; cropped image fallback covers only the picture bounds. Do not count broken-image icons as captured media.
- If an identified user image still cannot be embedded, stop semantic export with an explicit warning instead of silently producing an incomplete PDF. The user may retry while the image is visible or choose Visual Backup manually.
- Preserve ChatGPT's prior image-embedding route, scanner, Stop controls, print styles, and page layout.

**Validation status:** synthetic Chromium fixtures verify Claude and Gemini in-message/sibling images, capture fallback and a real generated PDF with an embedded 640 × 360 image. Real user-image exports have also been verified on Claude and Gemini; providers can change their pages later.

## Fixes in 1.8.8

- Author-defined empty page-margin boxes hide the browser-added date, long extension URL and default page counters in current Chrome, even when Print > Headers and footers is enabled. This is CSS based and not guaranteed on older/non-Chromium browsers.
- Short tables are kept together when they fit on one page; long tables retain a repeatable THEAD, including when a provider placed the first TH row in TBODY.
- Printed citation/source cards become small, wrapping source chips with original links and icons preserved.
- Strengthened page-break hints between role badges and the opening content of each answer.
- No changes to the scanning, deduplication, stop, or visual backup engines.

## Fixes carried forward from 1.8.6

- Normalize provider-only CSS classes/data attributes on the print clone while retaining ChatFolio, KaTeX, and code syntax classes. Prevents source card utility CSS from introducing massive print whitespace.
- Strip grid, flex, aspect-ratio, and margin/padding inline layout hints that do not belong in a paginated document.
- Allow long figures/cards to split between pages while keeping their image media unbroken.
- Slightly reduce exchange spacing and cap non-screenshot response images at 108mm height, without sacrificing body readability.
- Keep the scanning and Stop code unchanged; validate text, images, links, tables, and math using browser fixtures.

## Fixes carried forward from 1.8.5

- Recognizes signed-negative scroll offsets in reversed flex scrollports (0 at bottom, negative at top), then scans in a normalized forward coordinate.
- Probes both positive and negative directions before rejecting a candidate scrollport.
- If scanning is still blocked, reports probe offsets and message movement without including chat text.
- Stops automatic tab refresh on update for Temporary Chat pages.
- Subsequent live ChatGPT exports validated this scrolling fix.

## Fixes carried forward from 1.8.4

- Verifies the actual conversation scroll container using visible message movement, not scrollTop changes alone.
- Detects new virtualized message content and tolerates temporary scroll-anchor jumps.
- Re-detects the scroller after a stall and limits recovery to three attempts.
- No longer mistakes the final *mounted* message for the end of a long ChatGPT conversation.
- Stabilizes message fingerprints when adjacent virtualized turns mount and unmount, preventing duplicate exports.
- Does not automatically launch Visual Backup after a failed ordinary export; the user may choose it explicitly.

- Avoids capturing only the `ChatGPT said:` accessibility/role caption when the actual response appears in adjacent elements of a grouped ChatGPT turn.
- Separates the user's question from the assistant's group-wide response capture.
- Checks for label-only/empty assistant captures and refuses to silently produce an incomplete semantic PDF.
- Keeps the live rendered image width where available, with separate compact image caps for generated/product pictures and larger caps for screenshots.
- Recognizes ChatGPT `temporary-chat=true` routes as routes where ordinary conversation metadata may be unavailable.
- Adds start/end scan guards against unverified partial traversal.

## Known limitations

- ChatGPT, Claude and Gemini frequently change DOM and API response structures. There is no universal guarantee of full-chat extraction if a provider exposes neither complete conversation metadata nor its full history to the browser.
- Temporary chats may be readable only through DOM scanning or Visual Backup.
- Some inaccessible old images/attachments cannot be recovered after their provider links expire.
- Visual Backup is image-based and may create large PDFs. Use the manual capture process as instructed by the panel.
- Chrome controls its own print-dialog headers and footers.
- **1.8.1 source was not part of the provided archive.** This build applies and tests the repairs against the supplied **1.8.0** code; features added only in a separate 1.8.1 build are not independently verified here.

## Local tests

If Python and Playwright are installed, run `python tests/test_negative_scroll_185.py`, `python tests/test_scroller_184.py`, `python tests/test_grouped_renderer.py`, and `python tests/test_layout_186.py`. Tests use synthetic DOM examples; they do not substitute for testing on the live ChatGPT conversation that produced a truncated PDF.

## Privacy and license

ChatFolio has no backend storing your chats. Its browser-side extraction may request first-party provider metadata, media and font resources as needed. See [PRIVACY.md](PRIVACY.md).

Licensed under MIT; see [LICENSE](LICENSE). ChatGPT, Claude, and Gemini are trademarks of their respective owners. ChatFolio is not affiliated with or endorsed by OpenAI, Anthropic or Google.

## Developing ChatFolio

The stable v1.8.11 runtime is currently preserved while the development
infrastructure is modernized in small, reviewable steps. See
[Development and testing](docs/development.md),
[Contributing](CONTRIBUTING.md), and
[Architecture decision 0001](docs/architecture/0001-baseline-and-ci.md).

Developer commands: `npm run check` validates syntax and manifest assets,
`npm test` runs the Chromium regression fixtures, and `npm run build` makes the
Chrome ZIP from an explicit allowlist. GitHub Actions runs these for pull
requests. This does **not** replace real-session smoke testing on provider sites.

## Architecture migration (phase 2)

Provider-neutral conversation and adapter contracts live in `src/core/` and
are described in [ADR 0002](docs/architecture/0002-conversation-contracts.md).
Run `npm run test:core` for fast domain contract checks, or `npm test` for
those checks plus the 13 browser regressions. The shipped extension still
uses the existing `content.js`: the new contracts are a migration foundation,
not a claim that provider adapters have already been split.

## Refactoring status (phase 3 / step A)

Provider DOM adapters are separate ESM modules under `src/providers/`.
Run `npm run bundle` after source changes and see `docs/architecture/0003-provider-dom-adapters.md`.

### Architecture refactor: phase 3B1

ChatGPT's conversation-branch and shared-page metadata decoders are now an
independent, tested module (`src/providers/chatgpt/metadata-parser.js`). The
shipping single-file MV3 content script is generated deterministically;
transport, media, and long-chat scanning are not yet migrated. See
[ADR 0003B1](docs/architecture/0003b1-chatgpt-metadata-parsers.md).

### Engineering refactor milestone — ChatGPT transport (Phase 3B2)

The source code now isolates ChatGPT session, conversation, public-share, legacy
share, and attachment URL requests in `src/providers/chatgpt/transport.js`.
This is a structural change; the published Stable release remains v1.8.11.
No provider permissions or export UI were changed. See
`docs/architecture/0003b2-chatgpt-transport.md` for compatibility boundaries.

### Engineering refactor milestone — Gemini history scanner (Phase 3B3)

Gemini's scroll-to-load history collection and message completeness checks are
isolated in `src/providers/gemini/history-scanner.js`. The generated Chrome
content script remains classic MV3, and the user-facing release stays
`v1.8.11`. See [ADR 0003B3](docs/architecture/0003b3-gemini-history-scanner.md).
