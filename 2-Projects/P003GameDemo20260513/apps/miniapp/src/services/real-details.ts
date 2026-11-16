type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export type AcquiredItem = { itemInstanceId: string; itemId: string; itemKind: string; quantity: number | null; state: string; activationRecordId: string | null };
export function dashboardDetails(value: unknown) {
 const data=obj(value),usage=obj(data.usage),ark=obj(data.ark),wallets=obj(ark.wallets),inventory=obj(ark.inventory),records=obj(data.records),income=obj(records.yesterdayIncome),latest=obj(records.latestItems),conversations=obj(data.conversations);
 const day=(v:unknown)=>{const d=obj(v);return {date:text(d.date),available:d.available===true,focusMinutes:count(d.focusMinutes),updatedAtMs:count(d.updatedAtMs)};};
 const items:AcquiredItem[]=list(latest.items).map(v=>{const i=obj(v);return {itemInstanceId:text(i.itemInstanceId),itemId:text(i.itemId),itemKind:text(i.itemKind),quantity:count(i.quantity),state:text(i.state),activationRecordId:typeof i.activationRecordId==='string'?i.activationRecordId:null};});
 return {
  usage:{today:day(usage.today),daily:list(usage.daily).map(day)},
  ark:{available:ark.available===true&&ark.sourceMode==='normal',reason:text(ark.reason),familyCoin:count(wallets.familyCoin),stardust:count(wallets.stardust),cards:count(inventory['M-CARD-001']),capturedAtMs:count(ark.capturedAtMs),receivedAtMs:count(ark.receivedAtMs)},
  income:{available:income.available===true&&income.sourceMode==='normal',reason:text(income.reason),date:text(income.date),familyCoin:count(income.familyCoin),stardust:count(income.stardust)},
  latest:{available:latest.available===true&&latest.sourceMode==='normal',reason:text(latest.reason),recordId:text(latest.recordId),saveId:text(latest.saveId),occurredAtMs:count(latest.occurredAtMs),items},
  recordsUpdatedAtMs:count(records.updatedAtMs),
  conversations:{available:conversations.available===true,reason:text(conversations.reason),messageCount:count(conversations.messageCount),userMessageCount:count(conversations.userMessageCount),assistantMessageCount:count(conversations.assistantMessageCount),firstMessageAtMs:count(conversations.firstMessageAtMs),lastMessageAtMs:count(conversations.lastMessageAtMs)},
 };
}
export type DashboardDetails=ReturnType<typeof dashboardDetails>;
const shown=(available:boolean,value:number|null,suffix='')=>available&&value!==null?`${value}${suffix}`:'暂无数据';
export function detailsView(d:DashboardDetails){return {today:shown(d.usage.today.available,d.usage.today.focusMinutes,' 分钟'),daily:d.usage.daily.map(x=>({date:x.date,value:shown(x.available,x.focusMinutes,' 分钟')})),familyCoin:shown(d.ark.available,d.ark.familyCoin),stardust:shown(d.ark.available,d.ark.stardust),cards:shown(d.ark.available,d.ark.cards,' 张'),incomeFamilyCoin:shown(d.income.available,d.income.familyCoin),incomeStardust:shown(d.income.available,d.income.stardust),latestItems:d.latest.available?d.latest.items:[],conversationCount:d.conversations.available&&d.conversations.messageCount!==null?`已同步 ${d.conversations.messageCount} 条`:'暂无数据'};}
export function unavailableText(reason:string){const labels:Record<string,string>={no_records:'暂无已同步记录',no_snapshot:'暂无有效快照',non_normal:'当前来源不可作为正常业务数据',clock_unknown:'时间信息不完整，暂不能确认最新物品',not_enabled:'该能力暂未开放',dependency_unavailable:'数据暂时读取失败，请刷新重试',identity_mismatch:'设备归属或授权已变化，请刷新设备列表',partial_history:'仅含已同步记录，历史可能不完整',policy_pending:'展示口径尚未就绪'};return labels[reason]||'暂无可用数据';}
