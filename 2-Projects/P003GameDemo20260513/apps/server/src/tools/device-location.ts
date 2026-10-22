import {BlockList,isIP} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
const blocked=new BlockList(),blocked6=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001:db8::',32],['2001::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]] as const)blocked6.addSubnet(ip,bits,'ipv6');
export function publicIp(value:unknown):string|null {
 if(typeof value!=='string'||value.length>45||value.trim()!==value||value.includes('%'))return null;
 const family=isIP(value);if(!family||(family===4?blocked:blocked6).check(value,family===4?'ipv4':'ipv6'))return null;
 return family===4?value:new URL(`http://[${value}]/`).hostname.slice(1,-1);
}
/** Nginx must overwrite X-Real-IP. Never take XFF[0] or the caller of the Worker API. */
export function trustedDeviceIp(peer:unknown,host:unknown,xRealIp:unknown):string|null {
 return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(String(peer))&&host==='kidshub-ai.hahaxiong.cc'?publicIp(xRealIp):null;
}
export type DeviceCity={provider:'ip9';city:string;province:string};
const municipalities=['北京','上海','天津','重庆'];
const provinces:Record<string,string>={北京:'北京',上海:'上海',沈阳:'辽宁',大连:'辽宁',广州:'广东',深圳:'广东',杭州:'浙江',天津:'天津',重庆:'重庆'};
const failure=(code:string):never=>{throw new Error(code);};
function parseCity(raw:any,ip:string):DeviceCity {
 const d=raw?.data;
 if(raw?.ret!==200||publicIp(d?.ip)!==ip||d?.country_code!=='cn')return failure('location_payload');
 if(typeof d.city!=='string'||typeof d.prov!=='string'||!/^[\u4e00-\u9fff]{2,24}$/.test(d.city)||!/^[\u4e00-\u9fff]{2,24}$/.test(d.prov))return failure('location_city_missing');
 const city=d.city.replace(/市$/,''),province=d.prov.replace(/[省市]$/,'');
 if((provinces[city]&&provinces[city]!==province)||(municipalities.includes(province)&&city!==province))return failure('location_city_mismatch');
 return {provider:'ip9',city:/(?:自治州|地区|盟|区|县)$/.test(city)?city:city+'市',province};
}
export class Ip9Location {
 private cache=new Map<string,{until:number;city?:DeviceCity}>();private flights=new Map<string,Promise<DeviceCity>>();private hits:number[]=[];
 private now:()=>number;private fetcher:typeof fetch;private timeoutMs:number;
 constructor(o:{now?:()=>number;fetch?:typeof fetch;timeoutMs?:number}={}){this.now=o.now??Date.now;this.fetcher=o.fetch??fetch;this.timeoutMs=o.timeoutMs??3500;}
 async lookup(value:string):Promise<DeviceCity> {
  const ip=publicIp(value);if(!ip)return failure('location_invalid_ip');
  const cached=this.cache.get(ip);if(cached&&cached.until>this.now()){if(!cached.city)return failure('location_cooldown');return {...cached.city};}
  const running=this.flights.get(ip);if(running)return running;
  this.hits=this.hits.filter(t=>t>this.now()-60000);if(this.hits.length>=30)return failure('location_rate_limit');this.hits.push(this.now());
  const flight=this.query(ip).then(city=>{this.cache.set(ip,{city,until:this.now()+6*3600000});return city;},e=>{this.cache.set(ip,{until:this.now()+60000});throw e;}).finally(()=>{this.flights.delete(ip);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);});
  this.flights.set(ip,flight);return flight;
 }
 private async query(ip:string):Promise<DeviceCity> {
  const signal=AbortSignal.timeout(this.timeoutMs);
  try {
   const r=await this.fetcher('https://ip9.com.cn/get?ip='+encodeURIComponent(ip),{redirect:'error',signal,headers:{Accept:'application/json','User-Agent':'P003-personal-location-test/1.0'}});
   if(!r.ok){await r.body?.cancel();return failure('location_upstream');}
   const reader=r.body?.getReader();if(!reader)return failure('location_empty');
   let size=0;const parts:Uint8Array[]=[];
   try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384)return failure('location_body_limit');parts.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   signal.throwIfAborted();return parseCity(JSON.parse(Buffer.concat(parts).toString('utf8')),ip);
  }catch(e){if(signal.aborted)return failure('location_timeout');if(e instanceof Error&&/^location_/.test(e.message))throw e;return failure('location_unavailable');}
 }
}
export type LocationView={state:'unknown'|'pending'|'ready'|'failed'|'expired';city?:string;province?:string;provider?:'ip9';observed_at?:number;expires_at?:number;reason?:string};
type Row={sn:string;room:string;request:string;state:string;city:string|null;province:string|null;observed:number;expires:number;reason:string|null};
export class DeviceLocationStore {
 private db:DatabaseSync;
 constructor(path:string,private now:()=>number=Date.now){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; CREATE TABLE IF NOT EXISTS device_location(room TEXT PRIMARY KEY,sn TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,city TEXT,province TEXT,observed INTEGER NOT NULL,expires INTEGER NOT NULL,reason TEXT); CREATE INDEX IF NOT EXISTS location_subject ON device_location(sn,observed);`);}
 begin(sn:string,room:string,expires:number):string {
  if(!/^BJP003\d{14}$/.test(sn)||!new RegExp('^sn-'+sn+'-\\d{1,20}$').test(room)||!Number.isFinite(expires)||expires<=this.now())return failure('location_scope');
  const request=randomUUID();this.db.prepare('DELETE FROM device_location WHERE expires<?').run(this.now()-3600000);
  this.db.prepare("INSERT INTO device_location VALUES(?,?,?,'pending',NULL,NULL,?,?,NULL) ON CONFLICT(room) DO UPDATE SET sn=excluded.sn,request=excluded.request,state='pending',city=NULL,province=NULL,observed=excluded.observed,expires=excluded.expires,reason=NULL").run(room,sn,request,this.now(),Math.min(expires,this.now()+3600000));return request;
 }
 finish(request:string,city:DeviceCity){this.db.prepare("UPDATE device_location SET state='ready',city=?,province=?,observed=?,reason=NULL WHERE request=? AND expires>?").run(city.city,city.province,this.now(),request,this.now());}
 fail(request:string,reason:string){const safe=/^location_[a-z_]{1,40}$/.test(reason)?reason:'location_unavailable';this.db.prepare("UPDATE device_location SET state='failed',reason=? WHERE request=?").run(safe,request);}
 private view(row:Row|undefined):LocationView {
  if(!row)return {state:'unknown',reason:'location_no_session'};
  if(row.expires<=this.now())return {state:'expired',observed_at:row.observed,expires_at:row.expires,reason:'location_expired'};
  return {state:row.state as LocationView['state'],observed_at:row.observed,expires_at:row.expires,...(row.state==='ready'?{city:row.city!,province:row.province!,provider:'ip9' as const}:{}),...(row.reason?{reason:row.reason}:{})};
 }
 get(sn:string,room:string):LocationView{return this.view(this.db.prepare('SELECT * FROM device_location WHERE sn=? AND room=?').get(sn,room) as Row|undefined);}
 async wait(sn:string,room:string,signal:AbortSignal):Promise<LocationView>{
  const start=Date.now();for(;;){signal.throwIfAborted();const v=this.get(sn,room);if(v.state!=='pending'||Date.now()-start>=3600)return v;
   await new Promise<void>((resolve,reject)=>{const t=setTimeout(done,50);function done(){signal.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);signal.removeEventListener('abort',abort);reject(signal.reason);}signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  }
 }
 summary(sns:string[]){return sns.map(sn=>{const row=this.db.prepare('SELECT * FROM device_location WHERE sn=? ORDER BY observed DESC,rowid DESC LIMIT 1').get(sn) as Row|undefined;return {sn,...this.view(row),session_digest:row?createHash('sha256').update(row.room).digest('hex').slice(0,12):null};});}
 close(){this.db.close();}
}
