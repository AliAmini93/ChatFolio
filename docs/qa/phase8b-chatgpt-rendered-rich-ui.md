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
