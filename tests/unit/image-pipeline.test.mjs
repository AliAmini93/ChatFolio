import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePipeline } from '../../src/media/image-pipeline.js';

function imageModule({ platform = 'gemini', fetchImpl = async () => ({ ok: false }), styles = () => ({ backgroundImage: 'none' }) } = {}) {
  return createImagePipeline({
    PLATFORM: { id: platform },
    document: { scrollingElement: { scrollTop: 0, scrollLeft: 0 } },
    window: { innerWidth: 900, innerHeight: 700, scrollX: 0, scrollY: 0, scrollTo() {} },
    getComputedStyle: styles,
    absoluteUrl: (url) => url.startsWith('/') ? `https://gemini.google.com${url}` : url,
    sendRuntimeMessage: async () => ({ ok: false }),
    loadDataUrlImage: async () => { throw Error('unexpected screenshot'); },
    sleepWithAbort: async () => {},
    makeCancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
    fetch: fetchImpl,
    FileReader: class {
      readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,YWJj`;
        queueMicrotask(() => this.onload?.());
      }
      abort() {}
    }
  });
}

function element({ attributes = {}, currentSrc = '', rect = {left: 10, top: 20, width: 120, height: 90, right: 130, bottom: 110}, assistant = false } = {}) {
  return {
    currentSrc,
    naturalWidth: 400,
    naturalHeight: 300,
    tagName: 'IMG',
    getAttribute: (name) => attributes[name] || null,
    getBoundingClientRect: () => rect,
    closest: (selector) => assistant && selector.includes('model-response') ? {} : null
  };
}

test('media pipeline exports the capture/transport contract', () => {
  const names = Object.keys(imageModule());
  assert.equal(names.length, 13);
  assert.deepEqual(names.sort(), [
    'bestLiveImageUrl','plausibleLiveUserPicture','liveImageInViewport',
    'saveImageScrollPositions','restoreImageScrollPositions',
    'waitForLiveUserImage','captureVisibleImageRegion','embedVisibleProviderImage',
    'makeMissingImageNotice','providerUserMediaContainer','appendProviderUserImages',
    'sourceToDataUrl','blobToDataUrl'
  ].sort());
});

test('URL resolution prefers live currentSrc then srcset and style background', () => {
  const m = imageModule({ styles: () => ({ backgroundImage: 'url("https://assets.claude.ai/preview.png")' }) });
  assert.equal(m.bestLiveImageUrl(element({ currentSrc: 'https://lh3.googleusercontent.com/real.png', attributes: { src: '/placeholder.png' } })), 'https://lh3.googleusercontent.com/real.png');
  assert.equal(m.bestLiveImageUrl(element({ attributes: { srcset: '/small.png 1x, /large.png 2x' } })), 'https://gemini.google.com/large.png');
  assert.equal(m.bestLiveImageUrl(element()), 'https://assets.claude.ai/preview.png');
});

test('image classification rejects toolbar/assistant and tiny thumbnails', () => {
  const m = imageModule();
  assert.equal(m.plausibleLiveUserPicture(element()), true);
  assert.equal(m.plausibleLiveUserPicture(element({ assistant: true })), false);
  assert.equal(m.plausibleLiveUserPicture(element({ rect: { left: 1, top: 1, width: 15, height: 15, right: 16, bottom: 16 } })), false);
});

test('viewport requires entire rectangle, not just overlapping pixels', () => {
  const m = imageModule();
  assert.equal(m.liveImageInViewport(element()), true);
  assert.equal(m.liveImageInViewport(element({ rect: {left: -10,top: 10,right: 130,bottom: 140,width: 140,height:130} })), false);
});

test('image data URL bypasses network entirely', async () => {
  const m = imageModule({fetchImpl: async () => {throw Error('unexpected fetch');}});
  assert.equal(await m.sourceToDataUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(await m.sourceToDataUrl(''), '');
});

test('fetch conversion only accepts successful bounded image blobs', async () => {
  const calls=[];
  const m = imageModule({ fetchImpl: async (url,init) => {
    calls.push({url,init});
    return {ok:true,blob:async()=>new Blob(['abc'],{type:'image/png'})};
  }});
  assert.equal(await m.sourceToDataUrl('https://example.org/a.png'), 'data:image/png;base64,YWJj');
  assert.equal(calls.length,1);
  assert.equal(calls[0].init.credentials,'include');
  assert.equal(calls[0].init.cache,'force-cache');
  assert.ok(calls[0].init.signal);
});

test('nonimage blobs and HTTP/network failures return an empty data URL', async () => {
  for (const response of [
    {ok:false},
    {ok:true,blob:async()=>new Blob(['not an image'],{type:'text/plain'})}
  ]) {
    const m=imageModule({fetchImpl:async()=>response});
    assert.equal(await m.sourceToDataUrl('https://example.org/x'), '');
  }
  assert.equal(await imageModule({fetchImpl:async()=>{throw Error('CORS');}}).sourceToDataUrl('https://example.org/x'), '');
});

test('aborted image fetch rejects and propagates cancellation', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(imageModule().sourceToDataUrl('https://example.org/image.png', ac.signal), /Cancelled/);
});

test('provider user media container remains provider scoped', () => {
  const shared = {closest: () => null, parentElement: {parentElement: 'parent'}};
  assert.equal(imageModule({platform:'chatgpt'}).providerUserMediaContainer(shared,shared), null);
  assert.equal(imageModule({platform:'claude'}).providerUserMediaContainer(shared,shared),'parent');
});
