"""Phase 5C1 browser regression: sanitizer strips active HTML while preserving math/media.

Uses synthetic local DOM only; no real conversations or external resources.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (ROOT / 'content.js').read_text(encoding='utf-8')
assert 'BEGIN GENERATED print sanitizer' in RUNTIME

sample_png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9f03sAAAAASUVORK5CYII='
fixture = """
<article id="turn" data-message-author-role="assistant">
  <p dir="rtl">سلام و جدول <a href="javascript:alert(1)" onclick="globalThis.attack=1">BAD_LINK</a>
    <a href="https://example.org/source" onclick="globalThis.attack=1">GOOD_LINK</a></p>
  <div style="background-image:url(https://evil.invalid/track.png);color:#112233" onmouseover="globalThis.attack=1">COLORED_TEXT</div>
  <div onclick="globalThis.attack=1" data-provider-sneak="bad" data-export-kind="safe">CLEAN_TEXT</div>
  <img id="badImage" src="javascript:alert(1)" srcset="https://evil.invalid/img 2x"
       onerror="globalThis.attack=1" alt="Unsafe" width="20" height="20">
  <img id="safeImage" src="PNG_SRC" alt="VALID_IMG" width="180" height="130">
  <svg viewBox="0 0 32 32" onload="globalThis.attack=1">
    <defs><path id="my-path" d="M0 0L10 10"/></defs>
    <use href="#my-path"></use>
    <use href="https://evil.invalid/external.svg#shape"></use>
    <foreignObject><div>FOREIGN_HTML</div></foreignObject>
    <path d="M1 1L2 2" onload="globalThis.attack=1"></path>
  </svg>
  <math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>
  <span class="katex"><span class="mord" style="height:1em;vertical-align:-0.2em">FORMULA_KATEX</span></span>
  <table><tbody><tr><th>Heading</th><th>مقدار</th></tr><tr><td>Voltage</td><td>2.5</td></tr></tbody></table>
  <unknown-provider-widget aria-label="uncertain"><strong>AUTHORED_TEXT</strong></unknown-provider-widget>
  <script>globalThis.attack=1</script>
  <style>@import url(https://evil.invalid/style.css)</style>
  <iframe src="https://evil.invalid/"></iframe>
</article>
""".replace("PNG_SRC", sample_png)

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,
        args=['--no-sandbox','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1100, 'height': 900})
    # Freeze externally-sourced network assets: an export should never need to
    # fetch malware/trackers just to test the output sanitizer.
    page.route('**/*', lambda route: route.abort())
    page.set_content('<!doctype html><html><body>' + fixture + '</body></html>')
    page.evaluate("""() => {
      window.chrome = { runtime: {
        onMessage: {addListener: () => {}},
        sendMessage: (_message, respond) => respond?.({ok:false}),
        getManifest: () => ({version:'1.8.11'})
      } };
    }""")
    injected = RUNTIME.replace('const PLATFORM = detectPlatform();',
        'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};', 1)
    injected = injected.rsplit('})();', 1)[0] + '''
      window.__phase5c1 = { serializeTurn, sanitizePrintClone };})();'''
    page.add_script_tag(content=injected)
    result = page.evaluate("""async () => {
      const turn = document.getElementById('turn');
      return await window.__phase5c1.serializeTurn(
        turn, turn, 'assistant', false, new AbortController().signal);
    }""")
    html = result['html']
    normalized = html.lower()
    assert 'سلام' in html and 'Voltage' in html and '2.5' in html, html
    assert 'GOOD_LINK' in html and 'href="https://example.org/source"' in html, html
    assert 'BAD_LINK' in html and 'href="javascript:' not in normalized, html
    assert 'src="javascript:' not in normalized and 'srcset=' not in normalized, html
    assert '<script' not in normalized and '<iframe' not in normalized, html
    assert '<foreignobject' not in normalized and 'FOREIGN_HTML' not in html, html
    assert 'onclick=' not in normalized and 'onload=' not in normalized and 'onerror=' not in normalized, html
    assert 'data-provider-sneak' not in normalized, html
    assert 'background-image:' not in normalized and 'evil.invalid' not in normalized, html
    assert 'VALID_IMG' in html and 'data:image/png' in html, html
    assert '<svg' in normalized and 'viewbox=' in normalized and '<path' in normalized, html
    assert 'href="#my-path"' in html and 'external.svg' not in html, html
    assert '<math' in normalized and '<mfrac' in normalized and '<mn>2</mn>' in normalized, html
    assert 'FORMULA_KATEX' in html and 'mord' in html and 'height:' in html, html
    assert '<table' in normalized and 'Heading' in html and 'مقدار' in html, html
    assert 'AUTHORED_TEXT' in html and '<unknown-provider-widget' not in normalized, html
    assert result['imageCount'] >= 1, result

    # Load only sanitized result into a fresh isolated print document. The
    # original provider page's scripts are intentionally not trusted.
    printable = browser.new_page()
    printable.route('**/*', lambda route: route.abort())
    printable.set_content('<!doctype html><html><body>' + html + '</body></html>')
    assert printable.evaluate("typeof window.attack") == 'undefined'
    printable.close()
    page.close()
    browser.close()

print('PASS: sanitized print HTML blocks active content and retains RTL/table/KaTeX/MathML/SVG/image')
