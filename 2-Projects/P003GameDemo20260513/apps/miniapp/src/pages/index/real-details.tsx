import {useEffect,useState} from 'react';
import {Button,Picker,Text,View} from '@tarojs/components';
import {Card,Heading} from './components';
import {dashboardDetails,detailsView,sourceModeText,unavailableText,type DashboardDetails} from '../../services/real-details';
import {HistoryController,type HistoryQuery,type HistoryPage} from '../../services/live-history';
import {getBusinessPage,getConversationPage,getObservationPage,type BusinessItem,type ConversationItem} from '../../services/history-api';
import {durationText,observationKindLabel,observationKinds,type Observation} from '../../services/observations';

const time=(value:number|null|undefined)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间未知';
const itemState=(state:string)=>state==='active'?'已启用':state==='pending_activation'?'待激活':'状态未知';
const reasonLabel:Record<string,string>={reward_claim:'领取奖励',tank_unlock:'解锁生态缸',makeup_card_use:'使用补勤卡',resource_spend:'资源消费',item_activation:'物品激活',gm_adjustment:'测试调整',unknown:'原因未知'};
const resourceLabel:Record<string,string>={family_coin:'家族币',stardust:'星尘','M-CARD-001':'补勤卡','C-FAMILY-001':'家族币','C-COIN-001':'家族币','C-STARDUST-001':'星尘'};

export function ConversationRow({item}:{item:ConversationItem}){return <View className="live-history-entry"><Text className="row-title">{item.role==='user'?'孩子':'小可'}</Text><Text className="small-note">{time(item.ts)}</Text><Text className="live-history-content" selectable>{item.text}</Text></View>;}
export function BusinessRow({item}:{item:BusinessItem}){
 const legacy=item.format==='p003-ark-records-r1',baseline=legacy&&item.recordKind==='baseline';
 const title=baseline?'历史基线':legacy&&item.reason==='unknown'?'业务变更':reasonLabel[item.reason]||'业务记录';
 return <View className="live-history-entry">
  <Text className="row-title">{title}{item.sourceMode!=='normal'?` · ${item.sourceMode==='gm'?'测试来源':'来源未知'}`:''}</Text>
  <Text className="small-note">{item.timeStatus==='reported'?`发生 ${time(item.occurredAtMs)}`:'发生时间待确认'} · 接收 {time(item.receivedAtMs)}{item.logicalDay?` · 游戏日 ${item.logicalDay}`:''}</Text>
  {baseline?<>
   <Text className="small-note">接入时已有状态，不计入新增收益或新获得。</Text>
   {item.baseline?<>
    {([['familyCoin','家族币'],['stardust','星尘'],['M-CARD-001','补勤卡']] as const).map(([key,label])=><Text className="live-history-content" key={key}>{label}：{item.baseline!.wallets[key]??'未知'}</Text>)}
    {item.baseline.items.map(x=><Text className="live-history-content" key={x.itemId}>已有 · {x.itemId} × {x.quantity??'数量未知'} · {itemState(x.state)}</Text>)}
   </>:<Text className="small-note">暂无基线资产数据</Text>}
  </>:<>
   {item.resourceChanges.map(x=><Text className="live-history-content" key={x.resourceId}>{resourceLabel[x.resourceId]||x.resourceId}：{x.delta>0?'+':''}{x.delta}</Text>)}
   {item.grants?.map(g=><View key={g.rewardInstanceId}><Text className="small-note">已领取 {g.sourceId}{g.logicalDay?` · 游戏日 ${g.logicalDay}`:''}</Text>{g.resolvedRewards.map((r,i)=><Text className="live-history-content" key={`${g.rewardInstanceId}:${i}`}>{resourceLabel[r.itemId]||r.itemId} × {r.quantity}</Text>)}</View>)}
   {item.inventoryChanges?.map(x=><Text className="live-history-content" key={`inventory:${x.itemId}`}>库存 · {resourceLabel[x.itemId]||x.itemId}：{x.before?.quantity??0} → {x.after?.quantity??0}{x.after?.status?` · ${itemState(x.after.status)}`:''}</Text>)}
   {!item.inventoryChanges?.length&&item.itemChanges.map(x=><Text className="live-history-content" key={x.itemInstanceId}>{x.operation==='activated'?'激活':x.operation==='acquired'?'获得':'状态变化'} · {x.itemId||x.itemInstanceId}{x.quantity!==undefined?` × ${x.quantity}`:''} · {itemState(x.state)}</Text>)}
   {!item.inventoryChanges?.length&&item.inventoryStateChanges?.map(x=><Text className="live-history-content" key={`state:${x.itemId}`}>状态变化 · {x.itemId} · {itemState(x.fromState)} → {itemState(x.toState)}</Text>)}
   {item.makeupGrants?.map((x,i)=><Text className="live-history-content" key={`makeup-grant:${i}`}>补勤授予 · {x.tankId}</Text>)}
   {item.makeupUses?.map((x,i)=><Text className="live-history-content" key={`makeup-use:${i}`}>使用补勤卡 · 游戏日 {x.logicalDay}{x.tankId?` · ${x.tankId}`:''}</Text>)}
  </>}
  <Text className="small-note live-record-id" selectable>记录 {item.recordId}</Text>
 </View>;
}

