# Phase 7B — Manual, non-publishing Release Candidate preview

Status: tooling only. **No Git tag, GitHub Release, browser-store upload or
version bump is created by this phase.** Published Stable stays `v1.8.11`.
The desired `v1.9.0-rc.1` cannot pass version matching while the extension
manifest and package are still `1.8.11`.

## The two separate gates

**Local real-provider QA:** Run the Phase 6B2 tool against private PDF exports
from your logged-in ChatGPT, Claude and Gemini sessions. Compare every scenario
with the source. Store only counts-only JSON results in the ignored
`.chatfolio-qa/` directory. `scripts/rc_readiness.py` checks **22 required
provider/scenario files**, with explicit `pass` in every relevant human check,
the original turn count, PDF text metrics, and a nonempty upload count for each
media case.

The required scenarios are: ChatGPT (short, long, rtl, rich, media, stop,
project, temporary, share), Claude (short, long, rtl, rich, media, stop), and
Gemini (short, long, rtl, rich, media, stop, virtualized). Use the 6B2
instructions: [live acceptance guide](../qa/phase6b2-live-acceptance.md).
These checks have **not yet been run**. Do not create fake passing reports or
mark `pass` before comparing the original conversation and the local PDF.
Stop produces no PDF. Retain real PDFs outside the repository and offline.

When all checks really pass, preview the local gate with:

```bash
cd "$HOME/Downloads/ChatFolio"
SHA="$(git rev-parse HEAD)"
PY="/mnt/HDD/AliWorks/HCI Tagging Database/HCI/bin/python3"
"$PY" scripts/rc_readiness.py \
  --candidate-tag v1.9.0-rc.1 \
  --expected-sha "$SHA" \
  --qa-dir .chatfolio-qa
```

The example command will **intentionally fail** until a separate reviewed PR
updates both `manifest.json` and `package.json` to `1.9.0`, and all 22
local QA reports are completed. That version bump is **not** part of Phase 7B.
Failures print only fixed scenario names/error categories, never private text
or PDF paths.

**Manual CI RC preview:** Once the exact candidate commit is frozen, version
alignment and local QA are independently checked, a reviewer can run
`Actions > Manual RC Preview (no publication) > Run workflow`, select
`main`, enter the proposed `vX.Y.Z-rc.N`, the exact 40-character HEAD
SHA and explicitly check the human QA attestation box. The job:
- rejects any non-main ref or mismatched candidate SHA / semantic version;
- refuses a missing/false attestation;
- executes all unit and Chromium regressions with pinned tools;
- builds a reproducible 12-file ZIP and independently validates its hashes;
- uploads a 7-day Actions **preview artifact**, not a GitHub Release;
- runs with read-only `contents` permission and no publication token.

The CI attestation checkbox is **a human declaration**. Private QA reports
stay on the reviewer's machine; the workflow cannot independently verify
them. Human reviewers must check those local results *before* attesting.

## Stop conditions

Do not request a candidate preview when any required live-provider case is
`fail`, `pending` or `not-checked`, when the manifest version does not
match the proposed RC tag, or if the checked-out commit is not precisely the
reviewed candidate. ZIP hashes cannot substitute for source-vs-PDF QA.

GitHub main-branch protection and required reviews are controlled by
repository administrators; adding workflow files does not enable Rulesets.
A later, separately approved Phase 8 procedure decides **whether and when**
to create `v1.9.0-rc.1` and publish anything.

Never commit, copy or upload `Previous Chats/`, private PDFs, browser profiles,
tokens, cookies or the local `.chatfolio-qa/` reports.
