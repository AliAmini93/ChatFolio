from pathlib import Path
from playwright.sync_api import sync_playwright
import json,time
base=Path(__file__).resolve().parents[1]
source=(base/'content.js').read_text()
source=source.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };',1)
source=source.rsplit('})();',1)[0]+'''window.__cfTest = { getMessageNodes, findTurnElement, getMessageRole, serializeTurn, collectEntireConversation, resolveConversationScrollContainer, exportConversation, recoverForwardScan };})();'''
results=[]
# virtualized DOM: 30 exchanges; each viewport only mounts ~10 exchanges, but viewport scroll height spans full conversation.
html='''<!doctype html><html><head><style>
* {box-sizing:border-box} html,body {margin:0;padding:0;overflow:hidden;height:100%;}
main {padding:15px; height:100%;} #conversation-scroll {height:560px;width:680px;overflow-y:auto;border:2px solid black;overflow-anchor:none;}
#virtual-space {position:relative;width:100%;height:6700px;} [data-turn-key] {position:absolute;left:0;right:0;height:212px;padding:4px 8px;background:#fff;border-bottom:1px solid #bbb;}
[data-user-message-bubble] {font-weight:bold}
</style></head><body><main><div id="conversation-scroll"><div id="virtual-space"></div></div></main>
<script>
const scroller = document.getElementById('conversation-scroll');
const virtual = document.getElementById('virtual-space');
const totalTurns=30;
function renderVisible(){
  let start=Math.max(0,Math.floor(scroller.scrollTop/212)-2);
  let end=Math.min(totalTurns,Math.ceil((scroller.scrollTop+560)/212)+4);
  let str='';
  for(let i=start;i<end;i++){
    str += `<div data-turn-key="chat-exchange-stable-${i.toString().padStart(4,'0')}" style="top:${i*212}px"><div data-user-message-bubble>Question ${i+1} — important</div><div><span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown"><p>Response ${i+1} — unique report detail ${i+1}</p></div></div></div>`;
  }
  virtual.innerHTML=str;
}
scroller.addEventListener('scroll',()=>renderVisible(),{passive:true});renderVisible();
</script></body></html>'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'],timeout=15000)
    page=browser.new_page(viewport={'width':1250,'height':900})
    page.set_content(html,wait_until='domcontentloaded')
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.3"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    page.add_script_tag(content=source)
    # test selected scroller physically moves message
    scroller_probe=page.evaluate('''async()=>{
      const n=window.__cfTest.getMessageNodes()[0];
      const sc=await window.__cfTest.resolveConversationScrollContainer(n,'chatgpt',new AbortController().signal);
      return {id:sc.id, count:window.__cfTest.getMessageNodes().length};
    }''')
    results.append({'test':'Actual conversation scroller selected, not page/main', 'passed':scroller_probe['id']=='conversation-scroll','result':scroller_probe})
    started=time.monotonic()
    report=page.evaluate('''async()=>{
      let api=window.__cfTest;
      let session={controller:new AbortController(),cancelled:false,sourceUrl:location.href};
      let sc=document.querySelector('#conversation-scroll');
      let data=await api.collectEntireConversation(sc,{embedImages:false},session);
      return {count:data.messages.length,user:data.messages.filter(m=>m.role==='user').length, assistant:data.messages.filter(m=>m.role==='assistant').length, first:data.messages[0].text, last:data.messages.at(-1).text, ordered:data.messages.every((m,i)=>i%2===0?m.role==='user':m.role==='assistant'), hasText:data.messages.some(m=>m.text.includes('Response 30'))};
    }''')
    elapsed=round(time.monotonic()-started,2)
    results.append({'test':'Virtualized conversation: all 60 authored messages including final reply', 'passed': report['count']==60 and report['user']==30 and report['assistant']==30 and report['ordered'] and report['hasText'], 'result':report,'seconds':elapsed})
    # force blocked scroller: 10 msgs, scroll position snaps back after scroll (simulate stuck), speed up internal threshold in injected tester while preserving real 1.8.3 source.
    blocked=html.replace('const totalTurns=30','const totalTurns=5') .replace('height:6700px','height:2600px').replace('scroller.addEventListener(\'scroll\',()=>renderVisible(),{passive:true});renderVisible();','scroller.addEventListener(\'scroll\',()=>{if(scroller.scrollTop>160){scroller.scrollTop=0;}renderVisible();},{passive:true});renderVisible();')
    blocked_page=browser.new_page(viewport={'width':1250,'height':900})
    blocked_page.set_content(blocked,wait_until='domcontentloaded')
    blocked_page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:"1.8.3"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    # shorten recovery threshold only in test to avoid waiting >45 sec
    fast_source=source.replace('noProgressMs >= 10500','noProgressMs >= 1100')
    blocked_page.add_script_tag(content=fast_source)
    blocked_page.evaluate("""()=>{ const node=document.querySelector('#conversation-scroll'); node.scrollTo=()=>{}; Object.defineProperty(node,'scrollTop',{get(){return 0},set(_){}}); }""")
    started=time.monotonic()
    blocked_result=blocked_page.evaluate('''async()=>{
      let error='';let count=0;
      try {await window.__cfTest.collectEntireConversation(document.querySelector('#conversation-scroll'),{embedImages:false},{controller:new AbortController(),cancelled:false,sourceUrl:location.href})}
      catch(e){error=String(e);}
      return {error, nodes:window.__cfTest.getMessageNodes().length, overlay:!!document.querySelector('[data-chatfolio-visual-overlay]')};
    }''')
    results.append({'test':'Blocked scroller: safely detects stall and does not automatically show Visual Backup', 'passed': (('could not advance' in blocked_result['error']) or ('none moved' in blocked_result['error'])) and blocked_result['nodes']==10  and not blocked_result['overlay'], 'result':blocked_result,'seconds':round(time.monotonic()-started,2)})
    # Regression to ensure normal Export only exposes the explicit manual
    # Visual Backup path; no unconditional automatic overlay call remains.
    results.append({'test':'Visual Backup starts only when explicitly requested',
       'passed': source.count('return await runVisualArchiveFallback(')==1 and 'if (options.forceVisual)' in source,
       'result':{'explicitPathCount':source.count('return await runVisualArchiveFallback(')}})
    browser.close()
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(r['passed'] for r in results), 'At least one scan regression failed'