export function ReportedStateCard({state}:{state:NonNullable<DashboardDetails['reportedState']>}) {
 const p=state.progress,r=p.nextReward;
 const value=(n:number|null,suffix='')=>n===null?'暂无数据':`${n}${suffix}`;
 const timer=({running:'计时中',paused:'已暂停',stopped:'已停止'} as Record<string,string>)[p.timerState]||'暂无数据';
 const reward=({locked:'进行中',claimable:'可领取',claimed:'已领取',day_complete:'当日奖励已完成'} as Record<string,string>)[r.status]||'暂无数据';
 return <Card><Heading title="设备已上报资产与游戏状态"/>
  <Text className="row-title">{sourceModeText(state.sourceMode)} · 游戏日 {state.logicalDay||'未知'}</Text>
  {state.sourceMode!=='normal'&&<Text className="small-note">以下保留设备实际上传值；测试或未核实来源不计入正常收益。</Text>}
  <View className="live-metrics"><View><Text className="metric-label">家族币</Text><Text className="live-metric-value">{value(state.familyCoin)}</Text></View><View><Text className="metric-label">星尘</Text><Text className="live-metric-value">{value(state.stardust)}</Text></View><View><Text className="metric-label">补勤卡</Text><Text className="live-metric-value">{value(state.cards,' 张')}</Text></View></View>
  <Text className="row-title">奖励进度 · {timer}</Text><Text className="paragraph">{reward}{r.stageId?` · ${r.stageId}`:''} · 待领取 {value(p.claimableCount,' 个')}</Text>
  {r.remainingSeconds!==null&&<Text className="small-note">上报时距下一奖励 {durationText(r.remainingSeconds)}</Text>}
  <Text className="small-note">采样 {time(state.capturedAtMs)} · 接收 {time(state.receivedAtMs)}；这是最近上报状态，刷新后读取新值。</Text>
 </Card>;
}

