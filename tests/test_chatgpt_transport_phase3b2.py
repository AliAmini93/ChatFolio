"""Verify the actual generated MV3 content script exposes a working provider transport."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
source=(root/'content.js').read_text(encoding='utf-8')
assert 'BEGIN GENERATED ChatGPT transport' in source
assert 'END GENERATED ChatGPT transport' in source
# The fixture instruments the generated classic-script IIFE, rather than a
# parallel copy of the ESM source, to catch missing generated symbols.
source=source.rsplit('})();',1)[0]+'''window.__cfTransport = createChatGPTTransport;
})();'''
with sync_playwright() as p:
    launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
    browser_path=os.environ.get('CHATFOLIO_CHROMIUM')
    if browser_path and Path(browser_path).is_file():launch['executable_path']=browser_path
    browser=p.chromium.launch(**launch)
    try:
        page=browser.new_page()
        page.set_content('<main>ChatGPT simulated export</main>')
        page.evaluate("""window.chrome={runtime:{getManifest:()=>({version:'1.8.11'}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}""")
        page.add_script_tag(content=source)
        results=page.evaluate("""async () => {
          const calls=[];
          const fakeFetch=async (url,init)=>{
            calls.push({url,credentials:init.credentials,headers:init.headers});
            if(url==='/api/auth/session') return {ok:true,json:async()=>({accessToken:'fixture',account:'a1'})};
            if(url.startsWith('/backend-api/conversation/')) return {ok:true,json:async()=>({title:'fixture-chat',mapping:{}})};
            return {ok:false,status:404};
          };
          const t=window.__cfTransport({fetchImpl:fakeFetch,getOrigin:()=>location.origin,
            getChatGPTAccountId:(session)=>session.account,
            chatGPTAssetPointerInfo:()=>({kind:'url',value:'https://example.test/picture.png',fileId:''}),
            parsePublicShare:()=>null,makeCancelledError:()=>new Error('stopped')});
          const auth=await t.getRequiredAuth();
          const conversation=await t.getConversation({conversationId:'conv-id',projectId:'project-1'},auth.accessToken,auth.accountId);
          const image=await t.requestAssetDownloadUrl({}, {}, {});
          return {auth:auth.accountId,title:conversation.conversation.title,image,
            calls:calls.map(x=>({url:x.url,credentials:x.credentials,project:x.headers?.['chatgpt-project-id']||''}))};
        }""")
        assert results['auth']=='a1',results
        assert results['title']=='fixture-chat',results
        assert results['image']=='https://example.test/picture.png',results
        assert results['calls'][0]['url']=='/api/auth/session',results
        assert results['calls'][1]['project']=='project-1',results
        assert len(results['calls'])==2,results
        print(json.dumps({'passed':True,'browser':'Chromium','fixture':'generated MV3 ChatGPT transport'}))
    finally:
        browser.close()
