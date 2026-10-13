/** ChatGPT DOM extraction adapter. No transport, media, or printing side effects. */
export function createChatGPTDomAdapter(context) {
  const { outsideUiChrome, sortInDocumentOrder, normalizeText, looksUniqueDomId, cleanTitle, lastMessageNearViewportEnd } = context;
  const roleSelector = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-role="user"]',
    '[data-role="assistant"]',
    '[data-message-author="user"]',
    '[data-message-author="assistant"]'
  ].join(', ');

  const legacyTurnSelector = [
    'section[data-turn="user"]',
    'section[data-turn="assistant"]',
    'article[data-turn="user"]',
    'article[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]',
    '[data-testid*="conversation-turn"]',
    '.user-turn',
    '.agent-turn'
  ].join(', ');

  // ChatGPT's 2026 grouped renderer puts a user prompt and its assistant
  // response under the same stable [data-turn-key] group. The old role/data-turn
  // attributes can be completely absent in this rollout, so collect the two
  // authored surfaces separately instead of treating the whole group as one turn.
  const groupedTurnSelector = '[data-turn-key]';
  const groupedUserSelector = '[data-user-message-bubble]';
  const groupedAssistantSelector = '[data-conversation-role="assistant"]';
  const groupedAssistantStartSelector = '[data-chatgpt-agent-turn-start]';

  function inferRole(node) {
    if (!node) return "unknown";

    const direct = node.getAttribute?.('data-message-author-role')
      || node.getAttribute?.('data-role')
      || node.getAttribute?.('data-message-author')
      || node.getAttribute?.('data-turn')
      || node.getAttribute?.('data-conversation-role');
    if (direct === 'user' || direct === 'assistant') return direct;

    if (node.matches?.(groupedUserSelector) || node.closest?.(groupedUserSelector)) return 'user';
    if (node.matches?.(groupedAssistantSelector) || node.closest?.(groupedAssistantSelector)) return 'assistant';
    if (node.matches?.(groupedAssistantStartSelector) || node.closest?.(groupedAssistantStartSelector)) return 'assistant';
    const nestedGroupedUser = Boolean(node.querySelector?.(groupedUserSelector));
    const nestedGroupedAssistant = Boolean(node.querySelector?.(`${groupedAssistantSelector}, ${groupedAssistantStartSelector}`));
    if (nestedGroupedAssistant && !nestedGroupedUser) return 'assistant';
    if (nestedGroupedUser && !nestedGroupedAssistant) return 'user';

    const nested = node.querySelector?.(roleSelector);
    const nestedRole = nested?.getAttribute?.('data-message-author-role')
      || nested?.getAttribute?.('data-role')
      || nested?.getAttribute?.('data-message-author');
    if (nestedRole === 'user' || nestedRole === 'assistant') return nestedRole;

    // Do not assign a role to a grouped [data-turn-key] wrapper when it contains
    // both roles. Doing so would merge a prompt and response into one PDF message.
    if (node.matches?.(groupedTurnSelector)) {
      const hasUser = Boolean(node.querySelector?.(groupedUserSelector));
      const hasAssistant = Boolean(node.querySelector?.(`${groupedAssistantSelector}, ${groupedAssistantStartSelector}`));
      if (hasUser && !hasAssistant) return 'user';
      if (hasAssistant && !hasUser) return 'assistant';
      if (hasUser && hasAssistant) return 'unknown';
    }

    if (node.matches?.('.user-turn') || node.querySelector?.('.user-turn')) return 'user';
    if (node.matches?.('.agent-turn') || node.querySelector?.('.agent-turn')) return 'assistant';

    const labelNodes = [...(node.querySelectorAll?.('h1, h2, h3, h4, h5, h6, [aria-label]') || [])].slice(0, 8);
    const labelText = normalizeText(labelNodes.map((el) => `${el.getAttribute?.('aria-label') || ''} ${el.textContent || ''}`).join(' ')).toLowerCase();
    if (/\b(you said|user message|your message)\b/.test(labelText)) return 'user';
    if (/\b(chatgpt said|assistant message|assistant response)\b/.test(labelText)) return 'assistant';
    return 'unknown';
  }

  function findGroupedAssistantBody(group) {
    if (!group) return null;
    const roleNode = group.querySelector?.(groupedAssistantSelector);
    if (roleNode) return roleNode;

    const startNode = group.querySelector?.(groupedAssistantStartSelector);
    if (!startNode) return null;

    // Some agent/tool turns expose only a start marker. Walk upward from that
    // marker until we find a response-only subtree, but never cross into the
    // group that also contains the user's bubble.
    let current = startNode;
    while (current?.parentElement && current.parentElement !== group) {
      const parent = current.parentElement;
      const containsUser = Boolean(parent.querySelector?.(groupedUserSelector));
      const hasResponseContent = Boolean(parent.querySelector?.(
        '.markdown, [class*="markdown"], [data-message-model-slug], [data-message-content-part], [data-conversation-role="assistant"]'
      ));
      if (!containsUser && hasResponseContent) return parent;
      current = parent;
    }
    return startNode.parentElement && startNode.parentElement !== group ? startNode.parentElement : startNode;
  }

  function collectGroupedRendererNodes() {
    const groups = [...document.querySelectorAll(groupedTurnSelector)]
      .filter(outsideUiChrome)
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    if (!groups.length) return [];

    const nodes = [];
    for (const group of groups) {
      const user = group.querySelector?.(groupedUserSelector);
      if (user && outsideUiChrome(user)) nodes.push(user);

      const assistant = findGroupedAssistantBody(group);
      if (assistant && outsideUiChrome(assistant)) nodes.push(assistant);
    }
    return sortInDocumentOrder([...new Set(nodes)]);
  }

  return {
    getMessageNodes() {
      // First support the current grouped renderer. This path is intentionally
      // independent of the legacy role attributes because current A/B rollouts
      // can report role=0 and turns=0 while [data-turn-key] is fully populated.
      const grouped = collectGroupedRendererNodes();
      if (grouped.length >= 2) return grouped;

      const authored = [...document.querySelectorAll(roleSelector)]
        .filter(outsideUiChrome)
        .filter((node) => !node.closest?.(groupedTurnSelector))
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node) && inferRole(other) === inferRole(node)));
      if (authored.length >= 2) return sortInDocumentOrder(authored);

      const turns = [...document.querySelectorAll(legacyTurnSelector)]
        .filter(outsideUiChrome)
        .filter((node) => !node.closest?.(groupedTurnSelector))
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)))
        .filter((node) => ['user', 'assistant'].includes(inferRole(node)));
      if (turns.length) return sortInDocumentOrder(turns);

      // If only one current-renderer authored surface is mounted (for example
      // while a reply is still streaming), return it rather than misclassifying
      // composer/sidebar content as a turn.
      if (grouped.length) return grouped;

      const main = document.querySelector('main') || document.body;
      return [...main.querySelectorAll('article, section')]
        .filter(outsideUiChrome)
        .filter((node) => ['user', 'assistant'].includes(inferRole(node)))
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)))
        .sort((a, b) => sortInDocumentOrder([a, b])[0] === a ? -1 : 1);
    },
    getRole(node) {
      return inferRole(node);
    },
    findTurn(node) {
      const role = inferRole(node);
      if (role === 'user') {
        const bubble = node.matches?.(groupedUserSelector) ? node : node.closest?.(groupedUserSelector);
        if (bubble) return bubble;
      }
      if (role === 'assistant') {
        // In the 2026 grouped ChatGPT renderer the aria/role marker can be
        // only the short "ChatGPT said:" caption. The actual reply (including
        // images and DIL-rich content) can be in following sibling elements.
        // Use the full ONE-exchange wrapper for capture; serializeTurn removes
        // the user surface from an assistant capture before exporting it.
        const group = node.closest?.(groupedTurnSelector);
        if (group) return group;
        const roleNode = node.matches?.(groupedAssistantSelector) ? node : node.closest?.(groupedAssistantSelector);
        if (roleNode) return roleNode;
        const body = findGroupedAssistantBody(group);
        if (body) return body;
      }
      return node.closest?.('section[data-turn], article[data-turn], [data-testid^="conversation-turn-"], [data-testid*="conversation-turn"], article, section') || node;
    },
    orderContainer(node) {
      return node.closest?.(groupedTurnSelector) || this.findTurn(node);
    },
    identityMeta(node, turn, role) {
      const group = node.closest?.(groupedTurnSelector) || turn?.closest?.(groupedTurnSelector);
      const groupKey = group?.getAttribute?.('data-turn-key') || '';
      if (groupKey) {
        return {
          stableId: looksUniqueDomId(groupKey) ? `${groupKey}:${role || inferRole(node)}` : '',
          turnIndex: Number.NaN
        };
      }

      const candidate = turn || node;
      const testId = candidate?.getAttribute?.('data-testid') || '';
      const match = testId.match(/conversation-turn-(\d+)/i);
      const nestedIdNode = candidate?.querySelector?.('[data-message-id], [data-message-uuid], [data-turn-id]');
      const explicit = node?.getAttribute?.('data-message-id')
        || node?.getAttribute?.('data-message-uuid')
        || node?.getAttribute?.('data-turn-id')
        || candidate?.getAttribute?.('data-message-id')
        || candidate?.getAttribute?.('data-message-uuid')
        || candidate?.getAttribute?.('data-turn-id')
        || nestedIdNode?.getAttribute?.('data-message-id')
        || nestedIdNode?.getAttribute?.('data-message-uuid')
        || nestedIdNode?.getAttribute?.('data-turn-id')
        || candidate?.id
        || '';
      return {
        stableId: looksUniqueDomId(explicit) ? explicit : '',
        turnIndex: match ? Number(match[1]) : Number.NaN
      };
    },
    nearbyIdentityText(node) {
      const holder = node.closest?.(groupedTurnSelector) || this.findTurn(node);
      const prev = holder?.previousElementSibling;
      const next = holder?.nextElementSibling;
      return normalizeText(`${prev?.innerText || ''}|${next?.innerText || ''}`).slice(0, 500);
    },
    getTitle() {
      return cleanTitle(document.title, 'ChatGPT') || 'ChatGPT Conversation';
    },
    isAtConversationEnd(scrollContainer) {
      return lastMessageNearViewportEnd(this.getMessageNodes(), scrollContainer);
    }
  };
}
