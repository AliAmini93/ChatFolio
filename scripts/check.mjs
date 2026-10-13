#!/usr/bin/env node
/** Dependency-free sanity checks for the current pre-refactor runtime. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const runtimeFiles = ['background.js', 'content.js', 'popup.js', 'print.js'];
const assets = [
  'popup.html', 'popup.css', 'print.html',
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
];
if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('Chrome Manifest V3 and a three-part version are required');
}
for (const file of new Set([...runtimeFiles, ...assets])) {
  if (!statSync(join(root, file)).isFile()) throw new Error(`Missing runtime file: ${file}`);
}
if (!runtimeFiles.includes(manifest.background?.service_worker)) {
  throw new Error('Background worker is missing from the checked JavaScript files');
}
for (const file of runtimeFiles) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  console.log(`Syntax OK: ${file}`);
}
console.log(`Runtime integrity OK: manifest v${manifest.version}`);

// Phase-2 pure domain modules and unit tests are also syntax-checked.
function collectModules(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectModules(path, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
  });
}
for (const file of [...collectModules(join(root, 'src'), '.js'), ...collectModules(join(root, 'tests', 'unit'), '.mjs')]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  console.log(`Syntax OK: ${file.slice(root.length + 1)}`);
}
