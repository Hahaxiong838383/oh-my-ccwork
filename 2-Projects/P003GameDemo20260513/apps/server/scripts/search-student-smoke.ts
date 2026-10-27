/** Opt-in, sequential real-provider check using synthetic public questions only.
 * Run in an isolated source copy; it does not create rooms or business tasks.
 * Private result files contain public provider excerpts for manual fact review.
 * Exit zero means the batch ran, NOT that the answers passed content review. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SearchExecutor, type ToolAudit, type SearchValidationAudit } from '../src/tools/search-executor.js';

if (process.env.SEARCH_STUDENT_SMOKE !== '1') throw Error('explicit_smoke_opt_in_required');
const output = process.env.SEARCH_STUDENT_SMOKE_OUTPUT;
if (!output || !process.env.DEEPSEEK_API_KEY || !process.env.SEARCH_ALLOWED_DOMAINS) throw Error('missing_smoke_configuration');
mkdirSync(output, { recursive: false, mode: 0o700 });
const cases = [
  ['game','查一下我的世界基岩版最新正式更新有哪些新玩法'],
  ['anime','读取宝可梦官网动画介绍，查地平线的两位主角是谁，别剧透'],
  ['sport','读取羽毛球官方规则，查双打发球和打起来以后边界有什么区别'],
  ['music','查一下动画电影大鱼海棠主题曲大鱼是谁唱的'],
  ['animal','查一下猫为什么会发出呼噜声'],
  ['space','查一下最近中国航天有什么新进展'],
  ['game_mechanism','读取我的世界基岩版官网介绍，查红石中继器有什么用'],
  ['sport_natural','帮我查一下羽毛球双打发球的底线在哪'],
  ['game_natural','帮我查一下我的世界基岩版红石中继器有什么用'],
  ['r20_redstone','我的世界里红石中继器主要有什么用'],
  ['r20_music','大鱼海棠里大鱼是谁唱的'],
  ['r20_sport','羽毛球双打发球后面的线到底算哪个'],
  ['r20_sport_asr','毛球双打发球后面的线到底算哪一步'],
  ['r20_space','最近中国航天新闻'],
  ['r20_dinosaur','恐龙为什么会灭绝'],
] as const;
const selection = process.env.SEARCH_STUDENT_SMOKE_CASES?.split(',');
if(selection?.some(id=>!cases.some(([name])=>name===id)))throw Error('unknown_smoke_case');
const rows: object[] = [];
for (const [id,query] of cases.filter(([id])=>!selection||selection.includes(id))) {
  const events: ToolAudit[] = [], validation: SearchValidationAudit[] = [], calls: object[] = [];
  const started = Date.now();
  const executor = new SearchExecutor({
    apiKey: process.env.DEEPSEEK_API_KEY, domains: process.env.SEARCH_ALLOWED_DOMAINS.split(','),
    tools: true, grounding: true,
    toolAudit: e => events.push(e), validationAudit: e => validation.push(e),
    fetch: async (url,init) => {
      const response = await fetch(url,init);
      if(process.env.SEARCH_STUDENT_SMOKE_CAPTURE==='1'){
        const file=join(output,`${id}-frames.jsonl`);
        const {appendFileSync}=await import('node:fs');
        appendFileSync(file,JSON.stringify({path:new URL(String(url)).pathname,request:init?.body?JSON.parse(String(init.body)):null,status:response.status,raw:await response.clone().text()})+'\n',{mode:0o600});
      }
      if (String(url).endsWith('/search')) {
        const body = JSON.parse(String(init?.body));
        const result = await response.clone().json() as any;
        calls.push({path:'search',query:body.query,status:response.status,
          results:(result.results??[]).map((r:any)=>({url:r.url,title:r.title,date:r.date}))});
      } else if (String(url).endsWith('/fetch')) {
        calls.push({path:'fetch',url:JSON.parse(String(init?.body)).url,status:response.status});
      }
      return response;
    },
  });
  try {
    const result = await executor.run(query, AbortSignal.timeout(22_000), '你是小可，和小学高年级及初中生平等、自然地交流。');
    rows.push({id,query,ok:true,result,events,validation,calls,ms:Date.now()-started});
  } catch (error: any) {
    rows.push({id,query,ok:false,failure:error.failure??{stage:'unknown',reason:'unknown'},events,validation,calls,ms:Date.now()-started});
  }
  writeFileSync(join(output,'results.json'),JSON.stringify(rows,null,2),{mode:0o600});
}
writeFileSync(join(output,'terminal.json'),JSON.stringify({done:true,count:rows.length,content_review:'required'}),{mode:0o600});
console.log(JSON.stringify({done:true,count:rows.length,content_review:'required'}));
