import {BaiduWeather,type PlaceWeatherRequest} from './baidu-weather.js';
import {MojiWeather,MOJI_CITIES} from './moji-weather.js';
import {resolveWeatherPlace} from './weather-places.js';
import type {SearchResult} from './search-tasks.js';
export class FixedWeather {
 private baidu:Pick<BaiduWeather,'run'>;private moji:Pick<MojiWeather,'run'>;
 constructor(o:{baidu?:Pick<BaiduWeather,'run'>;moji?:Pick<MojiWeather,'run'>}={}){this.baidu=o.baidu??new BaiduWeather();this.moji=o.moji??new MojiWeather();}
 async run(q:PlaceWeatherRequest,signal:AbortSignal,requestedAt:number,context?:{province?:string}):Promise<SearchResult>{
  signal.throwIfAborted();const requested=q.place;let p;let scope='';
  try{p=resolveWeatherPlace(requested,context);}
  catch(e){
   // Only unlisted development zones with an explicit, unique city may use
   // a disclosed city reference. Never downgrade a known district's outage,
   // use the device's IP to resolve an ambiguous parent, or broaden AQI.
   const city=/^(.+?)(?:经济技术开发区|经开区|高新区)$/.exec(requested)?.[1];
   if(!(e instanceof Error)||e.message!=='weather_place_unknown'||q.metric==='aqi'||!city)throw e;
   p=resolveWeatherPlace(city);if(p.name!==p.city)throw e;
   q={...q,place:p.label};scope=`暂时无法细化到${requested}，先提供${p.label}市级天气参考。`;
  }
  const scoped=(r:SearchResult):SearchResult=>scope?{...r,text:scope+r.text}:r;
  const fallback=p.name===p.city?MOJI_CITIES.find(c=>c.name===p.name+'市'):undefined;
  const budget=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
  if(q.metric!=='aqi'){
   try{return scoped(await this.baidu.run(q,budget,requestedAt,context));}catch(e){budget.throwIfAborted();if(!fallback)throw e;}
  }else if(!fallback)throw new Error('weather_metric_unsupported');
  return scoped(await this.moji.run({city_id:fallback!.id,city_name:fallback!.name,metric:q.metric,day_offset:q.day_offset},budget,requestedAt));
 }
}
