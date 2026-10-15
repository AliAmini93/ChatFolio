/**
 * Phase 5C1: conservative, provider-neutral print-clone HTML sanitizer.
 *
 * Run this ONLY on a detached, already-serialized turn clone. Never mutate a
 * live provider DOM subtree or attempt to sanitize a full HTML/CSS document.
 */
export function createPrintHtmlSanitizer({ document }) {
  const htmlTags = new Set((
    'a abbr article b bdi bdo blockquote br caption cite code col colgroup ' +
    'dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 ' +
    'header hr i img ins kbd li main mark ol p picture pre q rp rt ruby s ' +
    'samp section small span strong sub summary sup table tbody td tfoot th ' +
    'thead time tr u ul var wbr'
  ).split(' '));
  const svgTags = new Set((
    'svg g path rect circle ellipse line polyline polygon defs symbol use ' +
    'title desc clipPath mask linearGradient radialGradient stop text tspan'
  ).split(' ').map(value => value.toLowerCase()));
  const mathTags = new Set((
    'math mrow mi mn mo ms mtext mfrac msqrt mroot msub msup msubsup ' +
    'munder mover munderover mtable mtr mtd mlabeledtr mspace mstyle ' +
    'mpadded mphantom menclose mmultiscripts mprescripts none semantics ' +
    'annotation annotation-xml'
  ).split(' '));
  // A node in this set never contributes printable authored text.
  const removeSubtree = new Set((
    'script style iframe frame frameset object embed portal form input textarea ' +
    'select option button nav audio video source track link meta base noscript ' +
    'template canvas foreignobject animate animatemotion animatetransform set ' +
    'discard feimage image'
  ).split(' '));

  const safeGlobalAttrs = new Set([
    'class', 'style', 'dir', 'lang', 'title', 'role', 'aria-label', 'aria-hidden'
  ]);
  const safeHtmlAttrs = new Set([
    'alt', 'width', 'height', 'colspan', 'rowspan', 'scope', 'start',
    'reversed', 'open', 'datetime', 'cite', 'abbr'
  ]);
  const safeSvgAttrs = new Set([
    'id', 'viewbox', 'preserveaspectratio', 'xmlns', 'width', 'height',
    'd', 'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
    'fill-opacity', 'opacity', 'transform', 'x', 'y', 'x1', 'x2', 'y1',
    'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'pathlength', 'offset',
    'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
    'spreadmethod', 'xml:space', 'focusable'
  ]);
  const safeMathAttrs = new Set([
    'xmlns', 'display', 'displaystyle', 'mathvariant', 'mathsize', 'mathcolor',
    'mathbackground', 'scriptlevel', 'stretchy', 'symmetric', 'fence',
    'separator', 'lspace', 'rspace', 'minsize', 'maxsize', 'largeop',
    'movablelimits', 'accent', 'accentunder', 'notation', 'rowspan',
    'columnspan', 'columnalign', 'rowalign', 'encoding'
  ]);
  const safeCssProps = new Set([
    'color', 'background-color', 'font-family', 'font-size', 'font-weight',
    'font-style', 'font-variant', 'font-variant-ligatures', 'line-height',
    'letter-spacing', 'word-spacing', 'text-decoration', 'text-decoration-line',
    'text-decoration-style', 'text-decoration-color', 'text-transform',
    'text-indent', 'white-space', 'word-break', 'overflow-wrap',
    'vertical-align', 'text-align', 'direction', 'unicode-bidi', 'opacity',
    'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
    'border-width', 'border-color', 'border-style', 'border-radius',
    'border-top-width', 'border-bottom-width', 'border-left-width',
    'border-right-width', 'border-top-color', 'border-bottom-color',
    'border-left-color', 'border-right-color', 'background',
    '--chatfolio-image-width'
  ]);
  const mathCssProps = new Set([
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'top', 'left', 'right', 'bottom', 'margin', 'margin-top', 'margin-bottom',
    'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom',
    'padding-left', 'padding-right', 'display', 'position', 'transform'
  ]);

  function safeLinkUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
    try {
      const parsed = new URL(raw, document.baseURI);
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return '';
      // Browsers can parse https://evil@trusted.example as userinfo.
      if (parsed.username || parsed.password) return '';
      return parsed.href;
    } catch { return ''; }
  }

  function safeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
    if (/^data:/i.test(raw)) {
      return /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp)(?:;charset=[a-z0-9_-]+)?(?:;base64)?,/i.test(raw) ? raw : '';
    }
    try {
      const parsed = new URL(raw, document.baseURI);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (parsed.username || parsed.password) return '';
      return parsed.href;
    } catch { return ''; }
  }

  function safeFragmentRef(value) {
    const raw = String(value || '').trim();
    // SVG <use> and clip-path can only refer to a fragment in this document.
    return /^#[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(raw) ? raw : '';
  }

  function cleanInlineStyle(node, insideMath) {
    if (!node.hasAttribute('style')) return;
    const declarations = node.style;
    if (!declarations) {
      node.removeAttribute('style');
      return;
    }
    for (const name of [...declarations]) {
      const lower = name.toLowerCase();
      const value = declarations.getPropertyValue(name);
      const permitted = safeCssProps.has(lower) ||
        (insideMath && mathCssProps.has(lower));
      if (!permitted ||
          /url\s*\(|expression\s*\(|@import|behavior\s*:|binding\s*:|[\u0000-\u0008\u000b\u000e-\u001f]/i.test(value) ||
          (lower === 'position' && !/^(relative|absolute|static)$/i.test(value.trim())) ||
          (lower === 'display' && !/^(none|block|inline|inline-block|contents|table|table-cell)$/i.test(value.trim()))) {
        declarations.removeProperty(name);
      }
    }
    if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
  }

  function sanitizePrintClone(root) {
    // Freeze traversal before removing elements, preserving the order of source
    // text and media. Nested descendants of removed nodes are skipped.
    for (const node of [...root.querySelectorAll('*')]) {
      if (!root.contains(node)) continue;
      const tag = node.localName?.toLowerCase() || '';
      const ns = node.namespaceURI || '';
      const inSvg = ns === 'http://www.w3.org/2000/svg';
      const inMath = ns === 'http://www.w3.org/1998/Math/MathML';
      const allowed = inSvg ? svgTags.has(tag) : inMath ? mathTags.has(tag) : htmlTags.has(tag);
      if (removeSubtree.has(tag)) {
        node.remove();
        continue;
      }
      if (!allowed) {
        // Unknown provider/custom wrappers are not copied into the export,
        // but authored text and their safe descendants remain in order.
        node.replaceWith(...node.childNodes);
        continue;
      }

      const insideMath = inMath || Boolean(node.closest('.katex, .katex-display'));
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (name === 'href' && tag === 'a' && !inSvg && !inMath) {
          const url = safeLinkUrl(attr.value);
          if (url) node.setAttribute('href', url);
          else node.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'xlink:href') && inSvg &&
                   (tag === 'use' || tag === 'lineargradient' || tag === 'radialgradient')) {
          const fragment = safeFragmentRef(attr.value);
          if (fragment) node.setAttribute(attr.name, fragment);
          else node.removeAttribute(attr.name);
        } else if (name === 'src' && tag === 'img' && !inSvg) {
          const url = safeImageUrl(attr.value);
          if (url) node.setAttribute('src', url);
          else node.removeAttribute(attr.name);
        } else if (name === 'style') {
          cleanInlineStyle(node, insideMath);
        } else if (name === 'class' && !insideMath) {
          const kept = [...node.classList].filter(cls =>
            /^(?:export-|chatfolio-|hljs(?:-|$)|language-|katex(?:-|$)|math-)/.test(cls));
          if (kept.length) node.setAttribute('class', kept.join(' '));
          else node.removeAttribute('class');
        } else if (safeGlobalAttrs.has(name) ||
                   (name.startsWith('data-export-') || name.startsWith('data-chatfolio-')) ||
                   (!inSvg && !inMath && safeHtmlAttrs.has(name)) ||
                   (inSvg && safeSvgAttrs.has(name)) ||
                   (inMath && safeMathAttrs.has(name))) {
          // Keep only explicitly enumerated inert formatting metadata.
        } else {
          node.removeAttribute(attr.name);
        }
      }
      if (tag === 'a' && !inSvg && !inMath) {
        if (node.hasAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        } else {
          node.removeAttribute('target');
          node.removeAttribute('rel');
        }
      }
    }
    return root;
  }

  return { sanitizePrintClone, safeLinkUrl, safeImageUrl, safeFragmentRef };
}