export function ObservationRow({item}:{item:Observation}){return <View className="live-history-entry">
 <Text className="row-title">{observationKindLabel(item.kind)}</Text><Text className="small-note">{item.timeStatus==='clock_suspect'?'设备时间待确认':time(item.occurredAtMs)} · 接收 {time(item.receivedAtMs)}</Text>
 {item.rewards.map((r,i)=><Text className="live-history-content" key={`${r.itemId}:${i}`}>{resourceLabel[r.itemId]||r.itemId} × {r.quantity??'数量未知'}</Text>)}
 {item.inventory&&<Text className="live-history-content">{resourceLabel[item.inventory.itemId]||item.inventory.itemId||'未标记资源'}：{item.inventory.before??'未知'} → {item.inventory.after??'未知'}{item.inventory.delta!==null?`（${item.inventory.delta>0?'+':''}${item.inventory.delta}）`:''}{item.inventory.status?` · ${itemState(item.inventory.status)}`:''}</Text>}
 {item.progress&&<Text className="live-history-content">累计奖励进度 {durationText(item.progress.elapsedSeconds)}{item.progress.checkpointMinutes!==null?` · ${item.progress.checkpointMinutes} 分钟节点`:''}</Text>}
 <Text className="small-note">历史上报，来源模式未确认{item.logicalDay?` · 游戏日 ${item.logicalDay}`:''}；不代表当前余额或完整收益。</Text>
 </View>;}

function HistoryViewer({publicId,kind,onAccessLost}:{publicId:string;kind:'conversations'|'records'|'observations';onAccessLost:(status:number)=>void}){
 const [controller]=useState(()=>new HistoryController<ConversationItem|BusinessItem|Observation>((q:HistoryQuery):Promise<HistoryPage<ConversationItem|BusinessItem|Observation>>=>kind==='conversations'?getConversationPage(publicId,q):kind==='observations'?getObservationPage(publicId,q):getBusinessPage(publicId,q),onAccessLost));
 const [state,setState]=useState(controller.state);const [fromDay,setFromDay]=useState('');const [toDay,setToDay]=useState('');const [filterError,setFilterError]=useState('');const [category,setCategory]=useState(0);
 useEffect(()=>{const stop=controller.subscribe(setState);void controller.refresh();return()=>{stop();controller.dispose();};},[controller]);
 const refresh=()=>{if(fromDay&&toDay&&fromDay>toDay){setFilterError('开始日期不能晚于结束日期');return;}setFilterError('');void controller.refresh({...fromDay?{fromDay}:{},...toDay?{toDay}:{},...kind==='observations'?{kind:observationKinds[category]}:{}});};
 return <View className="live-history">
  <Text className="small-note">按北京时间筛选；从新到旧。这里只展示已同步历史。</Text>
  <View className="live-history-filters"><Picker mode="date" value={fromDay} onChange={e=>setFromDay(e.detail.value)}><Button size="mini">{fromDay||'开始日期'}</Button></Picker><Picker mode="date" value={toDay} onChange={e=>setToDay(e.detail.value)}><Button size="mini">{toDay||'结束日期'}</Button></Picker>{kind==='observations'&&<Picker mode="selector" value={category} range={observationKinds.map(observationKindLabel)} onChange={e=>setCategory(Number(e.detail.value))}><Button size="mini">{observationKindLabel(observationKinds[category])}</Button></Picker>}<Button size="mini" disabled={state.busy} onClick={refresh}>查询 / 刷新</Button><Button size="mini" disabled={state.busy} onClick={()=>{setFromDay('');setToDay('');setCategory(0);setFilterError('');void controller.refresh({});}}>全部日期</Button></View>
  {(filterError||state.error)&&<View className="notice live-error"><Text>{filterError||state.error}</Text></View>}
  {state.page?.messageCount!==undefined&&<Text className="small-note">本次查询已同步 {state.page.messageCount} 条 · 孩子 {state.page.userMessageCount} 条 / 小可 {state.page.assistantMessageCount} 条；不代表完整历史。</Text>}
  {state.items.map(item=>'role' in item?<ConversationRow key={item.id} item={item}/>:'eventId' in item?<ObservationRow key={item.eventId} item={item}/>:<BusinessRow key={item.recordId} item={item}/>)}
  {state.loaded&&!state.items.length&&!state.error&&<Text className="paragraph muted">暂无符合条件的已同步记录</Text>}
  {state.busy&&<Text className="paragraph muted">正在读取记录…</Text>}
  {state.needsRefresh&&<Button className="link-button" disabled={state.busy} onClick={refresh}>刷新首屏</Button>}
  {!state.needsRefresh&&state.page?.hasMore&&<Button className="link-button" disabled={state.busy} onClick={()=>void controller.loadMore()}>加载更多</Button>}
  {state.loaded&&!!state.items.length&&!state.page?.hasMore&&!state.busy&&<Text className="small-note">已显示本次查询全部已同步记录</Text>}
 </View>;
}

