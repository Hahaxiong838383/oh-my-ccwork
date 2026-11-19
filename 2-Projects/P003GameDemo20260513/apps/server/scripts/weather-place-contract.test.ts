import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveWeatherPlace} from '../src/tools/weather-places.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/weather-place-contract.json',import.meta.url),'utf8'));
for(const c of fixture.cases as {input:string;stations:string[]}[]) {
  if(c.stations.length===1) assert.equal(resolveWeatherPlace(c.input).station,c.stations[0],c.input);
  else assert.throws(()=>resolveWeatherPlace(c.input),new RegExp(c.stations.length?'weather_place_ambiguous':'weather_place_unknown'),c.input);
}
assert.equal(resolveWeatherPlace('朝阳',{province:'辽宁'}).province,'辽宁');
assert.throws(()=>resolveWeatherPlace('北京大学'),/weather_place_unknown/);
console.log(`weather catalog contract: ${fixture.cases.length} cases passed`);
