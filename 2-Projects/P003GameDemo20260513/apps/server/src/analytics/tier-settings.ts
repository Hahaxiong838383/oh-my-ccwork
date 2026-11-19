import type {KeySpec} from '../config-store.js';
import type {DatabaseSync} from 'node:sqlite';
const bool=(label:string):KeySpec=>({builtinDefault:false,validate:v=>typeof v==='boolean',label,unit:'bool',hint:'按设备保存，默认关闭',min:0,max:1});
const int=(label:string,value:number,min:number,max:number,unit:'day'|'count'|'bytes'):KeySpec=>({builtinDefault:value,validate:v=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max,label,unit,hint:'客户端本地队列配置；不改变云端保留期',min,max});
export const TIER_CONFIG_KEYS:Record<string,KeySpec>={
 'analytics.tiering_enabled':bool('启用本地分层'),
 'analytics.aggregate_upload_enabled':bool('启用周期聚合'),
 'analytics.aggregate_period_days':int('聚合周期（本轮固定7天）',7,7,7,'day'),
 'analytics.aggregate_retention_days':int('本地聚合保留天数',90,14,180,'day'),
 'analytics.aggregate_max_buckets':int('本地聚合桶上限',2048,128,4096,'count'),
 'analytics.on_demand_capture_enabled':bool('捕获短期脱敏样本'),
 'analytics.on_demand_upload_enabled':bool('按需上传（请求管理控制）'),
 'analytics.on_demand_request_id':{builtinDefault:'',validate:v=>typeof v==='string'&&(v===''||/^diag-[a-f0-9-]{36}$/.test(v)),label:'服务端按需请求ID',unit:'text',hint:'由服务端生成，不能手填',min:0,max:96},
 'analytics.on_demand_retention_days':int('本地样本保留天数',3,1,14,'day'),
 'analytics.on_demand_max_events':int('本地样本条数上限',1000,100,2000,'count'),
 'analytics.on_demand_max_bytes':int('本地样本字节上限',2097152,262144,4194304,'bytes'),
 'analytics.request_gzip_enabled':bool('压缩上传请求'),
};
export const TIER_SETTING_NAMES=Object.keys(TIER_CONFIG_KEYS).map(k=>k.slice(10)).filter(k=>!['on_demand_request_id','on_demand_upload_enabled'].includes(k));
export type DiagnosticRequest={id:string;sn:string;created_at_ms:number;expires_at_ms:number;revoked_at_ms:number|null;allowed_event_names:string[];max_events:number;lookback_days:number};
export function initDiagnosticRequests(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS analytics_diagnostic_request (
 id TEXT PRIMARY KEY,sn TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER,
 allowed_event_names_json TEXT NOT NULL,max_events INTEGER NOT NULL,lookback_days INTEGER NOT NULL,created_by TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS analytics_diagnostic_request_sn ON analytics_diagnostic_request(sn,created_at_ms DESC);`);}
export function diagnosticRequests(db:DatabaseSync,sn:string):DiagnosticRequest[]{
 return (db.prepare('SELECT * FROM analytics_diagnostic_request WHERE sn=? ORDER BY created_at_ms DESC LIMIT 100').all(sn) as any[]).map(({allowed_event_names_json,created_by,...r})=>({...r,allowed_event_names:JSON.parse(allowed_event_names_json)}));
}
