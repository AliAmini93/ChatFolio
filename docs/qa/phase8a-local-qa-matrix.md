# Phase 8A — private, fail-closed real-provider QA progress matrix

Status: **QA collection can begin on the experimental extension**; this is
not a claim of successful live ChatGPT, Claude or Gemini extraction.
The published stable v1.8.11 remains unchanged. No tag/release/version
bump occurs here.

## Why this exists

Phase 7B blocks an RC until all 22 provider/scenario combinations are
confirmed, but its original CLI reported only the first failing case. Use the
Phase 8A progress display to see *all* outstanding checks at once without
revealing any conversations.

## View the matrix

On your private Ubuntu computer:

```bash
cd "$HOME/Downloads/ChatFolio"
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"

"$PY" scripts/qa_matrix.py --qa-dir .chatfolio-qa

# Optional: machine-readable enum/status counts only
"$PY" scripts/qa_matrix.py --qa-dir .chatfolio-qa --json

# Strict mode: exit 3 until every required local report passes
"$PY" scripts/qa_matrix.py --qa-dir .chatfolio-qa --require-ready
```

The 22 cases are ChatGPT (short, long, rtl, rich, media, stop, project,
temporary, share), Claude (short, long, rtl, rich, media, stop), Gemini
(short, long, rtl, rich, media, stop, virtualized).

Every case is shown as PASS, PENDING, FAIL, INVALID or NOT-RUN. A report is
marked PASS **only if the same exact validator used by the RC gate** accepts
that report. The tool inspects only the fixed, expected local counts-only
JSON filenames. It never opens a PDF, copies cookies or browser state,
prints file paths or user data, or uploads anything to GitHub.

## Begin with one small, real ChatGPT conversation

1. Check out the experimental development commit and load the unpacked
   extension in `chrome://extensions`. Disable an earlier ChatFolio
   installation for the test, so two extensions do not capture the same
   conversation.
2. Open a *non-sensitive*, ordinary 10–20-turn ChatGPT conversation. Count
   the user and assistant turns in the currently selected branch. Use the
   extension to create the PDF; keep it **outside the Git repository**.
3. Open the PDF locally and compare the beginning, middle, end, every role,
   turn ordering and layout against the original conversation. Only mark a
   manual check PASS after verifying that behavior; otherwise leave the
   check omitted or mark FAIL.

```bash
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"
"$PY" scripts/qa_live_provider.py \
  --provider chatgpt --scenario short \
  --pdf "$HOME/Downloads/YOUR_REAL_EXPORT.pdf" \
  --source-turns YOUR_REAL_TURN_COUNT \
  --check turns=pass --check layout=pass \
  --output .chatfolio-qa/chatgpt-short.json

"$PY" scripts/qa_matrix.py --qa-dir .chatfolio-qa
```

Replace the example path and count with actual values. The `pass` flags
are **not automated proof** and must not be used unless the user has actually
compared the source with the output. A report can pass schema checks while
its human assertion is incorrect; this tool cannot independently access
logged-in provider sessions.

Repeat for the remaining scenarios with the full check names from
[Phase 6B2](phase6b2-live-acceptance.md). For Temporary Chat, never reload a
still-open ephemeral conversation just to run QA. If it cannot be tested
without losing the source, leave it NOT-RUN and do not approve release.
Image fidelity, missing turns and malformed equations are release blockers.

## Release gate and privacy

The progress matrix is an **overview**, not the release authorization. The
existing `scripts/rc_readiness.py` separately verifies version and the exact
approved source SHA, in addition to this same strict 22-report validator.
While manifest/package remain 1.8.11, an intended
`v1.9.0-rc.1` request must fail. Do not create release tags or run manual
RC preview actions until the genuine QA matrix has been completed and a
separate reviewed candidate-version update is available.

Keep `.chatfolio-qa/` and `Previous Chats/` out of GitHub. Never attach
private chat PDFs, screenshots, signed media URLs, browser tokens or cookies
to CI, public issues, or automated tests.
