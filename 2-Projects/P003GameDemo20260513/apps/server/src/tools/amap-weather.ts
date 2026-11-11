import {placeWeatherSchema,type PlaceWeatherRequest} from './baidu-weather.js';
import {resolveWeatherPlace,type WeatherPlace} from './weather-places.js';
import type {SearchResult} from './search-tasks.js';
import type {WeatherFacts} from './weather-advice.js';
import {AmapUsageStore} from './amap-usage.js';
export type AmapWeatherEvidence={provider:'amap';city_name:string;adcode:string;target_date:string;updated_at:string;fetched_at:string;cache_hit:boolean;metric:string;precision:'city'};
type Result=SearchResult&{weather:AmapWeatherEvidence;weather_facts:WeatherFacts};
type Flight={controller:AbortController;promise:Promise<Result>;users:number};
const fail=(code:string):never=>{throw new Error('weather_amap_'+code);};
const day=(ms:number)=>new Date(ms+28800000).toISOString().slice(0,10);
const normalize=(s:unknown)=>typeof s==='string'?s.replace(/(?:维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市)$/u,''):'';
const temperature=(v:unknown)=>typeof v==='string'&&/^-?\d{1,2}(?:\.\d)?$/.test(v)&&Number(v)>=-70&&Number(v)<=60?Number(v):fail('temperature');
const words=(v:unknown)=>typeof v==='string'&&/^[\u4e00-\u9fff]{1,12}$/.test(v)?v:fail('wording');

/** Official city-level weather. Device IP is resolved by the trusted session,
 * never by this server's egress. No SDK/MCP process or model call is needed. */
