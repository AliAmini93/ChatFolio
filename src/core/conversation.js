import { ContractError, ensure } from './contracts.js';
import { getProvider } from './provider-registry.js';

/**
 * Canonical format v1. No DOM nodes, functions or provider-specific object graphs.
 * HTML blocks are TEMPORARY compatibility blocks, and MUST be sanitized before
 * rendering. This module neither sanitizes nor authorizes HTML.
 *
 * @typedef {{type:'text', value:string} | {type:'legacy-html', html:string} |
 *   {type:'image', src:string, alt:string, embedded:boolean} |
 *   {type:'attachment', name:string, mimeType:string, url:string|null}} ContentBlock
 * @typedef {{key:string|null, turnIndex:number|null, discoveryOrder:number|null}} MessageSource
 * @typedef {{id:string, role:'user'|'assistant', order:number, text:string,
 *   blocks:ContentBlock[], imageCount:number, source:MessageSource}} ConversationMessage
 * @typedef {{schemaVersion:1, provider:'chatgpt'|'claude'|'gemini', title:string,
 *   messages:ConversationMessage[]}} Conversation
 */
export const CONVERSATION_SCHEMA_VERSION = 1;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nullableIndex(value, path) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  ensure(Number.isSafeInteger(value) && value >= 0, 'INVALID_INDEX', `${path} must be a non-negative integer or null`);
  return value;
}

/** @param {ContentBlock} block @param {string} path */
function normalizeBlock(block, path) {
  ensure(block && typeof block === 'object' && !Array.isArray(block), 'BLOCK_TYPE', `${path} must be an object`);
  switch (block.type) {
    case 'text':
      ensure(typeof block.value === 'string', 'BLOCK_TEXT', `${path}.value must be a string`);
      return { type: 'text', value: block.value };
    case 'legacy-html':
      ensure(typeof block.html === 'string', 'BLOCK_HTML', `${path}.html must be a string`);
      return { type: 'legacy-html', html: block.html };
    case 'image':
      ensure(nonEmpty(block.src), 'BLOCK_IMAGE', `${path}.src must be a non-empty string`);
      ensure(typeof block.alt === 'string' && typeof block.embedded === 'boolean', 'BLOCK_IMAGE', `${path} requires alt and embedded`);
      return { type: 'image', src: block.src, alt: block.alt, embedded: block.embedded };
    case 'attachment':
      ensure(nonEmpty(block.name) && typeof block.mimeType === 'string', 'BLOCK_ATTACHMENT', `${path} requires name and mimeType`);
      ensure(block.url === null || typeof block.url === 'string', 'BLOCK_ATTACHMENT', `${path}.url must be a string or null`);
      return { type: 'attachment', name: block.name, mimeType: block.mimeType, url: block.url };
    default:
      throw new ContractError('BLOCK_UNSUPPORTED', `Unsupported content block type at ${path}: ${String(block.type)}`);
  }
}

/** @param {ConversationMessage} input */
export function createMessage(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'MESSAGE_TYPE', 'Message must be an object');
  ensure(nonEmpty(input.id), 'MESSAGE_ID', 'Message id must be a non-empty string');
  ensure(input.role === 'user' || input.role === 'assistant', 'MESSAGE_ROLE', `Unknown message role: ${String(input.role)}`);
  ensure(Number.isSafeInteger(input.order) && input.order >= 0, 'MESSAGE_ORDER', 'Message order must be a non-negative integer');
  ensure(typeof input.text === 'string', 'MESSAGE_TEXT', 'Message text must be a string');
  ensure(Number.isSafeInteger(input.imageCount) && input.imageCount >= 0, 'IMAGE_COUNT', 'imageCount must be a non-negative integer');
  ensure(Array.isArray(input.blocks) && input.blocks.length > 0, 'MESSAGE_BLOCKS', 'Message requires at least one content block');
  const source = input.source ?? {};
  ensure(source && typeof source === 'object' && !Array.isArray(source), 'MESSAGE_SOURCE', 'Message source must be an object');
  ensure(source.key === undefined || source.key === null || nonEmpty(source.key), 'MESSAGE_SOURCE', 'source.key must be non-empty string or null');
  return {
    id: input.id,
    role: input.role,
    order: input.order,
    text: input.text,
    blocks: input.blocks.map((block, index) => normalizeBlock(block, `blocks[${index}]`)),
    imageCount: input.imageCount,
    source: {
      key: source.key ?? null,
      turnIndex: nullableIndex(source.turnIndex, 'source.turnIndex'),
      discoveryOrder: nullableIndex(source.discoveryOrder, 'source.discoveryOrder'),
    },
  };
}

