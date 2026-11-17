import { durationText, observationSummary } from './observations';
import { businessItem } from './business-record';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export type AcquiredItem = { itemInstanceId: string; itemId: string; itemKind: string; quantity: number | null; state: string; activationRecordId: string | null };
export function dashboardDetails(value: unknown) {
 const data=obj(value),usage=obj(data.usage),ark=obj(data.ark),wallets=obj(ark.wallets),inventory=obj(ark.inventory),records=obj(data.records),income=obj(records.yesterdayIncome),latest=obj(records.latestItems),conversations=obj(data.conversations);
 const day=(v:unknown)=>{const d=obj(v);return {date:text(d.date),available:d.available===true,focusMinutes:count(d.focusMinutes),totalSeconds:count(d.totalSeconds),observedSeconds:count(d.observedSeconds),estimatedSeconds:count(d.estimatedSeconds),source:text(d.source),updatedAtMs:count(d.updatedAtMs)};};
 const history=obj(data.historicalUsage);
 const reported=obj(ark.reportedState),reportedWallets=obj(reported.wallets),reportedInventory=obj(reported.inventory),progress=obj(reported.progress),reward=obj(progress.nextReward),recent=obj(records.recentActivity);
 const items:AcquiredItem[]=list(latest.items).map(v=>{const i=obj(v);return {itemInstanceId:text(i.itemInstanceId),itemId:text(i.itemId),itemKind:text(i.itemKind),quantity:count(i.quantity),state:text(i.state),activationRecordId:typeof i.activationRecordId==='string'?i.activationRecordId:null};});
 return {
  usage:{today:day(usage.today),daily:list(usage.daily).map(day)},
  historicalUsage:{available:history.available===true,reason:text(history.reason),totalSeconds:count(history.totalSeconds),totalMinutes:count(history.totalMinutes),observedSeconds:count(history.observedSeconds),estimatedSeconds:count(history.estimatedSeconds),fromDay:text(history.fromDay),toDay:text(history.toDay),daily:list(history.daily).map(day),updatedAtMs:count(history.updatedAtMs)},
  observations:observationSummary(data.observations),
  reportedState:ark.reportedState&&reported.source==='device.ark.state'?{sourceMode:['normal','gm'].includes(text(reported.sourceMode))?text(reported.sourceMode):'unknown',snapshotId:text(reported.snapshotId),logicalDay:text(reported.logicalDay),capturedAtMs:count(reported.capturedAtMs),receivedAtMs:count(reported.receivedAtMs),familyCoin:count(reportedWallets.familyCoin),stardust:count(reportedWallets.stardust),cards:count(reportedInventory['M-CARD-001']),progress:{timerState:text(progress.timerState),claimableCount:count(progress.claimableCount),nextReward:{status:text(reward.status),kind:text(reward.kind),itemId:text(reward.itemId),stageId:text(reward.stageId),remainingSeconds:count(reward.remainingSeconds)}}}:null,
  recentActivity:{available:recent.available===true,reason:text(recent.reason),items:recent.available===true?list(recent.items).map(businessItem):[],hasMore:recent.hasMore===true,nextCursor:text(recent.nextCursor)||null,updatedAtMs:count(recent.updatedAtMs)},
  ark:{available:ark.available===true&&ark.sourceMode==='normal',reason:text(ark.reason),familyCoin:count(wallets.familyCoin),stardust:count(wallets.stardust),cards:count(inventory['M-CARD-001']),capturedAtMs:count(ark.capturedAtMs),receivedAtMs:count(ark.receivedAtMs)},
  income:{available:income.available===true&&income.sourceMode==='normal',reason:text(income.reason),date:text(income.date),familyCoin:count(income.familyCoin),stardust:count(income.stardust)},
  latest:{available:latest.available===true&&latest.sourceMode==='normal',reason:text(latest.reason),recordId:text(latest.recordId),saveId:text(latest.saveId),occurredAtMs:count(latest.occurredAtMs),items},
  recordsUpdatedAtMs:count(records.updatedAtMs),
  conversations:{available:conversations.available===true,reason:text(conversations.reason),messageCount:count(conversations.messageCount),userMessageCount:count(conversations.userMessageCount),assistantMessageCount:count(conversations.assistantMessageCount),firstMessageAtMs:count(conversations.firstMessageAtMs),lastMessageAtMs:count(conversations.lastMessageAtMs)},
 };
}
export type DashboardDetails=ReturnType<typeof dashboardDetails>;
export const sourceModeText=(mode:string)=>mode==='normal'?'正常来源':mode==='gm'?'测试来源（GM）':'来源未核实';
const shown=(available:boolean,value:number|null,suffix='')=>available&&value!==null?`${value}${suffix}`:'暂无数据';
const usageText=(day:DashboardDetails['usage']['today'])=>day.available&&day.totalSeconds!==null?durationText(day.totalSeconds):shown(day.available,day.focusMinutes,' 分钟');
export function detailsView(d:DashboardDetails){return {today:usageText(d.usage.today),daily:d.usage.daily.map(x=>({date:x.date,value:usageText(x)})),historicalUsage:d.historicalUsage.available?durationText(d.historicalUsage.totalSeconds):'暂无数据',familyCoin:shown(d.ark.available,d.ark.familyCoin),stardust:shown(d.ark.available,d.ark.stardust),cards:shown(d.ark.available,d.ark.cards,' 张'),incomeFamilyCoin:shown(d.income.available,d.income.familyCoin),incomeStardust:shown(d.income.available,d.income.stardust),latestItems:d.latest.available?d.latest.items:[],conversationCount:d.conversations.available&&d.conversations.messageCount!==null?`已同步 ${d.conversations.messageCount} 条`:'暂无数据'};}
export function unavailableText(reason:string){const labels:Record<string,string>={no_records:'暂无已同步记录',no_observations:'尚无已同步历史上报',no_snapshot:'暂无有效快照',non_normal:'当前来源不可作为正常业务数据',clock_unknown:'时间信息不完整，暂不能确认最新物品',not_enabled:'该能力暂未开放',dependency_unavailable:'数据暂时读取失败，请刷新重试',identity_mismatch:'设备归属或授权已变化，请刷新设备列表',partial_history:'仅含已同步记录，历史可能不完整',policy_pending:'展示口径尚未就绪'};return labels[reason]||'暂无可用数据';}
