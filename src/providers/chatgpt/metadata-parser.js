/**
 * ChatGPT data-first metadata parsers and share hydration decoder.
 *
 * Pure except for the optional browser location default in
 * getChatGPTConversationContext(). No account tokens or network I/O here.
 * These named exports are imported by Node tests; the on-demand classic
 * content script compiler embeds the SAME source inside its IIFE.
 */

export function getChatGPTConversationContext(href = globalThis.location.href) {
  try {
    const url = new URL(href);
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
    return { conversationId, projectId, shareId: "", isShare: false,
      isTemporary: url.searchParams.get('temporary-chat') === 'true' };
  } catch {
    return null;
  }
}

export function decodeJwtPayload(token) {
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

export function getChatGPTAccountId(session, accessToken) {
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

export function collectChatGPTBranch(conversation) {
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

export function orderChatGPTShareNodes(share) {
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

export function extractChatGPTTurboChunks(source) {
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

export function decodeChatGPTTurboStreamFromSource(source) {
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

export function findChatGPTShareContainer(root) {
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
