"""Check that Chrome's GENERATED classic content script embeds the live Gemini scanner."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'content.js').read_text()
assert source.count('function createGeminiHistoryScanner({') == 1
assert source.count('BEGIN GENERATED Gemini history scanner') == 1
source = source.rsplit('})();', 1)[0] + '\nwindow.__geminiHistoryFactory = createGeminiHistoryScanner;\n})();\n'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True,
        executable_path=os.getenv('CHATFOLIO_CHROMIUM') or None,
        args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
    try:
        page = browser.new_page()
        page.set_content('''<main><section id="chat-history">
          <div class="conversation-container"><user-query data-message-id="user-1">سلام</user-query><model-response data-message-id="answer-1">درود</model-response></div>
          <div class="conversation-container"><user-query data-message-id="user-2">عکس</user-query><model-response data-message-id="answer-2">دریافت شد</model-response></div>
        </section></main>''')
        page.evaluate("window.chrome={runtime:{getManifest:()=>({version:'1.8.11'}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}")
        page.add_script_tag(content=source)
        result = page.evaluate('''async () => {
          const el=document.querySelector('#chat-history'), progress=[];
          const f=window.__geminiHistoryFactory({
            documentRef: document,
            notifyProgress: data=>progress.push(data),
            throwIfCancelled: () => {}, assertSameConversation:()=>{},
            setScrollTop: (node, top)=>{node.scrollTop=top;},
            getScrollTop: node=>node.scrollTop||0,
            scrollRange:()=>200,
            sleepWithAbort: async()=>{},
            getMessageNodes:()=>[...document.querySelectorAll('user-query,model-response')],
            dedupeNestedMessages:nodes=>nodes,
            getMessageRole:n=>n.tagName.toLowerCase()==='user-query'?'user':'assistant',
            findTurnElement:n=>n,
            getMessageIdentity:n=>({strongKey:n.getAttribute('data-message-id'),fingerprintKey:n.textContent}),
            serializeTurn:async(_,n)=>({html:'<p>'+n.textContent+'</p>',text:n.textContent,imageCount:0,mediaKeys:[]}),
            assertProviderUserImagesCaptured:()=>{},
            findConversationScrollContainer:()=>el
          });
          const out=await f.collectGeminiConversation(el,{embedImages:true},{controller:{signal:{aborted:false}}});
          return {count:out.messages.length,keys:out.messages.map(m=>m.key),roles:out.messages.map(m=>m.role),
            progress:progress.length,turns:f.countGeminiConversationTurns(),firstHtml:out.messages[0].html};
        }''')
        assert result['count'] == 4, result
        assert result['roles'] == ['user','assistant','user','assistant'], result
        assert result['keys'] == ['user-1','answer-1','user-2','answer-2'], result
        assert result['turns'] == 2, result
        assert result['firstHtml'] == '<p>سلام</p>', result
        assert result['progress'] >= 5, result
        print(json.dumps({'passed': True, 'fixture':'bundled Gemini history scanner','result':result},ensure_ascii=False))
    finally:
        browser.close()
