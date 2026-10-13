"""Synthetic regression: long Gemini text openings may cross A4 page boundaries.

Run: python tests/test_gemini_print_whitespace_191.py
No private user chat data or provider network calls are needed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import fitz, tempfile, json, os, re

root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('CHATFOLIO_191_QA_DIR',tempfile.mkdtemp(prefix='chatfolio-191-')))
out.mkdir(parents=True,exist_ok=True)
source=(root/'content.js').read_text().replace('const PLATFORM = detectPlatform();', 'const PLATFORM = {id:"gemini",name:"Gemini",assistantLabel:"Gemini"};',1)
source=source.rsplit('})();',1)[0]+'window.__test191={buildPrintableDocument,splitPrintableMessageOpening};})();'
shortmsg=lambda text:{'role':'user','html':f'<p dir="rtl">{text}</p>','text':text,'imageCount':0}
assist=lambda html,txt,images=0:{'role':'assistant','html':html,'text':txt,'imageCount':images}
filler='دانشمندان یک مجموعه از تصاویر ریزساختاری را برای پژوهش علمی بازسازی کرده اند. '
long=filler*47
short=filler*4
cases={
    'long_p':f'<p dir="rtl">{long}</p>',
    'long_div':f'<div dir="rtl">{long}</div>',
    'nested_long_p':f'<section><div><p dir="rtl">{long}</p></div></section>',
    'rich_formatted_p':f'<p dir="rtl"><strong>نتیجه:</strong> {long}</p>',
}
results=[]
with sync_playwright() as p:
    b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    pg=b.new_page(viewport={'width':1200,'height':920})
    pg.set_content('<html></html>')
    pg.evaluate('window.chrome={runtime:{getManifest:()=>({version:"1.8.11"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}')
    pg.add_script_tag(content=source)
    initial=[shortmsg('لینک آزمایشی و یک سوال کوتاه'), assist(f'<p dir="rtl">{short}</p>',short),shortmsg('یک سوال دوم در مورد این پژوهش')]
    for name,richer in cases.items():
        opening=pg.evaluate('(html)=>window.__test191.splitPrintableMessageOpening(html)',richer)
        assert opening['longTextOpening'] and len(opening['lead'])>500,(name,opening)
        msgs=initial+[assist(richer,long)]
        html=pg.evaluate('msgs=>window.__test191.buildPrintableDocument(msgs,"گفتگوی آزمایشی",{layoutMode:"comfortable",showMessageNumbers:true,includeExportTime:false},0,{id:"gemini",name:"Gemini",assistantLabel:"Gemini"})',msgs)
        assert 'class="message-opening message-opening-flow"' in html
        pg.set_content(html); file=out/f'{name}.pdf'
        pg.pdf(path=str(file),prefer_css_page_size=True,format='A4',print_background=True,display_header_footer=True)
        doc=fitz.open(file)
        content=[x.get_text() for x in doc]
        assert len(doc)>=2,(name,len(doc))
        assert any('4' in blk[4] and 'Gemini' in blk[4] for blk in doc[0].get_text('blocks')),(name,'fourth message did not start on first page')
        # A Gemini opener that used to jump wholesale to page two now fills
        # substantial first-page space with answer text.
        first_bottom=max(b[3] for b in doc[0].get_text('blocks') if b[4].strip() and ' / ' not in b[4])
        assert first_bottom>635,(name,first_bottom)
        assert all(f'{i+1} / {len(doc)}' in txt for i,txt in enumerate(content)),(name,'page numbering')
        results.append(dict(case=name,pages=len(doc),first_page_bottom=round(first_bottom)))
        doc.close()
    # A short Gemini opener remains indivisible with the author label.
    small=pg.evaluate('(html)=>window.__test191.splitPrintableMessageOpening(html)',f'<p>{short}</p>')
    assert small['longTextOpening'] is False
    # Non-Gemini providers must never acquire this new flow class.
    html=pg.evaluate('msgs=>window.__test191.buildPrintableDocument(msgs,"Short example",{layoutMode:"comfortable",showMessageNumbers:true},0,{id:"claude",name:"Claude",assistantLabel:"Claude"})',initial+[assist(cases['long_p'],long)])
    assert 'message-opening-flow' not in html.split('<main>',1)[1]
    # A genuine user image remains atomic, irrespective of size.
    pic='data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%22320%22%20height%3D%22180%22%3E%3Crect%20width%3D%22320%22%20height%3D%22180%22%20fill%3D%22teal%22/%3E%3C/svg%3E'
    med=f'<p>{long}</p><img class="export-user-media" src="{pic}" alt="TEST_UPLOAD">'
    medlead=pg.evaluate('(html)=>window.__test191.splitPrintableMessageOpening(html)',med)
    assert medlead['longTextOpening'] is True # long text precedes an image; only text is in opening
    med2=f'<div><img class="export-user-media" src="{pic}" alt="TEST_UPLOAD"></div><p>{long}</p>'
    imgopening=pg.evaluate('(html)=>window.__test191.splitPrintableMessageOpening(html)',med2)
    assert imgopening['longTextOpening'] is False
    html=pg.evaluate('msgs=>window.__test191.buildPrintableDocument(msgs,"Media test",{layoutMode:"comfortable",showMessageNumbers:true},1,{id:"gemini",name:"Gemini",assistantLabel:"Gemini"})',initial+[assist(med2,long,1)])
    assert html.count('TEST_UPLOAD')==1
    assert 'class="message-opening"' in html.split('<main>',1)[1]
    b.close()
print(json.dumps({'passed':True,'cases':results,'image_opening_unchanged':True,'other_platforms_unchanged':True,'qa_dir':str(out)},ensure_ascii=False,indent=2))
