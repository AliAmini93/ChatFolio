"""Repro for provider CSS leaking tall responsive cards into ChatFolio print.
Run with python tests/test_layout_186.py; produces QA PDFs outside the packaged extension.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import fitz, json, os, re, tempfile
from urllib.parse import quote

base = Path(__file__).resolve().parents[1]
new=base/'content.js'
output=Path(os.environ.get('CHATFOLIO_LAYOUT_QA_DIR') or tempfile.mkdtemp(prefix='chatfolio-layout-qa-')); output.mkdir(parents=True,exist_ok=True)
svg='<svg xmlns="http://www.w3.org/2000/svg" width="520" height="380"><rect width="100%" height="100%" fill="#e8efe9"/><rect x="160" y="50" width="190" height="290" rx="16" fill="#e4d2b5" stroke="#6c665f" stroke-width="5"/><text x="260" y="180" font-size="30" fill="#52452e" text-anchor="middle">LATTAFA</text><text x="260" y="222" font-size="18" fill="#52452e" text-anchor="middle">THE KINGDOM</text></svg>'
image='data:image/svg+xml,'+quote(svg)
style='''<style>html,body{margin:0}main{max-width:800px;margin:auto;padding:30px;font-family:Arial,sans-serif} .provider-huge-card{min-height:790px!important;display:grid!important;grid-template-rows:1fr auto!important;align-items:end!important;} [data-provider-layout="hero"]{min-height:630px!important} .provider-summary-card {display:flex!important;min-height:470px!important;align-items:flex-end!important} .provider-hidden {display:none!important}</style>'''
markup=f'''<!doctype html><html><head>{style}</head><body><main>
<div data-message-author-role="user" data-message-id="user0001"><p>Looking for this Lattafa gift set in Kaunas; how much does it cost?</p></div>
<div data-message-author-role="assistant" data-message-id="assista001">
  <p>فروشگاه‌های مختلف را بررسی کردم. چند انتخاب برای ست عطر وجود دارد.</p><span class="provider-hidden">INVISIBLE DEBUG CLONE</span>
  <div class="provider-huge-card" data-provider-layout="hero" style="display:grid;grid-template-rows:1fr auto;height:790px;gap:40px"><div class="product-photo" style="min-height:200px"><img alt="Product photograph" src="{image}" width="230" height="168" style="width:230px;height:168px"/></div><div><h3>Lattafa The Kingdom Men Gift Set</h3><p>قیمت فعلی در فروشگاه: 26.89 €</p><p>روش های تحویل: دریافت حضوری یا ارسال با الکر.</p></div></div>
  <table><thead><tr><th>روش دریافت</th><th>هزینه</th></tr></thead><tbody><tr><td>دریافت حضوری</td><td>26.89 €</td></tr><tr><td>ارسال با الکر</td><td>29.38 €</td></tr></tbody></table>
</div>
<div data-message-author-role="user" data-message-id="user0002"><p>Can I trust the online store and is the item really in stock?</p></div>
<div data-message-author-role="assistant" data-message-id="assista002">
  <h2>بررسی اعتبار فروشگاه</h2><p>اطلاعات ثبت و شرایط پرداخت را بررسی می‌کنیم. وجود آدرس و تلفن نشانهٔ مثبتی است، اما اعتبار فروشگاه را تضمین نمی‌کند.</p>
  <div class="provider-summary-card"><div><h3>فروشگاه Perfumes.lt</h3><p>نظرات مشتریان محدود است. بهتر است از روش پرداخت محافظت شده استفاده کنی.</p><p>در این چت فارسی و English ترکیب شده است.</p><p><a href="https://example.com">View store</a></p></div></div>
  <ol><li>Compare prices and stock</li><li>Check shipping method</li><li>Review checkout carefully</li></ol>
</div>
</main></body></html>'''


def test_one(browser,source,label):
    page=browser.new_page(viewport={'width':1100,'height':900})
    page.set_content(markup, wait_until='domcontentloaded')
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.6"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    source=source.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };',1)
    source=source.rsplit('})();',1)[0]+'''window.__cfTest = {serializeTurn,buildPrintableDocument};})();'''
    page.add_script_tag(content=source)
    data=page.evaluate('''async()=>{
      const messages=[];
      for(const [i,node] of [...document.querySelectorAll('[data-message-author-role]')].entries()){
        const role=node.getAttribute('data-message-author-role');
        const val=await window.__cfTest.serializeTurn(node,node,role,false,new AbortController().signal);
        messages.push({role, ...val});
      }
      const html=window.__cfTest.buildPrintableDocument(messages,'خرید ست لطافه',{layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},1,{id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'});
      return { messages, html };
    }''')
    assert len(data['messages'])==4
    assert '26.89' in data['messages'][1]['html'] and '<table' in data['messages'][1]['html']
    assert '29.38' in data['messages'][1]['html'] and 'export-content-image' in data['messages'][1]['html']
    assert 'INVISIBLE DEBUG CLONE' not in data['messages'][1]['html'], 'hidden provider duplicate leaked'
    if label=='after':
        assert 'provider-huge-card' not in data['messages'][1]['html'], 'source class leaked'
        assert 'data-provider-layout' not in data['messages'][1]['html'], 'source data attr leaked'
        assert 'style="display:grid' not in data['messages'][1]['html'], 'inline grid leaked'
        assert 'View store' in data['messages'][3]['html']
    else:
        assert 'provider-huge-card' in data['messages'][1]['html']
    qa_html=data['html'].replace('</head>',style+'</head>')
    (output/f'{label}.html').write_text(qa_html)
    page.set_content(qa_html,wait_until='load')
    page.pdf(path=str(output/f'{label}.pdf'),format='A4',print_background=True,prefer_css_page_size=True,display_header_footer=False)
    pdf=fitz.open(str(output/f'{label}.pdf'))
    n=len(pdf)
    stats={ 'pages':n,'total_chars':sum(len(p.get_text()) for p in pdf),'page_chars':[len(p.get_text()) for p in pdf]}
    pdf.close();page.close();return stats

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None, args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
 current_source=new.read_text()
 # Control reproduces the provider CSS leak by omitting only the new class/data normalization.
 control_source=current_source.replace('      removeProviderPresentationHooks(node);','      // normalization intentionally disabled in control fixture;')
 # Phase 5C1 adds a final provider-independent scrub. Disable it only for
 # this intentionally broken 'before' reproduction so baseline remains valid.
 control_source=control_source.replace('    sanitizePrintClone(clone);','    // sanitizer intentionally disabled in control fixture;')
 # Remove the new structural reset in the control as well.
 control_source=control_source.replace('''    .message-body :is(div, section, article, figure, picture) {
      min-height: 0 !important;
      height: auto !important;
      max-height: none !important;
      aspect-ratio: auto !important;
    }
    .message-body :is(div, section, article) {
      break-inside: auto;
      page-break-inside: auto;
    }
''','')
 before=test_one(browser,control_source,'before')
 after=test_one(browser,current_source,'after')
 browser.close()
print(json.dumps({'before':before,'after':after},ensure_ascii=False,indent=2))
assert after['page_chars'][0] > before['page_chars'][0] * 1.45, 'First-page density did not improve'
assert after['pages'] <= before['pages'], 'Pagination regressed'
assert after['total_chars']>=before['total_chars']-50,'Text was lost'
