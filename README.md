# ChatFolio

Current release: **1.8.0**

ChatFolio is a Chrome extension that exports conversations from ChatGPT, Claude, and Gemini to PDF.

## Supported platforms

- ChatGPT
- Claude
- Gemini

## Features

- Three-layer resilience: provider data -> semantic DOM scanner -> assisted visual backup
- Adaptive bounded concurrency for faster ChatGPT text/media extraction and print transfer on faster machines
- Quota-safe Visual backup paced to Chrome's screenshot API limit, with retry backoff instead of failing on burst capture
- Assisted visual backup when a provider redesign prevents message detection/extraction
- **Visual backup** opens an on-page capture panel so the user can scroll the real conversation while ChatFolio archives the visible views
- Visual backup does not programmatically crawl provider scroll containers; it follows real user scrolling and captures distinct visible views, avoiding virtualized-history failures
- ChatGPT data-first active-branch extraction with DOM fallback
- Resilient full-conversation scanning across current and fallback Claude/Gemini DOM layouts
- Full-conversation scanning for long chats
- Stop and stall-recovery controls
- Extension-origin print view to avoid provider popup/CSP differences
- User/assistant separation
- Multilingual RTL/LTR layout
- Tables, code blocks, links, images, and detected attachments
- Comfortable and Compact reading density
- Light, Graphite, and Dark extension themes
- Local preference storage

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extension folder that contains `manifest.json`.

## Usage

1. Open a conversation in ChatGPT, Claude, or Gemini.
2. Open ChatFolio from the Chrome toolbar.
3. Choose the reading density and options you want.
4. Click **Export full chat**.
5. In Chrome's print dialog, choose **Save to PDF**.

For a cleaner PDF, disable **Headers and footers** in Chrome's print dialog.

## Privacy

ChatFolio processes conversation content in the browser to create the printable document. It does not send conversation content to a ChatFolio-controlled server. For complete ChatGPT exports it may read the current conversation through ChatGPT's own authenticated metadata endpoint; the temporary access token is held only in memory and is not stored or exported. When image embedding is enabled, the extension may fetch image resources from the AI provider domains that already host those resources. If semantic extraction fails, the visual fallback captures the active conversation tab locally through Chrome's capture API and sends those captures only to ChatFolio's local print page; they are not uploaded to a ChatFolio server.

See [PRIVACY.md](PRIVACY.md).

## Known limitations

- ChatGPT, Claude, and Gemini can change their internal data structures and page behavior without notice. Semantic export can still require maintenance after major provider changes.
- If semantic export fails, ChatFolio opens the assisted visual-backup panel. The user scrolls the conversation normally, then chooses Finish & create PDF. The resulting archive is image-based rather than selectable/searchable and may include some provider UI.
- Extremely long visual-backup archives can create large PDF files because each captured view is stored as an image. Chrome limits visible-tab capture frequency, so Visual backup is intentionally slower than semantic export even on very fast hardware.
- Some historical attachments may no longer be accessible from the provider and therefore cannot always be reconstructed in semantic mode.
- Browser-added print headers/footers are controlled by Chrome, not ChatFolio.

## License

MIT. See [LICENSE](LICENSE).

## Trademark notice

ChatGPT, Claude, Gemini, OpenAI, Anthropic, and Google are trademarks of their respective owners. ChatFolio is not affiliated with or endorsed by those companies.


## Version 1.3.0

- Mirrors the live provider page font stack for normal prose, including Persian/Arabic glyph fallback, instead of forcing a separate Arabic font.
- Restores meaningful ChatGPT progress reporting in metadata mode: connection, download, message parsing, rendering, and print-view phases.
- Keeps ChatGPT metadata-first extraction with DOM fallback, reducing sensitivity to UI/layout changes.
- Claude and Gemini retain layered provider-specific DOM adapters plus diagnostics; provider redesigns can still require adapter updates.



## Version 1.5.6

- Public ChatGPT share links are decoded from the first-party React Router hydration/turbo-stream embedded in the share page.
- The legacy `/backend-api/share/<id>` JSON endpoint is now only a compatibility fallback because public links may return HTTP 401/403 there.
- Shared-chat export still fails closed instead of silently generating a partial PDF if neither full-data route is available.

## Version 1.5.4

- Removed experimental live-page printing and restored the stable extension-owned print page as the only print path.
- Prevents the misleading Chrome extension warning that appeared when live-page mounting failed even though the fallback PDF succeeded.
- Simplified the running UI to a progress bar without live message/media counters.
- Persian/font-mirroring experiments are intentionally paused; v1.5.4 prioritizes reliable export behavior across ChatGPT, Claude, and Gemini.

## Version 1.5.1

- Prints from inside the live ChatGPT / Claude / Gemini document first, so fonts already loaded by the site or by another RTL/font extension remain available during printing.
- Uses the exact computed font stack of the visible conversation and avoids overriding it with guessed webfont families.
- Keeps the extension-origin print page as a fallback if live-page printing is blocked.
- Simplifies the popup progress UI to a progress bar without message/media counters.
- Completes the progress bar before opening Chrome print.

## Version 1.4.0

- Captures provider webfont faces and embeds font resources into the print document when available.
- Detects loaded webfont families that cover Persian/Arabic text instead of copying only the CSS font-family stack.
- Keeps system/provider font stacks as fallback when a font resource is inaccessible.
- Holds the final progress state briefly so the completed message count is visible before the print tab activates.
