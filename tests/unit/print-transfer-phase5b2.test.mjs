import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/content/main.js', import.meta.url), 'utf8');
const begin = source.indexOf('  function canRetryInterruptedPrintTransfer(error) {');
const end = source.indexOf('\n  async function deliverPrintableDocument(', begin);
assert.ok(begin !== -1 && end > begin, 'print retry must be a separately testable section');
const section = source.slice(begin, end);

function fixture(handler) {
  const calls = [];
  let jobSequence = 0;
  const controller = new AbortController();
  const session = { controller };
  const context = {
    PLATFORM: { id:'chatgpt',name:'ChatGPT' },
    location: { href:'https://chatgpt.com/c/sample' },
    navigator: { deviceMemory:4 },
    makePrintJobId: () => 'job-' + ++jobSequence,
    clampNumber: (value, low, high) => Math.max(low, Math.min(high, value)),
    adaptiveTransferConcurrency: () => 2,
    mapWithConcurrency: async (values, fn) => Promise.all(values.map(fn)),
    sendRuntimeMessage: async (message) => {calls.push(message);return handler(message, controller);},
    throwIfCancelled: (value) => { if (value.controller.signal.aborted) throw new Error('Cancelled'); },
    sleep: async () => {}
  };
  const functions = vm.runInNewContext(section +
    '\n({deliverPrintableDocumentViaExtensionPage,canRetryInterruptedPrintTransfer})', context);
  return { ...functions, calls, session, controller };
}

test('ordinary print transfer does not retry or alter the HTML payload', async () => {
  const f=fixture(async (m) => m.type==='CHATFOLIO_PRINT_BEGIN' ?
    {ok:true,printTabId:77} : {ok:true});
  await f.deliverPrintableDocumentViaExtensionPage('<p>سلام 🌿</p>', 'Sample', f.session);
  assert.deepEqual(f.calls.map(m=>m.type),
    ['CHATFOLIO_PRINT_BEGIN','CHATFOLIO_PRINT_CHUNK','CHATFOLIO_PRINT_END']);
  assert.equal(f.calls[1].data,'<p>سلام 🌿</p>');
});

test('missing worker job retries once with a fresh id and full HTML', async () => {
  const f=fixture(async (m) => {
    if (m.type==='CHATFOLIO_PRINT_BEGIN') return {ok:true,printTabId:77};
    if (m.type==='CHATFOLIO_PRINT_CHUNK' && m.jobId==='job-1')
      return {ok:false,error:'The print job is no longer available.'};
    if (m.type==='CHATFOLIO_PRINT_STATUS') return {ok:false};
    return {ok:true};
  });
  await f.deliverPrintableDocumentViaExtensionPage('unmodified-print-html', 'Large', f.session);
  const begins=f.calls.filter(m=>m.type==='CHATFOLIO_PRINT_BEGIN');
  assert.deepEqual(begins.map(m=>m.jobId),['job-1','job-2']);
  assert.equal(f.calls.find(m=>m.type==='CHATFOLIO_PRINT_ABORT').printTabId,77);
  assert.equal(f.calls.find(m=>m.type==='CHATFOLIO_PRINT_CHUNK' && m.jobId==='job-2').data,'unmodified-print-html');
});

test('lost PRINT_END response checks committed status and avoids duplicate printing', async () => {
  const f=fixture(async (m) => {
    if (m.type==='CHATFOLIO_PRINT_BEGIN') return {ok:true,printTabId:88};
    if (m.type==='CHATFOLIO_PRINT_END') throw new Error('The message port closed before a response was received.');
    if (m.type==='CHATFOLIO_PRINT_STATUS') return {ok:true,complete:true,printTabId:88};
    return {ok:true};
  });
  await f.deliverPrintableDocumentViaExtensionPage('<p>done</p>', 'Done', f.session);
  assert.equal(f.calls.filter(m=>m.type==='CHATFOLIO_PRINT_BEGIN').length,1);
  assert.equal(f.calls.filter(m=>m.type==='CHATFOLIO_PRINT_ABORT').length,0);
});

test('non-transient failures do not retry', async () => {
  const f=fixture(async (m) => {
    if (m.type==='CHATFOLIO_PRINT_BEGIN') return {ok:true,printTabId:91};
    if (m.type==='CHATFOLIO_PRINT_CHUNK') return {ok:false,error:'Print job exceeds the safe memory limit.'};
    return {ok:true};
  });
  await assert.rejects(f.deliverPrintableDocumentViaExtensionPage('payload','Large',f.session),/safe memory limit/);
  assert.equal(f.calls.filter(m=>m.type==='CHATFOLIO_PRINT_BEGIN').length,1);
});

test('second interruption stops rather than endlessly recreating jobs', async () => {
  const f=fixture(async (m) => {
    if (m.type==='CHATFOLIO_PRINT_BEGIN') return {ok:true,printTabId:50};
    if (m.type==='CHATFOLIO_PRINT_CHUNK') return {ok:false,error:'The print job is no longer available.'};
    if (m.type==='CHATFOLIO_PRINT_STATUS') return {ok:false};
    return {ok:true};
  });
  await assert.rejects(f.deliverPrintableDocumentViaExtensionPage('payload','Large',f.session),/no longer available/);
  assert.equal(f.calls.filter(m=>m.type==='CHATFOLIO_PRINT_BEGIN').length,2);
});
