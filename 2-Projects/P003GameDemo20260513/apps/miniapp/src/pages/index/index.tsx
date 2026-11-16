import { useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import { Button, Canvas, Image, Input, Picker, Text, Textarea, View } from '@tarojs/components';
import { art } from '../../assets';
import { dateToday, emptyChild, emptyVisionMeasurements, newId, promisePercent, publishedWeekRange, shouldRecall, suggestions, visionMetricDefinitions, type Action, type Child, type DemoState, type PromiseItem, type Suggestion, type Tab, type Task, type VisionMeasurements, type VisionMetricCode, type VisionReport } from '../../model';
import { nextSkippedStep, type SetupStep } from '../../setupSteps';
import { dispatchDemo, loadDemo, resetDemo } from '../../services/demo';
import { Card, Choice, Coin, Counter, Empty, Field, Heading, Primary, Row, Selector, Toggle } from './components';
import { bluetoothCapability, checkConnection, releaseBluetooth, scanWechatDevices, type ConnectionCheck, type NearbyDevice } from '../../services/bluetooth';
import { validateWifiCredentials } from '../../services/bleProtocol';
import { BleProtocolError, BleSession } from '../../services/bleSession';
import { exportShareCard } from '@share';
import RealDataHome from './real-data';

type Panel = 'setup' | 'network' | 'device' | 'settings' | 'postureSettings' | 'voiceSettings' | 'guide' | 'task' | 'promise' | 'records' | 'cards' | 'history' | 'feedback' | 'share' | 'suggestion' | 'ideas' | 'personal' | 'child' | 'reports' | 'visionEdit' | 'privacy' | 'intercept' | 'service' | 'messages' | null;
const nav: { id: Tab; label: string; icon: string; activeIcon: string }[] = [
  { id: 'home', icon: art.navHome, activeIcon: art.navHomeActive, label: '首页' }, { id: 'weekly', icon: art.navWeekly, activeIcon: art.navWeeklyActive, label: '周报' },
  { id: 'rewards', icon: art.navRewards, activeIcon: art.navRewardsActive, label: '兑换' }, { id: 'kids', icon: art.navKids, activeIcon: art.navKidsActive, label: 'KidsHub' },
  { id: 'mine', icon: art.navMine, activeIcon: art.navMineActive, label: '我的' },
];
const tabTitles: Record<Tab, string> = { home: '空间光学读写台', weekly: '周报', rewards: '兑换家族币', kids: 'KidsHub', mine: '我的' };
const panelTitles: Record<Exclude<Panel, null>, string> = {
  setup: '添加设备', network: '网络配置', device: '设备管理', settings: '设备设置', postureSettings: '坐姿提醒设置', voiceSettings: '语音伴学设置', guide: '使用帮助', task: '家长任务', promise: '亲子约定', records: '家族币收支记录', cards: '补勤卡', history: '历史报告', feedback: '家长反馈', share: '生成分享卡', suggestion: '建议详情', ideas: '金点子库', personal: '个人中心', child: '孩子管理', reports: '视光报告', visionEdit: '视光报告', privacy: '权限与隐私', intercept: '好久不见', service: '售后服务', messages: '消息中心',
};
const MESSAGE_CATEGORIES = ['待兑换提醒', '因为你的建议，小可又进化啦', '周报生成'];
const weekMinutes = [45, 60, 30, 65, 0, 70, 50];
const weeklyUseDays = weekMinutes.filter(minutes => minutes > 0).length;
const weeklyFocusMinutes = weekMinutes.reduce((sum, minutes) => sum + minutes, 0);
const weeklyPostureCount = 10;
const formatDuration = (minutes: number) => minutes < 60 ? `${minutes}分钟` : `${(minutes / 60).toFixed(1)}小时`;
const weekStart = (offset = 0) => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - offset * 7);
};
const weekRange = (offset = 0) => {
  const monday = weekStart(offset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const format = (date: Date) => `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  return `${format(monday)}–${format(sunday)}`;
};
const monthDate = (offset = 0) => new Date(new Date().getFullYear(), new Date().getMonth() - offset, 1);
const formatMonth = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
const toast = (title: string) => { Taro.showToast({ title, icon: 'none' }); };
async function ask(title: string, content: string) {
  const result = await Taro.showModal({ title, content, confirmText: '确认', cancelText: '取消', confirmColor: '#F77836' });
  return result.confirm;
}

export default function Index() {
  return process.env.TARO_APP_DATA_MODE === 'live' ? <RealDataHome /> : <DemoIndex />;
}

function DemoIndex() {
  const [state, setState] = useState<DemoState>(() => loadDemo());
  const stateRef = useRef(state);
  const [tab, setTab] = useState<Tab>('home');
  const [panels, setPanels] = useState<Exclude<Panel, null>[]>([]);
  const panel = panels[panels.length - 1] || null;
  const overlay = panel === 'suggestion' || panel === 'intercept';
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedPromise, setSelectedPromise] = useState<PromiseItem | null>(null);
  const [selectedIdea, setSelectedIdea] = useState<Suggestion | null>(null);
  const [selectedReport, setSelectedReport] = useState<VisionReport | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; content?: string; confirmText?: string; confirm: () => void } | null>(null);
  const [shareKind, setShareKind] = useState<'week' | 'idea'>('week');
  const currentTitle = panel === 'task' ? (selectedTask ? '家长任务' : '创建任务') : panel === 'promise' ? (selectedPromise ? '亲子约定' : '新建约定') : panel ? panelTitles[panel] : tabTitles[tab];
  const open = (next: Exclude<Panel, null>) => setPanels(current => [...current, next]);
  const close = () => setPanels(current => current.slice(0, -1));
  const update = (action: Action) => {
    try {
      const next = dispatchDemo(stateRef.current, action);
      stateRef.current = next;
      setState(next);
      return true;
    } catch (error) { toast(error instanceof Error ? error.message : '操作失败，请重试'); return false; }
  };
  const selectTab = (next: Tab) => { setTab(next); setPanels([]); };
  const createTask = (task: Task | null = null) => { setSelectedTask(task); open('task'); };
  const createPromise = (item: PromiseItem | null = null) => { setSelectedPromise(item); open('promise'); };
  const confirmTask = async (task: Task) => {
    if (await ask('确认发放任务奖励？', `确认“${task.title}”后，将发放 ${task.pendingReward} 个奖励币。`)) update({ type: 'task.confirm', id: task.id, date: dateToday() }) && toast('示例奖励已发放');
  };
  const redeem = (item: PromiseItem) => setConfirmation({ title: '确认兑换约定?', confirm: () => { update({ type: 'promise.redeem', id: item.id, date: dateToday() }) && toast('示例约定已兑现'); setConfirmation(null); } });
  const goShare = (kind: 'week' | 'idea') => { setShareKind(kind); open('share'); };
  const hasDevice = Boolean(state.device);
  const ready = hasDevice && state.loggedIn;
  const hasUnreadMessages = MESSAGE_CATEGORIES.some(category => !state.readMessageCategories.includes(category));
  const status = !state.device?.online ? '离线' : state.device?.present === false ? '未学习' : '学习中';
  useEffect(() => {
    if (process.env.TARO_ENV === 'weapp') Taro.setNavigationBarTitle({ title: currentTitle });
  }, [currentTitle]);
  useEffect(() => {
    Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => undefined);
  }, [panel, tab]);
  useEffect(() => {
    const at = new Date().toISOString();
    const showRecall = shouldRecall(stateRef.current);
    update({ type: 'app.open', at, showRecall });
    if (showRecall) setPanels(current => [...current, 'intercept']);
  }, []);
  useEffect(() => {
    const refresh = () => { const next = loadDemo(); stateRef.current = next; setState(next); };
    const timer = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  return <View className={`app-screen ${panel ? `screen-${panel}` : `screen-${tab}`} ${process.env.TARO_ENV === 'weapp' ? 'weapp-screen' : ''} ${tab === 'weekly' && !panel ? 'weekly-screen' : ''} ${tab === 'home' && (!panel || overlay) ? 'home-screen' : ''} ${tab === 'home' && !panel && !state.device?.online ? 'home-unready' : ''}`}>
    <View className="preview-strip"><Text>开发预览 · 页面与业务数据为本机演示</Text></View>
    <View className="app-header" style={process.env.TARO_ENV === 'weapp' ? { paddingTop: `${Taro.getWindowInfo().statusBarHeight}px` } : undefined}>{panel && !overlay ? <Button className="back-button" onClick={close}>‹ 返回</Button> : <View className="header-spacer" />}<Text className="app-title">{panel && !overlay ? currentTitle : tabTitles[tab]}{tab === 'weekly' && !panel && <Text className="weekly-header-period">{publishedWeekRange()}</Text>}</Text><View className="header-spacer" /></View>
    {panel && !overlay ? <View className={`panel-content panel-${panel}`} key={`${panel}-${panels.length}`}>
      {panel === 'setup' && <SetupFlow state={state} update={update} open={open} finish={() => { setPanels([]); setTab('home'); }} />}
      {panel === 'network' && <SetupFlow state={state} update={update} open={open} finish={close} networkOnly />}
      {panel === 'device' && <DevicePanel state={state} update={update} open={open} close={close} />}
      {panel === 'settings' && <SettingsPanel state={state} update={update} close={close} />}
      {panel === 'postureSettings' && <SettingsPanel state={state} update={update} close={close} kind="posture" />}
      {panel === 'voiceSettings' && <SettingsPanel state={state} update={update} close={close} kind="voice" />}
      {panel === 'guide' && <GuidePanel model={state.device?.model} />}
      {panel === 'task' && <TaskPanel task={selectedTask} state={state} update={update} close={close} />}
      {panel === 'promise' && <PromisePanel item={selectedPromise} state={state} update={update} close={close} />}
      {panel === 'records' && <RecordsPanel state={state} />}
      {panel === 'cards' && <><Card><Heading title="补勤卡" /><Text className="large-number">{Math.max(0, state.cards.filter(c => c.kind === '下发').length - state.cards.filter(c => c.kind === '使用').length)} <Text className="muted">张</Text></Text><Text className="paragraph muted">补勤卡用于设备端补勤玩法。下发规则待补充。</Text></Card><Card><Heading title="使用记录" />{state.cards.length === 0 ? <Text className="muted paragraph">暂无下发与使用记录</Text> : <View className="records-list">{state.cards.map(card => <View className="record-row" key={card.id}><View><Text className="row-title">{card.note}</Text><Text className="small-note">{card.date.split('-').join('/')}</Text></View><Text className={`pill ${card.kind === '下发' ? 'primary-pill' : 'soft-pill'}`}>{card.kind}</Text></View>)}</View>}</Card></>}
      {panel === 'history' && <HistoryPanel reports={state.reports} />}
      {panel === 'feedback' && <FeedbackPanel update={update} close={close} />}
      {panel === 'share' && <SharePanel state={state} kind={shareKind} close={close} />}
      {panel === 'ideas' && <><Text className="paragraph muted">以下为示例建议，真实库内页内容待补充。</Text>{suggestions.filter(s => s.status === '已进金点子库').map(item => <Button className="suggestion-row card" key={item.id} onClick={() => { setSelectedIdea(item); open('suggestion'); }}><Text>{item.title}</Text><Text className="chevron">›</Text></Button>)}</>}
      {panel === 'personal' && <PersonalPanel state={state} update={update} close={close} />}
      {panel === 'child' && <ChildPanel state={state} update={update} close={close} open={open} />}
      {panel === 'reports' && <ReportsPanel reports={state.reports} edit={report => { setSelectedReport(report); open('visionEdit'); }} confirmDelete={report => setConfirmation({ title: '删除报告', content: '将立即删除此项目，删除后将无法恢复', confirmText: '删除', confirm: () => { if (update({ type: 'report.delete', id: report.id })) toast('视光报告已删除'); setConfirmation(null); } })} />}
      {panel === 'visionEdit' && <VisionPanel report={selectedReport} child={state.child} update={update} close={close} />}
      {panel === 'privacy' && <PrivacyPanel />}
      {panel === 'service' && <ServicePanel />}
      {panel === 'messages' && <MessagesPanel selectTab={selectTab} close={close} readCategories={state.readMessageCategories} update={update} />}
    </View> : <View className={`tab-content tab-${tab}`}>
      {!state.loggedIn && tab !== 'mine' && tab !== 'home' ? <Empty title="请先完成设备添加" text="绑定账号和读写台后即可使用此功能" action="去添加设备" onClick={() => { setTab('home'); open('setup'); }} /> : <>
        {tab === 'home' && <>
          {!ready ? <View className="unbound-home"><Card><View className="unbound-device-illustration"><View /><Text /></View><Text className="unbound-empty-title">{state.loggedIn ? '暂无数据' : '登录后查看孩子与设备数据'}</Text><Primary onClick={() => open('setup')}>{state.loggedIn ? '添加设备' : '登录 / 添加设备'}</Primary></Card></View> : <>
            <View className="child-header"><Image src={state.child?.avatar || art.homeAvatar} mode="aspectFit" /><View><Text className="child-name">{state.child?.name || '待完善孩子信息'}</Text><Text className="device-state">{status}</Text></View><Button className="message-entry" onClick={() => open('messages')}><Image src={art.newsBell} mode="aspectFit" />{hasUnreadMessages && <View className="message-entry-dot" />}</Button></View>
            {state.device?.online && <Button className="income-card" onClick={() => selectTab('rewards')}><Image src={art.coin} mode="aspectFit" /><Text>昨天方舟带回</Text><Coin amount="+32" /><Text className="pill primary-pill">{state.redeemedDate === dateToday() ? '已兑换' : '去兑换'}</Text></Button>}
            <Card className="desk-card"><Button className="guide-entry" onClick={() => open('guide')}>操作指南 ⓘ</Button><Button className="desk-main" onClick={() => open('device')}><Image src={art.desk} mode="aspectFit" /><View className="desk-metrics"><Metric label="今日专注（分钟）" value={state.device?.online ? '68' : '0'} /><Metric label="坐姿守护（次数）" value={state.device?.online ? '10' : '0'} /></View></Button><View className="device-parameters">{[{ image: art.brightness, label: '亮度', value: '标准' }, { image: art.temperature, label: '色温', value: '中性' }, { image: art.distance, label: '像距', value: state.device?.model === 'Max' ? '需校准' : '4.5米' }].map(item => <View className="parameter" key={item.label}><Image src={item.image} mode="aspectFit" /><View><Text className="muted">{item.label}</Text><Text>{state.device?.online ? item.value : '—'}</Text></View></View>)}</View>{!state.device?.online && <Primary onClick={() => open('network')}>配置网络</Primary>}</Card>
            {state.device?.online && <><View className="eco-strip"><Image className="eco-reward-thumb" src={art.gift} mode="aspectFit" /><Text>【生态缸】新获得 <Text className="accent">星月云朵灯</Text> 道具</Text></View><Card><View className="section-heading"><Text className="section-title">本周总时长：<Text className="accent">{weeklyFocusMinutes}</Text>分钟</Text></View><UsageChart values={weekMinutes} /></Card></>}
          </>}
        </>}
        {tab === 'weekly' && (!ready || !state.device?.online ? <Empty title="给设备联网" text="设备联网后可以同步使用数据" action="配置网络" onClick={() => open(hasDevice ? 'network' : 'setup')} /> : state.weeklyEmpty ? <Empty title="没有使用数据" text="生态缸快干涸了，今晚一起看看读写台吧" /> : <>
          <Card className="weekly-card">
            <View className="highlight"><Image className="highlight-label-art" src={art.weeklyLabel} mode="aspectFit" /><Text className="highlight-caption">KidsHub 建议被采纳<Text className="accent">1</Text>条</Text><Image className="highlight-character" src={art.weeklyHighlight} mode="aspectFit" /></View>
            <View className="weekly-section-title"><Image src={art.guardHeading} mode="aspectFit" /><Text>护眼守护</Text></View>
            <View className="weekly-metrics">{[{ icon: art.postureIcon, label: '坐姿守护(次)', value: '10' }, { icon: art.durationIcon, label: '日均用眼(时)', value: '0.8' }, { icon: art.activeIcon, label: '活跃天数', value: '6' }].map(metric => <View className="weekly-metric" key={metric.label}><Image src={metric.icon} mode="aspectFit" /><Text className="weekly-metric-value">{metric.value}</Text><Text>{metric.label}</Text></View>)}</View>
            <View className="weekly-section-title"><Image src={art.trendHeading} mode="aspectFit" /><Text>视力趋势</Text></View>
            <View className="weekly-trend-empty"><Text>{state.reports.length ? '视力趋势待后台分析' : '暂无视光报告'}</Text><Text>{state.reports.length ? `已记录 ${state.reports.length} 份报告，分析结果生成后在这里展示` : '录入报告后，由后台生成双眼趋势分析'}</Text></View>
            <View className="weekly-note"><View className="weekly-note-title"><Image src={art.adviceIcon} mode="aspectFit" /><Text>小建议</Text></View><Text>连续使用时间不宜超过40分钟</Text></View>
            <View className="weekly-note"><View className="weekly-note-title"><Image src={art.goalIcon} mode="aspectFit" /><Text>小目标</Text></View><Text>至少使用5天，每天使用1～2小时</Text></View>
          </Card>
          <View className="weekly-actions"><Primary onClick={() => open('history')}>查看历史报告</Primary><View className="split-buttons"><Primary secondary onClick={() => open('feedback')}>家长反馈</Primary><Primary secondary onClick={() => goShare('week')}>生成分享卡</Primary></View></View>
        
        </>)}
        {tab === 'rewards' && (!ready ? <Empty title="添加读写台后开启奖励" text="完成任务，积攒奖励币，兑现亲子约定" action="添加设备" onClick={() => open('setup')} /> : <>
          <Card className="wallet reward-section"><View className="wallet-main"><Image src={art.coin} mode="aspectFit" /><View><Text className="muted">当前家族币数量</Text><Text className="wallet-balance">{state.balance}</Text></View><Button className="link-button" onClick={() => open('records')}>查看记录 ›</Button></View>{state.promises.filter(p => p.status === 'pending').map(item => <View className="pending-redemption" key={item.id}><View><Text><Text className="accent">待兑现</Text> · {state.child?.name || '孩子'}已确认</Text><Text className="small-note">{item.title}　扣除 {item.cost} 个家族币</Text></View><Button className="pill primary-pill" onClick={() => redeem(item)}>去兑现</Button></View>)}</Card>
          <Card className="reward-section task-section"><Heading title="家长任务" titleImage={art.taskHeading} action="创建任务" onClick={() => createTask()} />{state.tasks.length === 0 && <Text className="muted paragraph">还没有给孩子下发任务呢～</Text>}{[...state.tasks].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || a.editedAt.localeCompare(b.editedAt)).map(task => <View className="reward-row" key={task.id}><Button className="reward-main" onClick={() => createTask(task)}><Image src={task.status === 'pending' ? art.taskPending : art.taskActive} mode="aspectFit" /><View><Text className="row-title">{task.title}</Text><View className="reward-detail"><Text>{task.repeat ? task.kind === 'reading' ? '每日重复' : '每周重复' : '1次'} · 完成后可获得</Text><Coin amount={`+${task.reward}`} /></View></View></Button>{task.status === 'pending' ? <Button className="pill primary-pill" onClick={() => confirmTask(task)}>待确认</Button> : <Text className="pill soft-pill">进行中</Text>}</View>)}</Card>
          <Card className="reward-section promise-section"><Heading title="亲子约定" titleImage={art.promiseHeading} action="创建约定" onClick={() => createPromise()} />{state.promises.filter(p => p.status === 'active').length === 0 && <Text className="muted paragraph">还没有为孩子创建约定呢～</Text>}{state.promises.filter(p => p.status === 'active').sort((a, b) => a.editedAt.localeCompare(b.editedAt)).map(item => <View className="promise-row" key={item.id}><Button className="promise-main" onClick={() => createPromise(item)}><Image src={art.promiseActive} mode="aspectFit" /><View className="promise-description"><View className="promise-line"><Text className="row-title">{item.title}</Text><Coin amount={`${state.balance}/${item.cost}`} /></View><View className="progress-track"><View style={{ width: `${promisePercent(state.balance, item.cost)}%` }} /></View></View></Button><Text className="pill soft-pill">进行中</Text></View>)}</Card>
          <Card className="reward-section"><Row label="补勤卡" value={`${Math.max(0, state.cards.filter(card => card.kind === '下发').length - state.cards.filter(card => card.kind === '使用').length)}张`} onClick={() => open('cards')} /></Card>
        </>)}
        {tab === 'kids' && (!ready || !state.device?.online ? <Empty title="给设备联网" text="联网后查看孩子提出的建议与共创进展" action="配置网络" onClick={() => open(hasDevice ? 'network' : 'setup')} /> : <>
          <View className="kids-level"><Image className="kids-level-art" src={art.kidsLevel} mode="widthFix" /><Text className="contribution-value">0</Text><Text className="adopted-value">{suggestions.filter(item => item.status === '已采纳').length}</Text></View>
          {suggestions.filter(item => item.status === '已采纳').sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 1).map(item => <Card className="kids-highlight" key={item.id}><Image src={art.kidsRobot} mode="aspectFit" /><View><Text className="row-title">{item.title}</Text><Text className="small-note">已在{item.version || '上线版本待确认'}上线</Text></View><Button className="pill green-pill" onClick={() => goShare('idea')}>分享</Button></Card>)}
          <Card className="kids-timeline"><View className="section-heading"><View className="kids-timeline-title"><Image src={art.timelineHeading} mode="aspectFit" /><Text>建议时间线</Text></View></View>{[...suggestions].sort((a, b) => b.date.localeCompare(a.date)).map(item => <Button className="suggestion-row" key={item.id} onClick={() => { setSelectedIdea(item); open('suggestion'); }}><View><Text className="small-note">{item.date}</Text><Text className="row-title">{item.title}</Text></View><Image className="status-stamp" src={item.status === '已采纳' ? art.stampAdopted : item.status === '评估中' ? art.stampEvaluating : item.status === '已进金点子库' ? art.stampGolden : art.stampReceived} mode="aspectFit" /></Button>)}</Card>
          <Button className="idea-library" onClick={() => open('ideas')}><Image src={art.idea} mode="aspectFit" /><View><Text className="row-title">金点子库</Text><Text className="idea-library-note"><Text className="idea-library-count">{suggestions.filter(item => item.status === '已进金点子库').length}个</Text>点子被珍藏</Text></View><Text className="chevron">›</Text></Button>
        </>)}
        {tab === 'mine' && <>
          <View className="mine-profile"><Image className="parent-avatar-image" src={state.loggedIn ? state.profileAvatar || art.homeAvatar : art.parentDefaultAvatar} mode="aspectFill" /><Button className="mine-profile-name" onClick={() => { if (!state.loggedIn) open('setup'); }}>{state.loggedIn ? state.nickname : '登陆/注册'}</Button>{state.loggedIn && <Button className="mine-profile-link" onClick={() => open('personal')}>个人中心</Button>}</View>
          {ready && <>
            <Text className="group-label">孩子管理</Text>
            <Button className="mine-entry-card mine-child-entry" onClick={() => open('child')}><Image src={state.child?.avatar || art.robot} mode="aspectFit" /><View><Text className="row-title">{state.child?.name || '完善孩子信息'}</Text><Text className="small-note">{state.child ? `${state.child.gender} | ${state.child.birthday.replace('-', '年')}月` : '添加孩子档案'}</Text></View><Text className="chevron">›</Text></Button>
            <Text className="group-label">健康报告</Text>
            <MineEntry icon="vision" label="视光报告" onClick={() => open('reports')} />
          </>}
          <Text className="group-label">设备管理</Text>
          <MineEntry icon="device" label={ready ? state.device?.name || '空间光学读写台' : '空间光学读写台'} onClick={ready ? () => open('device') : undefined} action={!ready ? '添加设备' : undefined} onAction={() => open('setup')} />
          {state.loggedIn && hasDevice && <MineEntry icon="network" label="网络配置" onClick={() => open('network')} />}
          {ready && <><MineEntry icon="posture" label="坐姿提醒设置" onClick={() => open('postureSettings')} /><MineEntry icon="voice" label="语音伴学设置" onClick={() => open('voiceSettings')} /></>}
          {ready && <><Text className="group-label">消息</Text><MineEntry icon="message" label="消息中心" onClick={() => open('messages')} unread={hasUnreadMessages} /></>}
          <Text className="group-label">帮助</Text>
          <MineEntry icon="guide" label="使用帮助" onClick={() => open('guide')} />
          <MineEntry icon="service" label="售后服务" onClick={() => open('service')} />
          <View className="preview-tools"><Text className="small-note">预览工具</Text><Button className="link-button" onClick={() => open('setup')}>走一遍首次使用流程 ›</Button><Button className="link-button" onClick={() => open('intercept')}>预览长期未使用问卷 ›</Button><Button className="link-button" onClick={() => { update({ type: 'weeklyEmpty.toggle' }); }}>演示：周报无使用数据/有数据 ›</Button><Button className="link-button" onClick={async () => { if (await ask('重置示例数据？', '将清除本机开发预览中的修改，恢复初始示例。')) { try { const next = resetDemo(); stateRef.current = next; setState(next); toast('示例数据已重置'); } catch (error) { toast(error instanceof Error ? error.message : '重置失败，请重试'); } } }}>重置示例数据</Button></View>
        </>}
      </>}
    </View>}
    {(!panel || overlay || panel === 'history') && <View className="tabbar">{nav.filter(item => panel !== 'history' || item.id !== 'kids').map(item => <Button className={`tab-button ${item.id === tab ? 'active' : ''}`} key={item.id} onClick={() => selectTab(item.id)}><Image className="tab-icon" src={item.id === tab ? item.activeIcon : item.icon} mode="aspectFit" /><Text>{item.label}</Text></Button>)}</View>}
    {confirmation && <View className="modal-backdrop"><View className="confirmation-sheet"><Text>{confirmation.title}</Text>{confirmation.content && <Text className="confirmation-content">{confirmation.content}</Text>}<View className="split-buttons"><Primary secondary onClick={() => setConfirmation(null)}>取消</Primary><Primary onClick={confirmation.confirm}>{confirmation.confirmText || '确认'}</Primary></View></View></View>}
    {overlay && <View className="modal-backdrop"><View className={`modal-sheet ${panel === 'intercept' ? 'recall-sheet' : ''}`}><Button className="modal-close" onClick={close}>×</Button>{panel === 'suggestion' && selectedIdea && <SuggestionPanel item={selectedIdea} />}{panel === 'intercept' && <InterceptPanel update={update} close={close} />}</View></View>}
  </View>;
}

function MineEntry({ icon, label, onClick, action, onAction, unread = false }: { icon: 'device' | 'network' | 'posture' | 'voice' | 'vision' | 'message' | 'guide' | 'service'; label: string; onClick?: () => void; action?: string; onAction?: () => void; unread?: boolean }) {
  return <View className="mine-entry-card" onClick={onClick}><View className={`mine-entry-icon mine-entry-icon-${icon}`}><View /></View><Text className="row-title">{label}</Text>{action ? <Button className="add-device-button" onClick={event => { event.stopPropagation(); onAction?.(); }}>{action}</Button> : <>{unread && <View className="message-unread-dot" />}<Text className="chevron">›</Text></>}</View>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View className="metric"><Text className="metric-value">{value}</Text><Text className="muted metric-label">{label}</Text></View>;
}
function UsageChart({ values, labels = ['一', '二', '三', '四', '五', '六', '日'], dense = false }: { values: number[]; labels?: string[]; dense?: boolean }) {
  const max = Math.max(120, Math.ceil(Math.max(...values) / 15) * 15);
  const ticks: number[] = [];
  for (let value = max; value >= 0; value -= 15) ticks.push(value);
  return <View className={`usage-chart ${dense ? 'dense' : ''}`}><View className="chart-scale">{ticks.map(value => <Text key={value}>{value}</Text>)}</View><View className="chart-columns">{values.map((value, i) => <View className="chart-column" key={i}><View className={`bar ${i % 2 ? 'dark' : ''}`} style={{ height: `${value / max * 100}%` }} /><Text className="bar-label">{labels[i]}</Text></View>)}</View></View>;
}

type PanelProps = { state: DemoState; update: (action: Action) => boolean; close: () => void };
function TaskPanel({ task, state, update, close }: PanelProps & { task: Task | null }) {
  const [kind, setKind] = useState(task?.kind || 'reading');
  const [minutes, setMinutes] = useState(task?.minutes || 30);
  const [days, setDays] = useState(task?.days || 5);
  const [reward, setReward] = useState(task?.reward || 30);
  const [repeat, setRepeat] = useState(task?.repeat ?? true);
  const [sync, setSync] = useState(task?.sync ?? true);
  const readOnly = task?.status === 'pending';
  const duplicate = !task && state.tasks.some(t => t.kind === kind);
  const chooseKind = (next: 'reading' | 'frequency') => {
    if (task) return;
    setKind(next); setMinutes(30); setDays(5); setReward(next === 'reading' ? 30 : 150); setRepeat(true); setSync(true);
  };
  const save = () => {
    const next: Task = { id: task?.id || newId('task'), kind, title: kind === 'reading' ? '阅读打卡' : '使用频次打卡', minutes, days: kind === 'reading' ? 1 : days, reward, repeat, sync, status: 'active', pendingReward: 0, editedAt: new Date().toISOString() };
    if (update({ type: 'task.save', task: next })) { toast(task ? '示例任务已更新' : '示例任务已发布'); close(); }
  };
  return <>
    <Heading title="选个任务模版" /><View className="template-grid two-columns">{[{ id: 'reading' as const, title: '阅读打卡', art: art.reading }, { id: 'frequency' as const, title: '使用频次打卡', art: art.frequency }].map(item => <Button className={`template-card ${kind === item.id ? 'selected' : ''}`} key={item.id} disabled={Boolean(task && kind !== item.id)} onClick={() => chooseKind(item.id)}><Image src={item.art} mode="aspectFit" /><Text>{item.title}</Text></Button>)}</View>
    {readOnly ? <Card><Text className="notice">任务已完成，等待家长确认奖励，暂不支持修改或删除。</Text><Row label="累计使用时长" value={`${minutes}分钟`} />{kind === 'frequency' && <Row label="每周使用天数" value={`${days}天`} />}<Row label="本次待发奖励" value={`${task.pendingReward}个奖励币`} /><Row label="频次" value={repeat ? kind === 'reading' ? '每日重复' : '每周重复' : '1次'} /></Card> : <>
      {duplicate && <Text className="notice">每个模板只能创建1个任务，可编辑或删除已有任务。</Text>}
      <Card>{kind === 'frequency' && <Counter label="每周使用天数" value={days} setValue={setDays} min={1} max={7} />}<Counter label={kind === 'reading' ? '阅读时长' : '每天累计使用时长'} value={minutes} setValue={setMinutes} min={1} max={300} /><Counter label="家族币" value={reward} setValue={setReward} min={1} max={500} /><Selector label="频次" values={[kind === 'reading' ? '每日重复' : '每周重复', '1次']} value={repeat ? kind === 'reading' ? '每日重复' : '每周重复' : '1次'} onChange={value => setRepeat(value !== '1次')} /><Toggle label="同步给小可" note="正式接入后设备端会告诉孩子" enabled={sync} onChange={setSync} /></Card>
      <Primary disabled={duplicate} onClick={save}>{task ? '保存修改' : '发布任务'}</Primary>
      {task && <Button className="danger-button" onClick={async () => { if (await ask('删除任务？', '删除后任务不再显示，设备使用数据保留。')) { if (update({ type: 'task.delete', id: task.id })) close(); } }}>删除任务</Button>}
      {task && <View className="preview-tools"><Button className="link-button" onClick={() => { if (update({ type: 'task.complete', id: task.id })) { close(); toast('示例任务已达标，返回列表确认发币'); } }}>演示：设备使用达到目标</Button></View>}
    </>}
  </>;
}

const promiseTemplates = [
  { title: '运动30分钟', category: '运动类' as const, image: art.sport },
  { title: '看电影1次', category: '娱乐类' as const, image: art.movie },
  { title: '去游乐园', category: '娱乐类' as const, image: art.park },
  { title: '买礼物', category: '购物类' as const, image: art.gift },
  { title: '自由时间1小时', category: '其他' as const, image: art.free },
  { title: '自定义', category: '其他' as const, image: art.custom },
];
function useSubmitGuard() {
  const lock = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const run = (action: () => void) => {
    if (lock.current) return;
    lock.current = true; setSubmitting(true);
    try { action(); } finally { lock.current = false; setSubmitting(false); }
  };
  return { submitting, run };
}
function PromisePanel({ item, state, update, close }: PanelProps & { item: PromiseItem | null }) {
  const [title, setTitle] = useState(item?.title || '运动30分钟');
  const [cost, setCost] = useState(item?.cost || 300);
  const [category, setCategory] = useState<PromiseItem['category']>(item?.category || '运动类');
  const { submitting, run } = useSubmitGuard();
  return <>
    <Heading title="选个约定模版" /><View className={`template-grid ${item ? 'editing' : 'creating'}`}>{promiseTemplates.map(template => <Button className={`template-card ${title === template.title ? 'selected' : ''}`} key={template.title} onClick={() => { setTitle(template.title === '自定义' ? '' : template.title); setCategory(template.category); setCost(300); }}><Image src={template.image} mode="aspectFit" /><Text>{template.title}</Text></Button>)}</View>
    <Card><Field label="约定名称" value={title} onChange={setTitle} maxLength={20} placeholder="填写一个期待的小奖励" /><Counter label="所需家族币" value={cost} setValue={setCost} min={1} max={999} /><Selector label="分类" values={['运动类', '娱乐类', '购物类', '其他']} value={category} onChange={value => setCategory(value as PromiseItem['category'])} />{item && <><Text className="small-note">现有 {state.balance} / 目标 {cost} 个奖励币</Text><View className="progress-track"><View style={{ width: `${promisePercent(state.balance, cost)}%` }} /></View></>}</Card>
    <Text className="promise-note">家族币来自孩子的夜航收益和任务，达成后孩子确认，即可线下兑现</Text>
    <Primary disabled={!title.trim() || submitting} onClick={() => run(() => { if (update({ type: 'promise.save', item: { id: item?.id || newId('promise'), title: title.trim(), cost, category, status: 'active', editedAt: new Date().toISOString() } })) { close(); toast('示例约定已保存'); } })}>{item ? '保存修改' : '创建约定'}</Primary>
    {item && <><Button className="promise-delete" onClick={async () => { if (await ask('删除约定？', '删除后约定不再显示。')) { if (update({ type: 'promise.delete', id: item.id })) close(); } }}>删除约定</Button><View className="preview-tools"><Button className="link-button" onClick={() => { if (update({ type: 'promise.request', id: item.id })) { close(); toast('示例孩子已确认，返回列表兑现'); } }}>演示：孩子在设备端确认达成</Button></View></>}
  </>;
}
function RecordsPanel({ state }: { state: DemoState }) {
  if (!state.records.length) return <Empty title="暂无收支记录" text="任务奖励和约定兑换将在这里留下记录" />;
  return <View className="records-list">{state.records.map(record => <View className="record-row" key={record.id}><View><Text className="row-title">{record.title}</Text><Text className="small-note">{record.date.split('-').join('/')}</Text></View><View className={record.amount > 0 ? 'record-income' : 'record-expense'}><Coin amount={`${record.amount > 0 ? '+' : '−'}${Math.abs(record.amount)}`} /></View></View>)}</View>;
}

function DevicePanel({ state, update, open, close }: PanelProps & { open: (panel: Exclude<Panel, null>) => void }) {
  const [name, setName] = useState(state.device?.name || '空间光学读写台');
  if (!state.device) return <Empty title="尚未添加设备" text="先连接你的读写台" action="添加设备" onClick={() => open('setup')} />;
  return <><Image className="device-hero" src={art.desk} mode="aspectFit" /><Card><Field label="设备名称" value={name} onChange={setName} maxLength={10} /><Row label="型号" value={state.device.model} /><Row label="序列号" value={state.device.sn} /><Row label="软件版本" value="示例版本" /><Row label="状态" value={state.device.online ? '在线（示例）' : '离线（示例）'} /></Card><Primary disabled={!name.trim()} onClick={() => { update({ type: 'device.save', device: { ...state.device!, name: name.trim() } }) && toast('示例设备名称已保存'); }}>保存名称</Primary><Card><Row label="坐姿提醒设置" onClick={() => open('postureSettings')} /><Row label="语音伴学设置" onClick={() => open('voiceSettings')} /><Row label="网络配置" onClick={() => open('network')} /></Card><Button className="danger-button" onClick={async () => { if (await ask('移除设备？', '开发预览中的孩子、设备和奖励数据将置空，保留示例账号。')) { if (update({ type: 'device.remove' })) close(); } }}>移除设备</Button><View className="preview-tools"><Button className="link-button" onClick={() => { update({ type: 'device.save', device: { ...state.device!, online: !state.device!.online } }); close(); }}>演示：切换设备在线/离线</Button><Button className="link-button" onClick={() => { update({ type: 'device.save', device: { ...state.device!, present: !state.device!.present } }); close(); }}>演示：切换学习/未学习</Button></View></>;
}
function SettingsPanel({ state, update, close, kind }: PanelProps & { kind?: 'posture' | 'voice' }) {
  const [settings, setSettings] = useState({ ...state.settings });
  const posture = kind !== 'voice';
  return <><Card>{posture ? <><Toggle label="坐姿提醒" enabled={settings.posture} onChange={postureEnabled => setSettings({ ...settings, posture: postureEnabled })} />{settings.posture && <Selector label="提醒间隔" values={['5分钟', '10分钟', '15分钟', '30分钟']} value={`${settings.interval}分钟`} onChange={value => setSettings({ ...settings, interval: parseInt(value) })} />}</> : <><Toggle label="语音伴学" enabled={settings.voice} onChange={voice => setSettings({ ...settings, voice })} />{settings.voice && <Selector label="每日可用时长" values={Array.from({ length: 24 }, (_, i) => `${i + 1}小时`)} value={settings.voiceLimit} onChange={voiceLimit => setSettings({ ...settings, voiceLimit })} />}</>}</Card><Text className="small-note paragraph">当前设置只更新开发预览；云端下发与设备回执待接口接入。</Text><Primary onClick={() => { if (update({ type: 'settings.save', settings })) { close(); toast('示例设置已保存'); } }}>保存</Primary><Primary secondary onClick={close}>取消</Primary></>;
}

function SetupFlow({ state, update, open, finish, networkOnly = false }: { state: DemoState; update: (action: Action) => boolean; open: (panel: Exclude<Panel, null>) => void; finish: () => void; networkOnly?: boolean }) {
  const [step, setStep] = useState<SetupStep>(networkOnly ? process.env.TARO_ENV === 'weapp' ? 'bluetooth' : 'wifi' : 'add');
  const [agreementOpen, setAgreementOpen] = useState(true);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [platformPrivacyReady, setPlatformPrivacyReady] = useState(process.env.TARO_ENV !== 'weapp');
  const privacyResolver = useRef<((option: { event: 'exposureAuthorization' | 'agree' | 'disagree'; buttonId?: string }) => void) | null>(null);
  const agreementAccepted = useRef(false);
  const [networkFailed, setNetworkFailed] = useState(false);
  const [deniedPerm, setDeniedPerm] = useState<'bluetooth' | 'location' | null>(null);
  const [foundState, setFoundState] = useState<'searching' | 'notFound' | 'ready' | 'pairing' | 'connectFailed' | 'bindFailed'>('searching');
  const [network, setNetwork] = useState('BRO');
  const [wifiOptions, setWifiOptions] = useState<string[]>(['BRO', '示例家庭网络']);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [manual, setManual] = useState(false);
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);
  const [child, setChild] = useState(networkOnly ? state.child || emptyChild() : emptyChild());
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileComplete, setProfileComplete] = useState(false);
  const [networkReady, setNetworkReady] = useState(false);
  const [failures, setFailures] = useState(0);
  const [failureText, setFailureText] = useState('');
  const [nearby, setNearby] = useState<NearbyDevice[]>([]);
  const [scanDone, setScanDone] = useState(false);
  const [realBusy, setRealBusy] = useState(false);
  const [realResult, setRealResult] = useState('');
  const [phoneAuthMessage, setPhoneAuthMessage] = useState('');
  const [bluetoothReady, setBluetoothReady] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const connection = useRef<ConnectionCheck | null>(null);
  const bleSession = useRef<BleSession | null>(null);
  const mounted = useRef(true);
  const capability = bluetoothCapability();
  useEffect(() => {
    if (process.env.TARO_ENV !== 'weapp') return;
    Taro.onNeedPrivacyAuthorization(resolve => {
      if (agreementAccepted.current) { resolve({ event: 'agree', buttonId: 'privacy-agree' }); return; }
      privacyResolver.current = resolve;
      setAgreementOpen(true);
      resolve({ event: 'exposureAuthorization' });
    });
    Taro.requirePrivacyAuthorize({ success: () => setPlatformPrivacyReady(true) });
  }, []);
  useEffect(() => {
    if (platformPrivacyReady && agreementAccepted.current) {
      setAgreementOpen(false); setHasAgreed(true); setStep('login');
    }
  }, [platformPrivacyReady]);
  useEffect(() => {
    Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => undefined);
  }, [step]);
  useEffect(() => () => {
    mounted.current = false;
    connection.current?.disconnect().catch(() => undefined);
    bleSession.current?.disconnect().catch(() => undefined);
    void releaseBluetooth();
  }, []);
  const checkReal = async (device?: NearbyDevice) => {
    setRealBusy(true); setRealResult('');
    try {
      if (process.env.TARO_ENV === 'weapp') {
        if (!device) throw new Error('请选择附近设备');
        setFoundState('pairing');
        if (bleSession.current) await bleSession.current.disconnect();
        const next = new BleSession(device);
        const result = await next.connect();
        if (!mounted.current) { await next.disconnect(); return; }
        bleSession.current = next;
        setRealResult(`BLE 握手成功：${result.deviceSn}，正在扫描附近 Wi-Fi…`);
        try {
          const networks = await next.scanWifi();
          const options = networks.map(item => item.ssid);
          setWifiOptions(options);
          if (options[0]) { setNetwork(options[0]); setManual(false); }
          setRealResult(`BLE 握手成功：${result.deviceSn}。扫描到 ${options.length} 个 Wi-Fi，可继续配网；云端激活尚未确认。`);
        } catch (scanError) {
          setRealResult(`BLE 握手成功，但 Wi-Fi 扫描失败：${scanError instanceof Error ? scanError.message : '未知错误'}。可手动输入网络。`);
        }
        setStep('wifi');
      } else {
        if (connection.current) await connection.current.disconnect();
        const result = await checkConnection(device);
        if (!mounted.current) { await result.disconnect(); return; }
        connection.current = result;
        setRealResult(`已连接：${result.name}。网页端仅做连接检查，真实配网请使用微信小程序。`);
      }
    } catch (error) {
      if (mounted.current) {
        setFoundState('connectFailed');
        setRealResult(error instanceof Error ? error.message : '连接失败，请检查蓝牙与授权');
      }
    } finally { if (mounted.current) setRealBusy(false); }
  };
  const scanReal = async () => {
    setRealBusy(true); setRealResult('');
    try {
      const devices = await scanWechatDevices();
      if (mounted.current) { setNearby(devices); setScanDone(true); setFoundState(devices.length ? 'ready' : 'notFound'); }
    } catch (error) {
      if (mounted.current) { setFoundState('notFound'); setRealResult(error instanceof Error ? error.message : '未能扫描，请检查手机蓝牙、微信权限与设备电源'); }
    }
    finally { if (mounted.current) setRealBusy(false); }
  };
  const allowBluetooth = async () => {
    if (process.env.TARO_ENV !== 'weapp') { toast('请在微信小程序真机上授权蓝牙'); return; }
    try { await Taro.openBluetoothAdapter(); setBluetoothReady(true); setDeniedPerm(null); setStep('location'); }
    catch { setDeniedPerm('bluetooth'); }
  };
  const acceptAgreement = () => {
    agreementAccepted.current = true;
    if (platformPrivacyReady) { setAgreementOpen(false); setHasAgreed(true); setStep('login'); return; }
    const resolve = privacyResolver.current;
    if (resolve) { privacyResolver.current = null; resolve({ event: 'agree', buttonId: 'privacy-agree' }); }
    else Taro.requirePrivacyAuthorize({ success: () => setPlatformPrivacyReady(true), fail: () => toast('请先同意微信隐私保护指引') });
  };
  const rejectAgreement = () => {
    agreementAccepted.current = false;
    privacyResolver.current?.({ event: 'disagree' });
    privacyResolver.current = null;
    setAgreementOpen(false);
  };
  const skipCurrentStep = () => {
    setDeniedPerm(null);
    if (step === 'add') rejectAgreement();
    if (step === 'permissions') setPhoneAuthMessage('');
    if (step === 'location') setFoundState('searching');
    setStep(nextSkippedStep(step));
  };
  const allowLocation = async () => {
    if (process.env.TARO_ENV !== 'weapp') { toast('请在微信小程序真机上授权位置'); return; }
    try {
      const setting = await Taro.getSetting();
      if (setting.authSetting['scope.userLocation'] === false) {
        const result = await Taro.openSetting();
        if (!result.authSetting['scope.userLocation']) throw new Error('位置权限未开启');
      } else await Taro.authorize({ scope: 'scope.userLocation' });
      setLocationReady(true); setDeniedPerm(null); setFoundState('searching'); setStep('found');
    } catch { setDeniedPerm('location'); }
  };
  useEffect(() => {
    if (step === 'found' && foundState === 'searching' && bluetoothReady && locationReady && process.env.TARO_ENV === 'weapp') void scanReal();
  }, [step, foundState, bluetoothReady, locationReady]);
  const refreshWifi = async () => {
    const session = bleSession.current;
    if (!session) { toast('开发预览暂无真实Wi-Fi列表'); return; }
    setRealBusy(true);
    try {
      const networks = await session.scanWifi();
      const options = networks.map(item => item.ssid);
      setWifiOptions(options);
      if (options[0]) { setNetwork(options[0]); setManual(false); }
      setNetworkMenuOpen(false);
      toast(`已刷新，扫描到 ${options.length} 个 Wi-Fi`);
    } catch (error) { toast(error instanceof Error ? error.message : 'Wi-Fi 扫描失败'); }
    finally { setRealBusy(false); }
  };
  const startNetwork = async () => {
    const error = validateWifiCredentials(network, password);
    if (error) { toast(error); return; }
    if (process.env.TARO_ENV === 'weapp' && !bleSession.current) { toast('请先连接真实读写台'); return; }
    setStep('connecting'); setNetworkReady(false); setNetworkFailed(false); setProfileOpen(!networkOnly && !profileComplete);
    const session = bleSession.current;
    if (!session) return;
    try {
      await session.configureWifi(newId('wifi'), network, password);
      if (!mounted.current) return;
      setNetworkReady(true);
      setRealResult('设备已返回 NETWORK_READY；云端激活接口尚未接入，暂不进入首页。');
    } catch (error) {
      if (!mounted.current) return;
      const status = error instanceof BleProtocolError ? error.status : '';
      const messages: Record<string, string> = {
        PASSWORD_ERROR: 'Wi-Fi 密码错误，请检查后重试',
        NETWORK_NOT_FOUND: '找不到该 Wi-Fi，请检查名称或靠近路由器',
        SIGNAL_WEAK_OR_ASSOC_TIMEOUT: '信号较弱或连接路由器超时',
        DHCP_TIMEOUT: '路由器连接成功，但获取网络地址超时',
        NO_INTERNET: 'Wi-Fi 已连接，但当前无法访问互联网',
        WIFI_TIMEOUT: '配网等待超时，可重试或查询原任务状态',
        OTA_BUSY: '设备正在更新，请稍后再配网',
        SESSION_EXPIRED: 'BLE 会话已过期，请重新连接设备',
      };
      setFailures(value => value + 1);
      setNetworkFailed(true);
      setFailureText(messages[status] || (error instanceof Error ? error.message : '网络连接失败，请重试'));
      setStep('failure');
    }
  };
  const finishBinding = () => {
    if (update({ type: 'device.save', device: { name: '空间光学读写台', sn: 'DEMO-0261', model: 'Ultra', online: true, present: true } })) {
      setPassword('');
      finish();
    }
  };
  const saveProfile = () => {
    if (!update({ type: 'child.save', child })) return;
    setProfileComplete(true);
    setProfileOpen(false);
    if (networkFailed) setStep('failure');
  };
  const skipProfile = () => {
    setProfileComplete(true);
    setProfileOpen(false);
    if (networkFailed) setStep('failure');
  };
  useEffect(() => {
    if (process.env.TARO_ENV === 'weapp' || step !== 'connecting' || networkReady || networkFailed || bleSession.current) return;
    const timer = setTimeout(() => {
      setNetworkReady(true);
      if (networkOnly && state.device && update({ type: 'device.save', device: { ...state.device, online: true } })) {
        setPassword('');
        finish();
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [step, networkReady, networkFailed, networkOnly]);
  useEffect(() => {
    if (process.env.TARO_ENV !== 'weapp' && step === 'connecting' && networkReady && profileComplete && !profileOpen && !networkOnly && !bleSession.current) finishBinding();
  }, [step, networkReady, profileComplete, profileOpen, networkOnly]);
  const LoginScene = ({ dimmed = false }: { dimmed?: boolean }) => <View className={`setup-login-scene ${dimmed ? 'is-dimmed' : ''}`}>
    <View className="setup-topbar"><Button onClick={() => setStep('add')}>‹</Button><View /></View>
    <View className="setup-logo"><View><Text>FUTURUS</Text><Text>爱视可</Text></View></View><Text className="setup-brand">FUTURUS 爱视可</Text>
    <Primary onClick={() => setStep('permissions')}><Text className="phone-login-icon" />手机号快捷登录</Primary>
    <Button className="setup-cancel" onClick={() => setStep('add')}>取消登录</Button>{!dimmed && <Button className="setup-demo-skip" onClick={skipCurrentStep}>演示：跳过此步</Button>}
  </View>;
  const visibleNetworkReady = networkReady && !profileOpen;
  return <>
    {(step === 'wifi' || step === 'connecting' || networkOnly) && <Text className="notice">{bleSession.current ? '设备 BLE 已连接；设备联网后仍需服务端确认账号绑定。' : '当前为开发演示，尚未向真实设备发送 Wi-Fi 密码，也不会完成账号绑定。'}</Text>}
    {step === 'add' && <View className="setup-stage setup-agreement-stage"><View className="setup-home-preview"><View className="setup-preview-card"><View className="unbound-device-illustration"><View /><Text /></View><Text>暂无数据</Text><Button onClick={() => hasAgreed ? setStep('login') : setAgreementOpen(true)}>添加设备</Button></View></View>{agreementOpen && <><View className="setup-dim" /><View className="agreement-sheet"><View className="agreement-brand"><Text className="agreement-mark">F</Text><Text>FUTURUS 爱视可隐私政策提醒</Text></View><Text className="agreement-title">用户协议及隐私保护</Text><Text className="agreement-copy">本服务由 FUTURUS 爱视可提供。请阅读下方微信小程序隐私保护指引。正式儿童隐私协议和用户协议尚待提供，当前版本仅供开发体验。</Text><Button className="agreement-links" onClick={() => process.env.TARO_ENV === 'weapp' ? Taro.openPrivacyContract({}) : open('privacy')}>查看微信小程序隐私保护指引</Button><View className="agreement-actions"><Button onClick={rejectAgreement}>拒绝</Button><Button id="privacy-agree" openType={process.env.TARO_ENV === 'weapp' ? 'agreePrivacyAuthorization' : undefined} onAgreePrivacyAuthorization={acceptAgreement} onClick={acceptAgreement}>同意</Button></View><Button className="setup-demo-skip" onClick={skipCurrentStep}>演示：跳过此步</Button></View></>}</View>}
    {step === 'login' && <LoginScene />}
    {step === 'permissions' && <View className="setup-stage phone-auth-stage"><LoginScene dimmed /><View className="setup-dim" /><View className="phone-auth-sheet"><View className="phone-auth-brand"><Text className="agreement-mark">F</Text><View><Text>FUTURUS 爱视可</Text><Text className="small-note">申请获取你的手机号</Text></View><Text className="phone-info">ⓘ</Text></View><Text className="phone-auth-copy">微信授权后需由服务端验证手机号；当前服务端接口尚未接通，此处不会完成登录。</Text><Button className="phone-choice" openType={process.env.TARO_ENV === 'weapp' ? 'getPhoneNumber' : undefined} onGetPhoneNumber={event => setPhoneAuthMessage(event.detail.code ? '已取得微信手机号授权码；服务端验证接口尚未接通，暂不能登录或绑定设备。' : '未取得手机号授权，请重试或取消。')} onClick={() => { if (process.env.TARO_ENV !== 'weapp') setPhoneAuthMessage('请在微信小程序真机上验证手机号。'); }}>微信授权手机号</Button>{phoneAuthMessage && <Text className="notice">{phoneAuthMessage}</Text>}<Button className="phone-deny" onClick={() => setStep('add')}>取消</Button><View className="preview-tools"><Button className="link-button" onClick={skipCurrentStep}>演示：跳过此步，进入蓝牙授权</Button></View></View></View>}
    {step === 'bluetooth' && <View className="setup-stage permission-stage"><LoginScene dimmed /><View className="setup-dim" /><View className="permission-sheet"><View className="permission-mark"><Text>🛜</Text></View><Text className="permission-title">申请蓝牙权限</Text><Text className="permission-copy">用于发现并连接附近的读写台，完成设备绑定与配网</Text><View className="permission-actions"><Button onClick={() => setDeniedPerm('bluetooth')}>拒绝</Button><Button onClick={allowBluetooth}>去授权</Button></View><Button className="setup-demo-skip" onClick={skipCurrentStep}>演示：跳过此步</Button></View></View>}
    {step === 'location' && <View className="setup-stage permission-stage"><LoginScene dimmed /><View className="setup-dim" /><View className="permission-sheet"><View className="permission-mark"><Text>📍</Text></View><Text className="permission-title">申请位置权限</Text><Text className="permission-copy">用于在系统要求时搜索附近的读写台；不会读取或保存你的坐标</Text><View className="permission-actions"><Button onClick={() => setDeniedPerm('location')}>拒绝</Button><Button onClick={allowLocation}>去授权</Button></View><Button className="setup-demo-skip" onClick={skipCurrentStep}>演示：跳过此步</Button></View></View>}
    {deniedPerm && <View className="setup-stage permission-stage"><LoginScene dimmed /><View className="setup-dim" /><View className="permission-sheet"><View className="permission-mark"><Text>!</Text></View><Text className="permission-title">{deniedPerm === 'bluetooth' ? '未授权蓝牙，功能无法使用' : '未授权位置信息，功能无法使用'}</Text><Text className="permission-copy">需要授权后才能继续添加设备</Text><View className="permission-actions"><Button onClick={() => { setDeniedPerm(null); setStep('add'); }}>取消</Button><Button onClick={deniedPerm === 'bluetooth' ? allowBluetooth : allowLocation}>重新授权</Button></View><Button className="setup-demo-skip" onClick={skipCurrentStep}>演示：跳过此步</Button></View></View>}
    {step === 'found' && <View className="setup-stage pairing-stage"><View className="setup-page-title"><Button onClick={() => setStep('location')}>‹</Button><Text>添加设备</Text><View /></View>{foundState === 'searching' && <View className="pairing-card"><Image src={art.desk} mode="aspectFit" /><Text className="pairing-title">{bluetoothReady && locationReady ? "正在寻找附近读写台…" : "已跳过授权，暂不搜索设备"}</Text><Text className="pairing-subtitle">{bluetoothReady && locationReady ? "请确保读写台已开机并靠近手机" : "返回完成蓝牙和位置授权后可搜索真实设备"}</Text></View>}{foundState === 'notFound' && <View className="pairing-card"><Text className="pairing-title">未搜索到设备</Text><Text className="pairing-subtitle">请确认设备已开机，且未连接其他手机</Text><Primary onClick={() => setFoundState('searching')}>重新搜索</Primary></View>}{foundState === 'ready' && <View className="pairing-card"><Image src={art.desk} mode="aspectFit" /><Text className="pairing-title">空间光学读写台</Text><Text className="pairing-subtitle">已发现 {nearby.length} 台读写台，请选择设备连接</Text>{nearby.map(device => <Row key={device.id} label={device.name} value="连接设备" onClick={() => checkReal(device)} />)}</View>}{foundState === 'pairing' && <View className="pairing-card"><Image src={art.desk} mode="aspectFit" /><Text className="pairing-title">蓝牙配对中…</Text><View className="pairing-progress"><Text>●　正在连接 BLE 服务…</Text><Text>●　正在读取设备信息…</Text></View><Text className="pairing-toast">正在准备网络配置…</Text></View>}{foundState === 'connectFailed' && <View className="pairing-card"><Text className="pairing-title">设备连接失败</Text><Text className="pairing-subtitle">请靠近设备后重试</Text><Primary onClick={() => setFoundState('searching')}>重新搜索</Primary></View>}{foundState === 'bindFailed' && <View className="pairing-card"><Text className="pairing-title">设备绑定失败</Text><Text className="pairing-subtitle">该设备已被其他账号绑定</Text><Primary onClick={() => setFoundState('searching')}>重新搜索</Primary></View>}<View className="preview-tools"><Text>{capability.message}</Text>{process.env.TARO_ENV === 'weapp' ? <Primary disabled={realBusy || !bluetoothReady || !locationReady} onClick={scanReal}>搜索真实蓝牙设备</Primary> : <Primary disabled={!capability.supported || realBusy} onClick={() => checkReal()}>检查真实蓝牙连接</Primary>}{scanDone && nearby.length === 0 && <Text>未搜索到设备</Text>}{realResult && <Text>{realResult}</Text>}{process.env.TARO_ENV !== 'weapp' && <View className="demo-branch-row"><Button className="link-button" onClick={() => setFoundState('ready')}>演示：搜索到设备</Button><Button className="link-button" onClick={() => setFoundState('notFound')}>演示：未搜索到设备</Button><Button className="link-button" onClick={() => setFoundState('connectFailed')}>演示：连接失败</Button><Button className="link-button" onClick={() => setFoundState('bindFailed')}>演示：已被绑定</Button><Button className="link-button" onClick={() => setStep('wifi')}>演示：进入网络配置</Button></View>}</View></View>}
    {step === 'wifi' && <View className="setup-stage wifi-stage"><View className="setup-page-title"><Button onClick={() => setStep('found')}>‹</Button><Text>网络连接</Text><View /></View><View className="wifi-card"><View className="wifi-heading"><Text>选择Wi-Fi</Text><Button onClick={() => Taro.showModal({ title: '联网指南', content: '请选择2.4GHz、无需网页认证的Wi-Fi；确认网络名称和密码后再继续。', showCancel: false })}>联网指南</Button></View><Text className="wifi-note">设备只支持使用2.4GHz的Wi-Fi连接使用，不支持需要认证的Wi-Fi。</Text><View className="wifi-select-wrap"><Button className="wifi-select" onClick={() => setNetworkMenuOpen(value => !value)}><Text>{manual ? '手动添加网络' : network}</Text><Text>⌄</Text></Button>{networkMenuOpen && <View className="wifi-menu">{wifiOptions.map(name => <Button key={name} onClick={() => { setNetwork(name); setManual(false); setNetworkMenuOpen(false); }}>{name}</Button>)}<Button onClick={refreshWifi}>刷新网络</Button><Button onClick={() => { setManual(true); setNetwork(''); setNetworkMenuOpen(false); }}>添加网络</Button></View>}</View>{manual && <Field label="网络名称" value={network} onChange={setNetwork} placeholder="填写Wi-Fi名称" />}<View className="wifi-password"><Input value={password} password placeholder="输入密码（开放网络可留空）" maxlength={64} onInput={e => setPassword(e.detail.value)} /><Text>◉</Text></View><View className="wifi-remember"><Text>请注意区分大小写</Text><Button onClick={() => setRemember(value => !value)}><Text className={remember ? 'checked' : ''}>✓</Text> 记住密码</Button></View></View><Primary disabled={!network} onClick={startNetwork}>下一步</Primary>{process.env.TARO_ENV !== 'weapp' && <View className="preview-tools"><Button disabled={!network} onClick={() => { const error = validateWifiCredentials(network, password); if (error) { toast(error); return; } startNetwork(); setFailures(n => n + 1); setNetworkFailed(true); setFailureText('WiFi 密码可能不对，或路由器有特殊设置'); if (profileComplete || networkOnly) setStep('failure'); }}>演示本次联网失败</Button></View>}</View>}
    {step === 'connecting' && <View className="setup-stage connecting-stage"><View className="setup-page-title"><Button onClick={() => setStep('wifi')}>‹</Button><Text>连接网络</Text><View /></View><View className="connecting-card"><View className="unbound-device-illustration"><View /><Text /></View><View className={`network-indicator ${visibleNetworkReady ? 'is-ready' : ''}`}>{visibleNetworkReady ? '✓' : <View />}</View><Text className="pairing-title">{visibleNetworkReady ? (bleSession.current ? 'Wi-Fi 已就绪，等待云端激活' : '网络连接成功') : '正在连接网络…'}</Text><Text className="connecting-note">预计需要 <Text>10-30 秒</Text>，请耐心等待</Text><View className={`network-progress ${visibleNetworkReady ? 'is-ready' : ''}`}><Text>{visibleNetworkReady ? '✓' : ''}</Text><Text>{visibleNetworkReady ? '网络连接成功' : '网络连接中…'}</Text></View>{visibleNetworkReady && <Text className="connecting-toast">正在准备设备信息…</Text>}</View>{profileOpen && <><View className="profile-overlay" /><View className="profile-layer"><Image className="profile-sheet-robot" src={art.homeAvatar} mode="aspectFit" /><View className="profile-sheet"><Button className="profile-sheet-close" onClick={skipProfile}>×</Button><View className="profile-sheet-heading"><Text className="profile-sheet-title">{networkReady ? '联网成功，填完这一步就完成啦！' : '等待时填一下'}</Text><Text className="profile-sheet-note">让小可第一次见面，就能叫出宝贝的名字</Text></View><View className="profile-sheet-fields"><Field label="孩子昵称" value={child.name} onChange={name => setChild({ ...child, name })} placeholder="例如：小明" maxLength={10} /><Text className="profile-birthday-label">出生年月</Text><Picker mode="date" fields="month" value={child.birthday || '2016-08'} end={dateToday()} onChange={e => setChild({ ...child, birthday: e.detail.value.slice(0, 7) })}><View className="profile-picker"><Text>{child.birthday || '请选择'}</Text><Text>›</Text></View></Picker><Choice label="性别" values={['男孩', '女孩']} value={child.gender === '男' ? '男孩' : '女孩'} onChange={gender => setChild({ ...child, gender: gender === '男孩' ? '男' : '女' })} /><Primary onClick={saveProfile}>{networkReady ? '保存并开始使用' : '保存'}</Primary><Primary secondary onClick={skipProfile}>{networkReady ? '取消' : '跳过'}</Primary><Text className="profile-sheet-footnote">配网正在后台继续，填写或跳过都不影响连接</Text></View></View></View></>}</View>}
    {step === 'failure' && <View className="setup-stage failure-stage"><View className="setup-page-title"><Button onClick={() => setStep('wifi')}>‹</Button><Text>连接网络</Text><View /></View><View className="failure-content"><Text className="failure-icon">×</Text><Text className="pairing-title">{failures >= 2 ? '还是没连上' : '网络连接失败'}</Text><Text className="failure-copy">{failureText || 'WiFi 密码可能不对，或路由器有特殊设置'}</Text><Text className="failure-code">已尝试{failures}次 · 错误码 E-003</Text><View className="failure-tip"><Text>试试这些办法</Text><Text>1. 确认 WiFi 密码大小写</Text><Text>2. 路由器若开了 5G 双频合一，建议临时分开 2.4G 再试</Text></View></View><View className="failure-actions">{failures >= 2 && <Primary onClick={async () => { if (await ask('请拨打客服电话', '400-0869-920')) Taro.makePhoneCall({ phoneNumber: '4000869920' }); }}>联系客服</Primary>}<Primary secondary onClick={() => setStep('wifi')}>{failures >= 2 ? '再试一次' : '重试'}</Primary></View></View>}
  </>;
}

function ChildPanel({ state, update, close, open }: PanelProps & { open: (panel: Exclude<Panel, null>) => void }) {
  const [child, setChild] = useState(state.child || emptyChild());
  return <><Card><Button className="profile-avatar-row" onClick={async () => { try { const result = await Taro.chooseImage({ count: 1, sourceType: ['album', 'camera'] }); setChild({ ...child, avatar: result.tempFilePaths[0] }); } catch { /* 取消选图时保留当前头像。 */ } }}><Text>头像</Text><Image src={child.avatar || art.robot} mode="aspectFill" /><Text className="chevron">›</Text></Button><Field label="昵称" value={child.name} onChange={name => setChild({ ...child, name })} maxLength={10} placeholder="填写昵称" /><Choice label="性别" values={['男', '女']} value={child.gender} onChange={gender => setChild({ ...child, gender: gender as '男' | '女' })} /><Picker mode="date" fields="month" value={child.birthday || '2016-08'} end={dateToday()} onChange={e => setChild({ ...child, birthday: e.detail.value.slice(0, 7) })}><View className="picker-row"><Text>出生年月</Text><Text>{child.birthday || '请选择'} ›</Text></View></Picker></Card><Primary disabled={!child.name.trim() || !child.birthday} onClick={() => { if (update({ type: 'child.save', child })) { close(); toast('示例孩子信息已保存'); } }}>保存</Primary><Card><Row label="奖励兑换记录" onClick={() => open('records')} /></Card></>;
}
function PersonalPanel({ state, update, close }: PanelProps) {
  const [name, setName] = useState(state.nickname);
  const [avatar, setAvatar] = useState(state.profileAvatar || '');
  return <><View className="personal-card"><Button className="personal-row personal-avatar-row" onClick={async () => { try { const result = await Taro.chooseImage({ count: 1, sourceType: ['album', 'camera'] }); const selectedAvatar = result.tempFilePaths[0]; setAvatar(selectedAvatar); update({ type: 'account.profile', nickname: name, avatar: selectedAvatar }); } catch { /* 取消选图时保留当前头像。 */ } }}><Text className="personal-label">头像</Text><Image src={avatar || art.homeAvatar} mode="aspectFill" /></Button><View className="personal-row personal-name-row"><View className="personal-label-line"><Text className="personal-label">昵称</Text><Text className="personal-hint">最多10个字</Text></View><Input className="personal-name-input" value={name} maxlength={10} onInput={event => { const value = event.detail.value; setName(value); update({ type: 'account.profile', nickname: value, avatar }); }} /></View></View><View className="personal-card personal-phone-card"><View className="personal-row"><View className="personal-label-line"><Text className="personal-label">手机号</Text><Text className="personal-hint">来自注册账号不可修改</Text></View><Text className="personal-value">{state.phone}</Text></View></View><Button className="personal-logout" onClick={async () => { if (await ask('退出登录？', '确认退出当前账号？')) { if (update({ type: 'account.logout' })) close(); } }}>退出登陆</Button></>;
}
type MessageItem = { title: string; date: string; body: string; destination?: Tab };
type MessageCategory = { category: string; previewTime: string; tone: 'orange' | 'green' | 'blue'; items: MessageItem[] };
function MessagesPanel({ selectTab, close, readCategories, update }: { selectTab: (tab: Tab) => void; close: () => void; readCategories: string[]; update: (action: Action) => boolean }) {
  const categories: MessageCategory[] = [
    { category: '待兑换提醒', previewTime: '今天 09:20', tone: 'orange', items: [
      { title: '大妮有1条亲子约定等待兑换', date: '今天 09:20', body: '孩子已经确认完成亲子约定，请及时查看并完成兑换。', destination: 'rewards' },
      { title: '【周末去公园】已由孩子确认', date: '10-10 18:32', body: '孩子已确认完成“周末去公园”，可以前往亲子约定页面处理。', destination: 'rewards' },
      { title: '【看一场电影】已达到兑换条件', date: '10-08 16:05', body: '当前家族币已达到“看一场电影”的兑换条件。', destination: 'rewards' },
    ] },
    { category: '因为你的建议，小可又进化啦', previewTime: '昨天 18:46', tone: 'green', items: [
      { title: '【更温和的坐姿提醒】已被采纳', date: '昨天 18:46', body: '谢谢你的建议！“更温和的坐姿提醒”已被产品团队采纳。' },
      { title: '【增加护眼休息小游戏】进入评估', date: '10-09 11:20', body: '这条建议已经进入产品评估，我们会继续同步进展。' },
      { title: '“夜间降低提示音量”已收到', date: '10-05 14:10', body: '建议已收到，感谢你和孩子一起参与小可共创。' },
    ] },
    { category: '周报生成', previewTime: '10-07 08:00', tone: 'blue', items: [
      { title: '本周护眼周报已生成', date: '10-07 08:00', body: '本周使用数据已经整理完成，可以查看孩子的专注时长与坐姿守护情况。', destination: 'weekly' },
      { title: '上周护眼周报已生成', date: '09-30 08:00', body: '上周护眼周报已生成，点击下方按钮查看。', destination: 'weekly' },
    ] },
  ];
  const unread = categories.map(item => item.category).filter(category => !readCategories.includes(category));
  const [activeCategory, setActiveCategory] = useState<MessageCategory | null>(null);
  const [selected, setSelected] = useState<MessageItem | null>(null);
  const back = () => { if (selected) setSelected(null); else if (activeCategory) setActiveCategory(null); else close(); };
  const title = activeCategory?.category || '消息中心';
  return <><View className="message-page-header" style={process.env.TARO_ENV === 'weapp' ? { paddingTop: `${Taro.getWindowInfo().statusBarHeight}px` } : undefined}><Button onClick={back}>‹</Button><Text>{title}</Text><View /></View>
    {!activeCategory && <><Text className="message-overview-note">按类别显示最新一条消息</Text><View className="message-overview-list">{categories.map(item => <Button className="message-overview-row" key={item.category} onClick={() => { setActiveCategory(item); update({ type: 'messages.read', category: item.category }); }}><View className={`message-category-icon ${item.tone}`}><View />{unread.includes(item.category) && <View className="message-unread-dot" />}</View><View className="message-copy"><Text className="row-title">{item.category}</Text><Text className="small-note">{item.previewTime}</Text></View><Text className="chevron">›</Text></Button>)}</View></>}
    {activeCategory && !selected && <View className="message-category-list">{activeCategory.items.map(item => <View className="message-list-row" key={`${item.title}-${item.date}`}><View className={`message-category-icon ${activeCategory.tone}`}><View /></View><View className="message-copy"><Text className="row-title">{item.title}</Text><Text className="small-note">{item.date}</Text></View><Button className="message-view" onClick={() => setSelected(item)}>查看</Button></View>)}</View>}
    {activeCategory && selected && <View className="message-detail-page"><Text className="message-detail-title">{selected.title}</Text><Text className="small-note">{selected.date}</Text><Text className="message-detail-body">{selected.body}</Text>{selected.destination && <Primary onClick={() => selectTab(selected.destination!)}>去查看</Primary>}</View>}
  </>;
}
function ReportsPanel({ reports, edit, confirmDelete }: { reports: VisionReport[]; edit: (report: VisionReport | null) => void; confirmDelete: (report: VisionReport) => void }) {
  const value = (report: VisionReport, code: VisionMetricCode, side: 'right' | 'left') => report.measurements[code][side] ?? '--';
  const rows: { left: VisionMetricCode[]; right: VisionMetricCode[] }[] = [
    { left: ['smallPupilSphere'], right: ['axialLength'] },
    { left: ['dilatedPupilSphere'], right: ['subjectiveRefraction'] },
    { left: ['uncorrectedVisualAcuity'], right: ['keratometryK1', 'keratometryK2'] },
    { left: ['correctedVisualAcuity'], right: ['anteriorChamberDepth', 'lensThickness'] },
  ];
  const labels: Record<VisionMetricCode, string> = Object.fromEntries(visionMetricDefinitions.map(item => [item.code, item.label])) as Record<VisionMetricCode, string>;
  const compactMetric = (report: VisionReport, codes: VisionMetricCode[]) => <><View className="vision-compact-label">{codes.map(code => <Text key={code}>{labels[code]}</Text>)}</View><View className="vision-compact-values">{codes.map(code => <Text key={code}>{value(report, code, 'right')}</Text>)}</View><View className="vision-compact-values">{codes.map(code => <Text key={code}>{value(report, code, 'left')}</Text>)}</View></>;
  return <>{reports.length === 0 ? <Empty title="暂无视光记录" text="点击下方按钮新建视光报告" /> : reports.map(report => <View key={report.id} className="vision-report-card"><View className="vision-report-head"><Text>{report.examinationDate}</Text><View>{report.canEdit && <Button onClick={() => edit(report)}>编辑</Button>}{report.canDelete && <Button onClick={() => confirmDelete(report)}>删除</Button>}</View></View><View className="vision-report-place"><Text>{report.centerName}</Text><Text>{report.ageYearsAtExamination === null ? '年龄未记录' : `${report.ageYearsAtExamination}岁`}</Text></View><View className="vision-compact-header"><Text /><Text>右</Text><Text>左</Text><Text /><Text>右</Text><Text>左</Text></View>{rows.map((row, index) => <View className="vision-compact-row" key={index}>{compactMetric(report, row.left)}{compactMetric(report, row.right)}</View>)}</View>)}<Primary onClick={() => edit(null)}>＋ 新建报告</Primary></>;
}
type VisionInputs = Record<VisionMetricCode, { right: string; left: string }>;
const ageAtDate = (birthday: string | undefined, date: string) => {
  if (!birthday) return null;
  const [birthYear, birthMonth] = birthday.split('-').map(Number);
  const [year, month] = date.split('-').map(Number);
  if (![birthYear, birthMonth, year, month].every(Number.isFinite)) return null;
  return Math.max(0, year - birthYear - Number(month < birthMonth));
};
const visionInputs = (measurements: VisionMeasurements): VisionInputs => Object.fromEntries(visionMetricDefinitions.map(item => [item.code, {
  right: measurements[item.code].right === null ? '' : String(measurements[item.code].right),
  left: measurements[item.code].left === null ? '' : String(measurements[item.code].left),
}])) as VisionInputs;
const parseVisionValue = (value: string) => value.trim() === '' ? null : Number(value);

function VisionMetricTable({ title, group, values, setValues, readOnly = false }: { title: string; group: 'optometry' | 'ocularBiometry'; values: VisionInputs; setValues?: (values: VisionInputs) => void; readOnly?: boolean }) {
  const items = visionMetricDefinitions.filter(item => item.group === group);
  return <Card className="vision-sheet"><Heading title={title} /><View className="vision-grid vision-grid-header"><Text /><Text>右眼</Text><Text>左眼</Text></View>{items.map(item => <View className="vision-grid" key={item.code}><View className="vision-metric-label"><Text>{item.label}</Text><Text>{item.alias}</Text></View>{(['right', 'left'] as const).map(side => <View className="vision-input-wrap" key={side}><Input disabled={readOnly} type="digit" value={values[item.code][side]} onInput={e => setValues?.({ ...values, [item.code]: { ...values[item.code], [side]: e.detail.value } })} />{item.unit && values[item.code][side] && <Text>{item.unit}</Text>}</View>)}</View>)}</Card>;
}

function VisionPanel({ report, child, update, close }: { report: VisionReport | null; child: Child | null; update: (action: Action) => boolean; close: () => void }) {
  const [date, setDate] = useState(report?.examinationDate || dateToday());
  const [center, setCenter] = useState(report?.centerName || '');
  const [centerDraft, setCenterDraft] = useState(report?.centerName || '');
  const [centerEditing, setCenterEditing] = useState(false);
  const [values, setValues] = useState<VisionInputs>(() => visionInputs(report?.measurements || emptyVisionMeasurements()));
  const { submitting, run } = useSubmitGuard();
  const age = ageAtDate(child?.birthday, date);
  const entries = visionMetricDefinitions.flatMap(item => [values[item.code].right, values[item.code].left]);
  const valid = Boolean(center.trim()) && entries.some(value => value.trim() !== '') && entries.every(value => value.trim() === '' || Number.isFinite(Number(value)));
  return <><View className="vision-meta-card"><Picker mode="date" value={date} end={dateToday()} onChange={e => setDate(e.detail.value)}><View className="vision-date-line"><Text>{date}</Text></View></Picker><Button className="vision-center-line" onClick={() => { setCenterDraft(center); setCenterEditing(true); }}><Text>{center || '请选择视光中心'}</Text><Text className="chevron">›</Text><Text>{age === null ? '年龄未记录' : `${age}岁`}</Text></Button></View><VisionMetricTable title="视光单" group="optometry" values={values} setValues={setValues} /><VisionMetricTable title="眼轴单" group="ocularBiometry" values={values} setValues={setValues} /><Primary disabled={!valid || submitting} onClick={() => run(() => {
    const measurements = emptyVisionMeasurements();
    visionMetricDefinitions.forEach(item => { measurements[item.code] = { right: parseVisionValue(values[item.code].right), left: parseVisionValue(values[item.code].left) }; });
    const next: VisionReport = { id: report?.id || newId('vision'), examinationDate: date, ageYearsAtExamination: age, centerId: report?.centerId || null, centerName: center.trim(), measurements, source: report?.source || 'manual', status: 'final', canEdit: report?.canEdit ?? true, canDelete: report?.canDelete ?? true };
    if (update({ type: 'report.save', report: next })) { close(); toast('视光报告已保存'); }
  })}>完成</Primary>{centerEditing && <View className="modal-backdrop vision-center-backdrop"><View className="vision-center-sheet"><Text className="vision-center-title">视光中心名称</Text><Input value={centerDraft} maxlength={14} onInput={event => setCenterDraft(event.detail.value)} /><Text className="vision-center-hint">限14个字以内</Text><Primary disabled={!centerDraft.trim()} onClick={() => { setCenter(centerDraft.trim()); setCenterEditing(false); }}>完成</Primary><Button className="vision-center-cancel" onClick={() => setCenterEditing(false)}>取消</Button></View></View>}</>;
}
function FeedbackPanel({ update, close }: { update: (action: Action) => boolean; close: () => void }) {
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const { submitting, run } = useSubmitGuard();
  return <><View className="feedback-label"><Text>问题和意见(必填)</Text><Text className="muted">{text.length}/100</Text></View><Textarea className="feedback-text" value={text} maxlength={100} placeholder="请填写你的功能建议，感谢你的支持～" onInput={e => setText(e.detail.value)} /><Text className="feedback-label">图片（选填，提供问题截图）</Text><View className="feedback-images">{images.map((url, i) => <Button className="image-preview" key={url} onClick={() => Taro.previewImage({ current: url, urls: images })} onLongPress={() => setImages(current => current.filter((_, index) => index !== i))}><Image src={url} mode="aspectFill" /></Button>)}{images.length < 3 && <Button className="upload-button" onClick={async () => { try { const result = await Taro.chooseImage({ count: 3 - images.length, sourceType: ['album'] }); setImages(current => [...current, ...result.tempFilePaths].slice(0, 3)); } catch { /* 取消保留当前选图。 */ } }}>＋</Button>}</View><Text className="feedback-label">联系方式</Text><View className="feedback-contact"><Field label="" value={contact} onChange={setContact} placeholder="留下联系方式，更可能解决问题～" /></View><Primary disabled={!text.trim() || submitting} onClick={() => run(() => { if (update({ type: 'feedback.save', item: { id: newId('feedback'), text: text.trim(), contact, date: dateToday(), imageCount: images.length } })) setSubmitted(true); })}>提交</Primary>{submitted && <View className="modal-backdrop"><View className="feedback-success" onClick={close}><View className="success-check" /><Text>文字已存本机演示，图片未上传</Text></View></View>}</>;
}
function SuggestionPanel({ item }: { item: Suggestion }) {
  const statusIcon = item.status === '已采纳' ? art.detailAdopted : item.status === '评估中' ? art.detailEvaluating : item.status === '已进金点子库' ? art.detailGolden : art.detailReceived;
  return <><View className="suggestion-original"><Text>{item.title}</Text></View><View className="suggestion-timeline"><View className="timeline-point"><Image src={art.detailProposed} mode="aspectFit" /><Text>{item.date}</Text><Text>提出</Text></View><View className="timeline-point"><Image src={statusIcon} mode="aspectFit" /><Text>{item.updated}</Text><Text>{item.status === '已采纳' ? '被采纳' : item.status}</Text></View>{item.version && <Text className="small-note">已在{item.version}上线</Text>}</View></>;
}
function VisionTrendChart({ reports, metric, title }: { reports: VisionReport[]; metric: 'axialLength' | 'uncorrectedVisualAcuity'; title: string }) {
  const canvasId = `vision-${metric}`;
  const data = reports
    .filter(report => ['left', 'right'].some(side => typeof report.measurements[metric][side as 'left' | 'right'] === 'number'))
    .sort((a, b) => a.examinationDate.localeCompare(b.examinationDate))
    .slice(-10);
  useEffect(() => {
    if (!data.length) return;
    const timer = setTimeout(() => {
      const ctx = Taro.createCanvasContext(canvasId);
      const width = 320, height = 180, left = 38, right = 8, top = 16, bottom = 32;
      const plotWidth = width - left - right, plotHeight = height - top - bottom;
      const values = data.flatMap(report => (['left', 'right'] as const).map(side => report.measurements[metric][side])).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (!values.length) return;
      const padding = metric === 'axialLength' ? 0.2 : 0.1;
      let min = Math.min(...values) - padding, max = Math.max(...values) + padding;
      if (max - min < padding * 2) { min -= padding; max += padding; }
      min = Math.max(0, Math.floor(min * 10) / 10); max = Math.ceil(max * 10) / 10;
      const x = (index: number) => left + (data.length === 1 ? plotWidth / 2 : index * plotWidth / (data.length - 1));
      const y = (value: number) => top + (max - value) / (max - min) * plotHeight;
      ctx.setStrokeStyle('#F0F1F3'); ctx.setLineWidth(1);
      ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(left, top + plotHeight); ctx.lineTo(left + plotWidth, top + plotHeight); ctx.stroke();
      ctx.setFillStyle('#9198A1'); ctx.setFontSize(9);
      for (let i = 0; i < 8; i += 1) {
        const value = max - (max - min) * i / 7;
        ctx.setTextAlign('right'); ctx.fillText(value.toFixed(1), left - 7, top + plotHeight * i / 7 + 3);
      }
      const labelStep = Math.max(1, Math.ceil((data.length - 1) / 4));
      data.forEach((report, index) => {
        if (index % labelStep !== 0 && index !== data.length - 1) return;
        const [, month, day] = report.examinationDate.split('-');
        ctx.setTextAlign('center'); ctx.fillText(`${Number(month)}.${Number(day)}`, x(index), height - 10);
      });
      const legend = [{ label: '左眼', color: '#FF9F80' }, { label: '右眼', color: '#9FB9CE' }];
      legend.forEach((item, index) => {
        const lx = width - 116 + index * 58;
        ctx.setFillStyle(item.color); ctx.beginPath(); ctx.arc(lx, 8, 3, 0, Math.PI * 2); ctx.fill();
        ctx.setTextAlign('left'); ctx.fillText(item.label, lx + 7, 11);
      });
      (['left', 'right'] as const).forEach((side, eyeIndex) => {
        const color = legend[eyeIndex].color;
        const points = data.map((report, index) => ({ x: x(index), value: report.measurements[metric][side] })).filter(point => typeof point.value === 'number').map((point, index2) => ({ x: point.x, y: y(point.value as number), key: index2 }));
        if (!points.length) return;
        ctx.setStrokeStyle(color); ctx.setLineWidth(2); ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length - 1; i += 1) {
          const current = points[i], next = points[i + 1];
          const midX = (current.x + next.x) / 2, midY = (current.y + next.y) / 2;
          ctx.quadraticCurveTo(current.x, current.y, midX, midY);
        }
        if (points.length > 1) ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.stroke();
        ctx.setFillStyle(color);
        points.forEach(point => { ctx.beginPath(); ctx.arc(point.x, point.y, 3, 0, Math.PI * 2); ctx.fill(); });
      });
      ctx.draw();
    }, 60);
    return () => clearTimeout(timer);
  }, [reports, metric, data.length]);
  return <Card><Heading title={title} />{data.length ? <Canvas canvasId={canvasId} id={canvasId} className="vision-trend-canvas" style={{ width: '320px', height: '180px' }} /> : <Empty title="暂无视光数据" text="录入报告后显示双眼趋势" />}</Card>;
}
function HistoryPanel({ reports }: { reports: VisionReport[] }) {
  const [period, setPeriod] = useState('周');
  const [offset, setOffset] = useState(0);
  const month = period === '月';
  const selectedMonth = monthDate(offset);
  const daysInMonth = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = selectedMonth.getFullYear() === today.getFullYear() && selectedMonth.getMonth() === today.getMonth();
  const values = month ? Array.from({ length: daysInMonth }, (_, i) => (isCurrentMonth && i + 1 > today.getDate()) || i % 4 === 0 ? 0 : 30 + (i * 7) % 45) : weekMinutes;
  const labels = month ? values.map((_, i) => i === 0 || (i + 1) % 5 === 0 || i === values.length - 1 ? String(i + 1) : '') : undefined;
  const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
  return <>
    <Choice label="" values={['月', '周']} value={period} onChange={value => { setPeriod(value); setOffset(0); }} />
    <View className="period-picker"><Button onClick={() => setOffset(n => n + 1)}>‹</Button><Text>{month ? formatMonth(selectedMonth) : weekRange(offset)}</Text><Button disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 1))}>›</Button></View>
    <Card><Heading title={`${period}使用分布`} /><UsageChart dense={month} values={offset === 0 ? values : values.map(v => Math.floor(v * 0.8))} labels={labels} /></Card>
    <Card><Heading title={`${period}使用日历`} /><View className="usage-calendar">{values.map((value, i) => {
      const date = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), i + 1);
      return <View className={`calendar-day ${value ? 'used' : ''}`} key={i}><Text>{month ? String(date.getDate()).padStart(2, '0') : weekDays[i]}</Text></View>;
    })}</View></Card>
    <VisionTrendChart reports={reports} metric="axialLength" title="眼轴长度趋势" />
    <VisionTrendChart reports={reports} metric="uncorrectedVisualAcuity" title="裸眼视力趋势" />
  </>;
}
function SharePanel({ state, kind, close }: { state: DemoState; kind: 'week' | 'idea'; close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState('');
  const statusBarHeight = process.env.TARO_ENV === 'weapp' ? Taro.getWindowInfo().statusBarHeight || 20 : 20;
  const [badge] = useState(weeklyUseDays >= 5 ? '护眼小达人' : '护眼小先锋');
  const title = kind === 'week' ? badge : '小小共创家';
  const image = kind === 'week' ? badge === '护眼小达人' ? art.badgeExpert : art.badgePioneer : art.kidsRobot;
  const latestAdopted = [...suggestions].filter(item => item.status === '已采纳').sort((a, b) => b.updated.localeCompare(a.updated))[0];
  const story = `自从用上这台读写台，${state.child?.name || '儿童昵称'}这周打卡${weeklyUseDays}天，专注使用${formatDuration(weeklyFocusMinutes)}，主动挺直${weeklyPostureCount}次腰杆。`;
  const caption = kind === 'week' ? story : `${latestAdopted?.title || '孩子的建议'}，已在${latestAdopted?.version || '上线版本待确认'}上线`;
  const metrics = kind === 'week' ? [{ label: '主动坐直(次)', value: String(weeklyPostureCount) }, { label: '专注(小时)', value: (weeklyFocusMinutes / 60).toFixed(1) }, { label: '坚持(天)', value: String(weeklyUseDays) }] : [{ label: '处理状态', value: '已采纳' }, { label: '上线版本', value: latestAdopted?.version || '待确认' }];
  const run = async (share: boolean, channel?: 'qq') => {
    setBusy(true);
    try {
      const result = await exportShareCard({ kind, name: state.child?.name || '孩子', title, caption, period: weekRange(), image, qr: art.promotionQr, brand: art.shareBrand, quote: art.shareQuote, stamp: art.xiaokeStamp, metrics }, share);
      if (result) setExported(result);
      if (channel === 'qq') toast('图片已保存，请前往QQ发送');
    } catch (error) { toast(error instanceof Error ? error.message : '未能生成图片，请重试'); }
    finally { setBusy(false); }
  };
  return <>
    <View className="share-preview" style={{ paddingTop: `${statusBarHeight + 24}px` }}>
      <Image className="share-brand" src={art.shareBrand} mode="aspectFit" style={{ top: `${statusBarHeight + 12}px` }} />
      <Image src={image} mode="aspectFit" />
      {kind === 'idea' && <Text className="share-title">{title}</Text>}
      <Text className="share-period">{weekRange()}</Text>
      <View className="share-summary"><Image className="share-quote" src={art.shareQuote} mode="aspectFit" /><Text className="share-story">{caption}</Text><View className="metrics-grid share-metrics">{metrics.map(metric => <Metric key={metric.label} label={metric.label} value={metric.value} />)}</View></View>
      <View className="share-promotion"><Image src={art.promotionQr} mode="aspectFit" /><View><Text>也想要个会主动护眼，还不用催的小孩儿？</Text><Text className="small-note">扫码看看，爱视可空间光学护眼读写台，它替你保护孩子的坐姿和视力</Text></View><Image className="share-stamp" src={art.xiaokeStamp} mode="aspectFit" /></View>
    </View>
    <View className="share-action-tray"><View className="share-action-row"><Button disabled={busy} onClick={() => run(false)}><Image src={art.shareSave} mode="aspectFit" /><Text>保存图片</Text></Button><Button disabled={busy} onClick={() => run(true)}><Image src={art.shareWechat} mode="aspectFit" /><Text>微信</Text></Button><Button disabled={busy} onClick={() => run(false, 'qq')}><Text className="qq-symbol">Q</Text><Text>QQ</Text></Button></View><Button className="share-cancel" onClick={close}>取消</Button></View>
    {exported && <Card><Text className="paragraph">图片已生成。如果浏览器没有下载，请长按下方图片保存。</Text><Image src={exported} mode="widthFix" style={{ width: '100%' }} /></Card>}
    <Canvas canvasId="share-card" id="share-card" className="share-canvas" style={{ width: '320px', height: '550px' }} />
  </>;
}
function InterceptPanel({ update, close }: { update: (action: Action) => boolean; close: () => void }) {
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const { submitting, run } = useSubmitGuard();
  return <><Image className="recall-robot" src={art.helloRobot} mode="aspectFit" /><Text className="recall-title">好久不见啦</Text><Text className="recall-caption">最近用得少了，是什么原因呢？</Text><Card><View className="recall-reasons">{['没有时间', '体验不好', '其他'].map(value => <Button key={value} onClick={() => setReason(value)}><View className={`radio-circle ${reason === value ? 'checked' : ''}`} /><Text>{value}</Text></Button>)}</View>{reason === '其他' && <Textarea value={text} maxlength={100} placeholder="请填写具体原因（100字以内）" onInput={e => setText(e.detail.value)} />}</Card><Primary disabled={!reason || (reason === '其他' && !text.trim()) || submitting} onClick={() => run(() => { if (update({ type: 'intercept.save', item: { id: newId('intercept'), reason, text: text.trim(), date: dateToday() } })) { close(); toast('示例问卷已保存'); } })}>提交</Primary></>;
}
function GuidePanel({ model }: { model?: string }) {
  return <View className="guide-document"><Image src={model === 'Max' ? art.guideMax : art.guideUltra} mode="widthFix" style={{ width: '100%' }} /></View>;
}
function PrivacyPanel() {
  return <><Card><Heading title="权限与隐私" /><Text className="paragraph">蓝牙用于首次连接和配网；相册用于反馈选图及保存分享图片。</Text><Text className="paragraph muted">正式儿童与用户协议待提供。附近设备搜索可请求蓝牙和位置权限；不会读取坐标，不上传反馈，不保存 Wi-Fi 密码。</Text></Card><Card><Heading title="本机示例数据" /><Text className="paragraph muted">在“我的—预览工具”中可重置本机示例数据。</Text></Card></>;
}

function ServicePanel() {
  return <Card className="service-card"><Button className="service-phone" onClick={() => Taro.makePhoneCall({ phoneNumber: '4000869920' })}>售后服务电话：400-0869-920</Button><Image src={art.customerQr} mode="aspectFit" /><Text className="small-note">微信扫一扫，添加客服</Text><Text className="paragraph">若要进一步了解空间光学读写台信息，请访问 https://www.futurus-ai.co/或扫描下方二维码，关注官方微信公众号、小程序平台，获得更多咨询。</Text><Image src={art.officialQr} mode="aspectFit" /><Text className="small-note">微信扫一扫，使用公众号</Text><Image src={art.officialMiniCode} mode="aspectFit" /><Text className="small-note">微信扫一扫，使用小程序</Text></Card>;
}
