/** Format only facts already checked by the fixed providers. No fetch/model, no derived apparent temperature. */
import type {SearchResult} from './search-tasks.js';
export type WeatherFacts={metric:'forecast'|'current';low?:number;high?:number;temperature?:number;conditions:string[]};
export type WeatherFactsResult=SearchResult & {weather_facts?:WeatherFacts};
export function weatherAdvice(result:WeatherFactsResult,query:string):SearchResult {
 const {weather_facts:f,...answer}=result;
 if(!f)return answer;
 const advice:string[]=[];
 if(/带伞|拿伞|用伞/.test(query)){
  const wet=f.conditions.some(v=>/雨|雪|冰雹/.test(v));
  advice.push(f.metric==='current'?'这只是当前观测，出门前再看临近预报。':wet?'预报有降水，出门建议带伞。':'预报未提示降水，出门前再看临近预报。');
 }
 if(/冷不冷|热不热|冷吗|热吗/.test(query)){
  const lo=f.low??f.temperature,hi=f.high??f.temperature;
  if(lo!==undefined&&hi!==undefined&&Number.isFinite(lo)&&Number.isFinite(hi)){
   advice.push(hi<=18?'温度偏凉，注意添衣。':lo>=28?'温度偏热，注意补水。':lo<18?'早晚可能偏凉，备件外套。':hi>=30?'高温时段注意补水。':'可按这个温度范围调整衣着。');
  }
 }
 if(!advice.length)return answer;
 let text=answer.text.replace(/预报会变化。$/,'');
 for(const sentence of advice)if([...text+sentence].length<=132)text+=sentence;
 return {...answer,text};
}
