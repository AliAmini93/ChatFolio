# ADR 0003B3 — Gemini history scanner isolation

Status: implemented in phase 3B3 (merge only after GitHub CI passes).

## Decision

`src/providers/gemini/history-scanner.js` owns Gemini's existing lazy-history
polling, structural turn counting, per-message identity/occurrence handling,
media-aware serialization sequence and incomplete-export safety checks. It
exports one `createGeminiHistoryScanner(context)` factory returning
`collectGeminiConversation`, `countGeminiConversationTurns` and
`findGeminiScrollContainer`. Its dependencies are explicit and injectable:
DOM reference, scrolling helpers, cancellation/navigation guards, message
selectors, serializer, media validator, clock, and progress callback.

The controller in `src/content/main.js` still selects the provider, restores
original scroll position/scroll CSS after the export, manages Stop, owns shared
media/PDF rendering, and chooses visual fallback. The existing 35-second
history load cutoff, 850-ms polling, 3 stable rounds and structural-message
completeness threshold are preserved; changing those parameters requires its
own behavior-specific tests and PR.

`scripts/bundle.mjs` embeds this tested ESM factory into the generated classic
`content.js` within the same isolated script scope. No new Chrome permissions,
remote calls, external dependencies or persistent data are introduced.

## Acceptance

- Node tests cover complete two-turn capture, media keys/counts, non-unique
  identity occurrences, structural turn mismatch, missing nodes, cancellation,
  navigation changes, scroller selection and history timeout.
- A Chromium test executes the **generated** content script and exercises the
  embedded Gemini factory with realistic `user-query`/`model-response` markup.
- All previous synthetic browser regressions, PDF layout tests and runtime
  packaging checks continue to pass. Real provider smoke testing is still
  required before a future public release.

## Remaining work

The shared scrollport discovery/probing and generic virtualized ChatGPT/Claude
scanner remain in the controller. Image capture and PDF layout belong to the
next media/renderer refactor. A scanner extraction alone does not guarantee
Gemini's live DOM will never change.
