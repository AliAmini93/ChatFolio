import os
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,time
ROOT=Path(__file__).resolve().parents[1]
src=(ROOT/'content.js').read_text()
src=src.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };',1)
src=src.rsplit('})();',1)[0]+'''window.__cfTest={getMessageNodes,resolveConversationScrollContainer,collectEntireConversation,getScrollTop,setScrollTop,probeConversationScroller};})();'''
html='''<!doctype html><html><head><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}main{height:800px;position:relative}
#real{width:740px;height:560px;display:flex;flex-direction:column-reverse;overflow-y:auto;overflow-anchor:none;border:2px solid #ccc;position:relative;background:white}
#space{width:100%;height:0;position:relative;flex-shrink:0}
[data-turn-key]{position:absolute;left:0;right:0;height:208px;padding:5px 15px;border-bottom:1px solid #aaa}
[data-user-message-bubble]{font-weight:bold}.markdown{padding:10px}
</style></head><body><main><div id="real"><div id="space"></div></div></main>
<script>
const real=document.querySelector('#real'),space=document.querySelector('#space');
const total=28;space.style.height=(total*208)+'px';
function draw(){
 const range=real.scrollHeight-real.clientHeight;
 const logicalTop=real.scrollTop+range;
 const from=Math.max(0,Math.floor(logicalTop/208)-2),to=Math.min(total,Math.ceil((logicalTop+560)/208)+3);
 let output='';for(let n=from;n<to;n++)output+=`<section data-turn-key="row-${n}" style="top:${n*208}px"><div data-user-message-bubble>Prompt ${n} about a sample</div><div><span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown"><p>Detailed answer ${n} sample text</p></div></div></section>`;
 space.innerHTML=output;
}
real.addEventListener('scroll',draw,{passive:true});draw();
</script></body></html>'''
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,args=['--no-sandbox','--disable-dev-shm-usage'],timeout=15000)
 page=b.new_page(viewport={'width':1280,'height':900})
 page.set_content(html,wait_until='domcontentloaded')
 page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:'1.8.5'}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
 page.add_script_tag(content=src)
 state=page.evaluate('''async()=>{
  const a=window.__cfTest,sc=document.querySelector('#real');
  const oldFirst=a.getMessageNodes()[0].closest('[data-turn-key]').getAttribute('data-turn-key');
  const chosen=await a.resolveConversationScrollContainer(a.getMessageNodes()[0],'chatgpt',new AbortController().signal);
  const before={raw:sc.scrollTop,logical:a.getScrollTop(sc),range:sc.scrollHeight-sc.clientHeight,first:oldFirst};
  a.setScrollTop(sc,0);
  await new Promise(r=>setTimeout(r,200));
  const atStart={raw:sc.scrollTop,logical:a.getScrollTop(sc),first:a.getMessageNodes()[0].closest('[data-turn-key]').getAttribute('data-turn-key')};
  a.setScrollTop(sc,sc.scrollHeight-sc.clientHeight);
  await new Promise(r=>setTimeout(r,200));
  const atEnd={raw:sc.scrollTop,logical:a.getScrollTop(sc),first:a.getMessageNodes()[0].closest('[data-turn-key]').getAttribute('data-turn-key')};
  return {selected:chosen.id,before,atStart,atEnd};
 }''')
 results.append({'test':'Negative scrollbar found and coordinate normalized','passed': state['selected']=='real' and state['before']['raw']==0 and state['before']['logical']>1000 and state['atStart']['raw']<-1000 and state['atStart']['logical']<=2 and state['atEnd']['raw']==0,'detail':state})
 t=time.monotonic()
 try:
  outcome=page.evaluate('''async()=>{
    const sc=document.querySelector('#real'),a=window.__cfTest;
    const session={controller:new AbortController(),cancelled:false,sourceUrl:location.href};
    const result=await a.collectEntireConversation(sc,{embedImages:false},session);
    return {count:result.messages.length,first:result.messages[0].text,last:result.messages.at(-1).text,user:result.messages.filter(m=>m.role==='user').length,assistant:result.messages.filter(m=>m.role==='assistant').length,ordered:result.messages.every((m,i)=>m.role===(i%2?'assistant':'user')),restored:{logical:a.getScrollTop(sc),raw:sc.scrollTop}};
  }''')
  good=outcome['count']==56 and outcome['user']==28 and outcome['assistant']==28 and outcome['ordered'] and '27' in outcome['last']
  results.append({'test':'Reversed virtualized 28 exchanges scanned end-to-end','passed':good,'detail':{'result':outcome,'seconds':round(time.monotonic()-t,1)}})
 except Exception as error:
  results.append({'test':'Reversed virtualized 28 exchanges scanned end-to-end','passed':False,'detail':str(error)})
 page.close();b.close()
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(x['passed'] for x in results), 'Regression failed'