export class AmapWeather{
 private fetcher:typeof fetch;private now:()=>number;private apiKey:string;private timeoutMs:number;
 private cache=new Map<string,{at:number;result:Result}>();private geo=new Map<string,{at:number;code:string;city:string}>();
 private flights=new Map<string,Flight>();private cooldown=new Map<string,number>();private hits:number[]=[];
 private usage?:AmapUsageStore;
 constructor(o:{apiKey?:string;fetch?:typeof fetch;now?:()=>number;timeoutMs?:number;usage?:AmapUsageStore}={}){this.apiKey=o.apiKey??process.env.AMAP_WEATHER_API_KEY??'';this.fetcher=o.fetch??fetch;this.now=o.now??Date.now;this.timeoutMs=o.timeoutMs??3000;this.usage=o.usage??(process.env.AMAP_USAGE_DB_PATH?new AmapUsageStore(process.env.AMAP_USAGE_DB_PATH):undefined);}
 async run(raw:PlaceWeatherRequest,signal:AbortSignal,requestedAt=this.now(),context?:{province?:string}):Promise<Result>{
  signal.throwIfAborted();if(!this.apiKey)return fail('unconfigured');const q=placeWeatherSchema.parse(raw);if(q.metric==='aqi')return fail('metric_unsupported');
  const p=resolveWeatherPlace(q.place,context),target=day((q.metric==='current'?this.now():requestedAt)+q.day_offset*86400000),key=JSON.stringify([p.province,p.city,q.metric,target]);
  const cached=this.cache.get(key);if(cached&&this.now()-cached.at<300000)return {...structuredClone(cached.result),weather:{...cached.result.weather,cache_hit:true}};
  if((this.cooldown.get(key)??0)>this.now())return fail('cooldown');let f=this.flights.get(key);
  if(!f){
   if(this.usage&&this.usage.snapshot().remaining<1)return fail('quota_exhausted');
   const controller=new AbortController(),budget=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]);
   f={controller,users:0,promise:Promise.resolve(null as any)};const flight=f;
   flight.promise=this.query(q,p,target,budget).then(result=>{this.cache.set(key,{at:this.now(),result});if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);return result;}).catch(e=>{if(!controller.signal.aborted)this.cooldown.set(key,this.now()+30000);if(this.cooldown.size>128)this.cooldown.delete(this.cooldown.keys().next().value!);throw e;}).finally(()=>{if(this.flights.get(key)===flight)this.flights.delete(key);});this.flights.set(key,flight);
  }
  const flight=f;flight.users++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(error:unknown,value?:Result)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);if(--flight.users===0)flight.controller.abort();error?reject(error):resolve(structuredClone(value!));};const abort=()=>finish(signal.reason??new Error('aborted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();flight.promise.then(v=>finish(null,v),e=>finish(e));});
 }
 private async read(path:string,params:Record<string,string>,signal:AbortSignal):Promise<any>{
  signal.throwIfAborted();this.hits=this.hits.filter(t=>t>this.now()-1000);if(this.hits.length>=3)return fail('rate_limit');this.hits.push(this.now());
  let requestId:string|undefined;
  try{requestId=this.usage?.reserve(path==='weather/weatherInfo'?'weather':'geocode');}catch(e){return fail(e instanceof Error&&e.message==='quota_exhausted'?'quota_exhausted':'usage_unavailable');}
  const recorded=(outcome:'success'|'rejected',code?:string)=>{if(requestId)try{this.usage!.finish(requestId,outcome,code);}catch{/* Reservation remains counted, with unknown outcome. */}};
  // No exception from fetch (which may contain this URL/key) leaves the adapter.
  try{
   const response=await this.fetcher('https://restapi.amap.com/v3/'+path+'?'+new URLSearchParams({...params,key:this.apiKey,output:'JSON'}),{redirect:'error',signal,headers:{Accept:'application/json'}});
   if(!response.ok){recorded('rejected');await response.body?.cancel();return fail('http_'+response.status);}
   const reader=response.body?.getReader();if(!reader)return fail('empty');let size=0;const chunks:Uint8Array[]=[];
   try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)return fail('body_limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   signal.throwIfAborted();let data:any;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('payload');}
   if(data?.status!=='1'||data?.infocode!=='10000'){recorded('rejected',data?.infocode);return fail(['10003','10004','10020','10021','10044'].includes(data?.infocode)?'quota':'api_rejected');}recorded('success','10000');return data;
  }catch(e){signal.throwIfAborted();if(e instanceof Error&&/^weather_amap_[a-z_0-9]+$/.test(e.message))throw e;return fail('transport');}
 }
 private async query(q:PlaceWeatherRequest,p:WeatherPlace,target:string,signal:AbortSignal):Promise<Result>{
  const cityKey=p.province+'/'+p.city;let location=this.geo.get(cityKey);
  if(!location||this.now()-location.at>86400000){
   const data=await this.read('geocode/geo',{address:p.province+p.city,city:p.city},signal);
   const candidates=Array.isArray(data.geocodes)?data.geocodes.filter((v:any)=>v?.country==='中国'&&normalize(v.province)===p.province&&(normalize(v.city)||normalize(v.province))===p.city&&/^\d{6}$/.test(v.adcode)&&['市','区县','省'].includes(v.level)):[];
   const codes=new Set(candidates.map((v:any)=>v.adcode));if(codes.size!==1)return fail('city_mismatch');
   location={at:this.now(),code:candidates[0].adcode,city:p.city};this.geo.set(cityKey,location);if(this.geo.size>128)this.geo.delete(this.geo.keys().next().value!);
  }
  const data=await this.read('weather/weatherInfo',{city:location.code,extensions:q.metric==='current'?'base':'all'},signal);
  const rows=q.metric==='current'?data.lives:data.forecasts;if(!Array.isArray(rows)||rows.length!==1)return fail('payload');const row=rows[0];
  if(row.adcode!==location.code||normalize(row.city)!==p.city||normalize(row.province)!==p.province)return fail('city_mismatch');
  const stamp=row.reporttime;if(typeof stamp!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp))return fail('timestamp');
  const updated=stamp.replace(' ','T')+'+08:00',at=Date.parse(updated),age=this.now()-at;
  if(!Number.isFinite(at)||age< -300000||age>(q.metric==='current'?3:24)*3600000)return fail('stale');
  let text:string;let facts:WeatherFacts;const label=p.city===p.province?p.city:p.province+p.city;
  if(q.metric==='current'){const condition=words(row.weather),t=temperature(row.temperature);facts={metric:'current',temperature:t,conditions:[condition]};text=`高德天气显示，${label}目前大致${condition}，${t}摄氏度。`;}
  else{
   const casts=Array.isArray(row.casts)?row.casts.filter((v:any)=>v?.date===target):[];if(casts.length!==1)return fail('target_date');const cast=casts[0],a=temperature(cast.daytemp),b=temperature(cast.nighttemp);
   const daytime=words(cast.dayweather),night=words(cast.nightweather);facts={metric:'forecast',low:Math.min(a,b),high:Math.max(a,b),conditions:[daytime,night]};
   text=`高德天气预报，${label}${target.slice(5).replace('-','月')}日，白天${daytime}，夜间${night}，大约${Math.min(a,b)}到${Math.max(a,b)}摄氏度。预报仅供参考。`;
  }
  return {text,weather_facts:facts,sources:[{title:'高德天气 · '+label,url:'https://www.amap.com/',date:updated}],weather:{provider:'amap',city_name:label,adcode:location.code,target_date:target,updated_at:updated,fetched_at:new Date(this.now()).toISOString(),cache_hit:false,metric:q.metric,precision:'city'}};
 }
}
