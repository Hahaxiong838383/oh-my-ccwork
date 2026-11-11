/** Bounded personal-test reader. Public HTML is data, never executable code or prompt instructions. */
import {z} from 'zod';
import type {WeatherFacts} from './weather-advice.js';
import {resolveWeatherPlace,type WeatherPlace} from './weather-places.js';
import type {SearchResult} from './search-tasks.js';
export const placeWeatherSchema=z.object({place:z.string().regex(/^[\u4e00-\u9fff]{1,40}$/),day_offset:z.number().int().min(0).max(2),metric:z.enum(['forecast','current','aqi'])}).strict().refine(v=>v.metric==='forecast'||v.day_offset===0);
export type PlaceWeatherRequest=z.infer<typeof placeWeatherSchema>;
export type BaiduWeatherEvidence={provider:'baidu-public-web';city_name:string;station_id:string;province:string;target_date:string;updated_at:string;fetched_at:string;cache_hit:boolean;metric:string};
type Result=SearchResult & {weather:BaiduWeatherEvidence;weather_facts:WeatherFacts};
const fail=(code:string):never=>{throw new Error('weather_'+code);};
const day=(ms:number)=>new Date(ms+28_800_000).toISOString().slice(0,10);
const temp=(v:unknown)=>typeof v==='string'&&/^-?\d{1,2}$/.test(v)&&Number(v)>=-70&&Number(v)<=60?Number(v):fail('temperature');
const words=(v:unknown)=>typeof v==='string'&&/^[\u4e00-\u9fff]{1,12}$/.test(v)?v:fail('wording');
function decode(html:string):any {
 const match=/window\.tplData\s*=\s*\{/.exec(html);if(!match)return fail('payload');
 const start=match.index+match[0].length-1;let depth=0,quoted=false,escaped=false;
 for(let i=start;i<html.length;i++){
  const c=html[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(html.slice(start,i+1));}catch{return fail('payload');}}
 }return fail('payload');
}
function parse(data:any,q:PlaceWeatherRequest,p:WeatherPlace,now:number,requestedAt:number,query=p.query):Result {
 const loc=data?.['24_hour_forecast']?.loc;
 if(data?.position?.country!=='中国'||data?.position?.city!==p.name||typeof loc!=='string'||!new RegExp('^https?://moji\\.com/'+p.station+'/?$').test(loc))return fail('city_mismatch');
 const stamp=data?.weather?.update_time;
 if(data?.weather?.site!=='moji'||data?.base?.date!==day(now)||typeof stamp!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp))return fail('timestamp');
 const updated=stamp.replace(' ','T')+':00+08:00',ms=Date.parse(updated);
 if(!Number.isFinite(ms)||new Date(ms+28_800_000).toISOString().slice(0,16)!==stamp.replace(' ','T')||ms>now+300_000||now-ms>2*3600_000)return fail('stale');
 const target=day((q.metric==='forecast'?requestedAt:now)+q.day_offset*86_400_000);let text:string;let weather_facts:WeatherFacts;
 if(q.metric==='current'){weather_facts={metric:'current',temperature:temp(data.weather.temperature),conditions:[words(data.weather.weather)]};text=`百度天气显示，${p.label}截至${stamp.slice(11)}，${words(data.weather.weather)}，${temp(data.weather.temperature)}摄氏度。`;}
 else {
  const rows=data?.long_day_forecast?.info;if(!Array.isArray(rows))return fail('payload');
  const found=rows.filter((x:any)=>x?.date===target);if(found.length!==1)return fail('target_date');const r=found[0];
  const low=temp(r.temperature_night),high=temp(r.temperature_day);if(low>high)return fail('temperature_range');
  weather_facts={metric:'forecast',low,high,conditions:[words(r.weather_day),words(r.weather_night)]};
  const relative=Math.round((Date.parse(target)-Date.parse(day(now)))/86_400_000);
  text=`百度天气预报，${p.label}${['今天','明天','后天'][relative]??''}${target.slice(5).replace('-','月')}日，白天${words(r.weather_day)}，夜间${words(r.weather_night)}，${low}到${high}摄氏度。预报会变化。`;
 }
 const url='https://weathernew.pae.baidu.com/weathernew/pc?'+new URLSearchParams({query,srcid:'4982',forecast:'long_day_forecast'});
 return {text,weather_facts,sources:[{title:'百度天气 · '+p.label,url,date:updated}],weather:{provider:'baidu-public-web',city_name:p.label,station_id:p.station,province:p.province,target_date:target,updated_at:updated,fetched_at:new Date(now).toISOString(),cache_hit:false,metric:q.metric}};
}
type Flight={controller:AbortController;promise:Promise<Result>;users:number};
export class BaiduWeather {
 private cache=new Map<string,{at:number;data:any;query:string}>();private flights=new Map<string,Flight>();private cooldown=new Map<string,number>();private hits:number[]=[];
 private fetcher:typeof fetch;private now:()=>number;private timeoutMs:number;
 constructor(o:{fetch?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){this.fetcher=o.fetch??fetch;this.now=o.now??Date.now;this.timeoutMs=o.timeoutMs??3000;}
 private async read(query:string,budget:AbortSignal){
  budget.throwIfAborted();this.hits=this.hits.filter(t=>t>this.now()-60_000);if(this.hits.length>=30)return fail('rate_limit');this.hits.push(this.now());
  const url='https://weathernew.pae.baidu.com/weathernew/pc?'+new URLSearchParams({query,srcid:'4982',forecast:'long_day_forecast'});
  const r=await this.fetcher(url,{redirect:'error',signal:budget,headers:{Accept:'text/html','User-Agent':'P003-personal-weather-test/1.0'}});
  if(!r.ok){await r.body?.cancel();return fail('http_'+r.status);}const reader=r.body?.getReader();if(!reader)return fail('empty');
  let size=0;const chunks:Uint8Array[]=[];try{for(;;){budget.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>262144)return fail('body_limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  budget.throwIfAborted();return decode(Buffer.concat(chunks).toString('utf8'));
 }
 async run(raw:PlaceWeatherRequest,signal:AbortSignal,requestedAt=this.now(),context?:{province?:string}):Promise<Result>{
  signal.throwIfAborted();const q=placeWeatherSchema.parse(raw);if(q.metric==='aqi')return fail('metric_unsupported');
  const place=resolveWeatherPlace(q.place,context),now=this.now(),key=JSON.stringify([place.station,q.metric,day((q.metric==='forecast'?requestedAt:now)+q.day_offset*86_400_000)]);
  const cached=this.cache.get(key);if(cached&&now-cached.at<300_000){try{const v=parse(cached.data,q,place,now,requestedAt,cached.query);v.weather.cache_hit=true;v.weather.fetched_at=new Date(cached.at).toISOString();return v;}catch{this.cache.delete(key);}}
  if((this.cooldown.get(key)??0)>now)return fail('cooldown');let f=this.flights.get(key);
  if(!f){
   const controller=new AbortController(),budget=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]);f={controller,users:0,promise:Promise.resolve(null as any)};const flight=f;
   flight.promise=(async()=>{
    let data:any,query=place.query;
    try{data=await this.read(query,budget);}
    catch(e){budget.throwIfAborted();if(!(e instanceof Error)||e.message!=='weather_payload'||place.city===place.name)throw e;query=place.city+place.name+'天气';data=await this.read(query,budget);}
    const result=parse(data,q,place,this.now(),requestedAt,query);this.cache.set(key,{at:this.now(),data,query});if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);return result;
   })().catch(e=>{if(!controller.signal.aborted)this.cooldown.set(key,this.now()+30_000);if(this.cooldown.size>128)this.cooldown.delete(this.cooldown.keys().next().value!);throw e;}).finally(()=>{if(this.flights.get(key)===flight)this.flights.delete(key);});this.flights.set(key,flight);
  }
  const flight=f;flight.users++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(e:unknown,v?:Result)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);if(--flight.users===0)flight.controller.abort();e?reject(e):resolve(structuredClone(v!));};const abort=()=>finish(signal.reason??new Error('aborted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();flight.promise.then(v=>finish(null,v),e=>finish(e));});
 }
}
