import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfDocumentRenderer } from '../../src/renderer/pdf-document.js';

const renderer = createPdfDocumentRenderer({
  // Pure domain functions are available without a browser or provider DOM.
  document: null, Node: null, Element: null,
  escapeHtml: value => String(value),
  mergeFontStacks: (source, fallback) => source || fallback,
  inferDirection: text => /[\u0600-\u06ff\u0590-\u05ff]/.test(text) ? 'rtl' : 'ltr'
});
const m = (role, text = '') => ({ role, text, html: `<p>${text}</p>`, imageCount: 0 });

test('PDF renderer publishes only its explicit document/layout surface', () => {
  assert.deepEqual(Object.keys(renderer).sort(), [
    'buildPrintableDocument', 'detectDocumentProfile',
    'groupMessagesIntoExchanges', 'splitPrintableMessageOpening'
  ].sort());
  assert.equal(typeof renderer.buildPrintableDocument, 'function');
  assert.equal(Object.isFrozen(renderer), true);
});
test('consecutive assistant turns stay in the same exchange', () => {
  const groups = renderer.groupMessagesIntoExchanges([
    m('user', '1'), m('assistant', '2'), m('assistant', '3'),
    m('user', '4'), m('assistant', '5')
  ]);
  assert.deepEqual(groups.map(g => g.map(x => x.text)), [['1','2','3'], ['4','5']]);
});
test('new user message without prior assistant remains in same exchange', () => {
  const groups = renderer.groupMessagesIntoExchanges([m('user', 'one'),m('user','two'),m('assistant','answer')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});
test('empty conversation has no exchanges and neutral document profile', () => {
  assert.deepEqual(renderer.groupMessagesIntoExchanges([]), []);
  assert.deepEqual(renderer.detectDocumentProfile([]), {lang:'und',dir:'ltr',uiLocale:'en',script:'latin'});
});
test('Persian dialogue uses native fa/rtl locale, even with Latin references', () => {
  const msgs = [m('user', 'سلام. این یک پیام فارسی برای بررسی یک مقاله تحقیقاتی درباره الگوریتم های هوش مصنوعی است.'.repeat(4)),
  m('assistant', 'چطور مدل های هوش مصنوعی را برای تبدیل سیگنال ها به داده های مطلوب ارزیابی کنیم؟ '.repeat(5))];
  const profile=renderer.detectDocumentProfile(msgs);
  assert.deepEqual(profile, { lang:'fa', dir:'rtl', uiLocale:'fa', script:'arabic' });
});
test('long English conversation is left-to-right', () => {
  const profile = renderer.detectDocumentProfile([m('user','How does this work in a normal English conversation?'.repeat(10))]);
  assert.deepEqual(profile, {lang:'en',dir:'ltr',uiLocale:'en',script:'latin'});
});
test('renderer has no external module imports and remains server/test-loadable', () => {
  assert.ok(!('getMessageNodes' in renderer));
  assert.ok(!('requestConversation' in renderer));
});
