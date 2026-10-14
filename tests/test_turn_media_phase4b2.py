"""Phase 4B2: compare generated MV3 turn serialization against phase-4B1 fixture.

No network access, account data or screenshot assets required. Both versions run
against identical synthetic authored turns inside real Chromium DOM environments.
A baseline snapshot may be injected by QA via CHATFOLIO_BASELINE_CONTENT; the
baseline is optional in CI, which still runs all structural/media smoke checks.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (ROOT / 'content.js').read_text()
assert 'BEGIN GENERATED turn media' in RUNTIME
assert RUNTIME.count('function createTurnMediaProcessor({') == 1
assert 'const imageStats = await embedTurnImagePairs(' in RUNTIME
BASELINE_PATH = os.environ.get('CHATFOLIO_BASELINE_CONTENT')
BASELINE = Path(BASELINE_PATH).read_text() if BASELINE_PATH else None

SVG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAWgAAADICAIAAABK7OzYAAACeklEQVR4nO3UQQ3AIADAQEANmnCKu2noiyy5U9BX5z53ABTrdQDwP8YBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZMYBZB+i0wLLyZ/lKgAAAABJRU5ErkJggg=='

cases = [
    ('claude','user',f'<article id="turn"><p>Review attached screenshot</p><button><img id="upload" src="{SVG}" alt="Uploaded image" style="width:220px;height:125px"></button></article>'),
    ('gemini','user',f'<div class="conversation-container"><article id="turn"><p>آیا این تصویر درست است؟</p><img id="upload" src="{SVG}" alt="Uploaded image" style="width:220px;height:125px"></article></div>'),
    ('chatgpt','assistant',f'<article id="turn"><p>Here is the screenshot:</p><img src="{SVG}" alt="Screenshot results" style="width:360px;height:200px"></article>'),
    ('claude','assistant','<article id="turn"><p>Generated figure</p><canvas id="plot" width="160" height="96"></canvas></article>'),
    ('gemini','user','<article id="turn"><p>Canvas upload cannot be read</p><canvas id="plot" width="160" height="96"></canvas></article>'),
    ('gemini','user','<div class="conversation-container"><button title="archive.zip">archive.zip</button><article id="turn"><p>Attached document</p></article></div>'),
]

def run_case(browser, runtime, platform, role, fragment, embed=True):
    page = browser.new_page(viewport={'width':1024,'height':768})
    page.set_content('<!doctype html><html><body><main>'+fragment+'</main></body></html>')
    page.evaluate('''() => {
      window.chrome={runtime:{onMessage:{addListener:()=>{}},sendMessage:(_m,cb)=>cb?.({ok:false}),getManifest:()=>({version:'1.8.11'})}};
      window.fetch=()=>{throw Error('Unexpected network request')};
      const canvas=document.getElementById('plot');
      if (canvas) {
        const ctx=canvas.getContext('2d'); ctx.fillStyle='#123';ctx.fillRect(0,0,160,96);
      }
    }''')
    # The poisoned canvas case explicitly exercises the existing missing-image
    # guard and requires an identical HTML/count result after module extraction.
    if role == 'user' and 'Canvas upload' in fragment:
        page.evaluate('''() => {document.querySelector('canvas').toDataURL=()=>{throw Error('SecurityError: tainted canvas')};}''')
    # Ensure the image actually decodes before the serializer reads natural size.
    if 'id="upload"' in fragment:
        page.evaluate('''async()=>{await document.getElementById('upload').decode()}''')
    patched = runtime.replace('const PLATFORM = detectPlatform();',
        f'const PLATFORM = {{id:"{platform}",name:"{platform.capitalize()}",assistantLabel:"{platform.capitalize()}"}};',1)
    patched = patched.rsplit('})();',1)[0] + '''window.__media4b2={serializeTurn, classifyImage};})();'''
    page.add_script_tag(content=patched)
    result = page.evaluate('''async([role,embed])=>{
      const turn=document.getElementById('turn');
      const result=await window.__media4b2.serializeTurn(turn,turn,role,embed,new AbortController().signal);
      return { ...result, imageTypes:(result.html.match(/data-export-image-kind="[^"]+"/g)||[]) };
    }''',[role,embed])
    page.close()
    return result

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,
                              args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
    for i,(platform,role,html) in enumerate(cases):
        result=run_case(browser,RUNTIME,platform,role,html)
        assert result['html'].strip() and not result['html'].startswith('<p>[Media-only'), (i,result)
        if 'id="upload"' in html:
            assert result['embeddedImageCount']>=1 and result['missingUserImages']==0, (i,result)
            assert 'data:image/png;base64' in result['html'], (i,result)
        if 'Generated figure' in html:
            assert result['embeddedImageCount']==1 and result['imageCount']==1, (i,result)
            assert '<canvas' not in result['html'] and 'data:image/png' in result['html'], (i,result)
        if 'Canvas upload' in html:
            assert result['missingUserImages']==1 and result['embeddedImageCount']==0, (i,result)
        if 'archive.zip' in html:
            assert 'archive.zip' in result['html'] and 'export-attachment' in result['html'],(i,result)
        if BASELINE:
            old=run_case(browser,BASELINE,platform,role,html)
            assert result==old,(i,platform,role,repr(result)[:400],repr(old)[:400])
    browser.close()
print('PASS: generated classic MV3 turn-media integration, 6 fixtures' + (' + exact pre-refactor parity' if BASELINE else ''))
