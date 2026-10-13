# Contributing

ChatFolio exports private conversations. Do not commit real chat content, PDF
archives, screenshots, access tokens, or unredacted browser logs. Use small
synthetic fixtures in tests instead.

1. Branch from `main` rather than committing directly to the stable release.
2. Describe the user-facing change and which provider(s) are affected.
3. Run `npm run check`, `npm test`, and `npm run build` as documented in
   [docs/development.md](docs/development.md).
4. Inspect the generated archive and confirm it does not include development
   artifacts or any conversation content.
5. For changes in provider selectors, print layout, or media handling, add a
   regression test and manually verify on live provider sites before release.
6. Submit a PR and wait for the CI job before merging.

The current architecture is transitional: see
[ADR 0001](docs/architecture/0001-baseline-and-ci.md). Do not bulk-format or
reorganize `content.js` without an equivalence test and a narrowly scoped PR.
