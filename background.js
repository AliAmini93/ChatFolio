const STORAGE_KEY = "chatfolioActiveExport";
const printJobs = new Map();
const MAX_ACTIVE_PRINT_JOBS = 3;
const MAX_PRINT_CHUNK_CHARS = 1024 * 1024;
const MAX_PRINT_JOB_CHARS = 128 * 1024 * 1024;
let memoryActiveExport = null;

// Phase 5B1: complete print jobs survive a service-worker restart. The spool
// never leaves this extension origin; incomplete transfers remain fail-closed.
const PRINT_RECOVERY_DB = "chatfolio-print-recovery";
const PRINT_RECOVERY_TTL_MS = 10 * 60 * 1000;
let printRecoveryDbPromise = null;

function openPrintRecoveryDb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!printRecoveryDbPromise) {
    printRecoveryDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PRINT_RECOVERY_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("completed", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Print recovery storage is unavailable."));
      request.onblocked = () => reject(new Error("Print recovery storage is blocked."));
    }).catch((error) => {
      printRecoveryDbPromise = null;
      throw error;
    });
  }
  return printRecoveryDbPromise;
}

async function storeCompletedPrintJob(job) {
  const db = await openPrintRecoveryDb();
  if (!db) return; // The legacy memory-only path remains usable in test runtimes.
  const snapshot = {
    id: job.id, title: job.title, platform: job.platform,
    platformName: job.platformName, sourceTabId: job.sourceTabId,
    printTabId: job.printTabId, totalChunks: job.totalChunks,
    receivedChunks: job.receivedChunks, receivedChars: job.receivedChars,
    createdAt: job.createdAt, chunks: [...job.chunks]
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction("completed", "readwrite");
    tx.objectStore("completed").put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to store the print preview."));
    tx.onabort = () => reject(tx.error || new Error("Print preview storage was aborted."));
  });
}

async function restoreCompletedPrintJob(jobId) {
  const db = await openPrintRecoveryDb();
  if (!db) return null;
  const stored = await new Promise((resolve, reject) => {
    const tx = db.transaction("completed", "readonly");
    const request = tx.objectStore("completed").get(jobId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not load the saved print preview."));
  });
  if (!stored) return null;
  if (Date.now() - stored.createdAt >= PRINT_RECOVERY_TTL_MS ||
      !Array.isArray(stored.chunks) ||
      stored.chunks.length !== stored.totalChunks ||
      stored.chunks.some((part) => typeof part !== "string") ||
      stored.receivedChunks !== stored.totalChunks ||
      stored.receivedChars > MAX_PRINT_JOB_CHARS) {
    await removeCompletedPrintJob(jobId);
    return null;
  }
  return { ...stored, complete: true, port: null, sentChunks: 0, endSent: false };
}

async function pruneCompletedPrintJobs({ closedTabId = null } = {}) {
  const db = await openPrintRecoveryDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("completed", "readwrite");
    const request = tx.objectStore("completed").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value;
      if (Date.now() - item.createdAt >= PRINT_RECOVERY_TTL_MS ||
          (closedTabId !== null && (item.printTabId === closedTabId || item.sourceTabId === closedTabId))) {
        cursor.delete();
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to prune old print jobs."));
    tx.onabort = () => reject(tx.error || new Error("Print recovery cleanup was aborted."));
  });
}

async function removeCompletedPrintJob(jobId) {
  const db = await openPrintRecoveryDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("completed", "readwrite");
    tx.objectStore("completed").delete(jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Unable to delete stored print preview."));
    tx.onabort = () => reject(tx.error || new Error("Print preview cleanup was aborted."));
  });
}



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
  // The extension owns the data; discard it once the preview consumed it.
  void removeCompletedPrintJob(jobId).catch(() => {});
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
      // Send every chunk again on reconnect. The print view deduplicates by
      // chunk index and will only assemble a complete document once.
      void (async () => {
        let job = printJobs.get(message.jobId);
        if (!job) {
          job = await restoreCompletedPrintJob(message.jobId);
          if (job) printJobs.set(job.id, job);
        }
        if (!job || (Number.isInteger(port.sender?.tab?.id) &&
            Number.isInteger(job.printTabId) && port.sender.tab.id !== job.printTabId)) {
          safePost(port, { type: "CHATFOLIO_PRINT_ERROR", error: "The print job expired or is unavailable. Please export again." });
          return;
        }
        attachedJobId = job.id;
        job.port = port;
        job.sentChunks = 0;
        job.endSent = false;
        flushPrintJob(job);
      })().catch(() => {
        safePost(port, { type: "CHATFOLIO_PRINT_ERROR", error: "The saved print view could not be restored. Please export again." });
      });
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
const REMOTE_CACHE_MAX_ENTRIES = 8;
const REMOTE_CACHE_TTL_MS = 5 * 60 * 1000;

function cachedRemoteResource(key) {
  const entry = remoteResourceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt >= REMOTE_CACHE_TTL_MS) {
    remoteResourceCache.delete(key);
    return null;
  }
  remoteResourceCache.delete(key);
  remoteResourceCache.set(key, entry);
  return entry.promise;
}

function rememberRemoteResource(key, promise) {
  const now = Date.now();
  for (const [cachedKey, entry] of remoteResourceCache) {
    if (now - entry.createdAt >= REMOTE_CACHE_TTL_MS) remoteResourceCache.delete(cachedKey);
  }
  remoteResourceCache.set(key, { promise, createdAt: now });
  while (remoteResourceCache.size > REMOTE_CACHE_MAX_ENTRIES) {
    remoteResourceCache.delete(remoteResourceCache.keys().next().value);
  }
}

