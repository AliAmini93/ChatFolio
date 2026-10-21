# ChatFolio v1.9.1 — release preparation (DRAFT)

This is a proposed narrowly scoped patch over the published ChatFolio v1.9.0 stable release. **This document and the PR are drafts; no v1.9.1 tag or public GitHub Release has been approved or created.**

## Primary fix — delayed ChatGPT assistant image previews (Issue #25)

When the ChatGPT interface initially shows a loading indicator instead of a response image, the extension can revisit a rich snapshot of the **same already identity-matched assistant** after the image becomes visible, with no more than two bounded upgrade captures. The replacement is refused if it would remove image tags from the previously retained snapshot. Small citation icons do not trigger this mechanism, and no new extension permissions, external image polling or private logs are added.

This change is based on [PR #27](https://github.com/AliAmini93/ChatFolio/pull/27), merged to main as `0b030bac83104c24c6d1efd518a026f6c5bb09fa`. Stable v1.9.0 itself was not modified.

## Validation available before the version bump

- GitHub Actions and isolated Ubuntu QA: **85/85 Node tests and 39/39 real Chromium fixtures** passed on the exact implementation SHA `9190bc623ccbf20303c449cb8f514caf3f95e301`. Bundle, syntax, deterministic ZIP gate passed.
- Three foreground, real ChatGPT runs of the **same 122-message** conversation: **29/29** unique groups, **14** confident rich assistants, 100% group coverage. `scanImageRecaptures` was **4, 0 and 2** across the runs.
- All three private PDFs: **74 pages, 57 clickable links and 15 image appearances**; all image binary content and page numbers and hyperlink targets matched the known-good baseline. Some relative timestamp labels and text line/page wrapping vary across exports. Private PDFs and user media were never uploaded to GitHub.

## Known limitations and QA status

- ChatGPT must remain in the foreground during virtualized historical Rich UI capture. A backgrounded scan fails rather than silently exporting an incomplete conversation.
- Images that appear only after a virtualized group has completely unmounted, or remote resources unavailable in the print frame, are outside the narrow verified fix. Keep monitoring [issue #25](https://github.com/AliAmini93/ChatFolio/issues/25).
- The 22-case manual QA acceptance matrix covering ChatGPT, Claude and Gemini remains **incomplete**. Do not claim unrun tests passed.
- Raw UI representation for unmatched assistant messages is subject to previously disclosed API/DOM matching limitations; `apiRawRich` does not equal the count of confidently matched rich responses.

## Prior to any public v1.9.1 Release

1. Verify the **version-bumped** candidate commit on GitHub Actions and Ubuntu (unit tests, Chromium browser tests, release integrity, reproducible ZIP).
2. Inspect and record the final artifact size and **actual SHA-256**. Never reuse the v1.9.0 asset hash for the new patch.
3. Retain the explicit known limitations and obtain separate maintainer approval for any outstanding manual-QA release exceptions.
4. Only after those gates create an annotated `v1.9.1` tag and attach the exact verified `chatfolio-1.9.1-chrome.zip` asset. No user conversations, PDFs, images or authentication data may be included.
