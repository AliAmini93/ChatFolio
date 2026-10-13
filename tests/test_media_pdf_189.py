"""Generate a synthetic Claude PDF and verify user attachment image is embedded."""
from pathlib import Path
import base64
import json
from playwright.sync_api import sync_playwright
from PIL import Image
import io

base=Path(__file__).resolve().parents[1]
source=(base/'content.js').read_text()
source=source.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "claude", name:"Claude", assistantLabel:"Claude" };',1)
source=source.rsplit('})();',1)[0]+'window.__cfPDF={serializeTurn,getMessageNodes,getMessageRole,findTurnElement,buildPrintableDocument};})();'
png=Image.new('RGB',(640,360),(63,120,190));buffer=io.BytesIO();png.save(buffer,format='PNG');url='data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode()
html=f'''<div data-test-render-count="1"><div data-testid="user-message">Describe attached picture.</div><img alt="uploaded screenshot" src="{url}" style="width:350px;height:197px"></div>
<div data-test-render-count="2"><div class="font-claude-response"><p>The picture is blue and 640 pixels wide.</p></div></div>'''
pdf=Path('/mnt/data/chatfolio_189_work/user-upload-189-smoke.pdf')
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 page=b.new_page(); page.set_content(html,wait_until='load')
 page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:'1.8.9'}),onMessage:{addListener:()=>{}},sendMessage:(x,cb)=>cb({ok:false})}}''')
 page.add_script_tag(content=source)
 doc=page.evaluate('''async()=>{
   const nodes=__cfPDF.getMessageNodes(),messages=[];
   for(const node of nodes){ const role=__cfPDF.getMessageRole(node);
     const item=await __cfPDF.serializeTurn(__cfPDF.findTurnElement(node),node,role,true,new AbortController().signal);
     messages.push({role,...item});
   }
   return {html:__cfPDF.buildPrintableDocument(messages,'Attachment test', {layoutMode:'compact',includeExportTime:false,showMessageNumbers:true}, 1,{id:'claude',name:'Claude',assistantLabel:'Claude'}),imageCount:messages[0].imageCount,htmlImages:(messages[0].html.match(/src="data:image\//g)||[]).length};
 }''')
 assert doc['imageCount']==1 and doc['htmlImages']==1
 printpage=b.new_page();printpage.set_content(doc['html'],wait_until='load');printpage.pdf(path=str(pdf),format='A4',print_background=True,prefer_css_page_size=True)
 b.close()
print(json.dumps({'file':str(pdf),'size':pdf.stat().st_size,'image_count':doc['imageCount']}))
