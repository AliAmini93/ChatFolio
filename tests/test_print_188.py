"""v1.8.8 browser print QA: orphan heads, RTL page counters and source spacing.
Run: python tests/test_print_188.py. Uses only synthetic fixture data.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image,ImageDraw
from io import BytesIO
import base64, re, fitz, json, os, tempfile
from urllib.parse import quote

base=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('CHATFOLIO_188_QA_DIR') or tempfile.mkdtemp(prefix='chatfolio-188-'))
out.mkdir(parents=True,exist_ok=True)
code=(base/'content.js').read_text().replace('const PLATFORM = detectPlatform();', 'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',1)
code=code.rsplit('})();',1)[0]+'window.__cfTest188={serializeTurn,buildPrintableDocument,splitPrintableMessageOpening};})();'
im=Image.new('RGB',(600,470),'#dfebea');draw=ImageDraw.Draw(im);draw.rectangle((40,50,550,400),outline='#567675',width=5);draw.text((120,230),'COVER IMAGE / FIDELITY TEST',fill='black');buf=BytesIO();im.save(buf,format='PNG')
photo='data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
logo='data:image/svg+xml,'+quote('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#208c69"/></svg>')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1200,'height':920})
    page.set_content('<html><body>Fixture</body></html>')
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.8"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    page.add_script_tag(content=code)
    chipMarkup=f'<div data-message-author-role="assistant"><div class="provider-source-card"><a href="https://example.org/evidence"><img src="{logo}" width="16" height="16"><span>perfumes.lt</span><span>+2</span></a></div></div>'
    page.evaluate('(html)=>document.body.innerHTML=html',chipMarkup)
    chip=page.evaluate('''async()=>{const n=document.querySelector('[data-message-author-role]');return await window.__cfTest188.serializeTurn(n,n,'assistant',false,new AbortController().signal)}''')
    assert 'export-source-extra-count' in chip['html'],chip['html'][:1000]
    assert 'href="https://example.org/evidence"' in chip['html']
    assert '+2' in chip['text'] and 'perfumes.lt' in chip['text']
    source_opening=page.evaluate('(html)=>window.__cfTest188.splitPrintableMessageOpening(html)',chip['html'])
    assert 'perfumes.lt' in source_opening['lead'] and 'export-preview-logo' in source_opening['lead'], 'favicon separated from source'
    assert source_opening['lead'].count('https://example.org/evidence')==1
    # Build a real page-near-end case by varying prior answer size. The last
    # reply begins with a nested image; its author must print alongside it.
    tested=[]
    for paragraphs in (7, 9, 11, 13, 15, 17, 19, 21):
        filler='<p>' + ' '.join(['A description of product sourcing and shipping with long pricing details.']*3) + '</p>'
        msgs=[
           {'role':'user','text':'Initial English question','html':'<p>Initial English question</p>','imageCount':0},
           {'role':'assistant','text':'Long background', 'html': filler*paragraphs,'imageCount':0},
           {'role':'user','text':'A follow-up question','html':'<p>A follow-up question</p>','imageCount':0},
           {'role':'assistant','text':'The full response remains printable', 'html':f'<div><div><img class="export-content-image export-response-screenshot" src="{photo}" style="--chatfolio-image-width:480px" alt="OPENING_IMAGE_188"></div><p>FIRST_REAL_TEXT_188 follows the picture in the answer.</p></div><p>Remaining answer text.</p>', 'imageCount':1}
        ]
        html=page.evaluate('''(messages)=>window.__cfTest188.buildPrintableDocument(messages,'Long English conversation',{layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},1,{id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'})''',msgs)
        if paragraphs==7:
            assert 'class="message-opening"' in html
            assert 'class="message-body message-lead"' in html
            assert html.count('FIRST_REAL_TEXT_188')==1
            assert html.count('OPENING_IMAGE_188')==1
        page.set_content(html,wait_until='load')
        path=out/f'orphan_{paragraphs}.pdf'
        page.pdf(path=str(path),format='A4',prefer_css_page_size=True,print_background=True,display_header_footer=True)
        pdf=fitz.open(path)
        page_text=[pg.get_text() for pg in pdf]
        full='\n'.join(page_text)
        heading_pages=[i for i,txt in enumerate(page_text) if re.search(r'Message\s*4',txt)]
        image_pages=[i for i,pg in enumerate(pdf) if any(x[0] in {entry[0] for entry in pg.get_images()} for x in pg.get_images())]
        assert len(heading_pages)==1,(paragraphs,heading_pages)
        assert heading_pages[0] in image_pages,(paragraphs,heading_pages,image_pages)
        assert full.count('FIRST_REAL_TEXT_188')==1
        assert all(f'{i+1} / {len(pdf)}' in txt for i,txt in enumerate(page_text)),(paragraphs,[t[:40] for t in page_text])
        assert 'about:blank' not in full and 'chrome-extension://' not in full
        tested.append({'paragraphs':paragraphs,'pages':len(pdf),'message4Page':heading_pages[0]+1,'imagePages':[x+1 for x in image_pages]})
        pdf.close()
    # Persian/Rtl numbering: the generated margin box must force LTR.
    rtlmsgs=[{'role':'user','text':'سلام سوال فارسی','html':'<p dir="rtl">سلام سوال فارسی</p>','imageCount':0}, {'role':'assistant','text':'این پاسخ طولانی است','html':('<p dir="rtl">این پاسخ طولانی است و همین متن را چند بار تکرار می‌کنیم تا صفحه‌بندی آزمایش شود.</p>'*70),'imageCount':0}]
    html=page.evaluate('''(messages)=>window.__cfTest188.buildPrintableDocument(messages,'گفتگوی آزمایشی',{layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},0,{id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'})''',rtlmsgs)
    page.set_content(html);path=out/'rtl.pdf';page.pdf(path=str(path),print_background=True,prefer_css_page_size=True,display_header_footer=True)
    pdf=fitz.open(path)
    assert len(pdf)>=2
    assert all(f'{i+1} / {len(pdf)}' in pg.get_text() for i,pg in enumerate(pdf))
    n=len(pdf);pdf.close()
    browser.close()
print(json.dumps({'passed':True,'orphan_cases':tested,'rtl_pages':n,'citation_counter_marked':True,'qa_dir':str(out)},indent=2))
