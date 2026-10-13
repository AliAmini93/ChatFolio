import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChatGPTConversationContext,
  decodeJwtPayload,
  getChatGPTAccountId,
  collectChatGPTBranch,
  orderChatGPTShareNodes,
  extractChatGPTTurboChunks,
  decodeChatGPTTurboStreamFromSource,
  findChatGPTShareContainer
} from '../../src/providers/chatgpt/metadata-parser.js';

const payload = value => `window.__reactRouterContext.streamController.enqueue(${JSON.stringify(value)});`;

test('conversation links resolve ordinary, projects, temporary and public shares', () => {
  assert.deepEqual(getChatGPTConversationContext('https://chatgpt.com/c/abc?temporary-chat=true'), {
    conversationId:'abc', projectId:'', shareId:'', isShare:false, isTemporary:true
  });
  assert.deepEqual(getChatGPTConversationContext('https://chatgpt.com/g/g-p-proj/c/abc'), {
    conversationId:'abc', projectId:'g-p-proj', shareId:'', isShare:false, isTemporary:false
  });
  assert.deepEqual(getChatGPTConversationContext('https://chatgpt.com/share/shared'), {
    conversationId:'', projectId:'', shareId:'shared', isShare:true
  });
  assert.equal(getChatGPTConversationContext('https://chatgpt.com/'), null);
  assert.equal(getChatGPTConversationContext('not-a-url'), null);
});

test('JWT decoder safely rejects invalid auth payload', () => {
  assert.equal(decodeJwtPayload('broken'), null);
  assert.equal(decodeJwtPayload('a.###.c'), null);
  const jwt = `h.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'id-42'}})).toString('base64url')}.s`;
  assert.equal(getChatGPTAccountId({},jwt),'id-42');
  assert.equal(getChatGPTAccountId({accountId:'explicit'},jwt),'explicit');
});

test('active branch uses parent chain rather than all siblings', () => {
  const mapping = {
    a:{id:'a',parent:null,children:['b','c'],message:{author:{role:'user'}}},
    b:{id:'b',parent:'a',children:[],message:{author:{role:'assistant'}}},
    c:{id:'c',parent:'a',children:[],message:{author:{role:'assistant'}}}
  };
  assert.deepEqual(collectChatGPTBranch({mapping,current_node:'c'}).map(x=>x.id),['a','c']);
  assert.deepEqual(collectChatGPTBranch({mapping,current_node:'b'}).map(x=>x.id),['a','b']);
  assert.deepEqual(collectChatGPTBranch({mapping:null}),[]);
});

test('parent cycles terminate without infinite recursion', () => {
  const mapping={a:{id:'a',parent:'b',children:['b']},b:{id:'b',parent:'a',children:['a']}};
  assert.equal(collectChatGPTBranch({mapping,current_node:'a'}).length,2);
});

test('shared conversation honors explicit linear ordering and falls back to mapping', () => {
  const linear=[{message:{id:'u'}},{message:{id:'a'}}];
  assert.equal(orderChatGPTShareNodes({linear_conversation:linear}),linear);
  const mapping={a:{id:'a',parent:null,children:['b']},b:{id:'b',parent:'a',children:[]}};
  assert.deepEqual(orderChatGPTShareNodes({mapping}).map(x=>x.id),['a','b']);
  assert.deepEqual(orderChatGPTShareNodes({}),[]);
});

test('React Router turbo chunks decode JSON escaped payload with whitespace', () => {
  const first=JSON.stringify([{name:1},'test']);
  assert.deepEqual(extractChatGPTTurboChunks(`${payload(first)}\nstreamController.enqueue ( ${JSON.stringify('P2:"more"')} ) ;`),[first,'P2:"more"']);
});

test('turbo-stream positional references and deferred patches decode fully', () => {
  // A small but structurally realistic React Router positional hydration table.
  const initial=[{loaderData:1},{route:2},{serverResponse:3},{data:4},{linear_conversation:5},[6,7],{id:8},['P',7],'message-u'];
  const html=`<script>${payload(JSON.stringify(initial))}${payload('P7:'+JSON.stringify({id:'assistant-2'}))}</script>`;
  const root=decodeChatGPTTurboStreamFromSource(html);
  assert.deepEqual(root,{loaderData:{route:{serverResponse:{data:{linear_conversation:[{id:'message-u'},{id:'assistant-2'}]}}}}});
  assert.deepEqual(findChatGPTShareContainer(root).linear_conversation.map(x=>x.id),['message-u','assistant-2']);
});

test('malformed hydration fails clearly without silently returning empty chat', () => {
  assert.throws(()=>decodeChatGPTTurboStreamFromSource('not a React Router page'),/No ChatGPT public-share/);
  assert.throws(()=>decodeChatGPTTurboStreamFromSource(payload('P10:[]')),/initial reference table/);
});

test('share container discovery navigates nested data, skips unrelated objects and cycles', () => {
  const shared={mapping:{id:{message:{id:'m'}}},current_node:'id'};
  const wrapper={wrapper:{loaderData:{route:{serverResponse:{data:shared}}}}};
  wrapper.circular=wrapper;
  assert.equal(findChatGPTShareContainer(wrapper),shared);
  assert.equal(findChatGPTShareContainer({foo:'bar'}),null);
});
