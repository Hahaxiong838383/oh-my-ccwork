/** Local clock tool. No network, database, model, or process-wide timezone mutation. */
export type ClockRequest = {kind:'clock';iana:string;place_label:string;requested:'time'|'date'|'weekday'}
  | {kind:'clarify_timezone';place?:string} | {kind:'clarify_date'};
const places:Record<string,string>={
  北京:'Asia/Shanghai',上海:'Asia/Shanghai',中国:'Asia/Shanghai',广州:'Asia/Shanghai',深圳:'Asia/Shanghai',杭州:'Asia/Shanghai',成都:'Asia/Shanghai',重庆:'Asia/Shanghai',武汉:'Asia/Shanghai',南京:'Asia/Shanghai',西安:'Asia/Shanghai',天津:'Asia/Shanghai',苏州:'Asia/Shanghai',郑州:'Asia/Shanghai',长沙:'Asia/Shanghai',香港:'Asia/Hong_Kong',澳门:'Asia/Macau',台北:'Asia/Taipei',
  纽约:'America/New_York',洛杉矶:'America/Los_Angeles',芝加哥:'America/Chicago',丹佛:'America/Denver',旧金山:'America/Los_Angeles',伦敦:'Europe/London',巴黎:'Europe/Paris',柏林:'Europe/Berlin',东京:'Asia/Tokyo',日本:'Asia/Tokyo',首尔:'Asia/Seoul',韩国:'Asia/Seoul',新加坡:'Asia/Singapore',悉尼:'Australia/Sydney',墨尔本:'Australia/Melbourne',迪拜:'Asia/Dubai',莫斯科:'Europe/Moscow',多伦多:'America/Toronto',温哥华:'America/Vancouver',曼谷:'Asia/Bangkok',印度:'Asia/Kolkata',新德里:'Asia/Kolkata',奥克兰:'Pacific/Auckland',夏威夷:'Pacific/Honolulu',檀香山:'Pacific/Honolulu',
};
const multiZone=new Set(['美国','加拿大','澳大利亚','澳洲','俄罗斯','巴西','墨西哥']);
const clean=(text:string)=>text.normalize('NFKC').replace(/[\s，。？！、,.?!：:]/g,'').replace(/^(?:小可(?:小可)?|请问|请|帮我(?:查查|查一下|查|看一下|看看)|告诉我|你知道|知道|问一下)+/,'');
const bad=/天气|下雨|气温|带伞|闹钟|提醒|倒计时|宝箱|奖励|用了|使用时长|使用时间|积分|几点建议|几点意见|几点要求|开门|关门|开会|上课|下课|几点开始|几点结束|几点出发|几点回家|几点吃|几点睡|几点起|几点叫|什么时候|是什么意思|怎么说|翻译|他说|她说|我说|你说现在|不要|不用|别报|别告诉/;
function detect(text:string):ClockRequest|null{
  const t=clean(text);if(!t||t.length>100||(bad.test(t)&&!/^现在才几点[啊呀]?就跟我说晚安$/.test(t)))return null;
  if(/^那是几号[呀啊呢吗]?$/.test(t))return {kind:'clarify_date'};
  // Current-clock correction in actual historical speech, not a general narrative trigger.
  const correction=/^现在才几点[啊呀]?就跟我说晚安$/.test(t);
  const time=/^(.*?)(?:现在|此刻|这会儿|这会|都|已经)?(?:是)?(?:几点(?:钟)?(?:了)?|什么时间|什么时刻|报个时|报一下时间|报时)[呀啊呢吗吧嘛啦]?$/.exec(t);
  const date=/^(.*?)(?:今天|今日|现在)(?:是)?(?:几月几[号日]|几号|几日|什么日期|日期)[呀啊呢吗吧]?$/.exec(t);
  const weekday=/^(.*?)(?:今天|今日|现在)(?:是)?(?:星期几|周几|礼拜几)[呀啊呢吗吧]?$/.exec(t);
  const named=/^(.+?)时间(?:是)?(?:多少|几点)?[呀啊呢吗吧]?$/.exec(t);
  const match=date??weekday??time??named;
  if(!match&&!correction)return null;
  if(t==='几点')return null;
  let place=correction?'':(match?.[1]??'').replace(/(?:现在|此刻|这会儿|这会|都|已经|今天|今日|的|当地|那边|那儿|那里|那)$/g,'');
  // Unknown qualifiers must not silently become Beijing time.
  if(['','北京','中国'].includes(place))return {kind:'clock',iana:'Asia/Shanghai',place_label:'北京时间',requested:date?'date':weekday?'weekday':'time'};
  if(multiZone.has(place)||!places[place])return {kind:'clarify_timezone',place};
  return {kind:'clock',iana:places[place],place_label:place,requested:date?'date':weekday?'weekday':'time'};
}
export function resolveClock(text:string,previousUserTurns:readonly string[]=[]):ClockRequest|null{
  const direct=detect(text);if(direct)return direct;
  const t=clean(text);if(bad.test(t))return null;
  const last=previousUserTurns.at(-1);const context=last?detect(last):null;
  if(!context||context.kind==='clarify_date')return null;
  const follow=/^(?:那)?([\p{Script=Han}]{2,8}?)(?:呢|那边呢|那儿呢)?$/u.exec(t);
  if(!follow)return null;
  const place=follow[1];if(!places[place]&&!multiZone.has(place))return null;
  const r=detect(place+'现在几点');
  return r?.kind==='clock'&&context.kind==='clock'?{...r,requested:context.requested}:r;
}
function cn(n:number):string{const a='零一二三四五六七八九';return n<10?a[n]:n<20?'十'+(n%10?a[n%10]:''):a[Math.floor(n/10)]+'十'+(n%10?a[n%10]:'');}
export function answerClock(req:ClockRequest,now=Date.now()):string{
  if(req.kind==='clarify_date')return '你是想问今天几号，还是刚才说的那件事的日期？';
  if(req.kind==='clarify_timezone')return req.place==='美国'?'美国有好几个时区，你是想问纽约、芝加哥还是洛杉矶？':`${req.place??'这个地方'}的时间需要先确认城市，你想问哪个城市？`;
  if(!Number.isFinite(now)||!Object.values(places).includes(req.iana))throw new Error('invalid_clock_request');
  const parts=new Intl.DateTimeFormat('zh-CN',{timeZone:req.iana,year:'numeric',month:'numeric',day:'numeric',weekday:'long',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(now);
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value])),h=Number(p.hour),m=Number(p.minute);
  const local=req.iana==='Asia/Shanghai',prefix=local?'今天':req.place_label+'当地今天';
  if(req.requested==='date')return `${prefix}是${p.year}年${Number(p.month)}月${Number(p.day)}日，${p.weekday}。`;
  if(req.requested==='weekday')return `${prefix}是${p.weekday}。`;
  const period=h<6?'凌晨':h<9?'早上':h<12?'上午':h<13?'中午':h<18?'下午':h<19?'傍晚':'晚上';
  const hour=h===0?0:h>12?h-12:h;
  const clock=period+cn(hour)+'点'+(m===0?'整':(m<10?'零':'')+cn(m)+'分');
  return (req.place_label==='北京时间'?'现在是北京时间':req.place_label+'现在是')+clock+(local?'':'，'+p.weekday)+'。';
}
