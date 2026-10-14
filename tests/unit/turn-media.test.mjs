import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnMediaProcessor } from '../../src/media/turn-media.js';

const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
function mediaFactory({ id = 'gemini', embed = async () => 'data:image/png;base64,AQ==', fetchData = async () => 'data:image/png;base64,Ag==' } = {}) {
  return createTurnMediaProcessor({
    PLATFORM: { id, name: id },
    document: { createElement: tag => ({ tagName: tag.toUpperCase(), src: '', alt: '', classList: { add() {} } }) },
    normalizeText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    sleepWithAbort: async (ms, signal) => { if (signal?.aborted) throw cancelled(); },
    bestLiveImageUrl: img => img.currentSrc || img.getAttribute('src') || '',
    sourceToDataUrl: fetchData,
    embedVisibleProviderImage: embed,
    absoluteUrl: url => url.startsWith('/') ? 'https://gemini.google.com' + url : url,
    makeMissingImageNotice: () => ({ kind: 'missing' })
  });
}
function img({ alt = '', rect = [200, 130], natural = [800, 600], src = 'data:image/png;base64,AAAA', link = false, button = false, source = false } = {}) {
  return {
    alt, currentSrc: src, naturalWidth: natural[0], naturalHeight: natural[1],
    getBoundingClientRect: () => ({ width: rect[0], height: rect[1] }),
    getAttribute: name => name === 'alt' ? alt : name === 'src' ? src : null,
    closest: selector => selector === 'button' ? (button ? {} : null) : selector === 'a[href]' ? (link ? {} : null) : (source && selector.includes('citation') ? {} : null)
  };
}
function clonedImg(parent = null) {
  const attrs = {};
  const classes = new Set();
  return {
    classList: { add: name => classes.add(name), contains: name => classes.has(name) },
    style: { setProperty: (key, value) => { attrs[key] = value; } },
    closest: () => parent,
    setAttribute: (key, value) => { attrs[key] = value; },
    removeAttribute: key => { delete attrs[key]; },
    replaceWith: value => { attrs.replacement = value; },
    getAttribute: key => attrs[key],
    attrs
  };
}

test('turn media module has the precise public surface', () => {
  assert.deepEqual(Object.keys(mediaFactory()).sort(), [
    'classifyImage', 'embedTurnCanvases', 'embedTurnImagePairs',
    'preserveGeminiSiblingAttachments', 'preserveMediaAndAttachmentButtons'
  ].sort());
});

test('classifies user upload, assistant content, and small citation logo without changing HTML', () => {
  const { classifyImage } = mediaFactory();
  assert.equal(classifyImage(img({ button: true, natural: [350, 250] }), 'user'), 'export-user-media');
  assert.equal(classifyImage(img({ rect: [32, 32], natural: [1200, 1200], link: true, source: true }), 'assistant'), 'export-preview-logo');
  assert.equal(classifyImage(img({ rect: [780, 500], natural: [1200, 700] }), 'assistant'), 'export-content-image');
});

test('canvas conversion preserves media statistics and CSS role tag', async () => {
  const { embedTurnCanvases } = mediaFactory();
  const cloneCanvas = { replacement: null, replaceWith(value) { this.replacement = value; } };
  const sourceCanvas = { toDataURL: () => 'data:image/png;base64,ABC', getAttribute: () => 'Graph' };
  const source = { querySelectorAll: () => [sourceCanvas] };
  const clone = { querySelectorAll: () => [cloneCanvas] };
  const result = await embedTurnCanvases(source, clone, 'user');
  assert.deepEqual(result, { embeddedImageCount: 1, meaningfulImageCount: 1, missingUserImages: 0 });
  assert.equal(cloneCanvas.replacement.src, 'data:image/png;base64,ABC');
  assert.equal(cloneCanvas.replacement.alt, 'Graph');
});

test('tainted canvas emits placeholder and counts missing user media', async () => {
  const { embedTurnCanvases } = mediaFactory();
  const source = { querySelectorAll: () => [{ toDataURL: () => { throw new Error('SecurityError'); } }] };
  let replacement;
  const clone = { querySelectorAll: () => [{ replaceWith: value => { replacement = value; } }] };
  assert.deepEqual(await embedTurnCanvases(source, clone, 'user'), { embeddedImageCount: 0, meaningfulImageCount: 0, missingUserImages: 1 });
  assert.equal(replacement.kind, 'missing');
  assert.deepEqual(await embedTurnCanvases(source, clone, 'assistant'), { embeddedImageCount: 0, meaningfulImageCount: 0, missingUserImages: 0 });
});

test('image processing preserves screenshot and live width, image counts and embedded data', async () => {
  const { embedTurnImagePairs } = mediaFactory();
  const original = img({alt:'screenshot evidence', rect: [630, 350], natural: [1260, 700]});
  const target = clonedImg();
  const pairs = [{ sourceImg: original, cloneImg: target }];
  const keys = [];
  const result = await embedTurnImagePairs(pairs, { contains: () => true }, 'assistant', true, null, keys);
  assert.deepEqual(result, {embeddedImageCount: 1, meaningfulImageCount: 1, missingUserImages: 0});
  assert.ok(target.classList.contains('export-content-image'));
  assert.ok(target.classList.contains('export-response-screenshot'));
  assert.equal(target.attrs['--chatfolio-image-width'], '630px');
  assert.equal(target.src, 'data:image/png;base64,AQ==');
  assert.deepEqual(keys, ['data:image/png;base64,AAAA']);
});

test('broken user image is a missing attachment rather than a silent successful export', async () => {
  const m = mediaFactory({ embed: async () => '' });
  const original = img({ natural: [0, 0], alt: 'Uploaded photo', button: true });
  const target = clonedImg();
  const result = await m.embedTurnImagePairs([{ sourceImg: original, cloneImg: target }], { contains: () => true }, 'user', true, null, []);
  assert.deepEqual(result, {embeddedImageCount:0, meaningfulImageCount:0, missingUserImages:1});
  assert.equal(target.attrs.replacement.kind, 'missing');
});

test('no embedding preserves remote URL and counts image content', async () => {
  const m = mediaFactory({ embed: async () => { throw Error('should not embed'); }});
  const target = clonedImg();
  const result = await m.embedTurnImagePairs([{ sourceImg: img({src:'/image.png'}), cloneImg:target }], { contains: () => true }, 'assistant', false, null, []);
  assert.equal(target.src, 'https://gemini.google.com/image.png');
  assert.equal(result.meaningfulImageCount,1);
  assert.equal(result.embeddedImageCount,0);
});

test('aborted image loop propagates cancellation before image processing', async () => {
  const m = mediaFactory();
  const controller = new AbortController();controller.abort();
  await assert.rejects(m.embedTurnImagePairs([{sourceImg: img(),cloneImg:clonedImg()}],{contains:()=>true},'assistant',true,controller.signal,[]), /Cancelled/);
});
