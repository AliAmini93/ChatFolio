# ADR 0004A: Provider-neutral PDF document renderer

**Status:** Implemented; phase 4A, first of several phase-4 PRs. No release/version change.

## Motivation

The printable A4 layout, document-language detection, exchange grouping, role
badges, page-break policy and CSS were embedded in a 5,600-line content script
that also performs provider-specific DOM/network/image extraction. The renderer
should be a separate unit while preserving the already validated Gemini page
break and Claude/ChatGPT image behavior.

## Decision

- The source of truth for printable document construction is
  `src/renderer/pdf-document.js`. Its single ESM export,
  `createPdfDocumentRenderer({document, Node, Element, escapeHtml,
  mergeFontStacks, inferDirection})`, declares all external dependencies.
- The factory returns **only** `buildPrintableDocument`,
  `splitPrintableMessageOpening`, `groupMessagesIntoExchanges`, and
  `detectDocumentProfile` as a frozen object.
- The controller in `src/content/main.js` calls this factory once and keeps
  orchestration, font sampling, print delivery and user feedback.
- The existing narrow `scripts/bundle.mjs` generator inserts the module into
  the classic Manifest V3 `content.js`. The module MUST be embedded without
  automatic re-indentation because it contains a whitespace-sensitive HTML/CSS
  template literal. The generator validates exactly one export and no imports.
- All **971 lines** of the four legacy renderer functions were moved without
  changing their bodies or printable CSS rules. The remaining controller is
  shorter by 966 lines. Existing internal names stay available in the generated
  scope for compatibility with the regression fixtures.

## Safety and input contract

The renderer receives ordered, already-serialized `role`, `text`, `html`,
`imageCount` message objects. It **does not sanitize arbitrary HTML**. Provider
HTML and external asset handling remain in the extraction/media boundary; the
full sanitization review belongs to phase 5. No runtime permissions, network
requests or third-party runtime dependencies are added.

## Acceptance

1. `npm run bundle:check && npm run check && npm run test:core`.
2. `tests/test_pdf_renderer_phase4a.py`: compare the actual generated content
   renderer with its independent ESM factory using English, Persian/Gemini and
   an image-containing Claude fixture; require byte-identical HTML and readable
   A4 PDF with page counters.
3. Existing `tests/test_gemini_print_whitespace_191.py` verifies the long text
   opener does not reintroduce blank paper; all other browser fixtures pass.
4. `npm run build` includes the same 12 runtime files. `content.js` is a
   generated artifact, not an independent source of truth.
5. CI runs the complete test suite on the PR; do **not** merge a failed check.

## Deferred to phase 4B and beyond

Image discovery, protected-site screenshot fallback, blob/media embedding,
print-document delivery and font fetching remain in the controller. Migrate
these in separate PRs with real session smoke tests and no accidental changes
to Chrome MV3 security, service-worker lifetime or cancellation semantics.
