import {useEffect,useState} from 'react';
import {Button,Picker,Text,View} from '@tarojs/components';
import {Card,Heading} from './components';
import {dashboardDetails,detailsView,unavailableText,type DashboardDetails} from '../../services/real-details';
import {HistoryController,type HistoryQuery,type HistoryPage} from '../../services/live-history';
import {getBusinessPage,getConversationPage,type BusinessItem,type ConversationItem} from '../../services/history-api';

const time=(value:number|null|undefined)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间未知';
const itemState=(state:string)=>state==='active'?'已启用':state==='pending_activation'?'待激活':'状态未知';
const reasonLabel:Record<string,string>={reward_claim:'领取奖励',tank_unlock:'解锁生态缸',makeup_card_use:'使用补勤卡',resource_spend:'资源消费',item_activation:'物品激活',gm_adjustment:'测试调整',unknown:'原因未知'};
const resourceLabel:Record<string,string>={family_coin:'家族币',stardust:'星尘','M-CARD-001':'补勤卡'};

export function ConversationRow({item}:{item:ConversationItem}){return <View className="live-history-entry"><Text className="row-title">{item.role==='user'?'孩子':'小可'}</Text><Text className="small-note">{time(item.ts)}</Text><Text className="live-history-content" selectable>{item.text}</Text></View>;}
export function BusinessRow({item}:{item:BusinessItem}){
 const legacy=item.format==='p003-ark-records-r1',baseline=legacy&&item.recordKind==='baseline';
 const title=baseline?'历史基线':legacy&&item.reason==='unknown'?'业务变更':reasonLabel[item.reason]||'业务记录';
 return <View className="live-history-entry">
  <Text className="row-title">{title}{item.sourceMode!=='normal'?` · ${item.sourceMode==='gm'?'测试来源':'来源未知'}`:''}</Text>
  <Text className="small-note">{item.timeStatus==='reported'?time(item.occurredAtMs):'发生时间待确认'}</Text>
  {baseline?<>
   <Text className="small-note">接入时已有状态，不计入新增收益或新获得。</Text>
   {item.baseline?<>
    {([['familyCoin','家族币'],['stardust','星尘'],['M-CARD-001','补勤卡']] as const).map(([key,label])=><Text className="live-history-content" key={key}>{label}：{item.baseline!.wallets[key]??'未知'}</Text>)}
    {item.baseline.items.map(x=><Text className="live-history-content" key={x.itemId}>已有 · {x.itemId} × {x.quantity??'数量未知'} · {itemState(x.state)}</Text>)}
   </>:<Text className="small-note">暂无基线资产数据</Text>}
  </>:<>
   {item.resourceChanges.map(x=><Text className="live-history-content" key={x.resourceId}>{resourceLabel[x.resourceId]||x.resourceId}：{x.delta>0?'+':''}{x.delta}</Text>)}
   {item.itemChanges.map(x=><Text className="live-history-content" key={x.itemInstanceId}>{x.operation==='activated'?'激活':x.operation==='acquired'?'获得':'状态变化'} · {x.itemId||x.itemInstanceId}{x.quantity!==undefined?` × ${x.quantity}`:''} · {itemState(x.state)}</Text>)}
   {item.inventoryStateChanges?.map(x=><Text className="live-history-content" key={`state:${x.itemId}`}>状态变化 · {x.itemId} · {itemState(x.fromState)} → {itemState(x.toState)}</Text>)}
  </>}
  <Text className="small-note live-record-id" selectable>记录 {item.recordId}</Text>
 </View>;
}

function HistoryViewer({publicId,kind,onAccessLost}:{publicId:string;kind:'conversations'|'records';onAccessLost:(status:number)=>void}){
 const [controller]=useState(()=>new HistoryController<ConversationItem|BusinessItem>((q:HistoryQuery):Promise<HistoryPage<ConversationItem|BusinessItem>>=>kind==='conversations'?getConversationPage(publicId,q):getBusinessPage(publicId,q),onAccessLost));
 const [state,setState]=useState(controller.state);const [fromDay,setFromDay]=useState('');const [toDay,setToDay]=useState('');const [filterError,setFilterError]=useState('');
 useEffect(()=>{const stop=controller.subscribe(setState);void controller.refresh();return()=>{stop();controller.dispose();};},[controller]);
 const refresh=()=>{if(fromDay&&toDay&&fromDay>toDay){setFilterError('开始日期不能晚于结束日期');return;}setFilterError('');void controller.refresh({...fromDay?{fromDay}:{},...toDay?{toDay}:{}});};
 return <View className="live-history">
  <Text className="small-note">按北京时间筛选；从新到旧。这里只展示已同步历史。</Text>
  <View className="live-history-filters"><Picker mode="date" value={fromDay} onChange={e=>setFromDay(e.detail.value)}><Button size="mini">{fromDay||'开始日期'}</Button></Picker><Picker mode="date" value={toDay} onChange={e=>setToDay(e.detail.value)}><Button size="mini">{toDay||'结束日期'}</Button></Picker><Button size="mini" disabled={state.busy} onClick={refresh}>查询 / 刷新</Button><Button size="mini" disabled={state.busy} onClick={()=>{setFromDay('');setToDay('');setFilterError('');void controller.refresh({});}}>全部日期</Button></View>
  {(filterError||state.error)&&<View className="notice live-error"><Text>{filterError||state.error}</Text></View>}
  {state.page?.messageCount!==undefined&&<Text className="small-note">本次查询已同步 {state.page.messageCount} 条 · 孩子 {state.page.userMessageCount} 条 / 小可 {state.page.assistantMessageCount} 条；不代表完整历史。</Text>}
  {state.items.map(item=>'role' in item?<ConversationRow key={item.id} item={item}/>:<BusinessRow key={item.recordId} item={item}/>)}
  {state.loaded&&!state.items.length&&!state.error&&<Text className="paragraph muted">暂无符合条件的已同步记录</Text>}
  {state.busy&&<Text className="paragraph muted">正在读取记录…</Text>}
  {state.needsRefresh&&<Button className="link-button" disabled={state.busy} onClick={refresh}>刷新首屏</Button>}
  {!state.needsRefresh&&state.page?.hasMore&&<Button className="link-button" disabled={state.busy} onClick={()=>void controller.loadMore()}>加载更多</Button>}
  {state.loaded&&!!state.items.length&&!state.page?.hasMore&&!state.busy&&<Text className="small-note">已显示本次查询全部已同步记录</Text>}
 </View>;
}

