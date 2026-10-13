/**
 * ChatGPT same-origin transport only. No token persistence or external endpoints.
 * All network calls receive the caller's AbortSignal and use an injectable fetch.
 * The controller still owns progress, error policy, DOM scan and rendering.
 */
export function createChatGPTTransport({
  fetchImpl, getOrigin, getChatGPTAccountId, chatGPTAssetPointerInfo,
  parsePublicShare, makeCancelledError
}) {
  if (typeof fetchImpl !== "function" || typeof getOrigin !== "function" ||
      typeof getChatGPTAccountId !== "function" || typeof chatGPTAssetPointerInfo !== "function" ||
      typeof parsePublicShare !== "function" || typeof makeCancelledError !== "function") {
    throw new TypeError("ChatGPT transport dependencies are incomplete");
  }
  const fetch = fetchImpl;
  const chatGPTAssetUrlCache = new Map();

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

  async function requestAssetDownloadUrl(part, context, headers, signal) {
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

          if (response.url && /^https:\/\//i.test(response.url) && response.url !== new URL(endpoint, getOrigin()).href) {
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

  async function getOptionalAuthHeaders(signal) {
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

  async function getPublicShare(signal, fromDocument, url) {
    // Public share pages serialize the conversation into React Router hydration
    // data. First inspect the already-loaded document, then refetch the PUBLIC page
    // without account cookies. The anonymous response is often more fully SSR'd
    // than the signed-in SPA shell and avoids workspace/account-specific routing.
    let share = null;
    try { share = fromDocument(); } catch { share = null; }
    if (share) return share;

    const attempts = [
      { credentials: "omit", label: "anonymous public page" },
      { credentials: "include", label: "signed-in public page" }
    ];
    const errors = [];

    for (const attempt of attempts) {
      try {
        const response = await fetch(url, {
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
        share = parsePublicShare(html);
        if (share) return share;
        errors.push(`${attempt.label} had hydration data but no complete conversation object`);
      } catch (error) {
        if (signal?.aborted) throw makeCancelledError();
        errors.push(`${attempt.label}: ${error?.message || error}`);
      }
    }

    throw new Error(`ChatGPT public share page did not expose a complete conversation (${errors.join("; ")}).`);
  }

  async function getRequiredAuth(signal) {
    const response = await fetch("/api/auth/session", {
      credentials: "include", cache: "no-store", signal
    });
    if (!response.ok) throw new Error(`ChatGPT session metadata returned HTTP ${response.status}.`);
    const authSession = await response.json();
    const accessToken = authSession?.accessToken || "";
    if (!accessToken) throw new Error("ChatGPT session metadata did not provide a temporary access token.");
    const accountId = getChatGPTAccountId(authSession, accessToken);
    if (!accountId) throw new Error("ChatGPT account metadata could not be resolved for this conversation.");
    return { accessToken, accountId };
  }

  async function getConversation(context, accessToken, accountId, signal) {
    const endpoint = `/backend-api/conversation/${encodeURIComponent(context.conversationId)}`;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-ID": accountId,
      "X-OpenAI-Target-Path": endpoint,
      "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}"
    };
    if (context.projectId) headers["chatgpt-project-id"] = context.projectId;
    const response = await fetch(endpoint, {
      method: "GET", credentials: "include", cache: "no-store", headers, signal
    });
    if (!response.ok) throw new Error(`ChatGPT conversation metadata returned HTTP ${response.status}.`);
    const conversation = await response.json();
    return { conversation, headers };
  }

  async function getLegacyShare(shareId, headers, signal) {
    const endpoint = `/backend-api/share/${encodeURIComponent(shareId)}`;
    const response = await fetch(endpoint, {
      method: "GET", credentials: "include", cache: "no-store",
      headers: { Accept: "application/json", ...headers }, signal
    });
    if (!response.ok) {
      const error = new Error(`Legacy shared-conversation endpoint returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }


  return { getRequiredAuth, getOptionalAuthHeaders, getConversation, getLegacyShare, getPublicShare, requestAssetDownloadUrl };
}
