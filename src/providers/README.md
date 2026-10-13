# Provider DOM adapters (phase 3 / step A)

The three production DOM adapters now live in separate, importable JavaScript modules:

- `chatgpt/dom-adapter.js`: grouped and legacy message surfaces, user/assistant role and stable identity.
- `claude/dom-adapter.js`: Claude message bodies, turn wrappers, and conversation titles.
- `gemini/dom-adapter.js`: Gemini conversation containers, query/response role and stable identity.

Each exports a `create*DomAdapter(context)` factory that satisfies the phase-2
`ProviderDomAdapter` contract. Context contains a small explicit allowlist of
shared DOM helpers; adapters do not import one another or the PDF renderer.

The on-demand Chrome MV3 content script is still a **single classic script**:
`src/content/main.js` is the authoritative controller source and
`scripts/bundle.mjs` deterministically inlines these three factories into the
committed generated `content.js`. The generator refuses unrecognized imports or
exports. The runtime and Chrome extension injection mechanism do not require
any new host permissions, dynamic imports, or persistent globals.

## Developer workflow

1. Edit `src/content/main.js` or one of the three DOM adapter modules.
2. Run `npm run bundle` to regenerate root `content.js`.
3. Run `npm run check` to validate the generated artifact matches its sources.
4. Run `npm test` and `npm run build`. Check the generated `content.js` into Git.

**Never edit `content.js` by hand.** CI rejects stale generated assets. Tests
and distributable ZIP use the generated runtime, not a parallel implementation.

## Deliberately deferred to phase 3 / step B

- ChatGPT authenticated metadata/share/export transport and rich message parsing.
- Gemini's specialized full-conversation scrolling, media recovery and user-image handling.
- Common scanning/serialization/print rendering (phase 4 for media & renderer).

These remain in `src/content/main.js` until they can be migrated behind stable
provider-level boundaries without regressing full-chat coverage. Moving the
DOM adapters does **not** yet mean the entire 6,500-line controller was split.

## ChatGPT metadata parser — phase 3B1

The pure parsing and tree-ordering part of ChatGPT's data-first path now lives in
`chatgpt/metadata-parser.js`; these eight named ESM exports are embedded verbatim
as local declarations in `content.js` by `scripts/bundle.mjs` (see ADR 0003B1).
Run `npm run bundle`, then `npm run check` and `npm test` after modifications.
Authenticated fetches and the remaining scanner/network orchestration are still
in the main controller pending phase 3B2/3B3. Do not introduce network calls or
persistent access-token storage into the parser module.

## ChatGPT transport (Phase 3B2)

`chatgpt/transport.js` receives `fetchImpl`, URL origin, account resolver and
parsers as dependencies. Keep all ChatGPT session, conversation, public share,
legacy share and asset-download requests inside this factory. The classic MV3
content script receives the factory through the deterministic bundler; no
module imports execute inside injected `content.js`. The caller retains Stop,
progress, DOM scanning and rendering. See ADR 0003B2.
