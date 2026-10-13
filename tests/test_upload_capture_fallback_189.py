import os
"""Validate capture fallback for loaded, CORS-blocked attachment thumbnails."""
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
import base64
import io
import json

root = Path(__file__).resolve().parents[1]
src = (root / 'content.js').read_text()
fixture_image = Image.new('RGB', (480, 270), (32, 112, 202))
image_buffer = io.BytesIO()
fixture_image.save(image_buffer, format='PNG')
raw_png = image_buffer.getvalue()
report = []

with sync_playwright() as p:
  browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None, args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
  for platform in ['claude','gemini']:
    page = browser.new_page(viewport={'width':1000,'height':750}, device_scale_factor=1)
    # This URL is an offline Playwright fixture. fetch() cannot read its pixels
    # because the server sends no CORS headers, even though the <img> renders.
    page.route('https://assets.claude.ai/test-upload.png', lambda route: route.fulfill(status=200, content_type='image/png', body=raw_png))
    markup=(f'<main><div data-test-render-count="1"><div data-testid="user-message">Attached screenshot:</div><div style="margin:10px">'
          '<img style="width:320px;height:180px" alt="Screenshot" src="https://assets.claude.ai/test-upload.png"></div></div>'
          '<div data-test-render-count="2"><div class="font-claude-response">I can see it.</div></div></main>') if platform=='claude' else (
          '<main><div class="conversation-container"><user-query><span class="query-text-line">Attached screenshot:</span>'
          '<img style="width:320px;height:180px" alt="Uploaded image preview" src="https://assets.claude.ai/test-upload.png"></user-query>'
          '<model-response>I can see it.</model-response></div></main>')
    page.set_content(markup, wait_until='networkidle')
    # Snapshot represents a browser capture returned from the existing extension
    # background route. It is not taken from any real user's account.
    screenshot_url = 'data:image/png;base64,'+base64.b64encode(page.screenshot(full_page=False)).decode()
    page.evaluate('''(screen)=>{
      const oldFetch=window.fetch.bind(window);
      window.fetch=(url,options)=>String(url).includes('assets.claude.ai/test-upload.png') ? Promise.reject(new TypeError('CORS blocked')) : oldFetch(url,options);
      window.chrome={runtime:{onMessage:{addListener:()=>{}},getManifest:()=>({version:"1.8.9"}),lastError:null,
         sendMessage:(msg,callback)=>callback(msg.type==='CHATFOLIO_CAPTURE_VISIBLE'?{ok:true,dataUrl:screen}:{ok:false})}};
    }''',screenshot_url)
    platform_src=src.replace('const PLATFORM = detectPlatform();',f'const PLATFORM = {{ id: "{platform}", name: "{platform}", assistantLabel: "{platform}" }};',1)
    platform_src=platform_src.rsplit('})();',1)[0]+'window.__test={getMessageNodes,getMessageRole,findTurnElement,serializeTurn,buildPrintableDocument};})();'
    page.add_script_tag(content=platform_src)
    result=page.evaluate('''async()=>{
        const nodes=__test.getMessageNodes();const user=nodes.find(n=>__test.getMessageRole(n)==='user');
        const captured=await __test.serializeTurn(__test.findTurnElement(user),user,'user',true,new AbortController().signal);
        return {html:captured.html,imageCount:captured.imageCount,embedCount:captured.embeddedImageCount,missing:captured.missingUserImages};
    }''')
    encoded=result['html'].split('src="')[1].split('"')[0]
    ok=encoded.startswith('data:image/jpeg;base64,') and result['imageCount']==1 and result['embedCount']==1 and result['missing']==0
    if ok:
      crop=Image.open(io.BytesIO(base64.b64decode(encoded.split(',')[1])))
      ok=300<=crop.width<=330 and 175<=crop.height<=185
    report.append({'test':platform+' capture fallback', 'passed':ok,'imageCount':result['imageCount'],'embedded':result['embedCount'],'missing':result['missing'], 'srcPrefix':encoded[:28]})
    page.close()
  browser.close()
print(json.dumps(report,indent=2))
assert all(r['passed'] for r in report)
