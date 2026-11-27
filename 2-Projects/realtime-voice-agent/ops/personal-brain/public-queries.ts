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

// Check the full station alias between removals. In particular, a city inside
// a route or an unknown district is not a match for the whole requested place.
const spokenLead = ['我想了解','我想知道','我想问问','我现在在','我人在','我在','我说的是','请问','小可','麻烦','帮忙',
  '能不能','可不可以','请','你','先','再','还是','那','就','帮我','给我','告诉我','提供一下','提供','只说说',
  '看一看','看一下','看看','看下','查一查','查一下','查查','查下','查询','查','问一下','在','呃','额','啊'];
const spokenTail = ['可以吗','行不行','好不好','就好','就行','快一点','快点','这边','那边','的','呢','吧','呗','啊','呀','嘛','吗'];
const weatherWords = ['天气预报','天气情况','空气质量','需不需要带伞','要不要带伞','用不用带伞','会不会下雨',
  '下不下雨','会下雨','要带伞','带伞','出门','下雨','降雨','气温','温度','多少度','是多少','多少','天气',
  '今天','明天','后天','现在','目前','实时','怎么样','咋样','如何','的'];
const weatherLead = [...spokenLead, ...weatherWords];
const weatherTail = ['再告诉我需不需要带伞','再告诉我要不要带伞','告诉我会不会下雨','告诉我下不下雨',
  '你找不着','你查不到', ...spokenTail, ...weatherWords];

function spokenPlace(text: string, lead: string[], tail: string[]): string {
  let rest = compact(text);
  while (rest) {
    if (inspectWeatherPlace(rest).candidates.length) break;
    const end = tail.find(word => rest.endsWith(word));
    if (end) {
      rest = rest.slice(0, -end.length);
      continue;
    }
    const start = lead.find(word => rest.startsWith(word));
    if (!start) break;
    rest = rest.slice(start.length);
  }
  return rest;
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
  const place = spokenPlace(q, weatherLead, weatherTail);
  const result = inspectWeatherPlace(place);
  if (result.status === 'unique') return {request: {...target, place}, target};
  if (result.status === 'ambiguous') return {target, ambiguous: true};
  if (/^[\u4e00-\u9fff]{2,25}(?:经开区|高新区|经济技术开发区)$/u.test(place)) return {request: {...target,place},target};
  return {target};
}

export function followupPlace(text: string) {
  // Volc ASR can render the sentence-final “的呗” as “的Bye” or “的拜”. This normalization
  // is limited to a pending weather reply; the remaining place must still match a station.
  const place = spokenPlace(compact(text).replace(/的(?:bye|拜)$/iu, '的'), spokenLead, spokenTail);
  return inspectWeatherPlace(place).status === 'unique' ? place : undefined;
}

// A plain news request can start with a short domestic bulletin. Preserve any named
// topic, source, region, historical date or unsupported count for the regular search.
export function domesticBulletin(query: string) {
  const q = query.normalize('NFKC').replace(/[\s,，。!?！？、：:]/gu, '');
  if (q.length > 60 || !q.includes('新闻')) return;
  const count = q.match(/(?:[一1两二2])条/gu) ?? [];
  if (count.length > 1) return;
  const rest = q.replace(/我想听听|我想听|给我讲讲|有什么|有哪些|有没有|怎么样|今天|今日|现在|目前|最新|最近|近期|国内|我国|中国|一条|1条|两条|二条|2条|新闻|给我|帮我|跟我|可以|请你|只要|就好|就行|即可|简短|简要|说说|讲讲|播报|播一播|听听|看看|说|讲|播|听|来|请|的|点|吗|呢|吧|啊/gu, '');
  if (rest) return;
  return {
    query: /今天|今日|现在|目前/u.test(q) ? '央视今天国内新闻' : '央视最新国内新闻',
    count: count[0] === '一条' || count[0] === '1条' ? 1 : 2,
  };
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
