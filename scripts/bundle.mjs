#!/usr/bin/env node
/**
 * Dependency-free, deterministic transitional compiler for the on-demand MV3
 * content script. Each provider module is kept as a real importable ESM source;
 * its named factory is embedded into the SAME isolated IIFE as the runtime.
 *
 * This is a deliberately narrow temporary step, not a general-purpose bundler.
 * Do not add imports or additional exports to these modules. Phase 4 may switch
 * to a pinned, standard bundler after the media/renderer boundaries are clear.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const providers = Object.freeze([
  ['chatgpt', 'ChatGPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
]);
const marker = '  /* @chatfolio-provider-adapters */';
const metadataMarker = '  /* @chatfolio-chatgpt-metadata */';
const metadataNames = Object.freeze([
  'getChatGPTConversationContext', 'decodeJwtPayload', 'getChatGPTAccountId',
  'collectChatGPTBranch', 'orderChatGPTShareNodes', 'extractChatGPTTurboChunks',
  'decodeChatGPTTurboStreamFromSource', 'findChatGPTShareContainer'
]);
const source = readFileSync(join(root, 'src/content/main.js'), 'utf8');
if (source.split(marker).length !== 2) throw new Error('Content template must contain exactly one provider insertion marker');

const definitions = providers.map(([id, title]) => {
  const path = join(root, `src/providers/${id}/dom-adapter.js`);
  const original = readFileSync(path, 'utf8').trimEnd();
  // Make any external dependency or unexpected export a build error, rather
  // than emitting a runtime that cannot resolve its bindings.
  const declaration = `export function create${title}DomAdapter(context) {`;
  if (!original.includes(declaration) || original.split(declaration).length !== 2 ||
      /^\s*(?:import\s|export\s(?!function\s))/m.test(original) ||
      (original.match(/\bexport\s+function\b/g) ?? []).length !== 1) {
    throw new Error(`Unsupported module structure in ${path}`);
  }
  const local = original.replace(declaration, `function create${title}DomAdapter(context) {`);
  return `  // BEGIN GENERATED ${id} provider adapter\n` +
    local.split('\n').map(line => line ? `  ${line}` : '').join('\n') +
    `\n  // END GENERATED ${id} provider adapter`;
});
const metadataSource = readFileSync(join(root, 'src/providers/chatgpt/metadata-parser.js'), 'utf8').trimEnd();
if (source.split(metadataMarker).length !== 2 ||
    /^\s*import\s/m.test(metadataSource) ||
    /\bexport\s+(?!function\s)/m.test(metadataSource)) {
  throw new Error('Unsupported ChatGPT metadata module or missing injection marker');
}
const declaredNames = Array.from(metadataSource.matchAll(/^export function (\w+)\(/gm), match => match[1]);
if (declaredNames.length !== metadataNames.length ||
    declaredNames.some((name, i) => name !== metadataNames[i])) {
  throw new Error('ChatGPT metadata export contract mismatch');
}
const embeddedMetadata = metadataSource.replace(/^export function /gm, 'function ')
  .split('\n').map(line => line ? `  ${line}` : '').join('\n');
const transportMarker = '  /* @chatfolio-chatgpt-transport */';
const transportSource = readFileSync(join(root, 'src/providers/chatgpt/transport.js'), 'utf8').trimEnd();
if (source.split(transportMarker).length !== 2 ||
    !transportSource.includes('export function createChatGPTTransport({') ||
    (transportSource.match(/\bexport\s+function\b/g) ?? []).length !== 1 ||
    /^\s*import\s/m.test(transportSource) ||
    /\bexport\s+(?!function\s)/m.test(transportSource)) {
  throw new Error('ChatGPT transport module or insertion marker has invalid structure');
}
const embeddedTransport = transportSource.replace('export function createChatGPTTransport({', 'function createChatGPTTransport({')
  .split('\n').map(line => line ? `  ${line}` : '').join('\n');
const geminiHistoryMarker = '  /* @chatfolio-gemini-history */';
const geminiHistorySource = readFileSync(join(root, 'src/providers/gemini/history-scanner.js'), 'utf8').trimEnd();
const geminiHistoryDeclaration = 'export function createGeminiHistoryScanner({';
if (source.split(geminiHistoryMarker).length !== 2 ||
    !geminiHistorySource.includes(geminiHistoryDeclaration) ||
    geminiHistorySource.split(geminiHistoryDeclaration).length !== 2 ||
    (geminiHistorySource.match(/\bexport\s+function\b/g) ?? []).length !== 1 ||
    /^\s*import\s/m.test(geminiHistorySource) ||
    /\bexport\s+(?!function\s)/m.test(geminiHistorySource)) {
  throw new Error('Gemini history scanner module or insertion marker has invalid structure');
}
const embeddedGeminiHistory = geminiHistorySource.replace(geminiHistoryDeclaration, 'function createGeminiHistoryScanner({')
  .split('\n').map(line => line ? `  ${line}` : '').join('\n');
// Phase 4A: PDF construction is provider-independent and exports one factory.
// Preserve the original renderer implementation verbatim in the classic MV3
// script; do not require ESM syntax at injection time.
const pdfRendererMarker = '  /* @chatfolio-pdf-document-renderer */';
const pdfRendererSource = readFileSync(join(root, 'src/renderer/pdf-document.js'), 'utf8').trimEnd();
const pdfRendererDeclaration = 'export function createPdfDocumentRenderer({';
if (source.split(pdfRendererMarker).length !== 2 ||
    !pdfRendererSource.includes(pdfRendererDeclaration) ||
    pdfRendererSource.split(pdfRendererDeclaration).length !== 2 ||
    (pdfRendererSource.match(/\bexport\s+function\b/g) ?? []).length !== 1 ||
    /^\s*import\s/m.test(pdfRendererSource) ||
    /\bexport\s+(?!function\s)/m.test(pdfRendererSource)) {
  throw new Error('PDF renderer module or insertion marker has invalid structure');
}
// Do not re-indent: this module contains a large HTML/CSS template literal.
// Prefixing lines would alter printable HTML whitespace and risk pagination.
const embeddedPdfRenderer = pdfRendererSource.replace(pdfRendererDeclaration, 'function createPdfDocumentRenderer({');
// Phase 4B1: copy provider image/media extraction as an isolated source
// factory into the classic MV3 script without changing its helper bodies.
const mediaMarker = '  /* @chatfolio-image-pipeline */';
const mediaSource = readFileSync(join(root, 'src/media/image-pipeline.js'), 'utf8').trimEnd();
const mediaDeclaration = 'export function createImagePipeline({';
if (source.split(mediaMarker).length !== 2 ||
    mediaSource.split(mediaDeclaration).length !== 2 ||
    (mediaSource.match(/\bexport\s+function\b/g) ?? []).length !== 1 ||
    /^\s*import\s/m.test(mediaSource) ||
    /\bexport\s+(?!function\s)/m.test(mediaSource)) {
  throw new Error('Image pipeline factory or insertion marker has invalid structure');
}
const embeddedMedia = mediaSource.replace(mediaDeclaration, 'function createImagePipeline({');
// Phase 4B2: image pairs, canvas snapshots and attachment preservation remain
// pure media preparation (not print layout). Embed the legacy function bodies
// without new indentation or source rewriting in the MV3 isolated script.
const turnMediaMarker = '  /* @chatfolio-turn-media */';
const turnMediaSource = readFileSync(join(root, 'src/media/turn-media.js'), 'utf8').trimEnd();
const turnMediaDeclaration = 'export function createTurnMediaProcessor({';
if (source.split(turnMediaMarker).length !== 2 ||
    turnMediaSource.split(turnMediaDeclaration).length !== 2 ||
    (turnMediaSource.match(/\bexport\s+function\b/g) ?? []).length !== 1 ||
    /^\s*import\s/m.test(turnMediaSource) ||
    /\bexport\s+(?!function\s)/m.test(turnMediaSource)) {
  throw new Error('Turn media module factory or insertion marker has invalid structure');
}
const embeddedTurnMedia = turnMediaSource.replace(turnMediaDeclaration, 'function createTurnMediaProcessor({');
// Phase 5C1: detached printable DOM sanitization.
const printSanitizerMarker = '  /* @chatfolio-print-html-sanitizer */';
const printSanitizerSource = readFileSync(join(root, 'src/security/print-html.js'), 'utf8').trimEnd();
const printSanitizerDeclaration = 'export function createPrintHtmlSanitizer({';
if (source.split(printSanitizerMarker).length !== 2 ||
    printSanitizerSource.split(printSanitizerDeclaration).length !== 2 ||
    (printSanitizerSource.match(/\\bexport\\s+function\\b/g) ?? []).length !== 1 ||
    /^\\s*import\\s/m.test(printSanitizerSource) ||
    /\\bexport\\s+(?!function\\s)/m.test(printSanitizerSource)) {
  throw new Error('Print HTML sanitizer module or insertion marker has invalid structure');
}
const embeddedPrintSanitizer = printSanitizerSource.replace(printSanitizerDeclaration, 'function createPrintHtmlSanitizer({');
const generated = source.replace(marker, definitions.join('\n\n'))
  .replace(metadataMarker, `  // BEGIN GENERATED ChatGPT metadata parsers\n${embeddedMetadata}\n  // END GENERATED ChatGPT metadata parsers`)
  .replace(transportMarker, `  // BEGIN GENERATED ChatGPT transport\n${embeddedTransport}\n  // END GENERATED ChatGPT transport`)
  .replace(geminiHistoryMarker, `  // BEGIN GENERATED Gemini history scanner\n${embeddedGeminiHistory}\n  // END GENERATED Gemini history scanner`)
  .replace(pdfRendererMarker, `  // BEGIN GENERATED PDF document renderer\n${embeddedPdfRenderer}\n  // END GENERATED PDF document renderer`)
  .replace(mediaMarker, `  // BEGIN GENERATED Image pipeline\n${embeddedMedia}\n  // END GENERATED Image pipeline`)
  .replace(turnMediaMarker, `  // BEGIN GENERATED turn media\n${embeddedTurnMedia}\n  // END GENERATED turn media`)
  .replace(printSanitizerMarker, `  // BEGIN GENERATED print sanitizer\n${embeddedPrintSanitizer}\n  // END GENERATED print sanitizer`);
const dest = join(root, 'content.js');
if (process.argv.includes('--write')) {
  writeFileSync(dest, generated, 'utf8');
  console.log('Updated content.js from src/content/main.js and provider adapters');
} else if (process.argv.includes('--check')) {
  const actual = readFileSync(dest, 'utf8');
  if (actual !== generated) {
    throw new Error('content.js is stale: run npm run bundle and commit the generated file');
  }
  console.log('Generated content.js matches the provider module sources');
} else {
  throw new Error('Usage: node scripts/bundle.mjs --write|--check');
}
