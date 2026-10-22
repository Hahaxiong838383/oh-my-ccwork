import { timingSafeEqual } from 'node:crypto';
import { configStore } from '../config-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { buildDeviceBase, deviceAddendum, getDevicePromptConfig } from '../device-brain-prompt.js';
import { createSearchRoute } from '../routes/search-tasks.js';
import { SearchTasks } from './search-tasks.js';
import { SearchAvailability } from './search-availability.js';
import { RoutingStore } from './search-routing-store.js';
import { MojiWeather,weatherRequestSchema } from './moji-weather.js';
import { searchCapabilityBase } from './search-chat-policy.js';
import { SearchExecutor } from './search-executor.js';

let instance: SearchTasks | null = null;
let routingStore:RoutingStore|null=null;
const weather=new MojiWeather();
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
    instance = new SearchTasks({ canSubmit: r => Boolean(r?.weather_enabled&&r.weather)||availability.available(), dbPath: process.env.SEARCH_TASK_DB_PATH!, enabled: () => searchSettings().enabled,
      resolveRouting:(owner,claim)=>{
        const snapshot=getSearchRoutingStore()?.resolve(owner.subject,claim.version);if(!snapshot)throw new Error('routing_version_unknown');
        if(!['builtin-explicit','builtin-control','weather-city-followup','builtin-fallback'].includes(claim.rule_id)&&!snapshot.config.rules.some(r=>r.id===claim.rule_id&&r.enabled))throw new Error('routing_version_scope');
        return {...claim,weather:claim.weather?weatherRequestSchema.parse(claim.weather):undefined,weather_enabled:snapshot.config.weather_enabled};
      },
      allowed: s => searchSettings().allowed.includes(s) && deviceRegistryStore.statusOf(s) === 'active',
      execute: async (query, signal, owner) => {
        const record = deviceRegistryStore.get(owner.subject);
        if (!record?.account_id || record.status !== 'active') throw new Error('device_unavailable');
        if(owner.routing?.weather_enabled&&owner.routing.weather){
          try {const result=await weather.run(owner.routing.weather,signal,owner.createdAt);console.info('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,...result.weather}));return result;}
          catch{console.warn('[search-weather]',JSON.stringify({task_id:owner.id,version:owner.routing.version,outcome:'unavailable'}));throw new Error('weather_unavailable');}
        }
        const cfg = getDevicePromptConfig(record.account_id);
        try {
          const result = await new SearchExecutor({ apiKey: process.env.DEEPSEEK_API_KEY!, domains: domains(), tools: searchSettings().tools, audit: stats => console.info('[search-filter]', JSON.stringify({task_id: 'id' in owner ? owner.id : undefined, ...stats})) })
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
export function closeSearchRuntime() { if (timer) clearInterval(timer); timer = null; instance?.close(); instance = null; routingStore?.close();routingStore=null; }
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
