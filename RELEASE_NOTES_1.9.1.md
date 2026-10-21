# ChatFolio v1.9.1 — Stable Release Notes (2026-10-21)

This is a narrowly scoped stable patch over ChatFolio v1.9.0. The maintainer approved its publication on **2026-10-21**, expressly accepting the outstanding cross-provider manual QA and unhandled image-hydration edge cases described below.

## Primary fix — delayed ChatGPT assistant image previews (Issue #25)

When the ChatGPT interface initially shows a loading indicator instead of a response image, the extension can revisit a rich snapshot of the **same already identity-matched assistant** after the image becomes visible, with no more than two bounded upgrade captures. The replacement is refused if it would remove image tags from the previously retained snapshot. Small citation icons do not trigger this mechanism, and no new extension permissions, external image polling or private logs are added.

This change is based on [PR #27](https://github.com/AliAmini93/ChatFolio/pull/27), merged to main as `0b030bac83104c24c6d1efd518a026f6c5bb09fa`. Stable v1.9.0 itself was not modified.

## Validation

- GitHub Actions and isolated Ubuntu QA: **85/85 Node tests and 39/39 real Chromium fixtures** passed on the exact implementation SHA `9190bc623ccbf20303c449cb8f514caf3f95e301`. Bundle, syntax, deterministic ZIP gate passed.
- Three foreground, real ChatGPT runs of the **same 122-message** conversation: **29/29** unique groups, **14** confident rich assistants, 100% group coverage. `scanImageRecaptures` was **4, 0 and 2** across the runs.
- All three private PDFs: **74 pages, 57 clickable links and 15 image appearances**; all image binary content and page numbers and hyperlink targets matched the known-good baseline. Some relative timestamp labels and text line/page wrapping vary across exports. Private PDFs and user media were never uploaded to GitHub.

## Known limitations and QA status

- ChatGPT must remain in the foreground during virtualized historical Rich UI capture. A backgrounded scan fails rather than silently exporting an incomplete conversation.
- Images that appear only after a virtualized group has completely unmounted, or remote resources unavailable in the print frame, are outside the narrow verified fix. Keep monitoring [issue #25](https://github.com/AliAmini93/ChatFolio/issues/25).
- The 22-case manual QA acceptance matrix covering ChatGPT, Claude and Gemini remains **incomplete**. Do not claim unrun tests passed.
- Raw UI representation for unmatched assistant messages is subject to previously disclosed API/DOM matching limitations; `apiRawRich` does not equal the count of confidently matched rich responses.

## Release verification and artifact

- Version-bumped release candidate `4a16eeb4a78ba2372ed850d2ec27620c21ecc31d`: GitHub Actions run `39574140240` and independent Ubuntu run both PASS (**85 Node unit tests, 39 Chromium browser tests**, bundle/check/build, reproducible 12-file ZIP).
- Approved distributable: `chatfolio-1.9.1-chrome.zip` — **116,068 bytes**.
- Approved SHA-256: `6f80980e7f32ab650965bc14f4d4c23b3e929f3806a4fdb2941e3bbefc5bccf2`.
- The final tagged source includes only documentation changes since the fully tested merged code. The publication workflow repeats validation and checks byte-identical ZIP hashes **before** creating the annotated tag or the GitHub Release.

## Installation

Download the ZIP asset from this official GitHub Release, verify the SHA-256 above, extract into a permanent folder and load it through Chrome `chrome://extensions` → Developer mode → Load unpacked. Disable duplicate older unpacked copies to avoid using the wrong version. Keep the source ChatGPT tab foreground during historical rich export.

## Accepted release exceptions

On **2026-10-21**, the maintainer explicitly authorized publishing Stable v1.9.1 with the uncompleted 22-scenario real-provider QA matrix and out-of-scope assistant preview hydration edge cases **clearly disclosed**. This does not turn unfinished tests into PASS and does not guarantee pixel-perfect archival output. No user conversations, PDFs, image content or authentication data are included in the repository or public ZIP.
