import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTTransport } from '../../src/providers/chatgpt/transport.js';

function fixture(fetchImpl, extra = {}) {
  return createChatGPTTransport({
    fetchImpl,
    getOrigin: () => 'https://chatgpt.com',
    getChatGPTAccountId: (auth) => auth.account || '',
    chatGPTAssetPointerInfo: (part) => part.pointerInfo,
    parsePublicShare: (html) => html.includes('VALID_SHARE') ? { title: 'public' } : null,
    makeCancelledError: () => Object.assign(new Error('Stopped'), { name: 'AbortError' }),
    ...extra,
  });
}
const json = (data, status = 200, options = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...options.headers }, ...options,
});

test('required session and conversation request preserve project/account and target-route headers', async () => {
  const calls=[];
  const transport=fixture(async(url, init)=>{
    calls.push({url,init});
    return url === '/api/auth/session'
      ? json({ accessToken: 'sensitive-token', account: 'acct-1' })
      : json({ mapping: {}, title: 'conversation' });
  });
  const ctrl = new AbortController();
  const { accessToken, accountId }=await transport.getRequiredAuth(ctrl.signal);
  const result=await transport.getConversation({conversationId:'id /42',projectId:'proj-1'},accessToken,accountId,ctrl.signal);
  assert.equal(result.conversation.title,'conversation');
  assert.deepEqual(calls.map(c=>c.url),['/api/auth/session','/backend-api/conversation/id%20%2F42']);
  assert.equal(calls[1].init.headers.Authorization,'Bearer sensitive-token');
  assert.equal(calls[1].init.headers['ChatGPT-Account-ID'],'acct-1');
  assert.equal(calls[1].init.headers['chatgpt-project-id'],'proj-1');
  assert.equal(calls[1].init.headers['X-OpenAI-Target-Path'],calls[1].url);
  assert.equal(calls[1].init.headers['X-OpenAI-Target-Route'],'/backend-api/conversation/{conversation_id}');
  assert.equal(calls[1].init.credentials,'include');
  assert.strictEqual(calls[0].init.signal,ctrl.signal);
  assert.strictEqual(calls[1].init.signal,ctrl.signal);
  assert.equal(transport.getConversation.constructor.name,'AsyncFunction');
});

test('required authentication fails explicitly on missing token or account', async () => {
  for (const auth of [{},{accessToken:'token'}]) {
    const t=fixture(async()=>json(auth));
    await assert.rejects(t.getRequiredAuth(),/token|account metadata/);
  }
  await assert.rejects(fixture(async()=>json({},401)).getRequiredAuth(),/HTTP 401/);
});

test('optional auth failures degrade gracefully; abort still propagates', async () => {
  const optional=fixture(async()=>json({},403));
  assert.deepEqual(await optional.getOptionalAuthHeaders(),{});
  const partial=fixture(async()=>json({accessToken:'t',account:'a'}));
  assert.deepEqual(await partial.getOptionalAuthHeaders(),{Authorization:'Bearer t','ChatGPT-Account-ID':'a'});
  const ctrl=new AbortController();ctrl.abort();
  const cancelled=fixture(async()=>{throw new DOMException('aborted','AbortError')});
  await assert.rejects(cancelled.getOptionalAuthHeaders(ctrl.signal),/Stopped/);
});

test('public share loaded-document path requires zero requests', async () => {
  const t=fixture(async()=>{throw new Error('network must not be used')});
  assert.deepEqual(await t.getPublicShare(null,()=>({messages:['loaded']}),'https://chatgpt.com/share/x'),{messages:['loaded']});
});

test('public share falls back from anonymous to signed-in with original GET flags', async () => {
  const calls=[];
  const t=fixture(async(url,init)=>{
    calls.push({url,init});
    if(init.credentials==='omit')return new Response('empty shell',{status:200});
    return new Response('VALID_SHARE',{status:200});
  });
  const value=await t.getPublicShare(null,()=>null,'https://chatgpt.com/share/123');
  assert.equal(value.title,'public');
  assert.deepEqual(calls.map(x=>x.init.credentials),['omit','include']);
  assert.deepEqual(calls.map(x=>x.url),['https://chatgpt.com/share/123','https://chatgpt.com/share/123']);
  for(const call of calls){assert.equal(call.init.headers.Accept,'text/html,application/xhtml+xml');assert.equal(call.init.cache,'no-store')}
});

