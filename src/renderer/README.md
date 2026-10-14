# Print renderer boundary

`pdf-document.js` is the only source of truth for HTML/A4 printable document
construction. It does not know the provider DOM, network endpoints or Chrome
extension APIs. It consumes serialized message HTML, a platform label and
options, plus injected helpers. Existing markup is preserved verbatim; do not
send unsanitized third-party content to this renderer.

The classic `content.js` is generated with `npm run bundle`. Run
`npm run bundle:check`, `npm run test:core` and the Chromium/PDF regressions
after modifying styles or message splitting. See
`docs/architecture/0004a-pdf-document-renderer.md`.
