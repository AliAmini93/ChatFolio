import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintHtmlSanitizer } from '../../src/security/print-html.js';

const sanitizer = createPrintHtmlSanitizer({
  document: { baseURI: 'https://chatgpt.com/c/synthetic' }
});

test('print sanitizer declares an explicit public API', () => {
  assert.deepEqual(Object.keys(sanitizer).sort(), [
    'safeFragmentRef', 'safeImageUrl', 'safeLinkUrl', 'sanitizePrintClone'
  ].sort());
});

test('unsafe anchor protocols, credentials and hidden control characters are rejected', () => {
  assert.equal(sanitizer.safeLinkUrl('javascript:alert(1)'), '');
  assert.equal(sanitizer.safeLinkUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(sanitizer.safeLinkUrl('file:///etc/passwd'), '');
  assert.equal(sanitizer.safeLinkUrl('https://user:pass@example.org/data'), '');
  assert.equal(sanitizer.safeLinkUrl('https://example.org/\n@evil.org'), '');
  assert.equal(sanitizer.safeLinkUrl('https://example.org/document'), 'https://example.org/document');
  assert.equal(sanitizer.safeLinkUrl('/guide'), 'https://chatgpt.com/guide');
  assert.equal(sanitizer.safeLinkUrl('mailto:hello@example.org'), 'mailto:hello@example.org');
});

test('images allow common provider URLs and safe image data MIME only', () => {
  assert.equal(sanitizer.safeImageUrl('javascript:alert(1)'), '');
  assert.equal(sanitizer.safeImageUrl('data:text/html;base64,PGgxPg=='), '');
  assert.equal(sanitizer.safeImageUrl('blob:https://chatgpt.com/random'), '');
  assert.equal(sanitizer.safeImageUrl('data:image/png;base64,iVBORw=='), 'data:image/png;base64,iVBORw==');
  assert.equal(sanitizer.safeImageUrl('data:image/svg+xml,%3Csvg%3E'), 'data:image/svg+xml,%3Csvg%3E');
  assert.equal(sanitizer.safeImageUrl('https://example.org/pic.png'), 'https://example.org/pic.png');
});

test('SVG external references are rejected while local definitions survive', () => {
  assert.equal(sanitizer.safeFragmentRef('#shape01'), '#shape01');
  assert.equal(sanitizer.safeFragmentRef('#katex-3'), '#katex-3');
  assert.equal(sanitizer.safeFragmentRef('https://evil.example/shape.svg#image'), '');
  assert.equal(sanitizer.safeFragmentRef('javascript:alert(1)'), '');
  assert.equal(sanitizer.safeFragmentRef('# x'), '');
});
