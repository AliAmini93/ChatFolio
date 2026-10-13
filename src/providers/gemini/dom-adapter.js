/** Gemini DOM extraction adapter. No transport, media, or printing side effects. */
export function createGeminiDomAdapter(context) {
  const { outsideUiChrome, sortInDocumentOrder, normalizeText, looksUniqueDomId, cleanTitle, lastMessageNearViewportEnd } = context;
  const userSelector = 'user-query, .user-query, .user-query-container, [data-message-author="user"], [data-message-author-role="user"]';
  const assistantSelector = 'model-response, .model-response, .model-response-container, response-container, [data-message-author="assistant"], [data-message-author-role="assistant"]';

  return {
    getMessageNodes() {
      const containers = [...document.querySelectorAll('.conversation-container')]
        .filter((node) => !node.parentElement?.closest?.('.conversation-container'))
        .filter(outsideUiChrome);
      const structural = [];
      for (const container of containers) {
        const user = container.querySelector('user-query') || container.querySelector(userSelector);
        const model = container.querySelector('model-response') || container.querySelector(assistantSelector);
        if (user) structural.push(user);
        if (model) structural.push(model);
      }
      if (structural.length) return sortInDocumentOrder(structural);

      const primary = sortInDocumentOrder([
        ...document.querySelectorAll(userSelector),
        ...document.querySelectorAll(assistantSelector)
      ])
        .filter(outsideUiChrome)
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node) && this.getRole(other) === this.getRole(node)));
      return primary;
    },
    getRole(node) {
      const tag = node.tagName?.toLowerCase?.() || '';
      if (tag === 'user-query' || node.matches?.(userSelector) || node.closest?.('user-query')) return 'user';
      if (tag === 'model-response' || node.matches?.(assistantSelector) || node.closest?.('model-response')) return 'assistant';
      return 'unknown';
    },
    findTurn(node) {
      return node.closest?.('user-query, model-response, .user-query, .model-response, .user-query-container, .model-response-container, response-container') || node;
    },
    identityMeta(node, turn) {
      const candidate = turn || node;
      const explicit = candidate.getAttribute?.('data-message-id')
        || candidate.getAttribute?.('data-response-id')
        || candidate.getAttribute?.('data-id')
        || candidate.id
        || '';
      return { stableId: looksUniqueDomId(explicit) ? explicit : '', turnIndex: Number.NaN };
    },
    nearbyIdentityText(node) {
      const container = node.closest?.('.conversation-container');
      const prev = container?.previousElementSibling;
      const next = container?.nextElementSibling;
      return normalizeText(`${prev?.innerText || ''}|${next?.innerText || ''}`).slice(0, 500);
    },
    getTitle() {
      const title = cleanTitle(document.title, 'Gemini');
      if (title && title.toLowerCase() !== 'gemini') return title;
      const candidate = document.querySelector('[data-test-id="conversation-title"], [data-testid="conversation-title"], main h1');
      return normalizeText(candidate?.innerText || candidate?.textContent || '') || 'Gemini Conversation';
    },
    isAtConversationEnd(scrollContainer) {
      return lastMessageNearViewportEnd(this.getMessageNodes(), scrollContainer);
    }
  };
}
