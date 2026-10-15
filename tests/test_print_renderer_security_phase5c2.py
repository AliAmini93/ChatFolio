"""Phase 5C2: final PDF renderer rejects unsanitized messages and raw CSS."""
import os
from pathlib import Path
import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (ROOT / "content.js").read_text(encoding="utf-8")

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    page = browser.new_page()
    page.set_content("<!doctype html><html><body>fixture</body></html>")
    page.evaluate("""() => {
      window.chrome = { runtime: {
        getManifest: () => ({version:"1.8.11"}),
        onMessage: {addListener: () => {}},
        sendMessage: async () => ({ok:false})
      }};
    }""")
    code = RUNTIME.replace(
        "const PLATFORM = detectPlatform();",
        'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',
        1,
    ).rsplit("})();", 1)[0] + (
        "window.__testPhase5C2 = {buildPrintableDocument, sanitizePrintClone};})();"
    )
    page.add_script_tag(content=code)
    print_html = page.evaluate("""() => {
      const raw = [
        {role:"user",text:"سلام. Please inspect my research table.",
         html:'<p dir="rtl">سلام <strong>research</strong> ' +
              '<a href="javascript:alert(2)" onclick="window.PWNED=1">bad link</a></p>' +
              '<style></style><script>window.PWNED=1</script>' +
              '<svg onload="window.PWNED=1"><foreignObject><body>danger</body></foreignObject></svg>' +
              '<img src="data:text/html;base64,PGgxPg==" onerror="window.PWNED=1">' +
              '<div style="background-image:url(https://unsafe.invalid/tracker.png)">AUTHORED_TEXT</div>',
         imageCount:0},
        {role:"assistant",text:"Table and equation in Persian.",
         html:'<table><tr><th>Parameter</th><th>Value</th></tr>' +
              '<tr><td>Voltage</td><td>2.5</td></tr></table>' +
              '<math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>' +
              '<span class="katex"><span class="mord" style="height:1em">KATEX</span></span>' +
              '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9f03sAAAAASUVORK5CYII=" alt="safe">' +
              '<a href="https://example.org/paper">paper</a>',
         imageCount:1}
      ];
      const font = {
        base:{fontFamily:'Arial; background: url(https://unsafe.invalid/style.css)'},
        rtl:{fontFamily:'"Noto Sans Arabic", Tahoma, sans-serif'},
        ltr:{fontFamily:'Inter, Arial, sans-serif'},
        fontFaceCss:'</style><script>window.FONT_PWNED=1</script><style>@import url(https://unsafe.invalid/font.css)'
      };
      return window.__testPhase5C2.buildPrintableDocument(
        raw, "پژوهش درباره فرمول", {layoutMode:"comfortable",
        showMessageNumbers:true,includeExportTime:false},
        1,{id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"},font);
    }""")
    lowered = print_html.lower()
    assert print_html.count("<style>") == 1, "Untrusted stylesheet broke out of style element"
    assert "<script" not in lowered
    assert "javascript:" not in lowered
    assert "onclick=" not in lowered and "onerror=" not in lowered
    assert "foreignobject" not in lowered
    assert "data:text/html" not in lowered
    assert "unsafe.invalid" not in lowered
    assert "window.pwned" not in lowered and "window.font_pwned" not in lowered
    assert "@import" not in lowered
    assert "Voltage" in print_html and "2.5" in print_html
    assert "AUTHORED_TEXT" in print_html and "سلام" in print_html
    assert "<math" in lowered and "mfrac" in lowered and "KATEX" in print_html
    assert "data:image/png" in lowered
    assert 'href="https://example.org/paper"' in print_html
    assert "Noto Sans Arabic" in print_html
    assert "background: url(" not in print_html
    assert "@page" in print_html

    final = browser.new_page()
    final.route("**/*", lambda route: route.abort())
    final.set_content(print_html, wait_until="load")
    assert final.evaluate("typeof window.PWNED") == "undefined"
    assert final.evaluate("typeof window.FONT_PWNED") == "undefined"
    pdf_bytes = final.pdf(format="A4", print_background=True, prefer_css_page_size=True)
    pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    extracted = "".join(page.get_text() for page in pdf)
    assert "Voltage" in extracted and "2.5" in extracted, extracted[:700]
    assert len(pdf) >= 1
    pdf.close()
    final.close()
    page.close()
    browser.close()

print("PASS: renderer rejects raw HTML/CSS and preserves safe math, table, Persian text and PDF")
