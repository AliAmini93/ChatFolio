"""Regression: native Chromium print scaling must not shift RTL A4 content off-paper.

Only fabricated conversation text. Exercises both default and user-selected 2/3
PDF print scale; validates printed coordinates, tables and source direction.
"""
from pathlib import Path
import fitz
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'content.js').read_text(encoding='utf-8')
SOURCE = SOURCE.replace('const PLATFORM = detectPlatform();',
    'const PLATFORM = {id:"chatgpt",name:"ChatGPT",assistantLabel:"ChatGPT"};', 1)
SOURCE = SOURCE.rsplit('})();',1)[0] + 'window.__rtlQa={buildPrintableDocument};})();'
PERSIAN = 'این یک متن آزمایشی فارسی برای بررسی چیدمان خروجی ChatFolio است. ' * 7
ASSISTANT = 'پاسخ آزمایشی با یک جدول فارسی و لینک انگلیسی برای تست نمایش چاپ. ' * 8
messages = []
for index in range(8):
    role = 'user' if index % 2 == 0 else 'assistant'
    message = PERSIAN if role == 'user' else ASSISTANT
    table = (f'<table><tr><th>موضوع</th><th>ارزیابی</th></tr>'
             f'<tr><td>PHASE9B-TABLE-{index}</td><td>نتیجه ساختگی {index}</td></tr></table>')
    a = '<p><a href="https://example.org/print-fixture">Fixture link</a></p>'
    messages.append({'key':f'qa-{index}', 'role':role,
        'text':message, 'html':f'<p>{message}</p>{table}{a}', 'imageCount':0})

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True,
        executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,
        args=['--no-sandbox','--disable-dev-shm-usage'])
    try:
        page = browser.new_page(viewport={'width':1560,'height':960})
        page.set_content('<html><body></body></html>')
        page.evaluate('''() => { window.chrome={runtime:{getManifest:()=>({version:'1.9.1'}),
            onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:false})}}; }''')
        page.add_script_tag(content=SOURCE)
        html = page.evaluate('''msgs => window.__rtlQa.buildPrintableDocument(
            msgs, 'بازیابی وضعیت پژوهش',
            {layoutMode:'comfortable',showMessageNumbers:true,includeExportTime:false},
            0,{id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'})''', messages)
        page.set_content(html,wait_until='load')
        page.emulate_media(media='screen')
        assert page.evaluate('getComputedStyle(document.documentElement).direction') == 'rtl'
        page.emulate_media(media='print')
        directions = page.evaluate('''() => ({root:getComputedStyle(document.documentElement).direction,
            body:getComputedStyle(document.body).direction,
            header:getComputedStyle(document.querySelector('.document-header')).direction,
            message:getComputedStyle(document.querySelector('.message')).direction})''')
        assert directions == {'root':'ltr','body':'ltr','header':'rtl','message':'rtl'},directions
        for scale in (1, 2/3):
            output = page.pdf(prefer_css_page_size=True,print_background=True,scale=scale)
            with fitz.open(stream=output,filetype='pdf') as pdf:
                assert len(pdf) > 1, len(pdf)
                for index, sheet in enumerate(pdf):
                    words = sheet.get_text('words')
                    assert words, (scale,index)
                    # The PDF margin-box footer is allowed but no content can
                    # disappear to the negative-x, clipped side of an A4 page.
                    left = min(x[0] for x in words)
                    right = max(x[2] for x in words)
                    assert left >= 20, (scale,index,round(left,2),'RTL page clipped')
                    assert right <= sheet.rect.width-20, (scale,index,round(right,2),'right overflow')
                combined = '\n'.join(sheet.get_text() for sheet in pdf)
                assert 'PHASE9B-TABLE-7' in combined, 'End-of-chat table lost'
                assert 'PHASE9B-TABLE-1' in combined, 'Early table lost'
                assert any(link.get('uri') == 'https://example.org/print-fixture'
                    for sheet in pdf for link in sheet.get_links())
    finally:
        browser.close()
print('PASS: 100% and 67% RTL print scales keep all text, tables, links inside A4')
