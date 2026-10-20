"""Phase 8C2: unique authored assistant prose restores Rich UI after pasted logs.

Synthetic grouped ChatGPT DOM, real extension bundle and a real Chromium PDF.
Never stores personal messages or uses network access.
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
    "window.__phase8c2={getMessageNodes,matchedChatGPTLiveAssistantTurns,"
    "enhanceChatGPTMetadataWithRenderedDom,buildPrintableDocument};})();"
)


def msg(role: str, text: str, n: int) -> dict:
    return {
        "key": f"chatgpt:prose-identity:{n}",
        "role": role,
        "text": text,
        "html": "<p>" + text.replace("<", "&lt;").replace(">", "&gt;") + "</p>",
        "imageCount": 0,
        "turnIndex": n,
    }


prose = [
    "این گزارش طولانی درباره وضعیت واقعی افزونه و کیفیت استخراج گفت‌وگو است و باید در سند نهایی به شکل صحیح و قابل جستجو باقی بماند.",
    "وقتی یک متن بزرگ از خروجی ترمینال ارسال می‌شود، ترتیب پیام‌های قبلی باید کاملاً حفظ شود و تنها پاسخ مرتبط با آن بازسازی گردد.",
    "اگر دو پاسخ مختلف از نظر جمله‌های بلند و محتوای اصلی یکسان باشند، هیچ‌کدام نباید با یک بخش اشتباه از صفحه جایگزین شوند.",
    "وجود یک جدول واقعی و یک لینک آزمایشی در خروجی نهایی نشان می‌دهد که به جای تگ‌های خام از صفحه رندرشده استفاده شده است.",
]
long_input = "Terminal output pasted from a non-sensitive synthetic build:\n" + \
             "\n".join(f"command-{i}: completed check-{i}" for i in range(85))
raw_rich = "## گزارش نهایی\n" + "\n".join(prose) + \
           "\n<grid columns={2}><grid-item><box>RAW_PROSE_IDENTITY_DIL</box></grid-item></grid>"
api = [
    msg("user", long_input, 0),
    msg("assistant", "در حال بررسی فایل و آماده‌سازی نتیجه", 1),
    msg("assistant", "گزارش پیشرفت: آخرین مراحل هنوز اجرا نشده است", 2),
    msg("assistant", raw_rich, 3),
]


def group(key: str, user_html: str, assistant_html: str) -> str:
    return (
        f'<div data-turn-key="{key}"><div data-user-message-bubble>{user_html}</div>'
        '<div data-conversation-role="assistant">ChatGPT said:</div>'
        f'<div class="response">{assistant_html}</div></div>'
    )


rendered_assistant = (
    '<h2>گزارش نهایی</h2>' +
    "".join(f"<p>{line}</p>" for line in prose) +
    '<table><tr><th>Check</th><th>Result</th></tr>'
    '<tr><td>Rich UI</td><td>PASS</td></tr></table>'
    '<a href="https://example.org/verified">Test reference</a>'
)
rendered_user = "<pre>Short visible snippet from a large terminal attachment</pre>"
markup = "<main>" + group("log-unique", rendered_user, rendered_assistant) + "</main>"
call = """async messages => (
    await window.__phase8c2.enhanceChatGPTMetadataWithRenderedDom(
      {extractionSource:"metadata",messages,imageCount:0},
      {embedImages:false},{controller:new AbortController(),cancelled:false}
    )
).messages"""

with sync_playwright() as playwright:
    chrome = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = chrome.new_page()
        summary_logs = []
        page.on("console", lambda message: summary_logs.append(message.text)
                if "ChatFolio Rich UI QA (counts only):" in message.text else None)
        page.set_content("<main></main>")
        page.evaluate("""() => {window.chrome = {runtime: {
          getManifest: () => ({version:"1.8.11"}),
          onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})}}}""")
        page.add_script_tag(content=SOURCE)

        # The user bubble and metadata text are intentionally not comparable,
        # but the final assistant has four unique substantial prose anchors.
        page.set_content(markup)
        pairs = page.evaluate(
            """messages => [...window.__phase8c2.matchedChatGPTLiveAssistantTurns(
                  messages,window.__phase8c2.getMessageNodes()
            ).keys()]""", api)
        assert pairs == [3], pairs
        enhanced = page.evaluate(call, api)
        assert summary_logs and '"apiTurns":4' in summary_logs[-1], summary_logs
        assert '"enrichedRawRich":1' in summary_logs[-1], summary_logs[-1]
        assert '"scanObservedAssistantGroups":1' in summary_logs[-1], summary_logs[-1]
        assert '"scanMatchedAssistantGroups":1' in summary_logs[-1], summary_logs[-1]
        assert '"scanUnmatchedAssistantGroups":0' in summary_logs[-1], summary_logs[-1]
        assert not any(prose[0] in line or long_input in line for line in summary_logs)
        assert len(enhanced) == len(api)
        assert [x["key"] for x in enhanced] == [x["key"] for x in api]
        assert [x["html"] for x in enhanced[:3]] == [x["html"] for x in api[:3]]
        assert "<table" in enhanced[3]["html"], enhanced[3]["html"][:350]
        assert "RAW_PROSE_IDENTITY_DIL" not in enhanced[3]["html"]
        printable = page.evaluate(
            """messages => window.__phase8c2.buildPrintableDocument(
              messages,"Synthetic pasted terminal QA",
              {layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},
              0,{id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
            )""", enhanced)
        assert "<table" in printable and "RAW_PROSE_IDENTITY_DIL" not in printable
        with TemporaryDirectory(prefix="chatfolio-phase8c2-") as tmp:
            page.set_content(printable)
            path = Path(tmp) / "rich-from-pasted-terminal.pdf"
            page.pdf(path=str(path), format="A4", print_background=True)
            with fitz.open(path) as pdf:
                full_text = "\n".join(p.get_text() for p in pdf)
                assert "Rich UI" in full_text and "PASS" in full_text
                assert "RAW_PROSE_IDENTITY_DIL" not in full_text
                assert any(link.get("uri") == "https://example.org/verified"
                           for p in pdf for link in p.get_links())

        # Two API assistant segments repeating identical prose are ambiguous.
        page.set_content(markup)
        repeated_api = [dict(x) for x in api] + [msg("assistant", raw_rich, 4)]
        assert page.evaluate(call, repeated_api)[3]["html"] == api[3]["html"]

        # Two DOM groups with the same response are also ambiguous.
        page.set_content("<main>" + group("first", rendered_user, rendered_assistant)
                         + group("second", "Another user surface", rendered_assistant)
                         + "</main>")
        assert page.evaluate(call, api)[3]["html"] == api[3]["html"]

        # Three long assistant prose lines in the user bubble must NOT count
        # as the author's answer if the assistant itself says something else.
        page.set_content("<main>" + group(
            "echoed-by-user", "<p>" + "</p><p>".join(prose) + "</p>",
            "<p>Unrelated assistant answer, not the submitted report.</p>"
        ) + "</main>")
        assert page.evaluate(call, api)[3]["html"] == api[3]["html"]

        # A different source response with generic "PASS" or short headings
        # cannot match the rich DOM without the actual prose anchors.
        page.set_content(markup)
        unrelated = [dict(x) for x in api]
        unrelated[3] = msg("assistant", "## گزارش نهایی\nPASS\n<grid>Other data</grid>", 3)
        assert page.evaluate(call, unrelated)[3]["html"] == unrelated[3]["html"]

        # Missing rendered answer fails closed.
        page.set_content("<main>" + group("empty", rendered_user, "") + "</main>")
        assert page.evaluate(call, api)[3]["html"] == api[3]["html"]
    finally:
        chrome.close()

print("PASS: split pasted-log Rich UI, unique prose, duplicate guards, user-echo rejection and real PDF")
