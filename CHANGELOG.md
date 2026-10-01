# ChatFolio 1.8.0

- Replaced the unreliable automatic Visual Backup scroll crawler with an assisted capture workflow driven by real user scrolling.
- Visual Backup now opens an isolated on-page control panel: go to the beginning, Start capture, scroll normally, then Finish & create PDF.
- Added automatic capture during wheel/touch/keyboard/scroll activity plus a manual **Capture current view** button for maximum reliability.
- Added near-duplicate frame detection so repeated viewports are ignored instead of producing misleading repeated PDF pages.
- Visual Backup now refuses to finish after meaningful scrolling if only a couple of distinct frames were captured, preventing the previous silent 2-page failure.
- The capture overlay is hidden during screenshots so ChatFolio controls are not embedded in the archive.
- Chrome screenshot quota pacing and retry backoff from 1.7.x remain in place.
- Normal ChatGPT/Claude/Gemini semantic export paths and performance logic are unchanged.

## Previous releases

# ChatFolio 1.7.1

- Fixed Visual Backup selecting a scrollable sidebar/wrapper while capturing the unchanged conversation area.
- Visual Backup now discovers scrollers from central viewport hit-testing, main-content overlap, and real movement probing.
- The capture crop is tied to the selected conversation region instead of an unrelated `main` element.
- Added self-validation: if the first candidate produces too little real conversation movement or too few frames, ChatFolio restores it and tries another candidate automatically.
- Preserved the quota-safe `captureVisibleTab` queue from 1.7.0.

# Changelog

## 1.7.1

- Fixed Visual backup failures caused by Chrome's `captureVisibleTab` quota by adding a serialized capture queue, automatic quota pacing, and retry backoff.
- Visual backup now respects Chrome's reported capture limit instead of issuing screenshots as fast as the page can scroll.
- Manual Visual backup enters the provider-agnostic path before typography/message inspection, reducing dependence on provider DOM during emergency export.
- Added hardware- and connection-aware bounded concurrency for ChatGPT semantic message/media rendering.
- ChatGPT normal and shared-chat exports now resolve independent messages/media in parallel while preserving original conversation order.
- Increased print-transfer chunk size on machines with more memory and sends print chunks with bounded parallelism.
- Kept provider request concurrency deliberately conservative (maximum 4) to reduce the risk of triggering provider rate limits.
- No additional extension permissions were added.

## 1.6.0

- Added an automatic layout-independent visual archive fallback for ChatGPT, Claude, and Gemini.
- If provider data and semantic DOM extraction both fail, ChatFolio now scrolls the conversation generically and captures sequential viewport images instead of aborting.
- Visual fallback does not require message selectors, role attributes, message counts, or provider-specific markup.
- Added a manual **Visual backup** button so users can bypass semantic extraction entirely when a future provider change produces suspiciously incomplete output without an explicit error.
- Added generic scroll-container scoring so the emergency path can keep working across substantial UI/layout changes.
- Added top-history stabilization for virtualized/infinite conversations before visual capture begins.
- Added local JPEG capture/cropping and overlap between captures to reduce gaps while keeping emergency PDFs reasonably sized.
- Stop Export remains functional during visual fallback and the original scroll position is restored afterward.
- Visual fallback is clearly marked in the PDF because its content is image-based rather than selectable/searchable text.

## 1.5.6

- Fixed large ChatGPT shared conversations whose React Router payload stores the conversation in deferred `P<index>:` promise patches.
- Shared-page parser now accepts both `linear_conversation` and `mapping/current_node` representations.
- Public share HTML is retried anonymously first to obtain the fully server-rendered hydration payload.
- Legacy `/backend-api/share/<id>` fallback now includes the current ChatGPT auth/account headers when available.

- Fixed public ChatGPT share links that returned HTTP 401 from the legacy `/backend-api/share/<id>` endpoint.
- Added decoding of the complete first-party React Router turbo-stream embedded in ChatGPT `/share/<id>` pages.
- Reads `linear_conversation` directly from the public share-page hydration payload before trying the legacy backend endpoint.
- Keeps the fail-closed behavior for shared chats: no silently partial PDF when complete shared data cannot be recovered.


## 1.5.4

- Restores actual ChatGPT prompt images when metadata extraction is used.
- Resolves `image_asset_pointer` / `file-service://` assets through ChatGPT file-download endpoints.
- Supports newer `sediment://` attachment references as a fallback.
- Embeds resolved image assets into the printable document when image embedding is enabled.
- Preserves image uploads that are present only in message metadata attachments.
- Keeps media ordering close to the original multimodal content parts.

# ChatFolio Changelog

## 1.5.4

- Removed experimental live-page printing after it produced provider-page mount failures and Chrome extension warnings.
- Restored the extension-owned print view as the single reliable rendering path.
- Simplified export progress: the bar advances to completion without exposing live message/media counters.
- Paused provider/third-party Persian font mirroring to avoid further print regressions.

