"""Phase 8B: production bundled ChatGPT API + rendered DOM hybrid fidelity.

Real Chromium renders a grouped 2026 ChatGPT DOM. Metadata remains the source
of message count and ordering; rich PDF content is obtained from the safely
matched visible DOM. No private conversations or web connections.
"""
from __future__ import annotations

import base64
from io import BytesIO
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import fitz
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "content.js").read_text(encoding="utf-8")
assert "matchedChatGPTLiveAssistantTurns" in SOURCE
assert "enhanceChatGPTMetadataWithRenderedDom" in SOURCE
SOURCE = SOURCE.replace(
    "const PLATFORM = detectPlatform();",
    'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',
    1,
)
SOURCE = SOURCE.rsplit("})();", 1)[0] + (
    "window.__phase8b={getMessageNodes,matchedChatGPTLiveAssistantTurns,"
    "enhanceChatGPTMetadataWithRenderedDom,buildPrintableDocument};})();"
)

picture = Image.new("RGB", (320, 120), "#4b8c9c")
buffer = BytesIO()
picture.save(buffer, "PNG")
image_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def api_turn(role: str, text: str, index: int, *, image_count: int = 0):
    return {
        "key": "chatgpt:api:turn" + str(index),
        "role": role, "text": text,
        "html": "<p>" + text.replace("<", "&lt;").replace(">", "&gt;") + "</p>",
        "imageCount": image_count, "turnIndex": index,
    }


def browser() -> object:
    raise RuntimeError("not used")


