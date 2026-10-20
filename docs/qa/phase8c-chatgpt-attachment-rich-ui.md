# Phase 8C: attachment-backed Rich UI identity matching

## Observed real-provider defect

In the user's 51-page ChatGPT export, a recent user message consisted
of two uploaded file cards (`.txt` and `.pdf`). The final assistant response
was in correct position but displayed DIL `<grid>` / `<box>` markup as text.
The prior Phase 8B hybrid extraction required an exact normalized user text
anchor; grouped attachment cards may contain UI labels and different line
breaks from API metadata, so that exact comparison can fail.

This PR adds **a narrowly-scoped fallback for multi-file user requests**.
It does not attempt to interpret/render DIL into HTML, and does not claim
that every earlier unmounted Rich UI response can be reconstructed.

## Identity, completeness and security requirements

A grouped, rendered assistant can overlay API metadata only when:

1. A user bubble lists **at least two distinct recognizable file names** in
   each representation (API text/HTML and mounted DOM user bubble).
2. Normalized filename-tail signatures are exactly equal and **unique** among
   all API user messages and all mounted DOM user bubbles. One generic filename
   or identical file pairs on different user messages are insufficient.
3. The mounted assistant follows the user **inside the same data-turn-key**
   wrapper. No adjacent-window inference from an unrelated conversation.
4. A single assistant inside the same consecutive API run is identified by
   at least **two substantial natural-language prose anchors** (at least
   60% of available anchors) that appear in the rendered assistant content.
5. Serialized HTML still passes the centralized Phase 5C sanitizer.
   API-only assistant media must not be replaced by the overlay.

If these requirements are unmet, the API content is preserved, along with
all original messages, images and order. No private attached files are read,
uploaded, logged or added to GitHub. Only **synthetic names** appear in tests.

## Test coverage and release conditions

`tests/test_chatgpt_attachment_rich_ui_phase8c.py` launches Chromium and
tests two file cards + split assistant progress/final replies, output from
the real PDF renderer (table and clickable link), mismatched file lists,
duplicate file-pair ambiguity, lone filename, unrelated assistant prose and
missing mounted answer.

A green CI means the guard operates on synthetic DOM, **not** that the
original 51-page user conversation passes all 22 production QA scenarios.
On Ubuntu, reload the unpacked extension from this draft branch, re-export
the current ChatGPT thread, and visually check the most recent card/table
responses, attached file captions, two screenshots, message order and links.
Only after direct real-PDF comparison may this PR be considered for merge.

Stable release `v1.8.11`, manifest/package version, permissions, tags and
the protected local `Previous Chats/` directory remain unchanged.

## Phase 8C2: pasted user logs, independently identified assistant reply

The follow-up 55-page / 99-message real export exposes a second case:
even the *recent* answer may appear as raw `<CodeBlock>` markup when the
preceding user message is an extensive copied terminal output. Existing
user identity matching requires almost-exact normalized user text and can
fail when the live bubble is truncated or substantially reformatted.

The additional fallback accepts a mounted assistant response only when:

- It belongs to an actual `[data-turn-key]` ChatGPT exchange with a user
  bubble. User content is removed before comparing assistant prose.
- At least **three different substantial prose anchors** from the API
  assistant appear in the mounted assistant response, covering at least
  **75%** of eligible candidate lines. Code, headings and short labels do
  not count.
- The match is **mutually unique**: precisely one API assistant and one
  visible assistant qualify. If an answer is repeated by either source,
  or is echoed only by the user, no overlay is permitted.
- API progress messages, original turn keys and image-bearing answers
  remain untouched unless the existing guards authorize a safe overlay.

The independent Chromium test
`tests/test_chatgpt_prose_identity_phase8c2.py` produces a PDF with a
real table and clickable link and tests ambiguous repeated assistant
answers, two matching mounted groups, assistant text echoed solely in
the user prompt, and absent/unrelated rendered content.

