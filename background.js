const STORAGE_KEY = "chatfolioActiveExport";
const printJobs = new Map();
let memoryActiveExport = null;


let visibleCaptureQueue = Promise.resolve();
let lastVisibleCaptureStartedAt = 0;

function backgroundSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureVisibleQuotaIntervalMs() {
  const reported = Number(chrome.tabs?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND || 2);
  const perSecond = Number.isFinite(reported) && reported > 0 ? reported : 2;
  // Chrome currently reports 2 calls/s. Keep a safety margin because timers,
  // service-worker scheduling and another in-flight request can otherwise land
  // exactly on the quota boundary.
  return Math.ceil(1000 / perSecond) + 125;
}

function enqueueVisibleCapture(task) {
  const run = visibleCaptureQueue.then(task, task);
  visibleCaptureQueue = run.catch(() => {});
  return run;
}

async function captureVisibleTabRateLimited(windowId, options) {
  const minInterval = captureVisibleQuotaIntervalMs();
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sinceLast = Date.now() - lastVisibleCaptureStartedAt;
    const waitMs = Math.max(0, minInterval - sinceLast);
    if (waitMs) await backgroundSleep(waitMs);

    lastVisibleCaptureStartedAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      const isQuota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|captureVisibleTab.*quota|quota/i.test(message);
      if (!isQuota || attempt === 3) throw error;
      await backgroundSleep(minInterval + attempt * 180);
    }
  }

  throw lastError || new Error('Chrome could not capture the visible tab.');
}

function sessionStorageAvailable() {
  return Boolean(chrome.storage && chrome.storage.session);
}

async function getActiveExport() {
  if (!sessionStorageAvailable()) return memoryActiveExport;
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    return stored?.[STORAGE_KEY] || null;
  } catch {
    return memoryActiveExport;
  }
}

async function setActiveExport(value) {
  memoryActiveExport = value || null;
  if (!sessionStorageAvailable()) return;
  try {
    if (value) await chrome.storage.session.set({ [STORAGE_KEY]: value });
    else await chrome.storage.session.remove(STORAGE_KEY);
  } catch {
    // The in-memory fallback keeps Stop/status functional on older Chromium.
  }
}