with sync_playwright() as playwright:
    chrome = playwright.chromium.launch(
        headless=True, executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = chrome.new_page(viewport={"width": 1200, "height": 840})
        page.set_content("<main></main>")
        page.evaluate("""() => {window.chrome = {runtime: {
          getManifest: () => ({version:"1.8.11"}),
          onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})}}}""")
        page.add_script_tag(content=SOURCE)

        prompt1 = "سؤال اول درباره خروجی فارسی و نمایش درست جدول است."
        prompt2 = "سؤال دوم درباره تصاویر در خروجی PDF و لینک منابع علمی است."
        raw_dil = (
            'نتایج: <grid columns={2}><grid-item><table><tr><td>'
            'CF_RAW_WIDGET_NOT_IN_PDF</td></tr></table></grid-item></grid>'
        )
        rendered = (
            '<div data-turn-key="stable-1"><div data-user-message-bubble>'
            + prompt1 +
            '</div><div data-conversation-role="assistant">ChatGPT said:</div>'
            '<div class="response"><h3>نتایج آزمایش</h3><table><thead>'
            '<tr><th>معیار</th><th>نتیجه</th></tr></thead><tbody>'
            '<tr><td>Unit tests</td><td>83</td></tr></tbody></table>'
            '<a href="https://example.org/research">منبع پژوهش</a></div></div>'
            '<div data-turn-key="stable-2"><div data-user-message-bubble>'
            + prompt2 +
            '</div><div data-conversation-role="assistant">ChatGPT said:</div>'
            '<div><p>تصویر نمونه برای تأیید Export</p>'
            '<img alt="Image export fixture" width="320" height="120" src="'
            + image_url + '"></div></div>'
        )
        page.locator("main").evaluate("(node, markup) => node.innerHTML = markup", rendered)
        api = [
            api_turn("user", prompt1, 0),
            api_turn("assistant", raw_dil, 1),
            api_turn("user", prompt2, 2),
            api_turn("assistant", "تصویر نمونه برای تأیید Export", 3),
        ]
        data = page.evaluate("""async (messages) => {
          const session={controller:new AbortController(),cancelled:false};
          const result=await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:true},session
          );
          return {
            messages:result.messages,
            imageCount:result.imageCount,
            nodes:window.__phase8b.getMessageNodes().length,
            html:window.__phase8b.buildPrintableDocument(
              result.messages,"Phase 8B Synthetic RTL UI",
              {layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},
              result.imageCount, {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
            )
          };
        }""", api)
        assert data["nodes"] == 4, data["nodes"]
        assert len(data["messages"]) == 4
        assert [x["role"] for x in data["messages"]] == ["user", "assistant", "user", "assistant"]
        assert [x["key"] for x in data["messages"]] == [x["key"] for x in api]
        assert data["messages"][1]["html"].find("<table") >= 0
        assert 'href="https://example.org/research"' in data["messages"][1]["html"]
        assert "CF_RAW_WIDGET_NOT_IN_PDF" not in data["messages"][1]["html"]
        assert '<img' in data["messages"][3]["html"]
        assert data["imageCount"] >= 1
        assert "CF_RAW_WIDGET_NOT_IN_PDF" not in data["html"]

        with TemporaryDirectory(prefix="chatfolio-phase8b-") as temporary:
            output = Path(temporary) / "synthetic-rich-chat.pdf"
            page.set_content(data["html"])
            page.pdf(
                path=str(output), format="A4",
                prefer_css_page_size=True, print_background=True,
            )
            with fitz.open(output) as pdf:
                all_text = "\n".join(p.get_text() for p in pdf)
                assert "Unit tests" in all_text and "83" in all_text
                assert "CF_RAW_WIDGET_NOT_IN_PDF" not in all_text
                assert "نتایج" in all_text
                assert sum(len(p.get_images(full=True)) for p in pdf) >= 1
                assert any(link.get("uri") == "https://example.org/research"
                           for p in pdf for link in p.get_links())

        # Virtualized history: only the last exchange is mounted. Use unique
        # user text + same-group assistant sibling; preserve all API messages.
        page.set_content("<main>" + rendered[rendered.index('<div data-turn-key="stable-2">'):] + "</main>")
        virtual = page.evaluate("""async (messages) => {
          const result=await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          );
          return result.messages;
        }""", api)
        assert len(virtual) == 4
        assert virtual[1]["html"] == api[1]["html"], "Unseen earlier turn must remain API-sourced"
        assert "Image export fixture" in virtual[3]["html"]
        assert virtual[0]["html"] == api[0]["html"]

        # Duplicate source user text: partial history matching is ambiguous.
        ambiguous = [dict(message) for message in api]
        ambiguous[0]["text"] = prompt2
        untouched = page.evaluate("""async (messages) => (
          await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages""", ambiguous)
        assert untouched[3]["html"] == ambiguous[3]["html"]

        # A DOM from another conversation must never be treated as the same
        # full sequence merely because its roles and count match.
        page.set_content("<main>" + rendered.replace(prompt1, "WRONG BRANCH").replace(prompt2, "OTHER BRANCH") + "</main>")
        wrong = page.evaluate("""async (messages) => (
          await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages""", api)
        assert wrong[1]["html"] == api[1]["html"]

        # Media from the API must never be discarded by a rich DOM overlay.
        media = [dict(message) for message in api]
        media[1]["imageCount"] = 2
        page.set_content("<main>" + rendered + "</main>")
        held = page.evaluate("""async (messages) => (
          await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:2},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages""", media)
        assert held[1]["html"] == media[1]["html"]

        # Regression from the user's 49-page real PDF: one finalized rich
        # answer was captured as rendered HTML AND a subsequent split assistant
        # API message repeated the same DIL source as literal markup.
        # Exclude only independently corroborated duplicate fragments.
        prompt = "سؤال منحصر به فرد برای خروجی جدول پیشرفته و نمودار فارسی"
        prose = [
            "این یک توضیح کامل و مستقل درباره خروجی جدید است و باید همراه با جدول اصلی داخل فایل قابل جستجو باقی بماند.",
            "ما همچنین تعداد پیام‌ها و ترتیب آن‌ها را با اطلاعات اصلی می‌سنجیم و بررسی می‌کنیم که هیچ متنی بی‌دلیل حذف نشود.",
            "در پایان تصویر و لینک علمی را با خروجی مرورگر مقایسه می‌کنیم تا تفاوت مهمی میان فایل چاپی و صفحه وجود نداشته باشد.",
        ]
        live = (
            '<main><div data-turn-key="phase8b-split">'
            '<div data-user-message-bubble>' + prompt + '</div>'
            '<div data-conversation-role="assistant">ChatGPT said:</div>'
            '<div class="response"><h3>نتایج نهایی</h3>'
            + ''.join('<p>' + part + '</p>' for part in prose)
            + '<table><tr><th>مورد</th><th>نتیجه</th></tr>'
              '<tr><td>Rich UI</td><td>PASS</td></tr></table></div></div></main>'
        )
        page.set_content(live)
        final_source = (
            "## نتایج نهایی\n" + "\n".join(prose) +
            "\n<grid columns={3}>\n<grid-item>\n<box>خام و تکراری</box>\n</grid-item>\n</grid>"
        )
        split = [
            api_turn("user", prompt, 0),
            api_turn("assistant", "جواب اولیه در حال پردازش", 1),
            api_turn("assistant", "گزارش پیشرفت: هنوز در حال آزمایش مرورگر هستیم", 2),
            api_turn("assistant", final_source, 3),
        ]
        resolved = page.evaluate("""async (messages) => (
          await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages""", split)
        assert len(resolved) == 3, resolved
        assert [item["key"] for item in resolved] == [x["key"] for x in split[:3]]
        assert "<table" in resolved[1]["html"]
        assert resolved[2]["text"] == split[2]["text"], "Distinct progress must not be discarded"
        assert not any("<grid" in item["html"] for item in resolved)

        # Different authored rich content, even if it looks like a DIL
        # component, is NOT a duplicate and must not be discarded.
        other = [dict(message) for message in split]
        other[-1]["text"] = (
            "<grid columns={2}>\n"
            "این محتوای کاملاً مستقل هرگز نباید حذف شود و هیچ یک از جملات قبلی را تکرار نمی‌کند.\n"
            "این بخش متفاوت است و همچنان باید در خروجی به عنوان یک پیام مستقل باقی بماند.\n"
            "</grid>"
        )
        distinct = page.evaluate("""async (messages) => (
          await window.__phase8b.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages""", other)
        assert len(distinct) == 4
    finally:
        chrome.close()

print("PASS: ChatGPT API order + real rendered table, links, embedded PNG, virtualized/ambiguous and verified duplicate guards")
