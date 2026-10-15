# ADR 0005C1: Printable DOM sanitizer at the authored-turn boundary

Status: experimental, Phase 5C1. Stable v1.8.11 tag and release are untouched.

## Threat model
ChatFolio clones rich provider-authored turns for extension-local PDF printing. The copied subtree may contain event handlers, scripts, unsafe URL protocols, SVG external references, URL-bearing CSS and provider-specific/custom elements. Existing ad-hoc cleanup already removes common scripts/buttons and inline handlers but is not a central allowlisted boundary.

## Decision
Add `src/security/print-html.js` exporting `createPrintHtmlSanitizer({ document })`. The classic MV3 bundle embeds the factory through `scripts/bundle.mjs`. `serializeTurn` sanitizes the **detached** clone after all prior media, table, citation, typography and provider cleanup steps, immediately before serializing its `innerHTML`.

- Keep explicit HTML, SVG and MathML element allowlists; preserve authored text when unwrapping unsupported custom provider wrappers.
- Remove executable, embedded browsing, form and SVG animation/foreignObject subtrees.
- Keep only inert attributes; restrict anchors to HTTP(S)/mailto with noopener noreferrer. Images allow HTTP(S) and common image-only data MIME. SVG use/gradients reference only same-document `#ids`. Drop srcset, data URLs for HTML and all event handlers.
- Whitelist inline layout/typography CSS declarations, preserving KaTeX's internal positioning only; discard URL-bearing style values.
- Run entirely locally, preserve scientific equations, code highlighting, real hyperlinks, attachments, images and RTL markup. Do not alter the live provider DOM.

## Limits / follow-up
This step sanitizes **DOM-authored serialized turns**, not a completely general HTML document or any independently generated markup. In Phase 5C2, audit and enforce the same policy at the final PDF renderer boundary, including any non-DOM conversation paths and font/CSS injection surface. Policy regressions can occur if provider markup changes: test all three providers before promoting a release.

## Gates
All existing unit and Chromium regressions, new malicious/safe markup fixtures, deterministic bundle validation and ZIP build must pass on the same commit. Keep the PR as Draft until local Ubuntu confirmation. No personal conversation fixture or private `Previous Chats/` data is committed.