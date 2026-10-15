## Summary

What changes? Which provider, renderer, or background behavior is affected?

## Risk / privacy

- [ ] No private chats, screenshots, tokens, or logs are committed.
- [ ] New permissions/host permissions, if any, are justified.

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Verified the extension on affected live providers when applicable.

## Regression and release gates

- [ ] Added or updated a synthetic regression for the changed behavior.
- [ ] `python3 scripts/release_gate.py` succeeds after `npm run build`.
- [ ] The PR does **not** publish a release or modify Stable v1.8.11 unexpectedly.
- [ ] If claiming real-provider acceptance, cite a **counts-only local QA result**;
      live-session tests must not be marked passed when unperformed.
- [ ] Checked that `Previous Chats/`, `.chatfolio-qa/`, private PDFs,
      access tokens and provider cookies are absent from the diff.

## Release notes

Describe any user-facing change and whether this requires a new version.
