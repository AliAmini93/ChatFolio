(() => {
  // ChatFolio is injected on demand. Do not use a persistent global "already
  // injected" flag: after an extension Reload that flag can outlive the old,
  // invalid runtime listener and cause a permanent "Receiving end does not
  // exist" loop on an already-open tab.
  let exportInProgress = false;
  let activeExport = null;
  const EXTENSION_VERSION = (() => {
    try { return chrome.runtime.getManifest()?.version || "unknown"; } catch { return "unknown"; }
  })();
  const PLATFORM = detectPlatform();
  const ADAPTER = createPlatformAdapter(PLATFORM);
  const chatGPTAssetUrlCache = new Map();


  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || min));
  }

  function adaptiveIoConcurrency() {
    // Network/media resolution benefits from concurrency, but provider APIs can
    // rate-limit aggressive bursts. Scale conservatively with the machine and
    // connection rather than creating one worker per CPU core.
    const cores = clampNumber(navigator.hardwareConcurrency || 4, 1, 32);
    const memory = clampNumber(navigator.deviceMemory || 4, 1, 32);
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    const effectiveType = String(connection?.effectiveType || '').toLowerCase();

    let workers = cores >= 12 ? 4 : (cores >= 6 ? 3 : 2);
    if (memory <= 2) workers = Math.min(workers, 2);
    if (connection?.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') workers = 1;
    else if (effectiveType === '3g') workers = Math.min(workers, 2);
    return clampNumber(workers, 1, 4);
  }

  function adaptiveTransferConcurrency() {
    const cores = clampNumber(navigator.hardwareConcurrency || 4, 1, 32);
    const memory = clampNumber(navigator.deviceMemory || 4, 1, 32);
    let workers = cores >= 12 ? 6 : (cores >= 8 ? 5 : (cores >= 4 ? 4 : 2));
    if (memory <= 2) workers = Math.min(workers, 2);
    else if (memory <= 4) workers = Math.min(workers, 4);
    return clampNumber(workers, 2, 6);
  }

  async function mapWithConcurrency(items, worker, { concurrency = 2, signal = null, onSettled = null } = {}) {
    const list = Array.from(items || []);
    if (!list.length) return [];
    const results = new Array(list.length);
    let cursor = 0;
    let settled = 0;
    const runnerCount = Math.max(1, Math.min(list.length, Math.floor(concurrency) || 1));

    const runner = async () => {
      while (true) {
        if (signal?.aborted) throw makeCancelledError();
        const index = cursor;
        cursor += 1;
        if (index >= list.length) return;
        const result = await worker(list[index], index);
        results[index] = result;
        settled += 1;
        if (onSettled) onSettled(result, index, settled, list.length);
      }
    };

    await Promise.all(Array.from({ length: runnerCount }, () => runner()));
    return results;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHATFOLIO_PING") {
      sendResponse({ ok: true, version: EXTENSION_VERSION, platform: PLATFORM.id, platformName: PLATFORM.name });
      return;
    }

    if (message?.type === "GET_CHATFOLIO_STATE") {
      sendResponse({
        ok: true,
        running: exportInProgress,
        percent: Number(activeExport?.percent || 0),
        messageCount: Number(activeExport?.messageCount || 0),
        imageCount: Number(activeExport?.imageCount || 0),
        status: activeExport?.status || ""
      });
      return;
    }

    if (message?.type === "STOP_CHATFOLIO_EXPORT") {
      if (!activeExport || !exportInProgress) {
        sendResponse({ ok: true, stopping: false });
        return;
      }

      activeExport.cancelled = true;
      activeExport.status = "Stopping scan and restoring your position...";
      try { activeExport.controller.abort(); } catch {}
      notifyProgress({
        percent: activeExport.percent || 0,
        messageCount: activeExport.messageCount || 0,
        imageCount: activeExport.imageCount || 0,
        status: activeExport.status,
        running: true
      });
      sendResponse({ ok: true, stopping: true });
      return;
    }

    if (!["EXPORT_CHATFOLIO_PDF", "EXPORT_CHATFOLIO_VISUAL_PDF"].includes(message?.type)) return;

    if (exportInProgress) {
      sendResponse({ ok: false, error: "An export is already running in this tab." });
      return;
    }

    exportInProgress = true;
    activeExport = {
      controller: new AbortController(),
      cancelled: false,
      percent: 1,
      messageCount: 0,
      imageCount: 0,
      status: "Preparing the scan...",
      startedAt: Date.now(),
      sourceUrl: location.href
    };

    try {
      chrome.runtime.sendMessage({
        type: "CHATFOLIO_EXPORT_STARTED",
        platform: PLATFORM.id,
        platformName: PLATFORM.name,
        status: activeExport.status,
        percent: 1,
        messageCount: 0,
        imageCount: 0
      }).catch(() => {});
    } catch {}

    exportConversation({
      includeExportTime: Boolean(message.includeExportTime),
      embedImages: message.embedImages !== false,
      layoutMode: message.layoutMode === "compact" ? "compact" : "comfortable",
      showMessageNumbers: message.showMessageNumbers !== false,
      forceVisual: message.type === "EXPORT_CHATFOLIO_VISUAL_PDF"
    }, activeExport)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        const cancelled = isCancelledError(error) || activeExport?.cancelled;
        if (!cancelled) console.warn(`${PLATFORM.name} export failed:`, error);
        sendResponse({
          ok: false,
          cancelled,
          error: cancelled ? "Scan stopped by user." : (error?.message || String(error))
        });
      })
      .finally(() => {
        notifyProgress({
          percent: activeExport?.percent || 0,
          messageCount: activeExport?.messageCount || 0,
          imageCount: activeExport?.imageCount || 0,
          status: activeExport?.cancelled
            ? "Scan stopped. Original position restored."
            : (activeExport?.status || "Export finished."),
          running: false
        });
        try { chrome.runtime.sendMessage({ type: "CHATFOLIO_EXPORT_FINISHED" }).catch(() => {}); } catch {}
        exportInProgress = false;
        activeExport = null;
      });

    return true;
  });

  function detectPlatform() {
    const host = location.hostname.toLowerCase();
    if (host === "chatgpt.com" || host === "chat.openai.com") {
      return { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };
    }
    if (host === "claude.ai") {
      return { id: "claude", name: "Claude", assistantLabel: "Claude" };
    }
    if (host === "gemini.google.com") {
      return { id: "gemini", name: "Gemini", assistantLabel: "Gemini" };
    }
    return { id: "unsupported", name: "Unsupported", assistantLabel: "Assistant" };
  }

  function createPlatformAdapter(platform) {
    const outsideUiChrome = (node) => !node.closest?.('nav, aside, [role="dialog"], [role="menu"], [role="listbox"]');

    if (platform.id === "chatgpt") {
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
            const roleNode = node.matches?.(groupedAssistantSelector) ? node : node.closest?.(groupedAssistantSelector);
            if (roleNode) return roleNode;
            const group = node.closest?.(groupedTurnSelector);
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

    if (platform.id === "claude") {
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

    if (platform.id === "gemini") {
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

    return {
      getMessageNodes() { return []; },
      getRole() { return 'unknown'; },
      findTurn(node) { return node; },
      identityMeta() { return { stableId: '', turnIndex: Number.NaN }; },
      nearbyIdentityText() { return ''; },
      getTitle() { return 'Conversation'; }
    };
  }


  function getChatGPTConversationContext() {
    try {
      const url = new URL(location.href);
      const parts = url.pathname.split("/").filter(Boolean);

      const shareMarker = parts.lastIndexOf("share");
      if (shareMarker >= 0 && parts[shareMarker + 1]) {
        let shareId = parts[shareMarker + 1];
        // Some ChatGPT routes insert a short locale/channel segment before the id.
        if (/^[a-z]{1,4}$/i.test(shareId) && parts[shareMarker + 2]) shareId = parts[shareMarker + 2];
        return { conversationId: "", projectId: "", shareId, isShare: true };
      }

      const marker = parts.lastIndexOf("c");
      if (marker < 0 || !parts[marker + 1]) return null;
      const conversationId = parts[marker + 1];
      const projectId = parts.slice(0, marker).find((part) => part.startsWith("g-p-")) || "";
      return { conversationId, projectId, shareId: "", isShare: false };
    } catch {
      return null;
    }
  }

  function decodeJwtPayload(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length !== 3) return null;
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  function getChatGPTAccountId(session, accessToken) {
    const explicit = session?.account?.id
      || session?.accountId
      || session?.user?.account_id
      || session?.user?.accountId
      || "";
    if (explicit) return explicit;
    const claims = decodeJwtPayload(accessToken) || {};
    return claims?.["https://api.openai.com/auth"]?.chatgpt_account_id
      || claims?.chatgpt_account_id
      || "";
  }

  function htmlFromPlainText(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n");
    if (!text.trim()) return "";

    const chunks = [];
    let cursor = 0;
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let match;
    while ((match = fence.exec(text))) {
      if (match.index > cursor) chunks.push({ type: "text", value: text.slice(cursor, match.index) });
      chunks.push({ type: "code", lang: (match[1] || "").trim(), value: match[2] || "" });
      cursor = fence.lastIndex;
    }
    if (cursor < text.length) chunks.push({ type: "text", value: text.slice(cursor) });

    return chunks.map((chunk) => {
      if (chunk.type === "code") {
        const language = chunk.lang ? ` data-language="${escapeHtml(chunk.lang)}"` : "";
        return `<pre><code${language}>${escapeHtml(chunk.value.replace(/\n$/, ""))}</code></pre>`;
      }
      return chunk.value
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
          const heading = block.match(/^(#{1,6})\s+(.+)$/s);
          if (heading && !heading[2].includes("\n")) {
            const level = Math.min(6, heading[1].length);
            return `<h${level}>${escapeHtml(heading[2])}</h${level}>`;
          }
          const lines = block.split("\n");
          if (lines.length > 1 && lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
            return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^\s*[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
          }
          if (lines.length > 1 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
            return `<ol>${lines.map((line) => `<li>${escapeHtml(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
          }
          return `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`;
        }).join("");
    }).join("");
  }

  function chatGPTAssetPointerInfo(part) {
    const directUrl = String(part?.image_url || part?.url || "").trim();
    const pointer = String(part?.asset_pointer || part?.assetPointer || "").trim();
    if (/^https:\/\//i.test(directUrl)) return { kind: "url", value: directUrl, fileId: "" };
    if (/^https:\/\//i.test(pointer)) return { kind: "url", value: pointer, fileId: "" };
    if (pointer.startsWith("file-service://")) {
      return { kind: "file-service", value: pointer, fileId: pointer.slice("file-service://".length) };
    }
    if (pointer.startsWith("sediment://")) {
      return { kind: "sediment", value: pointer, fileId: pointer.slice("sediment://".length) };
    }
    const fallbackId = String(part?.file_id || part?.fileId || part?.id || "").trim();
    if (fallbackId) return { kind: "file-service", value: `file-service://${fallbackId}`, fileId: fallbackId };
    return { kind: "", value: pointer || directUrl, fileId: "" };
  }

  function downloadUrlFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    return String(
      payload.download_url
      || payload.downloadUrl
      || payload.signed_url
      || payload.signedUrl
      || payload.url
      || payload.file_url
      || payload.fileUrl
      || ""
    ).trim();
  }

  async function requestChatGPTAssetDownloadUrl(part, context, headers, signal) {
    const info = chatGPTAssetPointerInfo(part);
    if (info.kind === "url" && info.value) return info.value;
    if (!info.fileId) return "";

    const cacheKey = `${context?.conversationId || ""}|${context?.shareId || ""}|${info.kind}|${info.fileId}`;
    if (chatGPTAssetUrlCache.has(cacheKey)) return chatGPTAssetUrlCache.get(cacheKey);

    const promise = (async () => {
      const encodedFileId = encodeURIComponent(info.fileId);
      const encodedConversationId = encodeURIComponent(context?.conversationId || "");
      const encodedShareId = encodeURIComponent(context?.shareId || "");
      const endpoints = [];

      // Shared conversations expose attachment references through the share id, not
      // the /c/<conversation-id> route. Prefer that resolver when available.
      if (context?.shareId) {
        endpoints.push(`/backend-api/files/${encodedFileId}/download?shared_conversation_id=${encodedShareId}`);
      }

      if (info.kind === "sediment") {
        if (context?.conversationId) {
          endpoints.push(`/backend-api/conversation/${encodedConversationId}/attachment/${encodedFileId}/download`);
        }
      } else {
        if (context?.conversationId) {
          endpoints.push(`/backend-api/files/download/${encodedFileId}?conversation_id=${encodedConversationId}&inline=true`);
        }
        endpoints.push(`/backend-api/files/${encodedFileId}/download`);
      }

      for (const endpoint of endpoints) {
        if (signal?.aborted) throw makeCancelledError();
        try {
          const response = await fetch(endpoint, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            redirect: "follow",
            headers: {
              ...headers,
              Accept: "application/json, image/*, */*"
            },
            signal
          });
          if (!response.ok) continue;

          const contentType = String(response.headers.get("content-type") || "").toLowerCase();
          if (contentType.includes("application/json") || contentType.includes("text/json")) {
            const payload = await response.json().catch(() => null);
            const url = downloadUrlFromPayload(payload);
            if (url) return url;
            continue;
          }

          if (response.url && /^https:\/\//i.test(response.url) && response.url !== new URL(endpoint, location.origin).href) {
            return response.url;
          }
        } catch (error) {
          if (signal?.aborted) throw makeCancelledError();
        }
      }
      return "";
    })();

    chatGPTAssetUrlCache.set(cacheKey, promise);
    try {
      const url = await promise;
      chatGPTAssetUrlCache.set(cacheKey, Promise.resolve(url));
      return url;
    } catch (error) {
      chatGPTAssetUrlCache.delete(cacheKey);
      throw error;
    }
  }

  function chatGPTMediaLabel(part, fallback = "Image attachment") {
    return String(
      part?.metadata?.name
      || part?.metadata?.filename
      || part?.name
      || part?.filename
      || fallback
    ).trim() || fallback;
  }

  async function renderChatGPTImagePart(part, context, headers, signal, embedImages, role) {
    const label = chatGPTMediaLabel(part);
    const remoteUrl = await requestChatGPTAssetDownloadUrl(part, context, headers, signal);
    if (!remoteUrl) return { html: `<div class="attachment-card">${escapeHtml(label)}</div>`, mediaCount: 1 };

    let src = remoteUrl;
    if (embedImages) {
      const dataUrl = await fetchDataUrlResource(remoteUrl);
      if (dataUrl) src = dataUrl;
    }

    const cls = role === "user" ? "export-user-media" : "export-content-image";
    return {
      html: `<figure class="export-api-image"><img class="${cls}" data-export-image-kind="${cls}" src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="eager" decoding="sync"></figure>`,
      mediaCount: 1
    };
  }

  async function chatGPTContentToHtml(content, { context, headers, signal, embedImages = true, role = "assistant", metadata = null } = {}) {
    if (!content || typeof content !== "object") return { html: "", text: "", mediaCount: 0 };
    const contentType = String(content.content_type || "");
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const textParts = [];
    const htmlParts = [];
    const seenAssets = new Set();
    let mediaCount = 0;

    for (const part of parts) {
      if (signal?.aborted) throw makeCancelledError();
      if (typeof part === "string") {
        if (part.trim()) {
          textParts.push(part);
          htmlParts.push(htmlFromPlainText(part));
        }
        continue;
      }
      if (!part || typeof part !== "object") continue;

      const kind = String(part.content_type || part.type || "").toLowerCase();
      const partText = typeof part.text === "string" && part.text.trim()
        ? part.text
        : (typeof part.caption === "string" && part.caption.trim() ? part.caption : "");
      if (partText) {
        textParts.push(partText);
        htmlParts.push(htmlFromPlainText(partText));
      }

      const assetInfo = chatGPTAssetPointerInfo(part);
      const assetKey = assetInfo.value || assetInfo.fileId || String(part.image_url || "");
      const isImage = kind.includes("image") || Boolean(part.image_url) || kind === "image_asset_pointer";

      if (isImage) {
        if (assetKey && seenAssets.has(assetKey)) continue;
        if (assetKey) seenAssets.add(assetKey);
        const rendered = await renderChatGPTImagePart(part, context, headers, signal, embedImages, role);
        htmlParts.push(rendered.html);
        mediaCount += rendered.mediaCount;
      } else if (kind.includes("file") || kind.includes("audio") || kind.includes("video") || part.asset_pointer || part.file_id || part.filename) {
        if (assetKey && seenAssets.has(assetKey)) continue;
        if (assetKey) seenAssets.add(assetKey);
        mediaCount += 1;
        const label = chatGPTMediaLabel(part, "Attachment");
        htmlParts.push(`<div class="attachment-card">${escapeHtml(label)}</div>`);
      }
    }

    // Some uploads are represented only in message.metadata.attachments rather than
    // content.parts. Preserve them too, but deduplicate against image_asset_pointer parts.
    const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
    for (const attachment of attachments) {
      if (signal?.aborted) throw makeCancelledError();
      if (!attachment || typeof attachment !== "object") continue;
      const fileId = String(attachment.id || attachment.file_id || attachment.fileId || "").trim();
      const assetKey = fileId ? `file-service://${fileId}` : String(attachment.url || "");
      if (assetKey && seenAssets.has(assetKey)) continue;
      if (assetKey) seenAssets.add(assetKey);

      const mime = String(attachment.mime_type || attachment.mimeType || attachment.type || "").toLowerCase();
      const name = String(attachment.name || attachment.filename || "Attachment");
      const looksImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);
      if (looksImage && (fileId || attachment.url)) {
        const rendered = await renderChatGPTImagePart({
          ...attachment,
          asset_pointer: fileId ? `file-service://${fileId}` : "",
          image_url: attachment.url || "",
          filename: name
        }, context, headers, signal, embedImages, role);
        htmlParts.push(rendered.html);
        mediaCount += rendered.mediaCount;
      } else {
        mediaCount += 1;
        htmlParts.push(`<div class="attachment-card">${escapeHtml(name)}</div>`);
      }
    }

    if (!textParts.length) {
      if (typeof content.text === "string" && content.text.trim()) {
        textParts.push(content.text);
        htmlParts.unshift(htmlFromPlainText(content.text));
      }
      if (typeof content.result === "string" && content.result.trim()) {
        textParts.push(content.result);
        htmlParts.unshift(htmlFromPlainText(content.result));
      }
    }

    const text = textParts.join("\n\n").trim();
    let html = htmlParts.join("");
    if (contentType === "code" && text) html = `<pre><code>${escapeHtml(text)}</code></pre>` + htmlParts.filter((item) => item.includes("<img") || item.includes("attachment-card")).join("");
    if (!html && text) html = htmlFromPlainText(text);
    return { html, text, mediaCount };
  }


  function isExportableChatGPTMessage(message, { skipEditableContext = false } = {}) {
    if (!message || typeof message !== "object") return false;
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant") return false;
    if (role === "assistant" && message.recipient && message.recipient !== "all") return false;
    if (message.metadata?.is_visually_hidden_from_conversation === true) return false;
    if (message.metadata?.is_user_system_message === true) return false;
    if (skipEditableContext && message.content?.content_type === "model_editable_context") return false;
    return true;
  }

  async function renderChatGPTMessageBatch(nodes, {
    context,
    headers,
    signal,
    embedImages,
    keyPrefix,
    progressStart,
    progressSpan,
    progressStatus,
    skipEditableContext = false
  }) {
    const entries = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const message = nodes[index]?.message;
      if (!isExportableChatGPTMessage(message, { skipEditableContext })) continue;
      entries.push({ nodeIndex: index, message });
    }

    let completedRenderable = 0;
    let completedMedia = 0;
    const workers = adaptiveIoConcurrency();
    const renderedEntries = await mapWithConcurrency(entries, async (entry) => {
      if (signal?.aborted) throw makeCancelledError();
      const message = entry.message;
      const role = message.author?.role;
      const rendered = await chatGPTContentToHtml(message.content, {
        context,
        headers,
        signal,
        embedImages,
        role,
        metadata: message.metadata || null
      });
      if (!rendered.text && !rendered.html) return null;
      return {
        key: `${keyPrefix}:${message.id || entry.nodeIndex}`,
        role,
        turnIndex: entry.nodeIndex,
        positionHint: entry.nodeIndex,
        html: rendered.html || `<p>${escapeHtml(rendered.text)}</p>`,
        text: rendered.text,
        imageCount: rendered.mediaCount,
        identitySignature: String(message.id || entry.nodeIndex)
      };
    }, {
      concurrency: workers,
      signal,
      onSettled: (result, _index, settled, total) => {
        if (result) {
          completedRenderable += 1;
          completedMedia += Number(result.imageCount || 0);
        }
        const fraction = total ? settled / total : 1;
        notifyProgress({
          percent: progressStart + Math.round(fraction * progressSpan),
          messageCount: completedRenderable,
          imageCount: completedMedia,
          status: progressStatus,
          running: true
        });
      }
    });

    const messages = renderedEntries.filter(Boolean).map((item, discoveryOrder) => ({ ...item, discoveryOrder }));
    const imageCount = messages.reduce((sum, item) => sum + Number(item.imageCount || 0), 0);
    return { messages, imageCount, workers };
  }

  function collectChatGPTBranch(conversation) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object") return [];
    let currentId = conversation.current_node || conversation.currentNode || "";
    if (!currentId || !mapping[currentId]) {
      const nodes = Object.values(mapping);
      const leaf = nodes.find((node) => node && Array.isArray(node.children) && node.children.length === 0);
      currentId = leaf?.id || leaf?.message?.id || "";
    }

    const branch = [];
    const seen = new Set();
    while (currentId && mapping[currentId] && !seen.has(currentId)) {
      seen.add(currentId);
      const node = mapping[currentId];
      branch.push(node);
      currentId = node.parent || "";
    }
    branch.reverse();
    return branch;
  }

  function orderChatGPTShareNodes(share) {
    if (Array.isArray(share?.linear_conversation) && share.linear_conversation.length) {
      return share.linear_conversation;
    }
    const mapping = share?.mapping;
    if (!mapping || typeof mapping !== "object") return [];
    const nodes = Object.values(mapping).filter(Boolean);
    if (!nodes.length) return [];

    const root = nodes.find((node) => !node?.parent) || nodes[0];
    const ordered = [];
    const seen = new Set();
    let cursor = root;
    while (cursor) {
      const id = cursor.id || cursor.message?.id || `share-node-${ordered.length}`;
      if (seen.has(id)) break;
      seen.add(id);
      ordered.push(cursor);
      const childId = Array.isArray(cursor.children) ? cursor.children[0] : "";
      cursor = childId ? mapping[childId] : null;
    }
    return ordered;
  }

  function extractChatGPTTurboChunks(source) {
    const text = String(source || "");
    const chunks = [];

    // React Router emits one or more JavaScript calls such as:
    //   window.__reactRouterContext.streamController.enqueue("...")
    // Use a deliberately tolerant matcher because whitespace and a trailing
    // semicolon have changed between releases.
    const pattern = /streamController\.enqueue\s*\(\s*("(?:\\.|[^"\\])*")\s*\)\s*;?/gs;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      try {
        const decoded = JSON.parse(match[1]);
        if (typeof decoded === "string" && decoded) chunks.push(decoded);
      } catch {
        // Ignore malformed/non-payload calls and continue looking for usable chunks.
      }
    }
    return chunks;
  }

  function decodeChatGPTTurboStreamFromSource(source) {
    const chunks = extractChatGPTTurboChunks(source);
    if (!chunks.length) throw new Error("No ChatGPT public-share turbo-stream payload was found.");

    // React Router's current single-fetch format can defer parts of the root table.
    // The first payload is the positional table; later payloads can be promise
    // patches such as `P123:<json>`. Ignoring those patches can leave the
    // conversation behind an unresolved ["P", ...] placeholder, which is exactly
    // what happened on some large shared conversations.
    const raw = [];
    let foundInitial = false;
    for (const chunk of chunks) {
      const payload = String(chunk || "");
      if (!payload) continue;
      const normalizedPayload = payload.trimStart();

      if (normalizedPayload.startsWith("[")) {
        try {
          const parsed = JSON.parse(normalizedPayload);
          if (Array.isArray(parsed)) {
            raw.length = 0;
            raw.push(...parsed);
            foundInitial = true;
          }
        } catch {
          // Keep scanning; another enqueue may contain the initial table.
        }
        continue;
      }

      const promiseMatch = normalizedPayload.match(/^P(\d+):([\s\S]*)$/);
      if (promiseMatch) {
        const index = Number(promiseMatch[1]);
        let promisePayload = promiseMatch[2];
        if (promisePayload.endsWith("\n")) promisePayload = promisePayload.slice(0, -1);
        try {
          raw[index] = JSON.parse(promisePayload);
        } catch {
          // A malformed deferred patch should not destroy an otherwise usable root.
        }
      }
    }

    if (!foundInitial || !raw.length) {
      throw new Error("ChatGPT public-share turbo-stream did not contain an initial reference table.");
    }

    const undefinedSentinel = Symbol("chatfolio-undefined");
    const memo = new Map();

    const resolve = (reference) => {
      if (!Number.isInteger(reference)) return reference;
      if (reference === -1) return null;
      if (reference === -5) return undefinedSentinel;
      if (reference === -6) return false;
      if (reference === -7) return true;
      if (reference < 0) return `C${reference}`;
      if (memo.has(reference)) return memo.get(reference);
      if (reference >= raw.length) return null;

      const value = raw[reference];
      if (Array.isArray(value)) {
        // A promise placeholder may survive if a response truly omitted its patch.
        // Do not turn it into fake conversation data.
        if (value.length && value[0] === "P") {
          memo.set(reference, null);
          return null;
        }
        const items = [];
        memo.set(reference, items);
        for (const item of value) {
          const decoded = resolve(item);
          if (decoded !== undefinedSentinel) items.push(decoded);
        }
        return items;
      }

      if (value && typeof value === "object") {
        const object = {};
        memo.set(reference, object);
        for (const [rawKey, rawValue] of Object.entries(value)) {
          let key = rawKey;
          if (/^_\d+$/.test(rawKey)) {
            const decodedKey = resolve(Number(rawKey.slice(1)));
            if (decodedKey !== null && decodedKey !== undefined && decodedKey !== undefinedSentinel) key = String(decodedKey);
          }
          const decodedValue = resolve(rawValue);
          if (decodedValue !== undefinedSentinel) object[key] = decodedValue;
        }
        return object;
      }

      memo.set(reference, value);
      return value;
    };

    const root = resolve(0);
    return root === undefinedSentinel ? null : root;
  }

  function findChatGPTShareContainer(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);

      // Shared-page payloads are not uniform across ChatGPT rollouts. Some expose
      // linear_conversation directly, while others expose only mapping/current_node.
      // Both are complete conversation representations and orderChatGPTShareNodes()
      // already knows how to consume either form.
      if (Array.isArray(value.linear_conversation) && value.linear_conversation.length) return value;
      if (value.mapping && typeof value.mapping === "object" && (value.current_node || value.currentNode)) return value;

      // Current React Router share pages often nest the actual model under
      // loaderData -> route -> serverResponse -> data. Check that shape eagerly so
      // a route wrapper is not mistaken for the conversation itself.
      if (value.loaderData && typeof value.loaderData === "object") {
        for (const routeData of Object.values(value.loaderData)) {
          const direct = routeData?.serverResponse?.data;
          if (!direct || typeof direct !== "object") continue;
          if (Array.isArray(direct.linear_conversation) && direct.linear_conversation.length) return direct;
          if (direct.mapping && typeof direct.mapping === "object" && (direct.current_node || direct.currentNode)) return direct;
        }
      }

      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      } else {
        const values = Object.values(value);
        for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
      }
    }
    return null;
  }

  function decodeChatGPTShareFromLoadedDocument() {
    const scripts = Array.from(document.scripts || []);
    if (!scripts.length) return null;
    const source = scripts.map((script) => script.textContent || "").join("\n");
    if (!source.includes("streamController.enqueue")) return null;
    const root = decodeChatGPTTurboStreamFromSource(source);
    return findChatGPTShareContainer(root);
  }

  async function fetchChatGPTShareFromPublicPage(signal) {
    // Public share pages serialize the conversation into React Router hydration
    // data. First inspect the already-loaded document, then refetch the PUBLIC page
    // without account cookies. The anonymous response is often more fully SSR'd
    // than the signed-in SPA shell and avoids workspace/account-specific routing.
    let share = null;
    try {
      share = decodeChatGPTShareFromLoadedDocument();
    } catch {
      share = null;
    }
    if (share) return share;

    const attempts = [
      { credentials: "omit", label: "anonymous public page" },
      { credentials: "include", label: "signed-in public page" }
    ];
    const errors = [];

    for (const attempt of attempts) {
      try {
        const response = await fetch(location.href, {
          method: "GET",
          credentials: attempt.credentials,
          cache: "no-store",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Cache-Control": "no-cache"
          },
          signal
        });
        if (!response.ok) {
          errors.push(`${attempt.label} HTTP ${response.status}`);
          continue;
        }
        const html = await response.text();
        const root = decodeChatGPTTurboStreamFromSource(html);
        share = findChatGPTShareContainer(root);
        if (share) return share;
        errors.push(`${attempt.label} had hydration data but no complete conversation object`);
      } catch (error) {
        if (signal?.aborted) throw makeCancelledError();
        errors.push(`${attempt.label}: ${error?.message || error}`);
      }
    }

    throw new Error(`ChatGPT public share page did not expose a complete conversation (${errors.join("; ")}).`);
  }

  async function getOptionalChatGPTAuthHeaders(signal) {
    try {
      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
        signal
      });
      if (!sessionResponse.ok) return {};
      const authSession = await sessionResponse.json();
      const accessToken = authSession?.accessToken || "";
      if (!accessToken) return {};
      const headers = { Authorization: `Bearer ${accessToken}` };
      const accountId = getChatGPTAccountId(authSession, accessToken);
      if (accountId) headers["ChatGPT-Account-ID"] = accountId;
      return headers;
    } catch (error) {
      if (signal?.aborted) throw makeCancelledError();
      return {};
    }
  }

  async function collectChatGPTShareViaMetadata(options, session, context) {
    const signal = session.controller.signal;
    throwIfCancelled(session);

    notifyProgress({
      percent: 8,
      messageCount: 0,
      imageCount: 0,
      status: "Reading the complete shared ChatGPT conversation...",
      running: true
    });

    let share;
    let publicPageError = null;
    try {
      share = await fetchChatGPTShareFromPublicPage(signal);
    } catch (error) {
      if (signal?.aborted) throw makeCancelledError();
      publicPageError = error;
    }

    // Compatibility fallback for older/current deployments where the legacy JSON
    // endpoint is still readable. Do not make it the primary path: public share
    // links can legitimately return 401/403 here while the share page itself
    // contains the complete first-party hydration payload.
    if (!share) {
      const endpoint = `/backend-api/share/${encodeURIComponent(context.shareId)}`;
      const authHeaders = await getOptionalChatGPTAuthHeaders(signal);
      const response = await fetch(endpoint, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", ...authHeaders },
        signal
      });
      if (!response.ok) {
        const prefix = publicPageError?.message ? `${publicPageError.message} ` : "";
        throw new Error(`${prefix}Legacy shared-conversation endpoint returned HTTP ${response.status}.`);
      }
      share = await response.json();
    }
    throwIfCancelled(session);
    const nodes = orderChatGPTShareNodes(share);
    if (!nodes.length) throw new Error("ChatGPT shared-conversation data contained no readable message tree.");

    notifyProgress({
      percent: 24,
      messageCount: 0,
      imageCount: 0,
      status: `Shared conversation received. Reading ${nodes.length} stored turns...`,
      running: true
    });

    const headers = await getOptionalChatGPTAuthHeaders(signal);
    const mediaContext = {
      ...context,
      conversationId: String(share?.conversation_id || ""),
      shareId: context.shareId,
      isShare: true
    };

    const renderedBatch = await renderChatGPTMessageBatch(nodes, {
      context: mediaContext,
      headers,
      signal,
      embedImages: options.embedImages !== false,
      keyPrefix: "chatgpt:share",
      progressStart: 24,
      progressSpan: 58,
      progressStatus: "Exporting conversation...",
      skipEditableContext: true
    });
    const { messages, imageCount } = renderedBatch;

    if (!messages.length) throw new Error("ChatGPT shared-conversation data was available, but no visible user/assistant messages were found.");
    notifyProgress({
      percent: 84,
      messageCount: messages.length,
      imageCount,
      status: "Exporting conversation...",
      running: true
    });

    return {
      messages,
      imageCount,
      processedMediaKeys: new Set(),
      identityCollisions: 0,
      title: cleanTitle(share?.title || document.title, "ChatGPT") || "ChatGPT Conversation",
      extractionSource: "share-metadata"
    };
  }

  async function collectChatGPTViaMetadata(options, session) {
    const context = getChatGPTConversationContext();
    if (!context) return null;
    if (context.isShare && context.shareId) {
      return collectChatGPTShareViaMetadata(options, session, context);
    }
    const signal = session.controller.signal;
    throwIfCancelled(session);

    notifyProgress({
      percent: 5,
      messageCount: 0,
      imageCount: 0,
      status: "Connecting to the current ChatGPT conversation...",
      running: true
    });

    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
      signal
    });
    if (!sessionResponse.ok) throw new Error(`ChatGPT session metadata returned HTTP ${sessionResponse.status}.`);
    notifyProgress({
      percent: 12,
      messageCount: 0,
      imageCount: 0,
      status: "Authenticated. Requesting the complete ChatGPT conversation...",
      running: true
    });
    const authSession = await sessionResponse.json();
    const accessToken = authSession?.accessToken || "";
    if (!accessToken) throw new Error("ChatGPT session metadata did not provide a temporary access token.");
    const accountId = getChatGPTAccountId(authSession, accessToken);
    if (!accountId) throw new Error("ChatGPT account metadata could not be resolved for this conversation.");

    const endpoint = `/backend-api/conversation/${encodeURIComponent(context.conversationId)}`;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": accountId,
      "X-OpenAI-Target-Path": endpoint,
      "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}"
    };
    if (context.projectId) headers["chatgpt-project-id"] = context.projectId;

    notifyProgress({
      percent: 20,
      messageCount: 0,
      imageCount: 0,
      status: "Downloading the active ChatGPT conversation branch...",
      running: true
    });

    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers,
      signal
    });
    if (!response.ok) throw new Error(`ChatGPT conversation metadata returned HTTP ${response.status}.`);
    const conversation = await response.json();
    throwIfCancelled(session);

    const branch = collectChatGPTBranch(conversation);
    notifyProgress({
      percent: 30,
      messageCount: 0,
      imageCount: 0,
      status: `Conversation received. Reading ${branch.length} stored turn${branch.length === 1 ? "" : "s"}...`,
      running: true
    });
    const renderedBatch = await renderChatGPTMessageBatch(branch, {
      context,
      headers,
      signal,
      embedImages: options.embedImages !== false,
      keyPrefix: "chatgpt:api",
      progressStart: 30,
      progressSpan: 52,
      progressStatus: "Reading ChatGPT messages...",
      skipEditableContext: false
    });
    const { messages, imageCount } = renderedBatch;

    if (!messages.length) throw new Error("ChatGPT metadata was available, but no visible user/assistant messages were found.");
    notifyProgress({
      percent: 84,
      messageCount: messages.length,
      imageCount,
      status: `Conversation data ready. ${messages.length} messages captured.`,
      running: true
    });
    return {
      messages,
      imageCount,
      processedMediaKeys: new Set(),
      identityCollisions: 0,
      title: cleanTitle(conversation.title || document.title, "ChatGPT") || "ChatGPT Conversation",
      extractionSource: "metadata"
    };
  }

  function collectScrollCandidates(messageNode, platformId = PLATFORM.id) {
    const list = [];
    const add = (node) => {
      if (!node || list.includes(node)) return;
      list.push(node);
    };

    let current = messageNode;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current instanceof HTMLElement) {
        const style = getComputedStyle(current);
        const overflowY = style.overflowY;
        if (scrollRange(current) > 24 || overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") add(current);
      }
      current = current.parentElement;
    }

    if (platformId === "gemini") {
      add(document.querySelector("#chat-history"));
      add(document.querySelector(".chat-history-scroll-container"));
      add(document.querySelector("infinite-scroller"));
    }
    add(document.querySelector("main"));
    add(document.scrollingElement);
    add(document.documentElement);
    return list.filter(Boolean);
  }

  async function resolveConversationScrollContainer(messageNode, platformId, signal) {
    const candidates = collectScrollCandidates(messageNode, platformId);
    if (!candidates.length) return document.scrollingElement || document.documentElement;
    let best = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      if (signal?.aborted) throw makeCancelledError();
      const range = scrollRange(candidate);
      if (range <= 2) continue;
      const beforeTop = getScrollTop(candidate);
      const beforeRect = messageNode?.getBoundingClientRect?.();
      const delta = Math.min(180, Math.max(60, range * 0.08));
      const target = beforeTop > Math.min(range * 0.5, delta + 5)
        ? Math.max(0, beforeTop - delta)
        : Math.min(range, beforeTop + delta);
      setScrollTop(candidate, target);
      await sleepWithAbort(70, signal);
      const afterTop = getScrollTop(candidate);
      const afterRect = messageNode?.getBoundingClientRect?.();
      const topMotion = Math.abs(afterTop - beforeTop);
      const rectMotion = beforeRect && afterRect ? Math.abs(afterRect.top - beforeRect.top) : 0;
      setScrollTop(candidate, beforeTop);
      await sleepWithAbort(20, signal);

      const isDocument = candidate === document.scrollingElement || candidate === document.documentElement;
      const score = Math.min(range, 100000) / 1000 + topMotion * 2 + rectMotion * 3 + (isDocument ? 1 : 0);
      if ((topMotion > 2 || rectMotion > 2) && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best || candidates.find((node) => scrollRange(node) > 40) || document.scrollingElement || document.documentElement;
  }

  async function exportConversation(options, session) {
    throwIfCancelled(session);
    if (PLATFORM.id === "unsupported") throw new Error("This page is not supported by ChatFolio.");

    // Manual Visual backup is deliberately provider-agnostic. Do not touch
    // provider message nodes or typography before entering the screenshot path;
    // this keeps the emergency escape hatch usable even after a radical layout
    // redesign that breaks every semantic selector.
    if (options.forceVisual) {
      return await runVisualArchiveFallback(options, session, new Error("Visual backup was requested by the user."));
    }

    const sourceTypography = await detectSourceTypography(session.controller.signal);
    session.sourceTypography = sourceTypography;

    let collected = null;
    let metadataFailure = null;

    try {
      // ChatGPT is heavily virtualized and its DOM changes frequently. Prefer
      // conversation/share data first; provider DOM scanning is the semantic
      // fallback. If both stop working after a future redesign, the outer catch
      // switches to a provider-agnostic visual archive instead of leaving the
      // user without a PDF.
      if (PLATFORM.id === "chatgpt") {
        try {
          collected = await collectChatGPTViaMetadata(options, session);
        } catch (error) {
          if (isCancelledError(error)) throw error;
          metadataFailure = error;
          console.info("ChatFolio: ChatGPT data extraction was unavailable; trying semantic DOM scanning.", error?.message || error);
        }
      }

      if (!collected) {
        const initialNodes = getMessageNodes();
        if (!initialNodes.length) {
          const diagnostics = collectDomDiagnostics();
          const prefix = metadataFailure ? `ChatGPT data extraction also failed (${metadataFailure.message || metadataFailure}). ` : "";
          throw new Error(`${prefix}No ${PLATFORM.name} conversation messages were found. ${diagnostics}`);
        }

        const scrollContainer = await resolveConversationScrollContainer(initialNodes[0], PLATFORM.id, session.controller.signal);
        const originalScrollTop = getScrollTop(scrollContainer);
        const originalDistanceFromBottom = Math.max(0, getScrollHeight(scrollContainer) - getClientHeight(scrollContainer) - originalScrollTop);
        const originalBehavior = scrollContainer?.style?.scrollBehavior;
        const originalOverflowAnchor = scrollContainer?.style?.overflowAnchor;
        const originalScrollSnapType = scrollContainer?.style?.scrollSnapType;

        if (scrollContainer?.style) {
          scrollContainer.style.scrollBehavior = "auto";
          scrollContainer.style.overflowAnchor = "none";
          scrollContainer.style.scrollSnapType = "none";
        }

        try {
          collected = PLATFORM.id === "gemini"
            ? await collectGeminiConversation(scrollContainer, options, session)
            : await collectEntireConversation(scrollContainer, options, session);
          throwIfCancelled(session);
        } catch (error) {
          if (metadataFailure && PLATFORM.id === "chatgpt" && !isCancelledError(error)) {
            throw new Error(`ChatGPT data extraction failed (${metadataFailure.message || metadataFailure}); semantic DOM fallback failed (${error.message || error}).`);
          }
          throw error;
        } finally {
          if (PLATFORM.id === "gemini") {
            const restoreTop = Math.max(0, getScrollHeight(scrollContainer) - getClientHeight(scrollContainer) - originalDistanceFromBottom);
            setScrollTop(scrollContainer, restoreTop);
          } else {
            setScrollTop(scrollContainer, originalScrollTop);
          }
          if (scrollContainer?.style) {
            scrollContainer.style.scrollBehavior = originalBehavior || "";
            scrollContainer.style.overflowAnchor = originalOverflowAnchor || "";
            scrollContainer.style.scrollSnapType = originalScrollSnapType || "";
          }
        }
      }

      if (!collected?.messages?.length) throw new Error("The semantic full-chat collector did not find any messages.");
    } catch (error) {
      if (isCancelledError(error)) throw error;
      console.warn(`ChatFolio: semantic ${PLATFORM.name} export failed; switching to visual archive fallback.`, error);
      return await runVisualArchiveFallback(options, session, error);
    }

    notifyProgress({
      percent: 94,
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      status: "Building the printable document...",
      running: true
    });
    throwIfCancelled(session);

    const title = collected.title || getConversationTitle() || `${PLATFORM.name} Conversation`;
    let printableHtml;
    try {
      printableHtml = buildPrintableDocument(
        collected.messages,
        title,
        options,
        collected.imageCount,
        PLATFORM,
        sourceTypography
      );
    } catch (error) {
      if (isCancelledError(error)) throw error;
      console.warn("ChatFolio: semantic print document construction failed; switching to visual archive fallback.", error);
      return await runVisualArchiveFallback(options, session, error);
    }

    throwIfCancelled(session);
    notifyProgress({
      percent: 100,
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      status: "Conversation ready. Opening the print dialog...",
      running: true
    });
    await sleepWithAbort(320, session.controller.signal);

    await deliverPrintableDocument(printableHtml, title, session);
    throwIfCancelled(session);

    return {
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      platform: PLATFORM.id,
      platformName: PLATFORM.name,
      fallbackMode: null
    };
  }

  function isRootScrollNode(node) {
    return node === document.scrollingElement || node === document.documentElement || node === document.body;
  }

  function emergencyScrollerScore(node) {
    try {
      const range = scrollRange(node);
      if (range < 120) return -Infinity;
      const viewportWidth = Math.max(1, window.innerWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || 1);
      let rect;
      if (isRootScrollNode(node)) {
        rect = { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight, width: viewportWidth, height: viewportHeight };
      } else {
        rect = node.getBoundingClientRect();
      }
      const width = Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
      const height = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top));
      if (width < Math.min(280, viewportWidth * 0.28) || height < Math.min(240, viewportHeight * 0.35)) return -Infinity;

      const areaRatio = (width * height) / (viewportWidth * viewportHeight);
      const widthRatio = width / viewportWidth;
      const centerX = Math.max(0, Math.min(viewportWidth, rect.left + rect.width / 2));
      const centerAffinity = 1 - Math.min(1, Math.abs(centerX - viewportWidth / 2) / (viewportWidth / 2));
      const style = isRootScrollNode(node) ? null : getComputedStyle(node);
      const scrollStyleBonus = style && /auto|scroll|overlay/.test(style.overflowY || "") ? 6 : 0;
      const mainBonus = node.matches?.('main,[role="main"]') || node.closest?.('main,[role="main"]') ? 7 : 0;
      const sidePenalty = node.closest?.('nav,aside,[role="navigation"]') ? 24 : 0;
      const rootBonus = isRootScrollNode(node) ? 2 : 0;
      return Math.log2(range + 2) * 3.5 + areaRatio * 18 + widthRatio * 8 + centerAffinity * 7 + scrollStyleBonus + mainBonus + rootBonus - sidePenalty;
    } catch {
      return -Infinity;
    }
  }

  function collectEmergencyElements(limit = 5000) {
    const result = [];
    const seen = new Set();
    const stack = [];
    if (document.documentElement) stack.push(document.documentElement);

    while (stack.length && result.length < limit) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (node instanceof HTMLElement) result.push(node);

      // Open shadow roots are intentionally traversed here. The semantic adapters
      // do not need to know about them, but an emergency visual archive should
      // still be able to locate a future provider's scroll viewport if the UI is
      // moved into web components. Closed shadow roots remain browser-inaccessible.
      try {
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.children || []) stack.push(child);
        }
      } catch {}
      try {
        for (let i = node.children?.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
      } catch {}
    }
    return result;
  }

  function emergencyVisibleRect(node) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    if (isRootScrollNode(node)) return { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };
    try {
      const rect = node.getBoundingClientRect();
      const left = Math.max(0, Math.min(vw, rect.left));
      const top = Math.max(0, Math.min(vh, rect.top));
      const right = Math.max(left, Math.min(vw, rect.right));
      const bottom = Math.max(top, Math.min(vh, rect.bottom));
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    } catch {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
  }

  function emergencyRectOverlapRatio(a, b) {
    if (!a || !b || a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return 0;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  }

  function getEmergencyPrimaryRegion() {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    let bestNode = null;
    let bestRect = null;
    let bestScore = -Infinity;

    // Prefer large visible main-content regions when the provider exposes them,
    // but do not depend on any provider-specific class names.
    const candidates = [];
    try { candidates.push(...document.querySelectorAll('main,[role="main"]')); } catch {}
    for (const node of candidates) {
      try {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) continue;
        const rect = emergencyVisibleRect(node);
        if (rect.width < vw * 0.38 || rect.height < vh * 0.42) continue;
        const centerX = rect.left + rect.width / 2;
        const centerAffinity = 1 - Math.min(1, Math.abs(centerX - vw / 2) / (vw / 2));
        const score = rect.width * rect.height * (0.75 + centerAffinity * 0.25);
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
          bestRect = rect;
        }
      } catch {}
    }

    if (bestRect) return { node: bestNode, rect: bestRect };

    // Provider-agnostic fallback: the central content band. Sidebars normally sit
    // outside this region, so using it prevents the visual archive from scrolling
    // a navigation panel while repeatedly capturing an unchanged conversation.
    return {
      node: null,
      rect: { left: vw * 0.18, top: 0, right: vw, bottom: vh, width: vw * 0.82, height: vh }
    };
  }

  function collectEmergencyCenterAncestors() {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const hits = new Map();
    const xs = [0.36, 0.50, 0.64, 0.78];
    const ys = [0.24, 0.44, 0.64, 0.78];

    for (const xf of xs) {
      for (const yf of ys) {
        let node = null;
        try { node = document.elementFromPoint(Math.round(vw * xf), Math.round(vh * yf)); } catch {}
        let depth = 0;
        while (node && depth < 18) {
          if (node instanceof HTMLElement) hits.set(node, (hits.get(node) || 0) + 1);
          if (node.parentElement) node = node.parentElement;
          else {
            try { node = node.getRootNode?.()?.host || null; } catch { node = null; }
          }
          depth += 1;
        }
      }
    }
    return hits;
  }

  async function probeEmergencyScroller(node, signal) {
    if (!node || signal?.aborted) return false;
    const range = scrollRange(node);
    if (range < 120) return false;
    const original = getScrollTop(node);
    let target;
    if (original < range * 0.72) target = Math.min(range, original + Math.max(140, Math.min(420, range * 0.12)));
    else target = Math.max(0, original - Math.max(140, Math.min(420, range * 0.12)));
    if (Math.abs(target - original) < 24) return false;

    try {
      setScrollTop(node, target);
      await sleepWithAbort(85, signal);
      const moved = Math.abs(getScrollTop(node) - original) >= 18;
      setScrollTop(node, original);
      await sleepWithAbort(45, signal);
      return moved;
    } catch (error) {
      try { setScrollTop(node, original); } catch {}
      if (isCancelledError(error)) throw error;
      return false;
    }
  }

  async function findEmergencyVisualScroller(session, excluded = new Set()) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const primary = getEmergencyPrimaryRegion();
    const centerHits = collectEmergencyCenterAncestors();
    const candidates = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node) || excluded.has(node)) return;
      seen.add(node);
      candidates.push(node);
    };

    add(document.scrollingElement);
    add(document.documentElement);
    add(document.body);
    for (const node of centerHits.keys()) add(node);
    for (const node of collectEmergencyElements(5000)) add(node);

    const ranked = [];
    for (const node of candidates) {
      const base = emergencyScrollerScore(node);
      if (!Number.isFinite(base)) continue;
      const rect = emergencyVisibleRect(node);
      const isRoot = isRootScrollNode(node);
      const overlap = isRoot ? 1 : emergencyRectOverlapRatio(rect, primary.rect);
      const widthRatio = rect.width / vw;
      const heightRatio = rect.height / vh;
      const centerHitBonus = (centerHits.get(node) || 0) * 5.5;
      const primaryContainment = primary.node && (node === primary.node || node.contains?.(primary.node) || primary.node.contains?.(node)) ? 16 : 0;

      // A narrow sidebar can have an enormous scroll range and used to beat the
      // real conversation scroller. Non-root candidates must now occupy a large
      // central region or substantially overlap the main content region.
      if (!isRoot && widthRatio < 0.42 && overlap < 0.68) continue;
      if (!isRoot && heightRatio < 0.42) continue;
      if (!isRoot && overlap < 0.34 && (centerHits.get(node) || 0) < 2) continue;

      const score = base + overlap * 42 + Math.min(1, widthRatio) * 10 + centerHitBonus + primaryContainment;
      ranked.push({ node, score, overlap, centerHits: centerHits.get(node) || 0 });
    }

    ranked.sort((a, b) => b.score - a.score);
    for (const item of ranked.slice(0, 18)) {
      throwIfCancelled(session);
      if (await probeEmergencyScroller(item.node, session.controller.signal)) return item.node;
    }

    // If the page itself is not currently scrollable, return the highest-ranked
    // candidate anyway so callers can produce a one-viewport emergency archive.
    return ranked[0]?.node || document.scrollingElement || document.documentElement;
  }

  function clampCaptureRect(rect) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const left = Math.max(0, Math.min(vw, Number(rect?.left || 0)));
    const top = Math.max(0, Math.min(vh, Number(rect?.top || 0)));
    const right = Math.max(left, Math.min(vw, Number(rect?.right ?? vw)));
    const bottom = Math.max(top, Math.min(vh, Number(rect?.bottom ?? vh)));
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  function getEmergencyCaptureRect(scroller) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const primary = getEmergencyPrimaryRegion();

    if (!isRootScrollNode(scroller)) {
      const rect = clampCaptureRect(scroller.getBoundingClientRect());
      const overlap = emergencyRectOverlapRatio(
        { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, width: rect.width, height: rect.height },
        primary.rect
      );
      if (rect.width >= vw * 0.42 && rect.height >= vh * 0.45 && overlap >= 0.38) return rect;
    }

    if (primary?.rect) return clampCaptureRect(primary.rect);
    return { left: 0, top: 0, width: vw, height: vh };
  }

  function loadDataUrlImage(dataUrl, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(makeCancelledError());
      const img = new Image();
      const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
      const onAbort = () => { cleanup(); reject(makeCancelledError()); };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      img.onload = () => { cleanup(); resolve(img); };
      img.onerror = () => { cleanup(); reject(new Error("Could not decode a captured viewport image.")); };
      img.src = dataUrl;
    });
  }

  async function cropEmergencyCapture(dataUrl, rect, signal) {
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const safe = clampCaptureRect(rect);
    const nearFull = safe.left <= 2 && safe.top <= 2 && safe.width >= vw - 4 && safe.height >= vh - 4;
    if (nearFull) return dataUrl;

    try {
      const img = await loadDataUrlImage(dataUrl, signal);
      const scaleX = img.naturalWidth / vw;
      const scaleY = img.naturalHeight / vh;
      const sx = Math.max(0, Math.round(safe.left * scaleX));
      const sy = Math.max(0, Math.round(safe.top * scaleY));
      const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(safe.width * scaleX)));
      const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(safe.height * scaleY)));
      const maxWidth = 1500;
      const outputScale = Math.min(1, maxWidth / sw);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * outputScale));
      canvas.height = Math.max(1, Math.round(sh * outputScale));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return dataUrl;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.78);
    } catch (error) {
      if (isCancelledError(error)) throw error;
      return dataUrl;
    }
  }

  async function captureEmergencyViewport(scroller, session) {
    throwIfCancelled(session);
    const response = await sendRuntimeMessage({ type: "CHATFOLIO_CAPTURE_VISIBLE", quality: 80 });
    if (!response?.ok || !response?.dataUrl) throw new Error(response?.error || "Chrome could not capture the conversation viewport.");
    const rect = getEmergencyCaptureRect(scroller);
    return await cropEmergencyCapture(response.dataUrl, rect, session.controller.signal);
  }

  async function settleEmergencyTop(scroller, session) {
    const signal = session.controller.signal;
    let lastHeight = -1;
    let stableRounds = 0;
    const started = Date.now();
    for (let round = 0; round < 18 && stableRounds < 3 && Date.now() - started < 18000; round += 1) {
      throwIfCancelled(session);
      setScrollTop(scroller, 0);
      await sleepWithAbort(round < 3 ? 650 : 900, signal);
      const height = getScrollHeight(scroller);
      const top = getScrollTop(scroller);
      if (Math.abs(height - lastHeight) <= 12 && top <= 24) stableRounds += 1;
      else stableRounds = 0;
      lastHeight = height;
    }
    setScrollTop(scroller, 0);
    await sleepWithAbort(500, signal);
  }

  function emergencyFrameSignature(dataUrl) {
    const value = String(dataUrl || "");
    if (!value) return "";
    return `${value.length}:${simpleHash(value.slice(0, 1800) + value.slice(-1800))}`;
  }

  async function captureEmergencyScrollerSequence(scroller, session) {
    const signal = session.controller.signal;
    const originalTop = getScrollTop(scroller);
    const originalBehavior = scroller?.style?.scrollBehavior;
    const originalOverflowAnchor = scroller?.style?.overflowAnchor;
    const originalScrollSnapType = scroller?.style?.scrollSnapType;
    if (scroller?.style) {
      scroller.style.scrollBehavior = "auto";
      scroller.style.overflowAnchor = "none";
      scroller.style.scrollSnapType = "none";
    }

    const frames = [];
    let encodedChars = 0;
    let lastSignature = "";
    let stagnant = 0;
    let minTop = Infinity;
    let maxTop = -Infinity;
    const maxFrames = 1200;
    const maxEncodedChars = 190 * 1024 * 1024;

    try {
      await settleEmergencyTop(scroller, session);
      let viewport = Math.max(260, getClientHeight(scroller));
      let step = Math.max(220, Math.floor(viewport * 0.88));
      let target = 0;
      let lastActualTop = -1;

      while (frames.length < maxFrames && encodedChars < maxEncodedChars) {
        throwIfCancelled(session);
        const range = Math.max(0, scrollRange(scroller));
        const clampedTarget = Math.min(range, Math.max(0, target));
        setScrollTop(scroller, clampedTarget);
        await sleepWithAbort(frames.length < 2 ? 620 : 360, signal);
        const actualTop = getScrollTop(scroller);
        minTop = Math.min(minTop, actualTop);
        maxTop = Math.max(maxTop, actualTop);

        const frame = await captureEmergencyViewport(scroller, session);
        const signature = emergencyFrameSignature(frame);
        if (signature && signature !== lastSignature) {
          frames.push(frame);
          encodedChars += frame.length;
          lastSignature = signature;
          stagnant = 0;
        } else {
          stagnant += 1;
        }

        const currentRange = Math.max(0, scrollRange(scroller));
        const percent = currentRange > 0
          ? Math.min(91, 10 + Math.round((actualTop / currentRange) * 80))
          : 90;
        notifyProgress({ percent, messageCount: 0, imageCount: frames.length, status: "Creating a visual backup of the full conversation...", running: true });

        const atBottom = currentRange <= 8 || actualTop >= currentRange - 8;
        if (atBottom) {
          await sleepWithAbort(560, signal);
          const grownRange = Math.max(0, scrollRange(scroller));
          if (grownRange <= currentRange + 12) break;
        }

        // If setting scrollTop has no effect, this is almost certainly a false
        // scroller candidate (for example a sidebar or wrapper). Stop this pass so
        // the caller can rediscover another candidate instead of producing a PDF
        // with the same viewport repeated twice.
        if (lastActualTop >= 0 && clampedTarget > lastActualTop + 80 && actualTop <= lastActualTop + 8) {
          stagnant += 3;
        }
        if (stagnant >= 4 && Math.abs(actualTop - lastActualTop) < 12) break;

        lastActualTop = actualTop;
        viewport = Math.max(260, getClientHeight(scroller));
        step = Math.max(220, Math.floor(viewport * 0.88));
        target = actualTop + step;
      }

      return {
        frames,
        movement: Number.isFinite(minTop) && Number.isFinite(maxTop) ? Math.max(0, maxTop - minTop) : 0,
        range: Math.max(0, scrollRange(scroller)),
        viewport: Math.max(260, getClientHeight(scroller))
      };
    } finally {
      setScrollTop(scroller, originalTop);
      if (scroller?.style) {
        scroller.style.scrollBehavior = originalBehavior || "";
        scroller.style.overflowAnchor = originalOverflowAnchor || "";
        scroller.style.scrollSnapType = originalScrollSnapType || "";
      }
    }
  }

  function assistedVisualOverlay(session) {
    const existing = document.querySelector('[data-chatfolio-visual-overlay="1"]');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.setAttribute('data-chatfolio-visual-overlay', '1');
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          position: fixed;
          right: 18px;
          bottom: 18px;
          width: min(410px, calc(100vw - 36px));
          font-family: Arial, sans-serif;
          color: #171717;
          background: rgba(255,255,255,.97);
          border: 1px solid rgba(17,24,39,.18);
          border-radius: 14px;
          box-shadow: 0 18px 48px rgba(0,0,0,.24);
          padding: 15px;
          pointer-events: auto;
          backdrop-filter: blur(10px);
        }
        .title { font-size: 15px; font-weight: 700; margin: 0 0 7px; }
        .body { font-size: 12.5px; line-height: 1.45; color: #374151; margin: 0 0 11px; }
        .status { font-size: 12px; line-height: 1.4; color: #111827; margin: 8px 0 10px; min-height: 17px; }
        .counter { display: inline-flex; align-items: center; gap: 5px; margin-bottom: 8px; padding: 4px 8px; border-radius: 999px; background: #f3f4f6; font-size: 11px; color: #374151; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; }
        button {
          appearance: none; border: 0; border-radius: 9px; padding: 9px 11px;
          font: 600 12px/1 Arial, sans-serif; cursor: pointer;
        }
        button.primary { background: #111827; color: #fff; }
        button.secondary { background: #eef0f3; color: #111827; }
        button.danger { background: #fff0f0; color: #a11; }
        button:disabled { opacity: .48; cursor: default; }
        .tiny { font-size: 10.5px; color: #6b7280; margin-top: 9px; line-height: 1.35; }
      </style>
      <section class="panel" role="dialog" aria-label="ChatFolio visual backup">
        <div class="title">ChatFolio Visual Backup</div>
        <div class="body" data-body>
          Go to the <strong>beginning of the conversation</strong> using the page normally. Then click <strong>Start capture</strong>.
          After that, scroll downward at a normal, steady pace. ChatFolio will capture the visible conversation while you scroll.
        </div>
        <div class="counter" data-counter hidden>0 unique views captured</div>
        <div class="status" data-status>Waiting for you to reach the beginning of the chat.</div>
        <div class="row" data-before>
          <button class="primary" data-start>Start capture</button>
          <button class="danger" data-cancel>Cancel</button>
        </div>
        <div class="row" data-during hidden>
          <button class="secondary" data-capture>Capture current view</button>
          <button class="primary" data-finish>Finish & create PDF</button>
          <button class="danger" data-cancel2>Cancel</button>
        </div>
        <div class="tiny" data-tip>
          Best results: scroll in one direction, about one screen at a time. Pause briefly if you move quickly. Duplicate views are ignored automatically.
        </div>
      </section>`;

    const q = (selector) => shadow.querySelector(selector);
    return {
      host,
      shadow,
      body: q('[data-body]'),
      counter: q('[data-counter]'),
      status: q('[data-status]'),
      before: q('[data-before]'),
      during: q('[data-during]'),
      start: q('[data-start]'),
      capture: q('[data-capture]'),
      finish: q('[data-finish]'),
      cancel: q('[data-cancel]'),
      cancel2: q('[data-cancel2]'),
      remove() { try { host.remove(); } catch {} },
      hideForCapture() { host.style.visibility = 'hidden'; },
      showAfterCapture() { host.style.visibility = 'visible'; },
      setStatus(text) { q('[data-status]').textContent = String(text || ''); },
      setCount(count) {
        const el = q('[data-counter]');
        el.hidden = false;
        el.textContent = `${count} unique view${count === 1 ? '' : 's'} captured`;
      },
      enterCaptureMode() {
        q('[data-before]').hidden = true;
        q('[data-during]').hidden = false;
        q('[data-counter]').hidden = false;
        q('[data-body]').innerHTML = 'Scroll downward normally. ChatFolio captures during real user scrolling. Use <strong>Capture current view</strong> any time you want to force a frame.';
      }
    };
  }

  async function assistedVisualFingerprint(dataUrl, signal) {
    try {
      const img = await loadDataUrlImage(dataUrl, signal);
      const canvas = document.createElement('canvas');
      canvas.width = 28;
      canvas.height = 18;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const values = new Uint8Array(canvas.width * canvas.height);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
        values[j] = Math.round(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114);
      }
      return values;
    } catch (error) {
      if (isCancelledError(error)) throw error;
      return null;
    }
  }

  function assistedFingerprintDistance(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return 1;
    let total = 0;
    for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
    return total / (a.length * 255);
  }

  async function captureAssistedVisualViewport(session, overlay) {
    throwIfCancelled(session);
    overlay?.hideForCapture();
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const response = await sendRuntimeMessage({ type: 'CHATFOLIO_CAPTURE_VISIBLE', quality: 80 });
      if (!response?.ok || !response?.dataUrl) throw new Error(response?.error || 'Chrome could not capture the current conversation view.');
      const primary = getEmergencyPrimaryRegion();
      const rect = primary?.rect ? clampCaptureRect(primary.rect) : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      return await cropEmergencyCapture(response.dataUrl, rect, session.controller.signal);
    } finally {
      overlay?.showAfterCapture();
    }
  }

  async function captureWholeConversationAssisted(session) {
    notifyProgress({ percent: 7, messageCount: 0, imageCount: 0, status: 'Waiting for assisted visual backup...', running: true });
    const overlay = assistedVisualOverlay(session);
    const signal = session.controller.signal;
    const frames = [];
    const fingerprints = [];
    const maxFrames = 1200;
    const maxEncodedChars = 190 * 1024 * 1024;
    let encodedChars = 0;
    let started = false;
    let captureInFlight = null;
    let lastCaptureAt = 0;
    let lastActivityAt = 0;
    let activitySinceCapture = false;
    let activityEvents = 0;
    let timer = null;
    let settled = false;

    const cleanupFns = [];
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      cleanupFns.push(() => target.removeEventListener(type, handler, options));
    };

    const updateProgress = () => {
      const count = frames.length;
      overlay.setCount(count);
      const percent = Math.min(90, 10 + Math.round(Math.min(1, count / 24) * 75));
      notifyProgress({ percent, messageCount: 0, imageCount: count, status: 'Assisted visual backup is capturing the conversation...', running: true });
    };

    const addCurrentFrame = async (reason = 'auto') => {
      if (!started || settled) return false;
      if (captureInFlight) return captureInFlight;
      if (frames.length >= maxFrames || encodedChars >= maxEncodedChars) {
        overlay.setStatus('Capture limit reached. Finish the PDF now.');
        return false;
      }

      const task = (async () => {
        try {
          overlay.capture.disabled = true;
          overlay.finish.disabled = true;
          overlay.setStatus(reason === 'manual' ? 'Capturing this view…' : 'Capturing…');
          const frame = await captureAssistedVisualViewport(session, overlay);
          const fingerprint = await assistedVisualFingerprint(frame, signal);
          const exact = emergencyFrameSignature(frame);
          const previousExact = frames.length ? emergencyFrameSignature(frames[frames.length - 1]) : '';
          const distance = fingerprints.length ? assistedFingerprintDistance(fingerprint, fingerprints[fingerprints.length - 1]) : 1;
          const duplicate = Boolean(frames.length && (exact === previousExact || distance < 0.006));
          if (!duplicate) {
            frames.push(frame);
            fingerprints.push(fingerprint);
            encodedChars += frame.length;
            overlay.setStatus(`Captured view ${frames.length}. Keep scrolling downward.`);
            updateProgress();
          } else {
            overlay.setStatus('Same view detected and ignored. Scroll farther before the next capture.');
          }
          lastCaptureAt = Date.now();
          activitySinceCapture = false;
          return !duplicate;
        } finally {
          if (!settled) {
            overlay.capture.disabled = false;
            overlay.finish.disabled = false;
          }
        }
      })();
      captureInFlight = task;
      try { return await task; } finally { captureInFlight = null; }
    };

    const markActivity = () => {
      if (!started || settled) return;
      activityEvents += 1;
      activitySinceCapture = true;
      lastActivityAt = Date.now();
    };

    const onKey = (event) => {
      const key = String(event?.key || '');
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(key)) markActivity();
    };

    on(document, 'scroll', markActivity, true);
    on(window, 'wheel', markActivity, { passive: true, capture: true });
    on(window, 'touchmove', markActivity, { passive: true, capture: true });
    on(window, 'keydown', onKey, true);

    const dispose = () => {
      settled = true;
      if (timer) clearInterval(timer);
      for (const fn of cleanupFns.splice(0)) { try { fn(); } catch {} }
      overlay.remove();
    };

    const abortPromise = new Promise((_, reject) => {
      const onAbort = () => reject(makeCancelledError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
    });

    const userPromise = new Promise((resolve, reject) => {
      overlay.start.addEventListener('click', async () => {
        if (started || settled) return;
        started = true;
        overlay.enterCaptureMode();
        overlay.setCount(0);
        overlay.setStatus('Capturing the first view…');
        try {
          await addCurrentFrame('manual');
          overlay.setStatus('First view captured. Scroll downward normally.');
        } catch (error) {
          reject(error);
        }
      });

      overlay.capture.addEventListener('click', () => {
        addCurrentFrame('manual').catch(reject);
      });

      overlay.finish.addEventListener('click', async () => {
        if (!started || settled) return;
        try {
          if (activitySinceCapture && Date.now() - lastCaptureAt > 650) await addCurrentFrame('manual');
          if (!frames.length) {
            overlay.setStatus('No view has been captured yet. Scroll to the beginning and start capture first.');
            return;
          }
          if (activityEvents >= 4 && frames.length < 3) {
            overlay.setStatus('Only a few distinct views were captured. Continue scrolling through the chat before finishing.');
            return;
          }
          resolve({ frames: [...frames], scrollerDescription: 'assisted user scrolling' });
        } catch (error) {
          reject(error);
        }
      });

      const cancel = () => {
        session.cancelled = true;
        try { session.controller.abort(); } catch {}
      };
      overlay.cancel.addEventListener('click', cancel);
      overlay.cancel2.addEventListener('click', cancel);
    });

    timer = setInterval(() => {
      if (!started || settled || !activitySinceCapture || captureInFlight) return;
      const now = Date.now();
      const sinceCapture = now - lastCaptureAt;
      const sinceActivity = now - lastActivityAt;
      // Capture after a short pause, or periodically during continuous real
      // scrolling. The background worker enforces Chrome's hard API quota too.
      if (sinceCapture >= 800 && (sinceActivity >= 160 || sinceCapture >= 1250)) {
        addCurrentFrame('auto').catch(() => {});
      }
    }, 180);

    try {
      const result = await Promise.race([userPromise, abortPromise]);
      if (captureInFlight) await captureInFlight.catch(() => {});
      return result;
    } finally {
      dispose();
    }
  }

  async function captureWholeConversationVisually(session) {
    // v1.8.0 intentionally uses real user scrolling for the emergency archive.
    // Modern chat UIs can virtualize history in ways that ignore programmatic
    // scrollTop changes, so a fully automatic screenshot crawler can repeatedly
    // capture the same viewport while believing it moved. Assisted mode removes
    // that dependency and refuses to silently finish after only duplicate frames.
    return await captureWholeConversationAssisted(session);
  }

  function buildVisualArchiveDocument(frames, title) {
    const imageHtml = frames.map((src, index) => `\n      <section class="visual-page"><img src="${src}" alt="Conversation visual capture ${index + 1}"></section>`).join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #171717; font-family: Arial, sans-serif; }
  .fallback-note { margin: 0 0 5mm; padding: 3mm 4mm; border: 1px solid #d9dde2; border-radius: 7px; background: #f7f8f9; font-size: 9pt; line-height: 1.45; }
  .fallback-note strong { display: block; margin-bottom: 1mm; }
  .fallback-reason { color: #6b7280; font-size: 7.5pt; overflow-wrap: anywhere; }
  .visual-page { margin: 0; padding: 0; break-after: page; page-break-after: always; text-align: center; }
  .visual-page:last-child { break-after: auto; page-break-after: auto; }
  .visual-page img { display: block; width: 100%; height: auto; max-width: 100%; margin: 0 auto; object-fit: contain; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="fallback-note">
    <strong>${escapeHtml(title)} — visual archive fallback</strong>
    <div>This PDF was created from visual captures collected while the conversation was scrolled in the browser. The archive prioritizes completeness over selectable text.</div>
  </div>${imageHtml}
</body>
</html>`;
  }

  async function runVisualArchiveFallback(options, session, semanticFailure) {
    throwIfCancelled(session);
    notifyProgress({ percent: 5, messageCount: 0, imageCount: 0, status: "Opening assisted visual backup...", running: true });
    const title = getConversationTitle() || `${PLATFORM.name} Conversation`;
    const captured = await captureWholeConversationVisually(session);
    throwIfCancelled(session);
    notifyProgress({ percent: 94, messageCount: 0, imageCount: captured.frames.length, status: "Building visual archive PDF...", running: true });
    const html = buildVisualArchiveDocument(captured.frames, title);
    notifyProgress({ percent: 100, messageCount: 0, imageCount: captured.frames.length, status: "Visual archive ready. Opening the print dialog...", running: true });
    await sleepWithAbort(280, session.controller.signal);
    await deliverPrintableDocument(html, title, session);
    throwIfCancelled(session);
    return {
      messageCount: 0,
      imageCount: captured.frames.length,
      platform: PLATFORM.id,
      platformName: PLATFORM.name,
      fallbackMode: "visual"
    };
  }

  async function collectGeminiConversation(scrollContainer, options, session) {
    const signal = session.controller.signal;
    const loadStartedAt = Date.now();
    const maxLoadMs = 35000;
    let stableRounds = 0;
    let previousTurns = -1;
    let iterations = 0;

    notifyProgress({
      percent: 4,
      messageCount: 0,
      imageCount: 0,
      status: "Loading the complete Gemini history...",
      running: true
    });

    // Gemini lazy-loads older history when the chat-history scroller reaches the
    // top. Keep re-sending top=0 until the number of conversation containers is
    // stable for three polls. This is intentionally different from the generic
    // ChatGPT/Claude forward scanner.
    while (Date.now() - loadStartedAt < maxLoadMs) {
      throwIfCancelled(session);
      assertSameConversation(session);
      setScrollTop(scrollContainer, 0);
      await sleepWithAbort(850, signal);

      const turnCount = countGeminiConversationTurns();
      iterations += 1;
      if (turnCount === previousTurns) stableRounds += 1;
      else {
        stableRounds = 0;
        previousTurns = turnCount;
      }

      notifyProgress({
        percent: Math.min(58, 5 + iterations * 4),
        messageCount: turnCount * 2,
        imageCount: 0,
        status: `Loading earlier Gemini turns... ${turnCount} conversation turn${turnCount === 1 ? "" : "s"} loaded`,
        running: true
      });

      if (stableRounds >= 3) break;
    }

    if (stableRounds < 3 && getScrollTop(scrollContainer) > 3) {
      throw new Error(`Gemini history did not finish loading after ${Math.round(maxLoadMs / 1000)} seconds. Export stopped to avoid creating an incomplete PDF.`);
    }

    throwIfCancelled(session);
    assertSameConversation(session);

    const nodes = dedupeNestedMessages(getMessageNodes());
    if (!nodes.length) throw new Error("No Gemini conversation messages were found after loading history.");

    const messages = [];
    const processedMediaKeys = new Set();
    const occurrenceByFingerprint = new Map();
    let imageCount = 0;

    for (let index = 0; index < nodes.length; index += 1) {
      if (index % 3 === 0) await sleepWithAbort(0, signal);
      throwIfCancelled(session);
      const messageNode = nodes[index];
      const role = getMessageRole(messageNode);
      if (role !== "user" && role !== "assistant") continue;
      const turn = findTurnElement(messageNode);
      const meta = getMessageIdentity(messageNode, turn, role, index);
      const baseKey = meta.strongKey || meta.fingerprintKey;
      const occurrence = occurrenceByFingerprint.get(baseKey) || 0;
      occurrenceByFingerprint.set(baseKey, occurrence + 1);
      const key = meta.strongKey ? meta.strongKey : `${meta.fingerprintKey}:occ:${occurrence}`;

      const serialized = await serializeTurn(turn, messageNode, role, options.embedImages, signal);
      imageCount += serialized.imageCount;
      for (const mediaKey of serialized.mediaKeys) processedMediaKeys.add(mediaKey);
      messages.push({
        key,
        role,
        turnIndex: Number.NaN,
        discoveryOrder: messages.length,
        html: serialized.html,
        text: serialized.text,
        imageCount: serialized.imageCount
      });

      notifyProgress({
        percent: 60 + Math.round(((index + 1) / nodes.length) * 30),
        messageCount: messages.length,
        imageCount,
        status: `Capturing Gemini messages... ${messages.length}/${nodes.length}`,
        running: true
      });
    }

    // Sanity check: structural Gemini turns should normally yield two messages
    // each (user + model), except for a still-streaming final turn.
    const structuralTurns = countGeminiConversationTurns();
    if (structuralTurns >= 2 && messages.length < structuralTurns * 1.5) {
      throw new Error(`Gemini exposed ${structuralTurns} conversation turns but only ${messages.length} messages could be captured. Export stopped to avoid an incomplete PDF.`);
    }

    return { messages, imageCount, processedMediaKeys };
  }

  function countGeminiConversationTurns() {
    const containers = document.querySelectorAll('.conversation-container');
    if (containers.length) return containers.length;
    const users = document.querySelectorAll('user-query').length;
    const models = document.querySelectorAll('model-response').length;
    return Math.max(users, models);
  }

  function findGeminiScrollContainer(messageNode) {
    const preferred = [
      document.querySelector('#chat-history'),
      document.querySelector('.chat-history-scroll-container'),
      document.querySelector('infinite-scroller')
    ].filter(Boolean);
    const usable = preferred.find((node) => scrollRange(node) > 40 || getScrollTop(node) > 0);
    if (usable) return usable;
    return findConversationScrollContainer(messageNode);
  }

  async function collectEntireConversation(scrollContainer, options, session) {
    const messages = new Map();
    const processedMediaKeys = new Set();
    const stableSignatures = new Map();
    const precedenceEdges = new Map();
    const positionHints = new Map();
    let imageCount = 0;
    let discoveryCounter = 0;
    let identityCollisions = 0;
    let maxObservedNodes = 0;
    const signal = session.controller.signal;
    const scanStartedAt = Date.now();
    // A fixed two-minute cutoff was too aggressive for legitimate long chats.
    // Stall recovery below is the primary loop guard; this is only a final failsafe.
    const hardScanLimitMs = 10 * 60 * 1000;

    const captureVisibleMessages = async () => {
      throwIfCancelled(session);
      assertSameConversation(session);
      let added = 0;
      const visibleNodes = dedupeNestedMessages(getMessageNodes());
      maxObservedNodes = Math.max(maxObservedNodes, visibleNodes.length);
      const occurrenceByFingerprint = new Map();
      const snapshotKeys = [];

      for (let index = 0; index < visibleNodes.length; index += 1) {
        if (index % 4 === 0) await sleepWithAbort(0, signal);
        throwIfCancelled(session);
        assertSameConversation(session);

        const messageNode = visibleNodes[index];
        const turn = findTurnElement(messageNode);
        const role = getMessageRole(messageNode);
        if (role !== "user" && role !== "assistant") continue;

        const meta = getMessageIdentity(messageNode, turn, role, discoveryCounter);
        let key = "";

        if (meta.strongKey) {
          const knownSignature = stableSignatures.get(meta.strongKey);
          if (!knownSignature) {
            stableSignatures.set(meta.strongKey, meta.signature);
            key = meta.strongKey;
          } else if (knownSignature === meta.signature) {
            key = meta.strongKey;
          } else {
            // A provider reused something that looked like a stable id. Never
            // collapse distinct messages silently; fall back to content identity.
            identityCollisions += 1;
          }
        }

        if (!key) {
          const occurrence = occurrenceByFingerprint.get(meta.fingerprintKey) || 0;
          occurrenceByFingerprint.set(meta.fingerprintKey, occurrence + 1);
          key = `${meta.fingerprintKey}:occ:${occurrence}`;
        }

        snapshotKeys.push(key);
        updatePositionHint(positionHints, key, getMessageOrderHint(messageNode, scrollContainer));

        if (messages.has(key)) {
          const existing = messages.get(key);
          existing.positionHint = readPositionHint(positionHints, key);
          continue;
        }

        const serialized = await serializeTurn(turn, messageNode, role, options.embedImages, signal);
        throwIfCancelled(session);
        assertSameConversation(session);
        imageCount += serialized.imageCount;
        for (const mediaKey of serialized.mediaKeys) processedMediaKeys.add(mediaKey);

        messages.set(key, {
          key,
          role,
          turnIndex: meta.turnIndex,
          discoveryOrder: discoveryCounter++,
          positionHint: readPositionHint(positionHints, key),
          html: serialized.html,
          text: serialized.text,
          imageCount: serialized.imageCount,
          identitySignature: meta.signature
        });
        added += 1;
      }

      recordSnapshotOrder(snapshotKeys, precedenceEdges);
      return added;
    };

    notifyProgress({
      percent: 3,
      messageCount: 0,
      imageCount: 0,
      status: `Moving to the beginning of the ${PLATFORM.name} conversation...`,
      running: true
    });

    // ChatGPT and Claude can prepend older virtualized turns after scrollTop reaches
    // zero. Height alone is not a sufficient signal because some rollouts recycle a
    // fixed-height virtual list. Also track the first visible authored message.
    const topLoadStartedAt = Date.now();
    let previousTopSignature = "";
    let stableTopRounds = 0;
    let topLoadRounds = 0;
    while (stableTopRounds < 3 && topLoadRounds < 40 && Date.now() - topLoadStartedAt < 25000) {
      throwIfCancelled(session);
      assertSameConversation(session);
      setScrollTop(scrollContainer, 0);
      await sleepWithAbort(520, signal);

      const currentNodes = dedupeNestedMessages(getMessageNodes());
      const firstNode = currentNodes.length ? currentNodes[0] : null;
      const firstText = normalizeText(firstNode?.innerText || firstNode?.textContent || "").slice(0, 180);
      const currentHeight = Math.round(getScrollHeight(scrollContainer));
      const atTop = getScrollTop(scrollContainer) <= 4;
      const signature = `${currentHeight}|${currentNodes.length}|${simpleHash(firstText)}`;
      if (atTop && signature === previousTopSignature) stableTopRounds += 1;
      else stableTopRounds = 0;
      previousTopSignature = signature;
      topLoadRounds += 1;

      if (topLoadRounds % 3 === 0) {
        notifyProgress({
          percent: 4,
          messageCount: messages.size,
          imageCount,
          status: `Checking for earlier ${PLATFORM.name} messages...`,
          running: true
        });
      }
    }

    let lastGrowthAt = Date.now();
    let lastProgressAt = Date.now();
    let bottomStableRounds = 0;
    let recoveryAttempts = 0;
    let lastTop = getScrollTop(scrollContainer);
    let lastObservedTop = lastTop;
    let lastObservedHeight = getScrollHeight(scrollContainer);
    let lastRequestedTop = lastTop;
    const maxSteps = PLATFORM.id === "gemini" ? 700 : 1200;

    for (let step = 0; step < maxSteps; step += 1) {
      throwIfCancelled(session);
      assertSameConversation(session);
      if (Date.now() - scanStartedAt > hardScanLimitMs) {
        throw new Error(`The scan exceeded the 10-minute safety limit after finding ${messages.size} messages. Press Stop scan if needed, then retry after refreshing the chat tab.`);
      }

      const added = await captureVisibleMessages();
      if (added > 0) {
        lastGrowthAt = Date.now();
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
      }

      const top = getScrollTop(scrollContainer);
      const height = getScrollHeight(scrollContainer);
      const viewport = getClientHeight(scrollContainer);
      const forwardMotion = top > lastObservedTop + Math.max(28, viewport * 0.025);
      const heightChanged = Math.abs(height - lastObservedHeight) > 12;
      if (forwardMotion || heightChanged) lastProgressAt = Date.now();
      const maxTop = Math.max(0, height - viewport);
      const fraction = maxTop > 0 ? Math.min(1, Math.max(0, top / maxTop)) : 1;
      const physicalBottom = maxTop - top <= Math.max(8, viewport * 0.035);
      const logicalEndVisible = Boolean(ADAPTER.isAtConversationEnd?.(scrollContainer));
      // Use the DOM-visible end only as a fallback when a requested forward scroll
      // is being ignored. This avoids mistaking a virtualized viewport chunk for
      // the true end of a long Gemini/Claude conversation.
      const logicalBottom = logicalEndVisible && lastRequestedTop > top + 60 && (Date.now() - lastProgressAt) > 900;
      const atBottom = physicalBottom || logicalBottom;

      notifyProgress({
        percent: Math.max(5, Math.min(90, 5 + Math.round(fraction * 85))),
        messageCount: messages.size,
        imageCount,
        status: atBottom ? "Checking the end of the conversation..." : `Scanning the full ${PLATFORM.name} conversation...`,
        running: true
      });

      if (atBottom && added === 0) bottomStableRounds += 1;
      else bottomStableRounds = 0;
      if (bottomStableRounds >= (PLATFORM.id === "gemini" ? 2 : 4)) break;

      const noGrowthMs = Date.now() - lastGrowthAt;
      const noProgressMs = Date.now() - lastProgressAt;
      const movedBackwardUnexpectedly = top + Math.max(80, viewport * 0.18) < lastTop && lastRequestedTop > lastTop;

      if (!atBottom && (noProgressMs >= 7500 || (movedBackwardUnexpectedly && noGrowthMs >= 1800))) {
        recoveryAttempts += 1;
        if (recoveryAttempts > 2) {
          throw new Error(
            `The scanner became stuck after finding ${messages.size} messages. It stopped safely instead of looping forever. Retry the export; if it happens again, press Stop scan and refresh the AI chat tab.`
          );
        }

        notifyProgress({
          percent: Math.max(5, Math.min(90, 5 + Math.round(fraction * 85))),
          messageCount: messages.size,
          imageCount,
          status: `No scan progress detected. Recovery attempt ${recoveryAttempts}/2...`,
          running: true
        });

        await recoverForwardScan(scrollContainer, recoveryAttempts, signal);
        lastGrowthAt = Date.now();
        lastProgressAt = Date.now();
        lastTop = getScrollTop(scrollContainer);
        lastObservedTop = lastTop;
        lastObservedHeight = getScrollHeight(scrollContainer);
        lastRequestedTop = lastTop;
        continue;
      }

      lastTop = top;
      lastObservedTop = top;
      lastObservedHeight = height;
      const stepSize = Math.max(320, viewport * (PLATFORM.id === "gemini" ? 0.62 : 0.78));
      const nextTop = Math.min(maxTop, Math.max(top + stepSize, lastRequestedTop + 120));
      lastRequestedTop = nextTop;
      setScrollTop(scrollContainer, nextTop);
      await sleepWithAbort(PLATFORM.id === "gemini" ? 380 : 300, signal);
    }

    throwIfCancelled(session);
    assertSameConversation(session);
    setScrollTop(scrollContainer, getScrollHeight(scrollContainer));
    await sleepWithAbort(650, signal);
    await captureVisibleMessages();

    if (identityCollisions > 0) {
      notifyProgress({
        percent: 92,
        messageCount: messages.size,
        imageCount,
        status: `Resolved ${identityCollisions} message identity collision${identityCollisions === 1 ? "" : "s"} safely...`,
        running: true
      });
    }

    // If a provider exposes several mounted authored message nodes but identity
    // resolution retained suspiciously few, fail loudly instead of creating a
    // silently incomplete PDF.
    if (maxObservedNodes >= 4 && messages.size < Math.ceil(maxObservedNodes * 0.6)) {
      throw new Error(`ChatFolio detected ${maxObservedNodes} mounted message nodes but retained only ${messages.size}. Export was stopped to avoid an incomplete PDF.`);
    }

    for (const [key, message] of messages) {
      message.positionHint = readPositionHint(positionHints, key);
    }

    const ordered = orderCollectedMessages(messages, precedenceEdges);

    // Claude should normally alternate Human/Assistant. A malformed role sequence
    // with equal role counts is a strong signal that virtualization discovery order
    // leaked into the export. Fail safely instead of silently shuffling the chat.
    if (PLATFORM.id === "claude") {
      const users = ordered.filter((item) => item.role === "user").length;
      const assistants = ordered.filter((item) => item.role === "assistant").length;
      const sameRoleAdjacency = ordered.some((item, index) => index > 0 && item.role === ordered[index - 1].role);
      if (users === assistants && users >= 2 && sameRoleAdjacency) {
        throw new Error(`Claude ordering could not be verified safely (${users} user / ${assistants} Claude messages). Please retry once; ChatFolio stopped to avoid exporting messages out of order.`);
      }
    }

    return { messages: ordered, imageCount, processedMediaKeys, identityCollisions };
  }

  async function recoverForwardScan(scrollContainer, attempt, signal) {
    const viewport = getClientHeight(scrollContainer);
    if (attempt === 1) {
      const nodes = dedupeNestedMessages(getMessageNodes());
      const lastNode = nodes[nodes.length - 1];
      try { lastNode?.scrollIntoView({ block: "end", behavior: "auto" }); } catch {}
      await sleepWithAbort(180, signal);
      setScrollTop(scrollContainer, getScrollTop(scrollContainer) + Math.max(420, viewport * 1.15));
      await sleepWithAbort(700, signal);
      return;
    }

    // Second and final recovery: probe the true end once. If virtualization still
    // pulls us backwards, the caller aborts safely rather than entering a loop.
    setScrollTop(scrollContainer, getScrollHeight(scrollContainer));
    await sleepWithAbort(950, signal);
  }

  function getMessageNodes() {
    return ADAPTER.getMessageNodes();
  }

  function sortInDocumentOrder(nodes) {
    return [...new Set(nodes.filter(Boolean))].sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function getMessageOrderHint(messageNode, scrollContainer) {
    try {
      const orderNode = ADAPTER.orderContainer?.(messageNode) || messageNode;
      if (!orderNode?.getBoundingClientRect) return Number.NaN;
      const rect = orderNode.getBoundingClientRect();
      const isElementScroller = scrollContainer && scrollContainer !== document.documentElement && scrollContainer !== document.body;
      const containerRect = isElementScroller ? scrollContainer.getBoundingClientRect?.() : null;
      const viewportTop = containerRect ? containerRect.top : 0;
      const absoluteTop = getScrollTop(scrollContainer) + (rect.top - viewportTop);
      const height = Math.max(1, getScrollHeight(scrollContainer));
      return Math.max(0, absoluteTop / height);
    } catch {
      return Number.NaN;
    }
  }

  function updatePositionHint(store, key, value) {
    if (!Number.isFinite(value)) return;
    const previous = store.get(key) || { values: [] };
    previous.values.push(value);
    if (previous.values.length > 7) previous.values.shift();
    store.set(key, previous);
  }

  function readPositionHint(store, key) {
    const entry = store.get(key);
    if (!entry?.values?.length) return Number.NaN;
    const sorted = [...entry.values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function recordSnapshotOrder(snapshotKeys, edges) {
    const compact = [];
    for (const key of snapshotKeys) {
      if (!key || compact[compact.length - 1] === key) continue;
      compact.push(key);
    }
    for (let i = 0; i < compact.length - 1; i += 1) {
      const from = compact[i];
      const to = compact[i + 1];
      if (from === to) continue;
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    }
  }

  function compareMessageOrderHints(a, b) {
    const aHasIndex = Number.isFinite(a.turnIndex);
    const bHasIndex = Number.isFinite(b.turnIndex);
    if (aHasIndex && bHasIndex && a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
    if (aHasIndex !== bHasIndex) return aHasIndex ? -1 : 1;

    const aHasPosition = Number.isFinite(a.positionHint);
    const bHasPosition = Number.isFinite(b.positionHint);
    if (aHasPosition && bHasPosition && Math.abs(a.positionHint - b.positionHint) > 0.000001) return a.positionHint - b.positionHint;
    if (aHasPosition !== bHasPosition) return aHasPosition ? -1 : 1;
    return a.discoveryOrder - b.discoveryOrder;
  }

  function orderCollectedMessages(messages, precedenceEdges) {
    const items = [...messages.values()];
    if (items.length <= 1) return items;

    // Provider turn indices are authoritative when available for every item.
    if (items.every((item) => Number.isFinite(item.turnIndex))) {
      return items.sort(compareMessageOrderHints);
    }

    const keys = new Set(items.map((item) => item.key));
    const indegree = new Map([...keys].map((key) => [key, 0]));
    const validEdges = new Map();
    for (const [from, tos] of precedenceEdges) {
      if (!keys.has(from)) continue;
      for (const to of tos) {
        if (!keys.has(to) || from === to) continue;
        if (!validEdges.has(from)) validEdges.set(from, new Set());
        if (validEdges.get(from).has(to)) continue;
        validEdges.get(from).add(to);
        indegree.set(to, (indegree.get(to) || 0) + 1);
      }
    }

    const byKey = new Map(items.map((item) => [item.key, item]));
    const ready = [...keys].filter((key) => (indegree.get(key) || 0) === 0)
      .sort((a, b) => compareMessageOrderHints(byKey.get(a), byKey.get(b)));
    const ordered = [];

    while (ready.length) {
      const key = ready.shift();
      ordered.push(byKey.get(key));
      for (const to of validEdges.get(key) || []) {
        const next = (indegree.get(to) || 0) - 1;
        indegree.set(to, next);
        if (next === 0) {
          ready.push(to);
          ready.sort((a, b) => compareMessageOrderHints(byKey.get(a), byKey.get(b)));
        }
      }
    }

    if (ordered.length === items.length) return ordered;

    // A rare virtualization mutation can create contradictory precedence edges.
    // Keep all content and fall back to geometric/provider hints rather than
    // dropping messages or trusting discovery order blindly.
    return items.sort(compareMessageOrderHints);
  }

  function dedupeNestedMessages(nodes) {
    return nodes.filter((node, index) => {
      return !nodes.some((other, otherIndex) => {
        return otherIndex !== index && other.contains(node) && getMessageRole(other) === getMessageRole(node);
      });
    });
  }

  function getMessageRole(messageNode) {
    return ADAPTER.getRole(messageNode);
  }

  function findTurnElement(messageNode) {
    return ADAPTER.findTurn(messageNode) || messageNode;
  }

  function getMessageIdentity(messageNode, turn, role, fallbackOrder) {
    const platformId = PLATFORM.id;
    const platformMeta = ADAPTER.identityMeta?.(messageNode, turn, role) || {};
    const turnIndex = Number.isFinite(platformMeta.turnIndex) ? platformMeta.turnIndex : Number.NaN;

    const explicitCandidates = [
      platformMeta.stableId,
      messageNode.getAttribute?.("data-message-id"),
      messageNode.getAttribute?.("data-response-id"),
      messageNode.id,
      turn?.getAttribute?.("data-message-id"),
      turn?.getAttribute?.("data-response-id"),
      turn?.id
    ].filter(Boolean);

    let stableId = explicitCandidates.find((value) => looksUniqueDomId(value)) || "";
    if (!stableId && Number.isFinite(turnIndex)) stableId = `turn:${turnIndex}`;

    const text = normalizeText(messageNode.innerText || turn?.innerText || "").slice(0, 2400);
    const mediaSignature = [...(turn?.querySelectorAll?.("img") || [])]
      .map((img) => img.currentSrc || img.src || img.getAttribute("alt") || "")
      .join("|")
      .slice(0, 1400);
    const nearbyRaw = ADAPTER.nearbyIdentityText?.(messageNode, turn, role) || "";
    // Context helps distinguish repeated short prompts such as "continue", but
    // including neighboring text for every long message makes fingerprints
    // unstable at virtualization boundaries.
    const nearby = text.length < 80 ? nearbyRaw : "";
    const signature = simpleHash(`${platformId}|${role}|${text}|${mediaSignature}|${nearby}`);
    const fingerprintKey = `${platformId}:${role}:fp:${signature}${text || mediaSignature ? "" : `:${fallbackOrder}`}`;
    const strongKey = stableId ? `${platformId}:${role}:id:${stableId}` : "";

    return { strongKey, fingerprintKey, signature, turnIndex };
  }

  function looksUniqueDomId(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    if (/^(user-message|model-response|assistant-message|human-message|message|response|render|conversation)$/i.test(raw)) return false;
    if (/^(user-query|model-response)$/i.test(raw)) return false;
    // Generic test ids are not unique. Real ids usually contain a numeric/UUID-like
    // suffix or provider-generated token.
    return raw.length >= 8 || /[0-9_-]{3,}/.test(raw);
  }

  function lastMessageNearViewportEnd(nodes, scrollContainer) {
    const filtered = [...nodes].filter(Boolean);
    const last = filtered.length ? filtered[filtered.length - 1] : null;
    if (!last?.getBoundingClientRect) return false;
    const rect = last.getBoundingClientRect();
    const containerRect = scrollContainer && scrollContainer !== document.documentElement && scrollContainer !== document.body
      ? scrollContainer.getBoundingClientRect?.()
      : null;
    const topBoundary = containerRect ? containerRect.top : 0;
    const bottomBoundary = containerRect ? containerRect.bottom : window.innerHeight;
    const visible = rect.bottom > topBoundary + 24 && rect.top < bottomBoundary - 24;
    const nearEnd = rect.bottom <= bottomBoundary + Math.max(80, (bottomBoundary - topBoundary) * 0.16);
    return visible && nearEnd;
  }

  function assertSameConversation(session) {
    if (!session?.sourceUrl) return;
    try {
      const before = new URL(session.sourceUrl);
      const now = new URL(location.href);
      if (before.origin !== now.origin || before.pathname !== now.pathname) {
        session.cancelled = true;
        try { session.controller.abort(); } catch {}
        throw makeCancelledError();
      }
    } catch (error) {
      if (isCancelledError(error)) throw error;
    }
  }

  async function serializeTurn(turn, messageNode, role, embedImages, signal) {
    if (signal?.aborted) throw makeCancelledError();
    const source = turn || messageNode;
    const clone = source.cloneNode(true);
    // Pair original/clone images before any cleanup can remove attachment icons or
    // unwrap media buttons. Indexing two post-cleanup NodeLists can otherwise shift
    // and assign the wrong source URL to a later image.
    const originalImages = [...source.querySelectorAll("img")];
    const clonedImages = [...clone.querySelectorAll("img")];
    const imagePairs = originalImages.slice(0, clonedImages.length).map((sourceImg, index) => ({
      sourceImg,
      cloneImg: clonedImages[index]
    }));

    // Provider UIs can keep alternate/accessible renderings in the DOM and hide
    // them only with site CSS. Those hidden copies become visible when cloned into
    // ChatFolio's standalone print document. Remove elements that are actually
    // hidden in the live Gemini user turn before provider CSS is lost.
    pruneInvisibleProviderClone(source, clone, role);
    await sleepWithAbort(0, signal);

    let embeddedImageCount = 0;
    let meaningfulImageCount = 0;
    const mediaKeys = [];

    // Convert canvas output to ordinary images before pruning the clone.
    const sourceCanvases = [...source.querySelectorAll("canvas")];
    const cloneCanvases = [...clone.querySelectorAll("canvas")];
    for (let i = 0; i < Math.min(sourceCanvases.length, cloneCanvases.length); i += 1) {
      if (i % 4 === 0) await sleepWithAbort(0, signal);
      try {
        const dataUrl = sourceCanvases[i].toDataURL("image/png");
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = sourceCanvases[i].getAttribute("aria-label") || "Conversation image";
        img.classList.add(role === "user" ? "export-user-media" : "export-content-image");
        cloneCanvases[i].replaceWith(img);
        embeddedImageCount += 1;
        meaningfulImageCount += 1;
      } catch {
        cloneCanvases[i].remove();
      }
    }

    // Preserve authored rich content before generic UI cleanup. Writing blocks can be
    // contenteditable regions or same-origin iframes; removing them would leave only
    // their title/subject in the PDF.
    preserveEditableRegions(clone);
    preserveEmbeddedFrames(source, clone);
    clone.querySelectorAll("details").forEach((node) => { node.open = true; });

    // AI chat sites often wrap uploaded screenshots/thumbnails in buttons. If all buttons
    // are removed blindly, media-only user turns become empty. Convert media/attachment
    // buttons to neutral containers before the generic UI cleanup.
    let preservedAttachmentCount = preserveMediaAndAttachmentButtons(clone);
    if (PLATFORM.id === "gemini" && role === "user") {
      preservedAttachmentCount += preserveGeminiSiblingAttachments(messageNode, clone);
    }
    meaningfulImageCount += preservedAttachmentCount;

    for (let i = 0; i < imagePairs.length; i += 1) {
      if (i % 4 === 0) await sleepWithAbort(0, signal);
      const { sourceImg, cloneImg } = imagePairs[i];
      if (!clone.contains(cloneImg)) continue;
      const src = sourceImg.currentSrc || sourceImg.src || sourceImg.getAttribute("src") || "";
      const mediaKey = src || sourceImg.getAttribute("alt") || `image-${i}`;
      mediaKeys.push(mediaKey);

      const imageKind = classifyImage(sourceImg, role);
      cloneImg.classList.add(imageKind);
      if (imageKind === "export-preview-logo") {
        const sourceRef = cloneImg.closest("a, figure");
        if (sourceRef) {
          const refText = normalizeText(sourceRef.textContent || "");
          const refImages = sourceRef.querySelectorAll("img").length;
          if (refText.length <= 90 && refImages <= 1) sourceRef.classList.add("export-source-ref");
        }
      }
      cloneImg.setAttribute("data-export-image-kind", imageKind);
      if (imageKind !== "export-preview-logo") meaningfulImageCount += 1;

      cloneImg.removeAttribute("srcset");
      cloneImg.removeAttribute("sizes");
      cloneImg.setAttribute("loading", "eager");
      cloneImg.setAttribute("decoding", "sync");

      if (!src) continue;

      if (embedImages) {
        const embedded = await sourceToDataUrl(src, signal);
        cloneImg.src = embedded || absoluteUrl(src) || src;
        if (embedded) embeddedImageCount += 1;
      } else {
        cloneImg.src = absoluteUrl(src) || src;
      }
    }

    clone.querySelectorAll("source").forEach((node) => node.remove());

    // Media buttons have already been unwrapped. Remaining buttons are UI chrome.
    const selectorsToRemove = [
      "button",
      "textarea",
      "input",
      "form",
      "nav",
      "aside",
      "video",
      "audio",
      "iframe",
      "script",
      "style",
      "noscript",
      "[contenteditable='true']",
      "[data-testid*='copy']",
      "[data-testid*='thumb']",
      "[data-testid*='feedback']",
      "[data-testid*='action-button']",
      "[class*='turn-action']",
      ".sr-only",
      ".cdk-visually-hidden"
    ];

    clone.querySelectorAll(selectorsToRemove.join(",")).forEach((node) => node.remove());
    clone.querySelectorAll("[aria-hidden='true']").forEach((node) => {
      if (node.querySelector?.("img, picture")) node.removeAttribute("aria-hidden");
      else node.remove();
    });

    // Remove provider action bars and screen-reader-only turn labels that are UI,
    // not authored conversation content.
    clone.querySelectorAll("[data-message-action-bar], [role='toolbar'], [data-testid='action-bar-copy'], .sr-only, .cdk-visually-hidden").forEach((node) => node.remove());
    cleanupProviderArtifacts(clone, role, source);

    const allCloneNodes = [...clone.querySelectorAll("*")];
    for (let i = 0; i < allCloneNodes.length; i += 1) {
      if (i % 120 === 0) await sleepWithAbort(0, signal);
      const node = allCloneNodes[i];
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) node.removeAttribute(attr.name);
        if (name === "contenteditable") node.removeAttribute(attr.name);
      }

      if (node.tagName === "A") {
        const href = node.getAttribute("href");
        const resolved = href ? absoluteUrl(href) : "";
        if (resolved && /^(https?:|mailto:)/i.test(resolved)) {
          node.setAttribute("href", resolved);
        } else {
          node.removeAttribute("href");
        }
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }

      sanitizeInlineLayout(node);
    }

    applyDirectionality(clone);
    removeEmptyUiRemnants(clone);
    trimTrailingEmptyContent(clone);

    // Prefer the authored message subtree when it contains useful content, but keep
    // media/attachment siblings from the whole turn. The full clone is intentionally
    // retained because user screenshots can sit outside the markdown subtree.
    const html = clone.innerHTML.trim();
    const plainText = normalizeText(clone.textContent || messageNode.innerText || source.innerText || "");
    const fallback = escapeHtml(plainText);

    return {
      html: html || `<p dir="auto">${fallback || "[Media-only message]"}</p>`,
      text: plainText,
      imageCount: meaningfulImageCount,
      embeddedImageCount,
      mediaKeys
    };
  }

  function preserveEditableRegions(root) {
    root.querySelectorAll("[contenteditable='true'], [contenteditable='plaintext-only']").forEach((node) => {
      const text = normalizeText(node.textContent || "");
      if (text.length < 2) return;

      node.removeAttribute("contenteditable");
      node.classList.add("export-writing-block");
    });
  }

  function preserveEmbeddedFrames(source, clone) {
    const sourceFrames = [...source.querySelectorAll("iframe")];
    const cloneFrames = [...clone.querySelectorAll("iframe")];

    for (let i = 0; i < Math.min(sourceFrames.length, cloneFrames.length); i += 1) {
      const sourceFrame = sourceFrames[i];
      const cloneFrame = cloneFrames[i];
      let replacement = null;

      try {
        const body = sourceFrame.contentDocument?.body;
        const text = normalizeText(body?.innerText || body?.textContent || "");
        if (body && text.length >= 2) {
          const imported = document.importNode(body, true);
          imported.removeAttribute?.("id");
          imported.classList?.add("export-writing-block", "export-embedded-frame");
          replacement = imported;
        }
      } catch {
        // Cross-origin frames cannot be inspected.
      }

      if (!replacement) {
        const srcdoc = sourceFrame.getAttribute("srcdoc") || "";
        const text = normalizeText(
          srcdoc
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
        );
        if (text.length >= 2) {
          replacement = document.createElement("div");
          replacement.className = "export-writing-block export-embedded-frame";
          replacement.textContent = text;
        }
      }

      if (replacement) cloneFrame.replaceWith(replacement);
    }
  }

  function preserveMediaAndAttachmentButtons(root) {
    let attachmentCount = 0;
    const attachmentPattern = /([^\/\n]+?\.(pdf|docx?|xlsx?|csv|pptx?|zip|txt|md|rtf|mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm))\b/i;

    function makeAttachment(text) {
      const fileMatch = normalizeText(text || "").match(attachmentPattern);
      if (!fileMatch) return null;

      const replacement = document.createElement("div");
      replacement.className = "export-attachment";

      const filename = document.createElement("span");
      filename.className = "export-attachment-name";
      filename.textContent = fileMatch[1].trim();

      const type = document.createElement("span");
      type.className = "export-attachment-type";
      type.textContent = fileMatch[2].toUpperCase();
      replacement.append(filename, type);
      return replacement;
    }

    root.querySelectorAll("button").forEach((button) => {
      const hasMedia = Boolean(button.querySelector("img, picture, canvas"));
      const text = normalizeText(button.innerText || button.textContent || "");
      const attachment = makeAttachment(text);
      const imageFileMatch = text.match(/([^\/\n]+?\.(png|jpe?g|webp|gif|svg))\b/i);

      if (attachment) {
        button.replaceWith(attachment);
        attachmentCount += 1;
        return;
      }

      if (!hasMedia && !imageFileMatch) return;

      const replacement = document.createElement("figure");
      replacement.className = "export-media-wrapper";
      while (button.firstChild) replacement.appendChild(button.firstChild);
      button.replaceWith(replacement);
    });

    // Gemini and other Material-style UIs can expose uploaded files as chips
    // instead of buttons. Only convert candidates with an explicit filename.
    const chipSelectors = [
      '[data-test-id*="file"]', '[data-testid*="file"]',
      '[class*="attachment"]', '[class*="file-chip"]',
      '[class*="file-preview"]', '[class*="uploaded-file"]'
    ].join(',');

    for (const candidate of [...root.querySelectorAll(chipSelectors)]) {
      if (!root.contains(candidate)) continue;
      if (candidate.closest('.export-attachment')) continue;
      const attachment = makeAttachment(candidate.innerText || candidate.textContent || "");
      if (!attachment) continue;

      // Prefer the outermost matching chip so nested labels do not create duplicates.
      const parentMatch = candidate.parentElement?.closest?.(chipSelectors);
      if (parentMatch && root.contains(parentMatch) && makeAttachment(parentMatch.innerText || parentMatch.textContent || "")) continue;

      candidate.replaceWith(attachment);
      attachmentCount += 1;
    }

    return attachmentCount;
  }

  function preserveGeminiSiblingAttachments(messageNode, clone) {
    const container = messageNode?.closest?.('.conversation-container');
    if (!container) return 0;

    const attachmentPattern = /([^\/\n]+?\.(pdf|docx?|xlsx?|csv|pptx?|zip|txt|md|rtf|mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm))\b/i;
    const seen = new Set();
    const existingText = normalizeText(clone.textContent || "").toLowerCase();
    let count = 0;

    const selectors = [
      'button', 'audio', 'video',
      '[data-file-name]', '[data-filename]', '[data-mime-type]', '[data-file-type]', '[mime-type]',
      '[data-test-id*="file"]', '[data-testid*="file"]',
      '[class*="attachment"]', '[class*="file-chip"]', '[class*="file-preview"]', '[class*="uploaded-file"]',
      '[aria-label]', '[title]'
    ].join(',');

    const appendAttachment = (filename, typeLabel, keySource) => {
      const key = String(keySource || filename || typeLabel).toLowerCase();
      if (!key || seen.has(key) || (filename && existingText.includes(String(filename).toLowerCase()))) return false;
      seen.add(key);

      const replacement = document.createElement('div');
      replacement.className = 'export-attachment';
      const name = document.createElement('span');
      name.className = 'export-attachment-name';
      name.textContent = filename || `${String(typeLabel || 'Media').toLowerCase()} attachment`;
      const type = document.createElement('span');
      type.className = 'export-attachment-type';
      type.textContent = String(typeLabel || 'MEDIA').toUpperCase();
      replacement.append(name, type);
      clone.appendChild(replacement);
      count += 1;
      return true;
    };

    for (const candidate of [...container.querySelectorAll(selectors)]) {
      if (messageNode.contains(candidate)) continue;
      if (candidate.closest('model-response')) continue;
      const raw = [
        candidate.getAttribute?.('data-file-name'),
        candidate.getAttribute?.('data-filename'),
        candidate.getAttribute?.('aria-label'),
        candidate.getAttribute?.('title'),
        candidate.currentSrc,
        candidate.src,
        candidate.innerText,
        candidate.textContent
      ].filter(Boolean).join(' ');
      const normalizedRaw = normalizeText(raw);
      const match = normalizedRaw.match(attachmentPattern);
      if (match) {
        appendAttachment(match[1].trim(), match[2], match[1]);
        continue;
      }

      const mime = normalizeText([
        candidate.getAttribute?.('data-mime-type'),
        candidate.getAttribute?.('data-file-type'),
        candidate.getAttribute?.('mime-type'),
        candidate.getAttribute?.('type')
      ].filter(Boolean).join(' ')).toLowerCase();
      const tag = candidate.tagName?.toLowerCase?.() || '';
      const label = normalizedRaw.toLowerCase();
      const isAudio = tag === 'audio' || mime.startsWith('audio/') || /\b(audio|voice|recording)\b/.test(label);
      const isVideo = tag === 'video' || mime.startsWith('video/') || /\bvideo\b/.test(label);
      if (isAudio || isVideo) {
        const type = isAudio ? 'AUDIO' : 'VIDEO';
        appendAttachment('', type, `${type}:${candidate.currentSrc || candidate.src || label.slice(0, 80)}`);
      }
    }
    return count;
  }

  function pruneInvisibleProviderClone(source, clone, role) {
    if (PLATFORM.id !== "gemini" || role !== "user" || !source || !clone) return;

    const sourceNodes = [...source.querySelectorAll("*")];
    const cloneNodes = [...clone.querySelectorAll("*")];
    const count = Math.min(sourceNodes.length, cloneNodes.length);

    // Work backwards so removing a hidden parent does not disturb the stored
    // source/clone index pairs for earlier nodes.
    for (let i = count - 1; i >= 0; i -= 1) {
      const sourceNode = sourceNodes[i];
      const cloneNode = cloneNodes[i];
      if (!cloneNode?.isConnected && !clone.contains(cloneNode)) continue;

      let hidden = sourceNode.hidden || sourceNode.getAttribute?.("aria-hidden") === "true";
      if (!hidden) {
        try {
          const style = window.getComputedStyle(sourceNode);
          hidden = style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
        } catch {
          hidden = false;
        }
      }
      if (hidden) cloneNode.remove();
    }
  }

  function normalizeGeminiComparableText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function geminiLineTokenBag(value) {
    const normalized = String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return [];
    return normalized.split(" ").filter(Boolean);
  }

  function geminiMultisetCoverage(needleTokens, haystackTokens) {
    if (!needleTokens.length || !haystackTokens.length) return 0;
    const counts = new Map();
    for (const token of haystackTokens) counts.set(token, (counts.get(token) || 0) + 1);
    let matched = 0;
    for (const token of needleTokens) {
      const count = counts.get(token) || 0;
      if (!count) continue;
      matched += 1;
      if (count === 1) counts.delete(token);
      else counts.set(token, count - 1);
    }
    return matched / needleTokens.length;
  }

  function dedupeGeminiVisibleUserLines(rawText) {
    const rawLines = String(rawText || "").replace(/\r\n?/g, "\n").split("\n");
    while (rawLines.length && /^(?:you said|you said:)$/i.test(rawLines[0].trim())) rawLines.shift();

    const lines = rawLines.map((line) => line.trim()).filter(Boolean);
    if (lines.length <= 1) return lines.join("\n");

    // Gemini sometimes exposes the same visual sentence twice in adjacent DOM
    // presentation layers. Collapse only adjacent whole-line duplicates; repeated
    // words or repeated phrases inside a line are intentionally left untouched.
    const exactCollapsed = [];
    for (const line of lines) {
      const comparable = normalizeGeminiComparableText(line);
      const previous = exactCollapsed.length
        ? normalizeGeminiComparableText(exactCollapsed[exactCollapsed.length - 1])
        : "";
      if (comparable.length >= 8 && comparable === previous) continue;
      exactCollapsed.push(line);
    }

    if (exactCollapsed.length <= 2) return exactCollapsed.join("\n");

    // Another Gemini rendering pattern creates a synthetic first line that is the
    // concatenation of two genuine lines (often a short English mapping plus a
    // Persian instruction). Because BiDi can reorder the Latin fragment visually,
    // compare token multisets rather than raw character order. Only the FIRST line
    // is eligible for this removal, which keeps the rule conservative.
    const first = exactCollapsed[0];
    const firstTokens = geminiLineTokenBag(first);
    if (firstTokens.length >= 4) {
      const later = exactCollapsed.slice(1, Math.min(exactCollapsed.length, 6));
      let bestCoverage = 0;
      let bestReverseCoverage = 0;
      let bestCombinedLength = 0;
      let foundPair = false;

      for (let i = 0; i < later.length; i += 1) {
        for (let j = i + 1; j < later.length; j += 1) {
          const aTokens = geminiLineTokenBag(later[i]);
          const bTokens = geminiLineTokenBag(later[j]);
          if (!aTokens.length || !bTokens.length) continue;
          const combined = [...aTokens, ...bTokens];
          const coverage = geminiMultisetCoverage(firstTokens, combined);
          const reverseCoverage = geminiMultisetCoverage(combined, firstTokens);
          const combinedLength = later[i].length + later[j].length;
          if (coverage + reverseCoverage > bestCoverage + bestReverseCoverage) {
            bestCoverage = coverage;
            bestReverseCoverage = reverseCoverage;
            bestCombinedLength = combinedLength;
          }
          if (coverage >= 0.88 && reverseCoverage >= 0.82) foundPair = true;
        }
      }

      const plausibleCompositeLength = bestCombinedLength >= first.length * 0.62
        && bestCombinedLength <= first.length * 1.75;
      if (foundPair && plausibleCompositeLength) exactCollapsed.shift();
    }

    return exactCollapsed.join("\n").trim();
  }

  function getGeminiCanonicalUserText(sourceNode) {
    if (!sourceNode) return "";

    // Current Gemini renders each authored user line as .query-text-line. Read
    // those semantic line nodes directly instead of the whole <user-query>.
    // The outer component can contain mirrored/accessible presentation copies
    // that look harmless in Gemini but become visible in a detached print clone.
    const lineNodes = [...sourceNode.querySelectorAll(
      "user-query-content .query-text-line, .query-content .query-text-line, .query-text .query-text-line, p.query-text-line, .query-text-line"
    )];

    const uniqueLines = [];
    const seenNodes = new Set();
    for (const node of lineNodes) {
      if (!node || seenNodes.has(node)) continue;
      if (node.closest?.("model-response")) continue;
      seenNodes.add(node);
      const value = String(node.innerText ?? node.textContent ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\r\n?/g, "\n")
        .trimEnd();
      uniqueLines.push(value);
    }

    if (uniqueLines.length) {
      // Preserve authored line order exactly. Do not deduplicate identical lines
      // here: a user may intentionally repeat a sentence. UI duplicates live in
      // sibling/presentation layers, not in the semantic .query-text-line list.
      return uniqueLines.join("\n").replace(/^\n+|\n+$/g, "");
    }

    // Fallback for older Gemini rollouts that do not expose query-text-line.
    const authored = sourceNode.querySelector?.(
      "user-query-content .query-content .query-text, user-query-content div.query-text, .query-content > .query-text, div.query-text, .query-text"
    );
    const authoredText = String(authored?.innerText ?? authored?.textContent ?? "").trim();
    if (authoredText) return dedupeGeminiVisibleUserLines(authoredText);

    return dedupeGeminiVisibleUserLines(sourceNode.innerText || sourceNode.textContent || "");
  }

  function getGeminiVisibleUserText(sourceNode) {
    return getGeminiCanonicalUserText(sourceNode);
  }

  function reconcileGeminiUserCloneToVisibleSource(root, sourceNode) {
    if (PLATFORM.id !== "gemini" || !root || !sourceNode) return false;

    const visibleText = getGeminiVisibleUserText(sourceNode);
    const visibleComparable = normalizeGeminiComparableText(visibleText);
    if (!visibleComparable) return false;

    const currentComparable = normalizeGeminiComparableText(root.textContent || "");
    if (!currentComparable || currentComparable === visibleComparable) return false;

    // The live element's innerText is our authority for what the user can actually
    // see. Reconcile only when the detached clone has clear extra material. This
    // preserves intentional repeated lines because those repetitions are present in
    // innerText too, while removing hidden preview/accessibility copies that become
    // visible only after cloning.
    const visibleOccurrences = currentComparable.split(visibleComparable).length - 1;
    const clearlyRedundant = (visibleOccurrences >= 1
      && (visibleOccurrences >= 2 || currentComparable.length > visibleComparable.length * 1.08 + 8))
      || currentComparable.length > visibleComparable.length * 1.35 + 12;
    if (!clearlyRedundant) return false;

    const extraSelector = ".export-attachment, .export-media-wrapper, img.export-user-media, img.export-content-image";
    const extras = [...root.querySelectorAll(extraSelector)]
      .filter((node) => !node.parentElement?.closest(extraSelector))
      .map((node) => node.cloneNode(true));

    const visibleBlock = document.createElement("div");
    visibleBlock.className = "export-visible-user-text";
    visibleBlock.textContent = visibleText;
    root.replaceChildren(visibleBlock, ...extras);
    return true;
  }

  function pruneGeminiCompactDuplicate(root) {
    const normalizeComparable = (value) => normalizeText(value || "")
      .replace(/[\u2026.\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Gemini can expose the same user prompt twice: a compact/truncated preview
    // plus the complete authored text. The exact wrapper changes between Gemini
    // rollouts, so inspect TEXT NODES instead of relying only on div/span classes.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest('script, style, .export-attachment, .export-media-wrapper')) continue;
      const raw = normalizeText(node.nodeValue || "");
      if (raw) textNodes.push({ node, raw });
    }

    for (const entry of textNodes) {
      const { node, raw } = entry;
      if (!root.contains(node)) continue;
      if (raw.length < 12 || raw.length > 420) continue;
      if (!/(?:\.\.\.|…)$/.test(raw)) continue;

      const prefix = normalizeComparable(raw);
      if (prefix.length < 10) continue;
      const probe = prefix.slice(0, Math.min(prefix.length, 90));

      const duplicate = textNodes.find((other) => {
        if (other.node === node || !root.contains(other.node)) return false;
        const comparable = normalizeComparable(other.raw);
        if (comparable.length <= prefix.length + 8) return false;
        return comparable.startsWith(prefix) || comparable.startsWith(probe);
      });

      // In some Gemini rollouts the authored prompt is split across several
      // inline text nodes. No single node is longer than the compact preview,
      // so compare the preview with the concatenated text that follows it.
      const index = textNodes.indexOf(entry);
      const following = normalizeComparable(
        textNodes
          .slice(index + 1, index + 14)
          .filter((other) => root.contains(other.node))
          .map((other) => other.raw)
          .join(" ")
      );
      const duplicateAcrossNodes = following.length > prefix.length + 8
        && (following.startsWith(prefix) || following.startsWith(probe));

      if (!duplicate && !duplicateAcrossNodes) continue;
      node.nodeValue = "";
      let parent = node.parentElement;
      // Remove now-empty presentation wrappers, but never climb into the authored
      // full prompt or a media/attachment container.
      for (let depth = 0; parent && parent !== root && depth < 3; depth += 1) {
        if (parent.querySelector('img, picture, canvas, .export-attachment, .export-media-wrapper')) break;
        if (normalizeText(parent.textContent || "")) break;
        const next = parent.parentElement;
        parent.remove();
        parent = next;
      }
    }
  }

  function trimTrailingEmptyContent(root) {
    const meaningfulSelector = 'img, picture, svg, canvas, table, pre, code, math, .export-writing-block, .export-attachment, .export-media-wrapper';

    function empty(node) {
      if (node.nodeType === Node.TEXT_NODE) return !String(node.nodeValue || '').trim();
      if (!(node instanceof Element)) return false;
      if (node.matches(meaningfulSelector) || node.querySelector(meaningfulSelector)) return false;
      if (node.tagName === 'BR') return true;
      return !normalizeText(node.textContent || '');
    }

    let guard = 0;
    while (root.lastChild && guard++ < 40) {
      const last = root.lastChild;
      if (!empty(last)) {
        if (last instanceof Element) {
          let nestedGuard = 0;
          while (last.lastChild && nestedGuard++ < 20 && empty(last.lastChild)) last.lastChild.remove();
        }
        break;
      }
      last.remove();
    }
  }

  function cleanupProviderArtifacts(root, role, sourceNode = null) {
    if (PLATFORM.id !== "gemini") return;

    // Gemini user turns can contain several renderings of the same prompt. Use
    // the semantic .query-text-line nodes from the LIVE page as the canonical
    // authored text, then append already-normalized media/file chips from the
    // clone. This avoids copying compact previews and accessibility mirrors.
    if (role === "user") {
      const canonicalText = getGeminiCanonicalUserText(sourceNode);
      if (canonicalText) {
        const extraSelector = ".export-attachment, .export-media-wrapper, img.export-user-media, img.export-content-image";
        const extras = [...root.querySelectorAll(extraSelector)]
          .filter((node) => !node.parentElement?.closest(extraSelector))
          .map((node) => node.cloneNode(true));
        const canonicalBlock = document.createElement("div");
        canonicalBlock.className = "export-visible-user-text";
        canonicalBlock.textContent = canonicalText;
        root.replaceChildren(canonicalBlock, ...extras);
      } else {
        // Older/experimental Gemini DOMs fall back to the conservative cleanup.
        pruneGeminiCompactDuplicate(root);
        reconcileGeminiUserCloneToVisibleSource(root, sourceNode);
      }
    }

    const unwanted = role === "user"
      ? new Set(["you said", "you said:"])
      : new Set(["gemini said", "gemini said:"]);

    // Gemini includes accessibility/attribution labels inside the authored custom
    // elements. They are useful on screen but duplicate ChatFolio's own role badge.
    // Remove only small leaf nodes that exactly match those labels so authored
    // sentences containing the same words are never touched.
    for (const node of [...root.querySelectorAll("*")]) {
      if (node.children.length) continue;
      const text = normalizeText(node.textContent || "").toLowerCase();
      if (text.length <= 24 && unwanted.has(text)) node.remove();
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const candidates = [];
    while (walker.nextNode() && candidates.length < 12) candidates.push(walker.currentNode);
    for (const textNode of candidates) {
      const value = normalizeText(textNode.nodeValue || "").toLowerCase();
      if (value.length <= 24 && unwanted.has(value)) textNode.nodeValue = "";
    }
  }

  function classifyImage(sourceImg, role) {
    const rect = sourceImg.getBoundingClientRect?.() || { width: 0, height: 0 };
    const renderedWidth = Number(rect.width || 0);
    const renderedHeight = Number(rect.height || 0);
    const naturalWidth = Number(sourceImg.naturalWidth || 0);
    const naturalHeight = Number(sourceImg.naturalHeight || 0);
    const alt = normalizeText(sourceImg.getAttribute("alt") || sourceImg.getAttribute("aria-label") || "").toLowerCase();
    const inButton = Boolean(sourceImg.closest("button"));
    const inExternalLink = Boolean(sourceImg.closest("a[href]"));
    const inSourceContext = Boolean(sourceImg.closest(
      "[data-testid*='source'], [data-testid*='citation'], [class*='source'], [class*='citation'], [class*='reference']"
    ));
    const largeIntrinsic = naturalWidth >= 320 || naturalHeight >= 320;
    const wideRendered = renderedWidth >= 180 || renderedHeight >= 140;
    const likelyUploaded = /uploaded|attachment|image|screenshot|photo|figure|preview/.test(alt);

    const roughlySquare = (() => {
      const w = renderedWidth || naturalWidth;
      const h = renderedHeight || naturalHeight;
      if (!w || !h) return false;
      const ratio = w / h;
      return ratio >= 0.55 && ratio <= 1.8;
    })();

    const renderedTiny = renderedWidth > 0 && renderedHeight > 0 && renderedWidth <= 96 && renderedHeight <= 96;
    const renderedSmall = renderedWidth > 0 && renderedHeight > 0 && renderedWidth <= 150 && renderedHeight <= 150;
    const intrinsicSmall = naturalWidth > 0 && naturalHeight > 0 && naturalWidth <= 256 && naturalHeight <= 256;

    if (role === "user" && (inButton || likelyUploaded || largeIntrinsic || wideRendered)) {
      return "export-user-media";
    }

    // Source favicons/logos can have a large intrinsic bitmap but are rendered tiny.
    // Classify primarily from their rendered size and source/citation context.
    if (
      role !== "user" &&
      roughlySquare &&
      (renderedTiny || (renderedSmall && (inExternalLink || inSourceContext))) &&
      !likelyUploaded
    ) {
      return "export-preview-logo";
    }

    if (inSourceContext && role !== "user" && renderedWidth <= 180 && renderedHeight <= 180 && !likelyUploaded) {
      return "export-preview-logo";
    }

    if (largeIntrinsic && (wideRendered || !inExternalLink)) {
      return "export-content-image";
    }

    if ((inExternalLink && renderedSmall) || (intrinsicSmall && roughlySquare && role === "assistant")) {
      return "export-preview-logo";
    }

    return "export-content-image";
  }

  function sanitizeInlineLayout(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.closest(".katex, .katex-display, math")) return;
    const style = node.getAttribute("style");
    if (!style) return;

    const blocked = new Set([
      "width", "height", "min-width", "min-height", "max-width", "max-height",
      "position", "top", "right", "bottom", "left", "inset", "transform",
      "translate", "scale", "rotate", "overflow", "overflow-x", "overflow-y",
      "text-align", "float", "clear"
    ]);

    for (const prop of [...node.style]) {
      if (blocked.has(prop)) node.style.removeProperty(prop);
    }

    if (!node.getAttribute("style")?.trim()) node.removeAttribute("style");
  }

  function applyDirectionality(root) {
    const blocks = root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, div");
    blocks.forEach((node) => {
      if (node.closest("pre, code, kbd, samp")) return;
      if (node.querySelector(":scope > p, :scope > li, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")) {
        return;
      }
      const dir = inferDirection(node.textContent || "");
      if (dir) node.setAttribute("dir", dir);
    });

    root.querySelectorAll("pre, code, kbd, samp").forEach((node) => {
      node.setAttribute("dir", "ltr");
    });

    root.querySelectorAll("a").forEach((node) => {
      const text = normalizeText(node.textContent || "");
      if (/^(https?:\/\/|www\.|mailto:)/i.test(text)) node.setAttribute("dir", "ltr");
    });
  }

  function isolateMixedDirectionText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);

    for (const textNode of nodes) {
      const parent = textNode.parentElement;
      if (!parent) continue;
      if (parent.closest("pre, code, kbd, samp, script, style, .katex, .katex-display, math")) continue;
      if (parent.tagName === "BDI" || parent.tagName === "BDO") continue;

      const value = textNode.nodeValue || "";
      if (!/[A-Za-z]/.test(value) || !/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(value)) continue;

      const chunks = [];
      let chunk = "";
      let chunkDir = "";

      const strongDir = (char) => {
        if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(char)) return "rtl";
        if (/[A-Za-z0-9]/.test(char)) return "ltr";
        return "";
      };

      for (const char of value) {
        const dir = strongDir(char);
        if (dir && chunkDir && dir !== chunkDir) {
          chunks.push({ dir: chunkDir, text: chunk });
          chunk = char;
          chunkDir = dir;
        } else {
          if (dir && !chunkDir) chunkDir = dir;
          chunk += char;
        }
      }
      if (chunk) chunks.push({ dir: chunkDir || inferDirection(chunk) || "", text: chunk });

      const dirs = new Set(chunks.map((part) => part.dir).filter(Boolean));
      if (dirs.size < 2) continue;

      const fragment = document.createDocumentFragment();
      for (const part of chunks) {
        if (!part.dir) {
          fragment.appendChild(document.createTextNode(part.text));
          continue;
        }
        const bdi = document.createElement("bdi");
        bdi.setAttribute("dir", part.dir);
        bdi.textContent = part.text;
        fragment.appendChild(bdi);
      }
      textNode.replaceWith(fragment);
    }
  }

  function removeEmptyUiRemnants(root) {
    // After provider controls are stripped, citation/action shells can remain as
    // tiny empty pills. Remove only empty leaf-like wrappers; never touch rich
    // content, math, tables, media, or writing blocks.
    const candidates = [...root.querySelectorAll("a, span, div")].reverse();
    for (const node of candidates) {
      if (node.closest("pre, code, table, figure, .katex, .katex-display, math, .export-writing-block, .export-attachment")) continue;
      const text = normalizeText(node.textContent || "");
      const meaningful = node.querySelector("img, picture, svg, canvas, video, audio, table, pre, code, math, input, textarea");
      if (!text && !meaningful && node.children.length === 0) node.remove();
    }
  }

  function inferDirection(value) {
    const text = String(value || "");
    for (const char of text) {
      if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(char)) return "rtl";
      if (/[A-Za-z]/.test(char)) return "ltr";
    }
    return "";
  }

  async function sourceToDataUrl(src, signal) {
    if (!src) return "";
    if (src.startsWith("data:")) return src;
    if (signal?.aborted) throw makeCancelledError();

    const requestController = new AbortController();
    const onOuterAbort = () => requestController.abort();
    const timeoutId = setTimeout(() => requestController.abort(), 12000);
    signal?.addEventListener?.("abort", onOuterAbort, { once: true });

    try {
      const response = await fetch(src, { credentials: "include", cache: "force-cache", signal: requestController.signal });
      if (!response.ok) return "";
      const blob = await response.blob();
      if (signal?.aborted) throw makeCancelledError();
      if (!blob.type.startsWith("image/") || blob.size > 12 * 1024 * 1024) return "";
      return await blobToDataUrl(blob, signal);
    } catch (error) {
      if (signal?.aborted) throw makeCancelledError();
      // Per-image timeout/network failures should not abort the whole conversation.
      return "";
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", onOuterAbort);
    }
  }

  function blobToDataUrl(blob, signal) {
    if (signal?.aborted) return Promise.reject(makeCancelledError());
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
      const onAbort = () => {
        try { reader.abort(); } catch {}
        cleanup();
        reject(makeCancelledError());
      };
      reader.onload = () => { cleanup(); resolve(typeof reader.result === "string" ? reader.result : ""); };
      reader.onerror = () => { cleanup(); resolve(""); };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      reader.readAsDataURL(blob);
    });
  }

  function findConversationScrollContainer(messageNode) {
    let current = messageNode;
    const candidates = [];

    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollable(current)) candidates.push(current);
      current = current.parentElement;
    }

    if (candidates.length) {
      candidates.sort((a, b) => scrollRange(b) - scrollRange(a));
      return candidates[0];
    }

    const main = document.querySelector("main");
    if (main && isScrollable(main)) return main;

    return document.scrollingElement || document.documentElement;
  }

  function isScrollable(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const overflowY = style.overflowY;
    return (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      element.scrollHeight > element.clientHeight + 80
    );
  }

  function scrollRange(element) {
    return Math.max(0, (element?.scrollHeight || 0) - (element?.clientHeight || 0));
  }

  function getScrollTop(element) {
    return Number(element?.scrollTop || 0);
  }

  function setScrollTop(element, value) {
    if (!element) return;
    const top = Math.max(0, Number(value) || 0);
    try {
      element.scrollTo({ top, behavior: "auto" });
    } catch {
      element.scrollTop = top;
    }
  }

  function getScrollHeight(element) {
    return Number(element?.scrollHeight || document.documentElement.scrollHeight || 0);
  }

  function getClientHeight(element) {
    return Number(element?.clientHeight || window.innerHeight || 800);
  }

  function cleanTitle(value, platformName = PLATFORM.name) {
    let text = normalizeText(String(value || ""));
    if (!text) return "";

    const safeName = String(platformName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\s*[|–—-]\\s*${safeName}\\s*$`, "i"), "");
    text = text.replace(new RegExp(`^${safeName}\\s*[|–—-]\\s*`, "i"), "");

    if (String(platformName).toLowerCase() === "claude") {
      // Strip only known Claude header controls when they occur at the title edge.
      const boundaryUi = /(?:upgrade(?:\s+plan)?|free(?:\s+plan)?|share)/i;
      for (let i = 0; i < 6; i += 1) {
        const before = text;
        text = text.replace(new RegExp(`^\\s*${boundaryUi.source}\\s*`, "i"), "");
        text = text.replace(new RegExp(`\\s*${boundaryUi.source}\\s*$`, "i"), "");
        if (text === before) break;
      }
      text = text.replace(/\s*[|–—-]\s*claude\s*$/i, "");
    }

    if (String(platformName).toLowerCase() === "gemini") {
      text = text
        .replace(/^\s*(?:google\s+gemini|gemini(?:\s+google)?)\s*[|–—-]\s*/i, "")
        .replace(/\s*[|–—-]\s*(?:google\s+gemini|gemini(?:\s+google)?)\s*$/i, "");
    }

    return normalizeText(text);
  }

  function getConversationTitle() {
    const custom = ADAPTER.getTitle?.();
    if (custom && custom.trim()) return cleanTitle(custom.trim(), PLATFORM.name);
    return cleanTitle(document.title, PLATFORM.name);
  }

  function sanitizeFontFamily(value) {
    return String(value || "")
      .replace(/[{};<>\n\r]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
  }

  function isVisibleTypographyNode(node) {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
    return true;
  }

  function directTextLength(node) {
    let length = 0;
    for (const child of node?.childNodes || []) {
      if (child.nodeType === Node.TEXT_NODE) length += normalizeText(child.textContent || "").length;
    }
    return length;
  }

  function unquoteFontFamily(value) {
    return String(value || "")
      .trim()
      .replace(/^['\"]|['\"]$/g, "")
      .trim();
  }

  function splitFontFamilies(value) {
    const raw = String(value || "");
    const parts = [];
    let current = "";
    let quote = "";
    for (const ch of raw) {
      if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
        quote = quote ? "" : ch;
        current += ch;
        continue;
      }
      if (ch === "," && !quote) {
        if (current.trim()) parts.push(unquoteFontFamily(current));
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(unquoteFontFamily(current));
    return parts.filter(Boolean);
  }

  function cssQuoteFamily(value) {
    const family = unquoteFontFamily(value).replace(/[\\\"\n\r]/g, " ").trim();
    return family ? `"${family.replace(/"/g, "\\\"")}"` : "";
  }

  function normalizeFamilyKey(value) {
    return unquoteFontFamily(value).replace(/\s+/g, " ").toLowerCase();
  }

  async function familiesWithWebFacesForText(sampleText, signal) {
    const families = [];
    try {
      const seen = new Set();
      for (const face of document.fonts || []) {
        if (signal?.aborted) throw makeCancelledError();
        const family = unquoteFontFamily(face?.family || "");
        const key = normalizeFamilyKey(family);
        if (!family || seen.has(key)) continue;
        seen.add(key);
        families.push(family);
        if (families.length >= 80) break;
      }
    } catch (error) {
      if (isCancelledError(error)) throw error;
    }

    const matches = [];
    for (let index = 0; index < families.length; index += 1) {
      if (signal?.aborted) throw makeCancelledError();
      const family = families[index];
      try {
        const loaded = await Promise.race([
          document.fonts.load(`400 16px ${cssQuoteFamily(family)}`, sampleText),
          sleep(220).then(() => [])
        ]);
        if (Array.isArray(loaded) && loaded.length) matches.push(family);
      } catch {}
      if (index % 8 === 0) await sleepWithAbort(0, signal);
    }
    return matches;
  }

  function familyAppearsInStack(family, stacks) {
    const key = normalizeFamilyKey(family);
    return stacks.some((stack) => splitFontFamilies(stack).some((item) => normalizeFamilyKey(item) === key));
  }

  function choosePreferredWebFamily(matches, stacks) {
    const inStack = matches.find((family) => familyAppearsInStack(family, stacks));
    return inStack || matches[0] || "";
  }

  function collectFontFaceRulesFromCssom(wantedKeys) {
    const found = [];
    const inaccessible = [];
    const seenSheets = new Set();

    const visitSheet = (sheet) => {
      if (!sheet || seenSheets.has(sheet)) return;
      seenSheets.add(sheet);
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        if (sheet.href) inaccessible.push(sheet.href);
        return;
      }
      if (!rules) return;
      for (const rule of rules) {
        try {
          if (typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule) {
            const family = unquoteFontFamily(rule.style.getPropertyValue("font-family"));
            if (wantedKeys.has(normalizeFamilyKey(family))) {
              found.push({ cssText: rule.cssText, baseUrl: rule.parentStyleSheet?.href || sheet.href || location.href });
            }
          } else if (rule.styleSheet) {
            visitSheet(rule.styleSheet);
          } else if (rule.cssRules) {
            for (const nested of rule.cssRules) {
              if (typeof CSSFontFaceRule !== "undefined" && nested instanceof CSSFontFaceRule) {
                const family = unquoteFontFamily(nested.style.getPropertyValue("font-family"));
                if (wantedKeys.has(normalizeFamilyKey(family))) {
                  found.push({ cssText: nested.cssText, baseUrl: nested.parentStyleSheet?.href || sheet.href || location.href });
                }
              }
            }
          }
        } catch {}
      }
    };

    for (const sheet of document.styleSheets || []) visitSheet(sheet);
    return { found, inaccessible: [...new Set(inaccessible)].slice(0, 36) };
  }

  function extractFontFaceBlocks(cssText, wantedKeys, baseUrl) {
    const blocks = [];
    const text = String(cssText || "");
    const re = /@font-face\s*\{[\s\S]*?\}/gi;
    let match;
    while ((match = re.exec(text)) && blocks.length < 40) {
      const block = match[0];
      const familyMatch = block.match(/font-family\s*:\s*([^;}]*)/i);
      const family = unquoteFontFamily(familyMatch?.[1] || "");
      if (wantedKeys.has(normalizeFamilyKey(family))) blocks.push({ cssText: block, baseUrl });
    }
    return blocks;
  }

  function absoluteCssUrls(cssText, baseUrl) {
    return String(cssText || "").replace(/url\(\s*(['\"]?)([^'\")]+)\1\s*\)/gi, (whole, _quote, rawUrl) => {
      const value = String(rawUrl || "").trim();
      if (!value || /^(?:data:|blob:|chrome-extension:)/i.test(value)) return whole;
      try { return `url("${new URL(value, baseUrl || location.href).href}")`; } catch { return whole; }
    });
  }

  function fontUrlsFromCss(cssText) {
    const urls = [];
    String(cssText || "").replace(/url\(\s*(['\"]?)([^'\")]+)\1\s*\)/gi, (_whole, _quote, rawUrl) => {
      const value = String(rawUrl || "").trim();
      if (/^https?:\/\//i.test(value) && !urls.includes(value)) urls.push(value);
      return _whole;
    });
    return urls;
  }

  async function fetchTextResource(url) {
    try {
      const response = await sendRuntimeMessage({ type: "CHATFOLIO_FETCH_TEXT_RESOURCE", url });
      return response?.ok ? String(response.text || "") : "";
    } catch {
      return "";
    }
  }

  async function fetchDataUrlResource(url) {
    try {
      const response = await sendRuntimeMessage({ type: "CHATFOLIO_FETCH_DATA_RESOURCE", url });
      return response?.ok ? String(response.dataUrl || "") : "";
    } catch {
      return "";
    }
  }

  async function captureProviderFontFaces(wantedFamilies, signal) {
    const wantedKeys = new Set(wantedFamilies.map(normalizeFamilyKey).filter(Boolean));
    if (!wantedKeys.size) return { css: "", rules: 0, embeddedResources: 0 };

    const { found, inaccessible } = collectFontFaceRulesFromCssom(wantedKeys);
    const rules = [...found];

    // Some provider stylesheets are cross-origin and CSSOM intentionally hides
    // cssRules. Fetch only those provider stylesheets through the extension service
    // worker, then extract the matching @font-face declarations.
    for (const href of inaccessible) {
      if (signal?.aborted) throw makeCancelledError();
      const cssText = await fetchTextResource(href);
      if (!cssText) continue;
      rules.push(...extractFontFaceBlocks(cssText, wantedKeys, href));
      if (rules.length >= 24) break;
    }

    const unique = [];
    const seen = new Set();
    for (const item of rules) {
      const absolute = absoluteCssUrls(item.cssText, item.baseUrl);
      const key = absolute.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(absolute);
      if (unique.length >= 20) break;
    }

    const resourceCache = new Map();
    let embeddedResources = 0;
    let embeddedBytesEstimate = 0;
    const embeddedRules = [];
    for (const ruleText of unique) {
      if (signal?.aborted) throw makeCancelledError();
      let rewritten = ruleText;
      for (const url of fontUrlsFromCss(ruleText)) {
        if (signal?.aborted) throw makeCancelledError();
        let dataUrl = resourceCache.get(url);
        if (dataUrl === undefined) {
          dataUrl = await fetchDataUrlResource(url);
          resourceCache.set(url, dataUrl || "");
        }
        // Keep the whole font snapshot bounded so a provider with many subsets
        // cannot turn a PDF export into a huge extension message.
        if (dataUrl && embeddedBytesEstimate + dataUrl.length <= 6 * 1024 * 1024) {
          rewritten = rewritten.split(url).join(dataUrl);
          embeddedBytesEstimate += dataUrl.length;
          embeddedResources += 1;
        }
      }
      embeddedRules.push(rewritten);
    }

    return {
      css: embeddedRules.join("\n"),
      rules: embeddedRules.length,
      embeddedResources
    };
  }

  async function detectSourceTypography(signal) {
    const roots = [];
    try {
      const authored = dedupeNestedMessages(getMessageNodes()).slice(-16);
      roots.push(...authored);
    } catch {}
    if (!roots.length) {
      const main = document.querySelector("main");
      if (main) roots.push(main);
      if (document.body) roots.push(document.body);
    }

    const candidates = [];
    const seen = new Set();
    for (const root of roots) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      if (root instanceof HTMLElement) candidates.push(root);
      const descendants = root.querySelectorAll?.("p, li, blockquote, div, span") || [];
      for (const node of descendants) {
        if (candidates.length >= 900) break;
        if (!seen.has(node)) {
          seen.add(node);
          candidates.push(node);
        }
      }
      if (candidates.length >= 900) break;
    }

    const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
    const latinRegex = /[A-Za-z]/;

    const pick = (direction) => {
      let best = null;
      let bestScore = -Infinity;
      for (const node of candidates) {
        if (!isVisibleTypographyNode(node)) continue;
        const text = normalizeText(node.innerText || node.textContent || "");
        if (text.length < 8 || text.length > 1400) continue;
        const hasTarget = direction === "rtl" ? arabicRegex.test(text) : latinRegex.test(text);
        if (!hasTarget) continue;
        const childCount = node.children?.length || 0;
        const direct = directTextLength(node);
        const score = Math.min(text.length, 360) + Math.min(direct, 180) * 1.6 - childCount * 2.4;
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
      return best;
    };

    const read = (node) => {
      const target = node || document.body || document.documentElement;
      if (!target) return null;
      const style = getComputedStyle(target);
      return {
        fontFamily: sanitizeFontFamily(style.fontFamily),
        fontSize: String(style.fontSize || ""),
        fontWeight: String(style.fontWeight || ""),
        lineHeight: String(style.lineHeight || ""),
        letterSpacing: String(style.letterSpacing || "")
      };
    };

    const base = read(document.body || document.documentElement);
    const rtl = read(pick("rtl"));
    const ltr = read(pick("ltr"));
    const stacks = [base?.fontFamily || "", rtl?.fontFamily || "", ltr?.fontFamily || ""];

    // v1.5 intentionally does not copy font files into the extension print page.
    // The primary print path now stays inside the live provider document, where
    // fonts loaded by the provider or by another extension are already present.
    // Keeping the exact computed stacks is both more faithful and more robust.
    if (signal?.aborted) throw makeCancelledError();

    return { base, rtl, ltr, fontFaceCss: "", fontFaceRules: 0, embeddedFontResources: 0 };
  }

  function mergeFontStacks(primary, fallback) {
    const clean = sanitizeFontFamily(primary);
    if (!clean) return fallback;
    const normalizedPrimary = clean.toLowerCase();
    if (normalizedPrimary.includes("system-ui") && normalizedPrimary.includes("sans-serif")) return clean;
    return `${clean}, ${fallback}`;
  }

  function buildPrintableDocument(messages, title, options, totalImageCount, platform, sourceTypography = null) {
    const exportedAt = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());

    const profile = detectDocumentProfile(messages);
    const language = profile.lang;
    const documentDir = profile.dir;
    const isRtlDocument = documentDir === "rtl";
    const layoutMode = options.layoutMode === "compact" ? "compact" : "comfortable";
    const showMessageNumbers = options.showMessageNumbers !== false;
    const systemUiStack = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
    const sourceBaseFont = sourceTypography?.base?.fontFamily || "";
    const sourceRtlFont = sourceTypography?.rtl?.fontFamily || sourceBaseFont;
    const sourceLtrFont = sourceTypography?.ltr?.fontFamily || sourceBaseFont;
    const documentFontStack = mergeFontStacks(isRtlDocument ? sourceRtlFont : sourceLtrFont, systemUiStack);
    const ltrFontStack = mergeFontStacks(sourceLtrFont, systemUiStack);
    const rtlFontStack = mergeFontStacks(sourceRtlFont, systemUiStack);
    const userCount = messages.filter((message) => message.role === "user").length;
    const assistantCount = messages.filter((message) => message.role === "assistant").length;
    const exchanges = groupMessagesIntoExchanges(messages);

    const assistantName = platform?.assistantLabel || platform?.name || "Assistant";
    const platformName = platform?.name || assistantName;
    const translations = {
      fa: {
        conversation: `گفت‌وگوی ${platformName}`,
        messages: "پیام",
        media: "رسانه",
        you: "شما",
        assistant: assistantName,
        message: "پیام",
        exported: "خروجی گرفته‌شده در"
      },
      ar: {
        conversation: `محادثة ${platformName}`,
        messages: "رسالة",
        media: "وسائط",
        you: "أنت",
        assistant: assistantName,
        message: "رسالة",
        exported: "تم التصدير في"
      },
      en: {
        conversation: `${platformName} conversation`,
        messages: "messages",
        media: "media",
        you: "You",
        assistant: assistantName,
        message: "Message",
        exported: "Exported"
      }
    };
    const t = translations[profile.uiLocale] || translations.en;

    let messageNumber = 0;
    const exchangeHtml = exchanges.map((exchange) => {
      const inner = exchange.map((message) => {
        messageNumber += 1;
        const label = message.role === "user" ? t.you : message.role === "assistant" ? t.assistant : message.role;
        const shortClass = (message.text || "").length < 240 && Number(message.imageCount || 0) === 0 ? " message-short" : "";
        const mediaClass = Number(message.imageCount || 0) > 0 ? " has-media" : "";
        const numberHtml = showMessageNumbers
          ? `<span class="message-number">${escapeHtml(t.message)} ${messageNumber}</span>`
          : "";
        return `
          <section class="message ${escapeHtml(message.role)}${shortClass}${mediaClass}">
            <div class="message-meta">
              <span class="role-badge">${escapeHtml(label)}</span>
              ${numberHtml}
            </div>
            <div class="message-body" dir="auto">${message.html}</div>
          </section>
        `;
      }).join("\n");
      return `<article class="exchange">${inner}</article>`;
    }).join("\n");

    const mediaStat = Number(totalImageCount || 0) > 0
      ? `<span class="stat-item"><bdi dir="ltr">${totalImageCount}</bdi><span>${escapeHtml(t.media)}</span></span>`
      : "";
    const statsHtml = isRtlDocument
      ? [
          `<span class="stat-item"><bdi dir="ltr">${messages.length}</bdi><span>${escapeHtml(t.messages)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${userCount}</bdi><span>${escapeHtml(t.you)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${assistantCount}</bdi><bdi dir="ltr">${escapeHtml(t.assistant)}</bdi></span>`,
          mediaStat
        ].join("")
      : [
          `<span class="stat-item"><bdi dir="ltr">${messages.length}</bdi><span>${escapeHtml(t.messages)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${userCount}</bdi><span>from ${escapeHtml(t.you)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${assistantCount}</bdi><span>from ${escapeHtml(t.assistant)}</span></span>`,
          mediaStat
        ].join("");

    return `<!doctype html>
<html lang="${language}" dir="${documentDir}" data-script="${profile.script}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${sourceTypography?.fontFaceCss || ""}

    @page {
      size: A4;
      margin: 15mm 14mm 16mm;
    }

    * { box-sizing: border-box; }

    :root {
      --ink: #171717;
      --muted: #6b7280;
      --line: #e5e7eb;
      --line-soft: #eef0f2;
      --user-bg: #f5f6f7;
      --code-bg: #f6f7f8;
      --accent: #0f8f70;
      --accent-soft: #eaf7f2;
      --font-source: ${documentFontStack};
      --font-latin: ${ltrFontStack};
      --font-rtl-source: ${rtlFontStack};
      --font-arabic-fallback: "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma, Arial, sans-serif;
    }

    html {
      background: #fff;
      color: var(--ink);
      font-family: var(--font-source), var(--font-arabic-fallback);
      font-size: ${layoutMode === "compact" ? "10.1pt" : "10.9pt"};
      line-height: ${layoutMode === "compact" ? "1.52" : "1.62"};
      text-rendering: optimizeLegibility;
    }

    html[dir="rtl"] {
      font-size: ${layoutMode === "compact" ? "10.4pt" : "11.15pt"};
      line-height: ${layoutMode === "compact" ? "1.68" : "1.82"};
    }

    html[data-script="arabic"] {
      /* Match the provider page's own CSS font stack first. Let Chrome choose the
         same glyph-level fallback it uses in the live chat instead of forcing a
         different Arabic font for the entire RTL block. */
      font-family: var(--font-source), var(--font-arabic-fallback);
    }

    html[data-script="hebrew"] {
      font-family: "Noto Sans Hebrew", "Arial Hebrew", Arial, "Segoe UI", sans-serif;
    }

    html[data-script="cjk"] {
      font-family: "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "PingFang SC", "Hiragino Sans", "Yu Gothic", Meiryo, "Microsoft YaHei", "Malgun Gothic", "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.55" : "1.68"};
    }

    html[data-script="devanagari"] {
      font-family: "Noto Sans Devanagari", "Nirmala UI", Mangal, "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.62" : "1.74"};
    }

    html[data-script="thai"] {
      font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.58" : "1.72"};
    }

    body {
      margin: 0;
      background: #fff;
      color: var(--ink);
    }

    .document-header {
      direction: ${documentDir};
      margin: 0 0 18px;
      padding: 0 0 12px;
      border-bottom: 1.5px solid var(--line);
    }

    .document-kicker {
      margin-bottom: 4px;
      color: var(--accent);
      font-size: 8.6pt;
      font-weight: 700;
      letter-spacing: ${isRtlDocument ? "0" : "0.025em"};
    }

    .document-header h1 {
      margin: 0;
      font-size: 20pt;
      line-height: 1.28;
      font-weight: 760;
      overflow-wrap: anywhere;
      unicode-bidi: plaintext;
    }

    .document-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 9px;
      color: var(--muted);
      font-size: 8.45pt;
      direction: ${documentDir};
    }

    .stat-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border: 1px solid #e6e8eb;
      border-radius: 999px;
      background: #fafbfb;
      unicode-bidi: isolate;
      white-space: nowrap;
    }

    .stat-item bdi { font-variant-numeric: tabular-nums; }
    .export-time { color: var(--muted); align-self: center; margin-inline-start: 3px; }

    .exchange {
      margin: 0 0 ${layoutMode === "compact" ? "11px" : "16px"};
      padding: 0 0 ${layoutMode === "compact" ? "8px" : "12px"};
      border-bottom: 1px solid var(--line-soft);
    }

    .exchange:last-child {
      border-bottom: 0;
      margin-bottom: 0;
      padding-bottom: 0;
    }

    main {
      margin: 0;
      padding: 0;
    }

    main > :last-child {
      margin-bottom: 0 !important;
      padding-bottom: 0 !important;
    }

    .message {
      position: relative;
      margin: 0 0 ${layoutMode === "compact" ? "7px" : "10px"};
      break-inside: auto;
      direction: ${documentDir};
    }

    .message:last-child { margin-bottom: 0; }

    .message.user {
      padding: ${layoutMode === "compact" ? "8px 10px" : "10px 12px"};
      background: var(--user-bg);
      border: 1px solid var(--line);
      border-radius: 10px;
    }

    .message.assistant {
      padding: ${layoutMode === "compact" ? "4px 10px 4px 12px" : "5px 11px 5px 14px"};
      border-inline-start: 3px solid var(--accent);
      background: #fff;
    }

    .message.message-short { break-inside: avoid-page; }

    .message-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 20px;
      margin-bottom: ${layoutMode === "compact" ? "4px" : "6px"};
      break-after: avoid-page;
      direction: ${documentDir};
    }

    .role-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 8.3pt;
      font-weight: 730;
      line-height: 1.2;
      white-space: nowrap;
    }

    .user .role-badge {
      background: #e7e9ec;
      color: #40454c;
    }

    .assistant .role-badge {
      background: var(--accent-soft);
      color: #087258;
    }

    .message-number {
      color: #9aa0a6;
      font-size: 7.8pt;
      font-weight: 500;
      white-space: nowrap;
    }

    .message-body {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .message-body [dir="rtl"] {
      text-align: right !important;
      unicode-bidi: plaintext;
      font-family: var(--font-rtl-source), var(--font-arabic-fallback);
    }

    .message-body [dir="ltr"] {
      text-align: left !important;
      unicode-bidi: plaintext;
      font-family: var(--font-latin);
    }

    /* Keep UI labels on the same live-page font stack captured from the provider.
       This mirrors the browser's own glyph fallback for Persian/Arabic instead of
       forcing a separate Arabic family across the whole RTL block. */
    html[dir="rtl"] .document-kicker,
    html[dir="rtl"] .document-stats,
    html[dir="rtl"] .role-badge,
    html[dir="rtl"] .message-number {
      font-family: var(--font-rtl-source), var(--font-arabic-fallback);
    }

    .message-body p,
    .message-body li,
    .message-body blockquote,
    .message-body td,
    .message-body th,
    .message-body figcaption {
      unicode-bidi: plaintext;
    }

    .message-body bdi,
    .message-body code,
    .message-body kbd,
    .message-body samp,
    .message-body a {
      unicode-bidi: isolate;
    }

    .message-body > :first-child {
      margin-top: 0 !important;
      break-before: avoid-page;
    }
    .message-body > :last-child { margin-bottom: 0 !important; }
    .message-body [class] { max-width: 100%; }

    p, ul, ol, blockquote, pre, table, figure {
      margin-top: ${layoutMode === "compact" ? "0.48em" : "0.62em"};
      margin-bottom: ${layoutMode === "compact" ? "0.48em" : "0.62em"};
    }

    p { orphans: 2; widows: 2; }

    ul, ol {
      padding-inline-start: 1.55em;
      margin-inline-start: 0;
    }

    li { padding-inline-start: 0.12em; }
    li + li { margin-top: 0.18em; }

    h1, h2, h3, h4, h5, h6 {
      break-after: avoid;
      margin-top: 0.95em;
      margin-bottom: 0.38em;
      line-height: 1.38;
      font-weight: 740;
      unicode-bidi: plaintext;
    }

    h1 { font-size: 16.8pt; }
    h2 { font-size: 14.3pt; }
    h3 { font-size: 12.6pt; }
    h4, h5, h6 { font-size: 11.4pt; }

    a {
      color: #1f5f95;
      text-decoration: underline;
      text-decoration-thickness: 0.055em;
      text-underline-offset: 0.12em;
      overflow-wrap: anywhere;
    }

    pre {
      direction: ltr !important;
      text-align: left !important;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code-bg);
      border: 1px solid #dfe3e7;
      border-radius: 7px;
      padding: 9px 10px;
      font-size: 8.7pt;
      line-height: 1.48;
      break-inside: auto;
      unicode-bidi: isolate;
    }

    code, kbd, samp {
      direction: ltr;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }

    :not(pre) > code {
      background: #f0f2f4;
      border-radius: 4px;
      padding: 0.08em 0.28em;
    }

    blockquote {
      margin-inline: 0;
      padding-inline: 11px 3px;
      border-inline-start: 3px solid #c5cbd1;
      color: #444;
    }

    table {
      width: 100%;
      max-width: 100%;
      border-collapse: collapse;
      font-size: 9.1pt;
      table-layout: auto;
    }

    thead { display: table-header-group; }
    tr { break-inside: avoid; }

    th, td {
      border: 1px solid #d2d6da;
      padding: 5px 7px;
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    th {
      background: #f3f4f6;
      font-weight: 700;
    }

    img, svg {
      max-width: 100% !important;
      height: auto !important;
      object-fit: contain;
    }

    .export-api-image {
      margin: 10px 0 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .export-api-image img {
      display: block;
    }

    img.export-user-media,
    img.export-content-image {
      display: block;
      width: auto !important;
      max-width: 100% !important;
      max-height: 178mm !important;
      margin: 9px auto;
      border-radius: 6px;
      break-inside: avoid;
    }

    img.export-user-media {
      border: 1px solid #e1e4e7;
    }

    .export-media-wrapper {
      max-width: 100%;
      margin: 8px 0;
      padding: 0;
      break-inside: avoid;
    }

    .export-visible-user-text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      unicode-bidi: plaintext;
    }

    .export-source-ref {
      display: inline-flex !important;
      align-items: center;
      gap: 4px;
      width: auto !important;
      max-width: 100%;
      min-height: 0 !important;
      margin: 3px 3px 3px 0 !important;
      padding: 2px 6px !important;
      border: 1px solid #e1e4e7;
      border-radius: 999px;
      background: #fafafa;
      color: #59606a;
      font-size: 8pt;
      line-height: 1.25;
      vertical-align: middle;
      break-inside: avoid;
    }

    img.export-preview-logo,
    .export-source-ref img {
      display: inline-block !important;
      width: 18px !important;
      height: 18px !important;
      max-width: 18px !important;
      max-height: 18px !important;
      margin: 0 !important;
      border-radius: 4px;
      object-fit: contain;
      vertical-align: middle;
    }

    .export-attachment {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 6px 9px;
      margin: 5px 3px;
      border: 1px solid #dfe3e7;
      border-radius: 8px;
      background: #f8f9fa;
      overflow-wrap: anywhere;
      font-size: 9pt;
      break-inside: avoid;
      direction: ltr;
      text-align: left;
    }

    .export-attachment::before {
      content: "▣";
      color: #7b838c;
      font-size: 8pt;
      flex: 0 0 auto;
    }

    .export-attachment-name {
      min-width: 0;
      overflow-wrap: anywhere;
      font-weight: 620;
    }

    .export-attachment-type {
      flex: 0 0 auto;
      padding: 1px 5px;
      border-radius: 5px;
      background: #eceff2;
      color: #6b7280;
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: .02em;
    }

    .export-writing-block {
      margin: 8px 0;
      padding: 9px 11px;
      border: 1px solid #dfe3e7;
      border-radius: 8px;
      background: #fbfbfc;
      break-inside: auto;
      overflow-wrap: anywhere;
    }

    .export-writing-block > :first-child { margin-top: 0 !important; }
    .export-writing-block > :last-child { margin-bottom: 0 !important; }

    figure {
      max-width: 100%;
      break-inside: avoid;
    }

    figcaption {
      color: var(--muted);
      font-size: 8.5pt;
      margin-top: 4px;
    }

    .katex-display,
    .math-display {
      direction: ltr;
      text-align: center;
      max-width: 100%;
      overflow-wrap: anywhere;
      overflow-x: visible !important;
      break-inside: avoid;
    }

    button, textarea, input, form, nav, aside, video, audio, iframe, script, style {
      display: none !important;
    }

    @media print {
      html, body, main {
        min-height: 0 !important;
        height: auto !important;
        padding-bottom: 0 !important;
        margin-bottom: 0 !important;
      }
      .exchange:last-child, .exchange:last-child .message:last-child, .exchange:last-child .message-body {
        margin-bottom: 0 !important;
        padding-bottom: 0 !important;
      }
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <header class="document-header">
    <div class="document-kicker">${escapeHtml(t.conversation)}</div>
    <h1 dir="auto">${escapeHtml(title)}</h1>
    <div class="document-stats">
      ${statsHtml}
      ${options.includeExportTime ? `<span class="export-time">${escapeHtml(t.exported)} ${escapeHtml(exportedAt)}</span>` : ""}
    </div>
  </header>
  <main>${exchangeHtml}</main>
</body>
</html>`;
  }

  function groupMessagesIntoExchanges(messages) {
    const exchanges = [];
    let current = [];
    let hasAssistant = false;

    for (const message of messages) {
      if (message.role === "user" && current.length && hasAssistant) {
        exchanges.push(current);
        current = [];
        hasAssistant = false;
      }
      current.push(message);
      if (message.role === "assistant") hasAssistant = true;
    }
    if (current.length) exchanges.push(current);
    return exchanges;
  }

  function detectDocumentProfile(messages) {
    const sample = messages.map((message) => message.text || "").join(" ").slice(0, 180000);
    const count = (regex) => (sample.match(regex) || []).length;

    const arabic = count(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g);
    const hebrew = count(/[\u0590-\u05FF\uFB1D-\uFB4F]/g);
    const latin = count(/[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/g);
    const cyrillic = count(/[\u0400-\u052F]/g);
    const greek = count(/[\u0370-\u03FF]/g);
    const han = count(/[\u3400-\u4DBF\u4E00-\u9FFF]/g);
    const kana = count(/[\u3040-\u30FF]/g);
    const hangul = count(/[\uAC00-\uD7AF\u1100-\u11FF]/g);
    const devanagari = count(/[\u0900-\u097F]/g);
    const thai = count(/[\u0E00-\u0E7F]/g);

    const rtlChars = arabic + hebrew;
    const strongLtrChars = latin + cyrillic + greek + han + kana + hangul + devanagari + thai;
    const rtlMessages = messages.filter((message) => inferDirection(message.text || "") === "rtl").length;
    const dir = (
      rtlMessages >= Math.max(2, Math.ceil(messages.length * 0.2)) ||
      (rtlChars > 180 && rtlChars >= strongLtrChars * 0.35)
    ) ? "rtl" : "ltr";

    const hasUrduSpecific = /[ٹڈڑںھہے]/.test(sample);
    const hasPersianSpecific = /[پچژگکی]/.test(sample) && !hasUrduSpecific;

    let lang = "und";
    let uiLocale = "en";
    let script = "latin";

    // Direction and script must not disagree merely because a Persian/Arabic chat
    // contains lots of English identifiers, URLs, code, or pasted technical text.
    // If the document is clearly RTL, choose its RTL script first.
    if (dir === "rtl" && arabic >= 20 && arabic >= hebrew * 0.75) {
      script = "arabic";
      if (hasUrduSpecific) lang = "ur";
      else if (hasPersianSpecific) { lang = "fa"; uiLocale = "fa"; }
      else { lang = "ar"; uiLocale = "ar"; }
    } else if (dir === "rtl" && hebrew >= 20) {
      script = "hebrew";
      lang = "he";
    } else if (arabic >= Math.max(40, latin * 0.18)) {
      script = "arabic";
      if (hasUrduSpecific) lang = "ur";
      else if (hasPersianSpecific) { lang = "fa"; uiLocale = "fa"; }
      else { lang = "ar"; uiLocale = "ar"; }
    } else if (hebrew >= Math.max(40, latin * 0.18)) {
      script = "hebrew";
      lang = "he";
    } else if (hangul >= 40) {
      script = "cjk";
      lang = "ko";
    } else if (kana >= 20) {
      script = "cjk";
      lang = "ja";
    } else if (han >= 50) {
      script = "cjk";
      lang = "zh";
    } else if (devanagari >= 40) {
      script = "devanagari";
      lang = "hi";
    } else if (thai >= 40) {
      script = "thai";
      lang = "th";
    } else if (cyrillic >= 40) {
      script = "cyrillic";
      lang = "und";
    } else if (greek >= 40) {
      script = "greek";
      lang = "el";
    } else if (latin >= 20) {
      script = "latin";
      lang = "en";
    }

    return { lang, dir, uiLocale, script };
  }

  function collectDomDiagnostics() {
    try {
      const main = document.querySelector('main');
      const counts = {
        role: document.querySelectorAll('[data-message-author-role], [data-role="user"], [data-role="assistant"], [data-message-author="user"], [data-message-author="assistant"]').length,
        turns: document.querySelectorAll('section[data-turn], article[data-turn], [data-testid*="conversation-turn"]').length,
        turnKeys: document.querySelectorAll('[data-turn-key]').length,
        userBubbles: document.querySelectorAll('[data-user-message-bubble]').length,
        assistantRoles: document.querySelectorAll('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]').length,
        claude: document.querySelectorAll('[data-test-render-count], [data-testid="user-message"], .font-claude-response').length,
        gemini: document.querySelectorAll('user-query, model-response, .conversation-container').length,
        mainChildren: main?.children?.length || 0
      };
      return `DOM diagnostics: role=${counts.role}, turns=${counts.turns}, turnKeys=${counts.turnKeys}, userBubbles=${counts.userBubbles}, assistantRoles=${counts.assistantRoles}, claude=${counts.claude}, gemini=${counts.gemini}, main=${counts.mainChildren}.`;
    } catch {
      return 'DOM diagnostics unavailable.';
    }
  }

  function makePrintJobId() {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {}
    return `chatfolio-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || String(error)));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function extractPrintableParts(html) {
    const source = String(html || "");
    const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/i);
    const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const htmlMatch = source.match(/<html\b([^>]*)>/i);
    if (!styleMatch || !bodyMatch) throw new Error("The printable document could not be prepared for live-page printing.");

    const attrs = htmlMatch?.[1] || "";
    const readAttr = (name, fallback = "") => {
      const match = attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
      return match?.[1] || fallback;
    };

    return {
      css: styleMatch[1],
      bodyHtml: bodyMatch[1],
      lang: readAttr("lang", document.documentElement.lang || "en"),
      dir: readAttr("dir", document.documentElement.dir || "ltr"),
      script: readAttr("data-script", "latin")
    };
  }

  function scopePrintableCssForShadow(css) {
    let scoped = String(css || "");
    // The generated stylesheet was originally authored for a standalone HTML
    // document. In live-page mode it is mounted in a ShadowRoot, so remap only
    // the document-level selectors while leaving all message selectors intact.
    scoped = scoped.replace(/:root\s*\{/g, ":host {");
    scoped = scoped.replace(/html\[dir="rtl"\]/g, ".chatfolio-live-document[dir=\"rtl\"]");
    scoped = scoped.replace(/html\[data-script="arabic"\]/g, ".chatfolio-live-document[data-script=\"arabic\"]");
    scoped = scoped.replace(/html\[data-script="hebrew"\]/g, ".chatfolio-live-document[data-script=\"hebrew\"]");
    scoped = scoped.replace(/html\[data-script="cjk"\]/g, ".chatfolio-live-document[data-script=\"cjk\"]");
    scoped = scoped.replace(/html\[data-script="devanagari"\]/g, ".chatfolio-live-document[data-script=\"devanagari\"]");
    scoped = scoped.replace(/html\[data-script="thai"\]/g, ".chatfolio-live-document[data-script=\"thai\"]");
    scoped = scoped.replace(/html\s*,\s*body\s*,\s*main/g, ".chatfolio-live-document, .chatfolio-live-body, main");
    scoped = scoped.replace(/(^|\n)(\s*)html\s*\{/g, "$1$2.chatfolio-live-document {");
    scoped = scoped.replace(/(^|\n)(\s*)body\s*\{/g, "$1$2.chatfolio-live-body {");
    return scoped;
  }

  let livePrintTrustedPolicy = null;
  function appendGeneratedHtml(target, html) {
    // The HTML passed here is generated and sanitized by ChatFolio itself. Use a
    // contextual fragment first because it does not require document.write and
    // works in provider pages that enforce strict Trusted Types policies.
    try {
      const range = document.createRange();
      range.selectNodeContents(target);
      const fragment = range.createContextualFragment(String(html || ""));
      target.replaceChildren(fragment);
      return;
    } catch (rangeError) {
      try {
        const tt = globalThis.trustedTypes;
        if (tt && !livePrintTrustedPolicy) {
          livePrintTrustedPolicy = tt.createPolicy("chatfolio-live-print", { createHTML: (value) => value });
        }
        target.innerHTML = livePrintTrustedPolicy ? livePrintTrustedPolicy.createHTML(String(html || "")) : String(html || "");
        return;
      } catch (innerError) {
        throw new Error(`Could not mount the printable conversation in the live page (${innerError?.message || rangeError?.message || "HTML parser blocked"}).`);
      }
    }
  }

  async function waitForLivePrintAssets(shadowRoot, sourceTypography, signal) {
    const images = [...shadowRoot.querySelectorAll("img")];
    if (images.length) {
      await Promise.race([
        Promise.all(images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        })),
        sleepWithAbort(5000, signal)
      ]).catch(() => {});
    }

    // Crucial for interoperability with font/RTL extensions: the Persian font
    // may be a FontFace loaded by another extension and therefore impossible for
    // our extension-origin print page to fetch. In the provider document the
    // already-loaded FontFaceSet is shared with this ShadowRoot, so requesting
    // the exact computed family makes Chrome reuse that same face.
    const families = [
      sourceTypography?.rtl?.fontFamily,
      sourceTypography?.base?.fontFamily,
      sourceTypography?.ltr?.fontFamily
    ].filter(Boolean);
    const sample = "سلام فارسی پژوهش ChatGPT conversation";
    for (const family of families) {
      if (signal?.aborted) throw makeCancelledError();
      try {
        await Promise.race([
          document.fonts.load(`400 16px ${family}`, sample),
          sleepWithAbort(1200, signal)
        ]);
      } catch {}
    }
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, sleepWithAbort(1800, signal)]).catch(() => {});
    }
  }

  async function deliverPrintableDocumentInLivePage(html, title, session) {
    const parts = extractPrintableParts(html);
    const hostId = `chatfolio-live-print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const host = document.createElement("div");
    host.id = hostId;
    host.setAttribute("data-chatfolio-live-print", "true");
    host.setAttribute("lang", parts.lang || document.documentElement.lang || "en");
    host.setAttribute("dir", parts.dir || document.documentElement.dir || "ltr");
    host.setAttribute("data-script", parts.script || "latin");
    host.style.cssText = [
      "position:fixed",
      "left:-300vw",
      "top:0",
      "width:210mm",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-2147483648",
      "background:#fff"
    ].join(";");

    const pageStyle = document.createElement("style");
    pageStyle.setAttribute("data-chatfolio-live-print-style", "true");
    pageStyle.textContent = `
      @page { size: A4; margin: 15mm 14mm 16mm; }
      @media print {
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
          min-height: 0 !important;
          height: auto !important;
          overflow: visible !important;
        }
        body > *:not(#${hostId}) { display: none !important; }
        body::before, body::after { display: none !important; content: none !important; }
        #${hostId} {
          display: block !important;
          position: static !important;
          left: auto !important;
          top: auto !important;
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          height: auto !important;
          min-height: 0 !important;
          visibility: visible !important;
          pointer-events: auto !important;
          z-index: auto !important;
          overflow: visible !important;
          transform: none !important;
          opacity: 1 !important;
          background: #fff !important;
        }
      }
    `;

    let cleaned = false;
    const originalTitle = document.title;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { window.removeEventListener("afterprint", cleanup); } catch {}
      try { host.remove(); } catch {}
      try { pageStyle.remove(); } catch {}
      try { document.title = originalTitle; } catch {}
    };

    try {
      // Do not use a ShadowRoot here. Chromium can omit a shadow tree from the
      // print layout when the host is swapped in only for @media print, which
      // produced a one-page blank PDF on ChatGPT. Keeping the printable tree in
      // the provider document's light DOM preserves the provider FontFaceSet
      // (including fonts loaded by RTL/font extensions) and is reliably printed.
      const style = document.createElement("style");
      style.setAttribute("data-chatfolio-print-document-style", "true");
      style.textContent = scopePrintableCssForShadow(parts.css);
      host.appendChild(style);

      const docRoot = document.createElement("div");
      docRoot.className = "chatfolio-live-document";
      docRoot.lang = parts.lang;
      docRoot.dir = parts.dir;
      docRoot.dataset.script = parts.script;
      const body = document.createElement("div");
      body.className = "chatfolio-live-body";
      appendGeneratedHtml(body, parts.bodyHtml);
      docRoot.appendChild(body);
      host.appendChild(docRoot);

      document.documentElement.appendChild(pageStyle);
      document.body.appendChild(host);
      document.title = title || originalTitle || `${PLATFORM.name} Conversation`;

      // Force layout before entering print mode. This also verifies that the
      // generated conversation is actually mounted and non-empty.
      const mountedText = String(docRoot.innerText || "").trim();
      const mountedMedia = docRoot.querySelector("img, svg, canvas, video, audio");
      if (!mountedText && !mountedMedia) {
        throw new Error("The printable conversation mounted without any visible content.");
      }
      void host.offsetHeight;

      await waitForLivePrintAssets(host, session.sourceTypography || null, session.controller.signal);
      throwIfCancelled(session);

      window.addEventListener("afterprint", cleanup, { once: true });
      window.focus();
      window.print();
      // Chromium normally blocks here until the dialog closes. Keep a generous
      // fallback cleanup for browsers where afterprint is delayed or omitted.
      setTimeout(cleanup, 2500);
      return true;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function deliverPrintableDocumentViaExtensionPage(html, title, session) {
    const jobId = makePrintJobId();
    const memory = clampNumber(navigator.deviceMemory || 4, 1, 32);
    const chunkSize = memory >= 8 ? 512 * 1024 : (memory >= 4 ? 384 * 1024 : 256 * 1024);
    const totalChunks = Math.max(1, Math.ceil(html.length / chunkSize));
    let began = false;

    try {
      const begin = await sendRuntimeMessage({
        type: 'CHATFOLIO_PRINT_BEGIN',
        jobId,
        title: String(title || `${PLATFORM.name} Conversation`),
        platform: PLATFORM.id,
        platformName: PLATFORM.name,
        totalChunks,
        sourceUrl: location.href
      });
      if (!begin?.ok) throw new Error(begin?.error || 'Could not open the ChatFolio print view.');
      began = true;

      const indices = Array.from({ length: totalChunks }, (_value, index) => index);
      await mapWithConcurrency(indices, async (index) => {
        throwIfCancelled(session);
        const chunk = html.slice(index * chunkSize, (index + 1) * chunkSize);
        const response = await sendRuntimeMessage({ type: 'CHATFOLIO_PRINT_CHUNK', jobId, index, data: chunk });
        if (!response?.ok) throw new Error(response?.error || `Could not transfer print data (${index + 1}/${totalChunks}).`);
        return true;
      }, {
        concurrency: adaptiveTransferConcurrency(),
        signal: session.controller.signal
      });

      throwIfCancelled(session);
      const end = await sendRuntimeMessage({ type: 'CHATFOLIO_PRINT_END', jobId });
      if (!end?.ok) throw new Error(end?.error || 'Could not finalize the ChatFolio print view.');
    } catch (error) {
      if (began) {
        try { await sendRuntimeMessage({ type: 'CHATFOLIO_PRINT_ABORT', jobId }); } catch {}
      }
      throw error;
    }
  }

  async function deliverPrintableDocument(html, title, session) {
    // Stable print path: always render in ChatFolio's own extension page.
    // Live-page printing was removed because provider pages can reject or hide
    // the mounted print document, which created noisy extension errors even when
    // the fallback PDF was generated successfully.
    await deliverPrintableDocumentViaExtensionPage(html, title, session);
  }

  async function waitForPrintDocument(printWindow) {
    const doc = printWindow.document;

    if (doc.readyState !== "complete") {
      await Promise.race([
        new Promise((resolve) => printWindow.addEventListener("load", resolve, { once: true })),
        sleep(1800)
      ]);
    }

    const images = [...doc.images];
    if (images.length) {
      await Promise.race([
        Promise.all(images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        })),
        sleep(4500)
      ]);
    }

    if (doc.fonts?.ready) {
      await Promise.race([doc.fonts.ready, sleep(1200)]).catch(() => {});
    }

    await sleep(350);
  }

  function absoluteUrl(value) {
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function notifyProgress(payload) {
    if (activeExport) {
      if (Number.isFinite(payload.percent)) activeExport.percent = payload.percent;
      if (Number.isFinite(payload.messageCount)) activeExport.messageCount = payload.messageCount;
      if (Number.isFinite(payload.imageCount)) activeExport.imageCount = payload.imageCount;
      if (payload.status) activeExport.status = payload.status;
    }

    try {
      const maybePromise = chrome.runtime.sendMessage({
        type: "CHATFOLIO_PROGRESS",
        ...payload
      });
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch {
      // The popup can close while the export continues; progress is optional.
    }
  }

  function makeCancelledError() {
    const error = new Error("Scan stopped by user.");
    error.name = "AbortError";
    error.code = "CHATGPT_PDF_CANCELLED";
    return error;
  }

  function isCancelledError(error) {
    return error?.code === "CHATGPT_PDF_CANCELLED" || error?.name === "AbortError";
  }

  function throwIfCancelled(session) {
    if (session?.cancelled || session?.controller?.signal?.aborted) throw makeCancelledError();
  }

  function sleepWithAbort(ms, signal) {
    if (signal?.aborted) return Promise.reject(makeCancelledError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(makeCancelledError());
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function simpleHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
