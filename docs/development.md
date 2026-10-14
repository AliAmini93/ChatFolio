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

## Phase 3B3: Gemini history scanner

The source of truth for Gemini's lazy history loading, turn counting, message
capture and incomplete-export guard is now
`src/providers/gemini/history-scanner.js`. Do not reintroduce this logic into
`src/content/main.js`: it instantiates the injected factory while retaining
export session lifecycle, scroll restoration and printing. After editing,
run `npm run bundle && npm run check && npm test && npm run build`.
See [ADR 0003B3](architecture/0003b3-gemini-history-scanner.md).

On an Ubuntu workstation with Google Chrome installed, point Playwright at its
executable (e.g. `CHATFOLIO_CHROMIUM=/usr/bin/google-chrome-stable`) rather than
installing another Chromium. `scripts/test.py` uses the Python interpreter that
invokes it. For a custom pre-existing virtual environment, run
`"$PY" scripts/test.py` with `PY` set to that environment's `bin/python3`.
The CI requirements pin Pillow 11.3.0 so installing them does not introduce the
known `moviepy 2.2.1` vs Pillow 12.x incompatibility in a shared Python venv.

## Phase 4A: provider-neutral PDF document generation

The source of truth for A4 document HTML, page CSS, paragraph splitting,
message grouping and document-language direction is now
`src/renderer/pdf-document.js`. Modify that module, **not** generated
`content.js`, then run `npm run bundle && npm run check && npm run test:core`.
The one-export ESM factory is bundled into the classic MV3 script without
re-indenting its HTML/CSS template. Browser/PDF regression
`tests/test_pdf_renderer_phase4a.py` checks identical generated/ESM output
for ChatGPT/English, Gemini/Persian and Claude/image fixtures; run it with the
same Python/Chrome setup as existing tests. Media extraction and print delivery
have not moved yet. See [ADR 0004A](architecture/0004a-pdf-document-renderer.md).

## Phase 4B1: image pipeline

`src/media/image-pipeline.js` owns live attachment URL detection, bounded
image fetch-to-data conversion, and viewport screenshot fallbacks. The
content script injects its browser dependencies and remains classic MV3.
Keep the image and PDF regression fixtures green before changing its helpers.
See `docs/architecture/0004b1-image-pipeline.md`.

For Ubuntu's existing HCI venv and installed Google Chrome, run:

```sh
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"
CHATFOLIO_CHROMIUM=/usr/bin/google-chrome-stable "$PY" scripts/test.py
```

No Playwright-managed Chromium download is needed with this command.
