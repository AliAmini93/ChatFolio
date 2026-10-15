# ADR 0005C2 — Final PDF renderer safety boundary

Status: experimental (Phase 5C2); stable release v1.8.11 remains unchanged.

## Problem

Phase 5C1 sanitizes DOM-authored turns at `serializeTurn()`. Other extraction paths (notably provider conversation APIs / canonical messages) may carry `message.html` directly into the renderer, bypassing that earlier DOM checkpoint. Additionally, the renderer previously interpolated `sourceTypography.fontFaceCss` directly into its generated `<style>` block and accepted raw computed font-family strings.

## Decision

- Inject the existing `sanitizePrintClone()` dependency into `createPdfDocumentRenderer()`. Every incoming `message.html` is parsed inside an inert HTML template, scrubbed with the exact same HTML/SVG/MathML allowlist and only then split and laid out for printing. Do not modify the caller's message array or provider DOM.
- The renderer rejects a build if the document/sanitizer dependency is unavailable, rather than silently trusting external markup.
- Preserve provider font stacks only when their CSS values are literal comma-separated font family names, rejecting CSS functions, new declarations, control characters and escaped CSS. Fallback to system UI on failure.
- Reject raw `fontFaceCss` injection at this final boundary. Current typography discovery already produces an empty `fontFaceCss` in the main runtime. Future custom font embedding requires a separate verified `@font-face` builder (not a raw CSS string).
- Keep rich authoring: Persian/RTL text, ordinary hyperlinks, code, images, KaTeX, MathML, SVG paths and real tables.
- No change to provider adapters, Chrome permissions, network/credentials, the published release or package file count.

## Boundaries

This is a defense-in-depth HTML/CSS entry check, **not** a proof that all forms of untrusted browser content are safe. Sanitized HTTP(S) image URLs can still generate network requests if image embedding is disabled; a stricter external-resource policy is considered separately in security QA. Browser extension pages use their own MV3 CSP as another boundary. Avoid printing untrusted data without the sanitizer.

## Acceptance

Node + synthetic Chromium regression suites and package build succeed on the same head commit. New browser fixture sends intentionally unsanitized non-DOM message HTML and malicious typography, confirms the output is safe and searchable as a PDF. Re-check real long Persian ChatGPT/Claude/Gemini conversations before v1.9.0-rc.1. No private Previous Chats files enter Git history.
