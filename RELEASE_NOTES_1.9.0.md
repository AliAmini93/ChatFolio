# ChatFolio v1.9.0 — draft stable release notes

> Status: **Release preparation only**. No tag or public stable release has been published by this pull request. Stable version currently on GitHub is v1.8.11.

## Highlights

- Modular provider architecture and hardened data contracts for ChatGPT, Claude and Gemini, PDF renderer, media pipeline and sanitization.
- Bounded print-job transport, predictable build artifacts and release integrity checks.
- Long-conversation QA tooling and diagnostics that do not log private conversation text.
- Intended Phase 8D integration (PR #24): rehydrate confidently matched historical ChatGPT Rich UI even when the chat mounts only a handful of turns, preserve API turn ordering and attachments, and reject an incomplete rendered export when the browser tab becomes hidden during scanning.
- Phase 8D real-world benchmark on a 122-turn ChatGPT conversation: 29/29 groups scanned, 14 rich assistant responses rehydrated, 57 clickable PDF links, with matching time reduced from 13.3s to 2.4s on the latest candidate.

## Known limitations

- **Assistant preview image hydration (issue #25, planned for v1.9.1):** small images within ChatGPT assistant responses occasionally appear as loading indicators when exported. The same long conversation produced 11 or 15 raster appearances across runs. Some substantive images/attachments can be affected; inspect the output before treating it as an exact archival reproduction. Do **not** claim full image parity.
- **Tab visibility:** ChatGPT Rich UI scanning requires the source tab to remain visible. A hidden-tab attempt is stopped with an error instead of silently generating a degraded PDF. Automatic pause/resume is not available.
- **Manual provider QA:** synthetic automated tests do not prove all 22 live acceptance scenarios on ChatGPT, Claude and Gemini. Maintain an honest checklist of scenarios still awaiting manual validation.

## Release decision gates

1. PR #24 reviewed and merged to `main`; release preparation PR merged after it, with no unrelated changes.
2. Validate `manifest.json`, `package.json`, generated bundle and reproducible Chrome ZIP at an exact source commit.
3. Review local private live-provider QA records (22 scenarios) or record an **explicit owner-approved exception** without fabricating PASS results. No reports or PDFs uploaded to the public repository.
4. Confirm at least one foreground long ChatGPT export at 122 turns / 29 groups, and verify image and link limitations disclosed above.
5. Review release notes, permissions, privacy claims and assets; only then create annotated tag `v1.9.0` and publish the verified ZIP from that same commit.
6. Synchronize local Ubuntu checkout using `git pull --ff-only origin main`; verify its SHA, run `npm run bundle:check`, `npm run check`, `npm run test:core`, browser tests and `npm run build`. Do not commit private chats or `Previous Chats/`.

## Follow-up

Issue #25 targets v1.9.1 (not yet scheduled or shipped). The issue remains open until delayed-image previews are reliably captured in live-provider exports.
