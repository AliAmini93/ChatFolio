"""Smoke-test the generated classic MV3 runtime's extracted media factory."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
src = (root / "content.js").read_text()
assert "BEGIN GENERATED Image pipeline" in src
assert src.count("function createImagePipeline({") == 1

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=os.environ.get("CHATFOLIO_CHROMIUM") or None,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )
    for platform in ("claude", "gemini"):
        page = browser.new_page(viewport={"width": 1024, "height": 768})
        page.set_content('''<main><div style="padding:30px"><img id="user-image" alt="Uploaded image"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='240'%3E%3C/svg%3E"
          style="width:180px;height:120px"></div></main>''')
        page.evaluate('''() => {
          window.chrome={runtime:{onMessage:{addListener:()=>{}},sendMessage:(req,cb)=>cb({ok:false}),getManifest:()=>({version:'1.8.11'})}};
          window.__networkCalls=0;
          window.fetch=()=>{__networkCalls+=1;throw Error('unexpected fetch')};
        }''')
        generated=src.replace("const PLATFORM = detectPlatform();",f'const PLATFORM = {{id:"{platform}", name:"{platform}", assistantLabel:"{platform}"}};',1)
        generated=generated.rsplit("})();",1)[0]+'''window.__media4b1={createImagePipeline, bestLiveImageUrl, sourceToDataUrl, embedVisibleProviderImage};})();'''
        page.add_script_tag(content=generated)
        result=page.evaluate('''async () => {
          const img=document.getElementById('user-image');
          await img.decode();
          const before=window.scrollY;
          const raw=__media4b1.bestLiveImageUrl(img);
          const output=await __media4b1.embedVisibleProviderImage(img,raw,new AbortController().signal);
          const direct=await __media4b1.sourceToDataUrl(raw,new AbortController().signal);
          return {factory:typeof __media4b1.createImagePipeline, same:raw===output&&output===direct,
                  image:output.startsWith('data:image/svg+xml'), network:window.__networkCalls,
                  scrollUnchanged:window.scrollY===before};
        }''')
        assert result == {"factory":"function","same":True,"image":True,"network":0,"scrollUnchanged":True}, (platform,result)
        page.close()
    browser.close()
print("Phase 4B1: generated MV3 image pipeline passed Claude and Gemini smoke fixtures")
