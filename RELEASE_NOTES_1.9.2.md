# ChatFolio v1.9.2 — release preparation (DRAFT)

This patch integrates the previously merged fix for horizontally clipped RTL A4 PDF output when Chrome's native print Scale is not 100%. This is a **source version-bump candidate**, not an already published GitHub Release.

## User-visible changes

- Printed A4 pages use a stable left-to-right physical coordinate system, while Persian message content, headings and tables retain right-to-left layout.
- The original PDF issue could leave much of the paper blank and clip text outside the opposite page edge, particularly at an effective 67% print scale.
- A real private 311-page export now showed **0** off-page word rectangles, image placements, clickable link areas and drawing rectangles. Previously, 130 of 310 pages had off-page extracted words. As those two exports came from different conversation states, counts of messages/images/links should not be compared as proof of exact parity.
- The popup version is read at runtime from the extension Manifest; its number will display **v1.9.2** after the user loads/reloads this version.

## Verification recorded

- Implementation commit: `33b12a5ea1b279e1cce21002aa5d4ff6b27b21b6`, merged to `main` as `04f01f93895f3be84f2abc1e457b7e6b1de6243f` in [PR #30](https://github.com/AliAmini93/ChatFolio/pull/30).
- 85/85 unit tests, 40/40 Chromium browser tests, source/bundle checks and reproducible 12-file ZIP verified in CI and on Ubuntu for the implementation.
- Run the same gates on this exact **version-bumped** candidate before merging or tagging. The distributable will be named `chatfolio-1.9.2-chrome.zip`, with its own new SHA-256.

## Remaining limitations

- Keep ChatGPT visible while Rich UI scrolling/extraction proceeds; background capture fails safely rather than silently exporting an incomplete PDF.
- Assistant preview images that hydrate only after a virtualized turn unmounts, and remote resources unavailable to the print frame, remain outside the validated fix.
- The full 22-scenario manual cross-provider QA matrix is incomplete. Do not report those unexecuted cases as passed.
- Chrome native print Scale can still produce smaller text if set to 67%; the fix targets clipping, not the user's chosen font scale. For normal size select A4 and Scale 100%.

## Release decision

After CI and Ubuntu checks, obtain explicit maintainer approval before publishing an annotated `v1.9.2` tag and uploading the exact matching ZIP. Do not overwrite the existing stable v1.9.1 release or embed user data in the package.
