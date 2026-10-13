"""Phase-3 provider DOM adapter browser fixtures, using the bundled runtime.

This test validates the Chrome-consumed content.js, not only the ESM sources.
"""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = (ROOT / 'content.js').read_text(encoding='utf-8')
FIXTURES = [
    (
        'chatgpt',
        '<main><div data-turn-key="turn-stable-001"><div data-user-message-bubble>Question text</div>'
        '<div><div data-conversation-role="assistant">ChatGPT said:</div><p>Answer body</p></div></div></main>',
        ['user', 'assistant'],
    ),
    (
        'claude',
        '<main><div data-test-render-count="1"><div data-testid="user-message">Claude prompt</div></div>'
        '<div data-test-render-count="2"><div class="font-claude-response">Claude response</div></div></main>',
        ['user', 'assistant'],
    ),
    (
        'gemini',
        '<main><div class="conversation-container"><user-query><p>Gemini question</p></user-query>'
        '<model-response><p>Gemini response</p></model-response></div></main>',
        ['user', 'assistant'],
    ),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHATFOLIO_CHROMIUM') or None,
                                args=['--no-sandbox', '--disable-dev-shm-usage'])
    for platform, markup, expected in FIXTURES:
        page = browser.new_page()
        page.set_content(markup)
        page.evaluate('window.chrome={runtime:{getManifest:()=>({version:"1.8.11"}),onMessage:{addListener:()=>{}},sendMessage:async()=>({})}}')
        code = BASE.replace('const PLATFORM = detectPlatform();',
                            f'const PLATFORM = {{id:"{platform}", name:"{platform}", assistantLabel:"{platform}"}};', 1)
        assert code != BASE, 'Could not replace platform selector in generated runtime'
        code = code.rsplit('})();', 1)[0] + '''window.__adapterQA={getMessageNodes,getMessageRole,findTurnElement};})();'''
        page.add_script_tag(content=code)
        output = page.evaluate('''() => {
          const nodes=window.__adapterQA.getMessageNodes();
          return {roles:nodes.map(n=>window.__adapterQA.getMessageRole(n)),
                  boundaries:nodes.map(n=>Boolean(window.__adapterQA.findTurnElement(n)))};
        }''')
        assert output['roles'] == expected, (platform, output)
        assert all(output['boundaries']), (platform, output)
        print(f'PASS {platform}: {output["roles"]}', flush=True)
        page.close()
    browser.close()
