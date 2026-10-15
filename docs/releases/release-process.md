# ChatFolio release process and GitHub quality controls

Status: **Phase 7A: repository controls and artifact verification only**.
Do not interpret the existence of this procedure as approval to ship 1.9.0.
Published Stable is still `v1.8.11`.

## One verification command

After installing the pinned Python dependencies and Playwright Chromium,
run the same baseline as CI:

```bash
npm run bundle:check
npm run check
npm run test:core
PY="/path/to/python3-with-playwright"
CHATFOLIO_CHROMIUM=/usr/bin/google-chrome-stable "$PY" scripts/test.py
npm run build
python3 scripts/release_gate.py
```

The release gate fails if `package.json` and `manifest.json` disagree,
the archive has extra or missing files, its contents differ from the source,
archive entry timestamps/permissions are unexpected, or two independently
built archives are not **byte-for-byte identical**. It verifies precisely the
12 runtime files enumerated in `scripts/build.py`. It does not read the
private `Previous Chats/` directory or create a release.

On Ubuntu, test true unpacked Manifest V3 loading with **unbranded**
Playwright Chromium (Google Chrome Stable 137+ cannot be used for the
extension side-load automation). Other fixtures may still use installed
Google Chrome.

## Manual GitHub settings to enable

A repository administrator should review **Settings > Rules > Rulesets**
(or the repository's branch protection controls, depending on GitHub UI):

1. Protect `main` from force pushes and accidental deletions.
2. Require Pull Requests before merging; prevent direct commits to `main`.
3. Require the verified CI job, currently named
   `Validate / Browser Regression / Package`, to pass on the PR head.
4. Optionally require at least one approving review when a qualified
   independent reviewer is available. Do not configure a required review
   that no one can provide, thereby blocking all work.
5. Require resolution of review threads if available.

**Adding this document does not modify GitHub settings.** Check and enable
these rules through the GitHub administrator UI with the appropriate access.
Keep the existing CI workflow as the source of truth for job naming.

## Release candidate workflow (Phase 7B / Phase 8)

1. Choose and freeze one candidate source SHA after approved PRs.
2. Record local real-provider pass/fail outcomes for ChatGPT, Claude and Gemini
   from [Phase 6B2](../qa/phase6b2-live-acceptance.md). Incomplete, branched,
   Temporary Chat, text RTL, attachments and images are release blockers if
   unchecked or failed. **Do not upload personal PDFs or logins**.
3. Version alignment: the Chrome Manifest version supports only numeric
   components (e.g. `1.9.0`); candidate tag names can have a suffix such as
   `v1.9.0-rc.1`. The numeric version in `package.json` and `manifest.json`
   must match. A release candidate must not silently replace stable release.
4. Verify the clean tree, bundle freshness, syntax, every unit/Chromium
   regression, real-extension MV3 smoke and deterministic ZIP safety gate at
   the frozen SHA. Review whether any permission or host access changed.
5. Manually inspect rendered PDFs against the original conversations and
   ensure the final ZIP includes only the exact documented runtime files.
6. Only then proceed to the separate, explicitly authorized candidate-tag
   and distribution procedure. **Phase 7A does not create a tag, publish a
   release, enable auto-release, or update Chrome Web Store.**

## Phase 7B: manual preview without publication

The [RC preview procedure](rc-preview.md) documents the strict
`scripts/rc_readiness.py` identity/QA gate, local-only 22-scenario
ChatGPT/Claude/Gemini report validation, and the **manual**
`.github/workflows/rc-preview.yml` workflow. That job can create a
short-lived, unpublished Actions artifact only; it **does not** create
tags, releases or browser-store uploads. A proposed `v1.9.0-rc.1`
cannot pass until the manifest and npm package both have version
`1.9.0` in a separately reviewed PR. The real-provider QA matrix
remains open until independently inspected in the local browser.

## What counts as release evidence

CI passing proves synthetic regression and artifact integrity only. The
real-provider acceptance table remains "Not run" until source-vs-PDF review
has been performed, and a `pending` result does not become a pass simply
because the PDF contains selectable text.

Do not commit the `.chatfolio-qa/` reports or the local
`Previous Chats/` directory, and never stage a private export or use
`git add -f` to bypass ignored paths.
