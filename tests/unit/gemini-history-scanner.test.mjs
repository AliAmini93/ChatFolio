import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiHistoryScanner } from '../../src/providers/gemini/history-scanner.js';

function fixture({ turns = 2, nodes = null, scrollTop = 0, failNavigation = false, stuckAtTop = false } = {}) {
  const progress = [];
  const serialized = [];
  const events = [];
  let now = 0;
  let aborted = false;
  let top = scrollTop;
  let observedTurnCount = turns;
  const messages = nodes ?? [
    { role: 'user', id: 'question', html: '<p>سلام</p>', text: 'سلام', imageCount: 1, mediaKeys: ['img:question'] },
    { role: 'assistant', id: 'answer', html: '<p>جواب</p>', text: 'جواب', imageCount: 0, mediaKeys: [] },
    { role: 'user', id: 'question2', html: '<p>دیگر</p>', text: 'دیگر', imageCount: 0, mediaKeys: [] },
    { role: 'assistant', id: 'answer2', html: '<p>تمام</p>', text: 'تمام', imageCount: 0, mediaKeys: [] }
  ];
  const doc = {
    querySelectorAll: (q) => q === '.conversation-container' ? Array.from({ length: observedTurnCount }, (_, i) => ({ id: `c${i}` })) :
      q === 'user-query' ? messages.filter(m => m.role === 'user') :
      q === 'model-response' ? messages.filter(m => m.role === 'assistant') : [],
    querySelector: q => ({ '#chat-history': { id: 'history' }, '.chat-history-scroll-container': { id: 'chat-history-scroll' }, 'infinite-scroller': { id: 'infinite' } })[q] || null
  };
  const scanner = createGeminiHistoryScanner({
    documentRef: doc, now: () => now,
    notifyProgress: v => progress.push(v),
    throwIfCancelled: () => { if (aborted) throw Error('Scan stopped by user.'); },
    assertSameConversation: () => { if (failNavigation) throw Error('Conversation changed'); },
    setScrollTop: (_, value) => { events.push(['top', value]); if (!stuckAtTop) top = value; },
    getScrollTop: () => top,
    scrollRange: node => node.id === 'history' ? 100 : 0,
    sleepWithAbort: async (ms, signal) => { events.push(['sleep', ms]); now += ms; if (signal?.aborted) throw Error('aborted'); },
    getMessageNodes: () => messages,
    dedupeNestedMessages: nodes => nodes,
    getMessageRole: node => node.role,
    findTurnElement: node => node,
    getMessageIdentity: node => ({ strongKey: node.id || '', fingerprintKey: node.text || 'fingerprint' }),
    serializeTurn: async (turn, _, __, ___, signal) => { if (signal?.aborted) throw Error('aborted'); serialized.push(turn.id); return { html: turn.html, text: turn.text, imageCount: turn.imageCount, mediaKeys: turn.mediaKeys }; },
    assertProviderUserImagesCaptured: (serial, role, embed) => { if (role === 'user' && embed && serial.imageCount && !serial.html.includes('p')) throw Error('missing image'); },
    findConversationScrollContainer: () => ({ id: 'generic' })
  });
  const session = { controller: { signal: { aborted: false } } };
  return { scanner, doc, messages, progress, events, serialized, session, setAborted: v => { aborted = v; }, setTurns: n => { observedTurnCount = n; }, getNow: () => now };
}

test('Gemini history counter prefers explicit conversation containers and falls back to query/response pairs', () => {
  const x = fixture({ turns: 3 });
  assert.equal(x.scanner.countGeminiConversationTurns(), 3);
  x.setTurns(0);
  assert.equal(x.scanner.countGeminiConversationTurns(), 2);
});

test('Gemini scroller prioritizes the actual moving chat-history viewport', () => {
  const x = fixture();
  assert.equal(x.scanner.findGeminiScrollContainer(x.messages[0]).id, 'history');
});

test('Gemini loader polls until three stable rounds, captures messages and preserves media', async () => {
  const x = fixture();
  const out = await x.scanner.collectGeminiConversation({}, { embedImages: true }, x.session);
  assert.equal(out.messages.length, 4);
  assert.deepEqual(out.messages.map(m => m.role), ['user','assistant','user','assistant']);
  assert.deepEqual(out.messages.map(m => m.key), ['question','answer','question2','answer2']);
  assert.equal(out.messages[0].html, '<p>سلام</p>');
  assert.ok(Number.isNaN(out.messages[0].turnIndex));
  assert.equal(out.messages[0].discoveryOrder, 0);
  assert.equal(out.imageCount, 1);
  assert.deepEqual([...out.processedMediaKeys], ['img:question']);
  assert.equal(x.events.filter(a => a[0] === 'top').length, 4);
  assert.ok(x.progress.some(v => v.status?.includes('Loading earlier Gemini turns')));
  assert.ok(x.progress.some(v => v.status?.includes('Capturing Gemini messages')));
});

test('Fingerprint-only identities retain separate occurrences instead of overwriting messages', async () => {
  const messages = [0,1].map(() => ({ role:'user',id:'',html:'<p>same</p>',text:'same',imageCount:0,mediaKeys:[] }));
  const x = fixture({turns:1,nodes:messages});
  const out = await x.scanner.collectGeminiConversation({}, {embedImages:false}, x.session);
  assert.deepEqual(out.messages.map(m => m.key), ['same:occ:0','same:occ:1']);
});

test('Incomplete Gemini structural turn coverage stops instead of exporting partial messages', async () => {
  const x = fixture({turns:4,nodes:[{role:'user',id:'only',html:'<p>x</p>',text:'x',imageCount:0,mediaKeys:[]}]});
  await assert.rejects(x.scanner.collectGeminiConversation({}, {embedImages:false}, x.session), /only 1 messages could be captured/);
});

test('No visible messages produces a clear error after history scan', async () => {
  const x = fixture({turns:1,nodes:[]});
  await assert.rejects(x.scanner.collectGeminiConversation({}, {}, x.session), /No Gemini conversation messages/);
});

test('User stop aborts the loader without generating a partial response', async () => {
  const x = fixture();
  x.setAborted(true);
  await assert.rejects(x.scanner.collectGeminiConversation({}, {}, x.session), /Scan stopped by user/);
  assert.equal(x.serialized.length, 0);
});

test('Navigating to another conversation aborts the loader', async () => {
  const x = fixture({failNavigation:true});
  await assert.rejects(x.scanner.collectGeminiConversation({}, {}, x.session), /Conversation changed/);
});

test('Timed-out lazy load refuses to export when still away from top', async () => {
  const x = fixture({turns:2,scrollTop:5,stuckAtTop:true});
  // Keep count changing so the 3-round stable guard never trips.
  let n = 0;
  x.setTurns(2);
  const initial = x.doc.querySelectorAll;
  x.doc.querySelectorAll = s => s === '.conversation-container' ? Array.from({length:++n}) : initial(s);
  await assert.rejects(x.scanner.collectGeminiConversation({}, {}, x.session), /Gemini history did not finish loading/);
  assert.ok(x.getNow() >= 35000);
});
