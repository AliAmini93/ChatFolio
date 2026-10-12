# ChatFolio

Current pre-release candidate: **1.8.8**. Stable public release: **1.8.0**.

ChatFolio is a Chrome extension for exporting ChatGPT, Claude, and Gemini conversations to printable, searchable PDF documents when semantic extraction is available. When it isn't, the extension offers an assisted screenshot-based Visual Backup.

## Installation

1. Extract `chatfolio-1.8.8-chrome.zip`.
2. Open `chrome://extensions/` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked**, and select the extracted `chatfolio-1.8.8` folder containing `manifest.json`.
4. Open a supported conversation and choose **Export full chat** from the ChatFolio popup.
5. In the Chrome print dialog, choose **Save as PDF**. Recent Chromium versions suppress their default page headers/footers through ChatFolio print CSS. If your browser still shows them, disable **Headers and footers**.

**Temporary Chat safety:** Do not refresh a still-open Temporary Chat tab just to update ChatFolio. Disable the older extension and load the new unpacked directory. ChatFolio 1.8.8 will not automatically reload Temporary Chat pages when an old content script is detected.

## Supported services

- ChatGPT (including shared-chat routes where full data is accessible)
- Claude
- Gemini

## Export paths

- **ChatGPT data-first:** first attempts to read the selected conversation branch using ChatGPT's existing authenticated, first-party interface. This route can be unavailable for temporary conversations.
- **Semantic DOM fallback:** traverses the browser's chat DOM, resolves authored messages/media, and preserves text selectability.
- **Assisted Visual Backup:** a separate user-selected mode for cases in which semantic extraction is unavailable. It captures visible screens as an image-based archive while you scroll manually. A failed normal export now shows an error instead of opening this mode unexpectedly.

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
- The reverse-scroll fix has been validated on a real ChatGPT Temporary Chat (16 exported turns), but provider interfaces may still change.

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
