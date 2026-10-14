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
