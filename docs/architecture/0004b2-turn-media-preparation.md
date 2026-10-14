# ADR 0004B2 — Extract canvas, attachment and image-pair handling

Status: Implemented in Phase 4B2. No MV3 permission change, provider logic
change, new runtime dependencies or release bump.

## Context

After Phase 4B1, a substantial portion of authored-media preparation remained
inline in `serializeTurn` and in miscellaneous DOM helper functions in
`src/content/main.js`. In particular, canvas snapshotting, image classification,
per-image embedding/accounting, attachment-button preservation and Gemini sibling
file chips still shared the content controller's scope.

## Decision

Move these legacy function bodies into `src/media/turn-media.js`, exporting one
factory, `createTurnMediaProcessor(dependencies)`. Keep `serializeTurn` as the
sequence owner, preserving the order of clone, hidden-node pruning, canvas
conversion, authored media wrapper preservation, image-pair embedding, browser UI
cleanup, sibling capture, HTML sanitization and validation.

The public functions are:

- `embedTurnCanvases`: replaces canvases with image snapshots or a missing-image
  notice, returning counts; unreadable user canvases increase `missingUserImages`.
- `embedTurnImagePairs`: classifies live images, records display width and
  screenshots, embeds data URLs/fallbacks, and reports identical per-turn counts.
- `classifyImage`: distinguishes real screenshots/photos from source favicons.
- `preserveMediaAndAttachmentButtons`: unwraps media buttons and converts file
  buttons/chips into neutral attachments.
- `preserveGeminiSiblingAttachments`: captures non-image file/audio/video chips
  adjacent to Gemini user turns without copying the assistant's attachments.

`src/media/image-pipeline.js` remains responsible for live authenticated image
fetch, offscreen screenshot fallback and sibling photo recovery. HTML cleanup and
text/citation sanitization remain in the controller. The deterministic
`bundle.mjs` generates the same one-file classic MV3 script.

## Verification

- All original image/canvas/attachment processing bodies were moved without
  changing their branches. Only the count aggregation was extracted into return
  values. The order of side effects and per-4-image abort checkpoints remains.
- `tests/unit/turn-media.test.mjs` tests classification, tainted canvases,
  embedded vs remote image handling, count preservation, screenshot sizing and
  abort propagation.
- `tests/test_turn_media_phase4b2.py` runs six synthetic authored-turn fixtures
  against the generated classic runtime; optionally compare it byte-for-byte
  with the previous phase's output via `CHATFOLIO_BASELINE_CONTENT`.
- Existing image, Gemini, Claude, scroll and print regressions remain the merge
  gate in GitHub Actions. Local Chromium can stall under constrained environments;
  an incomplete run is never treated as a pass.

## Consequences / future work

This change creates a narrow seam for provider-specific media rules. It does not
introduce new image codecs, modify source sanitization or add an external
service. The shared `serializeTurn` orchestrator, font/typography capture and
print-delivery lifecycle remain separate refactor opportunities. Any new media
formats need explicit tests and a failure policy that does not silently accept
missing user uploads.
