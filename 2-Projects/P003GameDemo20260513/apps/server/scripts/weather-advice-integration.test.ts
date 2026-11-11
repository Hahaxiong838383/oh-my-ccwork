import assert from 'node:assert/strict';
import {BaiduWeather} from '../src/tools/baidu-weather.js';import {MojiWeather} from '../src/tools/moji-weather.js';import {FixedWeather} from '../src/tools/fixed-weather.js';import {weatherAdvice} from '../src/tools/weather-advice.js';
const now=Date.parse('2026-11-11T10:00:00+08:00'),signal=new AbortController().signal;
const data={position:{country:'中国',city:'深圳'},base:{date:'2026-11-11'},weather:{site:'moji',update_time:'2026-11-11 09:55',temperature:'16',weather:'阴'},'24_hour_forecast':{loc:'http://moji.com/101280601'},long_day_forecast:{info:[{date:'2026-11-12',temperature_day:'18',temperature_night:'10',weather_day:'小雨',weather_night:'多云'}]}};
let calls=0;const b=new BaiduWeather({now:()=>now,fetch:async()=>{calls++;return new Response('window.tplData = '+JSON.stringify(data)+';');}});
const q={place:'深圳',day_offset:1,metric:'forecast'} as const;
const weather=new FixedWeather({baidu:b});
const overview=weatherAdvice(await weather.run(q,signal,now),'深圳明天天气');assert.doesNotMatch(overview.text,/带伞|添衣/);
const advice=weatherAdvice(await weather.run(q,signal,now),'深圳明天冷不冷，要带伞吗');assert.match(advice.text,/10到18摄氏度.*带伞.*偏凉/);assert.equal(calls,1);assert(advice.weather?.cache_hit);assert([...advice.text].length<=150);
const old=new MojiWeather({now:()=>now,fetch:async(url:any)=>new Response(JSON.stringify({code:0,data:String(url).includes('city')?{city:{id:892,name:'深圳市',time_zone_name:'Asia/Shanghai'}}:{}}))});
// Exercise actual Moji parser with a validated frozen response, then the real fallback selector.
const {parseWeather}=await import('../src/tools/moji-weather.js');
let fallbackCalls=0;const fallback=new FixedWeather({baidu:{run:async()=>{throw Error('weather_http_429');}},moji:{run:async(mq:any)=>{fallbackCalls++;return parseWeather({daily:[{predict_date:'2026-11-12',update_time:'2026-11-11 09:55:00',temp_low:10,temp_high:18,weather_day:'小雨',weather_night:'多云'}]},mq,now,now);}}});
assert.match(weatherAdvice(await fallback.run(q,signal,now),'要不要带伞').text,/带伞/);assert.equal(fallbackCalls,1);
for(const bad of [{...data,weather:{...data.weather,update_time:'2026-11-10 10:00'}},{...data,position:{country:'中国',city:'上海'}},{...data,long_day_forecast:{info:[]}}]){
 const provider=new BaiduWeather({now:()=>now,fetch:async()=>new Response('window.tplData = '+JSON.stringify(bad)+';')});await assert.rejects(provider.run(q,signal,now));
}
console.log('PASS: actual provider parse, same-source advice, shared cache, fallback and stale/wrong-city/missing-date rejection');
