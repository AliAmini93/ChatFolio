import os
"""Verify real off-screen Googleusercontent images are embedded by a viewport crop.
This intentionally disallows any CORS fetch: image pixels may only be captured
from the original Gemini page after temporary scrolling, then scroll restored.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
import io, json, base64

root = Path(__file__).resolve().parents[1]
src = (root / 'content.js').read_text()
fixture = Image.new('RGB', (440, 260), (37, 121, 206))
buffer = io.BytesIO()
fixture.save(buffer, format='PNG')
png = buffer.getvalue()
results = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None, args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
    for sibling in [False, True]:
        page = browser.new_page(viewport={'width': 1100, 'height': 800}, device_scale_factor=1)
        page.route('https://lh3.googleusercontent.com/**', lambda route: route.fulfill(status=200, content_type='image/png', body=png))
        image_tag = '<img id="uploaded" style="width:330px;height:195px" alt="Uploaded image preview" src="https://lh3.googleusercontent.com/gg/testing-image.png">'
        attachment = f'<div class="image-wrapper">{image_tag}</div>'
        if sibling:
            prompt = '<user-query>Please analyze screenshot</user-query>' + attachment
        else:
            prompt = '<user-query>Please analyze screenshot '+attachment+'</user-query>'
        page.set_content(f'''<style>
          .chat-history-scroll-container {{height:570px;overflow-y:auto; border:1px solid silver;}}
          .spacer {{height:1250px;}}
          .conversation-container {{padding:8px;}}
          .image-wrapper img {{display:block}}
          </style>
          <div class="chat-history-scroll-container">
            <div class="spacer">Earlier Gemini history</div>
            <div class="conversation-container">{prompt}<model-response>Assistant reply</model-response></div>
            <div class="spacer">Later history</div>
          </div>''', wait_until='networkidle')
        page.evaluate('''()=>{
          window.fetch=()=>{window.__fetchCount=(window.__fetchCount||0)+1;return Promise.reject(new TypeError('CORS blocked'));};
          window.__capturedTop=-1;
          window.chrome={runtime:{onMessage:{addListener:()=>{}},getManifest:()=>({version:'1.8.10'}),lastError:null,
            sendMessage:(msg,cb)=>{
              if(msg.type==='CHATFOLIO_CAPTURE_VISIBLE'){
                const image=document.getElementById('uploaded');
                const scroller=document.querySelector('.chat-history-scroll-container');
                window.__capturedTop=scroller.scrollTop;
                const r=image.getBoundingClientRect();
                const screen=document.createElement('canvas');
                screen.width=window.innerWidth;screen.height=window.innerHeight;
                const context=screen.getContext('2d');
                context.fillStyle='rgb(220,50,50)';
                context.fillRect(0,0,screen.width,screen.height);
                if(r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth){
                    context.fillStyle='rgb(37,121,206)';
                    context.fillRect(r.left,r.top,r.width,r.height);
                }
                cb({ok:true,dataUrl:screen.toDataURL('image/png')});
              }else cb({ok:false});
            }}};
        }''')
        platform_src = src.replace('const PLATFORM = detectPlatform();','const PLATFORM = {id:"gemini", name:"Gemini", assistantLabel:"Gemini"};',1)
        platform_src=platform_src.rsplit('})();',1)[0]+'window.__test={getMessageNodes,getMessageRole,findTurnElement,serializeTurn};})();'
        page.add_script_tag(content=platform_src)
        result = page.evaluate('''async()=>{
          const scroller=document.querySelector('.chat-history-scroll-container');
          const before=scroller.scrollTop;
          const prompt=__test.getMessageNodes().find(n=>__test.getMessageRole(n)==='user');
          const result=await __test.serializeTurn(__test.findTurnElement(prompt),prompt,'user',true,new AbortController().signal);
          return {html:result.html, before, after:scroller.scrollTop, captureTop:window.__capturedTop,
             missing:result.missingUserImages, embedded:result.embeddedImageCount,
             imageCount:result.imageCount, fetchCount:window.__fetchCount||0};
        }''')
        import re
        m = re.search(r'src="(data:image/jpeg;base64,[^"]+)"', result['html'])
        quality = None
        if m:
            img=Image.open(io.BytesIO(base64.b64decode(m.group(1).split(',')[1]))).convert('RGB')
            quality=img.getpixel((img.width//2,img.height//2))
        ok = (result['imageCount']==1 and result['embedded']==1 and result['missing']==0 and
              result['before']==result['after']==0 and result['captureTop']>500 and
              result['fetchCount']==0 and quality is not None and abs(quality[0]-37)<15 and abs(quality[1]-121)<15)
        results.append({'test': 'Gemini off-screen '+('sibling' if sibling else 'nested')+' protected image',
                        'passed':ok, 'before':result['before'],'after':result['after'],
                        'capturedAt':result['captureTop'],'missing':result['missing'],
                        'count':result['imageCount'],'embedded':result['embedded'], 'fetches':result['fetchCount'],
                        'color':quality})
        page.close()
    browser.close()
print(json.dumps(results,indent=2))
assert all(x['passed'] for x in results)
