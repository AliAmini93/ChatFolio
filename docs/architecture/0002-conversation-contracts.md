# ADR 0002: Provider-neutral conversation model and boundaries

Status: accepted for phase 2, **not yet activated in the MV3 production runtime**.
Baseline: v1.8.11 (phase 1 CI and reproducible ZIP); keep stable 1.8.11 unchanged.

## Existing system we must preserve

`content.js` still performs ChatGPT/Claude/Gemini detection and DOM traversal, ChatGPT
metadata extraction, serialization, image embedding, pagination and print transfer.
The shared renderer consumes legacy objects shaped approximately as
`{key,role,html,text,imageCount,turnIndex,discoveryOrder}`. The `turnIndex`
field can contain `NaN`, which is not valid JSON. We must not silently lose this.

## Contract definitions

- `src/core/provider-registry.js`: exact provider hostname dispatch; no DOM.
- `src/core/contracts.js`: runtime checks and JSDoc contracts for provider
  DOM adapters and the future independent renderer. Missing required functions
  produce explicit `ContractError`s.
- `src/core/conversation.js`: JSON-safe schema v1. A conversation has provider,
  title and ordered messages. Each message has stable ID, role (`user` or
  `assistant`), monotonically indexed order, plain text, content blocks,
  imageCount and optional source identity metadata.
- Typed content blocks: `text`, `image`, `attachment`; transitional
  `legacy-html` preserves the existing sanitized HTML exactly while the
  renderer is still monolithic.
- `fromLegacyConversation` / `toLegacyMessages` form a verified compatibility
  bridge for legacy renderer-required fields. They refuse duplicate IDs,
  unknown roles, unknown versions, malformed content and structured blocks
  that the old HTML renderer cannot accept.

## Trust boundary

No HTML is sanitized by `createConversation` or `fromLegacyConversation`.
Legacy HTML **must be sanitized at the existing serialization boundary**;
never feed raw provider HTML directly to the renderer. Introduce an explicit
sanitizer in the media/renderer migration before activating the new pipeline.
External image URLs are not proof of embedded/offline media; embeddings require
separate verification. Browser/extension tokens never belong in the model.

## Responsibilities and future modules

| Boundary | Inputs | Outputs | Must not know |
|---|---|---|---|
| Provider adapter | Host DOM/API, abort signal | Authored turns / media refs | PDF CSS |
| Scanner | Provider adapter and session | Ordered message snapshots | Renderer |
| Conversation normalization | Legacy messages / structured content | Versioned schema v1 | Host DOM |
| Media processing | Image/attachment refs, abort signal | Resolved media blocks | Provider selectors |
| Renderer | Canonical messages, print options | Printable document | Provider DOM / tokens |
| Background print transfer | Print document + session | Print job state | Provider internals |

## Incremental migration gates

1. **Phase 2 (this PR)**: introduce neutral contracts and direct Node unit tests;
   do not change any bundled runtime files. Keep the 13 browser tests green.
2. **Phase 3**: extract each adapter one at a time, retaining the compatibility
   bridge; compare ordered legacy messages and media counts with fixtures.
3. **Phase 4**: separate media and renderer; switch renderer input to canonical
   content blocks after adding sanitizer and offline-media checks.
4. Migrate build to bundled modules only after equivalence tests and all three
   provider smoke tests; the extension's MV3 on-demand injection must remain valid.

## CI expectations

`npm run test:core` runs contract tests without Chromium. `npm test` runs both
core tests and the existing 13 browser fixtures. `npm run build` still produces
exactly the same 12 v1.8.11 runtime files, unchanged at byte level.
