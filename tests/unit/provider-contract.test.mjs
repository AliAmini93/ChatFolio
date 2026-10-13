import test from 'node:test';
import assert from 'node:assert/strict';
import {detectProvider, getProvider, assertProviderDomAdapter, assertRenderer, ContractError} from '../../src/core/index.js';

const cases = [
  ['chatgpt.com','chatgpt'],['chat.openai.com','chatgpt'],['CLAUDE.AI','claude'],
  ['gemini.google.com.','gemini'],['notchatgpt.com',null],['chatgpt.com.evil.test',null],['www.claude.ai',null],
];

test('Provider host detection uses exact allowlisted hostnames',()=>{
  for (const [host,id] of cases) assert.equal(detectProvider(host)?.id??null,id,host);
  assert.equal(getProvider('unsupported'),null);
  assert.equal(getProvider('claude')?.label,'Claude');
});

test('Provider contracts correspond to the live DOM adapter signature',()=>{
  const fake={getMessageNodes:()=>[],getRole:()=> 'unknown',findTurn:node=>node,getTitle:()=> 'Title',identityMeta:()=>({stableId:'m',turnIndex:Number.NaN})};
  assert.equal(assertProviderDomAdapter(fake),fake);
  assert.throws(()=>assertProviderDomAdapter({...fake,findTurn:null}),e=>e instanceof ContractError&&e.code==='ADAPTER_REQUIRED');
  assert.throws(()=>assertProviderDomAdapter({...fake,orderContainer:5}),e=>e instanceof ContractError&&e.code==='ADAPTER_OPTIONAL');
  assert.throws(()=>assertProviderDomAdapter(null),e=>e instanceof ContractError&&e.code==='ADAPTER_TYPE');
});

test('Renderer contract cannot accidentally depend on a provider DOM API',()=>{
  assert.equal(typeof assertRenderer({render:()=>'<html></html>'}).render,'function');
  assert.throws(()=>assertRenderer({render: null}),e=>e.code==='RENDERER_REQUIRED');
});
