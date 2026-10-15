"""Phase 4A: generated-MV3-versus-ESM HTML parity and searchable PDF tests.

The same deterministic synthetic messages are rendered with the same explicit
helpers by both entrypoints, then printed in Chromium.
"""
from pathlib import Path
import os
import tempfile
import fitz
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
MODULE=(ROOT/'src/renderer/pdf-document.js').read_text(encoding='utf-8')
RUNTIME=(ROOT/'content.js').read_text(encoding='utf-8')
# Tests run without any external fixture: compare ESM rendering with generated
# classic content script at runtime. A separate local before/after comparison
# is run during the PR QA review for exact-byte legacy compatibility.
assert 'function createPdfDocumentRenderer({' in MODULE
assert 'function createPdfDocumentRenderer({' in RUNTIME
assert 'BEGIN GENERATED PDF document renderer' in RUNTIME

long_persian='پژوهشگران داده های مفصل را برای بررسی ویژگی های روش های یادگیری ماشین تحلیل می کنند. '*48
media='<figure><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="><figcaption>Sample image</figcaption></figure>'
cases=[
    ('en','chatgpt','Test conversation',[{'role':'user','text':'What is a model?','html':'<p>What is a model?</p>','imageCount':0}, {'role':'assistant','text':'A fitted representation','html':'<p>A fitted representation</p>','imageCount':0}]),
    ('fa','gemini','گفتگوی پژوهشی',[{'role':'user','text':'سوال درباره یک مقاله پژوهشی','html':'<p>سوال درباره یک مقاله پژوهشی</p>','imageCount':0}, {'role':'assistant','text':long_persian,'html':f'<p dir="rtl">{long_persian}</p>','imageCount':0}]),
    ('image','claude','Media example',[{'role':'user','text':'Look at my upload','html':f'<p>Look at my upload</p>{media}','imageCount':1},{'role':'assistant','text':'Image captured','html':'<p>Image captured</p>','imageCount':0}]),
]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,
      args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.set_content('<!doctype html><html><body></body></html>')
    page.evaluate('window.chrome={runtime:{getManifest:()=>({version:"1.8.11"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}')
    script=RUNTIME.replace('const PLATFORM = detectPlatform();', 'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',1)
    script=script.rsplit('})();',1)[0]+'window.__phase4a={buildPrintableDocument,escapeHtml,mergeFontStacks,inferDirection,sanitizePrintClone};})();'
    page.add_script_tag(content=script)
    # The same data/typed dependencies, all running in Chromium's DOM.
    esm=MODULE.replace('export function createPdfDocumentRenderer(', 'function createPdfDocumentRenderer(',1)
    source_func=r"""(source, messages, title, platform) => {
      const f=new Function('document','Node','Element','escapeHtml','mergeFontStacks','inferDirection','sanitizePrintClone',source+'\nreturn createPdfDocumentRenderer({document,Node,Element,escapeHtml,mergeFontStacks,inferDirection,sanitizePrintClone});');
      const deps=window.__phase4a;
      return f(document,Node,Element,deps.escapeHtml,deps.mergeFontStacks,deps.inferDirection,deps.sanitizePrintClone).buildPrintableDocument(messages,title,{layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},messages.reduce((x,m)=>x+m.imageCount,0),platform);
    }"""
    with tempfile.TemporaryDirectory(prefix='chatfolio4a-') as temp:
        for name,platform,title,messages in cases:
            pinfo={'id':platform,'name':platform.capitalize(),'assistantLabel':platform.capitalize()}
            opts={'layoutMode':'comfortable','showMessageNumbers':True,'includeExportTime':False}
            html_current=page.evaluate('([messages,title,opts,pinfo])=>window.__phase4a.buildPrintableDocument(messages,title,opts,messages.reduce((x,m)=>x+m.imageCount,0),pinfo)',[messages,title,opts,pinfo])
            html_esm=page.evaluate(f'([src,msg,title,pinfo])=>({source_func})(src,msg,title,pinfo)',[esm,messages,title,pinfo])
            # Font stack helper in ESM fixture must be equivalent to original
            # source's sanitize+merge for absent provider typography.
            assert html_current==html_esm, (name,len(html_current),len(html_esm))
            assert f'<html lang="{name if name in ("en","fa") else "en"}"' in html_current
            assert 'class="exchange"' in html_current
            if name=='fa':
                assert 'message-opening-flow' in html_current
            if name=='image':
                assert 'data:image/png;base64' in html_current
            page.set_content(html_current)
            file=Path(temp)/f'{name}.pdf'
            page.pdf(path=str(file),format='A4',prefer_css_page_size=True,print_background=True,display_header_footer=True)
            doc=fitz.open(file)
            assert len(doc)>=1
            assert any(len(pg.get_text().strip())>25 for pg in doc)
            assert all((f'{i+1} / {len(doc)}' in pg.get_text()) for i,pg in enumerate(doc)),name
            doc.close()
    browser.close()
print('PASS: 3 provider-neutral generated/ESM HTML snapshots + 3 searchable A4 PDF smoke tests')
