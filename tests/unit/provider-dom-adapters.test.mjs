import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProviderDomAdapter } from '../../src/core/contracts.js';
import { createChatGPTDomAdapter } from '../../src/providers/chatgpt/dom-adapter.js';
import { createClaudeDomAdapter } from '../../src/providers/claude/dom-adapter.js';
import { createGeminiDomAdapter } from '../../src/providers/gemini/dom-adapter.js';

const context = {
  outsideUiChrome: () => true,
  sortInDocumentOrder: (nodes) => nodes,
  normalizeText: (text) => String(text || '').replace(/\s+/g, ' ').trim(),
  looksUniqueDomId: (id) => String(id || '').length > 5,
  cleanTitle: (title, platform) => String(title || '').replace(platform, '').trim(),
  lastMessageNearViewportEnd: () => true,
};

const mockNode = ({ tagName = 'DIV', selectors = [], attributes = {}, closest = {} } = {}) => ({
  tagName,
  id: attributes.id ?? '',
  parentElement: null,
  matches: (selector) => selector.split(',').map((part) => part.trim()).some((part) => selectors.includes(part)),
  closest: (selector) => closest[selector] ?? null,
  getAttribute: (attribute) => attributes[attribute] ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
});

test('three real adapter modules implement the phase-2 ProviderDomAdapter contract', () => {
  for (const factory of [createChatGPTDomAdapter, createClaudeDomAdapter, createGeminiDomAdapter]) {
    assertProviderDomAdapter(factory(context));
  }
});

test('ChatGPT role and stable turn identity remain provider-local', () => {
  const adapter = createChatGPTDomAdapter(context);
  const node = mockNode({ attributes: { 'data-message-author-role': 'assistant', 'data-message-id': 'message-123456789' } });
  assert.equal(adapter.getRole(node), 'assistant');
  assert.equal(adapter.findTurn(node), node);
  assert.equal(adapter.identityMeta(node, node, 'assistant').stableId, 'message-123456789');
});

test('Claude authored node role and turn boundary remain provider-local', () => {
  const adapter = createClaudeDomAdapter(context);
  const node = mockNode({ selectors: ['[data-testid="user-message"]'], attributes: { 'data-message-id': 'claude-user-12345' } });
  assert.equal(adapter.getRole(node), 'user');
  assert.equal(adapter.findTurn(node), node);
  assert.equal(adapter.identityMeta(node).stableId, 'claude-user-12345');
});

test('Gemini DOM role classification and explicit identity remain provider-local', () => {
  const adapter = createGeminiDomAdapter(context);
  const user = mockNode({ tagName: 'USER-QUERY', attributes: { 'data-id': 'user-query-12345' } });
  const model = mockNode({ tagName: 'MODEL-RESPONSE' });
  assert.equal(adapter.getRole(user), 'user');
  assert.equal(adapter.getRole(model), 'assistant');
  assert.equal(adapter.findTurn(user), user);
  assert.equal(adapter.identityMeta(user, user).stableId, 'user-query-12345');
});
