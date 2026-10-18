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
