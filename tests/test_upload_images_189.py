"""Synthetic Chromium coverage for Claude and Gemini user image attachments."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json

root = Path(__file__).resolve().parents[1]
original = (root / 'content.js').read_text()
svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='480'%3E%3Crect width='800' height='480' fill='royalblue'/%3E%3C/svg%3E"

def inject_source(platform):
    src = original.replace('const PLATFORM = detectPlatform();', f'const PLATFORM = {{ id: "{platform}", name: "{platform}", assistantLabel: "{platform}" }};', 1)
    return src.rsplit('})();', 1)[0] + '''window.__mediaTest = { getMessageNodes, findTurnElement, getMessageRole, serializeTurn, buildPrintableDocument };})();'''

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
    for platform,markup in [
        ('claude',f'''<main style="width:900px">
          <div data-test-render-count="1">
            <div data-testid="user-message"><p>What does this screenshot show?</p></div>
            <button aria-label="View attachment" class="user-upload" style="padding:0;border:0;display:block">
             <img alt="Screenshot" src="{svg}" style="display:block;width:310px;height:186px" />
            </button>
          </div>
          <div data-test-render-count="2"><div class="font-claude-response"><p>This is an image.</p></div></div>
          </main>'''),
        ('gemini',f'''<main style="width:900px"><div class="conversation-container">
          <user-query><user-query-content><span class="query-text-line">Please analyze this picture.</span>
            <button class="upload-thumb" style="display:block;border:0;padding:0">
              <img alt="Uploaded image preview" src="{svg}" style="width:300px;height:180px" />
            </button>
          </user-query-content></user-query>
          <model-response><p>I see a picture.</p></model-response>
          </div></main>'''),
        ('gemini-sibling',f'''<main style="width:900px"><div class="conversation-container">
          <user-query><user-query-content><p class="query-text-line">Describe the screenshot.</p></user-query-content></user-query>
          <div class="image-attachment" style="height:188px"><img alt="Uploaded image" src="{svg}" style="width:300px;height:180px" /></div>
          <model-response><p>A blue picture.</p></model-response>
          </div></main>'''),
        ('claude-sibling-bg',f'''<main style="width:900px"><div data-test-render-count="1">
          <div data-testid="user-message"><p>Describe the picture.</p></div>
          <div class="media" style="width:310px;height:180px;background-image:url(&quot;{svg}&quot;);background-size:cover"></div>
          </div><div data-test-render-count="2"><div class="font-claude-response"><p>A blue image.</p></div></div></main>''')
    ]:
        actual_platform=platform.split('-')[0]
        page=browser.new_page(viewport={'width':1000,'height':850})
        page.set_content(markup, wait_until='domcontentloaded')
        page.evaluate('''window.chrome={runtime:{onMessage:{addListener:()=>{}},getManifest:()=>({version:"1.8.9"}), sendMessage:(data, callback)=>callback({ok:false})}};''')
        page.add_script_tag(content=inject_source(actual_platform))
        page.wait_for_timeout(100)
        res=page.evaluate('''async()=>{
          const api = window.__mediaTest;
          const nodes=api.getMessageNodes();
          const user=nodes.find(n=>api.getMessageRole(n)==='user');
          const assistant=nodes.find(n=>api.getMessageRole(n)==='assistant');
          if(!user||!assistant)return {found:nodes.length,error:'Roles missing'};
          const u=await api.serializeTurn(api.findTurnElement(user),user,'user',true,new AbortController().signal);
          const a=await api.serializeTurn(api.findTurnElement(assistant),assistant,'assistant',true,new AbortController().signal);
          return {found:nodes.length,userText:u.text,imageCount:u.imageCount,embedded:u.embeddedImageCount,missing:u.missingUserImages,
                  dataImages:(u.html.match(/src="data:image\//g)||[]).length,
                  assistantCount:a.imageCount,hasAnswer:a.text.includes('picture')||a.text.includes('image'),
                  duplicateTextCount:(u.text.match(/screenshot|picture/gi)||[]).length};
        }''')
        ok=res.get('found')==2 and res.get('dataImages')==1 and res.get('imageCount')==1 and res.get('embedded')==1 and res.get('missing')==0 and res.get('assistantCount')==0 and res.get('hasAnswer')
        results.append({'test':platform,'passed':ok,**res})
        page.close()
    browser.close()
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(x['passed'] for x in results), 'Media extraction regression'