function forgetFailedRemoteResource(key, promise) {
  if (remoteResourceCache.get(key)?.promise === promise) remoteResourceCache.delete(key);
}

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
  const cached = cachedRemoteResource(key);
  if (cached) return cached;
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
  rememberRemoteResource(key, promise);
  try { return await promise; } catch (error) { forgetFailedRemoteResource(key, promise); throw error; }
}

async function fetchRemoteDataUrl(url) {
  const key = `data:${url}`;
  const cached = cachedRemoteResource(key);
  if (cached) return cached;
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
  rememberRemoteResource(key, promise);
  try { return await promise; } catch (error) { forgetFailedRemoteResource(key, promise); throw error; }
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

    if (printJobs.has(jobId)) {
      sendResponse({ ok: false, error: "A print job with this identifier already exists." });
      return;
    }
    if (printJobs.size >= MAX_ACTIVE_PRINT_JOBS) {
      sendResponse({ ok: false, error: "Too many print jobs are open. Close an old print view and try again." });
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
      receivedChars: 0,
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
    if (message.data.length > MAX_PRINT_CHUNK_CHARS) {
      sendResponse({ ok: false, error: "Print data chunk exceeds the supported size." });
      return;
    }
    const previous = typeof job.chunks[index] === "string" ? job.chunks[index] : null;
    const receivedChars = job.receivedChars - (previous?.length || 0) + message.data.length;
    if (receivedChars > MAX_PRINT_JOB_CHARS) {
      cleanupPrintJob(job.id, { closeTab: true });
      sendResponse({ ok: false, error: "Print job exceeds the safe memory limit. Try a smaller archive." });
      return;
    }
    if (previous === null) job.receivedChunks += 1;
    job.receivedChars = receivedChars;
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
    // Persist *before* acknowledging success: a suspended worker can then
    // re-send the completed preview to a reconnecting print page.
    storeCompletedPrintJob(job).then(() => {
      job.complete = true;
      flushPrintJob(job);
      if (Number.isInteger(job.printTabId)) {
        chrome.tabs.update(job.printTabId, { active: true }).catch(() => {});
      }
      sendResponse({ ok: true, printTabId: job.printTabId });
    }).catch((error) => {
      sendResponse({ ok: false, error: error?.message || "Could not preserve the print preview." });
    });
    return true;
  }

  if (message.type === "CHATFOLIO_PRINT_STATUS") {
    const jobId = String(message.jobId || "");
    const sourceTabId = sender.tab?.id;
    const respond = (job) => {
      if (!Number.isInteger(sourceTabId) || !job || job.sourceTabId !== sourceTabId) {
        sendResponse({ ok: false, error: "Print job is no longer available." });
        return;
      }
      sendResponse({ ok: true, complete: job.complete, printTabId: job.printTabId });
    };
    const inMemory = printJobs.get(jobId);
    if (inMemory) respond(inMemory);
    else restoreCompletedPrintJob(jobId).then(respond).catch(() => {
      sendResponse({ ok: false, error: "Could not inspect print job state." });
    });
    return true;
  }

  if (message.type === "CHATFOLIO_PRINT_ABORT") {
    const jobId = String(message.jobId || "");
    const sourceTabId = sender.tab?.id;
    const job = printJobs.get(jobId);
    if (job) {
      if (!Number.isInteger(sourceTabId) || job.sourceTabId !== sourceTabId) {
        sendResponse({ ok: false, error: "Print job belongs to another source tab." });
        return;
      }
      cleanupPrintJob(jobId, { closeTab: true });
      sendResponse({ ok: true });
      return;
    }
    // Following a worker restart the old Map is empty. A retrying source can
    // still close *its exact* orphan preview, but never an unrelated browser tab.
    const candidate = Number(message.printTabId);
    if (!Number.isInteger(sourceTabId) || !Number.isInteger(candidate) || candidate < 0 || !jobId) {
      sendResponse({ ok: true });
      return;
    }
    (async () => {
      const stored = await restoreCompletedPrintJob(jobId);
      if (stored && stored.sourceTabId !== sourceTabId) {
        return { ok: false, error: "Print job belongs to another source tab." };
      }
      const tab = await chrome.tabs.get(candidate);
      const expected = chrome.runtime.getURL("print.html?job=" + encodeURIComponent(jobId));
      if (tab?.url !== expected) return { ok: false, error: "Print tab could not be verified." };
      if (stored) await removeCompletedPrintJob(jobId);
      await chrome.tabs.remove(candidate);
      return { ok: true };
    })().then(sendResponse).catch(() => sendResponse({ ok: false, error: "Old print tab could not be closed." }));
    return true;
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
  void pruneCompletedPrintJobs({ closedTabId: tabId }).catch(() => {});
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

// Clean up snapshots abandoned by closed tabs or expired workers.
void pruneCompletedPrintJobs().catch(() => {});

// Drop orphaned print jobs if a print page never connects.
setInterval(() => {
  void pruneCompletedPrintJobs().catch(() => {});
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [jobId, job] of printJobs) {
    if (job.createdAt < cutoff) cleanupPrintJob(jobId, { closeTab: true });
  }
}, 60 * 1000);
