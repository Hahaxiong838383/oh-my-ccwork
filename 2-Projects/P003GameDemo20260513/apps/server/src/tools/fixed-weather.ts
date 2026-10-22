import {BaiduWeather,type PlaceWeatherRequest} from './baidu-weather.js';
import {MojiWeather,MOJI_CITIES} from './moji-weather.js';
import {resolveWeatherPlace} from './weather-places.js';
import type {SearchResult} from './search-tasks.js';
export class FixedWeather {
 private baidu:Pick<BaiduWeather,'run'>;private moji:Pick<MojiWeather,'run'>;
 constructor(o:{baidu?:Pick<BaiduWeather,'run'>;moji?:Pick<MojiWeather,'run'>}={}){this.baidu=o.baidu??new BaiduWeather();this.moji=o.moji??new MojiWeather();}
 async run(q:PlaceWeatherRequest,signal:AbortSignal,requestedAt:number,context?:{province?:string}):Promise<SearchResult>{
  signal.throwIfAborted();const p=resolveWeatherPlace(q.place,context);
  const fallback=p.name===p.city?MOJI_CITIES.find(c=>c.name===p.name+'市'):undefined;
  const budget=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
  if(q.metric!=='aqi'){
   try{return await this.baidu.run(q,budget,requestedAt,context);}catch(e){budget.throwIfAborted();if(!fallback)throw e;}
  }else if(!fallback)throw new Error('weather_metric_unsupported');
  return this.moji.run({city_id:fallback!.id,city_name:fallback!.name,metric:q.metric,day_offset:q.day_offset},budget,requestedAt);
 }
}
