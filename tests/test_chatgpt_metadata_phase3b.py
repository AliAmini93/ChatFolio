"""Browser regression for the generated classic MV3 ChatGPT metadata helpers."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json

root = Path(__file__).resolve().parents[1]
source = (root / 'content.js').read_text(encoding='utf-8')
assert 'BEGIN GENERATED ChatGPT metadata parsers' in source
assert 'END GENERATED ChatGPT metadata parsers' in source
source = source.rsplit('})();', 1)[0] + '''window.__cfMetadataTest = {
  getChatGPTConversationContext, collectChatGPTBranch, orderChatGPTShareNodes,
  decodeChatGPTTurboStreamFromSource, findChatGPTShareContainer
};})();'''

with sync_playwright() as p:
    import os
    from pathlib import Path as P
    chrome = os.environ.get('CHATFOLIO_CHROMIUM')
    launch = {'headless':True, 'args':['--no-sandbox','--disable-dev-shm-usage']}
    if chrome and P(chrome).is_file():
        launch['executable_path'] = chrome
    browser = p.chromium.launch(**launch)
    page = browser.new_page()
    page.goto('https://chatgpt.com/c/synthetic-id', wait_until='commit') if False else page.set_content('<main><p>Fixture</p></main>')
    page.evaluate('''window.chrome={runtime:{getManifest:()=>({version:'1.8.11'}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}''')
    page.add_script_tag(content=source)
    actual = page.evaluate('''() => {
      const api=window.__cfMetadataTest;
      const context=api.getChatGPTConversationContext('https://chatgpt.com/c/id-42?temporary-chat=true');
      const mapping={a:{id:'a',parent:null,children:['b','c']},b:{id:'b',parent:'a',children:[]},c:{id:'c',parent:'a',children:[]}};
      const branch=api.collectChatGPTBranch({mapping,current_node:'c'}).map(n=>n.id);
      const share=api.orderChatGPTShareNodes({mapping}).map(n=>n.id);
      const raw=[{linear_conversation:1},[2],{id:3},'message'];
      const encoded=JSON.stringify(JSON.stringify(raw));
      const hydrated=api.decodeChatGPTTurboStreamFromSource(`window.__reactRouterContext.streamController.enqueue(${encoded});`);
      return {context,branch,share,messages:api.findChatGPTShareContainer(hydrated).linear_conversation.map(m=>m.id)};
    }''')
    assert actual['context']['isTemporary'] is True
    assert actual['context']['conversationId'] == 'id-42'
    assert actual['branch'] == ['a','c'], actual
    assert actual['share'] == ['a','b'], actual
    assert actual['messages'] == ['message'], actual
    print(json.dumps({'passed':True,'browser':'Chromium','checks':['route','branch','share-order','React Router hydration']}))
    browser.close()
