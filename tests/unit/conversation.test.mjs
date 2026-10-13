import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_SCHEMA_VERSION, ContractError, createConversation, createMessage,
  fromLegacyConversation, toLegacyMessages,
} from '../../src/core/index.js';

const legacyMessages = [
  {key:'chatgpt:user:id:100',role:'user',html:'<p dir="rtl">سلام</p><img src="data:image/png;base64,AA==">',text:'سلام',imageCount:1,turnIndex:0,discoveryOrder:2},
  {key:'chatgpt:assistant:id:101',role:'assistant',html:'<pre><code>x=1</code></pre>',text:'x=1',imageCount:0,turnIndex:Number.NaN,discoveryOrder:3},
];

function assertContractError(fn, code) {
  assert.throws(fn, (err) => err instanceof ContractError && err.code === code);
}

test('ChatGPT legacy export round-trips without losing markup, images or ordering', () => {
  const model = fromLegacyConversation({provider:'chatgpt',title:'فارسی & English',messages:legacyMessages});
  assert.equal(model.schemaVersion,CONVERSATION_SCHEMA_VERSION);
  assert.equal(model.messages[0].source.turnIndex,0);
  assert.equal(model.messages[1].source.turnIndex,null);
  assert.equal(JSON.stringify(model).includes('"turnIndex":null'),true);
  assert.deepEqual(toLegacyMessages(model), legacyMessages);
});

test('Gemini/Claude rich user-image HTML survives conversion unchanged', () => {
  for (const provider of ['gemini','claude']) {
    const message = {key:`${provider}:user:abc`,role:'user',html:'<img alt="uploaded" src="data:image/jpeg;base64,abc" />',text:'',imageCount:1,turnIndex:Number.NaN,discoveryOrder:0};
    const restored = toLegacyMessages(fromLegacyConversation({provider,title:'Image',messages:[message]}));
    assert.deepEqual(restored,[message]);
  }
});

test('Legacy message keys may be absent, but are made stable within this snapshot', () => {
  const c=fromLegacyConversation({provider:'claude',title:'Untitled',messages:[{role:'user',html:'<p>Hi</p>',text:'Hi',imageCount:0}]});
  assert.equal(c.messages[0].id,'claude:fallback:0');
  assert.equal(toLegacyMessages(c)[0].key,'claude:fallback:0');
});

test('Duplicate IDs are rejected instead of dropping or merging turns', () => {
  assertContractError(() => fromLegacyConversation({provider:'gemini',title:'t',messages:[
    {key:'same',role:'user',html:'a',text:'a',imageCount:0},
    {key:'same',role:'assistant',html:'b',text:'b',imageCount:0},
  ]}), 'DUPLICATE_MESSAGE_ID');
});

test('Unknown roles and invalid media counts fail at the boundary', () => {
  assertContractError(() => fromLegacyConversation({provider:'claude',title:'',messages:[{role:'system',html:'x',text:'x'}]}),'MESSAGE_ROLE');
  assertContractError(() => fromLegacyConversation({provider:'claude',title:'',messages:[{role:'user',html:'x',text:'x',imageCount:-1}]}),'IMAGE_COUNT');
  assertContractError(() => fromLegacyConversation({provider:'claude',title:'',messages:[{role:'user',html:null,text:'x'}]}),'LEGACY_CONTENT');
  assertContractError(() => fromLegacyConversation({provider:'claude',title:'',messages:[{role:'user',html:'x',text:'x',turnIndex:1.5}]}),'INVALID_INDEX');
});

test('A canonical conversation cannot silently reorder messages', () => {
  const one=createMessage({id:'1',role:'assistant',order:1,text:'hi',imageCount:0,blocks:[{type:'text',value:'hi'}]});
  assertContractError(()=>createConversation({schemaVersion:1,provider:'chatgpt',title:'t',messages:[one]}),'MESSAGE_ORDER');
});

test('Future typed image and attachment blocks are serializable and rejected by legacy renderer', () => {
  const m=createMessage({id:'m',role:'user',order:0,text:'',imageCount:1,blocks:[
    {type:'image',src:'data:image/png;base64,a',alt:'chart',embedded:true},
    {type:'attachment',name:'data.csv',mimeType:'text/csv',url:null},
  ]});
  const c=createConversation({schemaVersion:1,provider:'gemini',title:'Media',messages:[m]});
  assert.deepEqual(JSON.parse(JSON.stringify(c)),c);
  assertContractError(()=>toLegacyMessages(c),'LEGACY_ONLY');
});

test('Unsupported schemas and providers are rejected',()=>{
  assertContractError(()=>createConversation({schemaVersion:999,provider:'gemini',title:'',messages:[]}), 'SCHEMA_VERSION');
  assertContractError(()=>createConversation({schemaVersion:1,provider:'evil',title:'',messages:[]}), 'PROVIDER');
});
