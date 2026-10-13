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
const generated = source.replace(marker, definitions.join('\n\n'));
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
