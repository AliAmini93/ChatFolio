const exportBtn = document.getElementById("exportBtn");
const visualBtn = document.getElementById("visualBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const platformBadge = document.getElementById("platformBadge");
const includeTimestamps = document.getElementById("includeTimestamps");
const embedImages = document.getElementById("embedImages");
const progressWrap = document.getElementById("progressWrap");
const layoutMode = document.getElementById("layoutMode");
const showMessageNumbers = document.getElementById("showMessageNumbers");
const progressBar = document.getElementById("progressBar");
const platformNameEl = document.getElementById("platformName");
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
const versionPill = document.getElementById("versionPill");

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
if (versionPill) versionPill.textContent = `v${EXTENSION_VERSION}`;
const PREFS_KEY = "chatfolioPreferencesV1";
const DEFAULT_PREFS = {
  theme: "light",
  layoutMode: "comfortable",
  showMessageNumbers: true,
  includeTimestamps: false,
  embedImages: true
};

let activeTabId = null;
let activePlatform = null;
let runningExportTabId = null;
let runningExportPlatformName = null;
let stopRequested = false;

function applyTheme(theme) {
  const selected = ["light", "graphite", "dark"].includes(theme) ? theme : "light";
  document.documentElement.dataset.theme = selected;
  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", button.dataset.themeChoice === selected ? "true" : "false");
  }
}

async function loadPreferences() {
  try {
    const stored = await chrome.storage.local.get(PREFS_KEY);
    const prefs = { ...DEFAULT_PREFS, ...(stored?.[PREFS_KEY] || {}) };
    applyTheme(prefs.theme);
    layoutMode.value = prefs.layoutMode === "compact" ? "compact" : "comfortable";
    showMessageNumbers.checked = prefs.showMessageNumbers !== false;
    includeTimestamps.checked = Boolean(prefs.includeTimestamps);
    embedImages.checked = prefs.embedImages !== false;
    return prefs;
  } catch {
    applyTheme(DEFAULT_PREFS.theme);
    return { ...DEFAULT_PREFS };
  }
}

async function savePreferences(patch = {}) {
  try {
    const stored = await chrome.storage.local.get(PREFS_KEY);
    const next = { ...DEFAULT_PREFS, ...(stored?.[PREFS_KEY] || {}), ...patch };
    await chrome.storage.local.set({ [PREFS_KEY]: next });
  } catch {
    // Preference persistence should never block exporting.
  }
}

const PLATFORM_RULES = [
  { id: "chatgpt", name: "ChatGPT", regex: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i },
  { id: "claude", name: "Claude", regex: /^https:\/\/claude\.ai\//i },
  { id: "gemini", name: "Gemini", regex: /^https:\/\/gemini\.google\.com\//i }
];

function detectPlatform(url) {
  return PLATFORM_RULES.find((item) => item.regex.test(url || "")) || null;
}

function setPlatformUi(platform) {
  activePlatform = platform;
  document.body.dataset.platform = platform?.id || "unsupported";
  if (platform) {
    platformBadge.textContent = platform.name;
    platformNameEl.textContent = `${platform.name} conversation detected`;
    platformBadge.classList.remove("unsupported");
    if (!runningExportTabId && !stopRequested) {
      statusEl.textContent = `${platform.name} is ready. ChatFolio will scan the conversation and include supported media when available.`;
    }
  } else {
    platformBadge.textContent = "Unsupported";
    platformNameEl.textContent = "No supported conversation detected";
    platformBadge.classList.add("unsupported");
    if (!runningExportTabId) statusEl.textContent = "Open a ChatGPT, Claude, or Gemini conversation to export it.";
  }
  exportBtn.disabled = Boolean(runningExportTabId) || !platform;
  if (visualBtn) visualBtn.disabled = Boolean(runningExportTabId) || !platform;
}

function setRunningUi(running) {
  exportBtn.disabled = running || !activePlatform;
  if (visualBtn) visualBtn.disabled = running || !activePlatform;
  stopBtn.hidden = !running;
  stopBtn.disabled = !running || stopRequested;
  layoutMode.disabled = running;
  showMessageNumbers.disabled = running;
  includeTimestamps.disabled = running;
  embedImages.disabled = running;
}

function applyProgress(message) {
  progressWrap.hidden = false;
  const percent = Math.max(0, Math.min(100, Number(message.percent) || 0));
  progressBar.style.width = `${percent}%`;
  // Keep the running UI intentionally simple: the progress bar is the only
  // live progress indicator. Detailed counts remain internal diagnostics.
  if (message.running === true) statusEl.textContent = "Exporting conversation…";
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "CHATFOLIO_PROGRESS") return;
  if (sender?.tab?.id) runningExportTabId = sender.tab.id;
  applyProgress(message);
  if (message.running === true) {
    setRunningUi(true);
  }
  if (message.running === false) {
    runningExportTabId = null;
    runningExportPlatformName = null;
    stopRequested = false;
    setRunningUi(false);
  }
});