function safePost(port, payload) {
  try {
    port?.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function cleanupPrintJob(jobId, { closeTab = false } = {}) {
  const job = printJobs.get(jobId);
  if (!job) return;
  printJobs.delete(jobId);
  if (closeTab && Number.isInteger(job.printTabId)) {
    chrome.tabs.remove(job.printTabId).catch(() => {});
  }
}

function flushPrintJob(job) {
  if (!job?.port) return;
  while (job.sentChunks < job.chunks.length) {
    const index = job.sentChunks;
    const data = job.chunks[index];
    if (typeof data !== "string") break;
    if (!safePost(job.port, { type: "CHATFOLIO_PRINT_CHUNK", jobId: job.id, index, data })) return;
    job.sentChunks += 1;
  }

  if (job.complete && job.sentChunks === job.totalChunks && !job.endSent) {
    job.endSent = safePost(job.port, {
      type: "CHATFOLIO_PRINT_END",
      jobId: job.id,
      title: job.title,
      platformName: job.platformName,
      totalChunks: job.totalChunks
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chatfolio-print") return;
  let attachedJobId = null;

  port.onMessage.addListener((message) => {
    if (message?.type === "CHATFOLIO_PRINT_READY") {
      const job = printJobs.get(message.jobId);
      if (!job) {
        safePost(port, { type: "CHATFOLIO_PRINT_ERROR", error: "The print job expired. Please export again." });
        return;
      }
      attachedJobId = job.id;
      job.port = port;
      flushPrintJob(job);
      return;
    }

    if (message?.type === "CHATFOLIO_PRINT_CONSUMED" && message.jobId === attachedJobId) {
      cleanupPrintJob(attachedJobId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (!attachedJobId) return;
    const job = printJobs.get(attachedJobId);
    if (job?.port === port) job.port = null;
  });
});


const remoteResourceCache = new Map();

function isAllowedProviderResourceUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return [
      "chatgpt.com", "chat.openai.com", "openai.com", "oaistatic.com", "oaiusercontent.com", "openaimerge.com",
      "claude.ai", "anthropic.com",
      "gemini.google.com", "googleusercontent.com", "gstatic.com", "googleapis.com"
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function fetchRemoteText(url) {
  const key = `text:${url}`;
  if (remoteResourceCache.has(key)) return remoteResourceCache.get(key);
  const promise = (async () => {
    if (!isAllowedProviderResourceUrl(url)) throw new Error("Resource host is not allowed.");
    const response = await fetch(url, { cache: "force-cache", credentials: "omit", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 2 * 1024 * 1024) throw new Error("Stylesheet is too large.");
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("Stylesheet is too large.");
    return text;
  })();
  remoteResourceCache.set(key, promise);
  try { return await promise; } catch (error) { remoteResourceCache.delete(key); throw error; }
}

async function fetchRemoteDataUrl(url) {
  const key = `data:${url}`;
  if (remoteResourceCache.has(key)) return remoteResourceCache.get(key);
  const promise = (async () => {
    if (!isAllowedProviderResourceUrl(url)) throw new Error("Resource host is not allowed.");
    const response = await fetch(url, { cache: "force-cache", credentials: "omit", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mime = response.headers.get("content-type") || (url.match(/\.woff2(?:\?|$)/i) ? "font/woff2" : url.match(/\.woff(?:\?|$)/i) ? "font/woff" : "application/octet-stream");
    const maxBytes = mime.toLowerCase().startsWith("image/") ? 12 * 1024 * 1024 : 4 * 1024 * 1024;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) throw new Error("Remote resource is too large.");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("Remote resource is too large.");
    return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
  })();
  remoteResourceCache.set(key, promise);
  try { return await promise; } catch (error) { remoteResourceCache.delete(key); throw error; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "CHATFOLIO_FETCH_TEXT_RESOURCE") {
    fetchRemoteText(String(message.url || ""))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === "CHATFOLIO_FETCH_DATA_RESOURCE") {
    fetchRemoteDataUrl(String(message.url || ""))
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message.type === "CHATFOLIO_CAPTURE_VISIBLE") {
    const sourceTabId = sender.tab?.id;
    const sourceWindowId = sender.tab?.windowId;
    if (!Number.isInteger(sourceTabId) || !Number.isInteger(sourceWindowId)) {
      sendResponse({ ok: false, error: "The source conversation tab is unavailable." });
      return;
    }

    enqueueVisibleCapture(async () => {
      try {
        // captureVisibleTab always captures the active tab. Make the source tab
        // active explicitly so a long fail-safe capture cannot accidentally
        // archive a different tab if focus changed while the popup closed.
        const tab = await chrome.tabs.get(sourceTabId);
        if (!tab?.active) {
          await chrome.tabs.update(sourceTabId, { active: true });
          await backgroundSleep(90);
        }
        const quality = Math.max(45, Math.min(92, Number(message.quality) || 78));
        const dataUrl = await captureVisibleTabRateLimited(sourceWindowId, { format: "jpeg", quality });
        sendResponse({ ok: true, dataUrl });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    });
    return true;
  }

  if (message.type === "CHATFOLIO_PRINT_BEGIN") {
    const jobId = String(message.jobId || "");
    const totalChunks = Number(message.totalChunks || 0);
    if (!jobId || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 10000) {
      sendResponse({ ok: false, error: "Invalid print job metadata." });
      return;
    }

    const job = {
      id: jobId,
      title: String(message.title || "ChatFolio conversation"),
      platform: String(message.platform || "unknown"),
      platformName: String(message.platformName || "AI chat"),
      sourceTabId: sender.tab?.id || null,
      totalChunks,
      chunks: new Array(totalChunks),
      receivedChunks: 0,
      sentChunks: 0,
      complete: false,
      endSent: false,
      port: null,
      printTabId: null,
      createdAt: Date.now()
    };
    printJobs.set(jobId, job);

    chrome.tabs.create({
      url: chrome.runtime.getURL(`print.html?job=${encodeURIComponent(jobId)}`),
      active: false
    }).then((tab) => {
      job.printTabId = tab?.id || null;
      sendResponse({ ok: true, printTabId: job.printTabId });
    }).catch((error) => {
      cleanupPrintJob(jobId);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }

  if (message.type === "CHATFOLIO_PRINT_CHUNK") {
    const job = printJobs.get(String(message.jobId || ""));
    const index = Number(message.index);
    if (!job) {
      sendResponse({ ok: false, error: "The print job is no longer available." });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= job.totalChunks || typeof message.data !== "string") {
      sendResponse({ ok: false, error: "Invalid print data chunk." });
      return;
    }
    if (typeof job.chunks[index] !== "string") job.receivedChunks += 1;
    job.chunks[index] = message.data;
    flushPrintJob(job);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "CHATFOLIO_PRINT_END") {
    const job = printJobs.get(String(message.jobId || ""));
    if (!job) {
      sendResponse({ ok: false, error: "The print job is no longer available." });
      return;
    }
    if (job.receivedChunks !== job.totalChunks) {
      sendResponse({ ok: false, error: `Print transfer incomplete (${job.receivedChunks}/${job.totalChunks} chunks).` });
      return;
    }
    job.complete = true;
    flushPrintJob(job);
    if (Number.isInteger(job.printTabId)) {
      chrome.tabs.update(job.printTabId, { active: true }).catch(() => {});
    }
    sendResponse({ ok: true, printTabId: job.printTabId });
    return;
  }

  if (message.type === "CHATFOLIO_PRINT_ABORT") {
    cleanupPrintJob(String(message.jobId || ""), { closeTab: true });
    sendResponse({ ok: true });
    return;
  }

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

  for (const [jobId, job] of printJobs) {
    if (job.printTabId === tabId || job.sourceTabId === tabId) cleanupPrintJob(jobId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const active = await getActiveExport();
  if (active?.tabId !== tabId) return;
  if (active.url && changeInfo.url !== active.url) await setActiveExport(null);
});

// Drop orphaned print jobs if a print page never connects.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [jobId, job] of printJobs) {
    if (job.createdAt < cutoff) cleanupPrintJob(jobId, { closeTab: true });
  }
}, 60 * 1000);
