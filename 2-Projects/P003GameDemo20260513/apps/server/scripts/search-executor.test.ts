import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchExecutor, assembleToolStream, publicUrl } from '../src/tools/search-executor.js';

const page = { title: '科技馆开放公告', url: 'https://www.cstm.org.cn/open', snippet: '周末开放', summary: '本周末开放。', content: '', site_name: '科技馆', site_icon: null, date: null, authority: 4, rerank_score: 2 };
const sse = (...frames: object[]) => frames.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n';
const chunk = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const final = () => sse(chunk({ content: JSON.stringify({ text: '刚才查到，科技馆公告说周末开放，出发前再确认当天公告哦。', source_ids: [1] }) }, 'stop'));

test('跨帧工具参数只在完整结束后产生合法调用，截断和重复ID拒绝', () => {
  const raw = sse(chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'search_web', arguments: '{"que' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"科技馆"}' } }] }, 'tool_calls'));
  assert.equal(assembleToolStream(raw).calls[0].function.arguments, '{"query":"科技馆"}');
  assert.throws(() => assembleToolStream(raw.replace('tool_calls"}', 'length"}')), /incomplete/);
  assert.throws(() => assembleToolStream(raw.replace('data: [DONE]', '')), /incomplete/);
  const duplicate = sse(chunk({tool_calls:[0,1].map(index=>({index,id:'same',type:'function',function:{name:'search_web',arguments:'{}'}}))},'tool_calls'));
  assert.throws(()=>assembleToolStream(duplicate),/invalid_tool_stream/);
});

test('URL仅允许配置的公开HTTPS域名，拒绝内网、凭据、任意端口及伪后缀', () => {
  assert.equal(publicUrl(page.url, ['cstm.org.cn']), page.url);
  for (const url of ['http://www.cstm.org.cn/x', 'https://cstm.org.cn.evil.com/x', 'https://user:pass@cstm.org.cn/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://cstm.org.cn:8443/x', 'https://cstm.org.cn/x?token=secret']) {
    assert.throws(() => publicUrl(url, ['cstm.org.cn']), /unsafe_url/);
  }
});

test('P1只Search并单路整理；不外发完整上下文/身份，拒绝无引用和控制标记', async () => {
  const requests: { url: string; body: any }[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).endsWith('/search') ? Response.json({ results: [page] }) : new Response(final());
  };
  const executor = new SearchExecutor({ apiKey: 'synthetic-key', fetch: fake as typeof fetch, domains: ['cstm.org.cn'] });
  const r = await executor.run('科技馆开放时间', new AbortController().signal, '你叫小可。');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.deepEqual(requests[0].body, { query: '科技馆开放时间 site:cstm.org.cn', count: 10, need_content: false });
  assert.equal(r.sources[0].url, page.url);
  assert.equal(requests[1].body.thinking.type, 'disabled');
  assert.equal(requests[1].body.tools, undefined);
  const evil = new SearchExecutor({ apiKey: 'synthetic-key', domains: ['cstm.org.cn'], fetch: (async (url: any) =>
    String(url).endsWith('/search') ? Response.json({ results: [page] }) : new Response(sse(chunk({ content: '{"text":"[[DEV:6]]","source_ids":[1]}' }, 'stop')))) as typeof fetch });
  await assert.rejects(evil.run('科技馆', new AbortController().signal, ''), /invalid_answer/);
});