This is still a **guarded heuristic** and cannot regenerate Rich UI
for messages absent from the mounted browser DOM. Real-provider visual
validation of the affected latest replies is required before merging.

## Reality check after 8C2: not yet accepted

The 58-page real ChatGPT PDF on the updated code **does not** restore parity:
the same reply (#81) that rendered with actual screenshots and seven clickable
links in the previous 55-page output reverts to literal Rich UI source tags
in the new PDF. The new reply (#104) likewise contains literal `<CodeBlock>`.
The newer PDF has 104 numbered messages, but its page images/links decreased
from 6/7 (previous) to 4/0. This is a visual regression **in the observed
exports**, not proof that code is the sole cause: ChatGPT may virtualize or
unmount the relevant DOM between exports.

No real conversation text, source URLs, filenames, screenshots or PDFs
are stored in GitHub; only anonymized counts above are documented.

### Diagnostic counters (temporary QA)

A single `ChatFolio Rich UI QA (counts only):` console message appears
after a metadata-based export. Its JSON object includes only integer counts:
`apiTurns`, `apiAssistants`, `apiRawRich`, `mountedTurns`,
`mountedAssistants`, `matchedAssistants`, `matchedRawRich`,
`enrichedAssistants`, `enrichedRawRich`, `skippedApiMedia`,
`skippedDisconnected`, `skippedShortLiveText`, `failedCapture`.

A low `mountedAssistants` count suggests virtualized/unavailable live DOM.
A low `matchedAssistants` count with mounted turns suggests alignment
failure. A high `matchedAssistants` but low `enrichedAssistants` count
suggests capture or truncation skip. None of these counts include content.

To collect: reload the unpacked extension and ChatGPT page, open the Chrome
DevTools **Console** on the ChatGPT tab, export normally with ChatFolio,
then filter for `ChatFolio Rich UI QA (counts only):` and copy **only** the
JSON counter object. Do not share other console output, storage or request
headers. An absent summary may mean the DOM-only or visual-backup export
path was used.

PR remains Draft: do not merge or publish a stable release until a real
PDF again shows the last relevant reply with a rendered link/table/code
block, preserves prior images/links, and does not lose any message.

## Phase 8D: bounded virtualized DOM traversal (experimental)

The real numerical browser report was:

```json
{"apiTurns":112,"apiAssistants":86,"apiRawRich":36,
 "mountedTurns":6,"mountedAssistants":4,
 "matchedAssistants":1,"enrichedAssistants":1,"failedCapture":0}
```

This confirms that the immediate DOM cannot supply rich HTML for the
majority of the full metadata-backed conversation. Earlier matching
heuristics alone cannot solve this availability problem.

For ChatGPT metadata exports, the code now first captures the currently
mounted responses and, **only when raw Rich UI exists and the DOM is
partial**, probes for a scroller linked to authored conversation turns.
It performs a bounded traversal from the start of the conversation,
serializing safely matched assistant DOM snapshots *before* the browser
unmounts them. It uses the original API ordering and message identities,
applies snapshots only to their independently matched indexes, and finally
restores the original scroll position, scroll anchoring, snapping and
behavior. Other providers, private chat content and manifest permissions
are unchanged.

The traversal is capped at 72 scroll steps and 35 seconds; it can recover
many but not necessarily all historical Rich UI surfaces. A missing real
scrollport or ambiguous user/assistant identity falls back to complete
API text rather than inventing links/images or dropping messages. Stop
and navigation cancellation continue to apply. Full fidelity cannot be
asserted when ChatGPT no longer mounts the original Rich UI or exposes
only raw component source.

A new Chromium regression mounts only two of nine turns at a time
and checks that all nine rendered tables and clickable PDF links are
recovered in a real PDF, preserving 18 API turns, their order and the
original scroll position. Numeric-only QA diagnostics now include
`scanWindows` and `scanRestored`.

**Real-provider acceptance is still required** before merging. Repeat
an export of the user's 112-turn example, send only numeric console
counters, and compare recent and older formatted replies and embedded
images/links. No private chat, PDF or browser profile is committed.

## Phase 8D follow-up: live 119-turn PDF (partial success)

Real Ubuntu test at `ab33bc5`: 83 Node / 34 Chromium / release gate
all passed. User Chrome diagnostic (numbers only):

```json
{"apiTurns":119,"apiAssistants":91,"apiRawRich":38,
 "mountedTurns":10,"mountedAssistants":6,
 "matchedAssistants":5,"matchedRawRich":5,
 "enrichedAssistants":5,"enrichedRawRich":5,"failedCapture":0,
 "scanWindows":6,"scanRestored":true}
```

Actual 71-page PDF has 119 consecutively numbered messages, 12 PDF
link annotations and 10 PDF image occurrences, compared with 104 messages,
0 links and 4 image occurrences in the 58-page earlier export. The latest
answer contains a formatted table/code block; older pages still show
literal layout tags. The improvement is verified, but parity **is not**:
five assistant segments enriched out of 38 with raw Rich UI indicators.
Some raw tags are intentionally quoted inside code; the counters do
not prove that all other 33 are broken.

`scanWindows=6` counts capture calls, NOT unique virtualized pages;
alone it does not diagnose whether the scroller ended early, hydration
was delayed or content was never re-mounted.

### Delayed-history stabilization and counters

A fixed three-round ~600ms top wait could miss ChatGPT history
prepending after scroll-to-top. The scanner now waits for up to five
stable top frontiers with a bounded 12-round/7-second polling period.
It uses a smaller scroll step for denser viewport coverage while
retaining its 35-second/72-step movement limit and original scroll
restoration. Additional privacy-safe fields:
`scanSteps`, `scanTopWaitRounds`, `scanMaxMountedTurns`,
`scanStopReason` (a fixed diagnostic enum). No message content,
file names or URLs are logged.

The Chromium virtual scroll regression now intentionally defers
mounting the first two authored groups by 850ms after the scanner
reaches the top; without stabilization, the first group is missed.
The test still demands all nine formatted responses, all PDF links
and original scroll position. A successful test is **not** a guarantee
of recovery of every historic real-provider widget.

Continue to block merge and stable release until the user's newer
real PDF passes both visual parity and the existing QA matrix.


## Phase 8D follow-up: 122-turn step-budget diagnostic (awaiting live retest)

The next real Ubuntu run at `cc7c876` passed 83 Node, 34 Chromium,
reproducible ZIP and release gate. The actual 122-message console counters
reported `enrichedRawRich=9` (previously 5), `scanSteps=72`,
`scanWindows=80`, `scanStopReason=step-budget`, `scanRestored=true`,
and `failedCapture=0`. The step cap was exhausted; that **does not**
prove that every remaining raw Rich UI indicator is renderable or that
matching is correct. This is a private real-user diagnostic, not a pass.

In this bounded follow-up, increase the maximum traversal from 72 steps
and 35 seconds to 180 steps and 90 seconds, retaining the small overlapping
viewport stride, cancellation checks, identity matching, serialization
safeguards and scroll/style restoration. Add privacy-safe, numeric-only
`scanDistinctGroups` (mounted turn-group IDs counted in memory but never
logged) and `scanProgressPct` (final scroller position before restoring).
A new 50-group virtualized fixture requires more than 72 traversal steps,
validates every formatted table and PDF link, and checks restoration.

**Do not merge or release yet.** Retest the same live conversation on the
exact new SHA; inspect a fresh PDF and counters. If scan reaches near 100%
but fewer rich responses are restored, investigate matching/availability
rather than raising budgets again. Source content and private QA outputs
must not enter the repository.


## Phase 8D live regression, 19 October 2026: revert eager signature precomputation

Ubuntu `1ae795a`: 122 API turns, 39 raw-rich indicators, 9 observed
assistant groups, 5 matched/enriched, 4 unmatched, 36 scanned windows,
31 steps, 21% scroll progress, `scanStopReason=time-budget`.
Matching consumed 86,640 ms of 99,340 ms total; serialization took
118 ms. The previous live `deb706b` build traversed all 29 groups,
reached 100%, and enriched 14 raw-rich responses, with 13,441 ms spent
in matching across 158 windows.

The new eager `apiSignatures = apiMessages.map(...)` implementation
re-scanned every API user attachment body once per mounted viewport even
when no candidate needed its signature. That regression is suspected,
not yet conclusively profiled. Restore the prior, live-validated
fail-closed assistant-prose matcher while keeping counts-only group
coverage diagnostics. Record `scanMaxMatchingMs` per capture to locate
outliers. A passing synthetic CI test is not proof of performance on a
real virtualized 122-turn conversation.

Before merging PR #24, run the exact new commit locally; export the same
long conversation; compare message numbering, embedded images, clickable
links and rendered rich components against the known-good `deb706b`
PDF. Never upload private conversations, URLs, filenames or PDF bodies
to the public repository. No release or version bump.


## 19 October 2026: scroll geometry is not conversation coverage

Ubuntu `f2e55bc` passed 83 Node and 36 Chromium tests, yet its
122-message live ChatGPT export enriched 3 of 39 raw-rich metadata flags.
Its scan visited only 7 distinct mounted groups (against 29 API user
turns), terminated `at-scroll-limit` after 6 steps, and printed
`scanProgressPct=100`; matching time was only 2,097ms. Thus the 100%
figure only measured the selected scroller's geometric range, not complete
virtualized history coverage. Private output: 71 pages, 12 clickable
links, 10 raster images; do not store personal content in the repo.

Add `apiUserTurns`, `scanUserGroupCoveragePct`,
`scanFrontierChanges`, and initial/final scroller ranges as numeric-only
diagnostics. Once at a geometric scroll limit with fewer unique mounted
groups than API user turns, allow one bounded return-to-top rescan,
then report `incomplete-group-coverage` rather than `at-scroll-limit`
if the deficit remains. This does **not** prove the root cause; selecting
a wrong nested scrollport or delayed provider remount are live hypotheses.
A non-remounting synthetic scrollport must reproduce this result without
silently claiming complete scanning. It may still export the complete API
text, but visual-rich parity is unverified. Do not release or merge until
same-thread PDF visually matches the known-good baseline.

 
## Phase 8D: active-tab capture invariant and bounded filename matcher

Real-provider controlled A/B with the same private 122-message thread on
`7545d98`: keeping ChatGPT foreground gave 29/29 mounted group coverage,
14 rich snapshots, 54.6s, and a 74-page PDF with 57 clickable links and
15 raster image appearances. A prior background-tab export saw only
7/29 groups, took 202s and produced a deficient 71-page PDF (12 links,
8 images). This supports background throttling/hydration as a contributor,
not proof that every timing outlier has the same cause.

The fallback filename matcher previously used a greedy variable-length
regex that rescanned large dot-heavy logs at quadratic cost. Replace it
with a bounded extension-first scan and lazily cached signatures in a
single DOM matching window; retain two-file identity and unique API/DOM
guards without guessing by position.

When the ChatGPT tab becomes hidden during the rendered-DOM phase, mark
`scanTabBackgrounded=true`, stop with `scanStopReason=tab-backgrounded`
and a clear retry error instead of silently handing the user an incomplete
PDF. Preserve cancellation and scroll/style restoration. This first
fail-closed protection intentionally does not auto-resume a stale virtual
DOM scan when switching back. A future safe resumable workflow may be
developed separately. Users must keep the tab visible until completion.

**No merge / v1.9.0 release** until real Chrome behavior and PDF parity
are reconfirmed against the private foreground baseline. Never upload
private conversation content into the public repository.
