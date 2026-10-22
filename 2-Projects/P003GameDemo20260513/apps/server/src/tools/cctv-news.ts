/** Fixed public domestic-news source for the personal canary. Never executes JSONP/HTML. */
export type NewsEvidence={id:number;title:string;url:string;date:string;text:string};
type Request={today:boolean;space:boolean};
type Article={title:string;url:string;date:string;brief:string;keywords:string};
const day=(ms:number)=>new Date(ms+28_800_000).toISOString().slice(0,10);
const clean=(s:string)=>s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<(?:style|noscript|iframe)\b[^>]*>[\s\S]*?<\/(?:style|noscript|iframe)\s*>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const unsafe=(s:string)=>/\[\[DEV:|忽略.{0,8}(指令|规则)|ignore.{0,12}instructions/i.test(s);
function request(q:string):Request|null {
 if(!/(今天|今日|最新|最近|近期)/.test(q)||!/(新闻|消息|进展)/.test(q)||/(昨天|去年|明天|美国|俄罗斯|日本|国外|国际|体育|足球|篮球|股市)/.test(q))return null;
 const space=/航天|空间站|火箭|卫星/.test(q);
 if(space&&!/中国|我国|国内|央视/.test(q))return null;
 // Bounded to domestic bulletin / domestic space news, not arbitrary topics.
 const rest=q.replace(/中国|我国|国内|央视网?|中央电视台|航天|空间站|火箭|卫星|今天|今日|最新|最近|近期|新闻|消息|进展|有什么|有哪些|情况|报道|播报|看看|一下|帮我查|查|请|的|[，。？?！!\s]/g,'');
 return !rest&&(space||/央视/.test(q))?{today:/今天|今日/.test(q),space}:null;
}
function article(row:any,now:number,q:Request):Article|null {
 if(!row||typeof row.title!=='string'||typeof row.url!=='string'||typeof row.focus_date!=='string'||typeof row.brief!=='string'||typeof row.keywords!=='string')return null;
 if(!/^https:\/\/news\.cctv\.com\/(20\d{2})\/(\d{2})\/(\d{2})\/ARTI[a-zA-Z0-9]{10,60}\.shtml$/.test(row.url)||!/^[\d]{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.focus_date))return null;
 const date=row.focus_date.replace(' ','T')+'+08:00',ms=Date.parse(date);
 if(!Number.isFinite(ms)||new Date(ms+28_800_000).toISOString().slice(0,19)!==row.focus_date.replace(' ','T')||ms>now||now-ms>7*86400000||q.today&&day(ms)!==day(now)||!row.url.includes('/'+day(ms).replace(/-/g,'/')+'/'))return null;
 const title=clean(row.title),brief=clean(row.brief),keywords=clean(row.keywords);
 if(!title||title.length>160||unsafe(title+brief+keywords))return null;
 if(q.space&&!/航天|空间站|火箭|卫星|神舟|天舟|探月/.test(title+' '+brief+' '+keywords))return null;
 return {title,url:row.url,date,brief,keywords};
}
function content(html:string,a:Article,q:Request):string|null {
 const title=clean(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1]??'');
 const info=/<div\b[^>]*class=["'][^"']*\binfo\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]??'';
 const stamp=/(20\d{2})年(\d{2})月(\d{2})日\s+(\d{2}:\d{2})/.exec(clean(info));
 if(title.replace(/\s/g,'')!==a.title.replace(/\s/g,'')||!stamp||`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}`!==a.date.slice(0,16))return null;
 const start=/<div\b[^>]*\bid=["']text_area["'][^>]*>/i.exec(html);if(!start)return null;
 const after=html.slice(start.index+start[0].length);let depth=1,end=-1;
 for(const m of after.matchAll(/<\/?div\b[^>]*>/gi)){depth+=m[0].startsWith('</')?-1:1;if(depth===0){end=m.index!;break;}}
 if(end<0)return null;const text=clean(after.slice(0,end));
 if(text.length<30||unsafe(text)||q.space&&!/航天|空间站|火箭|卫星|神舟|天舟|探月/.test(text))return null;
 return [...text].slice(0,3500).join('');
}
type Flight={controller:AbortController;promise:Promise<string>;users:number};
export class CctvNews {
 private fetcher:typeof fetch;private now:()=>number;private timeoutMs:number;
 private cache=new Map<string,{at:number;text:string}>();private flights=new Map<string,Flight>();private hits:number[]=[];
 constructor(o:{fetch?:typeof fetch;now?:()=>number;timeoutMs?:number}={}){this.fetcher=o.fetch??fetch;this.now=o.now??Date.now;this.timeoutMs=o.timeoutMs??6000;}
 supports(query:string){return request(query)!==null;}
 private async read(url:string,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();const cached=this.cache.get(url);if(cached&&this.now()-cached.at<60000)return cached.text;
  let f=this.flights.get(url);
  if(!f){
   this.hits=this.hits.filter(t=>t>this.now()-60000);if(this.hits.length>=30)throw new Error('news_rate_limit');this.hits.push(this.now());
   const controller=new AbortController();f={controller,users:0,promise:Promise.resolve('')};const flight=f;
   flight.promise=(async()=>{
    const budget=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]);
    const r=await this.fetcher(url,{redirect:'error',signal:budget,headers:{Accept:'text/html,application/javascript','User-Agent':'P003-personal-news-test/1.0'}});
    if(!r.ok){await r.body?.cancel();throw new Error('news_http_'+r.status);}const reader=r.body?.getReader();if(!reader)throw new Error('news_empty');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){budget.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw new Error('news_body_limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    budget.throwIfAborted();const text=Buffer.concat(chunks).toString('utf8');this.cache.set(url,{at:this.now(),text});if(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);return text;
   })().finally(()=>{if(this.flights.get(url)===flight)this.flights.delete(url);});this.flights.set(url,flight);
  }
  const flight=f;flight.users++;
  return new Promise((resolve,reject)=>{let done=false;const finish=(e:unknown,v?:string)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);if(--flight.users===0)flight.controller.abort();e?reject(e):resolve(v!);};const abort=()=>finish(signal.reason??new Error('aborted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();flight.promise.then(v=>finish(null,v),e=>finish(e));});
 }
 async run(query:string,signal:AbortSignal):Promise<NewsEvidence[]>{
  signal.throwIfAborted();const q=request(query);if(!q)return [];
  const budget=AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]);const found=new Map<string,Article>();
  for(const page of [1,2]){
   const raw=await this.read(`https://news.cctv.com/2019/07/gaiban/cmsdatainterface/page/china_${page}.jsonp?cb=china`,budget);
   const m=/^\s*china\((\{[\s\S]*\})\)\s*;?\s*$/.exec(raw);if(!m)throw new Error('news_payload');
   const rows=JSON.parse(m[1])?.data?.list;if(!Array.isArray(rows)||rows.length>100)throw new Error('news_payload');
   for(const row of rows){const a=article(row,this.now(),q);if(a)found.set(a.url,a);}
   // General daily bulletin needs only the first page. Space can search one older page.
   if(!q.space||found.size>=2)break;
  }
  const ranked=[...found.values()].sort((a,b)=>{
   if(q.space){const direct=(a:Article)=>/发射|卫星|火箭|空间站|神舟|天舟/.test(a.title)?1:0;const d=direct(b)-direct(a);if(d)return d;}
   return Date.parse(b.date)-Date.parse(a.date);
  });
  const evidence:NewsEvidence[]=[];
  for(const a of ranked.slice(0,2)){
   try {
    const html=await this.read(a.url,budget);const text=content(html,a,q);if(text)evidence.push({id:evidence.length+1,title:a.title,url:a.url,date:a.date,text});
   } catch(e) { budget.throwIfAborted(); if(!(e instanceof Error)||!/^news_http_404$/.test(e.message))throw e; }
  }
  return evidence;
 }
}
export const cctvNews=new CctvNews();
