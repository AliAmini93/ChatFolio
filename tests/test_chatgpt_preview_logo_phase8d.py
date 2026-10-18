"""Phase 8D: moving virtualized viewport yields full, rich API-backed PDF.

Synthetic ChatGPT DOM exposes two of nine groups at a time. A genuine
scrollable element remounts new groups as it moves; the exporter must capture
rendered HTML before that group disappears and must restore scroll position.
No real conversation, signed media or network resource is included.
"""
from __future__ import annotations

import json
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
    "window.__phase8d={getMessageNodes,matchedChatGPTLiveAssistantTurns,"
    "enhanceChatGPTMetadataWithRenderedDom,buildPrintableDocument};})();"
)

GROUPS = 9
messages = []
groups = []
for i in range(GROUPS):
    question = f"Synthetic distinct question {i:02d}: explain printed tables and citations in detail."
    prose = [
        f"This complete response {i:02d} explains how an ordered scientific conversation can be faithfully exported without misplacing important information.",
        f"The second substantial paragraph for exchange {i:02d} establishes that the original user's attached content remains untouched in the output.",
        f"An additional independent paragraph for exchange {i:02d} requires actual rendered tables and links instead of unresolved component source strings.",
    ]
    raw = (
        "\n".join(prose) +
        f"\n<grid><grid-item><box>RAW_UI_SENTINEL_{i:02d}</box></grid-item></grid>"
    )
    messages += [
        {
            "key": f"q{i}","role":"user","text":question,
            "html":"<p>"+question+"</p>","imageCount":0
        },
        {
            "key":f"a{i}","role":"assistant","text":raw,
            "html":"<p>"+raw.replace("<","&lt;").replace(">","&gt;")+"</p>",
            "imageCount":0
        },
    ]
    rendered = (
        "<h3>Rendered response %02d</h3>" % i +
        "".join("<p>"+p+"</p>" for p in prose) +
        '<table><thead><tr><th>Result</th><th>Score</th></tr></thead>'
        f'<tbody><tr><td>Experiment {i:02d}</td><td>PASS</td></tr></tbody></table>'
        f'<a href="https://example.org/fixture/{i}">Linked reference {i}</a>' +
        f'<a href="https://example.org/source/{i}"><img src="https://example.org/slow-icon-{i}.png" style="width:24px;height:24px" width="24" height="24" alt=""></a>'
    )
    groups.append(
        f'<div data-turn-key="group-{i}" style="position:absolute;top:{i*430}px;left:0;right:0;min-height:300px">'
        f'<div data-user-message-bubble>{question}</div>'
        '<div data-conversation-role="assistant">ChatGPT said:</div>'
        f'<div class="response">{rendered}</div></div>'
    )

