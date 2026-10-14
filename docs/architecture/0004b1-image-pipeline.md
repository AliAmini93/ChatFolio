# ADR 0004B1: Extract live image capture and embedding

**Status:** Accepted for phase 4B1. **Stable public version:** 1.8.11 unchanged.

## Motivation

Live AI chat image assets are not equivalent to downloaded files. A user-uploaded
Claude or Gemini thumbnail may only be displayed after virtualized scrolling;
its authenticated image URL can reject both page and extension fetch (CORS).
The existing successful fallback uses the *source tab*, temporarily scrolls to
that image, requests one visible-tab screenshot, crops its rectangle, and
restores all ancestor/document scroll coordinates. A refactor must not reorder
this flow, leak inaccessible URLs into exported user-message PDF HTML, or treat
a broken image as an attached screenshot.

## Decision

Extract **the existing bodies** of `bestLiveImageUrl()` through
`appendProviderUserImages()` plus `sourceToDataUrl()` and `blobToDataUrl()`
into `src/media/image-pipeline.js`. The factory receives a small explicit
context: platform identity, document/window/getComputedStyle, absolute URL
resolver, runtime messaging, screenshot image loader, abort/sleep utilities,
Fetch and FileReader. It returns the same functions to the controller as local
bindings. The generator inserts the single ESM factory into a classic MV3 IIFE
without changing manifest permissions.

No changes are made to `serializeTurn`, media classification, CSS, PDF renderer,
background capture, signed ChatGPT asset transport, or the public release tag.

## Verification

- Unit tests mock network and FileReader without accessing private chats.
- Generated-runtime Chromium smoke covers Claude/Gemini Data URL paths.
- Existing Chromium fixtures cover off-screen protected Gemini upload,
  CORS screenshot fallback for Claude/Gemini, sibling attachments, scroll
  restoration, uploaded-image integrity, and PDF printing.
- GitHub Actions CI must pass the **complete** browser suite before merge.
- ZIP still has exactly 12 runtime artifacts and `bundle:check` must pass.

## Follow-up

The remaining media work can isolate response-media classification and
`serializeTurn`'s clone/canvas/media traversal separately, without widening
the scope of this compatibility-preserving PR. More complete end-to-end tests
with live provider DOM should be performed before the next stable release.
