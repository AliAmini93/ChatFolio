# Media pipeline

`image-pipeline.js` exports one injectable factory, `createImagePipeline(context)`,
which provides image URL discovery, protected/off-screen image capture,
scroll-restoring screenshot fallback, Claude/Gemini sibling upload recovery,
and bounded image fetch / Blob conversion.

The MV3 content controller passes runtime/browser dependencies. The ESM module is
bundled by `scripts/bundle.mjs` into the classic isolated-world `content.js`;
there is no new runtime import, extension permission, or network endpoint.

**Important invariants**

- Preserve existing visible-tab capture and scroll restoration even on errors.
- Protect against exporting a broken-image icon as an uploaded attachment.
- Preserve Gemini's protected `googleusercontent.com` capture-first path and
  Claude's fetch-then-capture fallback.
- Do not send user images to a ChatFolio server.
- Abort propagates; ordinary per-image network failure yields an empty result.
- Limit ordinary fetch to 12 seconds and decoded image size to 12 MiB.

Current limits: core `serializeTurn()` coordination, print styling, general
canvas/media UI markup transformation, response-image classification, font
embedding, and print delivery remain in `src/content/main.js` or the Renderer.
Those can be moved in separate small PRs. The module itself is not a complete
media serializer and does not sanitize external HTML.

## Phase 4B2 — authored-turn media preparation

`turn-media.js` owns canvas-to-image conversion, source/clone image-pair embedding,
rendered-size and citation-logo classification, media-button retention, and
Gemini sibling attachment chips. Its factory is dependency-injected and is
embedded in the same MV3 classic content script as the existing `image-pipeline.js`.

`serializeTurn` remains responsible for the overall clone/sanitization sequence:
prune hidden subtrees, then canvas conversion, preserve authored content and
file wrappers, embed matched images, strip provider chrome, append sibling
user images, sanitize HTML and validate that no required upload is missing.
Do **not** move the image-pair pass before the attachment wrappers or move
provider cleanup before DOM source/clone pairing; that can lose or mismatch
uploaded media. Do not treat unreadable user canvases as successful uploads.

The media statistics returned by both factory methods are additive and preserve
`imageCount`, `embeddedImageCount`, `missingUserImages` and `mediaKeys` semantics.
Unit tests and Chromium's generated-runtime parity test enforce this contract.
