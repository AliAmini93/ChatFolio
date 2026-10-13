# Development and regression testing

## Requirements

- Node.js 22 or newer (for manifest and JavaScript syntax checks).
- Python 3.11+ and the pinned packages in `requirements-ci.txt`.
- Chromium via `python -m playwright install chromium`, or use an existing
  executable by setting `CHATFOLIO_CHROMIUM=/usr/bin/chromium`.

## Quick start

```bash
python3 -m pip install -r requirements-ci.txt
python3 -m playwright install chromium
npm run check
npm test
npm run build
```

`npm install` is **not required**: milestone 1 intentionally uses no JavaScript
runtime or developer dependencies. The manifest and executed code are unchanged
from the published v1.8.11 release. `npm run build` creates a reproducible
archive in the ignored `dist/` directory.

For an installed system Chromium, use:

```bash
CHATFOLIO_CHROMIUM=/usr/bin/chromium npm test
```

To run one regression while developing:

```bash
CHATFOLIO_CHROMIUM=/usr/bin/chromium python3 scripts/test.py --pattern test_gemini_offscreen_190.py
```

The runner finds every `tests/test_*.py` and checks the child process return
code; failed assertions and timeouts fail CI. Browser fixtures are synthetic
and no provider login or private chat export is used for CI.

## Package integrity

`scripts/build.py` takes only the explicitly listed 12 runtime files.
The builder validates the Chrome MV3 manifest, verifies each ZIP entry against
its source bytes, and uses fixed timestamps for reproducibility. Test outputs,
private PDF examples, local caches, and source-only developer files are not
included. The zipped bytes may differ from the historical release's ZIP because
its original timestamps differ; the **unzipped files must remain identical**.

## What this milestone does not include

The legacy `content.js` is still a single script. ESLint/Prettier, TypeScript,
and esbuild will be introduced with reviewed module-by-module refactoring,
rather than applying destructive automatic formatting to the entire legacy
codebase before the behavior baseline is secured.

## Phase-2 pure domain contracts

Contract models are introduced in `src/core` without changing the shipped
content script. Run `npm run test:core` for fast contract checks. Local
Linux environments with system Chromium rather than Playwright-managed Chromium
can use `CHATFOLIO_CHROMIUM=/usr/bin/chromium npm test`. See ADR 0002 for
compatibility and migration gates.

## Generated provider DOM adapters

The checked-in root `content.js` is generated from `src/content/main.js` and
three `src/providers/*/dom-adapter.js` ESM factories by `scripts/bundle.mjs`.
After changing these sources, run `npm run bundle && npm run check`.
The generator refuses unexpected imports/exports. Test the emitted classic
script with `CHATFOLIO_CHROMIUM=/usr/bin/chromium npm test` before committing.
See ADR 0003 for the temporary bundler rationale.

## Phase 3B1: ChatGPT conversation/share parsers

Edit `src/providers/chatgpt/metadata-parser.js` for ChatGPT route, JWT, active
branch, public-share ordering or React Router hydration parsing changes.
`src/content/main.js` has only the injection marker and continues to own fetch
and rendering orchestration. Rebuild using `npm run bundle`. The generated
`content.js` must be committed with the source changes; CI checks its freshness.
Run `npm run test:core` for `tests/unit/chatgpt-metadata.test.mjs` and the other
unit cases, and `npm test` for Chromium regressions. See ADR 0003B1.

## Phase 3B2: ChatGPT transport

ChatGPT network requests now live in `src/providers/chatgpt/transport.js`.
Use `npm run test:core` for mocked session, share, conversation and attachment
requests; run `npm test` for the generated content script and browser fixtures.
Run `npm run bundle && npm run check` after editing the module. See ADR 0003B2.

For an existing Ubuntu Python environment, activate its `bin/activate` script
before `npm test`; `scripts/test.py` runs each browser test with that same Python
interpreter (`sys.executable`). Set `CHATFOLIO_CHROMIUM=/usr/bin/chromium` if
Playwright-managed Chromium is not installed in that environment.