export default function RealDetails({details,publicId,onAccessLost}:{details?:DashboardDetails;publicId:string;onAccessLost:(status:number)=>void}){
 const d=details||dashboardDetails({}),v=detailsView(d);const [showConversations,setShowConversations]=useState(false);const [showRecords,setShowRecords]=useState(false);
 return <>
  <Card><Heading title="已上报使用时长"/><Text className="live-metric-value">今日 {v.today}</Text><Text className="small-note">按设备有效使用片段统计；缺测日期保持暂无数据。</Text><View className="live-days">{v.daily.map(x=><View key={x.date}><Text>{x.date}</Text><Text>{x.value}</Text></View>)}</View>{!v.daily.length&&<Text className="paragraph muted">近 7 日暂无已同步数据</Text>}</Card>
  <Card><Heading title="设备资产快照"/><View className="live-metrics"><View><Text className="metric-label">家族币</Text><Text className="live-metric-value">{v.familyCoin}</Text></View><View><Text className="metric-label">星尘</Text><Text className="live-metric-value">{v.stardust}</Text></View><View><Text className="metric-label">补勤卡</Text><Text className="live-metric-value">{v.cards}</Text></View></View><Text className="small-note">{d.ark.available?`采样于 ${time(d.ark.capturedAtMs)}；不是实时余额。`:unavailableText(d.ark.reason)}</Text></Card>
  <Card><Heading title="昨日已上报收益"/><Text className="small-note">{d.income.date||'北京时间昨天'} · 仅含已同步奖励收入，不是完整收益。</Text><View className="live-metrics"><View><Text className="metric-label">家族币</Text><Text className="live-metric-value">{v.incomeFamilyCoin}</Text></View><View><Text className="metric-label">星尘</Text><Text className="live-metric-value">{v.incomeStardust}</Text></View></View>{!d.income.available&&<Text className="small-note">{unavailableText(d.income.reason)}</Text>}</Card>
  <Card><Heading title="最近已同步获得物品"/><Text className="small-note">当前授权下全部存档、全部缸的获得记录；不是当前库存。</Text>{v.latestItems.map(x=><View className="live-history-entry" key={x.itemInstanceId}><Text className="row-title">{x.itemId} × {x.quantity===null?'数量未知':x.quantity}</Text><Text className="small-note">{x.itemKind==='avatar_decoration'?'小可装饰':x.itemKind==='tank_component'?'生态缸组件':'物品'} · {itemState(x.state)}</Text></View>)}{!d.latest.available&&<Text className="paragraph muted">{unavailableText(d.latest.reason)}</Text>}{d.latest.available&&<Text className="small-note">获得于 {time(d.latest.occurredAtMs)}</Text>}<Button className="link-button" onClick={()=>setShowRecords(x=>!x)}>{showRecords?'收起业务流水':'查看已同步业务流水'}</Button>{showRecords&&<HistoryViewer key={`${publicId}:records`} publicId={publicId} kind="records" onAccessLost={onAccessLost}/>}</Card>
  <Card><Heading title="对话历史"/><Text className="live-metric-value">{v.conversationCount}</Text><Text className="small-note">已同步的设备对话，历史可能不完整。{d.conversations.available?`最近记录：${time(d.conversations.lastMessageAtMs)}`:unavailableText(d.conversations.reason)}</Text><Button className="link-button" onClick={()=>setShowConversations(x=>!x)}>{showConversations?'收起对话记录':'查看历史对话'}</Button>{showConversations&&<HistoryViewer key={`${publicId}:conversations`} publicId={publicId} kind="conversations" onAccessLost={onAccessLost}/>}</Card>
 </>;
}
