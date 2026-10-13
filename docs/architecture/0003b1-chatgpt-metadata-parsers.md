# ADR 0003B1: ChatGPT metadata parser boundary

Status: accepted as a deliberately narrow first step of phase 3B.

## Problem

`src/content/main.js` mixed parsing of authenticated ChatGPT conversation trees, public-share React Router hydration data, account JWT claims, network fetching, media rendering and DOM scanning. Parser regressions can silently truncate a shared conversation or choose the wrong assistant branch.

## Decision

Extract the eight existing ChatGPT metadata/ordering functions into `src/providers/chatgpt/metadata-parser.js` as individually importable ESM functions, and retain their names in the generated single-script MV3 runtime. This includes conversation/share URL route parsing, optional JWT claim interpretation, active-branch selection, share-node ordering, hydration TurboStream decoding (including deferred `P<number>:` patches), and discovery of a nested share object.

The compiler `scripts/bundle.mjs` embeds exactly the expected named exports into the existing content-script IIFE at `@chatfolio-chatgpt-metadata`, and fails if unexpected imports, exports or export ordering appear. There is no new runtime import, network call, permission, global, or build dependency. Only the URL helper gains a *defaulted* `href` parameter to make it testable without mutating browser globals; its no-argument runtime behavior is unchanged.

The network request/credentials, media mapping, asset URL resolution, actual ChatGPT/Claude/Gemini DOM scans, scroll recovery, and PDF rendering remain in the controller, unchanged in this PR. They will be separated in subsequent narrow phase-3B increments.

## Risks and safety controls

- Public-share hydration format is owned by ChatGPT, not ChatFolio, and can change without warning.
- The account ID JWT decoder must not log or persist access tokens; it remains an in-memory helper.
- Shared-page malformed or missing TurboStream must fail instead of silently emitting incomplete PDF.
- Node fixtures test ordering, cycles, missing data, deferred patches, nested share objects, account claims, and URL variants.
- A Chromium regression imports the **generated** `content.js` and exercises the helpers in the same IIFE.
- Existing provider DOM, scanner, media, and pagination regressions are CI merge gates.

## Follow-up

Phase 3B2: move authenticated/public-share **transport and orchestration** behind an explicitly injected API adapter, without storing credentials or changing fallback policy. Phase 3B3: isolate Gemini history loading and scanner recovery after dedicated real-chat and browser test fixtures. Phase 4: media and PDF renderer boundaries.

Do not change the stable v1.8.11 release for refactor-only commits.
