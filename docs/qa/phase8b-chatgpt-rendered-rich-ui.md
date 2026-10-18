# Phase 8B — rendered ChatGPT Rich UI in API-backed full-conversation exports

Issue observed in an actual 72-turn ChatGPT PDF: the metadata extraction
successfully exported the whole selected conversation, but serialized some
assistant Rich UI / DIL component source (e.g. `<grid>`, `<box>`) as
literal text rather than the formatted table visible in ChatGPT. This is
**not an RTL-language problem**; a separate RTL-view extension only changes
the visual direction of the live page.

## Conservative hybrid approach

- Preserve authenticated ChatGPT conversation metadata as the source of
  branch choice, message identity, message count and order. Never replace it
  with a partial DOM scan.
- Where the complete mounted DOM has identical role sequence and multiple
  corresponding exact user-text anchors, associate assistant nodes by order.
- If the browser virtualizes part of the conversation, associate only
  a unique exact user message and its next assistant inside the same
  `[data-turn-key]` group. Repeated generic prompts are ambiguous and skipped.
- Reuse the existing detached `serializeTurn()` print serializer to capture
  already rendered tables, anchor URLs, embedded images, RTL, and safety
  sanitization; the PDF renderer sanitizes again at the final trust boundary.
- If a UI response is missing, ambiguous, truncated, or serialization fails,
  keep the full metadata response. Do not silently drop a message or its
  API-authenticated media. Cancellation and source-navigation checks remain.
- The new regression uses a synthetic 2026-style ChatGPT grouped DOM and
  actually prints an A4 PDF in Chromium, checking selectable table text,
  a **clickable URL annotation** and embedded PNG. It also tests
  a partially mounted history, duplicate user prompts, wrong branch,
  and a response containing API-only media.

## Verified split-assistant duplication regression

The user's post-test 49-page PDF confirmed partial success: the newest
mounted response had clickable links and a rendered result layout, and the
two screenshots were embedded. But the API also yielded subsequent assistant
metadata segments from the same generation; one repeated the rendered final
answer with literal DIL markup in PDF pages 47-49.

To avoid silently dropping genuine messages, this repair removes **only**
later assistant metadata items that satisfy all of these requirements:
the preceding assistant in the same uninterrupted run was safely matched
to live DOM, the later item contains Rich UI source markup, contains no
API media, and at least 75% of two or more substantial natural-language
prose anchors are independently found in the previously rendered answer.
Distinct progress notes and unmatched content remain intact. This does
not promise perfect deduplication for every ChatGPT API format; unresolved
cases should remain in review rather than receiving a false QA pass.

## Follow-up: accurately match multi-part assistant replies

The next real 51-page PDF exposed a more specific issue: 19 user items and 66
assistant metadata items included several consecutive progress/final pieces,
while the 2026 grouped ChatGPT DOM mounts a single assembled assistant surface
per user turn. The original positional matcher attached that surface to the
first assistant after its user anchor, leaving the final rich response in raw
API form.

For a uniquely anchored user with *multiple* subsequent API assistants,
the candidate rich surface now requires a **unique** match against substantial
prose spans (at least two matches and 60% of available anchors) from ONE
assistant message in that same uninterrupted run. Other progress pieces are
kept in original order and with their original media; no contents from a
different branch are guessed. With ambiguous/missing anchors the full raw
metadata remains, rather than falsifying a match. A corresponding Chromium
regression tests a short user + two progress assistants + final rich answer.

This is a partial mitigation. It does not automatically re-render earlier
Rich UI widgets no longer mounted in the current browser, and it does not
justify deleting API messages merely because they look related. Real-provider
manual re-export and review remain required before merge.

## What is and is not fixed

This improves high-fidelity capture for Rich UI currently mounted in the
logged-in ChatGPT page. It cannot reconstruct a rich interactive widget
whose original rendered DOM is not mounted and whose metadata payload is
only a text representation. In that case, the original complete metadata
text remains available instead of being replaced with a guessed rendering.
PDF is inherently static: controls such as toggles and buttons cannot retain
their original click behavior.

Claude UI-footer leakage is a separate follow-up: first determine whether
`Claude works directly with your codebase` was authored response text or
Claude site chrome in the actual session. Do not globally delete specific
English phrases from user content without a verified provider DOM boundary.

## Release gate

This PR is a **targeted correctness fix**, not a release. Before claiming
`v1.9.0` stable, test the user's real long 72-message ChatGPT example
again, plus Claude's screenshot and Gemini's uploaded image, with the
exact updated commit. Verify actual visible widgets, at least two
real images uploaded to the current chat, and all message counts, and
inspect for missing text, false links or duplicates. Do not upload the
private original conversation to GitHub fixtures.

Keep Stable `v1.8.11` and existing Manifest permissions untouched.
