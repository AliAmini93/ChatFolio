from pathlib import Path
from playwright.sync_api import sync_playwright
import json
base=Path(__file__).resolve().parents[1]
source=(base/'content.js').read_text()
source=source.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };',1)
source=source.rsplit('})();',1)[0]+'''window.__cfTest = { getMessageNodes, findTurnElement, getMessageRole, serializeTurn, getMessageIdentity, buildPrintableDocument };})();'''
img = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3C/svg%3E"
markup=f'''<main>
<div data-turn-key="turn-000000a1"><div data-user-message-bubble>Question A</div><div>
  <div data-conversation-role="assistant"><span>ChatGPT said:</span></div><div class="prose"><p>First rich assistant response with a real paragraph and <b>important content</b>.</p></div>
  <img alt="Generated illustration" src="{img}" style="width:260px;height:195px;" />
</div></div>
<div data-turn-key="turn-000000a2"><div data-user-message-bubble>Question B</div><div>
  <span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown"><p>Second assistant response, located in a sibling of its role marker.</p></div>
</div></div>
<div data-turn-key="turn-000000a3"><div data-user-message-bubble>Question C</div><div>
  <div data-conversation-role="assistant">ChatGPT said:</div><p>A third answer with a table.</p><table><tr><td>Data</td></tr></table>
</div></div>
<div data-turn-key="turn-000000a4"><div data-user-message-bubble>Question D</div><div>
  <div data-conversation-role="assistant">ChatGPT said:</div>
</div></div>
</main>'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'], timeout=10000)
    page=browser.new_page()
    page.set_content(markup,wait_until='domcontentloaded',timeout=10000)
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.4"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    page.add_script_tag(content=source)
    result=page.evaluate('''async()=>{
      const api=window.__cfTest;const report=[];
      const nodes=api.getMessageNodes();
      report.push({test:'Grouped renderer detects 8 nodes',passed:nodes.length===8,nodes:nodes.length});
      for(let i=0;i<4;i++){
        const user=nodes[2*i], assistant=nodes[2*i+1],role=api.getMessageRole(assistant);
        let captured;
        try {captured=await api.serializeTurn(api.findTurnElement(assistant),assistant,'assistant',false,new AbortController().signal)}
        catch(e){ report.push({test:'Message '+(i+1), passed:i===3 && /content was not captured/i.test(String(e)), error:String(e)});continue; }
        const text=captured.text||'';
        let passed=false;
        if(i===0)passed=text.includes('First rich assistant response')&&!text.includes('Question A')&&captured.imageCount===1 &&captured.html.includes('--chatfolio-image-width: 260px');
        if(i===1)passed=text.includes('Second assistant response')&&!text.includes('Question B');
        if(i===2)passed=text.includes('A third answer with a table')&&captured.html.includes('<table')&&!text.includes('Question C');
        report.push({test:'Message '+(i+1),passed,text,imageCount:captured.imageCount,role,htmlFragment:captured.html.slice(0,400)});
      }
      const doc=api.buildPrintableDocument([{role:'user',text:'Question A',html:'<p>Question A</p>',imageCount:0},{role:'assistant',text:'First rich assistant response',html:'<p>First rich assistant response</p>',imageCount:1}], 'Regression', {layoutMode:'compact',includeExportTime:false,showMessageNumbers:true},1,{id:'chatgpt',name:'ChatGPT',assistantLabel:'ChatGPT'});
      report.push({test:'Image stylesheet size caps',passed:doc.includes('112mm')&&doc.includes('155mm')&&doc.includes('var(--chatfolio-image-width, auto)')});
      return report;
    }''')
    browser.close()
    # In-memory regression report; no fixture data is written into the extension folder.
    print(json.dumps(result,ensure_ascii=False,indent=2))
    assert all(x['passed'] for x in result),'Regression failed'
