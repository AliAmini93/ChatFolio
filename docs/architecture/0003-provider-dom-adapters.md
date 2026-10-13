# ADR 0003: Extract live provider DOM adapters behind explicit factories

**Status:** Implemented (phase 3 / step A). **Stable baseline:** v1.8.11.

## Context

The previous `createPlatformAdapter()` mixed DOM detection for ChatGPT,
Claude and Gemini into the on-demand content script. The adapters were not
importable, hard to reason about independently, and tightly interleaved with
full-scan logic, print rendering and error handling.

## Decision

- Keep the existing runtime's classic MV3 injected IIFE and public message
  protocol. No permissions, injection flow, or temporary-chat reload behavior
  changes at this stage.
- Place DOM adapters into `src/providers/{chatgpt,claude,gemini}/dom-adapter.js`
  as ESM factory functions with an explicit helper dependency context.
- Keep the controller at `src/content/main.js`. Dispatch only by provider ID;
  no cross-provider query selectors in dispatcher.
- Temporarily use `scripts/bundle.mjs` to inline **exactly three** trusted,
  import-free modules into the IIFE; verify checked-in generated `content.js`
  is up to date during `npm run check` and `npm run build`.
- Apply `assertProviderDomAdapter` contract tests and a browser fixture for
  each provider that executes the **generated runtime**.
- Preserve the normalized conversation model introduced in ADR 0002. Adapter
  extraction does not yet move the metadata/scroll/media pipelines into that
  model and does not sanitize HTML.

## Why this transitional compiler?

The popup injects `content.js` with `chrome.scripting.executeScript({files:...})`
into its isolated context. Direct ESM imports would change Chrome content
script delivery and might require additional permissions or runtime web-accessible
resources. A narrow, deterministic inliner avoids that during sensitive provider
migration. It is **not** an extensible JavaScript bundler; when modules require
imports, switch to a version-pinned standard tool (e.g. esbuild) with lockfile
and reproducibility tests.

## Validation gates

- All 15 Node unit tests pass, including provider factory contracts.
- Existing synthetic browser regressions pass against committed `content.js`.
- New Chromium fixtures exercise role/turn detection for all three providers.
- The bundle-check step fails when a provider source differs from generated
  `content.js`.
- Chrome ZIP still contains only the 12 approved runtime assets.
- No user conversation fixtures, session keys, access tokens or personal media
  are stored in the public repository.

## Remaining work

This is **one independently reviewable PR**, not a declaration that all phase-3
work is finished. ChatGPT metadata extraction and Gemini deep-scroll/media
logic remain in the legacy controller. Step B must migrate them individually
with regression fixtures; future phase 4 will separate media and renderer.