with sync_playwright() as playwright:
    chrome = playwright.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        page = chrome.new_page(viewport={"width":1100,"height":900})
        page.set_content("<main></main>")
        page.evaluate("""() => {window.chrome = {runtime: {
          getManifest: () => ({version:"1.8.11"}),
          onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})}}}""")
        page.add_script_tag(content=SOURCE)
        page.set_content("""
        <main>
          <div id="scrollport" data-scroll-container
             style="width:850px;height:440px;overflow-y:auto;overscroll-behavior:contain;position:relative">
             <div id="virtual-track" style="height:3900px;position:relative"></div>
          </div>
        </main>
        """)
        page.evaluate("""htmlGroups => {
           const viewport=document.getElementById("scrollport");
           const track=document.getElementById("virtual-track");
           let previous = -1;
           let prepended = false;
           let prependTimer = null;
           const render = () => {
              const first=Math.max(0,Math.min(htmlGroups.length-2,
                  Math.floor(viewport.scrollTop/430)));
              // Simulate asynchronous older-history hydration. The first
              // two groups do not mount until 850ms AFTER scrolling to top.
              if(first===0 && !prepended && !prependTimer) {
                  prependTimer=setTimeout(() => {
                      prepended=true;
                      previous=-1;
                      render();
                  },850);
              }
              const effective=first===0 && !prepended ? 2 : first;
              if(effective===previous) return;
              previous=effective;
              track.innerHTML=htmlGroups.slice(effective,effective+2).join("");
           };
           viewport.addEventListener("scroll",render);
           window.__phase8dRender=render;
           viewport.scrollTop=3400;
           render();
        }""", groups)
        page.wait_for_timeout(200)
        before = page.evaluate("""() => ({
          top:document.getElementById('scrollport').scrollTop,
          mounted:window.__phase8d.getMessageNodes().length,
          keys:[...document.querySelectorAll('[data-turn-key]')].map(x=>x.dataset.turnKey)
        })""")
        assert before["mounted"] == 4, before
        assert before["top"] > 3000, before
        page.evaluate("""() => { window.__logoFetches=0;
          const saved=window.fetch;
          window.fetch=(...args)=>{
            if(String(args[0]).includes("slow-icon-")){
              window.__logoFetches++; return new Promise(()=>{});
            }
            return saved(...args);
          };
        }""")
        snapshots = []
        page.on("console", lambda m: snapshots.append(m.text)
                if "ChatFolio Rich UI QA (counts only):" in m.text else None)
        result = page.evaluate("""async messages => {
          const session={controller:new AbortController(),cancelled:false};
          const extracted=await window.__phase8d.enhanceChatGPTMetadataWithRenderedDom(
            {extractionSource:"metadata",messages,imageCount:0},
            {embedImages:true},session);
          return {
            messages:extracted.messages,
            html:window.__phase8d.buildPrintableDocument(
              extracted.messages,"Virtualized synthetic conversation",
              {layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},
              extracted.imageCount,{id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"}
            ),
            afterTop:document.getElementById("scrollport").scrollTop
          };
        }""", messages)
        assert page.evaluate("window.__logoFetches") == 0, "Source logo fetch must not block Rich UI"
        assert len(result["messages"]) == len(messages)
        assert [m["key"] for m in result["messages"]] == [m["key"] for m in messages]
        assert abs(result["afterTop"]-before["top"]) < 5, (before,result["afterTop"])
        for i in range(GROUPS):
            answer = result["messages"][2*i+1]
            assert "<table" in answer["html"], (i,answer["html"][:220])
            assert f"RAW_UI_SENTINEL_{i:02d}" not in answer["html"]
        assert snapshots, "Missing numerical QA report"
        counters = json.loads(snapshots[-1].split("ChatFolio Rich UI QA (counts only):",1)[1].strip())
        assert counters["apiTurns"] == 18
        assert counters["mountedTurns"] == 4
        assert counters["enrichedRawRich"] == GROUPS, counters
        assert counters["scanWindows"] > 3
        assert counters["scanTopWaitRounds"] >= 5, counters
        assert counters["scanSteps"] >= 5, counters
        assert counters["scanStopReason"] in {
            "at-scroll-limit", "scroll-stalled", "short-scrollport",
            "step-budget", "time-budget"
        }, counters
        assert counters["scanRestored"] is True
        assert "Synthetic distinct question" not in snapshots[-1]

        with TemporaryDirectory(prefix="chatfolio-virtual-dom-") as temp:
            pdf_path = Path(temp) / "synthetic-scroll-recovery.pdf"
            page.set_content(result["html"])
            page.pdf(path=str(pdf_path),format="A4",print_background=True)
            with fitz.open(pdf_path) as pdf:
                all_text="\n".join(p.get_text() for p in pdf)
                for i in range(GROUPS):
                    assert f"Experiment {i:02d}" in all_text
                    assert f"RAW_UI_SENTINEL_{i:02d}" not in all_text
                links = [link.get("uri") for p in pdf for link in p.get_links()]
                assert "https://example.org/fixture/0" in links
                assert f"https://example.org/fixture/{GROUPS-1}" in links
    finally:
        chrome.close()

print("PASS: all virtualized Rich UI groups rehydrated into PDF with links and viewport restoration")
