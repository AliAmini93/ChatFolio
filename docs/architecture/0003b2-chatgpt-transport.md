# ADR 0003B2 — ChatGPT same-origin transport isolation

Status: implemented as Phase 3B2; merged only after CI. Stable extension version stays `1.8.11`.

## Decision

`src/providers/chatgpt/transport.js` contains the network operations previously
embedded in `src/content/main.js`. The controller creates one transport instance
per injected content-script context with an injected `fetchImpl`, origin resolver,
account ID resolver, public-share parser, asset pointer parser, and cancellation
error factory. The helper is a normal ESM module for tests and is embedded as a
classic-script factory in generated `content.js` by `scripts/bundle.mjs`.

The transport handles:

- Session read (strict for authenticated conversations; graceful optional headers for shares).
- Conversation JSON retrieval with account, project, and target route headers.
- Public share page retrieval: first use loaded hydration, otherwise anonymous
  HTML GET, then cookie-bearing HTML GET, then the controller's legacy JSON fallback.
- Legacy public share JSON retrieval with optional credentials.
- ChatGPT file-service/sediment download URL resolution and per-session promise cache.

**The controller still owns** scan selection, progress reporting, Stop semantics,
branch/route parsing, rendering, text extraction, non-ChatGPT media fetching,
scrolling, PDF and error fallback. This is **not** a network permission change or
an endpoint upgrade. No sensitive access token is persisted, logged or placed in a
URL by the module. Network fixtures do not contain real user data or secrets.

## Compatibility and acceptance

1. Preserve the original endpoint paths, `credentials`, cache modes, request
   headers, public-share retry order and abort propagation.
2. Preserve user-visible error semantics for HTTP failures and incomplete shares;
   keep temporary ChatGPT chats on the existing DOM scanner path.
3. Test the ESM factory with mocked `fetchImpl`, and validate the **generated**
   runtime factory inside Chromium.
4. Keep `npm run bundle:check`, `npm run check`, 35 Node cases and 16 browser
   fixtures passing before merge. A live service smoke test remains a separate
   release acceptance step, not simulated by CI.

## Follow-up

Provider-specific DOM/history scanner state is still inside `main.js`. Phase
3B3 may isolate Gemini history and scrolling incrementally. Shared renderer,
PDF layout and universal image embedding belong to Phase 4.
