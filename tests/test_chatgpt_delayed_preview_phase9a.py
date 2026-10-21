"""v1.9.1: a delayed screenshot must upgrade a proven assistant snapshot.

Synthetic fixed image and fake conversation only. A virtualized DOM starts
with an animated loader and replaces it with a real PNG after its first
serialized snapshot. A subsequent window of the same identity must upgrade
the output without losing the earlier authored table or changing API order.
"""
from __future__ import annotations

import base64
import json
import os
import struct
import zlib
from pathlib import Path
from tempfile import TemporaryDirectory

import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "content.js").read_text(encoding="utf8")
SOURCE = SOURCE.replace(
    "const PLATFORM = detectPlatform();",
    'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};', 1
)
SOURCE = SOURCE.rsplit("})();", 1)[0] + (
    "window.__delayedPreview={enhanceChatGPTMetadataWithRenderedDom,"
    "buildPrintableDocument,getMessageNodes};})();"
)


def png_data_url() -> str:
    width = height = 48
    row = b"\\x00" + bytes((30, 120, 180, 255)) * width
    def chunk(name: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + name + payload +
                struct.pack(">I", zlib.crc32(name + payload) & 0xffffffff))
    image = (b"\\x89PNG\\r\\n\\x1a\\n" +
             chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) +
             chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(image).decode("ascii")


GROUPS = 7
messages = []
groups = []
for index in range(GROUPS):
    question = f"Synthetic unique question {index:02d} about delayed visual image fidelity."
    text = (
        f"This complete assistant answer {index:02d} describes the importance "
        "of preserving a fully rendered ChatGPT response and its original "
        "scientific image as well as working table and citation links. "
        "The response contains enough original prose for conservative matching."
    )
    messages += [
        {"key": f"q{index}", "role": "user", "text": question,
         "html": "<p>" + question + "</p>", "imageCount": 0},
        {"key": f"a{index}", "role": "assistant",
         "text": text + "<grid><box>RAW_DELAYED_MARKUP</box></grid>",
         "html": "<p>" + text + "</p><p>&lt;grid&gt;RAW_DELAYED_MARKUP&lt;/grid&gt;</p>",
         "imageCount": 0}
    ]
    spinner = (
        '<span class="pending-preview animate-spin" role="progressbar" '
        'aria-label="Loading image" style="display:block;width:105px;height:60px">'
        '</span>'
        if index == 0 else ""
    )
    body = (
        f"<p>{text}</p>" +
        f"<table><tr><td>Verified table {index:02d}</td></tr></table>" +
        f'<a href="https://example.org/reference/{index}">Reference {index}</a>' + spinner
    )
    groups.append(
        f'<div data-turn-key="group-{index}" '
        f'style="position:absolute;top:{index * 560}px;left:0;right:0;min-height:340px">'
        f'<div data-user-message-bubble>{question}</div>'
        '<div data-conversation-role="assistant">ChatGPT said:</div>'
        f'<div class="response">{body}</div></div>'
    )

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"]
    )
    try:
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        page.set_content("<main></main>")
        page.evaluate("""() => {
          window.chrome = {runtime:{
            getManifest:()=>({version:"1.9.0"}),
            onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})
          }}
        }""")
        page.add_script_tag(content=SOURCE)
        page.set_content(
            '<main><div id="scrollport" data-scroll-container '
            'style="height:440px;width:850px;overflow-y:auto;position:relative">'
            '<div id="virtual-track" style="height:4000px;position:relative"></div>'
            '</div></main>'
        )
        page.evaluate("""groups => {
          const scrollport = document.getElementById("scrollport");
          const track = document.getElementById("virtual-track");
          let last = -1;
          const render = () => {
            const first = Math.max(0, Math.min(groups.length - 2,
              Math.floor(scrollport.scrollTop / 560)));
            if (last === first) return;
            last = first;
            track.innerHTML = groups.slice(first, first + 2).join("");
          };
          scrollport.addEventListener("scroll", render);
          render();
        }""", groups)
        page.evaluate("""imageURL => {
          window.__previewHydrationArmed = false;
          window.__previewHydrationCompleted = false;
          const native = Element.prototype.cloneNode;
          Element.prototype.cloneNode = function(deep) {
            if (!window.__previewHydrationArmed &&
                this.querySelector?.(".pending-preview") &&
                this.closest?.('[data-turn-key="group-0"]')) {
              window.__previewHydrationArmed = true;
              setTimeout(() => {
                const live = document.querySelector(
                    '[data-turn-key="group-0"] .pending-preview');
                if (!live) return;
                const image = document.createElement("img");
                image.alt = "Synthetic delayed response preview";
                image.width = 105;
                image.height = 60;
                image.style.width = "105px";
                image.style.height = "60px";
                image.src = imageURL;
                live.replaceWith(image);
                window.__previewHydrationCompleted = true;
              }, 90);
            }
            return native.call(this, deep);
          };
        }""", png_data_url())
        reports = []
        page.on("console", lambda msg: reports.append(msg.text)
                if "ChatFolio Rich UI QA (counts only):" in msg.text else None)
        extracted = page.evaluate("""async messages => {
          const session = {controller:new AbortController(),cancelled:false};
          const result = await window.__delayedPreview.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:true}, session
          );
          return {messages:result.messages,
            html:window.__delayedPreview.buildPrintableDocument(
              result.messages,"Synthetic delayed images",
              {layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},
              result.imageCount,{id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
            )
          };
        }""", messages)
        assert page.evaluate("window.__previewHydrationArmed"), "Initial loader snapshot never taken"
        assert page.evaluate("window.__previewHydrationCompleted"), "Preview never finished loading"
        assert len(extracted["messages"]) == 2 * GROUPS
        assert [item["key"] for item in extracted["messages"]] == [
            item["key"] for item in messages
        ]
        html = extracted["messages"][1]["html"]
        assert "data:image/png;base64," in html, "Hydrated preview missing from upgraded capture"
        assert "Verified table 00" in html, "Rich table was lost on image upgrade"
        assert "RAW_DELAYED_MARKUP" not in html, "API markup replaced actual rendered HTML"
        assert reports, "Counts-only QA missing"
        counts = json.loads(reports[-1].split(
            "ChatFolio Rich UI QA (counts only):", 1)[1].strip())
        assert counts["scanDistinctGroups"] == GROUPS, counts
        assert counts["scanImagePendingSnapshots"] >= 1, counts
        assert counts["scanImageRecaptures"] >= 1, counts
        assert counts["scanStopReason"] == "at-scroll-limit", counts
        assert counts["scanRestored"] is True, counts
        assert "Synthetic unique question" not in reports[-1]

        with TemporaryDirectory(prefix="chatfolio-delayed-preview-") as folder:
            pdf_path = Path(folder) / "output.pdf"
            page.set_content(extracted["html"])
            page.pdf(path=str(pdf_path), format="A4", print_background=True)
            with fitz.open(pdf_path) as pdf:
                assert sum(len(p.get_images(full=True)) for p in pdf) >= 1
                text = "\\n".join(p.get_text() for p in pdf)
                assert "Verified table 00" in text
                assert "RAW_DELAYED_MARKUP" not in text
    finally:
        browser.close()

print("PASS: delayed assistant image upgrades an existing rich snapshot and survives into PDF")
