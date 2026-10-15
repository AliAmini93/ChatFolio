# Phase 6 — Real-provider and browser QA matrix

Status: **not yet verified on live provider sessions**. This is a release acceptance checklist, not a record of completed tests. The v1.8.11 published release remains unchanged during development.

## Automated tests: what they prove

- `npm run test:core`: isolated provider contracts, media pipeline, renderer, sanitizer and print-transfer logic.
- `CHATFOLIO_CHROMIUM=/usr/bin/google-chrome-stable "$PY" scripts/test.py`: synthetic Chromium DOM/PDF regressions, including the Phase 6A real-MV3 test (`tests/test_mv3_extension_phase6a.py`).
- Phase 6A starts a **disposable Chromium profile**, loads the **actual unpacked extension**, obtains its real Manifest V3 background worker, sends a synthetic printable document using unmocked `chrome.runtime.sendMessage`, and verifies a real print tab/iframe. This specifically detects wiring and permissions bugs missed by manually mocked `background.js` tests. It does **not** authenticate to or scrape a real provider.
- `npm run bundle:check && npm run check && npm run build` confirm deterministic packaging; keep the release tag and version untouched until final approval.

## Live acceptance checklist (manual; never upload private chats)

For **each** provider (ChatGPT, Claude, Gemini), test on the user's own browser profile using the experimental extension loaded separately from the stable version:

| Case | Expected observation | ChatGPT | Claude | Gemini |
|---|---|---|---|---|
| Ordinary short conversation (10–20 turns) | All authored turns, right roles and ordering, searchable PDF | Not run | Not run | Not run |
| Longer conversation (100+ turns where available) | Earliest/middle/final turns preserved; no duplicated turns; count matches visible/source sequence | Not run | Not run | Not run |
| RTL/Persian mixed with code/English | Correct right-to-left paragraphs, left-to-right code and stable numbering | Not run | Not run | Not run |
| Tables, equations and links | All rows, complete KaTeX/MathML, valid citations and URLs | Not run | Not run | Not run |
| Screenshots and uploaded media | Real attachments embedded and aligned; missing uploads reported, not silently omitted | Not run | Not run | Not run |
| Abort while scanning | Stop stops work; no partial PDF silently presented | Not run | Not run | Not run |
| Retry after an interrupted print transfer | No duplicate preview; job completed or explicit actionable error | Not run | Not run | Not run |

### Provider-specific cases

- **ChatGPT:** ordinary and Project conversation; selected branch (not sibling answers); public-share route; Temporary Chat without automatic tab reload; data-first route or verified DOM fallback.
- **Claude:** long authored response, table/code, image embedded inside the authored turn and image attached as a sibling.
- **Gemini:** virtualized history, duplicate compact user prompt cleanup, offscreen protected `googleusercontent.com` photo capture/restore, long reply pagination without blank half-pages.
- **All:** browser print output on multiple pages: readable A4 text, page counter order, sensible breaking at figures/tables, no orphan author label, no provider toolbar or action buttons.

## Recording results

Capture only **non-sensitive metadata** (browser build, OS, extension commit SHA, provider, scenario, approximate turn count, PDF page count, pass/fail, redacted issue description). Never commit, upload or paste conversation text, screenshots, generated PDFs or signed media URLs. Preserve the local `Previous Chats/` folder outside Git. Do not copy logged-in browser profiles or cookies to CI.

### Release gate

Do not call the refactor production-ready based on green unit/browser synthetic fixtures alone. Before `v1.9.0-rc.1`, require passing CI at the candidate SHA, real-provider tests above, a clean Git diff/build and a documented decision for any remaining limitations. A failure in turn completeness or user-upload fidelity is release-blocking.