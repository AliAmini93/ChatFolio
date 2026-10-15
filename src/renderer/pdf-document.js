/**
 * Provider-neutral A4/RTL printable document renderer.
 *
 * The factory declares its outside dependencies so the ESM source is testable
 * in isolation, while the transitional MV3 generator can embed it inside the
 * existing single classic content script without adding Chrome permissions.
 *
 * Defense in depth: the renderer sanitizes every incoming message fragment
 * before layout, even if a non-DOM extraction route bypassed serializeTurn().
 */
export function createPdfDocumentRenderer({
  document, Node, Element, escapeHtml, mergeFontStacks, inferDirection,
  sanitizePrintClone
}) {
  function sanitizeMessageHtml(html) {
    // A template keeps parsed markup inert until after the allowlisted DOM
    // sanitizer has removed scripts, event handlers, unsafe URL references and
    // provider metadata. Never add raw incoming HTML to the printable document.
    if (!document?.createElement || typeof sanitizePrintClone !== 'function') {
      throw new Error('The PDF renderer requires an HTML sanitizer.');
    }
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    sanitizePrintClone(template.content);
    return template.innerHTML;
  }

  function safePrintFontStack(value, fallback) {
    const candidate = String(value || '').trim();
    // CSS font-family grammar here deliberately admits only literal names and
    // comma-separated fallback families, not var(), url(), brackets, braces,
    // backslash escapes or arbitrary CSS declarations.
    return candidate.length <= 380 &&
      /^[\p{L}\p{N} .,'"_\-]+$/u.test(candidate)
      ? candidate : fallback;
  }

  function splitPrintableMessageOpening(html) {
    // Keep the role badge and the FIRST authored content unit in one unbreakable
    // print fragment. break-after:avoid on the badge alone fails when ChatGPT
    // nests screenshots/paragraphs several divs deep. Never keep a whole long
    // message together: doing so would reintroduce large empty page regions.
    const root = document.createElement('div');
    root.innerHTML = html;
    const front = document.createElement('div');
    const atomic = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'PICTURE',
      'FIGURE', 'PRE', 'BLOCKQUOTE', 'SVG', 'MATH', 'LI'
    ]);
    const structural = new Set(['DIV', 'SECTION', 'ARTICLE', 'SPAN', 'A', 'UL', 'OL', 'LABEL']);
    const visible = (node) => node.nodeType === Node.TEXT_NODE
      ? Boolean((node.nodeValue || '').trim())
      : node.nodeType === Node.ELEMENT_NODE && (
          Boolean((node.textContent || '').trim()) ||
          Boolean(node.querySelector('img, svg, math, video, canvas, pre, table')) ||
          ['IMG','SVG','MATH','TABLE','PRE'].includes(node.tagName)
        );

    function firstUnit(parent) {
      for (const child of [...parent.childNodes]) {
        if (!visible(child)) continue;
        if (child.nodeType === Node.TEXT_NODE) return child;
        if (!(child instanceof Element)) continue;
        if (child.tagName === 'TABLE') return null; // never force a long table to stay on one page
        // A favicon + hostname + +N counter is one semantic linked source.
        // Never peel only its first IMG into the opening fragment.
        if ((child.matches('.export-source-chip, .export-source-ref') ||
            (child.tagName === 'A' && child.querySelector('img.export-preview-logo'))) &&
            (child.textContent || '').length < 170) return child;
        if (atomic.has(child.tagName)) return child;
        if (child.tagName === 'UL' || child.tagName === 'OL') {
          const items = [...child.children].filter((item) => item.tagName === 'LI');
          // Do not split an ordered list and inadvertently reset its numbering.
          if (items.length <= 4 && (child.textContent || '').length <= 360) return child;
          return null;
        }
        if (structural.has(child.tagName)) {
          const nested = firstUnit(child);
          if (nested) return nested;
          return null;
        }
        return child;
      }
      return null;
    }

    function takeUnit(target) {
      const parents = [];
      let current = target.parentNode;
      while (current && current !== root) {
        parents.push(current);
        current = current.parentNode;
      }
      let moved = target;
      for (const parent of parents) {
        const shell = parent.cloneNode(false);
        shell.appendChild(moved);
        moved = shell;
      }
      front.appendChild(moved);
      // Remove emptied provider wrappers left behind, preserving later content.
      for (const parent of parents) {
        if (parent.parentNode && ![...parent.childNodes].some(visible)) parent.remove();
      }
    }

    for (let i = 0; i < 2; i += 1) {
      const target = firstUnit(root);
      if (!target) break;
      takeUnit(target);
      const enoughText = (front.textContent || '').trim().length >= 56;
      const includesMedia = Boolean(front.querySelector('img, svg, math, pre'));
      if (enoughText || includesMedia) break;
    }
    if (!front.hasChildNodes()) return { lead: '', rest: html, longTextOpening: false };
    // A single Gemini <p> (or text-only DIV) can contain an entire long reply.
    // Keeping that fragment indivisible pushes the whole reply to the next
    // page, leaving half an A4 sheet blank. Text-only long opening fragments
    // may split while the author label remains paired with the first lines.
    const leadTextLength = (front.textContent || '').replace(/\s+/g, ' ').trim().length;
    const longTextOpening = leadTextLength > 520 &&
      !front.querySelector('img, picture, svg, canvas, video, math, table, pre');
    return { lead: front.innerHTML, rest: root.innerHTML, longTextOpening };
  }

  function buildPrintableDocument(messages, title, options, totalImageCount, platform, sourceTypography = null) {
    const exportedAt = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());

    const safeMessages = messages.map((message) => ({
      ...message,
      html: sanitizeMessageHtml(message.html)
    }));
    const profile = detectDocumentProfile(safeMessages);
    const language = profile.lang;
    const documentDir = profile.dir;
    const isRtlDocument = documentDir === "rtl";
    const layoutMode = options.layoutMode === "compact" ? "compact" : "comfortable";
    const showMessageNumbers = options.showMessageNumbers !== false;
    const systemUiStack = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
    const sourceBaseFont = sourceTypography?.base?.fontFamily || "";
    const sourceRtlFont = sourceTypography?.rtl?.fontFamily || sourceBaseFont;
    const sourceLtrFont = sourceTypography?.ltr?.fontFamily || sourceBaseFont;
    const documentFontStack = safePrintFontStack(
      mergeFontStacks(isRtlDocument ? sourceRtlFont : sourceLtrFont, systemUiStack), systemUiStack);
    const ltrFontStack = safePrintFontStack(mergeFontStacks(sourceLtrFont, systemUiStack), systemUiStack);
    const rtlFontStack = safePrintFontStack(mergeFontStacks(sourceRtlFont, systemUiStack), systemUiStack);
    const userCount = safeMessages.filter((message) => message.role === "user").length;
    const assistantCount = safeMessages.filter((message) => message.role === "assistant").length;
    const exchanges = groupMessagesIntoExchanges(safeMessages);

    const assistantName = platform?.assistantLabel || platform?.name || "Assistant";
    const platformName = platform?.name || assistantName;
    const translations = {
      fa: {
        conversation: `گفت‌وگوی ${platformName}`,
        messages: "پیام",
        media: "رسانه",
        you: "شما",
        assistant: assistantName,
        message: "پیام",
        exported: "خروجی گرفته‌شده در"
      },
      ar: {
        conversation: `محادثة ${platformName}`,
        messages: "رسالة",
        media: "وسائط",
        you: "أنت",
        assistant: assistantName,
        message: "رسالة",
        exported: "تم التصدير في"
      },
      en: {
        conversation: `${platformName} conversation`,
        messages: "messages",
        media: "media",
        you: "You",
        assistant: assistantName,
        message: "Message",
        exported: "Exported"
      }
    };
    const t = translations[profile.uiLocale] || translations.en;

    let messageNumber = 0;
    const exchangeHtml = exchanges.map((exchange) => {
      const inner = exchange.map((message) => {
        messageNumber += 1;
        const label = message.role === "user" ? t.you : message.role === "assistant" ? t.assistant : message.role;
        const shortClass = (message.text || "").length < 240 && Number(message.imageCount || 0) === 0 ? " message-short" : "";
        const mediaClass = Number(message.imageCount || 0) > 0 ? " has-media" : "";
        const numberHtml = showMessageNumbers
          ? `<span class="message-number">${escapeHtml(t.message)} ${messageNumber}</span>`
          : "";
        const opening = splitPrintableMessageOpening(message.html);
        // Gemini can render a very long answer as one paragraph. Only for
        // text-only long openings let Chromium paginate within that fragment.
        const openingFlowClass = platform?.id === 'gemini' && opening.longTextOpening
          ? ' message-opening-flow' : '';
        const metaHtml = `<div class="message-meta"><span class="role-badge">${escapeHtml(label)}</span>${numberHtml}</div>`;
        return `
          <section class="message ${escapeHtml(message.role)}${shortClass}${mediaClass}">
            ${opening.lead
              ? `<div class="message-opening${openingFlowClass}">${metaHtml}<div class="message-body message-lead" dir="auto">${opening.lead}</div></div>
                 <div class="message-body message-continuation" dir="auto">${opening.rest}</div>`
              : `${metaHtml}<div class="message-body" dir="auto">${message.html}</div>`}
          </section>
        `;
      }).join("\n");
      return `<article class="exchange">${inner}</article>`;
    }).join("\n");

    const mediaStat = Number(totalImageCount || 0) > 0
      ? `<span class="stat-item"><bdi dir="ltr">${totalImageCount}</bdi><span>${escapeHtml(t.media)}</span></span>`
      : "";
    const statsHtml = isRtlDocument
      ? [
          `<span class="stat-item"><bdi dir="ltr">${messages.length}</bdi><span>${escapeHtml(t.messages)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${userCount}</bdi><span>${escapeHtml(t.you)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${assistantCount}</bdi><bdi dir="ltr">${escapeHtml(t.assistant)}</bdi></span>`,
          mediaStat
        ].join("")
      : [
          `<span class="stat-item"><bdi dir="ltr">${messages.length}</bdi><span>${escapeHtml(t.messages)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${userCount}</bdi><span>from ${escapeHtml(t.you)}</span></span>`,
          `<span class="stat-item"><bdi dir="ltr">${assistantCount}</bdi><span>from ${escapeHtml(t.assistant)}</span></span>`,
          mediaStat
        ].join("");

    return `<!doctype html>
<html lang="${language}" dir="${documentDir}" data-script="${profile.script}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    /* Provider font-family stacks are retained after validation. Untrusted
       raw @font-face CSS must not be inserted into the report style element:
       it could contain @import, network URLs or an HTML style-element terminator. */

    @page {
      size: A4;
      margin: 15mm 14mm 16mm;
      /* Chromium's four default margin boxes add browser date/title/URL/page
         even when the conversation itself has no header/footer. Supplying
         empty author-defined boxes suppresses those print artifacts without
         touching PDF text or needing additional extension permissions. */
      @top-left { content: ""; }
      @top-right { content: ""; }
      @bottom-left { content: ""; }
      @bottom-right { content: ""; }
      @bottom-center {
        content: counter(page) " / " counter(pages);
        font-family: Arial, sans-serif;
        direction: ltr;
        unicode-bidi: isolate;
        font-size: 8pt;
        font-weight: 400;
        color: #8a929a;
      }
    }

    * { box-sizing: border-box; }

    :root {
      --ink: #171717;
      --muted: #6b7280;
      --line: #e5e7eb;
      --line-soft: #eef0f2;
      --user-bg: #f5f6f7;
      --code-bg: #f6f7f8;
      --accent: #0f8f70;
      --accent-soft: #eaf7f2;
      --font-source: ${documentFontStack};
      --font-latin: ${ltrFontStack};
      --font-rtl-source: ${rtlFontStack};
      --font-arabic-fallback: "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma, Arial, sans-serif;
    }

    html {
      background: #fff;
      color: var(--ink);
      font-family: var(--font-source), var(--font-arabic-fallback);
      font-size: ${layoutMode === "compact" ? "10.1pt" : "10.9pt"};
      line-height: ${layoutMode === "compact" ? "1.52" : "1.62"};
      text-rendering: optimizeLegibility;
    }

    html[dir="rtl"] {
      font-size: ${layoutMode === "compact" ? "10.4pt" : "11.15pt"};
      line-height: ${layoutMode === "compact" ? "1.68" : "1.82"};
    }

    html[data-script="arabic"] {
      /* Match the provider page's own CSS font stack first. Let Chrome choose the
         same glyph-level fallback it uses in the live chat instead of forcing a
         different Arabic font for the entire RTL block. */
      font-family: var(--font-source), var(--font-arabic-fallback);
    }

    html[data-script="hebrew"] {
      font-family: "Noto Sans Hebrew", "Arial Hebrew", Arial, "Segoe UI", sans-serif;
    }

    html[data-script="cjk"] {
      font-family: "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "PingFang SC", "Hiragino Sans", "Yu Gothic", Meiryo, "Microsoft YaHei", "Malgun Gothic", "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.55" : "1.68"};
    }

    html[data-script="devanagari"] {
      font-family: "Noto Sans Devanagari", "Nirmala UI", Mangal, "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.62" : "1.74"};
    }

    html[data-script="thai"] {
      font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, "Segoe UI", sans-serif;
      line-height: ${layoutMode === "compact" ? "1.58" : "1.72"};
    }

    body {
      margin: 0;
      background: #fff;
      color: var(--ink);
    }

    .document-header {
      direction: ${documentDir};
      margin: 0 0 18px;
      padding: 0 0 12px;
      border-bottom: 1.5px solid var(--line);
    }

    .document-kicker {
      margin-bottom: 4px;
      color: var(--accent);
      font-size: 8.6pt;
      font-weight: 700;
      letter-spacing: ${isRtlDocument ? "0" : "0.025em"};
    }

    .document-header h1 {
      margin: 0;
      font-size: 20pt;
      line-height: 1.28;
      font-weight: 760;
      overflow-wrap: anywhere;
      unicode-bidi: plaintext;
    }

    .document-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 9px;
      color: var(--muted);
      font-size: 8.45pt;
      direction: ${documentDir};
    }

    .stat-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border: 1px solid #e6e8eb;
      border-radius: 999px;
      background: #fafbfb;
      unicode-bidi: isolate;
      white-space: nowrap;
    }

    .stat-item bdi { font-variant-numeric: tabular-nums; }
    .export-time { color: var(--muted); align-self: center; margin-inline-start: 3px; }

    .exchange {
      margin: 0 0 ${layoutMode === "compact" ? "8px" : "12px"};
      padding: 0 0 ${layoutMode === "compact" ? "6px" : "8px"};
      border-bottom: 1px solid var(--line-soft);
    }

    .exchange:last-child {
      border-bottom: 0;
      margin-bottom: 0;
      padding-bottom: 0;
    }

    main {
      margin: 0;
      padding: 0;
    }

    main > :last-child {
      margin-bottom: 0 !important;
      padding-bottom: 0 !important;
    }

    .message {
      position: relative;
      margin: 0 0 ${layoutMode === "compact" ? "6px" : "8px"};
      break-inside: auto;
      direction: ${documentDir};
    }

    /* Group just the first content fragment with the author badge. */
    .message-opening {
      break-inside: avoid-page;
      page-break-inside: avoid;
    }
    /* Long Gemini opening paragraphs need to fragment rather than forcing the
       *entire* answer onto the next page. All ordinary badge/opening pairs,
       especially those with images, retain their no-break protection. */
    .message-opening.message-opening-flow {
      break-inside: auto;
      page-break-inside: auto;
    }
    .message-opening .message-meta { break-after: avoid-page; }
    .message-lead > :first-child { margin-top: 0 !important; }
    .message-lead > :last-child { margin-bottom: 0 !important; }
    .message-continuation:empty { display: none; }

    .message:last-child { margin-bottom: 0; }

    .message.user {
      padding: ${layoutMode === "compact" ? "8px 10px" : "10px 12px"};
      background: var(--user-bg);
      border: 1px solid var(--line);
      border-radius: 10px;
    }

    .message.assistant {
      padding: ${layoutMode === "compact" ? "4px 10px 4px 12px" : "5px 11px 5px 14px"};
      border-inline-start: 3px solid var(--accent);
      background: #fff;
    }

    .message.message-short { break-inside: avoid-page; }

    .message-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 20px;
      margin-bottom: ${layoutMode === "compact" ? "4px" : "6px"};
      break-after: avoid-page;
      page-break-after: avoid;
      direction: ${documentDir};
    }

    .role-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 8.3pt;
      font-weight: 730;
      line-height: 1.2;
      white-space: nowrap;
    }

    .user .role-badge {
      background: #e7e9ec;
      color: #40454c;
    }

    .assistant .role-badge {
      background: var(--accent-soft);
      color: #087258;
    }

    .message-number {
      color: #9aa0a6;
      font-size: 7.8pt;
      font-weight: 500;
      white-space: nowrap;
    }

    .message-body {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .message-body [dir="rtl"] {
      text-align: right !important;
      unicode-bidi: plaintext;
      font-family: var(--font-rtl-source), var(--font-arabic-fallback);
    }

    .message-body [dir="ltr"] {
      text-align: left !important;
      unicode-bidi: plaintext;
      font-family: var(--font-latin);
    }

    /* Keep UI labels on the same live-page font stack captured from the provider.
       This mirrors the browser's own glyph fallback for Persian/Arabic instead of
       forcing a separate Arabic family across the whole RTL block. */
    html[dir="rtl"] .document-kicker,
    html[dir="rtl"] .document-stats,
    html[dir="rtl"] .role-badge,
    html[dir="rtl"] .message-number {
      font-family: var(--font-rtl-source), var(--font-arabic-fallback);
    }

    .message-body p,
    .message-body li,
    .message-body blockquote,
    .message-body td,
    .message-body th,
    .message-body figcaption {
      unicode-bidi: plaintext;
    }

    .message-body bdi,
    .message-body code,
    .message-body kbd,
    .message-body samp,
    .message-body a {
      unicode-bidi: isolate;
    }

    .message-body > :first-child {
      margin-top: 0 !important;
      break-before: avoid-page;
      page-break-before: avoid;
    }
    /* A role label must stay attached to the first authored sentence even
       when the answer is wrapped in a provider DIV hierarchy. */
    .message:not(.message-short) .message-body > :first-child > :first-child {
      break-before: avoid-page;
    }
    .message-body > :last-child { margin-bottom: 0 !important; }
    .message-body [class] { max-width: 100%; }

    /* Neutral structural wrappers: no provider utility class, CSS grid/card
       viewport dimensions or source-page responsive min-height should survive. */
    .message-body :is(div, section, article, figure, picture) {
      min-height: 0 !important;
      height: auto !important;
      max-height: none !important;
      aspect-ratio: auto !important;
    }
    .message-body :is(div, section, article) {
      break-inside: auto;
      page-break-inside: auto;
    }

    p, ul, ol, blockquote, pre, table, figure {
      margin-top: ${layoutMode === "compact" ? "0.48em" : "0.62em"};
      margin-bottom: ${layoutMode === "compact" ? "0.48em" : "0.62em"};
    }

    p { orphans: 2; widows: 2; }

    ul, ol {
      padding-inline-start: 1.55em;
      margin-inline-start: 0;
    }

    li { padding-inline-start: 0.12em; }
    li + li { margin-top: 0.18em; }

    h1, h2, h3, h4, h5, h6 {
      break-after: avoid;
      margin-top: 0.95em;
      margin-bottom: 0.38em;
      line-height: 1.38;
      font-weight: 740;
      unicode-bidi: plaintext;
    }

    h1 { font-size: 16.8pt; }
    h2 { font-size: 14.3pt; }
    h3 { font-size: 12.6pt; }
    h4, h5, h6 { font-size: 11.4pt; }

    a {
      color: #1f5f95;
      text-decoration: underline;
      text-decoration-thickness: 0.055em;
      text-underline-offset: 0.12em;
      overflow-wrap: anywhere;
    }

    pre {
      direction: ltr !important;
      text-align: left !important;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--code-bg);
      border: 1px solid #dfe3e7;
      border-radius: 7px;
      padding: 9px 10px;
      font-size: 8.7pt;
      line-height: 1.48;
      break-inside: auto;
      unicode-bidi: isolate;
    }

    code, kbd, samp {
      direction: ltr;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
    }

    :not(pre) > code {
      background: #f0f2f4;
      border-radius: 4px;
      padding: 0.08em 0.28em;
    }

    blockquote {
      margin-inline: 0;
      padding-inline: 11px 3px;
      border-inline-start: 3px solid #c5cbd1;
      color: #444;
    }

    table {
      width: 100%;
      max-width: 100%;
      border-collapse: collapse;
      font-size: 9.1pt;
      table-layout: auto;
    }

    thead { display: table-header-group !important; }
    tbody { display: table-row-group !important; }
    table.export-table-short {
      break-inside: avoid-page !important;
      page-break-inside: avoid !important;
    }
    table.export-table-long {
      break-inside: auto !important;
      page-break-inside: auto !important;
    }
    thead tr, tbody tr {
      break-inside: avoid-page;
      page-break-inside: avoid;
    }

    th, td {
      border: 1px solid #d2d6da;
      padding: 5px 7px;
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    th {
      background: #f3f4f6;
      font-weight: 700;
    }

    img, svg {
      max-width: 100% !important;
      height: auto !important;
      object-fit: contain;
    }

    .export-api-image {
      margin: 10px 0 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .export-api-image img {
      display: block;
    }

    img.export-user-media,
    img.export-content-image {
      display: block;
      width: var(--chatfolio-image-width, auto) !important;
      height: auto !important;
      max-width: min(100%, 155mm) !important;
      max-height: 150mm !important;
      margin: 7px auto;
      object-fit: contain;
      border-radius: 6px;
      break-inside: avoid;
    }

    /* A generated picture/product image should NOT be printed page-wide.
       Wide screenshots still need enough width to keep small UI text legible. */
    img.export-content-image {
      max-width: min(100%, 112mm) !important;
      max-height: 108mm !important;
    }

    img.export-content-image.export-response-screenshot {
      max-width: min(100%, 155mm) !important;
      max-height: 130mm !important;
    }

    img.export-user-media {
      border: 1px solid #e1e4e7;
    }

    .export-image-unavailable {
      border: 1px solid #d5a585;
      background: #fffaf6;
      font-size: 10px;
      padding: 8px;
      margin: 7px 0;
    }

    .export-media-wrapper {
      max-width: 100%;
      margin: 8px 0;
      padding: 0;
      break-inside: avoid;
    }

    .export-visible-user-text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      unicode-bidi: plaintext;
    }

    /* Flatten source-card wrappers without removing citations, link targets,
       hostnames, or icons. Browsers can now place several references on the
       same line instead of giving each favicon an entire block of whitespace. */
    .message-body .export-source-chip {
      display: inline-flex !important;
      align-items: center;
      flex-wrap: wrap;
      gap: 3px 5px;
      max-width: 100%;
      width: auto !important;
      margin: 2px 5px 2px 0 !important;
      padding: 2px 6px !important;
      background: #f8faf9;
      border: 1px solid #e5eae7;
      border-radius: 7px;
      font-size: 8.2pt;
      line-height: 1.27;
      break-inside: avoid-page;
      vertical-align: middle;
    }
    .message-body .export-source-chip :is(div, span) {
      display: inline !important;
      margin: 0 !important;
      padding: 0 !important;
      min-height: 0 !important;
    }
    .message-body .export-source-chip :is(p, figure) {
      margin: 0 !important;
      padding: 0 !important;
    }
    .message-body .export-source-chip .export-source-extra-count,
    .message-body .export-source-ref .export-source-extra-count {
      display: inline !important;
      padding-inline-start: 5px !important;
      margin-inline-start: 4px !important;
      border-inline-start: 1px solid #d5dad8;
      unicode-bidi: isolate;
      white-space: nowrap;
      color: #68727c;
    }
    .message-body .export-source-chip img.export-preview-logo {
      width: 14px !important;
      height: 14px !important;
      max-height: 14px !important;
      max-width: 14px !important;
    }

    .export-source-ref {
      display: inline-flex !important;
      align-items: center;
      gap: 4px;
      width: auto !important;
      max-width: 100%;
      min-height: 0 !important;
      margin: 3px 3px 3px 0 !important;
      padding: 2px 6px !important;
      border: 1px solid #e1e4e7;
      border-radius: 999px;
      background: #fafafa;
      color: #59606a;
      font-size: 8pt;
      line-height: 1.25;
      vertical-align: middle;
      break-inside: avoid;
    }

    img.export-preview-logo,
    .export-source-ref img {
      display: inline-block !important;
      width: 18px !important;
      height: 18px !important;
      max-width: 18px !important;
      max-height: 18px !important;
      margin: 0 !important;
      border-radius: 4px;
      object-fit: contain;
      vertical-align: middle;
    }

    .export-attachment {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 6px 9px;
      margin: 5px 3px;
      border: 1px solid #dfe3e7;
      border-radius: 8px;
      background: #f8f9fa;
      overflow-wrap: anywhere;
      font-size: 9pt;
      break-inside: avoid;
      direction: ltr;
      text-align: left;
    }

    .export-attachment::before {
      content: "▣";
      color: #7b838c;
      font-size: 8pt;
      flex: 0 0 auto;
    }

    .export-attachment-name {
      min-width: 0;
      overflow-wrap: anywhere;
      font-weight: 620;
    }

    .export-attachment-type {
      flex: 0 0 auto;
      padding: 1px 5px;
      border-radius: 5px;
      background: #eceff2;
      color: #6b7280;
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: .02em;
    }

    .export-writing-block {
      margin: 8px 0;
      padding: 9px 11px;
      border: 1px solid #dfe3e7;
      border-radius: 8px;
      background: #fbfbfc;
      break-inside: auto;
      overflow-wrap: anywhere;
    }

    .export-writing-block > :first-child { margin-top: 0 !important; }
    .export-writing-block > :last-child { margin-bottom: 0 !important; }

    figure {
      max-width: 100%;
      break-inside: auto;
    }

    /* A figure may be a long product/result card, not just one illustration.
       Keep the media intact, but let descriptive text flow onto the next page. */
    figure > img, figure > picture {
      break-inside: avoid-page;
      page-break-inside: avoid;
    }

    figcaption {
      color: var(--muted);
      font-size: 8.5pt;
      margin-top: 4px;
    }

    .katex-display,
    .math-display {
      direction: ltr;
      text-align: center;
      max-width: 100%;
      overflow-wrap: anywhere;
      overflow-x: visible !important;
      break-inside: avoid;
    }

    button, textarea, input, form, nav, aside, video, audio, iframe, script, style {
      display: none !important;
    }

    @media print {
      html, body, main {
        min-height: 0 !important;
        height: auto !important;
        padding-bottom: 0 !important;
        margin-bottom: 0 !important;
      }
      .exchange:last-child, .exchange:last-child .message:last-child, .exchange:last-child .message-body {
        margin-bottom: 0 !important;
        padding-bottom: 0 !important;
      }
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <header class="document-header">
    <div class="document-kicker">${escapeHtml(t.conversation)}</div>
    <h1 dir="auto">${escapeHtml(title)}</h1>
    <div class="document-stats">
      ${statsHtml}
      ${options.includeExportTime ? `<span class="export-time">${escapeHtml(t.exported)} ${escapeHtml(exportedAt)}</span>` : ""}
    </div>
  </header>
  <main>${exchangeHtml}</main>
</body>
</html>`;
  }

  function groupMessagesIntoExchanges(messages) {
    const exchanges = [];
    let current = [];
    let hasAssistant = false;

    for (const message of messages) {
      if (message.role === "user" && current.length && hasAssistant) {
        exchanges.push(current);
        current = [];
        hasAssistant = false;
      }
      current.push(message);
      if (message.role === "assistant") hasAssistant = true;
    }
    if (current.length) exchanges.push(current);
    return exchanges;
  }

  function detectDocumentProfile(messages) {
    const sample = messages.map((message) => message.text || "").join(" ").slice(0, 180000);
    const count = (regex) => (sample.match(regex) || []).length;

    const arabic = count(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g);
    const hebrew = count(/[\u0590-\u05FF\uFB1D-\uFB4F]/g);
    const latin = count(/[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/g);
    const cyrillic = count(/[\u0400-\u052F]/g);
    const greek = count(/[\u0370-\u03FF]/g);
    const han = count(/[\u3400-\u4DBF\u4E00-\u9FFF]/g);
    const kana = count(/[\u3040-\u30FF]/g);
    const hangul = count(/[\uAC00-\uD7AF\u1100-\u11FF]/g);
    const devanagari = count(/[\u0900-\u097F]/g);
    const thai = count(/[\u0E00-\u0E7F]/g);

    const rtlChars = arabic + hebrew;
    const strongLtrChars = latin + cyrillic + greek + han + kana + hangul + devanagari + thai;
    const rtlMessages = messages.filter((message) => inferDirection(message.text || "") === "rtl").length;
    const dir = (
      rtlMessages >= Math.max(2, Math.ceil(messages.length * 0.2)) ||
      (rtlChars > 180 && rtlChars >= strongLtrChars * 0.35)
    ) ? "rtl" : "ltr";

    const hasUrduSpecific = /[ٹڈڑںھہے]/.test(sample);
    const hasPersianSpecific = /[پچژگکی]/.test(sample) && !hasUrduSpecific;

    let lang = "und";
    let uiLocale = "en";
    let script = "latin";

    // Direction and script must not disagree merely because a Persian/Arabic chat
    // contains lots of English identifiers, URLs, code, or pasted technical text.
    // If the document is clearly RTL, choose its RTL script first.
    if (dir === "rtl" && arabic >= 20 && arabic >= hebrew * 0.75) {
      script = "arabic";
      if (hasUrduSpecific) lang = "ur";
      else if (hasPersianSpecific) { lang = "fa"; uiLocale = "fa"; }
      else { lang = "ar"; uiLocale = "ar"; }
    } else if (dir === "rtl" && hebrew >= 20) {
      script = "hebrew";
      lang = "he";
    } else if (arabic >= Math.max(40, latin * 0.18)) {
      script = "arabic";
      if (hasUrduSpecific) lang = "ur";
      else if (hasPersianSpecific) { lang = "fa"; uiLocale = "fa"; }
      else { lang = "ar"; uiLocale = "ar"; }
    } else if (hebrew >= Math.max(40, latin * 0.18)) {
      script = "hebrew";
      lang = "he";
    } else if (hangul >= 40) {
      script = "cjk";
      lang = "ko";
    } else if (kana >= 20) {
      script = "cjk";
      lang = "ja";
    } else if (han >= 50) {
      script = "cjk";
      lang = "zh";
    } else if (devanagari >= 40) {
      script = "devanagari";
      lang = "hi";
    } else if (thai >= 40) {
      script = "thai";
      lang = "th";
    } else if (cyrillic >= 40) {
      script = "cyrillic";
      lang = "und";
    } else if (greek >= 40) {
      script = "greek";
      lang = "el";
    } else if (latin >= 20) {
      script = "latin";
      lang = "en";
    }

    return { lang, dir, uiLocale, script };
  }

  return Object.freeze({
    buildPrintableDocument,
    splitPrintableMessageOpening,
    groupMessagesIntoExchanges,
    detectDocumentProfile
  });
}
