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
