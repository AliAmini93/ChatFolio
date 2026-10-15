"""Phase 6B1: 120-turn synthetic conversation -> real, searchable A4 PDF.

Stress the actual generated MV3 renderer in Chrome for missing/duplicated/out-of-
order authored turns, RTL/English code, tables, formulae and embedded images.
Synthetic fixture only: this is NOT a test of logged-in provider extraction.
"""
from __future__ import annotations

import base64
from collections import Counter
from io import BytesIO
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory

import fitz
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from qa_pdf_audit import audit_pdf  # local-only metadata metrics

RUNTIME = (ROOT / "content.js").read_text(encoding="utf-8")
assert "BEGIN GENERATED PDF document renderer" in RUNTIME
assert "BEGIN GENERATED print sanitizer" in RUNTIME

image = Image.new("RGB", (320, 180), "#447d9f")
draw = ImageDraw.Draw(image)
draw.rectangle((35, 30, 285, 155), outline="white", width=6)
buffer = BytesIO()
image.save(buffer, format="PNG")
png_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

messages = []
expected_markers = []
for index in range(1, 121):
    token = f"CF6B{index:04d}"
    expected_markers.append(token)
    role = "user" if index % 2 else "assistant"
    rtl = index % 3 != 0
    sentence = (
        "این متن ساختگی برای بررسی شماره و ترتیب پیام‌ها در گفتگوی طولانی است."
        if rtl else
        "Synthetic scientific discussion with searchable English text."
    )
    html = (
        f'<p dir="{"rtl" if rtl else "ltr"}">'
        f'<strong>{token}</strong> {sentence} '
        'This line confirms consistent turn ordering.</p>'
    )
    if index % 13 == 0:
        html += (
            f'<table><thead><tr><th>Parameter</th><th>{token}_col</th></tr></thead>'
            '<tbody><tr><td>Voltage</td><td>2.5</td></tr></tbody></table>'
        )
    if index % 17 == 0:
        html += (
            '<div class="katex"><span class="mord">x</span></div>'
            '<math display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>'
        )
    if index % 19 == 0:
        html += ('<pre><code class="language-python">'
                 'def compute(x): return x*x\n'
                 '</code></pre>')
    if index % 29 == 0:
        html += (f'<figure><img alt="SYNTHETIC_QA_IMAGE" src="{png_url}"'
                 ' width="320" height="180">'
                 '<figcaption>Embedded QA image</figcaption></figure>')
    messages.append({
        "role": role,
        "text": token + " " + sentence,
        "html": html,
        "imageCount": 1 if index % 29 == 0 else 0,
    })

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.set_content("<!doctype html><html><body></body></html>")
        page.evaluate("""() => {
          window.chrome = {runtime: {
            getManifest: () => ({version:"1.8.11"}),
            onMessage: {addListener: () => {}},
            sendMessage: async () => ({ok:false})
          }};
        }""")
        script = RUNTIME.replace(
            "const PLATFORM = detectPlatform();",
            'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',
            1,
        )
        script = script.rsplit("})();", 1)[0] + (
            "window.__phase6b = {buildPrintableDocument};})();"
        )
        page.add_script_tag(content=script)
        html = page.evaluate("""(messages) => window.__phase6b.buildPrintableDocument(
          messages, "Synthetic long research conversation",
          {layoutMode:"compact",includeExportTime:false,
           showMessageNumbers:true},
          messages.reduce((n,m) => n + m.imageCount,0),
          {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
        )""", messages)

        # Check the complete generated HTML before Chrome's pagination.
        assert html.count('class="exchange"') == 60, "Exchange grouping changed"
        for token in expected_markers:
            assert html.count(token + "</strong>") == 1, f"Missing/duplicate {token} in HTML"
        assert html.find(expected_markers[0]) < html.find(expected_markers[59]) < html.find(expected_markers[-1])
        assert '<html lang="fa" dir="rtl"' in html
        assert '<table' in html and '<math' in html and 'data:image/png' in html
        assert '<script' not in html.lower()

        with TemporaryDirectory(prefix="chatfolio-6b-synthetic-") as tmp:
            output = Path(tmp) / "synthetic_120_turns.pdf"
            page.set_content(html, wait_until="load", timeout=30000)
            page.pdf(
                path=str(output), format="A4", prefer_css_page_size=True,
                print_background=True, display_header_footer=True
            )
            summary = audit_pdf(output)
            assert 5 <= summary["pages"] <= 110, summary
            assert summary["a4_portrait_pages"] == summary["pages"], summary
            assert summary["pages_with_selectable_text"] == summary["pages"], summary
            assert summary["embedded_image_instances"] >= 1, summary

            with fitz.open(output) as doc:
                text = "\n".join(sheet.get_text(sort=True) for sheet in doc)
                page_text = [sheet.get_text(sort=True) for sheet in doc]
                # No blank bodies: the page-number footer alone must not
                # make a physically blank document page appear acceptable.
                assert all(len(body.strip()) >= 50 for body in page_text), [
                    (index + 1, len(body.strip()))
                    for index, body in enumerate(page_text)
                    if len(body.strip()) < 50
                ]
                for page_number, sheet in enumerate(doc, 1):
                    assert f"{page_number} / {len(doc)}" in sheet.get_text(), (
                        "Missing/incorrect page counter", page_number
                    )

            found = re.findall(r"\bCF6B\d{4}\b", text)
            counts = Counter(found)
            assert len(found) == 120, (
                "PDF omitted or duplicated turn markers", len(found),
                [x for x in expected_markers if counts[x] != 1][:10]
            )
            assert all(counts[token] == 1 for token in expected_markers)
            locations = [text.index(token) for token in expected_markers]
            assert locations == sorted(locations), "Page ordering changed in PDF text"
            assert "Voltage" in text and "2.5" in text
            assert "compute" in text
            assert "SYNTHETIC_QA_IMAGE" in html
            print(
                "PASS: 120 synthetic messages -> searchable A4 PDF;"
                f" {summary['pages']} pages; {len(found)} exact ordered markers;"
                f" {summary['embedded_image_instances']} embedded image instances"
            )
        page.close()
    finally:
        browser.close()
