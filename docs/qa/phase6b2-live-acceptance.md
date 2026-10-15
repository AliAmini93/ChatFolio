# Phase 6B2 — Live-provider PDF acceptance, performed locally

Status: **tooling implemented, live ChatGPT/Claude/Gemini acceptance NOT YET RUN**.
All previously successful checks (Phase 6B1: 83 Node, 26 browser) were on synthetic fixtures.
Stable published `v1.8.11` remains untouched.

## Purpose

Automated tests cannot authenticate to the user's browser or verify that the
providers actually exposed every turn, upload or equation. This phase introduces
a privacy-preserving local checklist and a results-only reporter. It never
requests browser credentials, reads logged-in profiles, contacts web servers,
prints raw PDF text or sends a PDF to the repository.

The reporter uses `scripts/qa_pdf_audit.py` for page/image/selectable-text
metrics, then requires **the operator's explicit source-vs-PDF inspection**.
An expected turn count is *not inferred* from PDF page count, and PDF image
object counts are only a heuristic (not a claim about attachment fidelity).

## Before testing

1. On your workstation, use the candidate code from PR #19 after it passes
   CI/local tests. Open `chrome://extensions`, enable Developer mode, and
   **Load unpacked** from the checkout root containing `manifest.json`.
   Temporarily disable any installed stable ChatFolio extension to avoid
   duplicated capture handlers.
2. Keep logged-in Chrome profiles and authentication entirely local. Never
   copy provider cookies, export tokens, chat text or screenshots into GitHub,
   public issues, chat messages, or test fixtures.
3. **Temporary Chat:** do not reload a still-open temporary conversation
   just to switch extension versions. Mark the scenario pending if it cannot
   be tested safely in the existing session.
4. Export a *real* conversation using ChatFolio and Save as PDF to a private
   location **outside the repository**. Count the actual visible/authored user
   and assistant turns in the source. Verify first/middle/last messages;
   branched conversations must count only the selected branch.
5. Open the PDF locally and visually compare those turns and any images,
   tables, equations, code, roles and page breaks against the original site.
   Only mark a check `pass` after this side-by-side comparison.

## Run a short real ChatGPT export

```bash
cd "$HOME/Downloads/ChatFolio"
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"

"$PY" scripts/qa_live_provider.py \
  --provider chatgpt --scenario short \
  --pdf "$HOME/Downloads/my-private-export.pdf" \
  --source-turns 20 \
  --check turns=pass --check layout=pass \
  --output .chatfolio-qa/chatgpt-short.json
```

Replace the example PDF path and turn count with real values. The commands
shown with `pass` are **examples of a completed inspection**, not preset
results to apply without checking. Omit any unchecked `--check` argument:
the corresponding gate then stays `not-checked`, and the verdict is
`pending` rather than falsely `pass`.

For a 100+ turn conversation on Claude, use `--provider claude --scenario long`;
required manual checks are `turns`, `layout` and `history`. For Gemini
with offscreen uploads, use `--provider gemini --scenario media`,
`--source-uploads N` and checks `turns`, `layout`, `uploads`.
For RTL, use `--scenario rtl` with `turns`, `layout`, `rtl`.
For rich math/tables, use `--scenario rich` with `turns`, `layout`,
`math`, `tables`. The other supported scenarios are `project`,
`share`, `virtualized`, `temporary`, `retry`, and `stop`.

The Stop test produces **no PDF** by design. After manually confirming that
Stop cancels work without presenting an incomplete export, record:

```bash
"$PY" scripts/qa_live_provider.py \
  --provider chatgpt --scenario stop --check stop=pass \
  --output .chatfolio-qa/chatgpt-stop.json
```

Exit codes: **0** = complete manual acceptance, **1** = failed acceptance,
**3** = pending/manual work incomplete, **2** = invalid input or unreadable PDF.

## What can be shared safely

Only share the report's aggregate numerical metrics, fixed check statuses,
verdict and non-sensitive error categories. The program never prints the
PDF filename, extracted content, links, screenshots, titles or file path.
Reports saved in `.chatfolio-qa/` are ignored by the repository's
`.gitignore`; keep original PDFs elsewhere and never run `git add -f`
on reports or private conversation files. `Previous Chats/` remains
excluded locally and is not read by the QA scripts.

## Release criteria

At minimum, complete the scenario matrix in
[phase6-real-provider-checklist.md](phase6-real-provider-checklist.md):
short/long/RTL/rich/media/abort for each provider, plus ChatGPT Project and
Temporary Chat, Claude attached images, and Gemini virtualized/offscreen
history. A manual check marked `fail` is a release blocker; `pending`
does not count as acceptance. Failures in completeness or upload fidelity
must be fixed before the final release candidate.

Phase 6B2 supplies **validation tools and an auditable gate**, not proof that
the live provider sessions have already passed. No version bump or release
publication is part of this PR.
