const exportBtn = document.getElementById("exportBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const platformBadge = document.getElementById("platformBadge");
const includeTimestamps = document.getElementById("includeTimestamps");
const embedImages = document.getElementById("embedImages");
const progressWrap = document.getElementById("progressWrap");
const layoutMode = document.getElementById("layoutMode");
const showMessageNumbers = document.getElementById("showMessageNumbers");
const progressBar = document.getElementById("progressBar");
const messageCountEl = document.getElementById("messageCount");
const imageCountEl = document.getElementById("imageCount");
const progressPercentEl = document.getElementById("progressPercent");
const platformNameEl = document.getElementById("platformName");
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];

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
}

function setRunningUi(running) {
  exportBtn.disabled = running || !activePlatform;
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
  if (progressPercentEl) progressPercentEl.textContent = `${Math.round(percent)}%`;
  if (Number.isFinite(message.messageCount)) messageCountEl.textContent = `${message.messageCount} messages`;
  if (Number.isFinite(message.imageCount)) imageCountEl.textContent = `${message.imageCount} media`;
  if (message.status) statusEl.textContent = message.status;
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

async function sendExportMessage(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    type: "EXPORT_CHATFOLIO_PDF",
    includeExportTime: includeTimestamps.checked,
    embedImages: embedImages.checked,
    layoutMode: layoutMode.value,
    showMessageNumbers: showMessageNumbers.checked
  });
}

async function ensureContentScript(tabId, platform) {
  try {
    const pong = await pingContentScript(tabId);
    if (pong?.ok && pong?.platform === platform.id) return pong;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
  }

  statusEl.textContent = `Connecting ChatFolio to ${platform.name}…`;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  let lastError = null;
  for (const waitMs of [0, 60, 150, 300]) {
    if (waitMs) await delay(waitMs);
    try {
      const pong = await pingContentScript(tabId);
      if (pong?.ok && pong?.platform === platform.id) return pong;
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

exportBtn.addEventListener("click", async () => {
  stopRequested = false;
  progressWrap.hidden = false;
  progressBar.style.width = "2%";
  if (progressPercentEl) progressPercentEl.textContent = "2%";
  messageCountEl.textContent = "0 messages";
  imageCountEl.textContent = "0 media";

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
    statusEl.textContent = `Preparing a full ${platform.name} conversation scan…`;
    await ensureContentScript(tab.id, platform);
    const response = await sendExportMessage(tab.id);

    if (!response?.ok) {
      if (response?.cancelled) {
        statusEl.textContent = "Scan stopped. Your original scroll position was restored. No PDF was created.";
        progressBar.style.width = "0%";
        return;
      }
      throw new Error(response?.error || "Could not export this conversation.");
    }

    progressBar.style.width = "100%";
    if (progressPercentEl) progressPercentEl.textContent = "100%";
    messageCountEl.textContent = `${response.messageCount} messages`;
    imageCountEl.textContent = `${response.imageCount} media`;
    statusEl.textContent = `Full ${response.platformName || platform.name} scan complete. ${response.messageCount} messages collected. Print dialog opened.`;
  } catch (error) {
    statusEl.textContent = error?.message || String(error);
    progressBar.style.width = "0%";
    if (progressPercentEl) progressPercentEl.textContent = "0%";
  } finally {
    runningExportTabId = null;
    runningExportPlatformName = null;
    stopRequested = false;
    setRunningUi(false);
  }
});

stopBtn.addEventListener("click", async () => {
  if (stopRequested) return;
  stopRequested = true;
  stopBtn.disabled = true;
  statusEl.textContent = runningExportPlatformName
    ? `Stopping the ${runningExportPlatformName} scan and restoring its position…`
    : "Stopping scan and restoring the original position…";

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
      statusEl.textContent = "No active scan is running.";
      return;
    }
    statusEl.textContent = "Stop requested. Waiting for the source tab to restore its original position…";
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