/** @param {Conversation} input */
export function createConversation(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'CONVERSATION_TYPE', 'Conversation must be an object');
  ensure(input.schemaVersion === CONVERSATION_SCHEMA_VERSION, 'SCHEMA_VERSION', `Expected schema version ${CONVERSATION_SCHEMA_VERSION}`);
  ensure(Boolean(getProvider(input.provider)), 'PROVIDER', `Unsupported provider: ${String(input.provider)}`);
  ensure(typeof input.title === 'string', 'TITLE', 'Conversation title must be a string');
  ensure(Array.isArray(input.messages), 'MESSAGES', 'Conversation messages must be an array');
  const messages = input.messages.map(createMessage);
  const ids = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    ensure(item.order === index, 'MESSAGE_ORDER', `Expected message order ${index}; received ${item.order}`);
    ensure(!ids.has(item.id), 'DUPLICATE_MESSAGE_ID', `Duplicate message id: ${item.id}`);
    ids.add(item.id);
  }
  return { schemaVersion: CONVERSATION_SCHEMA_VERSION, provider: input.provider, title: input.title, messages };
}

/**
 * Adapt the exact legacy message shape emitted by all three providers. Never
 * infer roles or drop unknown messages silently. No HTML is modified.
 * This is the intentional bridge for migration phases 3 and 4.
 * @param {{provider:'chatgpt'|'claude'|'gemini', title:string, messages:Array<object>}} input
 * @returns {Conversation}
 */
export function fromLegacyConversation(input) {
  ensure(input && Array.isArray(input.messages), 'LEGACY_MESSAGES', 'Legacy input requires messages');
  const messages = input.messages.map((item, index) => {
    ensure(item && typeof item === 'object', 'LEGACY_MESSAGE', `Legacy message ${index} is not an object`);
    ensure(typeof item.html === 'string' && typeof item.text === 'string', 'LEGACY_CONTENT', `Legacy message ${index} requires html and text strings`);
    ensure(item.key === undefined || nonEmpty(item.key), 'LEGACY_KEY', `Legacy key at message ${index} is invalid`);
    const id = item.key ?? `${input.provider}:fallback:${index}`;
    return createMessage({
      id, role: item.role, order: index, text: item.text,
      blocks: [{ type: 'legacy-html', html: item.html }],
      imageCount: item.imageCount ?? 0,
      source: {
        key: item.key ?? null,
        turnIndex: item.turnIndex,
        discoveryOrder: item.discoveryOrder ?? index,
      },
    });
  });
  return createConversation({schemaVersion:CONVERSATION_SCHEMA_VERSION,provider:input.provider,title:input.title,messages});
}

/**
 * Lossless for legacy renderer-required fields; does not invent HTML for new
 * typed blocks. Migration must add a separate structured renderer first.
 * @param {Conversation} input
 */
export function toLegacyMessages(input) {
  const conversation = createConversation(input);
  return conversation.messages.map((message) => {
    ensure(message.blocks.length === 1 && message.blocks[0].type === 'legacy-html', 'LEGACY_ONLY', `Message ${message.id} contains structured blocks not supported by legacy PDF renderer`);
    return {
      key: message.source.key ?? message.id,
      role: message.role,
      turnIndex: message.source.turnIndex ?? Number.NaN,
      discoveryOrder: message.source.discoveryOrder ?? message.order,
      html: message.blocks[0].html,
      text: message.text,
      imageCount: message.imageCount,
    };
  });
}
