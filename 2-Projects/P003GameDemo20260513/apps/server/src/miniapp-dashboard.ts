import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {telemetryStore, dayOf} from './telemetry-store.js';
import {deviceRegistryStore} from './device-registry-store.js';
import {accountStore} from './account-store.js';
import {dashboardArk} from './ark/dashboard.js';
import {arkStore, arkCeiling} from './ark/service.js';
import {recordsDashboard, recordsStore, recordsAllowed, legacyUploadConfigAllowed} from './ark/records-service.js';
import {QuerySchema, RecordsError} from './ark/records-contract.js';
import {parentConversationSummary, readParentConversations} from './parent-conversations.js';
import {configStore} from './config-store.js';
import {otaStore} from './ota-store.js';

export class MiniappReadError extends Error {
 constructor(public status: 404 | 503, code: string) { super(code); }
}
const ONLINE_WINDOW_MS = 10 * 60_000;
function dateAdd(day: string, deltaDays: number): string {
 return new Date(Date.parse(`${day}T00:00:00+08:00`) + deltaDays * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
}
/** Authority is deliberately re-read outside the domain readers' transactions.
 * Monotonic binding/epoch detect A→B→A; grant ID/revision detect same-owner reauthorization.
 * No fingerprint or raw authorization configuration is returned to the browser.
 */
function accountRole(accountId:string) {
 return accountStore.findAccount(accountId)?.role ?? null;
}
/** Match the conversation/legacy scope's uniqueness rule, including disabled sibling devices.
 * A fresh read-only connection observes registry writers after a domain released its WAL snapshot.
 */
function accountUses(accountId:string|null):number {
 if(!accountId)return 0;
 const db=new DatabaseSync(resolve(process.env.DEVICES_DB_PATH?.trim()||'./data/devices.db'),{readOnly:true});
 try {
  const row=db.prepare('SELECT COUNT(*) account_uses FROM device_registry WHERE account_id=?').get(accountId) as {account_uses:number};
  return row.account_uses;
 } finally { db.close(); }
}
function authority(publicId: string, accountId: string, expectedBinding?: ReturnType<typeof binding>): string {
 const d = deviceRegistryStore.getByPublicId(publicId);
 if (!d || d.parent_account_id !== accountId) throw new MiniappReadError(404, 'not_found');
 if (expectedBinding && (['sn','public_id','parent_account_id','binding_version','status'] as const).some(key=>d[key]!==expectedBinding[key])) throw new MiniappReadError(404,'not_found');
 const ownerRole=accountRole(accountId);
 if (ownerRole!=='parent') throw new MiniappReadError(404,'not_found');
 const identity = deviceRegistryStore.arkIdentity(d.sn);
 const arkEnabled = arkCeiling().includes(d.sn);
 const store = arkEnabled ? arkStore() : null;
 return JSON.stringify({sn:d.sn, public_id:d.public_id, owner:d.parent_account_id,
  account_id:d.account_id, account_uses:accountUses(d.account_id), binding_version:d.binding_version, status:d.status, identity,
  owner_role:ownerRole,
  device_role:d.account_id ? accountRole(d.account_id) : null,
  ark_enabled:arkEnabled, settings:store?.settings() ?? null,
  grant:store?.db.prepare('SELECT * FROM ark_grant WHERE sn=?').get(d.sn) ?? null,
  records_enabled:recordsAllowed(d.sn),
  legacy_scope:process.env.ARK_RECORDS_LEGACY_SCOPE_JSON ?? null,
  conversation_scope:process.env.PARENT_CONVERSATION_SCOPE_JSON ?? null});
}

/** Current parent's live dashboard, preserving the existing parent API degradation contract.
 * The admin consumers below additionally guard the complete aggregate authority tuple. */
export function readParentDashboard(publicId: string, accountId: string, authRole: string, now = Date.now()) {
 const dev = deviceRegistryStore.getByPublicId(publicId);
 if (!dev || dev.parent_account_id !== accountId) throw new MiniappReadError(404, 'not_found');
  const today = dayOf(now);
  const weekFrom = dateAdd(today, -6);
  const daily = telemetryStore.dailyRange(dev.sn, weekFrom, today);
  const todayRow = daily.find((d) => d.date === today);
  const snap = telemetryStore.latestSnapshot(dev.sn);
  const p = snap?.payload;

  // 周日均：只除以已经过的自然日数（合同 §7.1：避免未来天数稀释）
  const totalFocusMin = Math.round(daily.reduce((s, d) => s + d.focus_ms, 0) / 60_000);
  const elapsedDays = daily.filter((d) => d.date < today).length || 1;

  const usageDaily = telemetryStore.usageRange(dev.sn, weekFrom, today);
  let ark: ReturnType<typeof dashboardArk>;
  let records: ReturnType<typeof recordsDashboard>;
  try { ark = dashboardArk(dev.sn); records = recordsDashboard(publicId, accountId); }
  catch { throw new MiniappReadError(503, 'dashboard_dependency_unavailable'); }
  const currentOwner = deviceRegistryStore.getByPublicId(publicId);
  if (!currentOwner || currentOwner.parent_account_id !== accountId || currentOwner.sn !== dev.sn) throw new MiniappReadError(404, 'not_found');
  const data = {
      ark,
      records,
      conversations: parentConversationSummary(publicId, accountId, authRole),
      usage: { source: 'telemetry.focus_segment', timezone: 'Asia/Shanghai',
        today: usageDaily[usageDaily.length - 1], daily: usageDaily },
      device: {
        updated_at_ms: snap?.server_received_ms ?? null,
        online: snap ? now - snap.server_received_ms < ONLINE_WINDOW_MS : false,
        lid_open: p?.lid_open ?? null,
        present: p?.present ?? null,
        brightness_level: p?.brightness_level ?? null,
        color_mode: p?.color_mode ?? null,
        image_distance_m: p?.image_distance_m ?? null,
        image_distance_state: p?.image_distance_state ?? null,
      },
      today: {
        focus_minutes: Math.round((todayRow?.focus_ms ?? 0) / 60_000),
        guarded_minutes: Math.round((todayRow?.guarded_ms ?? 0) / 60_000),
        posture_alert_count: todayRow?.reminder_played ?? 0,
      },
      week: {
        total_focus_minutes: totalFocusMin,
        daily_average_focus_minutes: Math.round(
          daily.filter((d) => d.date < today).reduce((s, d) => s + d.focus_ms, 0) / 60_000 / elapsedDays,
        ),
        daily: (() => {
          const map = new Map(daily.map((d) => [d.date, d]));
          const out: Array<{ date: string; focus_minutes: number }> = [];
          for (let i = -6; i <= 0; i += 1) {
            const day = dateAdd(today, i);
            out.push({ date: day, focus_minutes: Math.round((map.get(day)?.focus_ms ?? 0) / 60_000) });
          }
          return out;
        })(),
      },
      availability: { night_reward: false, percentile: false },
  };
  return data;
}

function binding(sn:string) {
 const d=deviceRegistryStore.get(sn);
 if(!d)throw new MiniappReadError(404,'not_found');
 return {sn:d.sn,public_id:d.public_id,parent_account_id:d.parent_account_id,
  parent_phone:d.parent_account_id?accountStore.findAccount(d.parent_account_id)?.phone??null:null,
  binding_version:d.binding_version,brain_opened:!!d.account_id,status:d.status,note:d.note};
}
function adminOwner(sn:string){
 const d=deviceRegistryStore.get(sn);
 if(!d?.public_id||!d.parent_account_id)throw new MiniappReadError(404,'not_found');
 const owner=accountStore.findAccount(d.parent_account_id);
 if(!owner||owner.role!=='parent')throw new MiniappReadError(404,'not_found');
 return {publicId:d.public_id,owner:owner.id,role:owner.role};
}
function integration(sn:string,conversations:{available:boolean;reason:string|null}|undefined) {
 let upload_config;
 try {
  const config=configStore.effectiveSnapshot(sn),r=config.ark_records as {enabled:boolean;contract_id:string}|undefined;
  upload_config={available:true,reason:null,source:'device_config',revision:config.revision,
   ark_records:r?{configured_enabled:r.enabled,effective_enabled:r.enabled&&legacyUploadConfigAllowed(sn),contract_id:r.contract_id}:null};
 } catch { upload_config={available:false,reason:'dependency_unavailable',source:'device_config',revision:null,ark_records:null}; }
 let reported_version;
 try {
  const r=otaStore.listDeviceStatus().find(d=>d.sn===sn);
  reported_version={available:!!r,reason:r?null:'no_report',source:'ota_device_status',version_code:r?.version_code??null,
   version_name:r?.version_name??null,reported_at_ms:r?.last_check_at??null};
 } catch { reported_version={available:false,reason:'dependency_unavailable',source:'ota_device_status',version_code:null,version_name:null,reported_at_ms:null}; }
 const identity=deviceRegistryStore.arkIdentity(sn),enabled=arkCeiling().includes(sn)&&arkStore().settings().enabled;
 return {upload_config,reported_version,history_authorization:{ark:{enabled,authorized:!!(enabled&&identity&&accountRole(identity.account_id)==='device'&&arkStore().grant(identity))},
  records:{enabled:recordsAllowed(sn)},conversations:conversations?{available:conversations.available,reason:conversations.reason}:{available:false,reason:'not_enabled'}}};
}
export function readAdminMiniappDashboard(sn:string,now=Date.now()) {
 const b=binding(sn),owner=b.parent_account_id?accountStore.findAccount(b.parent_account_id):null;
 const reason=!b.parent_account_id?'unbound':owner?.role!=='parent'?'parent_account_invalid':null;
 if(reason||!b.public_id)return {ok:true,binding:b,observed_at_ms:now,data:null,reason:reason??'unbound',integration:integration(sn,undefined)};
 const before=authority(b.public_id,b.parent_account_id!,b);
 const data=readParentDashboard(b.public_id,b.parent_account_id!,owner!.role,now);
 const meta=integration(sn,data.conversations);
 if(authority(b.public_id,b.parent_account_id!)!==before)throw new MiniappReadError(404,'not_found');
 return {ok:true,binding:b,observed_at_ms:now,data,reason:null,integration:meta};
}
export function readAdminMiniappRecords(sn:string,params:URLSearchParams) {
 const {publicId,owner}=adminOwner(sn),before=authority(publicId,owner);
 if([...params.keys()].some(k=>params.getAll(k).length!==1))throw new RecordsError(400,'invalid_query');
 const query=QuerySchema.safeParse(Object.fromEntries(params));if(!query.success)throw new RecordsError(400,'invalid_query');
 const data=recordsStore().page(publicId,owner,query.data);
 if(authority(publicId,owner)!==before)throw new MiniappReadError(404,'not_found');
 return data;
}
export function readAdminMiniappConversations(sn:string,params:URLSearchParams) {
 const {publicId,owner,role}=adminOwner(sn),before=authority(publicId,owner);
 const data=readParentConversations(publicId,owner,role,params);
 if(authority(publicId,owner)!==before)throw new MiniappReadError(404,'not_found');
 return data;
}