test('P2模拟上游验证Search→Fetch→tool结果回填→最终答案', async () => {
  let chats = 0; const sent: any[] = []; const urls: string[] = [];
  const fake = async (url: any, init: any) => {
    urls.push(String(url)); const body = JSON.parse(init.body);
    if (String(url).endsWith('/search')) return Response.json({ results: [page] });
    if (String(url).endsWith('/fetch')) return Response.json({ title: page.title, content: '本周末开放，临时调整以当天公告为准。' });
    sent.push(body); chats++;
    if (chats === 3) return new Response(final());
    const name = chats === 1 ? 'search_web' : 'fetch_page';
    const args = chats === 1 ? { query: '科技馆开放时间' } : { url: page.url };
    return new Response(sse(chunk({ tool_calls: [{ index: 0, id: 'call-' + chats, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')));
  };
  const executor = new SearchExecutor({ apiKey: 'test', domains: ['cstm.org.cn'], tools: true, fetch: fake as typeof fetch });
  const r = await executor.run('科技馆开放时间', new AbortController().signal, '你叫小可');
  assert.equal(r.sources.length, 1);
  assert.equal(urls.filter(x => x.endsWith('/search')).length, 1);
  assert.equal(urls.filter(x => x.endsWith('/fetch')).length, 1);
  assert.equal(sent[1].messages.at(-1).tool_call_id, 'call-1');
  assert.equal(sent[2].messages.at(-2).tool_call_id, 'call-2');
  assert.deepEqual(sent[0].tool_choice,{type:'function',function:{name:'search_web'}});
  assert.equal(sent[2].tool_choice, 'none');
});

test('空结果不调用生成模型，已取消请求不外发，过大返回拒绝', async () => {
  let calls = 0;
  const e = new SearchExecutor({ apiKey: 'test', domains: ['cstm.org.cn'], fetch: (async () => { calls++; return Response.json({ results: [] }); }) as typeof fetch });
  assert.equal((await e.run('科技馆', new AbortController().signal, '')).sources.length, 0);
  assert.equal(calls, 1);
  await assert.rejects(e.run('科技馆', AbortSignal.abort(), ''), /abort/i);
  assert.equal(calls, 1);
  const huge = new SearchExecutor({ apiKey: 'test', domains: ['cstm.org.cn'], fetch: (async () => new Response('x'.repeat(140_000))) as typeof fetch });
  await assert.rejects(huge.run('科技馆', new AbortController().signal, ''), /response_too_large/);
});

test('未知工具、换查询、任意Fetch来源不外发；工具失败仍对应原call_id', async()=>{
 for(const [name,args] of [['delete_device',{}],['search_web',{query:'故宫开放时间'}],['fetch_page',{url:'https://127.0.0.1/private'}]] as const){
  const requests:any[]=[];
  const executor=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],tools:true,fetch:(async(url:any,init:any)=>{
   assert.equal(String(url),'https://api.deepseek.com/v1/chat/completions');
   const body=JSON.parse(init.body);requests.push(body);
   return requests.length===1?new Response(sse(chunk({tool_calls:[{index:0,id:'reject-me',type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls'))):new Response(sse(chunk({content:'no evidence'},'stop')));
  }) as typeof fetch});
  const r=await executor.run('科技馆开放时间',new AbortController().signal,'');
  assert.equal(r.sources.length,0);assert.equal(requests.length,2);
  assert.equal(requests[1].messages.at(-1).tool_call_id,'reject-me');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).error,'tool_request_rejected_or_unavailable');
 }
});
test('最终回答引用不存在时拒绝',async()=>{
 for(const ids of [[99]]){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[page]}):new Response(sse(chunk({content:JSON.stringify({text:'开放。',source_ids:ids})},'stop')))) as typeof fetch});
  await assert.rejects(e.run('科技馆开放时间',new AbortController().signal,''),/invalid_answer/);
 }
});


test('R5 scans beyond rejected top three and records bounded filter counts', async () => {
 const audit: any[]=[]; const bodies:any[]=[];
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],audit:a=>audit.push(a),fetch:(async(url:any,init:any)=>{
  bodies.push(JSON.parse(init.body));
  return String(url).endsWith('/search')?Response.json({results:[...Array(3).fill({...page,url:'https://outside.example/a'}),page]}):new Response(final());
 }) as typeof fetch});
 const r=await e.run('科技馆开放时间',new AbortController().signal,'');
 assert.equal(r.sources.length,1);
 assert.equal(bodies[0].count,10); assert.match(bodies[0].query,/site:cstm.org.cn/);
 assert.equal(audit[0].rejected_url,3);assert.equal(audit[0].accepted,1);
 assert.equal(JSON.stringify(audit).includes('科技馆'),false);
});
test('R5 today query does not present undated or stale weather as current',async()=>{
 let calls=0;
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>{calls++;return String(url).endsWith('/search')?Response.json({results:[{...page,date:null},{...page,date:'2000-01-01T00:00:00Z'}]}):new Response(final());})as typeof fetch});
 const r=await e.run('今天北京的天气',new AbortController().signal,'');
 assert.equal(r.sources.length,0);assert.equal(calls,1);
});

