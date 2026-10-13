/**
 * Gemini history and message capture adapter (phase 3B3).
 *
 * No network calls and no print/UI dependencies. All mutable scroll state,
 * media serialization, cancellation and progress are explicitly supplied by
 * the caller; the scanner does not persist data across scanning sessions.
 */
export function createGeminiHistoryScanner({
  documentRef, now = () => Date.now(),
  notifyProgress, throwIfCancelled, assertSameConversation,
  setScrollTop, getScrollTop, scrollRange, sleepWithAbort,
  getMessageNodes, dedupeNestedMessages, getMessageRole,
  findTurnElement, getMessageIdentity, serializeTurn,
  assertProviderUserImagesCaptured, findConversationScrollContainer
}) {
    async function collectGeminiConversation(scrollContainer, options, session) {
      const signal = session.controller.signal;
      const loadStartedAt = now();
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
      while (now() - loadStartedAt < maxLoadMs) {
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
        assertProviderUserImagesCaptured(serialized, role, options.embedImages);
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
      const containers = documentRef.querySelectorAll('.conversation-container');
      if (containers.length) return containers.length;
      const users = documentRef.querySelectorAll('user-query').length;
      const models = documentRef.querySelectorAll('model-response').length;
      return Math.max(users, models);
    }

    function findGeminiScrollContainer(messageNode) {
      const preferred = [
        documentRef.querySelector('#chat-history'),
        documentRef.querySelector('.chat-history-scroll-container'),
        documentRef.querySelector('infinite-scroller')
      ].filter(Boolean);
      const usable = preferred.find((node) => scrollRange(node) > 40 || getScrollTop(node) > 0);
      if (usable) return usable;
      return findConversationScrollContainer(messageNode);
    }
  return { collectGeminiConversation, countGeminiConversationTurns, findGeminiScrollContainer };
}
