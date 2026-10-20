"""Phase 8D: hidden ChatGPT tab aborts rich capture rather than silently printing raw markup.

Only synthetic messages. No real user content or network access.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "content.js").read_text(encoding="utf8")
SOURCE = SOURCE.replace(
    "const PLATFORM = detectPlatform();",
    'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',1,
)
SOURCE = SOURCE.rsplit("})();", 1)[0] + (
    "window.__visibilityTest={enhanceChatGPTMetadataWithRenderedDom};})();"
)
question = "Synthetic unique question about printing the rich table."
answer = "This longer synthetic answer explains how the exporter captures the original rendered markup, with sufficient text for quality checks."
messages = [
  {"key":"q0","role":"user","text":question,
   "html":"<p>"+question+"</p>","imageCount":0},
  {"key":"a0","role":"assistant","text":answer+"\\n<grid><box>RAW_SNAPSHOT</box></grid>",
   "html":"<p>"+answer+"</p><p>&lt;grid&gt;RAW_SNAPSHOT&lt;/grid&gt;</p>","imageCount":0},
]
with sync_playwright() as playwright:
    chrome = playwright.chromium.launch(
        headless=True, executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox","--disable-dev-shm-usage"])
    try:
        page = chrome.new_page(viewport={"width":1100,"height":900})
        page.set_content("<main></main>")
        page.evaluate("""() => {window.chrome={runtime:{
          getManifest:()=>({version:"1.8.11"}),
          onMessage:{addListener:()=>{}},
          sendMessage:async()=>({ok:false})}}}""")
        page.add_script_tag(content=SOURCE)
        page.set_content(
          '<main><div data-turn-key="one" style="min-height:300px">'
          '<div data-user-message-bubble>'+question+'</div>'
          '<div data-conversation-role="assistant">ChatGPT said:</div>'
          '<div class="response"><p>'+answer+'</p>'
          '<table><tr><td>Rendered rich cell</td></tr></table></div>'
          '</div></main>'
        )
        page.evaluate("""() => {
          window.__simulateHidden=false;
          Object.defineProperty(document, "visibilityState", {
            configurable:true,
            get:()=>window.__simulateHidden?"hidden":"visible"
          });
        }""")
        qa = []
        page.on("console", lambda message: qa.append(message.text)
                if "ChatFolio Rich UI QA (counts only):" in message.text else None)
        page.evaluate("""() => {
          window.__simulateHidden=true;
          document.dispatchEvent(new Event("visibilitychange"));
        }""")
        failed = page.evaluate("""async msgs => {
          const session={controller:new AbortController(),cancelled:false};
          try {
            await window.__visibilityTest.enhanceChatGPTMetadataWithRenderedDom(
              {extractionSource:"metadata",messages:msgs,imageCount:0},
              {embedImages:false},session);
            return {ok:true};
          } catch(error) {
            return {ok:false,code:error.code,message:error.message};
          }
        }""", messages)
        assert failed["ok"] is False, failed
        assert failed["code"] == "CHATFOLIO_TAB_HIDDEN", failed
        assert "No incomplete PDF" in failed["message"], failed
        assert qa, "Missing visibility failure diagnostics"
        counters = json.loads(qa[-1].split("ChatFolio Rich UI QA (counts only):", 1)[1])
        assert counters["scanStopReason"] == "tab-backgrounded", counters
        assert counters["scanTabBackgrounded"] is True, counters
        assert counters["scanRestored"] is True, counters
        page.evaluate("""() => {
          window.__simulateHidden=false;
          document.dispatchEvent(new Event("visibilitychange"));
        }""")
        recovered = page.evaluate("""async msgs => {
          const session={controller:new AbortController(),cancelled:false};
          return (await window.__visibilityTest.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages:msgs,imageCount:0},
            {embedImages:false},session)).messages;
        }""", messages)
        assert len(recovered) == 2
        assert "<table" in recovered[1]["html"], recovered[1]
        assert "RAW_SNAPSHOT" not in recovered[1]["html"], recovered[1]
    finally:
        chrome.close()
print("PASS: hidden tab blocks partial Rich UI PDF; foreground succeeds")
