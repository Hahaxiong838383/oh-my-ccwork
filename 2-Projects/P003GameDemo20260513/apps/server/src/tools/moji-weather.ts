/** Personal-test adapter for public data used by moji.com. Not a contracted API. */
import { z } from 'zod';
import type { SearchResult } from './search-tasks.js';
export const MOJI_CITIES = [{id:2,name:'北京市'},{id:39,name:'上海市'},{id:94,name:'沈阳市'},{id:104,name:'大连市'},{id:886,name:'广州市'},{id:892,name:'深圳市'},{id:1185,name:'杭州市'}] as const;
export const weatherRequestSchema = z.object({city_id:z.number().int(),city_name:z.string(),day_offset:z.number().int().min(0).max(2),metric:z.enum(['forecast','current','aqi'])}).strict().refine(v=>MOJI_CITIES.some(c=>c.id===v.city_id&&c.name===v.city_name)&& (v.metric==='forecast'||v.day_offset===0));
export type WeatherRequest=z.infer<typeof weatherRequestSchema>;
export type WeatherEvidence={provider:'moji-public-web';city_id:number;city_name:string;target_date:string;updated_at:string;fetched_at:string;cache_hit:boolean;metric:string};
export type WeatherResult=SearchResult & {weather:WeatherEvidence};
const day=(ms:number)=>new Date(ms+28_800_000).toISOString().slice(0,10);
const fail=(s:string):never=>{throw new Error(s);};
function time(value:unknown,now:number,maxAge:number):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return fail('weather_timestamp');
  const iso=value.replace(' ','T')+'+08:00',ms=Date.parse(iso);
  if(!Number.isFinite(ms)||new Date(ms+28_800_000).toISOString().slice(0,19)!==value.replace(' ','T'))return fail('weather_timestamp');
  if(!Number.isFinite(ms)||ms>now+300_000||now-ms>maxAge)return fail('weather_stale');
  return iso;
}
const number=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:fail('weather_number');
const wording=(v:unknown)=>typeof v==='string'&&/^[\u4e00-\u9fff]{1,12}$/.test(v)?v:fail('weather_wording');
export function parseWeather(data:any,raw:WeatherRequest,now:number):WeatherResult {
  const q=weatherRequestSchema.parse(raw),target=day(now+q.day_offset*86_400_000);
  let updated:string,text:string;
  if(q.metric==='current') {
    const d=data?.current;updated=time(d?.obs_time,now,2*3600_000);
    text=`墨迹天气显示，${q.city_name}截至${updated.slice(11,16)}，${wording(d.weather)}，${number(d.temp,-70,60)}摄氏度，${wording(d.wind_dir)}${number(d.wind_level,0,18)}级，湿度百分之${number(d.humidity,0,100)}。`;
  } else if(q.metric==='aqi') {
    const d=data?.aqi;updated=time(d?.pub_time,now,2*3600_000);
    const aqi=number(d.aqi,0,1000);const level=aqi<=50?'优':aqi<=100?'良':aqi<=150?'轻度污染':aqi<=200?'中度污染':aqi<=300?'重度污染':'严重污染';
    text=`墨迹天气显示，${q.city_name}截至${updated.slice(11,16)}，空气质量指数${aqi}，${level}。`;
  } else {
    const d=Array.isArray(data?.daily)?data.daily.find((v:any)=>v?.predict_date===target):null;
    if(!d)return fail('weather_target_date');updated=time(d.update_time,now,24*3600_000);
    const low=number(d.temp_low,-70,60),high=number(d.temp_high,-70,60);if(low>high)return fail('weather_temperature_range');
    text=`墨迹天气预报，${q.city_name}${['今天','明天','后天'][q.day_offset]}${target.slice(5).replace('-','月')}日，白天${wording(d.weather_day)}，夜间${wording(d.weather_night)}，${low}到${high}摄氏度。预报会变化。`;
  }
  return {text,sources:[{title:`墨迹天气 · ${q.city_name}`,url:'https://www.moji.com/zh-CN',date:updated}],weather:{provider:'moji-public-web',city_id:q.city_id,city_name:q.city_name,target_date:target,updated_at:updated,fetched_at:new Date(now).toISOString(),cache_hit:false,metric:q.metric}};
}
type Flight={controller:AbortController;promise:Promise<WeatherResult>;users:number};
export class MojiWeather {
  private cache=new Map<string,{at:number;data:any}>();
  private flights=new Map<string,Flight>();
  private cooldown=new Map<string,number>();
  private fetcher:typeof fetch;private now:()=>number;
  constructor(opts:{fetch?:typeof fetch;now?:()=>number}={}){this.fetcher=opts.fetch??fetch;this.now=opts.now??Date.now;}
  private async get(endpoint:'getCityData'|'getCityWeatherAndIndex',city:number,signal:AbortSignal) {
    const url=`https://wwwapi.moji.com/app-api/cms/official-website/${endpoint}?lat&lon&cityId=${city}`;
    const r=await this.fetcher(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(3000)]),headers:{'User-Agent':'P003-personal-weather-test/1.0','Accept':'application/json'}});
    if(!r.ok){await r.body?.cancel();throw new Error('weather_http_'+r.status);}
    const reader=r.body?.getReader();if(!reader)return fail('weather_empty');
    let size=0;const chunks:Uint8Array[]=[];
    try {for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>131072)return fail('response_too_large');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(v?.code!==0||!v.data)return fail('weather_payload');return v.data;
  }
  async run(raw:WeatherRequest,signal:AbortSignal):Promise<WeatherResult> {
    signal.throwIfAborted();const q=weatherRequestSchema.parse(raw),now=this.now();
    const key=JSON.stringify([q.city_id,day(now+q.day_offset*86_400_000),q.metric]);
    const cached=this.cache.get(key);
    if(cached&&now-cached.at<300_000){try{const v=parseWeather(cached.data,q,now);v.weather.cache_hit=true;v.weather.fetched_at=new Date(cached.at).toISOString();return v;}catch{this.cache.delete(key);}}
    if((this.cooldown.get(key)??0)>now)return fail('weather_cooldown');
    let f=this.flights.get(key);
    if(!f) {
      const controller=new AbortController(),budget=AbortSignal.any([controller.signal,AbortSignal.timeout(6000)]);
      f={controller,users:0,promise:Promise.resolve(null as any)};
      const flight=f;
      flight.promise=(async()=>{
        const identity=await this.get('getCityData',q.city_id,budget);
        if(identity.city?.id!==q.city_id||identity.city?.name!==q.city_name||identity.city?.time_zone_name!=='Asia/Shanghai')return fail('weather_city_mismatch');
        const data=await this.get('getCityWeatherAndIndex',q.city_id,budget);budget.throwIfAborted();
        const result=parseWeather(data,q,this.now());
        this.cache.set(key,{at:this.now(),data});if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
        return result;
      })().catch(e=>{if(!controller.signal.aborted)this.cooldown.set(key,this.now()+30_000);if(this.cooldown.size>64)this.cooldown.delete(this.cooldown.keys().next().value!);throw e;}).finally(()=>{if(this.flights.get(key)===flight)this.flights.delete(key);});
      this.flights.set(key,flight);
    }
    const flight=f;flight.users++;
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(err:unknown,value?:WeatherResult)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);if(--flight.users===0)flight.controller.abort();err?reject(err):resolve(structuredClone(value!));};
      const abort=()=>finish(signal.reason??new Error('aborted'));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      flight.promise.then(v=>finish(null,v),e=>finish(e));
    });
  }
}
