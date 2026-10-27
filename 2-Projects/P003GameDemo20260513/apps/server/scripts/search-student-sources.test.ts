import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchExecutor } from '../src/tools/search-executor.js';
import { p2AcceptsSource } from '../src/tools/search-source-scope.js';

const oldDomains = ['weather.com.cn','gov.cn','people.com.cn','xinhuanet.com','cas.cn','cctv.com','chnmuseum.cn','dpm.org.cn'];
const sse = (delta: object, finish_reason: string) => new Response('data: ' + JSON.stringify({choices:[{index:0,delta,finish_reason}]}) + '\n\ndata: [DONE]\n\n');

async function request(query: string, domains: string[], tools = true) {
  let actual = '';
  let plans = 0;
  const executor = new SearchExecutor({ apiKey:'synthetic', domains, tools,
    fetch: (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/search')) { actual=body.query; return Response.json({results:[]}); }
      assert.ok(body.tools, 'empty search evidence must not invoke answer generation');
      if (plans++) return sse({content:''}, 'stop');
      return sse({tool_calls:[{index:0,id:'search',type:'function',function:{name:'search_web',arguments:JSON.stringify({query})}}]}, 'tool_calls');
    }) as typeof fetch });
  await executor.run(query, AbortSignal.timeout(2000), '');
  return actual;
}

test('P2 gives the configured game publisher a search scope instead of unrelated weather sites', async () => {
  const query='查一下《我的世界》基岩版红石中继器的玩法';
  assert.equal(await request(query,[...oldDomains,'minecraft.net','mc.163.com']), query+' site:minecraft.net');
  const china='查一下《我的世界》中国版的游戏更新';
  assert.equal(await request(china,[...oldDomains,'minecraft.net','mc.163.com']), china+' site:mc.163.com');
});

test('P2 searches approved animation and sports authorities', async () => {
  const anime='查宝可梦地平线的官方角色介绍';
  assert.equal(await request(anime,[...oldDomains,'pokemon.cn','pokemon.com.cn']),anime+' site:pokemon.cn OR site:pokemon.com.cn');
  const sport='查羽毛球双打官方完整规则';
  assert.equal(await request(sport,[...oldDomains,'bwf.sport','bwfbadminton.com']),sport+' site:bwf.sport OR site:bwfbadminton.com');
});

test('ordinary sports questions may use approved reference sources while official-only questions retain publisher scope',async()=>{
  const domains=['bwf.sport','baike.baidu.com','kepuchina.cn'];
  const ordinary='帮我查一下羽毛球双打发球的底线在哪';
  assert.equal(await request(ordinary,domains),ordinary+' site:bwf.sport OR site:kepuchina.cn OR site:baike.baidu.com');
  const official='帮我查一下羽毛球官方双打发球规则';
  assert.equal(await request(official,domains),official+' site:bwf.sport');
});

test('P2 never drops late configured sites just because the full site clause exceeds the query budget', async () => {
  const query='查一份关于深海发光动物为什么会发光以及光对它们有什么作用的公开资料';
  const scoped=await request(query,oldDomains);assert.match(scoped,/site:/);assert.ok([...scoped].length<=128);
});

test('source hints cannot expand the allowed domains and P1 keeps its existing scope', async () => {
  const query='查宝可梦地平线的官方角色介绍';
  assert.equal(await request(query,['example.org']),query+' site:example.org');
  assert.equal(await request(query,['example.org','pokemon.cn'],false),query+' site:example.org OR site:pokemon.cn');
});

test('regular badminton does not inherit a derivative sport rule and public feature requests are not release facts',()=>{
  assert.equal(p2AcceptsSource('查羽毛球双打发球边界','https://development.bwfbadminton.com/airbadminton/how-to-play','户外羽毛球指南'),false);
  assert.equal(p2AcceptsSource('查户外羽毛球发球规则','https://development.bwfbadminton.com/airbadminton/how-to-play','户外羽毛球指南'),true);
  assert.equal(p2AcceptsSource('查羽毛球双打发球边界','https://www.olympics.com/en/news/badminton-service-rules','Badminton service rules'),true);
  assert.equal(p2AcceptsSource('查我的世界基岩版红石玩法','https://feedback.minecraft.net/hc/en-us/community/posts/1234','New game ideas'),false);
  assert.equal(p2AcceptsSource('查我的世界基岩版更新','https://feedback.minecraft.net/hc/en-us/articles/1234','Release changelog'),true);
});
