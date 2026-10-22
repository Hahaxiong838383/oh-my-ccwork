import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const phrase=z.string().min(1).refine(s=>s.trim()===s&&[...s].length<=32&&!/[\x00-\x1f\x7f]/.test(s));
export const routingConfigSchema=z.object({schema:z.literal(1),weather_enabled:z.boolean(),auto_location_enabled:z.boolean().optional(),baidu_weather_enabled:z.boolean().optional(),rules:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),enabled:z.boolean(),priority:z.number().int().min(0).max(1000),action:z.enum(['search','weather','chat']),mode:z.enum(['prefix','contains_any','contains_all']),triggers:z.array(phrase).min(1).max(32),exclude:z.array(phrase).max(32)}).strict()).max(32)}).strict().refine(c=>new Set(c.rules.map(r=>r.id)).size===c.rules.length);
export type RoutingConfig=z.infer<typeof routingConfigSchema>;
export const defaultRoutingConfig=():RoutingConfig=>routingConfigSchema.parse(JSON.parse(readFileSync(new URL('./search-routing-defaults.json',import.meta.url),'utf8')));
export type RouteUtterance={text:string;at_ms:number;reset?:boolean};
/** Fixed executable; stdin only. Never accept a command, path or argument from HTTP. */
export function previewRouting(config:RoutingConfig,utterances:RouteUtterance[],executable:string):Promise<any> {
 const input=JSON.stringify({config:routingConfigSchema.parse(config),utterances});
 if(Buffer.byteLength(input)>65536||utterances.length>64) return Promise.reject(new Error('preview_too_large'));
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,[],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'},windowsHide:true});let out='',size=0,done=false;
  const finish=(e?:Error,v?:unknown)=>{if(done)return;done=true;clearTimeout(timer);child.kill();e?reject(e):resolve(v);};
  const timer=setTimeout(()=>finish(new Error('preview_timeout')),1500);
  child.on('error',()=>finish(new Error('preview_unavailable')));child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{size+=b.length;if(size>65536)finish(new Error('preview_too_large'));else out+=b.toString();});
  child.stderr.resume();child.on('close',code=>{try{const v=JSON.parse(out);if(code!==0||v.ok!==true||!Array.isArray(v.decisions))throw new Error();finish(undefined,v);}catch{finish(new Error('preview_failed'));}});
  child.stdin.end(input);
 });
}
export const ROUTING_REGRESSION=[
 ['今天北京的天气','search'],['明天上海会下雨吗','search'],['天气','clarify_city'],['帮我查一下','clarify'],
 ['帮我查恐龙灭绝的原因','search'],['帮我查故宫明天开放吗','search'],['帮我查今天汇率','search'],['取消搜索','cancel'],['改查上海天气','replace'],['继续刚才的搜索结果','resume'],
 ['我今天画了一只猫','chat'],['天气为什么会变化','chat'],['我今天心情像阴天','chat'],['不要查北京天气','chat'],['他说查北京天气','chat'],['如果北京下雨怎么办','chat'],['查询功能怎么实现','chat'],['帮我查一下天气，不要真的查','chat'],['讲个故事','chat'],['我今天看了最新新闻','chat'],
] as const;
export async function validateRoutingRegression(config:RoutingConfig,preview:(c:RoutingConfig,u:RouteUtterance[])=>Promise<any>) {
 const result=await preview(config,ROUTING_REGRESSION.map(([text],i)=>({text,at_ms:i*20000,reset:true})));
 const failures=ROUTING_REGRESSION.flatMap(([text,baseline],i)=>{const expected=text==='天气'&&config.weather_enabled&&config.auto_location_enabled?'search':baseline;return result.decisions[i]?.action===expected?[]:[{text,expected,actual:result.decisions[i]?.action??'missing'}];});
 return {passed:failures.length===0,total:ROUTING_REGRESSION.length,failures};
}
