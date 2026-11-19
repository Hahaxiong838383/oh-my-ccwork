import assert from 'node:assert/strict';
import {FixedWeather} from '../src/tools/fixed-weather.js';
const calls:any[]=[];
const shared={text:'已校验天气预报',sources:[{title:'测试天气源',url:'https://weathernew.pae.baidu.com/',date:'2026-10-31'}]};
const weather=new FixedWeather({baidu:{run:async(q:any)=>{calls.push(q);return shared;}},moji:{run:async()=>{throw Error('unexpected_moji');}}});
const signal=new AbortController().signal;
for(const [place,city] of [['北京经开区','北京'],['北京市经济技术开发区','北京'],['哈尔滨高新区','黑龙江哈尔滨']]){
 const result=await weather.run({place,day_offset:1,metric:'forecast'},signal,Date.now());
 assert.match(result.text,/市级天气参考/);assert.ok(result.text.includes(place));
 assert.equal(calls.at(-1).place,city);assert.equal(calls.at(-1).day_offset,1);assert.equal(result.sources[0].title,shared.sources[0].title);
}
assert.equal((await weather.run({place:'北京',day_offset:0,metric:'forecast'},signal,Date.now())).text,shared.text,'scope note must not pollute a shared/cache result');
assert.equal((await weather.run({place:'北京海淀区',day_offset:0,metric:'forecast'},signal,Date.now())).text,shared.text);
const before=calls.length;
for(const place of ['朝阳高新区','北京大兴区经开区','北京和上海经开区','东京高新区','北京大学经开区','经开区']){
 await assert.rejects(weather.run({place,day_offset:0,metric:'forecast'},signal,Date.now(),{province:'辽宁'}));
}
await assert.rejects(weather.run({place:'北京经开区',day_offset:0,metric:'aqi'},signal,Date.now()));
assert.equal(calls.length,before,'ambiguous/unknown/non-city/AQI must not call the provider');
let rejectedCalls=0;
const failed=new FixedWeather({baidu:{run:async()=>{rejectedCalls++;throw Error('weather_stale');}},moji:{run:async()=>{throw Error('must_not_downgrade_district');}}});
await assert.rejects(failed.run({place:'北京海淀区',day_offset:0,metric:'forecast'},signal,Date.now()),/weather_stale/);
assert.equal(rejectedCalls,1);
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(weather.run({place:'北京经开区',day_offset:0,metric:'forecast'},cancelled.signal,Date.now()));assert.equal(calls.length,before);
console.log('P1 city reference: 3 explicit fallbacks, exact district, ambiguity, cancellation, date and shared-result boundaries passed');
