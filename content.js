(() => {
  // ChatFolio is injected on demand. Do not use a persistent global "already
  // injected" flag: after an extension Reload that flag can outlive the old,
  // invalid runtime listener and cause a permanent "Receiving end does not
  // exist" loop on an already-open tab.
  let exportInProgress = false;
  let activeExport = null;
  const PLATFORM = detectPlatform();
  const ADAPTER = createPlatformAdapter(PLATFORM);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHATFOLIO_PING") {
      sendResponse({ ok: true, version: "0.8.0", platform: PLATFORM.id, platformName: PLATFORM.name });
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

    if (message?.type !== "EXPORT_CHATFOLIO_PDF") return;

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
      showMessageNumbers: message.showMessageNumbers !== false
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
    if (platform.id === "claude") {
      return {
        getMessageNodes() {
          // Live Claude conversations are virtualized. Current UIs wrap rendered
          // turns in [data-test-render-count] containers, but the attribute value
          // itself is a render-state counter, NOT a stable message id. Use those
          // wrappers only to recover the visual/chronological sibling order.
          const turnContainers = [...document.querySelectorAll('[data-test-render-count]')]
            .filter((node) => !node.parentElement?.closest?.('[data-test-render-count]'))
            .filter((node) => !node.closest('nav, aside, [role="dialog"], [role="menu"]'));

          const structural = [];
          for (const turn of turnContainers) {
            const user = turn.querySelector('[data-testid="user-message"], [data-user-message-bubble="true"]');
            if (user) {
              structural.push(user);
              continue;
            }

            // Prefer the response wrapper so multi-block/tool-use answers remain
            // one assistant message. Fall back to the response body/message class.
            const assistant = turn.querySelector('.font-claude-response, .font-claude-response-body, .font-claude-message, [data-testid="ai-message"], [data-testid="message-assistant"]');
            if (assistant) structural.push(assistant);
          }
          if (structural.length >= 2) return structural;

          const users = [...document.querySelectorAll('[data-testid="user-message"], [data-user-message-bubble="true"]')];
          let assistants = [...document.querySelectorAll('.font-claude-response')];
          if (!assistants.length) assistants = [...document.querySelectorAll('.font-claude-response-body')];
          if (!assistants.length) assistants = [...document.querySelectorAll('.font-claude-message, [data-testid="ai-message"], [data-testid="message-assistant"]')];
          return sortInDocumentOrder([...users, ...assistants])
            .filter((node) => !node.closest('nav, aside, [role="dialog"], [role="menu"]'));
        },
        getRole(node) {
          return node.matches('[data-testid="user-message"], [data-user-message-bubble="true"]') || Boolean(node.closest('[data-testid="user-message"], [data-user-message-bubble="true"]')) ? "user" : "assistant";
        },
        findTurn(node) {
          // Keep serialization scoped to the authored body. The surrounding
          // render-count wrapper contains headings/action chrome that can duplicate
          // labels in the PDF.
          return node;
        },
        orderContainer(node) {
          return node.closest('[data-test-render-count]') || node;
        },
        identityMeta(node) {
          const explicit = node.getAttribute('data-message-id') || node.id || "";
          return { stableId: looksUniqueDomId(explicit) ? explicit : "", turnIndex: Number.NaN };
        },
        nearbyIdentityText(node) {
          const holder = node.closest('[data-test-render-count]') || node.parentElement;
          const prev = holder?.previousElementSibling;
          const next = holder?.nextElementSibling;
          return normalizeText(`${prev?.innerText || ""}|${next?.innerText || ""}`).slice(0, 500);
        },
        getTitle() {
          // Prefer the browser title when it contains the conversation title. Claude's
          // visible header can also contain account/share controls such as
          // "Free plan", "Upgrade", and "Share".
          const browserTitle = cleanTitle(document.title, "Claude");
          if (browserTitle && browserTitle.toLowerCase() !== "claude") return browserTitle;

          const header = document.querySelector('[data-testid="chat-header"], [data-testid="page-header"], [data-testid="chat-title-split"]');
          const heading = header?.querySelector('h1, h2, [data-testid*="title"], [data-test-id*="title"]');
          const headingText = cleanTitle(normalizeText(heading?.innerText || heading?.textContent || ""), "Claude");
          if (headingText && headingText.toLowerCase() !== "claude") return headingText;

          const headerText = cleanTitle(normalizeText(header?.innerText || header?.textContent || ""), "Claude");
          if (headerText && headerText.toLowerCase() !== "claude") return headerText;
          return "Claude Conversation";
        },
        isAtConversationEnd(scrollContainer) {
          return lastMessageNearViewportEnd(this.getMessageNodes(), scrollContainer);
        }
      };
    }

    if (platform.id === "gemini") {
      return {
        getMessageNodes() {
          // Gemini's reliable structure is one conversation container containing
          // a <user-query> and a <model-response>. Restrict extraction to those
          // authored components so source panes, nested markdown, and composer UI
          // are never counted as extra messages.
          const containers = [...document.querySelectorAll('.conversation-container')]
            .filter((node) => !node.parentElement?.closest?.('.conversation-container'));
          const structural = [];
          for (const container of containers) {
            const user = container.querySelector('user-query');
            const model = container.querySelector('model-response');
            if (user) structural.push(user);
            if (model) structural.push(model);
          }
          if (structural.length) return sortInDocumentOrder(structural);

          let primary = [...document.querySelectorAll('user-query, model-response')]
            .filter((node) => !node.closest('nav, aside, [role="dialog"], [role="menu"]'));
          primary = primary.filter((node, index) => !primary.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
          if (primary.length) return sortInDocumentOrder(primary);

          const users = [...document.querySelectorAll('.user-query, [data-message-author="user"]')];
          const assistants = [...document.querySelectorAll('.model-response, [data-message-author="assistant"]')];
          return sortInDocumentOrder([...users, ...assistants])
            .filter((node) => !node.closest('nav, aside, [role="dialog"], [role="menu"]'));
        },
        getRole(node) {
          const tag = node.tagName?.toLowerCase?.() || "";
          if (tag === 'user-query' || node.matches('.user-query, [data-message-author="user"]') || node.closest('user-query')) return "user";
          return "assistant";
        },
        findTurn(node) {
          return node.closest('user-query, model-response') || node;
        },
        identityMeta(node, turn) {
          const candidate = turn || node;
          const explicit = candidate.getAttribute?.('data-message-id') || candidate.getAttribute?.('data-response-id') || candidate.getAttribute?.('data-id') || candidate.id || "";
          return { stableId: looksUniqueDomId(explicit) ? explicit : "", turnIndex: Number.NaN };
        },
        nearbyIdentityText(node) {
          const container = node.closest('.conversation-container');
          const prev = container?.previousElementSibling;
          const next = container?.nextElementSibling;
          return normalizeText(`${prev?.innerText || ""}|${next?.innerText || ""}`).slice(0, 500);
        },
        getTitle() {
          const title = cleanTitle(document.title, "Gemini");
          if (title && title.toLowerCase() !== "gemini") return title;
          const candidate = document.querySelector('[data-test-id="conversation-title"], [data-testid="conversation-title"], main h1');
          return normalizeText(candidate?.innerText || candidate?.textContent || "") || "Gemini Conversation";
        },
        isAtConversationEnd(scrollContainer) {
          return lastMessageNearViewportEnd(this.getMessageNodes(), scrollContainer);
        }
      };
    }

    return {
      getMessageNodes() {
        return [...document.querySelectorAll('[data-message-author-role], [data-role="user"], [data-role="assistant"]')];
      },
      getRole(node) {
        return node.getAttribute('data-message-author-role') || node.getAttribute('data-role') || "unknown";
      },
      findTurn(node) {
        return node.closest('[data-testid^="conversation-turn-"]') || node.closest('article') || node;
      },
      identityMeta(node, turn) {
        const testId = turn?.getAttribute?.('data-testid') || "";
        const match = testId.match(/conversation-turn-(\\d+)/i);
        return { stableId: "", turnIndex: match ? Number(match[1]) : Number.NaN };
      },
      nearbyIdentityText() { return ""; },
      getTitle() { return document.title; }
    };
  }

  async function exportConversation(options, session) {
    throwIfCancelled(session);
    if (PLATFORM.id === "unsupported") throw new Error("This page is not supported by ChatFolio.");
    const initialNodes = getMessageNodes();
    if (!initialNodes.length) {
      throw new Error(`No ${PLATFORM.name} conversation messages were found on this page. Open a conversation and try again.`);
    }

    const scrollContainer = PLATFORM.id === "gemini"
      ? findGeminiScrollContainer(initialNodes[0])
      : findConversationScrollContainer(initialNodes[0]);
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

    let collected;
    try {
      collected = PLATFORM.id === "gemini"
        ? await collectGeminiConversation(scrollContainer, options, session)
        : await collectEntireConversation(scrollContainer, options, session);
      throwIfCancelled(session);
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

    if (!collected.messages.length) {
      throw new Error("The full-chat scan did not find any messages.");
    }

    notifyProgress({
      percent: 94,
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      status: "Building the printable document...",
      running: true
    });
    throwIfCancelled(session);

    const title = getConversationTitle() || `${PLATFORM.name} Conversation`;
    const printableHtml = buildPrintableDocument(
      collected.messages,
      title,
      options,
      collected.imageCount,
      PLATFORM
    );

    throwIfCancelled(session);
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      throw new Error("The browser blocked the print window. Allow pop-ups for this AI chat site and try again.");
    }

    try {
      printWindow.history.replaceState(null, "", `${location.origin}/`);
    } catch {}

    printWindow.document.open();
    printWindow.document.write(printableHtml);
    printWindow.document.close();

    notifyProgress({
      percent: 97,
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      status: "Waiting for images and layout before printing...",
      running: true
    });

    await waitForPrintDocument(printWindow);
    throwIfCancelled(session);

    notifyProgress({
      percent: 100,
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      status: "Full scan complete. Opening the print dialog...",
      running: true
    });

    printWindow.focus();
    printWindow.print();

    return {
      messageCount: collected.messages.length,
      imageCount: collected.imageCount,
      platform: PLATFORM.id,
      platformName: PLATFORM.name
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

    let previousHeight = -1;
    let stableTopRounds = 0;
    for (let i = 0; i < 8 && stableTopRounds < 2; i += 1) {
      throwIfCancelled(session);
      assertSameConversation(session);
      setScrollTop(scrollContainer, 0);
      await sleepWithAbort(420, signal);
      const currentHeight = getScrollHeight(scrollContainer);
      const atTop = getScrollTop(scrollContainer) <= 3;
      if (atTop && Math.abs(currentHeight - previousHeight) < 3) stableTopRounds += 1;
      else stableTopRounds = 0;
      previousHeight = currentHeight;
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
      if (!key || compact.at(-1) === key) continue;
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
    const last = [...nodes].filter(Boolean).at(-1);
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
      "[aria-hidden='true']:not(:has(img)):not(:has(picture))",
      "[data-testid*='copy']",
      "[data-testid*='thumb']",
      "[data-testid*='feedback']",
      "[data-testid*='action-button']",
      "[class*='turn-action']",
      ".sr-only"
    ];

    clone.querySelectorAll(selectorsToRemove.join(",")).forEach((node) => node.remove());
    clone.querySelectorAll("[aria-hidden='true']").forEach((node) => node.removeAttribute("aria-hidden"));

    // Remove provider action bars and screen-reader-only turn labels that are UI,
    // not authored conversation content.
    clone.querySelectorAll("[data-message-action-bar], [role='toolbar'], [data-testid='action-bar-copy'], .sr-only").forEach((node) => node.remove());
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

      const replacement = document.createElement("div");
      replacement.className = "export-writing-block";
      replacement.innerHTML = node.innerHTML;
      node.replaceWith(replacement);
    });
  }

  function preserveEmbeddedFrames(source, clone) {
    const sourceFrames = [...source.querySelectorAll("iframe")];
    const cloneFrames = [...clone.querySelectorAll("iframe")];

    for (let i = 0; i < Math.min(sourceFrames.length, cloneFrames.length); i += 1) {
      const sourceFrame = sourceFrames[i];
      const cloneFrame = cloneFrames[i];
      let html = "";
      let text = "";

      try {
        const body = sourceFrame.contentDocument?.body;
        if (body) {
          html = body.innerHTML || "";
          text = normalizeText(body.innerText || body.textContent || "");
        }
      } catch {
        // Cross-origin frames cannot be inspected. Fall back to srcdoc below.
      }

      if (!text) {
        const srcdoc = sourceFrame.getAttribute("srcdoc") || "";
        if (srcdoc) {
          try {
            const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
            html = parsed.body?.innerHTML || "";
            text = normalizeText(parsed.body?.textContent || "");
          } catch {
            // Ignore malformed srcdoc.
          }
        }
      }

      if (text.length >= 2 && html) {
        const replacement = document.createElement("div");
        replacement.className = "export-writing-block export-embedded-frame";
        replacement.innerHTML = html;
        cloneFrame.replaceWith(replacement);
      }
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

  function buildPrintableDocument(messages, title, options, totalImageCount, platform) {
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
    }

    html {
      background: #fff;
      color: var(--ink);
      font-family: Inter, "Segoe UI", Roboto, Arial, "Noto Sans", sans-serif;
      font-size: ${layoutMode === "compact" ? "10.1pt" : "10.9pt"};
      line-height: ${layoutMode === "compact" ? "1.52" : "1.62"};
      text-rendering: optimizeLegibility;
    }

    html[dir="rtl"] {
      font-size: ${layoutMode === "compact" ? "10.4pt" : "11.15pt"};
      line-height: ${layoutMode === "compact" ? "1.68" : "1.82"};
    }

    html[data-script="arabic"] {
      font-family: "Noto Sans Arabic", "Noto Naskh Arabic", Vazirmatn, "Segoe UI", Tahoma, Arial, sans-serif;
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
    }

    .message-body [dir="ltr"] {
      text-align: left !important;
      unicode-bidi: plaintext;
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

    if (arabic >= Math.max(40, latin * 0.18)) {
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
