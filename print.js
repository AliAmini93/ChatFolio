const params = new URLSearchParams(location.search);
const jobId = params.get("job") || "";
const frame = document.getElementById("preview");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const printAgain = document.getElementById("printAgain");
const chunks = [];
let blobUrl = "";
let loadedFrame = null;
let finished = false;

function setError(message) {
  statusTitle.textContent = "Could not prepare the print view";
  statusText.textContent = message || "Please return to the conversation and export again.";
  printAgain.hidden = true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrameDocument(targetFrame) {
  const doc = targetFrame.contentDocument;
  if (!doc) return;

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
      sleep(5000)
    ]);
  }

  if (doc.fonts?.ready) {
    await Promise.race([doc.fonts.ready, sleep(4500)]).catch(() => {});
  }
  await sleep(400);
}

async function printCurrentFrame() {
  if (!loadedFrame?.contentWindow) return;
  try {
    loadedFrame.contentWindow.focus();
    loadedFrame.contentWindow.print();
    printAgain.hidden = false;
  } catch (error) {
    document.body.classList.remove("ready");
    setError(error?.message || String(error));
  }
}

printAgain.addEventListener("click", printCurrentFrame);

if (!jobId) {
  setError("Missing print job identifier.");
} else {
  const port = chrome.runtime.connect({ name: "chatfolio-print" });
  port.postMessage({ type: "CHATFOLIO_PRINT_READY", jobId });

  port.onMessage.addListener(async (message) => {
    if (message?.type === "CHATFOLIO_PRINT_ERROR") {
      setError(message.error);
      return;
    }
    if (message?.jobId !== jobId) return;

    if (message.type === "CHATFOLIO_PRINT_CHUNK") {
      chunks[message.index] = message.data;
      statusText.textContent = `Receiving conversation data... ${chunks.filter((item) => typeof item === "string").length} chunk(s)`;
      return;
    }

    if (message.type === "CHATFOLIO_PRINT_END" && !finished) {
      finished = true;
      const expected = Number(message.totalChunks || 0);
      if (!expected || chunks.length < expected || chunks.slice(0, expected).some((item) => typeof item !== "string")) {
        setError("The print data was incomplete. Please export the conversation again.");
        return;
      }

      document.title = message.title || "ChatFolio conversation";
      const html = chunks.slice(0, expected).join("");
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      blobUrl = URL.createObjectURL(blob);

      frame.addEventListener("load", async () => {
        loadedFrame = frame;
        await waitForFrameDocument(frame);
        document.body.classList.add("ready");
        try { port.postMessage({ type: "CHATFOLIO_PRINT_CONSUMED", jobId }); } catch {}
        await sleep(150);
        await printCurrentFrame();
      }, { once: true });

      frame.src = blobUrl;
    }
  });

  port.onDisconnect.addListener(() => {
    if (!finished) setError("The extension print service stopped unexpectedly. Please export again.");
  });
}

window.addEventListener("beforeunload", () => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