test('public share failure reports attempts, and abort stops retries', async () => {
  const t=fixture(async()=>json({},403));
  await assert.rejects(t.getPublicShare(null,()=>null,'https://chatgpt.com/share/x'),/anonymous public page HTTP 403.*signed-in public page HTTP 403/);
  const ctrl = new AbortController();
  const requests=[];
  const aborting=fixture(async(url,opts)=>{requests.push(opts.credentials);ctrl.abort();throw new Error('cancelled')});
  await assert.rejects(aborting.getPublicShare(ctrl.signal,()=>null,'https://chatgpt.com/share/x'),/Stopped/);
  assert.deepEqual(requests,['omit']);
});

test('legacy JSON share retains optional auth and reports HTTP errors', async () => {
  let target;
  const t=fixture(async(url,opts)=>{target={url,opts};return json({share:'okay'})});
  assert.deepEqual(await t.getLegacyShare('a/b',{Authorization:'Bearer xyz'},null),{share:'okay'});
  assert.equal(target.url,'/backend-api/share/a%2Fb');
  assert.equal(target.opts.headers.Authorization,'Bearer xyz');
  assert.equal(target.opts.credentials,'include');
  try { await fixture(async()=>json({},404)).getLegacyShare('xx',{},null);assert.fail('expected failure') }
  catch(error){assert.equal(error.status,404);assert.match(error.message,/HTTP 404/)}
});

test('asset download uses shared URL first and caches resolved result', async () => {
  const urls=[];
  const t=fixture(async(url,opts)=>{urls.push({url,opts});return json({download_url:'https://files.example.test/image.png'})});
  const ctrl=new AbortController();
  const part={pointerInfo:{kind:'file-service',fileId:'space /x'}};
  const context={shareId:'share id',conversationId:'chat'};
  assert.equal(await t.requestAssetDownloadUrl(part,context,{Authorization:'Bearer p'},ctrl.signal),'https://files.example.test/image.png');
  assert.equal(await t.requestAssetDownloadUrl(part,context,{Authorization:'Bearer p'},ctrl.signal),'https://files.example.test/image.png');
  assert.equal(urls.length,1);
  assert.equal(urls[0].url,'/backend-api/files/space%20%2Fx/download?shared_conversation_id=share%20id');
  assert.equal(urls[0].opts.headers.Authorization,'Bearer p');
});

test('asset sediment resolver follows conversation attachment route; direct HTTPS needs no fetch', async()=>{
  const urls=[];
  const t=fixture(async(url)=>{urls.push(url);return json({signed_url:'https://signed.example/file'})});
  const context={conversationId:'a b'};
  assert.equal(await t.requestAssetDownloadUrl({pointerInfo:{kind:'sediment',fileId:'i/j'}},context,{},null),'https://signed.example/file');
  assert.deepEqual(urls,['/backend-api/conversation/a%20b/attachment/i%2Fj/download']);
  assert.equal(await t.requestAssetDownloadUrl({pointerInfo:{kind:'url',fileId:'',value:'https://images.example/a'}},context,{},null),'https://images.example/a');
  assert.equal(urls.length,1);
});

test('asset lookup tries candidate endpoints in order and remembers redirects', async()=>{
  const urls=[];
  const t=fixture(async (url)=>{
    urls.push(url);
    if(url.includes('/files/download/'))return json({},404);
    return new Response('', {status:200,headers:{'content-type':'image/png'}});
  });
  assert.equal(await t.requestAssetDownloadUrl({pointerInfo:{kind:'file-service',fileId:'id'}},{conversationId:'c'}, {}, null),'');
  assert.deepEqual(urls,['/backend-api/files/download/id?conversation_id=c&inline=true','/backend-api/files/id/download']);
});

test('cancellation clears pending asset resolution; failed fetch does not leak token to URL', async()=>{
  const ctrl=new AbortController(); const urls=[];
  const t=fixture(async(url)=>{urls.push(url);ctrl.abort();throw new Error('aborted')});
  const p={pointerInfo:{kind:'file-service',fileId:'id'}};
  await assert.rejects(t.requestAssetDownloadUrl(p,{conversationId:'abc'},{Authorization:'Bearer SECRET'},ctrl.signal),/Stopped/);
  assert.equal(urls.length,1);
  assert.ok(urls.every(url=>!url.includes('SECRET')));
});
