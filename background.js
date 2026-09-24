const STORAGE_KEY = "chatfolioActiveExport";

async function getActiveExport() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY] || null;
}

async function setActiveExport(value) {
  if (value) await chrome.storage.session.set({ [STORAGE_KEY]: value });
  else await chrome.storage.session.remove(STORAGE_KEY);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "CHATFOLIO_EXPORT_STARTED") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false });
      return;
    }
    setActiveExport({
      tabId,
      platform: message.platform || "unknown",
      platformName: message.platformName || "AI chat",
      url: sender.tab?.url || "",
      status: message.status || "Preparing the scan...",
      percent: Number(message.percent || 1),
      messageCount: Number(message.messageCount || 0),
      imageCount: Number(message.imageCount || 0),
      startedAt: Date.now()
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "CHATFOLIO_PROGRESS") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    getActiveExport().then((active) => {
      if (!active || active.tabId !== tabId) return;
      if (message.running === false) {
        setActiveExport(null);
        return;
      }
      setActiveExport({
        ...active,
        status: message.status || active.status,
        percent: Number.isFinite(message.percent) ? message.percent : active.percent,
        messageCount: Number.isFinite(message.messageCount) ? message.messageCount : active.messageCount,
        imageCount: Number.isFinite(message.imageCount) ? message.imageCount : active.imageCount
      });
    });
    return;
  }

  if (message.type === "CHATFOLIO_EXPORT_FINISHED") {
    const tabId = sender.tab?.id;
    getActiveExport().then((active) => {
      if (!active || !Number.isInteger(tabId) || active.tabId === tabId) setActiveExport(null);
    });
    return;
  }

  if (message.type === "GET_CHATFOLIO_GLOBAL_STATE") {
    getActiveExport().then(async (active) => {
      if (!active) {
        sendResponse({ ok: true, running: false });
        return;
      }
      try {
        const tab = await chrome.tabs.get(active.tabId);
        if (!tab?.id) throw new Error("Tab no longer exists");
        sendResponse({ ok: true, running: true, ...active });
      } catch {
        await setActiveExport(null);
        sendResponse({ ok: true, running: false });
      }
    });
    return true;
  }

  if (message.type === "STOP_GLOBAL_CHATFOLIO_EXPORT") {
    getActiveExport().then(async (active) => {
      if (!active) {
        sendResponse({ ok: true, stopping: false, running: false });
        return;
      }
      try {
        const response = await chrome.tabs.sendMessage(active.tabId, { type: "STOP_CHATFOLIO_EXPORT" });
        sendResponse({ ok: true, stopping: Boolean(response?.stopping), tabId: active.tabId, platformName: active.platformName });
      } catch (error) {
        await setActiveExport(null);
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActiveExport();
  if (active?.tabId === tabId) await setActiveExport(null);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const active = await getActiveExport();
  if (active?.tabId !== tabId) return;
  // Navigating the source tab invalidates the in-page scanner. Clear stale global state.
  if (active.url && changeInfo.url !== active.url) await setActiveExport(null);
});
