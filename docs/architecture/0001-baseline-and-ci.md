# ADR 0001 — Protect the v1.8.11 runtime before restructuring

**Status:** Accepted for the first refactoring milestone.

## Context

The last user-validated release, `v1.8.11`, is packaged directly from
`content.js`, `background.js`, the popup, the print page, and four icon files.
The 13 synthetic Python/Playwright tests are standalone executable scripts;
previously they assumed Chromium at `/usr/bin/chromium`, and one test wrote a PDF
under `/mnt/data/`.

A complete rewrite before a reproducible baseline would risk regressions in
ChatGPT reverse scrolling, Claude/Gemini uploaded media, and print pagination.

## Decision

1. **No runtime changes in milestone 1.** Keep the current 12 packaged assets
   byte-identical to the source of the published `v1.8.11` release.
2. Use an explicit allowlist and deterministic ZIP metadata, so development
   files and private sample PDFs cannot slip into the installation package.
3. Add a dependency-free Node syntax/manifest check and a single Python runner
   for the existing browser tests, with per-test timeouts and correct exit codes.
4. Use a Playwright-managed Chromium installation on CI; allow local override
   with `CHATFOLIO_CHROMIUM` for users who already have Chromium installed.
5. Run checks and browser tests in GitHub Actions on PRs. Protect `main` after
   the first workflow succeeds; require the CI job before future merges.
6. Reserve provider-adapter extraction, renderer splitting, and a bundler for
   subsequent milestones. These require comparison tests against this baseline.

## Consequences

This adds automation and a safe packaging boundary but **does not fix** the
6,500-line monolith, media-cache bounds, print-job persistence, HTML
sanitization, or provider-specific brittle selectors. The existing tests use
synthetic DOM fixtures and must be complemented by manual smoke checks against
live provider sessions prior to any stable release.

A formatter/linter and esbuild migration should be added incrementally during
module extraction, with a committed dependency lockfile before being required
in CI. Formatting the current monolith in one PR would obscure functional diffs.