export default function RealDetails({details,publicId,onAccessLost}:{details?:DashboardDetails;publicId:string;onAccessLost:(status:number)=>void}){
 const d=details||dashboardDetails({}),v=detailsView(d);const [showConversations,setShowConversations]=useState(false);const [showRecords,setShowRecords]=useState(false);const [showObservations,setShowObservations]=useState(false);
 return <>
  <Card><Heading title="使用时长"/><Text className="live-metric-value">已同步历史 {v.historicalUsage}</Text><Text className="small-note">按使用片段、在位姿态窗口与奖励进度保守合并，重叠不重复累计；只包含已同步历史。</Text>{d.historicalUsage.available&&<><Text className="small-note">{d.historicalUsage.fromDay} 至 {d.historicalUsage.toDay} · 有效使用片段 {durationText(d.historicalUsage.observedSeconds)} · 补充用时 {durationText(d.historicalUsage.estimatedSeconds)}</Text><View className="live-days">{d.historicalUsage.daily.map(x=><View key={x.date}><Text>{x.date}</Text><Text>{x.available?(x.totalSeconds!==null?durationText(x.totalSeconds):`${x.focusMinutes} 分钟`):'暂无数据'}{x.estimatedSeconds&&x.estimatedSeconds>0?' · 含进度/在位估算':''}</Text></View>)}</View></>}<Text className="row-title">今日 {v.today}</Text><Text className="small-note">近 7 日；缺测日期保持暂无数据。</Text><View className="live-days">{v.daily.map(x=><View key={x.date}><Text>{x.date}</Text><Text>{x.value}</Text></View>)}</View>{!v.daily.length&&<Text className="paragraph muted">近 7 日暂无已同步数据</Text>}</Card>
  <Card><Heading title="历史奖励与道具"/>
   <Text className="row-title">实时业务记录</Text><Text className="small-note">上传成功的领取、钱包和道具变更可在此查询；与下方夜间历史观测分开展示，不重复合计。</Text>
   {d.recentActivity.items.map(item=><BusinessRow key={item.recordId} item={item}/>)}
   {!d.recentActivity.items.length&&<Text className="paragraph muted">{unavailableText(d.recentActivity.reason||'no_records')}</Text>}
   <Button className="link-button" onClick={()=>setShowRecords(x=>!x)}>{showRecords?'收起业务流水':'查看已同步业务流水'}</Button>{showRecords&&<HistoryViewer key={`${publicId}:records`} publicId={publicId} kind="records" onAccessLost={onAccessLost}/>}
   <Text className="row-title">夜间同步的历史观测</Text><Text className="small-note">历史埋点按设备调度上传；本次实时领取请先看上方业务记录。以下条数不含上方实时记录。</Text>
   {d.observations.available?<><View className="live-metrics"><View><Text className="metric-label">奖励记录</Text><Text className="live-metric-value">{d.observations.counts.rewards??'未知'} 条</Text></View><View><Text className="metric-label">库存变化</Text><Text className="live-metric-value">{d.observations.counts.inventory??'未知'} 条</Text></View><View><Text className="metric-label">补勤卡变化</Text><Text className="live-metric-value">{d.observations.counts.makeupCards??'未知'} 条</Text></View></View><Text className="small-note">已同步发生时间：{time(d.observations.coverage.firstOccurredAtMs)} 至 {time(d.observations.coverage.lastOccurredAtMs)}。历史可能不完整，记录数不是累计获得数量。</Text>{d.observations.latest.rewards&&<ObservationRow item={d.observations.latest.rewards}/>} {d.observations.latest.inventory&&<ObservationRow item={d.observations.latest.inventory}/>} {d.observations.latest.makeupCards&&<ObservationRow item={d.observations.latest.makeupCards}/>} {d.observations.latest.wallet&&<ObservationRow item={d.observations.latest.wallet}/>} {d.observations.latest.progress&&<ObservationRow item={d.observations.latest.progress}/>}<Text className="small-note">{d.observations.counts.wallet===0?'已同步历史中未采集到钱包变化，不能据此认定家族币或星尘为 0。':'历史钱包变化与当前余额分别显示。'}</Text></>:<Text className="paragraph muted">{unavailableText(d.observations.reason)}</Text>}<Button className="link-button" onClick={()=>setShowObservations(x=>!x)}>{showObservations?'收起历史奖励与道具':'查看全部已同步历史'}</Button>{showObservations&&<HistoryViewer key={`${publicId}:observations`} publicId={publicId} kind="observations" onAccessLost={onAccessLost}/>}</Card>
  {d.reportedState&&<ReportedStateCard state={d.reportedState}/>}
  <Card><Heading title="正常来源资产摘要"/><View className="live-metrics"><View><Text className="metric-label">家族币</Text><Text className="live-metric-value">{v.familyCoin}</Text></View><View><Text className="metric-label">星尘</Text><Text className="live-metric-value">{v.stardust}</Text></View><View><Text className="metric-label">补勤卡</Text><Text className="live-metric-value">{v.cards}</Text></View></View><Text className="small-note">{d.ark.available?`采样于 ${time(d.ark.capturedAtMs)}；不是实时余额。`:unavailableText(d.ark.reason)}</Text></Card>
  <Card><Heading title="昨日正常来源收益"/><Text className="small-note">{d.income.date||'北京时间昨天'} · 仅含正常来源、已同步奖励收入；测试记录和历史游戏日领取在上方实时业务记录查看。</Text><View className="live-metrics"><View><Text className="metric-label">家族币</Text><Text className="live-metric-value">{v.incomeFamilyCoin}</Text></View><View><Text className="metric-label">星尘</Text><Text className="live-metric-value">{v.incomeStardust}</Text></View></View>{!d.income.available&&<Text className="small-note">{unavailableText(d.income.reason)}</Text>}</Card>
  <Card><Heading title="最近正常来源获得物品"/><Text className="small-note">当前授权下全部存档、全部缸的获得记录；不是当前库存。</Text>{v.latestItems.map(x=><View className="live-history-entry" key={x.itemInstanceId}><Text className="row-title">{x.itemId} × {x.quantity===null?'数量未知':x.quantity}</Text><Text className="small-note">{x.itemKind==='avatar_decoration'?'小可装饰':x.itemKind==='tank_component'?'生态缸组件':'物品'} · {itemState(x.state)}</Text></View>)}{!d.latest.available&&<Text className="paragraph muted">{unavailableText(d.latest.reason)}</Text>}{d.latest.available&&<Text className="small-note">获得于 {time(d.latest.occurredAtMs)}</Text>}</Card>
  <Card><Heading title="对话历史"/><Text className="live-metric-value">{v.conversationCount}</Text><Text className="small-note">已同步的设备对话，历史可能不完整。{d.conversations.available?`最近记录：${time(d.conversations.lastMessageAtMs)}`:unavailableText(d.conversations.reason)}</Text><Button className="link-button" onClick={()=>setShowConversations(x=>!x)}>{showConversations?'收起对话记录':'查看历史对话'}</Button>{showConversations&&<HistoryViewer key={`${publicId}:conversations`} publicId={publicId} kind="conversations" onAccessLost={onAccessLost}/>}</Card>
 </>;
}