async function getActiveTabInfo({ requireSupported = true } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = detectPlatform(tab?.url || "");
  activeTabId = tab?.id || null;
  setPlatformUi(platform);
  if (!tab?.id || (requireSupported && !platform)) {
    throw new Error("ChatFolio supports ChatGPT, Claude, and Gemini. Open a conversation on one of those sites first.");
  }
  return { tab, platform };
}

function isMissingReceiverError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection") ||
    message.includes("The message port closed");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pingContentScript(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "CHATFOLIO_PING" });
}

async function sendExportMessage(tabId, { forceVisual = false } = {}) {
  return chrome.tabs.sendMessage(tabId, {
    type: forceVisual ? "EXPORT_CHATFOLIO_VISUAL_PDF" : "EXPORT_CHATFOLIO_PDF",
    includeExportTime: includeTimestamps.checked,
    embedImages: embedImages.checked,
    layoutMode: layoutMode.value,
    showMessageNumbers: showMessageNumbers.checked
  });
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The chat tab did not finish reloading in time.")), timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") finish();
    }).catch((error) => finish(error));
  });
}

async function ensureContentScript(tabId, platform) {
  let pong = null;
  try {
    pong = await pingContentScript(tabId);
    if (pong?.ok && pong?.platform === platform.id && pong?.version === EXTENSION_VERSION) return pong;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
  }

  // A tab can keep an injected worker from an older ChatFolio build after the
  // extension is updated. Never stack two message listeners on the same page.
  // Reload once so the new worker starts against the current provider DOM.
  if (pong?.ok && pong?.version && pong.version !== EXTENSION_VERSION) {
    statusEl.textContent = `ChatFolio was updated. Refreshing the ${platform.name} tab once…`;
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
  }

  statusEl.textContent = `Connecting ChatFolio to ${platform.name}…`;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  let lastError = null;
  for (const waitMs of [0, 80, 180, 360, 700]) {
    if (waitMs) await delay(waitMs);
    try {
      const nextPong = await pingContentScript(tabId);
      if (nextPong?.ok && nextPong?.platform === platform.id && nextPong?.version === EXTENSION_VERSION) return nextPong;
    } catch (error) {
      lastError = error;
      if (!isMissingReceiverError(error)) throw error;
    }
  }

  throw new Error(`ChatFolio could not connect to this ${platform.name} tab. Refresh the page once and try again.${lastError ? "" : ""}`);
}

async function getGlobalState() {
  try {
    return await chrome.runtime.sendMessage({ type: "GET_CHATFOLIO_GLOBAL_STATE" });
  } catch {
    return { ok: false, running: false };
  }
}

async function syncRunningState() {
  const globalState = await getGlobalState();
  if (globalState?.ok && globalState.running) {
    runningExportTabId = globalState.tabId;
    runningExportPlatformName = globalState.platformName || "AI chat";
    stopRequested = false;
    setRunningUi(true);
    applyProgress({
      percent: globalState.percent || 2,
      messageCount: globalState.messageCount || 0,
      imageCount: globalState.imageCount || 0,
      status: globalState.tabId === activeTabId
        ? (globalState.status || `Scanning the ${runningExportPlatformName} conversation…`)
        : `${runningExportPlatformName} scan is still running in another tab. Stop scan will stop that original tab.`
    });
    return true;
  }

  runningExportTabId = null;
  runningExportPlatformName = null;

  // Fallback for a just-started content worker before the service worker state is
  // visible, or after service-worker suspension.
  try {
    const { tab, platform } = await getActiveTabInfo();
    const state = await chrome.tabs.sendMessage(tab.id, { type: "GET_CHATFOLIO_STATE" });
    if (!state?.ok || !state.running) return false;
    runningExportTabId = tab.id;
    runningExportPlatformName = platform.name;
    stopRequested = false;
    setRunningUi(true);
    applyProgress({
      percent: state.percent || 2,
      messageCount: state.messageCount || 0,
      imageCount: state.imageCount || 0,
      status: state.status || `Scanning the ${platform.name} conversation…`
    });
    return true;
  } catch {
    return false;
  }
}

