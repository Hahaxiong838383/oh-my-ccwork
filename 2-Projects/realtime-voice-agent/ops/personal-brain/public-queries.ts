import {inspectWeatherPlace} from './p003/tools/weather-places.js';
import type {PlaceWeatherRequest} from './p003/tools/baidu-weather.js';
import type {SearchResult} from './p003/tools/search-tasks.js';

function compact(text: string) {
  return text.normalize('NFKC').replace(/[\s，。！？,.!?、]/gu, '');
}

const prefix = /^(?:小可|请问|我想知道|我想了解|我想问问|请告诉我|告诉我|那+|还是|就|帮我|给我|请你|麻烦你|看看|看下|看一下|查一下|查查|查下|查询|查|问一下)+/u;
const ending = /(?:可以吗|行不行|好不好|就好|就行|的|呢|吧|呗|啊|呀|嘛|吗)+$/u;

function placeWords(text: string) {
  return compact(text).replace(prefix, '').replace(ending, '');
}

export function weatherIntent(text: string) {
  const q = compact(text);
  if (!/天气|气温|降雨|下雨|带伞|多少度|空气质量/u.test(q) ||
      /为什么|原理|是什么|形成|故事|作文|如果|别查|不要查/u.test(q)) return;
  if (/昨天|前天|下周|下个月|第\d|[0-9一二三四五六七八九十]+[月日号]|周[一二三四五六日末]/u.test(q)) return {unsupported: true};
  const day_offset = /后天/u.test(q) ? 2 : /明天/u.test(q) ? 1 : 0;
  const metric = /空气质量/u.test(q) ? 'aqi' : /现在|目前|实时/u.test(q) && day_offset === 0 ? 'current' : 'forecast';
  if (metric === 'aqi' && day_offset) return {unsupported: true};
  const target = {day_offset, metric} as Pick<PlaceWeatherRequest, 'day_offset'|'metric'>;
  const words = placeWords(q).replace(/今天|明天|后天|现在|目前|实时|怎么样|咋样|如何|会不会下雨|会下雨吗|要不要带伞|用不用带伞|要带伞|带伞|下雨|降雨|出门|空气质量|天气预报|天气|气温|多少度|是多少|多少|的/gu, '');
  const place = placeWords(words);
  const result = inspectWeatherPlace(place);
  if (result.status === 'unique') return {request: {...target, place}, target};
  if (result.status === 'ambiguous') return {target, ambiguous: true};
  if (/^[\u4e00-\u9fff]{2,25}(?:经开区|高新区|经济技术开发区)$/u.test(place)) return {request: {...target,place},target};
  return {target};
}

export function followupPlace(text: string) {
  const place = placeWords(text);
  return inspectWeatherPlace(place).status === 'unique' ? place : undefined;
}

export function cnMarket(text: string): 'cn'|'unspecified'|undefined {
  const q = placeWords(text).replace(/^(?:(?:今天|今日|最新|目前|现在|当前|国内的?|中国的?|看看|了解一下|介绍一下))+/u, '');
  const m = /^(A股(?:股市|市场|大盘)?|沪深(?:股市|大盘|市场|指数)|上证指数|股市|股票市场|大盘)(?:今天|现在|目前|行情|情况|表现|走势|涨跌|点位|指数|多少点|怎么样|咋样|如何|是多少|多少|的)*$/iu.exec(q);
  if (!m) return;
  return /^(?:A股|沪深|上证)/iu.test(m[1]) || /国内|中国/u.test(text) ? 'cn' : 'unspecified';
}

const indices = [
  ['sh000001','上证指数'], ['sz399001','深证成指'], ['sz399006','创业板指'],
] as const;

export async function marketSnapshot(signal: AbortSignal, now = Date.now()): Promise<SearchResult> {
  const url = 'https://qt.gtimg.cn/q=' + indices.map(([id]) => id).join(',');
  const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]), redirect:'error'});
  if (!response.ok) {await response.body?.cancel(); throw new Error('quote_http');}
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 32768) throw new Error('quote_size');
  const body = new TextDecoder('gb18030').decode(bytes);
  const quotes = indices.map(([id,name]) => {
    const match = body.match(new RegExp('(?:^|;\\s*)v_' + id + '="([^"]+)"'));
    const f = match?.[1].split('~');
    if (!f || f[1] !== name || f[2] !== id.slice(2) || !/^\d{14}$/.test(f[30]) ||
        !/^\d+(?:\.\d+)?$/.test(f[3]) || Number(f[3]) <= 0 || !/^-?\d+(?:\.\d+)?$/.test(f[32])) throw new Error('quote_fields');
    const t = f[30], date = t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8)+'T'+t.slice(8,10)+':'+t.slice(10,12)+':'+t.slice(12,14)+'+08:00';
    const age = now-Date.parse(date);
    if (!Number.isFinite(age) || age < -60000 || age > 12*86400000) throw new Error('quote_date');
    return {date, stamp:t, value:f[3], change:Number(f[32]), id, name};
  });
  if (quotes.some(q => q.stamp.slice(0,8) !== quotes[0].stamp.slice(0,8))) throw new Error('quote_dates');
  const t=quotes.map(q=>q.stamp).sort()[0];
  const time=Number(t.slice(4,6))+'月'+Number(t.slice(6,8))+'日'+t.slice(8,10)+'点'+t.slice(10,12)+'分';
  const text='腾讯行情截至'+time+'，'+quotes.map(q=>q.name+q.value+'点，'+(q.change===0?'持平':(q.change>0?'涨':'跌')+Math.abs(q.change)+'%')).join('；')+'。';
  return {text, sources: quotes.map(q=>({title:'腾讯行情 · '+q.name, url:'https://gu.qq.com/'+q.id+'/zs', date:q.date}))};
}
