/** Claude DOM extraction adapter. No transport, media, or printing side effects. */
export function createClaudeDomAdapter(context) {
  const { outsideUiChrome, sortInDocumentOrder, normalizeText, looksUniqueDomId, cleanTitle, lastMessageNearViewportEnd } = context;
  const userSelector = [
    '[data-testid="user-message"]',
    '[data-testid="human-message"]',
    '[data-user-message-bubble="true"]',
    '[data-message-author-role="user"]'
  ].join(', ');
  const assistantSelector = [
    '.font-claude-response',
    '.font-claude-response-body',
    '.font-claude-message',
    '[data-testid="ai-message"]',
    '[data-testid="assistant-message"]',
    '[data-testid="message-assistant"]',
    '[data-message-author-role="assistant"]'
  ].join(', ');

  return {
    getMessageNodes() {
      const turnContainers = [...document.querySelectorAll('[data-test-render-count]')]
        .filter((node) => !node.parentElement?.closest?.('[data-test-render-count]'))
        .filter(outsideUiChrome);

      const structural = [];
      for (const turn of turnContainers) {
        const user = turn.querySelector(userSelector);
        if (user) {
          structural.push(user);
          continue;
        }
        const assistant = turn.querySelector(assistantSelector);
        if (assistant) structural.push(assistant);
      }
      if (structural.length >= 2) return sortInDocumentOrder(structural);

      const users = [...document.querySelectorAll(userSelector)].filter(outsideUiChrome);
      const assistantCandidates = [...document.querySelectorAll(assistantSelector)].filter(outsideUiChrome);
      const assistants = assistantCandidates.filter((node, index, all) => {
        return !all.some((other, otherIndex) => otherIndex !== index && other.contains(node));
      });
      const combined = sortInDocumentOrder([...users, ...assistants]);
      if (combined.length) return combined;

      // Conservative fallback for a future Claude rollout: inspect rendered
      // turn wrappers and retain only wrappers with an identifiable authored role.
      return turnContainers.filter((turn) => turn.querySelector(userSelector) || turn.querySelector(assistantSelector));
    },
    getRole(node) {
      if (node.matches?.(userSelector) || node.closest?.(userSelector)) return 'user';
      if (node.matches?.(assistantSelector) || node.closest?.(assistantSelector)) return 'assistant';
      const direct = node.getAttribute?.('data-message-author-role');
      return direct === 'user' || direct === 'assistant' ? direct : 'unknown';
    },
    findTurn(node) {
      // Keep serialization scoped to the authored body. The surrounding render
      // wrapper contains action chrome and accessibility labels.
      return node;
    },
    orderContainer(node) {
      return node.closest?.('[data-test-render-count]') || node;
    },
    identityMeta(node) {
      const explicit = node.getAttribute?.('data-message-id')
        || node.getAttribute?.('data-message-uuid')
        || node.id
        || '';
      return { stableId: looksUniqueDomId(explicit) ? explicit : '', turnIndex: Number.NaN };
    },
    nearbyIdentityText(node) {
      const holder = node.closest?.('[data-test-render-count]') || node.parentElement;
      const prev = holder?.previousElementSibling;
      const next = holder?.nextElementSibling;
      return normalizeText(`${prev?.innerText || ''}|${next?.innerText || ''}`).slice(0, 500);
    },
    getTitle() {
      const browserTitle = cleanTitle(document.title, 'Claude');
      if (browserTitle && browserTitle.toLowerCase() !== 'claude') return browserTitle;

      const header = document.querySelector('[data-testid="chat-header"], [data-testid="page-header"], [data-testid="chat-title-split"]');
      const heading = header?.querySelector('h1, h2, [data-testid*="title"], [data-test-id*="title"]');
      const headingText = cleanTitle(normalizeText(heading?.innerText || heading?.textContent || ''), 'Claude');
      if (headingText && headingText.toLowerCase() !== 'claude') return headingText;

      const headerText = cleanTitle(normalizeText(header?.innerText || header?.textContent || ''), 'Claude');
      if (headerText && headerText.toLowerCase() !== 'claude') return headerText;
      return 'Claude Conversation';
    },
    isAtConversationEnd(scrollContainer) {
      return lastMessageNearViewportEnd(this.getMessageNodes(), scrollContainer);
    }
  };
}
