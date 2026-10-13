from pathlib import Path
from playwright.sync_api import sync_playwright
import time,json
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'content.js').read_text()
source=source.replace('const PLATFORM = detectPlatform();','const PLATFORM = { id: "chatgpt", name: "ChatGPT", assistantLabel: "ChatGPT" };',1)
source=source.rsplit('})();',1)[0]+'''window.__cfTest={getMessageNodes,resolveConversationScrollContainer,collectEntireConversation,probeConversationScroller};})();'''
html='''<!doctype html><html><head><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden} main{height:800px;position:relative} 
#outer{height:580px;width:780px;overflow:visible;position:relative} #false-spacer{position:absolute;top:1000px;height:9200px;width:2px;pointer-events:none}
#real{width:740px;height:560px;overflow-y:auto;overflow-anchor:none;border:2px solid #ccc;position:relative;background:white}#space{width:100%;height:0;position:relative}
[data-turn-key]{position:absolute;left:0;right:0;height:208px;padding:5px 15px;border-bottom:1px solid #aaa}
[data-user-message-bubble]{font-weight:bold} .markdown{padding:10px}
</style></head><body><main><div id="outer"><div id="real"><div id="space"></div></div><div id="false-spacer"></div></div></main>
<script>
const real=document.querySelector('#real'),space=document.querySelector('#space');
const total=28;space.style.height=(total*208)+'px';
function draw(){
 const from=Math.max(0,Math.floor(real.scrollTop/208)-2),to=Math.min(total,Math.ceil((real.scrollTop+560)/208)+3);
 let output='';for(let n=from;n<to;n++)output+=`<section data-turn-key="row-${n}" style="top:${n*208}px"><div data-user-message-bubble>Prompt ${n} about a sample</div><div><span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown"><p>Detailed answer ${n} sample text</p></div></div></section>`;
 space.innerHTML=output;
}real.addEventListener('scroll',draw,{passive:true});draw();
</script></body></html>'''
results=[]
def add(name,pass_,detail):
 results.append({'test':name,'passed':bool(pass_),'detail':detail})
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'],timeout=15000)
 def open_page(content,code=source):
  page=b.new_page(viewport={'width':1280,'height':900})
  page.set_content(content,wait_until='domcontentloaded')
  page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:'1.8.4'}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
  page.add_script_tag(content=code)
  return page
 page=open_page(html)
 observation=page.evaluate('''async()=>{let a=window.__cfTest;let n=a.getMessageNodes()[0];const container=await a.resolveConversationScrollContainer(n,'chatgpt',new AbortController().signal);return {container:container.id,otherRange:document.querySelector('#outer').scrollHeight-document.querySelector('#outer').clientHeight,realRange:document.querySelector('#real').scrollHeight-document.querySelector('#real').clientHeight};}''')
 add('Reject tall non-scroll wrapper, select moving conversation scrollport',observation['container']=='real' and observation['otherRange']>9000,observation)
 t=time.monotonic()
 out=page.evaluate('''async()=>{const session={controller:new AbortController(),cancelled:false,sourceUrl:location.href};const a=window.__cfTest;let sc=document.querySelector('#real');let result=await a.collectEntireConversation(sc,{embedImages:false},session);return {count:result.messages.length,first:result.messages[0].text,last:result.messages.at(-1).text,user:result.messages.filter(m=>m.role==='user').length,assistant:result.messages.filter(m=>m.role==='assistant').length,ordered:result.messages.every((m,i)=>m.role===(i%2?'assistant':'user'))};}''')
 add('28 exchange virtualized collection complete and ordered',out['count']==56 and out['user']==28 and out['assistant']==28 and out['ordered'] and '27' in out['last'],{'result':out,'seconds':round(time.monotonic()-t,1)})
 page.close()
 # Invisible wrapper without any real scrollport should fail during initial selection
 no_scroll='''<html><head><style>body{overflow:hidden}#fake{height:500px;overflow:visible}#spacer{height:10204px} .markdown{height:250px}</style></head><body><div id="fake"><section data-turn-key="p-0"><div data-user-message-bubble>Hello</div><div><span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown">Answer</div></div></section><div id="spacer"></div></div></body></html>'''
 page=open_page(no_scroll)
 page.evaluate('''()=>{for(const n of [document.querySelector('#fake'), document.scrollingElement, document.documentElement]){if(!n)continue;Object.defineProperty(n,'scrollTop',{configurable:true,get(){return 0},set(_){}});n.scrollTo=()=>{};}}''')
 stat=page.evaluate('''async()=>{try{await window.__cfTest.resolveConversationScrollContainer(window.__cfTest.getMessageNodes()[0],'chatgpt',new AbortController().signal);return 'no error';}catch(e){return e.message}}''')
 add('Fail fast on inert 9704px wrapper, with safe evidence',('none moved' in stat and 'Scollers' not in stat),stat)
 page.close()
 # Portal-like renderer: scrollport is NOT a parent of the authored surface.
 # Its scroll events update the visible author nodes in a fixed sibling.
 portal='''<!doctype html><html><head><style>html,body{overflow:hidden;height:100%;margin:0}
main{width:1100px;height:700px;position:relative} .overflow-y-auto{overflow-y:auto}
#scrollpane{height:560px;width:750px;position:relative;background:#fafafa}
#tall{height:6000px}#authored{position:absolute;top:20px;left:20px;width:730px;pointer-events:none;background:white}
</style></head><body><main><div id="scrollpane" class="overflow-y-auto"><div id="tall"></div></div><div id="authored"></div></main><script>
const port=document.querySelector('#scrollpane'),surface=document.querySelector('#authored');
function render(){const n=Math.round(port.scrollTop/250);surface.innerHTML=`<div data-turn-key="row-${n}"><div data-user-message-bubble>Question ${n}</div><div><span data-chatgpt-agent-turn-start>ChatGPT said:</span><div class="markdown"><p>Reply ${n}</p></div></div></div>`}
port.addEventListener('scroll',render);render();
</script></body></html>'''
 page=open_page(portal)
 chosen=page.evaluate('''async()=>{const a=window.__cfTest;const n=a.getMessageNodes()[0];const sc=await a.resolveConversationScrollContainer(n,'chatgpt',new AbortController().signal);return {id:sc.id,found:a.getMessageNodes().length}}''')
 add('Portal-style scrollport resolved outside DOM ancestor chain',chosen['id']=='scrollpane',chosen)
 page.close()
 b.close()
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(x['passed'] for x in results)