## 1.5.1

- Fixed the one-page blank PDF regression introduced by v1.5.0 live-page printing.
- Live-page printing now mounts the printable conversation in the provider page light DOM instead of a ShadowRoot, preserving fonts loaded by RTL/font extensions while remaining printable in Chromium.
- Added a mounted-content sanity check before opening the print dialog.
- Simplified the popup progress UI to the progress bar and status text only; message/media counters and numeric percentage were removed.

## 1.5.1

- Added live-page print mode as the primary renderer. This keeps the provider document's loaded FontFaceSet available, including Persian fonts supplied by third-party RTL/font extensions.
- Preserved the exact computed live-page font stack instead of prepending guessed font families.
- Kept the extension-origin print page as a fallback.
- Simplified export progress to a visual progress bar; message/media counters are no longer shown in the popup.
- The progress bar reaches 100% before Chrome print is opened.

# Changelog

## 1.4.0

- Capture matching provider `@font-face` rules and embed their font resources into the print document when available.
- Detect webfont families that actually cover Persian/Arabic and Latin sample text instead of relying only on `getComputedStyle().fontFamily`.
- Preserve provider/system font stacks as a fallback when a webfont cannot be captured.
- Hold the progress UI at the final message count briefly before activating the print tab.
- Wait longer for embedded fonts to finish loading before opening the browser print dialog.
- Keep font-resource fetching restricted to the supported providers and their static/CDN domains.

## 1.3.0

- Changed PDF typography to mirror the live provider page's computed font stack instead of forcing Noto Sans Arabic for entire RTL blocks. This lets Chrome use the same per-glyph system fallback used in the chat UI.
- Added source-page typography sampling for ChatGPT, Claude, and Gemini.
- Made the ChatGPT metadata progress bar meaningful: authentication, conversation download, turn parsing with live message/media counts, rendering, and print preparation now report real phases.
- Renamed the popup progress section from "Conversation scan" to "Conversation export" because ChatGPT metadata mode no longer needs to scroll-scan the page.
- Preserved metadata-first ChatGPT extraction with DOM fallback and provider diagnostics.

## 1.2.1

- Fixed Persian/Arabic font selection in mixed-language conversations.
- RTL documents now select the Arabic-script font stack even when code or English tokens dominate the raw character count.
- RTL message blocks explicitly use an Arabic UI font stack while LTR blocks keep the Latin UI stack.
- Added Noto Sans Arabic UI as the preferred local Persian/Arabic font on Linux, with Noto Sans Arabic, Noto Naskh Arabic, Vazirmatn, Tahoma, Arial, and system fallbacks.
- No remote fonts are downloaded or bundled.


## 1.2.0

- ChatGPT now uses an API-first, active-branch metadata extractor before DOM scanning, eliminating dependence on virtualized scrolling when metadata is available.
- Added authenticated ChatGPT session/account handling entirely in memory; tokens are never stored or included in exports.
- Added safe fallback to DOM extraction when ChatGPT metadata is unavailable.
- Reworked scroll-container detection for Claude, Gemini, and DOM fallbacks using active movement probes instead of CSS overflow heuristics alone.
- Preserved Stop/cancellation behavior for metadata requests and DOM scans.
- Added clearer combined diagnostics when both ChatGPT metadata and DOM fallbacks fail.

## 1.1.1

- Added support for ChatGPT's current grouped `[data-turn-key]` conversation renderer.
- Detects user prompts through `data-user-message-bubble`.
- Detects assistant responses through `data-conversation-role="assistant"` and agent-turn start markers.
- Keeps user and assistant content separate even when ChatGPT groups both under one turn key.
- Added grouped-renderer DOM diagnostics for faster future compatibility fixes.
- Kept the Claude and Gemini adapters unchanged from 1.1.0.

## 1.1.0

- Added resilient ChatGPT detection for both role-based and current `data-turn` / conversation-turn DOM variants.
- Expanded Claude and Gemini selector fallbacks for provider UI rollouts.
- Moved printing to an extension-origin print page, avoiding site popup blockers and inherited Trusted Types/CSP restrictions.
- Removed Trusted Types-sensitive HTML parsing/writing from the page content script.
- Added chunked print transfer so long conversations and embedded images do not depend on one large extension message.
- Added version-aware content-script reconnect after extension updates.
- Removed newer `Array.prototype.at()` and `:has()` dependencies from the scanner path for wider Chromium compatibility.
- Added DOM diagnostics to message-detection failures.

## 1.0.0 - 2026-09-24

Initial public release.

- Export full conversations from ChatGPT, Claude, and Gemini
- Long-chat scanning with stop and stall recovery
- Multilingual RTL/LTR PDF layout
- Images and detected attachment handling
- Comfortable and Compact reading density
- Light, Graphite, and Dark popup themes
- Local preference storage
