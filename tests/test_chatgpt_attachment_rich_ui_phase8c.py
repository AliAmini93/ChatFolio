"""Phase 8C: ChatGPT attachment-heavy, multi-part Rich UI matching.

A synthetic 2026 grouped DOM and API metadata snapshot reproduces a real
failure in the user's 51-page export: file cards make the user bubble's
visible text different from the metadata string, leaving the final Rich UI
response as raw <grid> / <box> markup.

No real user files, filenames, screenshots or conversations are committed.
"""
from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory

import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "content.js").read_text(encoding="utf-8")
SOURCE = SOURCE.replace(
    "const PLATFORM = detectPlatform();",
    'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',
    1,
)
SOURCE = SOURCE.rsplit("})();", 1)[0] + (
    "window.__phase8c={getMessageNodes,matchedChatGPTLiveAssistantTurns,"
    "enhanceChatGPTMetadataWithRenderedDom,buildPrintableDocument};})();"
)


def api_turn(role: str, text: str, index: int, *, html: str = "") -> dict:
    return {
        "key": f"chatgpt:attachment-fixture:{index}",
        "role": role, "text": text,
        "html": html or "<p>" + text.replace("<", "&lt;").replace(">", "&gt;") + "</p>",
        "imageCount": 0, "turnIndex": index,
    }


filename1 = "fixture_notes(20261018-155501).txt"
filename2 = "fixture_chatfolio(42).pdf"
file_list = filename1 + "\n" + filename2
prose = [
    "این پاسخ شامل توضیحات طولانی و مستقل است که در نسخه نهایی باید به صورت یک جدول واقعی و قابل انتخاب چاپ شود.",
    "برای محافظت از تمام پیام‌های گفتگو، تطبیق پاسخ به متن‌های مشخص و طولانی داخل همین پاسخ واقعی وابسته است.",
    "هر پیام پیشرفت باید در جای اصلی خود حفظ شود و تنها پاسخ نهایی واجد شرایط دریافت خروجی رندرشده باشد.",
]
final_raw = (
    "## نتیجه خروجی جدید\n" + "\n".join(prose) +
    '\n<grid columns={2}><grid-item><box>RAW_ATTACHMENT_DIL</box></grid-item></grid>'
)

dom = (
    '<main><div data-turn-key="fixture-only-attachments">'
    '<div data-user-message-bubble>'
    '<div class="file-card"><span>Document</span><span>' + filename1 + '</span></div>'
    '<div class="file-card"><span>PDF</span><span>' + filename2 + '</span></div>'
    '</div><div data-conversation-role="assistant">ChatGPT said:</div>'
    '<div class="response"><h2>نتیجه خروجی جدید</h2>' +
    ''.join("<p>" + line + "</p>" for line in prose) +
    '<table><thead><tr><th>معیار</th><th>نتیجه</th></tr></thead>'
    '<tbody><tr><td>Rich UI</td><td>PASS</td></tr></tbody></table>'
    '<a href="https://example.org/fixture">پیوند نمونه</a>'
    '</div></div></main>'
)
api = [
    api_turn("user", file_list, 0, html="<div>Files: " + file_list + "</div>"),
    api_turn("assistant", "در حال آماده‌سازی خروجی اولیه", 1),
    api_turn("assistant", "گزارش پیشرفت، تبدیل قالب‌بندی هنوز ادامه دارد.", 2),
    api_turn("assistant", final_raw, 3),
]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = browser.new_page()
        page.set_content("<main></main>")
        page.evaluate("""() => {window.chrome = {runtime: {
          getManifest: () => ({version:"1.8.11"}),
          onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})}}}""")
        page.add_script_tag(content=SOURCE)
        page.set_content(dom)
        result = page.evaluate("""async messages => {
          const collected = await window.__phase8c.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          );
          return {
            nodes:window.__phase8c.getMessageNodes().length,
            messages:collected.messages,
            printable:window.__phase8c.buildPrintableDocument(
              collected.messages,"Attachment fixture",
              {layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},
              0,{id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
            )
          };
        }""", api)
        assert result["nodes"] == 2
        assert len(result["messages"]) == 4
        assert [x["key"] for x in result["messages"]] == [x["key"] for x in api]
        assert result["messages"][0]["html"] == api[0]["html"]
        assert result["messages"][1]["html"] == api[1]["html"]
        assert result["messages"][2]["html"] == api[2]["html"]
        assert "<table" in result["messages"][3]["html"]
        assert "RAW_ATTACHMENT_DIL" not in result["messages"][3]["html"]
        assert filename1 in result["printable"] and filename2 in result["printable"]

        with TemporaryDirectory(prefix="chatfolio-phase8c-") as tmpdir:
            output = Path(tmpdir) / "synthetic-attachment-rich-ui.pdf"
            page.set_content(result["printable"])
            page.pdf(path=str(output), format="A4", print_background=True)
            with fitz.open(output) as pdf:
                all_text = "\n".join(p.get_text() for p in pdf)
                assert "Rich UI" in all_text and "PASS" in all_text
                assert "RAW_ATTACHMENT_DIL" not in all_text
                assert filename1 in all_text and filename2 in all_text
                assert any(l.get("uri") == "https://example.org/fixture"
                           for p in pdf for l in p.get_links())

        async_call = """async messages => (
          await window.__phase8c.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:false},{controller:new AbortController(),cancelled:false}
          )
        ).messages"""

        # A different file signature must not align the assistant by position.
        page.set_content(dom)
        wrong = [dict(x) for x in api]
        wrong[0] = api_turn("user", filename1 + "\nfixture_other(43).pdf", 0)
        untouched = page.evaluate(async_call, wrong)
        assert untouched[3]["html"] == wrong[3]["html"]

        # A single generic repeated file is insufficient evidence.
        page.set_content(dom.replace(filename2, "file-description-without-extension"))
        only_one_file = page.evaluate(async_call, api)
        assert only_one_file[3]["html"] == api[3]["html"]

        # Repeated same file pair on the API branch is ambiguous.
        page.set_content(dom)
        duplicate = api + [api_turn("user", file_list, 4),
                           api_turn("assistant", final_raw, 5)]
        repeated = page.evaluate(async_call, duplicate)
        assert repeated[3]["html"] == api[3]["html"]
        assert repeated[5]["html"] == duplicate[5]["html"]

        # No overlap with assistant prose: filenames alone never authorize
        # overwriting an unrelated final response.
        unrelated = [dict(x) for x in api]
        unrelated[3] = api_turn(
            "assistant",
            "این متن مستقل هیچ‌کدام از جمله‌های بلند پاسخ رندرشده را ندارد. "
            "یک محتوای کاملاً متفاوت است که نباید با خروجی دیگر جایگزین شود.\n"
            "مقایسه این بخش فقط برای جلوگیری از تطبیق ناامن و اشتباه طراحی شده است.",
            3,
        )
        unrelated_result = page.evaluate(async_call, unrelated)
        assert unrelated_result[3]["html"] == unrelated[3]["html"]

        # An incomplete/virtualized render without matching file cards
        # must preserve API source, not substitute guessed Rich UI.
        page.set_content("<main><div data-turn-key='other'><div data-user-message-bubble>"
                         "Some unrelated prompt</div><div data-conversation-role='assistant'>"
                         "ChatGPT said:</div><div>Some unrelated response</div></div></main>")
        not_mounted = page.evaluate(async_call, api)
        assert not_mounted[3]["html"] == api[3]["html"]
    finally:
        browser.close()

print("PASS: attachment-rich UI, split assistant, PDF table/link and ambiguity guards")
