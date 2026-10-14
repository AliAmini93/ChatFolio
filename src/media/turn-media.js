/**
 * Phase 4B2: authored-turn media preparation (canvas, image pairs, attachments).
 * The original processing bodies are preserved to avoid provider regressions.
 * This factory requires only explicit browser, provider and pipeline helpers.
 */
export function createTurnMediaProcessor({
  PLATFORM, document, normalizeText, sleepWithAbort, bestLiveImageUrl,
  sourceToDataUrl, embedVisibleProviderImage, absoluteUrl,
  makeMissingImageNotice
}) {
  async function embedTurnCanvases(source, clone, role, signal) {
    let embeddedImageCount = 0;
    let meaningfulImageCount = 0;
    let missingUserImages = 0;
    // Convert canvas output to ordinary images before pruning the clone.
    const sourceCanvases = [...source.querySelectorAll("canvas")];
    const cloneCanvases = [...clone.querySelectorAll("canvas")];
    for (let i = 0; i < Math.min(sourceCanvases.length, cloneCanvases.length); i += 1) {
      if (i % 4 === 0) await sleepWithAbort(0, signal);
      try {
        const dataUrl = sourceCanvases[i].toDataURL("image/png");
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = sourceCanvases[i].getAttribute("aria-label") || "Conversation image";
        img.classList.add(role === "user" ? "export-user-media" : "export-content-image");
        cloneCanvases[i].replaceWith(img);
        embeddedImageCount += 1;
        meaningfulImageCount += 1;
      } catch {
        if (role === 'user') missingUserImages += 1;
        cloneCanvases[i].replaceWith(makeMissingImageNotice());
      }
    }

    return { embeddedImageCount, meaningfulImageCount, missingUserImages };
  }

  function preserveMediaAndAttachmentButtons(root) {
    let attachmentCount = 0;
    const attachmentPattern = /([^\/\n]+?\.(pdf|docx?|xlsx?|csv|pptx?|zip|txt|md|rtf|mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm))\b/i;

    function makeAttachment(text) {
      const fileMatch = normalizeText(text || "").match(attachmentPattern);
      if (!fileMatch) return null;

      const replacement = document.createElement("div");
      replacement.className = "export-attachment";

      const filename = document.createElement("span");
      filename.className = "export-attachment-name";
      filename.textContent = fileMatch[1].trim();

      const type = document.createElement("span");
      type.className = "export-attachment-type";
      type.textContent = fileMatch[2].toUpperCase();
      replacement.append(filename, type);
      return replacement;
    }

    root.querySelectorAll("button").forEach((button) => {
      const hasMedia = Boolean(button.querySelector("img, picture, canvas"));
      const text = normalizeText(button.innerText || button.textContent || "");
      const attachment = makeAttachment(text);
      const imageFileMatch = text.match(/([^\/\n]+?\.(png|jpe?g|webp|gif|svg))\b/i);

      if (attachment) {
        button.replaceWith(attachment);
        attachmentCount += 1;
        return;
      }

      if (!hasMedia && !imageFileMatch) return;

      const replacement = document.createElement("figure");
      replacement.className = "export-media-wrapper";
      while (button.firstChild) replacement.appendChild(button.firstChild);
      button.replaceWith(replacement);
    });

    // Gemini and other Material-style UIs can expose uploaded files as chips
    // instead of buttons. Only convert candidates with an explicit filename.
    const chipSelectors = [
      '[data-test-id*="file"]', '[data-testid*="file"]',
      '[class*="attachment"]', '[class*="file-chip"]',
      '[class*="file-preview"]', '[class*="uploaded-file"]'
    ].join(',');

    for (const candidate of [...root.querySelectorAll(chipSelectors)]) {
      if (!root.contains(candidate)) continue;
      if (candidate.closest('.export-attachment')) continue;
      const attachment = makeAttachment(candidate.innerText || candidate.textContent || "");
      if (!attachment) continue;

      // Prefer the outermost matching chip so nested labels do not create duplicates.
      const parentMatch = candidate.parentElement?.closest?.(chipSelectors);
      if (parentMatch && root.contains(parentMatch) && makeAttachment(parentMatch.innerText || parentMatch.textContent || "")) continue;

      candidate.replaceWith(attachment);
      attachmentCount += 1;
    }

    return attachmentCount;
  }

  function preserveGeminiSiblingAttachments(messageNode, clone) {
    const container = messageNode?.closest?.('.conversation-container');
    if (!container) return 0;

    const attachmentPattern = /([^\/\n]+?\.(pdf|docx?|xlsx?|csv|pptx?|zip|txt|md|rtf|mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm))\b/i;
    const seen = new Set();
    const existingText = normalizeText(clone.textContent || "").toLowerCase();
    let count = 0;

    const selectors = [
      'button', 'audio', 'video',
      '[data-file-name]', '[data-filename]', '[data-mime-type]', '[data-file-type]', '[mime-type]',
      '[data-test-id*="file"]', '[data-testid*="file"]',
      '[class*="attachment"]', '[class*="file-chip"]', '[class*="file-preview"]', '[class*="uploaded-file"]',
      '[aria-label]', '[title]'
    ].join(',');

    const appendAttachment = (filename, typeLabel, keySource) => {
      const key = String(keySource || filename || typeLabel).toLowerCase();
      if (!key || seen.has(key) || (filename && existingText.includes(String(filename).toLowerCase()))) return false;
      seen.add(key);

      const replacement = document.createElement('div');
      replacement.className = 'export-attachment';
      const name = document.createElement('span');
      name.className = 'export-attachment-name';
      name.textContent = filename || `${String(typeLabel || 'Media').toLowerCase()} attachment`;
      const type = document.createElement('span');
      type.className = 'export-attachment-type';
      type.textContent = String(typeLabel || 'MEDIA').toUpperCase();
      replacement.append(name, type);
      clone.appendChild(replacement);
      count += 1;
      return true;
    };

    for (const candidate of [...container.querySelectorAll(selectors)]) {
      if (messageNode.contains(candidate)) continue;
      if (candidate.closest('model-response')) continue;
      const raw = [
        candidate.getAttribute?.('data-file-name'),
        candidate.getAttribute?.('data-filename'),
        candidate.getAttribute?.('aria-label'),
        candidate.getAttribute?.('title'),
        candidate.currentSrc,
        candidate.src,
        candidate.innerText,
        candidate.textContent
      ].filter(Boolean).join(' ');
      const normalizedRaw = normalizeText(raw);
      const match = normalizedRaw.match(attachmentPattern);
      if (match) {
        appendAttachment(match[1].trim(), match[2], match[1]);
        continue;
      }

      const mime = normalizeText([
        candidate.getAttribute?.('data-mime-type'),
        candidate.getAttribute?.('data-file-type'),
        candidate.getAttribute?.('mime-type'),
        candidate.getAttribute?.('type')
      ].filter(Boolean).join(' ')).toLowerCase();
      const tag = candidate.tagName?.toLowerCase?.() || '';
      const label = normalizedRaw.toLowerCase();
      const isAudio = tag === 'audio' || mime.startsWith('audio/') || /\b(audio|voice|recording)\b/.test(label);
      const isVideo = tag === 'video' || mime.startsWith('video/') || /\bvideo\b/.test(label);
      if (isAudio || isVideo) {
        const type = isAudio ? 'AUDIO' : 'VIDEO';
        appendAttachment('', type, `${type}:${candidate.currentSrc || candidate.src || label.slice(0, 80)}`);
      }
    }
    return count;
  }

  function classifyImage(sourceImg, role) {
    const rect = sourceImg.getBoundingClientRect?.() || { width: 0, height: 0 };
    const renderedWidth = Number(rect.width || 0);
    const renderedHeight = Number(rect.height || 0);
    const naturalWidth = Number(sourceImg.naturalWidth || 0);
    const naturalHeight = Number(sourceImg.naturalHeight || 0);
    const alt = normalizeText(sourceImg.getAttribute("alt") || sourceImg.getAttribute("aria-label") || "").toLowerCase();
    const inButton = Boolean(sourceImg.closest("button"));
    const inExternalLink = Boolean(sourceImg.closest("a[href]"));
    const inSourceContext = Boolean(sourceImg.closest(
      "[data-testid*='source'], [data-testid*='citation'], [class*='source'], [class*='citation'], [class*='reference']"
    ));
    const largeIntrinsic = naturalWidth >= 320 || naturalHeight >= 320;
    const wideRendered = renderedWidth >= 180 || renderedHeight >= 140;
    const likelyUploaded = /uploaded|attachment|image|screenshot|photo|figure|preview/.test(alt);

    const roughlySquare = (() => {
      const w = renderedWidth || naturalWidth;
      const h = renderedHeight || naturalHeight;
      if (!w || !h) return false;
      const ratio = w / h;
      return ratio >= 0.55 && ratio <= 1.8;
    })();

    const renderedTiny = renderedWidth > 0 && renderedHeight > 0 && renderedWidth <= 96 && renderedHeight <= 96;
    const renderedSmall = renderedWidth > 0 && renderedHeight > 0 && renderedWidth <= 150 && renderedHeight <= 150;
    const intrinsicSmall = naturalWidth > 0 && naturalHeight > 0 && naturalWidth <= 256 && naturalHeight <= 256;

    if (role === "user" && (inButton || likelyUploaded || largeIntrinsic || wideRendered)) {
      return "export-user-media";
    }

    // Source favicons/logos can have a large intrinsic bitmap but are rendered tiny.
    // Classify primarily from their rendered size and source/citation context.
    if (
      role !== "user" &&
      roughlySquare &&
      (renderedTiny || (renderedSmall && (inExternalLink || inSourceContext))) &&
      !likelyUploaded
    ) {
      return "export-preview-logo";
    }

    if (inSourceContext && role !== "user" && renderedWidth <= 180 && renderedHeight <= 180 && !likelyUploaded) {
      return "export-preview-logo";
    }

    if (largeIntrinsic && (wideRendered || !inExternalLink)) {
      return "export-content-image";
    }

    if ((inExternalLink && renderedSmall) || (intrinsicSmall && roughlySquare && role === "assistant")) {
      return "export-preview-logo";
    }

    return "export-content-image";
  }

  async function embedTurnImagePairs(imagePairs, clone, role, embedImages, signal, mediaKeys) {
    let embeddedImageCount = 0;
    let meaningfulImageCount = 0;
    let missingUserImages = 0;
    for (let i = 0; i < imagePairs.length; i += 1) {
      if (i % 4 === 0) await sleepWithAbort(0, signal);
      const { sourceImg, cloneImg } = imagePairs[i];
      if (!clone.contains(cloneImg)) continue;
      const src = bestLiveImageUrl(sourceImg);
      const mediaKey = src || sourceImg.getAttribute("alt") || `image-${i}`;
      mediaKeys.push(mediaKey);

      const imageKind = classifyImage(sourceImg, role);
      cloneImg.classList.add(imageKind);
      if (imageKind === "export-preview-logo") {
        const sourceRef = cloneImg.closest("a, figure");
        if (sourceRef) {
          const refText = normalizeText(sourceRef.textContent || "");
          const refImages = sourceRef.querySelectorAll("img").length;
          if (refText.length <= 90 && refImages <= 1) sourceRef.classList.add("export-source-ref");
        }
      }
      cloneImg.setAttribute("data-export-image-kind", imageKind);
      // Provider-controlled CSS disappears in the standalone print document.
      // Save the LIVE displayed width before removing layout styles; otherwise
      // a 200px product image expands to its multi-thousand-pixel intrinsic size.
      const liveRect = sourceImg.getBoundingClientRect?.();
      const liveWidth = Math.round(Number(liveRect?.width || 0));
      if (liveWidth >= 32 && liveWidth <= 2400) {
        cloneImg.style.setProperty('--chatfolio-image-width', `${liveWidth}px`);
      }
      const liveHeight = Number(liveRect?.height || 0);
      const ratio = liveHeight > 0 ? liveWidth / liveHeight : 0;
      if (imageKind === 'export-content-image' &&
        (ratio >= 1.42 || /(?:screenshot|screen\s*shot|capture)/i.test(sourceImg.alt || ''))) {
        cloneImg.classList.add('export-response-screenshot');
      }
      // Count actual picture content, not merely a placeholder or broken icon.
      const isUserImage = role === 'user' && imageKind === 'export-user-media';
      const liveImageLooksReal = Number(sourceImg.naturalWidth || 0) >= 24 && Number(sourceImg.naturalHeight || 0) >= 24;
      if (imageKind !== "export-preview-logo" && (!isUserImage || liveImageLooksReal)) meaningfulImageCount += 1;

      cloneImg.removeAttribute("srcset");
      cloneImg.removeAttribute("sizes");
      cloneImg.setAttribute("loading", "eager");
      cloneImg.setAttribute("decoding", "sync");

      if (!src && !isUserImage) continue;

      if (embedImages) {
        const embedded = PLATFORM.id === 'chatgpt'
          ? await sourceToDataUrl(src, signal)
          : await embedVisibleProviderImage(sourceImg, src, signal);
        if (embedded) {
          cloneImg.src = embedded;
          embeddedImageCount += 1;
          if (isUserImage && !liveImageLooksReal) meaningfulImageCount += 1;
        } else if (isUserImage) {
          // A broken <img> cannot masquerade as a successful archived attachment.
          // The full-conversation serializer reports an explicit warning instead.
          missingUserImages += 1;
          cloneImg.replaceWith(makeMissingImageNotice());
        } else if (src) {
          cloneImg.src = absoluteUrl(src) || src;
        }
      } else if (src) {
        cloneImg.src = absoluteUrl(src) || src;
      }
    }

    return { embeddedImageCount, meaningfulImageCount, missingUserImages };
  }

  return {
    embedTurnCanvases, embedTurnImagePairs, classifyImage,
    preserveMediaAndAttachmentButtons, preserveGeminiSiblingAttachments
  };
}
