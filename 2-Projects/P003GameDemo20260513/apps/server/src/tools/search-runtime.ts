import { readResumeAuthority } from './search-resume-scope.js';
import { searchDialogueInstruction } from './search-dialogue-context.js';
import { timingSafeEqual } from 'node:crypto';
import { configStore } from '../config-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { buildDeviceBase, deviceAddendum, getDevicePromptConfig } from '../device-brain-prompt.js';
import { createSearchRoute } from '../routes/search-tasks.js';
import { SearchTasks } from './search-tasks.js';
import { SearchAvailability } from './search-availability.js';
import { RoutingStore } from './search-routing-store.js';
import { MojiWeather,weatherRequestSchema,autoWeatherSchema,MOJI_CITIES } from './moji-weather.js';
import {placeWeatherSchema,type PlaceWeatherRequest} from './baidu-weather.js';
import {FixedWeather} from './fixed-weather.js';
import {getDeviceLocationStore,closeDeviceLocationRuntime} from './device-location-runtime.js';
import { searchCapabilityBase } from './search-chat-policy.js';
import { SearchExecutor } from './search-executor.js';

let instance: SearchTasks | null = null;
let routingStore:RoutingStore|null=null;
const weather=new MojiWeather();
const expandedWeather=new FixedWeather();
async function expandedResult(q:PlaceWeatherRequest,signal:AbortSignal,owner:import('./search-tasks.js').SearchTask,context?:{province?:string}){
 try{return await expandedWeather.run(q,signal,owner.createdAt,context);}
 catch(e){signal.throwIfAborted();const code=e instanceof Error&&/^weather_[a-z_0-9]+$/.test(e.message)?e.message:'weather_unavailable';console.info('[search-weather]',JSON.stringify({task_id:owner.id,outcome:'unavailable',reason:code}));
  return {text:code==='weather_place_ambiguous'?'这个地名对应多个地区，请补充省份并再问一次天气。':code==='weather_metric_unsupported'?'这个地区的空气质量数据还没有完成校验，这次先不报数值。':code==='weather_place_unknown'?'暂时没有找到可确认的天气地点，请补充省市后再试。':'这次天气数据暂时没能通过地点或时效校验，我先不报未经确认的结果。',sources:[]};
 }
}
export function getSearchRoutingStore(){
 if(!process.env.SEARCH_CANARY_ROOT||!process.env.SEARCH_ROUTING_DB_PATH)return null;
 return routingStore??=new RoutingStore(process.env.SEARCH_ROUTING_DB_PATH);
}
const availability = new SearchAvailability();
let timer: ReturnType<typeof setInterval> | null = null;
const domains = () => (process.env.SEARCH_ALLOWED_DOMAINS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
export function searchSettings() {
  let allowed: string[] = [];
  try { const v = JSON.parse(configStore.getFlag('p003.search.allowlist')?.value ?? '[]'); if (Array.isArray(v)) allowed = v.filter((s: unknown) => typeof s === 'string' && /^BJP003\d{14}$/.test(s)); } catch { /* fail closed */ }
  const configured = process.env.SEARCH_ENABLED === '1' && Boolean(process.env.SEARCH_TASK_DB_PATH && process.env.DEEPSEEK_API_KEY && process.env.AUTH_JWT_SECRET && process.env.SEARCH_WORKER_ACCOUNT_ID?.trim() && domains().length);
  return { configured, enabled: configured && configStore.getFlag('p003.search.enabled')?.value === '1' && (!process.env.SEARCH_CANARY_ROOT || Number(configStore.getFlag('p003.search.canary.expires_at_ms')?.value) > Date.now()), allowed,
    tools: configStore.getFlag('p003.search.tools')?.value === '1', upstream: availability.state() };
}
export function getSearchTasks(): SearchTasks | null {
  const settings = searchSettings();
  if (!settings.enabled) { instance?.tick(); return null; }
  if (!instance) {
    instance = new SearchTasks({
      resumeEnabled:()=>Boolean(process.env.SEARCH_CANARY_ROOT)&&process.env.SEARCH_RESUME_V1==='1',
      resumeScope:o=>readResumeAuthority(process.env.SEARCH_RESUME_AUTHORITY_DB_PATH,o.subject,deviceRegistryStore.get(o.subject)?.account_id??null),
      windowDeadline:()=>Number(configStore.getFlag('p003.search.canary.expires_at_ms')?.value)||0,
      canSubmit: r => Boolean(r?.weather_enabled&&(r.weather||r.baidu_weather_enabled&&r.place_weather||r.auto_location_enabled&&r.auto_weather))||availability.available(), dbPath: process.env.SEARCH_TASK_DB_PATH!, enabled: () => searchSettings().enabled,
      resolveRouting:(owner,claim)=>{
        const snapshot=getSearchRoutingStore()?.resolve(owner.subject,claim.version);if(!snapshot)throw new Error('routing_version_unknown');
        if(!['builtin-explicit','builtin-control','weather-city-followup','builtin-fallback'].includes(claim.rule_id)&&!snapshot.config.rules.some(r=>r.id===claim.rule_id&&r.enabled))throw new Error('routing_version_scope');
        if(claim.auto_weather&&(!snapshot.config.auto_location_enabled||!snapshot.config.weather_enabled))throw new Error('routing_version_scope');
        if(claim.place_weather&&(!snapshot.config.baidu_weather_enabled||!snapshot.config.weather_enabled))throw new Error('routing_version_scope');
        return {...claim,weather:claim.weather?weatherRequestSchema.parse(claim.weather):undefined,auto_weather:claim.auto_weather?autoWeatherSchema.parse(claim.auto_weather):undefined,place_weather:claim.place_weather?placeWeatherSchema.parse(claim.place_weather):undefined,weather_enabled:snapshot.config.weather_enabled,auto_location_enabled:snapshot.config.auto_location_enabled===true,baidu_weather_enabled:snapshot.config.baidu_weather_enabled===true};
      },
      allowed: s => searchSettings().allowed.includes(s) && deviceRegistryStore.statusOf(s) === 'active',
      execute: async (query, signal, owner) => {
        const record = deviceRegistryStore.get(owner.subject);
        if (!record?.account_id || record.status !== 'active') throw new Error('device_unavailable');
        if(owner.routing?.weather_enabled&&owner.routing.auto_location_enabled&&owner.routing.auto_weather){
          const location=await getDeviceLocationStore()?.wait(owner.subject,owner.session,signal);signal.throwIfAborted();
          if(location?.state!=='ready') {console.info('[search-location]',JSON.stringify({task_id:owner.id,outcome:location?.state??'unknown',reason:location?.reason??'location_no_session'}));return {text:'暂时没能根据设备网络确定所在城市，这次先不报天气，稍后可以再试。',sources:[]};}
          if(owner.routing.baidu_weather_enabled){
            const result=await expandedResult({...owner.routing.auto_weather,place:location.city!},signal,owner,{province:location.province});
            result.text='按设备网络定位，'+result.text;
            console.info('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,city_source:'device_ip',location_provider:'ip9',location_observed_at:location.observed_at,...('weather'in result?result.weather:{})}));return result;
          }
          const city=MOJI_CITIES.find(c=>c.name===location.city);
          if(!city){console.info('[search-location]',JSON.stringify({task_id:owner.id,outcome:'unsupported_city',city:location.city}));return {text:`设备网络定位到${location.city}，目前还不能可靠查询这个城市的天气。`,sources:[]};}
          const result=await weather.run({...owner.routing.auto_weather,city_id:city.id,city_name:city.name},signal,owner.createdAt);
          result.text='按设备网络定位，'+result.text;
          console.info('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,city_source:'device_ip',location_provider:'ip9',location_observed_at:location.observed_at,...result.weather}));return result;
        }
        if(owner.routing?.weather_enabled&&owner.routing.baidu_weather_enabled&&owner.routing.place_weather){
          const location=getDeviceLocationStore()?.get(owner.subject,owner.session);
          const result=await expandedResult(owner.routing.place_weather,signal,owner,location?.state==='ready'?{province:location.province}:undefined);
          console.info('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,city_source:'explicit',...('weather'in result?result.weather:{})}));return result;
        }
        if(owner.routing?.weather_enabled&&owner.routing.weather){
          try {const result=await weather.run(owner.routing.weather,signal,owner.createdAt);console.info('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,...result.weather}));return result;}
          catch{console.warn('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,outcome:'unavailable'}));throw new Error('weather_unavailable');}
        }
        const cfg = getDevicePromptConfig(record.account_id);
        try {
          const result = await new SearchExecutor({ grounding: Boolean(process.env.SEARCH_CANARY_ROOT), apiKey: process.env.DEEPSEEK_API_KEY!, domains: domains(), tools: searchSettings().tools, audit: stats => console.info('[search-filter]', JSON.stringify({task_id: 'id' in owner ? owner.id : undefined, ...stats})) })
            .run(query, signal, searchCapabilityBase(buildDeviceBase(cfg),Boolean(process.env.SEARCH_CANARY_ROOT)) + '\n' + (deviceAddendum(cfg) ?? ''));
          availability.success(); return result;
        } catch (e) {
          const code = e instanceof Error ? e.message : 'search_unavailable';
          availability.failure(code);
          if (/^upstream_(402|429|5\d\d)$/.test(code)) console.warn('[search] ' + code);
          throw e;
        }
      } });
    timer = setInterval(() => { try { instance?.tick(); } catch { console.error('[search] ledger_tick_failed'); } }, 250);
    timer.unref();
  }
  return instance;
}
export function closeSearchRuntime() { if (timer) clearInterval(timer); timer = null; instance?.close(); instance = null; routingStore?.close();routingStore=null; closeDeviceLocationRuntime(); }
export function searchAudit() { return { loaded: instance !== null, tasks: instance?.audit() ?? [] }; }

export const searchTaskRoute = createSearchRoute({ tasks: getSearchTasks, routing:{get:o=>{if(!searchSettings().allowed.includes(o.subject))throw new Error('disabled');return getSearchRoutingStore()?.snapshot(o.subject)??null;},ack:(o,v)=>{if(!searchSettings().allowed.includes(o.subject))throw new Error('disabled');const store=getSearchRoutingStore();if(!store)throw new Error('disabled');store.ack(o.subject,v,o.session);}}, owner: async c => {
  // Worker JWT stays in a header, not a URL/access log. No anonymous or parent fallback.
  if (!process.env.AUTH_JWT_SECRET) return null;
  const auth = await verifyAuthToken(c.req.header('x-p003-worker-token'));
  if (auth?.role !== 'device' || !process.env.SEARCH_WORKER_ACCOUNT_ID?.trim() || auth.accountId !== process.env.SEARCH_WORKER_ACCOUNT_ID.trim()) return null;
  const key = process.env.CUSTOM_LLM_API_KEY?.trim();
  if (key) {
    const got = c.req.header('authorization') ?? '';
    const wanted = `Bearer ${key}`;
    if (Buffer.byteLength(got) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(got), Buffer.from(wanted))) return null;
  }
  const room = c.req.query('room') ?? '';
  const sn = /^sn-(BJP003\d{14})-\d{1,20}$/.exec(room)?.[1];
  if (!sn) return null;
  try {
    const device = deviceRegistryStore.get(sn);
    return device?.status === 'active' && device.account_id ? { subject: sn, session: room } : null;
  } catch { return null; }
} });

export function currentSearchDialogue(value:unknown,auth:{role:string;accountId:string}|null,room:string){
 if(process.env.P003_SEARCH_CONTEXT_V1!=='1'||!process.env.SEARCH_CANARY_ROOT||!instance||auth?.role!=='device'||auth.accountId!==process.env.SEARCH_WORKER_ACCOUNT_ID?.trim())return '';
 const subject=/^sn-(BJP003\d{14})-\d{1,20}$/.exec(room)?.[1];
 if(!subject)return '';
 return searchDialogueInstruction(value,{subject,session:room},(o,id,rev,grant)=>instance!.dialogueContext(o,id,rev,grant));
}
