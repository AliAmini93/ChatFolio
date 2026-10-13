/** Contract checks at module boundaries. Never coupled to a provider DOM. */
export class ContractError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function ensure(condition, code, message) {
  if (!condition) throw new ContractError(code, message);
}

/**
 * @typedef {{
 *   getMessageNodes: () => Element[],
 *   getRole: (node: Element) => 'user'|'assistant'|'unknown',
 *   findTurn: (node: Element) => Element|null,
 *   getTitle: () => string,
 *   identityMeta?: (node: Element, turn?: Element|null, role?: string) => {stableId?: string, turnIndex?: number},
 *   orderContainer?: (node: Element) => Element,
 *   nearbyIdentityText?: (node: Element) => string,
 *   isAtConversationEnd?: (scroller: Element) => boolean,
 * }} ProviderDomAdapter
 */
const REQUIRED_ADAPTER_METHODS = Object.freeze(['getMessageNodes', 'getRole', 'findTurn', 'getTitle']);
const OPTIONAL_ADAPTER_METHODS = Object.freeze([
  'identityMeta', 'orderContainer', 'nearbyIdentityText', 'isAtConversationEnd',
]);

/**
 * Validate the real v1.8.11 adapter surface before moving adapters into src/providers.
 * This only validates shape, not provider DOM correctness.
 * @param {unknown} adapter
 * @returns {ProviderDomAdapter}
 */
export function assertProviderDomAdapter(adapter) {
  ensure(adapter !== null && typeof adapter === 'object' && !Array.isArray(adapter), 'ADAPTER_TYPE', 'Provider adapter must be an object');
  for (const method of REQUIRED_ADAPTER_METHODS) {
    ensure(typeof adapter[method] === 'function', 'ADAPTER_REQUIRED', `Provider adapter missing ${method}()`);
  }
  for (const method of OPTIONAL_ADAPTER_METHODS) {
    ensure(adapter[method] === undefined || typeof adapter[method] === 'function', 'ADAPTER_OPTIONAL', `${method} must be a function when provided`);
  }
  return adapter;
}

/**
 * Renderer receives a canonical conversation, never a provider DOM node.
 * @typedef {{render: (conversation: import('./conversation.js').Conversation, options?: object) => Promise<string> | string}} ConversationRenderer
 */
export function assertRenderer(renderer) {
  ensure(renderer && typeof renderer === 'object' && typeof renderer.render === 'function', 'RENDERER_REQUIRED', 'Renderer requires render(conversation, options)');
  return renderer;
}
