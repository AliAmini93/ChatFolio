import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const background = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');

function harness() {
  let listener;
  let nextTabId = 100;
  const removed = [];
  let calls = 0;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onConnect: { addListener() {} },
      getURL(path) { return 'chrome-extension://fixture/' + path; }
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      create: async () => ({ id: nextTabId++ }),
      update: async () => ({}),
      remove: async (id) => { removed.push(id); }
    }
  };
  const context = vm.createContext({
    chrome, URL, Uint8Array, String, Number, Promise, Map,
    Date, setInterval: () => 1,
    fetch: async () => {
      calls++;
      return {
        ok: true, headers: { get: () => 'text/css' },
        text: async () => 'body { direction: rtl; }'
      };
    }
  });
  vm.runInContext(background, context, { filename: 'background.js' });
  function send(message) {
    return new Promise((resolve, reject) => {
      const done = (value) => resolve(value);
      try {
        const result = listener(message, { tab: { id: 42, windowId: 1 } }, done);
        if (result !== true && result !== undefined) reject(new Error('unexpected listener result'));
      } catch (error) { reject(error); }
    });
  }
  return { context, send, removed, get fetchCalls() { return calls; } };
}

test('print transfer accepts ordinary chunks and safe retransmission', async () => {
  const h = harness();
  const begin = await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'ordinary',totalChunks:2});
  assert.equal(begin.ok, true);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_CHUNK',jobId:'ordinary',index:0,data:'hello'})).ok,true);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_CHUNK',jobId:'ordinary',index:0,data:'HELLO'})).ok,true);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_CHUNK',jobId:'ordinary',index:1,data:' world'})).ok,true);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_END',jobId:'ordinary'})).ok,true);
  assert.equal(h.context.printJobs.get('ordinary').receivedChars,11);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_ABORT',jobId:'ordinary'})).ok,true);
  assert.equal(h.context.printJobs.size,0);
});

test('duplicate IDs cannot overwrite an active print job', async () => {
  const h = harness();
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'same',totalChunks:1})).ok,true);
  const second=await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'same',totalChunks:2});
  assert.equal(second.ok,false);
  assert.equal(h.context.printJobs.get('same').totalChunks,1);
});

test('simultaneous print jobs are bounded', async () => {
  const h = harness();
  for (let i=0;i<3;i++) assert.equal((await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'j'+i,totalChunks:1})).ok,true);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'j3',totalChunks:1})).ok,false);
  assert.equal(h.context.printJobs.size,3);
});

test('oversized chunk is rejected without storing data', async () => {
  const h = harness();
  await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'big',totalChunks:1});
  const out=await h.send({type:'CHATFOLIO_PRINT_CHUNK',jobId:'big',index:0,data:'x'.repeat(1024*1024+1)});
  assert.equal(out.ok,false);
  assert.equal(h.context.printJobs.get('big').receivedChars,0);
});

test('job size overflow aborts and frees the tab', async () => {
  const h = harness();
  await h.send({type:'CHATFOLIO_PRINT_BEGIN',jobId:'limited',totalChunks:1});
  // Use a reduced limit inside the VM to exercise the same guard without huge fixtures.
  vm.runInContext('MAX_PRINT_JOB_CHARS = 9', h.context);
  assert.equal((await h.send({type:'CHATFOLIO_PRINT_CHUNK',jobId:'limited',index:0,data:'0123456789'})).ok,false);
  assert.equal(h.context.printJobs.size,0);
  assert.deepEqual(h.removed,[100]);
});

test('resource cache reuses results and evicts beyond capacity', async () => {
  const h = harness();
  const url=(n)=>'https://chatgpt.com/cache-fixture/'+n+'.css';
  assert.equal((await h.send({type:'CHATFOLIO_FETCH_TEXT_RESOURCE',url:url(0)})).ok,true);
  assert.equal((await h.send({type:'CHATFOLIO_FETCH_TEXT_RESOURCE',url:url(0)})).ok,true);
  assert.equal(h.fetchCalls,1);
  for(let i=1;i<=8;i++) assert.equal((await h.send({type:'CHATFOLIO_FETCH_TEXT_RESOURCE',url:url(i)})).ok,true);
  assert.equal(h.context.remoteResourceCache.size,8);
  await h.send({type:'CHATFOLIO_FETCH_TEXT_RESOURCE',url:url(0)});
  assert.equal(h.fetchCalls,10);
});
