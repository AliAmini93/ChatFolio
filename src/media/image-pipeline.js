/**
 * Provider image capture and embedding (ChatFolio phase 4B1).
 *
 * Owns live image URL discovery, CORS-resistant viewport capture with scroll
 * restoration, sibling user attachments, and fetch/blob to data URL conversion.
 * The controller supplies browser/network/lifecycle dependencies; no new Chrome
 * permissions or extension-global state is introduced.
 */
export function createImagePipeline({
  PLATFORM, document, window, getComputedStyle, absoluteUrl,
  sendRuntimeMessage, loadDataUrlImage, sleepWithAbort, makeCancelledError,
  fetch, FileReader
}) {
  // Live provider image URLs can be stored in currentSrc, lazy-loading attributes,
  // srcset or a thumbnail background. Resolve them before cloning/provider cleanup.
  function bestLiveImageUrl(element) {
    if (!element) return '';
    const direct = [
      element.currentSrc, element.getAttribute?.('src'),
      element.getAttribute?.('data-src'), element.getAttribute?.('data-original'),
      element.getAttribute?.('data-image-url'), element.getAttribute?.('data-full-src')
    ].filter(Boolean);
    const srcset = element.getAttribute?.('srcset') || '';
    if (srcset) {
      const parts = srcset.split(',').map((part) => part.trim().split(/\s+/)[0]);
      direct.push(...parts.reverse());
    }
    const imageUrl = direct.find((url) => /^(?:https?:|blob:|data:image\/|\/)/i.test(String(url || '').trim()));
    if (imageUrl) return absoluteUrl(imageUrl) || imageUrl;

    try {
      const style = getComputedStyle(element);
      const value = style?.backgroundImage || '';
      const match = value.match(/url\(\s*(["']?)(.*?)\1\s*\)/i);
      if (match?.[2]) return absoluteUrl(match[2]) || match[2];
    } catch {}
    return '';
  }

  function plausibleLiveUserPicture(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const naturalWidth = Number(element.naturalWidth || 0);
    const naturalHeight = Number(element.naturalHeight || 0);
    const displayed = rect.width >= 68 && rect.height >= 48;
    const largeAsset = naturalWidth >= 128 && naturalHeight >= 80 && rect.width >= 35 && rect.height >= 35;
    if (!displayed && !largeAsset) return false;
    if (element.closest?.('model-response, .model-response, .model-response-container, [data-message-author-role="assistant"], [data-testid*="toolbar"], nav, aside')) return false;
    return true;
  }

  function liveImageInViewport(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return false;
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    return rect.width >= 24 && rect.height >= 24 &&
      rect.left >= -1 && rect.top >= -1 &&
      rect.right <= viewportWidth + 1 && rect.bottom <= viewportHeight + 1;
  }

  function saveImageScrollPositions(element) {
    // scrollIntoView() can move multiple nested scrollers and the document. Keep
    // every original offset so image capture never leaves the chat repositioned.
    const positions = [];
    const seen = new Set();
    const remember = (node) => {
      if (!node || seen.has(node) || typeof node.scrollTop !== 'number') return;
      seen.add(node);
      positions.push({ node, top: node.scrollTop, left: node.scrollLeft });
    };
    remember(document.scrollingElement);
    for (let node = element; node; node = node.parentElement) remember(node);
    return { positions, x: window.scrollX, y: window.scrollY };
  }

  function restoreImageScrollPositions(snapshot) {
    if (!snapshot) return;
    // Restore descendant scrollers before their outer parents.
    for (const { node, top, left } of [...snapshot.positions].reverse()) {
      try { node.scrollTop = top; node.scrollLeft = left; } catch {}
    }
    try { window.scrollTo(snapshot.x, snapshot.y); } catch {}
  }

  async function waitForLiveUserImage(element, signal) {
    // Gemini may lazy-load an uploaded picture only after it comes into view.
    if (element.tagName !== 'IMG' || (element.complete && element.naturalWidth >= 24)) return;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (signal?.aborted) throw makeCancelledError();
      if (element.complete && element.naturalWidth >= 24) break;
      await sleepWithAbort(140, signal);
    }
  }

  async function captureVisibleImageRegion(element, signal) {
    // Chrome can render a Google/Claude-hosted image while preventing scripts
    // and even an extension-origin fetch from reading its bytes (CORS/redirect).
    // Capture ONLY its own rectangle from the authenticated source tab. Gemini's
    // history loader often parks at the top, so later uploads are off-screen:
    // bring the image into view temporarily, then restore all scroll offsets.
    if (!element?.getBoundingClientRect || !plausibleLiveUserPicture(element)) return '';
    if (signal?.aborted) throw makeCancelledError();
    const wasVisible = liveImageInViewport(element);
    const scrollSnapshot = wasVisible ? null : saveImageScrollPositions(element);
    try {
      if (!wasVisible) {
        element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        await sleepWithAbort(190, signal);
      }
      await waitForLiveUserImage(element, signal);
      // Never archive the broken-image glyph as a valid user attachment.
      if (element.tagName === 'IMG' && Number(element.naturalWidth || 0) < 24) return '';
      if (!liveImageInViewport(element)) return '';
      const rect = element.getBoundingClientRect();
      const vw = Math.max(1, window.innerWidth);
      const vh = Math.max(1, window.innerHeight);
      const response = await sendRuntimeMessage({ type: 'CHATFOLIO_CAPTURE_VISIBLE', quality: 88 });
      if (!response?.ok || !response?.dataUrl) return '';
      const screenshot = await loadDataUrlImage(response.dataUrl, signal);
      const sx = Math.max(0, Math.round(rect.left * screenshot.naturalWidth / vw));
      const sy = Math.max(0, Math.round(rect.top * screenshot.naturalHeight / vh));
      const sw = Math.max(1, Math.min(screenshot.naturalWidth - sx, Math.round(rect.width * screenshot.naturalWidth / vw)));
      const sh = Math.max(1, Math.min(screenshot.naturalHeight - sy, Math.round(rect.height * screenshot.naturalHeight / vh)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(1800, sw);
      canvas.height = Math.max(1, Math.round(sh * canvas.width / sw));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return '';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(screenshot, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch (error) {
      if (signal?.aborted) throw makeCancelledError();
      return '';
    } finally {
      restoreImageScrollPositions(scrollSnapshot);
    }
  }

  async function embedVisibleProviderImage(element, rawUrl, signal) {
    const url = rawUrl || bestLiveImageUrl(element);
    // Googleusercontent images often redirect to authenticated rd-gg hosts. The
    // web page may display them while a second fetch from chrome-extension://
    // is blocked by CORS. Prefer the rendered photo rather than triggering
    // another doomed fetch. If capture fails, retain the older fetch paths.
    const geminiProtectedImage = PLATFORM.id === 'gemini' &&
      /^https:\/\/(?:[a-z0-9-]+\.)*googleusercontent\.com\//i.test(url);
    if (geminiProtectedImage) {
      const rendered = await captureVisibleImageRegion(element, signal);
      if (rendered) return rendered;
    }
    if (url) {
      const local = await sourceToDataUrl(url, signal);
      if (local && /^data:image\//i.test(local)) return local;
      if (/^https:\/\//i.test(url)) {
        try {
          const remote = await sendRuntimeMessage({ type: 'CHATFOLIO_FETCH_DATA_RESOURCE', url });
          if (remote?.ok && /^data:image\//i.test(remote.dataUrl || '')) return remote.dataUrl;
        } catch {}
      }
    }
    return geminiProtectedImage ? '' : await captureVisibleImageRegion(element, signal);
  }

  function makeMissingImageNotice() {
    const box = document.createElement('div');
    box.className = 'export-attachment export-image-unavailable';
    box.textContent = 'Image attachment could not be embedded. Reopen this conversation and retry with the image visible.';
    return box;
  }

  function providerUserMediaContainer(source, messageNode) {
    if (PLATFORM.id === 'claude') {
      return messageNode?.closest?.('[data-test-render-count]')
        || source?.closest?.('[data-test-render-count]')
        || messageNode?.parentElement?.parentElement || null;
    }
    if (PLATFORM.id === 'gemini') {
      return messageNode?.closest?.('.conversation-container')
        || source?.closest?.('.conversation-container')
        || messageNode?.parentElement || null;
    }
    return null;
  }

  async function appendProviderUserImages(source, messageNode, clone, embedImages, signal, mediaKeys) {
    const container = providerUserMediaContainer(source, messageNode);
    if (!container) return { count: 0, embedded: 0, missing: 0 };
    let count = 0;
    let embedded = 0;
    let missing = 0;
    const seen = new Set((mediaKeys || []).filter((key) => /^(?:https?:|blob:|data:image\/)/i.test(key)));
    const candidates = [
      ...container.querySelectorAll('img, canvas, [style*="background-image"], [data-testid*="image-preview"], [data-test-id*="image-preview"]')
    ];
    for (const element of candidates) {
      if (count >= 10) break;
      if (source?.contains?.(element) || messageNode?.contains?.(element)) continue;
      if (!plausibleLiveUserPicture(element)) continue;
      if (element.closest?.('[data-test-render-count]') && PLATFORM.id === 'claude'
        && element.closest('[data-test-render-count]') !== container) continue;
      const url = bestLiveImageUrl(element);
      const key = url || `attachment:${Math.round(element.getBoundingClientRect().left)}:${Math.round(element.getBoundingClientRect().top)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let imageSrc = '';
      if (element.tagName === 'CANVAS') {
        try { imageSrc = element.toDataURL('image/png'); } catch {}
        if (!imageSrc) imageSrc = await captureVisibleImageRegion(element, signal);
      } else {
        imageSrc = embedImages ? await embedVisibleProviderImage(element, url, signal) : url;
      }
      if (!imageSrc) {
        missing += 1;
        clone.appendChild(makeMissingImageNotice());
        continue;
      }
      const figure = document.createElement('figure');
      figure.className = 'export-media-wrapper export-user-attachment';
      const image = document.createElement('img');
      image.src = imageSrc;
      image.alt = 'Uploaded image';
      image.className = 'export-user-media';
      image.setAttribute('data-export-image-kind', 'export-user-media');
      image.setAttribute('loading', 'eager');
      image.setAttribute('decoding', 'sync');
      const width = Math.round(element.getBoundingClientRect().width);
      if (width >= 32 && width <= 2400) image.style.setProperty('--chatfolio-image-width', `${width}px`);
      figure.appendChild(image);
      clone.appendChild(figure);
      count += 1;
      if (embedImages) embedded += 1;
      mediaKeys?.push(key);
    }
    return { count, embedded, missing };
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

  return {
    bestLiveImageUrl, plausibleLiveUserPicture, liveImageInViewport,
    saveImageScrollPositions, restoreImageScrollPositions,
    waitForLiveUserImage, captureVisibleImageRegion, embedVisibleProviderImage,
    makeMissingImageNotice, providerUserMediaContainer, appendProviderUserImages,
    sourceToDataUrl, blobToDataUrl
  };
}