async function startExport({ forceVisual = false } = {}) {
  stopRequested = false;
  progressWrap.hidden = false;
  progressBar.style.width = "2%";

  try {
    const existing = await getGlobalState();
    if (existing?.ok && existing.running) {
      await syncRunningState();
      return;
    }

    const { tab, platform } = await getActiveTabInfo();
    setRunningUi(true);
    runningExportTabId = tab.id;
    runningExportPlatformName = platform.name;
    statusEl.textContent = forceVisual
      ? `Preparing a visual backup of the ${platform.name} conversation…`
      : `Preparing the ${platform.name} conversation export…`;
    await ensureContentScript(tab.id, platform);
    const response = await sendExportMessage(tab.id, { forceVisual });

    if (!response?.ok) {
      if (response?.cancelled) {
        statusEl.textContent = "Export stopped. No PDF was created.";
        progressBar.style.width = "0%";
        return;
      }
      throw new Error(response?.error || "Could not export this conversation.");
    }

    progressBar.style.width = "100%";
    statusEl.textContent = response.fallbackMode === "visual"
      ? `${response.platformName || platform.name} visual archive ready. Print view opened.`
      : `${response.platformName || platform.name} conversation ready. Print view opened.`;
  } catch (error) {
    statusEl.textContent = error?.message || String(error);
    progressBar.style.width = "0%";
  } finally {
    runningExportTabId = null;
    runningExportPlatformName = null;
    stopRequested = false;
    setRunningUi(false);
  }
}

exportBtn.addEventListener("click", () => startExport({ forceVisual: false }));
if (visualBtn) visualBtn.addEventListener("click", () => startExport({ forceVisual: true }));

stopBtn.addEventListener("click", async () => {
  if (stopRequested) return;
  stopRequested = true;
  stopBtn.disabled = true;
  statusEl.textContent = runningExportPlatformName
    ? `Stopping the ${runningExportPlatformName} export…`
    : "Stopping export…";

  try {
    let response = await chrome.runtime.sendMessage({ type: "STOP_GLOBAL_CHATFOLIO_EXPORT" });
    if (!response?.ok && runningExportTabId) {
      response = await chrome.tabs.sendMessage(runningExportTabId, { type: "STOP_CHATFOLIO_EXPORT" });
    }
    if (!response?.ok) throw new Error(response?.error || "The scan could not be stopped.");
    if (response.stopping === false) {
      runningExportTabId = null;
      runningExportPlatformName = null;
      stopRequested = false;
      setRunningUi(false);
      statusEl.textContent = "No active export is running.";
      return;
    }
    statusEl.textContent = "Stop requested. Waiting for the export to end…";
  } catch (error) {
    stopRequested = false;
    stopBtn.disabled = false;
    statusEl.textContent = isMissingReceiverError(error)
      ? "The scan worker is no longer connected. Its stale running state has been cleared; refresh the source chat before the next export."
      : (error?.message || String(error));
  }
});

for (const button of themeButtons) {
  button.addEventListener("click", async () => {
    const theme = button.dataset.themeChoice || "light";
    applyTheme(theme);
    await savePreferences({ theme });
  });
}

layoutMode.addEventListener("change", () => savePreferences({ layoutMode: layoutMode.value }));
showMessageNumbers.addEventListener("change", () => savePreferences({ showMessageNumbers: showMessageNumbers.checked }));
includeTimestamps.addEventListener("change", () => savePreferences({ includeTimestamps: includeTimestamps.checked }));
embedImages.addEventListener("change", () => savePreferences({ embedImages: embedImages.checked }));

(async () => {
  await loadPreferences();
  try {
    await getActiveTabInfo({ requireSupported: false });
  } catch {
    setPlatformUi(null);
  }
  await syncRunningState();
})();
