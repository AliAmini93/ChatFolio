"""Browser-print regression tests for v1.8.7. Run: python tests/test_print_polish_187.py
Fixtures are synthetic, no user conversations or live network sessions are accessed.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import fitz, json, re, os, tempfile
from urllib.parse import quote

BASE = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('CHATFOLIO_PRINT_QA_DIR') or tempfile.mkdtemp(prefix='chatfolio-print187-'))
OUT.mkdir(parents=True, exist_ok=True)
code = (BASE / 'content.js').read_text().replace('const PLATFORM = detectPlatform();','const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};',1)
code = code.rsplit('})();',1)[0] + 'window.__print187={serializeTurn,buildPrintableDocument};})();'
assert 'window.__print187' in code
src = 'data:image/svg+xml,' + quote('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#238659"/></svg>')
photo = 'data:image/svg+xml,'+quote('<svg xmlns="http://www.w3.org/2000/svg" width="550" height="400"><rect width="550" height="400" fill="#cedacc"/><text x="50" y="95">PRODUCT</text></svg>')
long_table = '<table><tbody><tr><th>H_ITEM_187</th><th>H_VALUE_187</th></tr>' + ''.join(f'<tr><td>BIG_ROW_{i:03d}</td><td>value {i:03d}</td></tr>' for i in range(1,61))+'</tbody></table>'
short_table = '<table><tbody><tr><th>S_NAME_187</th><th>S_COST_187</th></tr><tr><td>SMALL_ONE_187</td><td>30</td></tr><tr><td>SMALL_TWO_187</td><td>40</td></tr><tr><td>SMALL_THREE_187</td><td>50</td></tr></tbody></table>'
source_card = f'<div class="host-source-card" style="display:grid;grid-template-rows:1fr 1fr;gap:42px"><div><a href="https://example.com/source" class="host-source-link"><img width="16" height="16" src="{src}"/><span>example.com</span></a></div></div>'
content = f'''<!doctype html><html><body>
<div data-message-author-role="user" data-message-id="u0000001"><p>بررسی PDF و تست جدول ها</p></div>
<div data-message-author-role="assistant" data-message-id="a0000001">
<p>اولین پاراگراف در مورد ست عطر و فروشگاه‌های مختلف است.</p>
<img src="{photo}" alt="Product photograph" style="width:210px;height:151px"/>
<h2>Short table must not split</h2>
{''.join('<p>Fill text '+str(i)+': '+' '.join(['This is a realistic paragraph with 170 characters and English/Persian context.']*2)+'</p>' for i in range(8))}
{short_table}
<p>بعد از جدول کوتاه، جدول طولانی را با هدر تکرارشونده داریم.</p>
<h2>Long table must repeat its header</h2>
{long_table}
<h3>Source card</h3>
{source_card}
<p>End of primary assistant response.</p>
</div>
<div data-message-author-role="user" data-message-id="u0000002"><p>Can we get a concise report?</p></div>
<div data-message-author-role="assistant" data-message-id="a0000002"><p>Yes. Every message should be preserved verbatim.</p></div>
</body></html>'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width':1024,'height':850})
    page.set_content(content,wait_until='load')
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.7"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    page.add_script_tag(content=code)
    result=page.evaluate('''async()=>{
        const messages=[];
        for (const node of document.querySelectorAll('[data-message-author-role]')) {
            const role=node.getAttribute('data-message-author-role');
            messages.push({role,...(await window.__print187.serializeTurn(node,node,role,false,new AbortController().signal))});
        }
        const pdfHtml=window.__print187.buildPrintableDocument(messages,'خرید ست لطافه',
            {layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},2,
            {id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'});
        return {messages,html:pdfHtml};
    }''')
    assert len(result['messages'])==4
    assert 'export-table-short' in result['messages'][1]['html']
    assert 'export-table-long' in result['messages'][1]['html']
    assert '<thead>' in result['messages'][1]['html'], 'semantic header did not move to THEAD'
    assert result['messages'][1]['html'].count('H_ITEM_187') == 1
    assert result['messages'][1]['html'].count('S_NAME_187') == 1
    assert 'export-source-chip' in result['messages'][1]['html'], 'source card was not compacted'
    assert 'https://example.com/source' in result['messages'][1]['html'], 'source link missing'
    assert 'export-content-image' in result['messages'][1]['html'], 'picture missing'
    assert result['messages'][1]['html'].count('BIG_ROW_')==60
    (OUT/'sample.html').write_text(result['html'])
    page.set_content(result['html'],wait_until='load')
    path=OUT/'sample.pdf'
    # Deliberately enable browser headers/footers to test CSS override.
    page.pdf(path=str(path), format='A4', print_background=True, prefer_css_page_size=True, display_header_footer=True)
    pdf=fitz.open(path)
    texts=[pg.get_text() for pg in pdf]
    total='\n'.join(texts)
    assert 'about:blank' not in total and 'chrome-extension://' not in total, 'browser footer leaked'
    assert 'Oct' not in total and '10/10' not in total, 'browser date header leaked'
    assert all(token in total for token in ('SMALL_ONE_187','SMALL_TWO_187','SMALL_THREE_187'))
    small_indices={i for i,text in enumerate(texts) if any(item in text for item in ('S_NAME_187','SMALL_ONE_187','SMALL_TWO_187','SMALL_THREE_187'))}
    assert len(small_indices)==1, f'Short table split across PDF pages: {small_indices}'
    long_pages=[i for i,txt in enumerate(texts) if re.search(r'BIG_ROW_\d{3}',txt)]
    assert len(long_pages)>=2, f'Fixture failed to split long table: {long_pages}'
    repeat_check={i: ('H_ITEM_187' in texts[i] and 'H_VALUE_187' in texts[i]) for i in long_pages}
    assert all(repeat_check.values()),f'Long table header missing: {repeat_check}'
    assert len(re.findall(r'BIG_ROW_\d{3}', total)) == 60, 'Lost/duplicated long table body rows'
    links=sum(len(pg.get_links()) for pg in pdf)
    assert links >=1, 'PDF lost clickable source link'
    assert 'Can we get a concise report?' in total
    pdf.close()
    page.close(); browser.close()
print(json.dumps({'passed':True,'page_count':len(texts),'short_table_pages':sorted(small_indices),'long_table_pages':long_pages,'long_header_repeated':repeat_check,'source_links':links,'pdf':str(path)},indent=2))
