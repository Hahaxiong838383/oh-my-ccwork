import {readFileSync} from 'node:fs';
export type WeatherPlace={province:string;city:string;name:string;station:string;label:string;query:string};
type Row=[string,string,string,string,string[]];
const catalog=JSON.parse(readFileSync(new URL('./weather-places.json',import.meta.url),'utf8')) as {places:Row[]};
const provinces:Record<string,string>={北京:'北京市',上海:'上海市',天津:'天津市',重庆:'重庆市',内蒙古:'内蒙古自治区',广西:'广西壮族自治区',宁夏:'宁夏回族自治区',新疆:'新疆维吾尔自治区',西藏:'西藏自治区',香港:'香港特别行政区',澳门:'澳门特别行政区'};
const places=new Map<string,WeatherPlace>(),aliases=new Map<string,Set<string>>();
const join=(...parts:string[])=>parts.filter((x,i)=>x&&x!==parts[i-1]).join('');
function add(alias:string,station:string){if(!aliases.has(alias))aliases.set(alias,new Set());aliases.get(alias)!.add(station);}
for(const [province,city,name,station,cityAliases] of catalog.places){
 if(!/^101\d{6}$/.test(station)||places.has(station))throw new Error('weather_catalog_invalid');
 const label=join(province,city,name);places.set(station,{province,city,name,station,label,query:label+'天气'});
 const ps=[province,provinces[province]??province+'省'],cs=[city,city+'市',...cityAliases];
 const ns=[name,...(name===city?[name+'市',...cityAliases]:[name+'区',name+'县'])];
 for(const n of ns){add(n,station);for(const p of ps)add(p+n,station);for(const c of cs){add(c+n,station);for(const p of ps)add(p+c+n,station);}}
}
export const WEATHER_PLACE_COUNT=places.size;
export function resolveWeatherPlace(raw:string,context?:{province?:string}):WeatherPlace {
 if(!/^[\u4e00-\u9fff]{1,40}$/.test(raw))throw new Error('weather_place_invalid');
 let candidates=[...(aliases.get(raw)??[])].map(id=>places.get(id)!);
 if(candidates.length>1&&context?.province){const local=candidates.filter(p=>context.province===p.province||context.province===(provinces[p.province]??p.province+'省'));if(local.length)candidates=local;}
 if(candidates.length!==1)throw new Error(candidates.length?'weather_place_ambiguous':'weather_place_unknown');
 return {...candidates[0]};
}