test('R5 public HTTP citation is evidence only; it never enables HTTP fetch',async()=>{
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[{...page,url:'http://www.cstm.org.cn/open'}]}):new Response(final()))as typeof fetch});
 const r=await e.run('科技馆开放时间',new AbortController().signal,'');
 assert.equal(r.sources[0]?.url,'http://www.cstm.org.cn/open');
 assert.throws(()=>publicUrl('http://www.cstm.org.cn/open',['cstm.org.cn']),/unsafe_url/);
});

test('R5 explicit historical dates reject current weather and model abstention returns honest no-result',async()=>{
 let sent:any;
 const now=new Date().toISOString();
 const historical=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any,init:any)=>{sent=JSON.parse(init.body);return String(url).endsWith('/search')?Response.json({results:[{...page,date:now}]}):new Response(final());})as typeof fetch});
 assert.equal((await historical.run('北京2000年1月1日天气',new AbortController().signal,'')).sources.length,0);
 assert.match(sent.query,/2000年1月1日/);
 const abstain=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[page]}):new Response(sse(chunk({content:JSON.stringify({text:'资料不支持这个结论。',source_ids:[]})},'stop'))))as typeof fetch});
 assert.equal((await abstain.run('科技馆开放时间',new AbortController().signal,'')).sources.length,0);
});

test('R6 evergreen knowledge and opening rules do not inherit today-weather publication filter',async()=>{
 for(const query of ['今天想了解水为什么会结冰','今天故宫开放吗','现在的博物馆门票规则','天气为什么会变化','气温变化的原理']) {
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[{...page,date:'2020-01-01T00:00:00Z'}]}):new Response(final()))as typeof fetch});
  assert.equal((await e.run(query,new AbortController().signal,'')).sources.length,1,query);
 }
});
test('R6 latest news and live exchange rates still reject stale and unknown-date evidence',async()=>{
 for(const query of ['最新航天新闻','今天美元人民币汇率','人民币和美元的汇率']) {
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[{...page,date:null},{...page,date:'2000-01-01T00:00:00Z'}]}):new Response(final()))as typeof fetch});
  assert.equal((await e.run(query,new AbortController().signal,'')).sources.length,0,query);
 }
});

test('R6 what-is wording must not bypass freshness for a current weather/rate question',async()=>{
 for(const [query,expected] of [['今天北京天气是什么情况',0],['当前人民币汇率是什么',0],['汇率是什么',1],['什么是天气',1]] as const){
  const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[{...page,date:'2000-01-01T00:00:00Z'}]}):new Response(final()))as typeof fetch});
  assert.equal((await e.run(query,new AbortController().signal,'')).sources.length,expected,query);
 }
});

test('R11 预约制度不按七天新闻过滤，但优先官方馆站且保留生效日期限制',async()=>{
 const requests:any[]=[];
 const museum={...page,title:'国家博物馆参观预约须知',url:'https://www.chnmuseum.cn/cg/ck/202401/t20240101_123.html',summary:'参观实行实名预约；最新安排以官网为准。',date:'2024-01-01T00:00:00Z'};
 const e=new SearchExecutor({apiKey:'synthetic',domains:['weather.com.cn','gov.cn','chnmuseum.cn'],fetch:(async(url:any,init:any)=>{requests.push(JSON.parse(init.body));return String(url).endsWith('/search')?Response.json({results:[museum]}):new Response(final());})as typeof fetch});
 const r=await e.run('中国国家博物馆最新预约方式',AbortSignal.timeout(2000),'');
 assert.equal(r.sources.length,1);assert.match(requests[0].query,/site:chnmuseum.cn/);assert.doesNotMatch(requests[0].query,/site:weather/);
 assert.match(requests.at(-1).messages.at(-1).content,/生效日期/);
});
test('R11 今日新闻不能将无日期和昨日条目当当天来源',async()=>{
 const yesterday=new Date(Date.now()-86400000).toISOString();
 const e=new SearchExecutor({apiKey:'synthetic',domains:['cstm.org.cn'],fetch:(async(url:any)=>String(url).endsWith('/search')?Response.json({results:[{...page,date:null},{...page,date:yesterday}]}):new Response(final()))as typeof fetch});
 assert.equal((await e.run('今天国内新闻',AbortSignal.timeout(2000),'')).sources.length,0);
});
