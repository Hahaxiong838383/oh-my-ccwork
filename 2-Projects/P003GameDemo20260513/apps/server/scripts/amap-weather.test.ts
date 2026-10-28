import assert from 'node:assert/strict';
import {test} from 'node:test';
const module:any=await import('../src/tools/amap-weather.js').catch(()=>({}));
const now=Date.parse('2026-10-28T16:00:00+08:00'),q={place:'成都',day_offset:0,metric:'forecast'};
const geo={status:'1',infocode:'10000',geocodes:[{country:'中国',province:'四川省',city:'成都市',district:[],adcode:'510100',level:'市'}]};
const data={status:'1',infocode:'10000',forecasts:[{province:'四川',city:'成都市',adcode:'510100',reporttime:'2026-10-28 11:00:00',casts:[{date:'2026-10-28',dayweather:'阴',nightweather:'小雨',daytemp:'18',nighttemp:'-2'}]}]};
const make=(weather:any=data,geocode:any=geo)=>new module.AmapWeather({apiKey:'synthetic',now:()=>now,fetch:async(url:any)=>Response.json(String(url).includes('/geocode/')?geocode:weather)});
test('R23 official weather returns coarse city/date, accepts scheduled daily forecast and negative temperatures',async()=>{
 assert.equal(typeof module.AmapWeather,'function');const p=make();const r=await p.run(q,new AbortController().signal,now);
 assert.match(r.text,/成都.*-2.*18/);assert.equal(r.weather.provider,'amap');assert.equal(r.weather.target_date,'2026-10-28');assert(!r.sources[0].url.includes('synthetic'));
});
test('R23 unknown credentials, wrong city, missing values, stale data and API limits are not weather facts',async()=>{
 assert.equal(typeof module.AmapWeather,'function');
 for(const d of [{...data,infocode:'10003',status:'0'}, {...data,forecasts:[{...data.forecasts[0],adcode:'110000'}]}, {...data,forecasts:[{...data.forecasts[0],reporttime:'2026-10-26 11:00:00'}]}, {...data,forecasts:[{...data.forecasts[0],casts:[{...data.forecasts[0].casts[0],daytemp:''}]}]}]) await assert.rejects(make(d).run(q,new AbortController().signal,now));
 await assert.rejects(make(data,{...geo,geocodes:[{...geo.geocodes[0],city:'北京市',province:'北京市'}]}).run(q,new AbortController().signal,now));
 let called=0;await assert.rejects(new module.AmapWeather({apiKey:'',fetch:async()=>{called++;throw Error('unused');}}).run(q,new AbortController().signal,now),/unconfigured/);assert.equal(called,0);
});
test('R23 cache and concurrent requests share upstream work; cancelling a subscriber does not cancel another',async()=>{
 assert.equal(typeof module.AmapWeather,'function');let calls=0,release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const p=new module.AmapWeather({apiKey:'synthetic',now:()=>now,fetch:async(url:any)=>{calls++;await wait;return Response.json(String(url).includes('/geocode/')?geo:data);}});
 const a=new AbortController(),b=new AbortController();const one=p.run(q,a.signal,now),two=p.run(q,b.signal,now);a.abort();await assert.rejects(one);release();const r=await two;assert.match(r.text,/成都/);assert.equal(calls,2);
 assert.equal((await p.run(q,b.signal,now)).weather.cache_hit,true);assert.equal(calls,2);
 const stopped=new AbortController();stopped.abort();await assert.rejects(p.run(q,stopped.signal,now));assert.equal(calls,2);
});
test('R23 municipality geocoding may return an empty city array without losing the verified province',async()=>{
 const municipality={status:'1',infocode:'10000',geocodes:[{country:'中国',province:'北京市',city:[],district:[],adcode:'110000',level:'省'}]};
 const bj={...data,forecasts:[{...data.forecasts[0],province:'北京',city:'北京市',adcode:'110000'}]};
 assert.match((await make(bj,municipality).run({...q,place:'北京'},new AbortController().signal,now)).text,/北京/);
});
