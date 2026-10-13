/**
 * P0 人格成长回归测试 · 跑法：npm run test:persona（tsx 直跑，无框架）
 * 覆盖（契约 §8 + codex 评审）：miss 饱和 / 档位边界 / 会话切分 29-31min / 首见特判 /
 * 乱序拒收(codex 2.3) / sampleKey 防重(2.4) / 省略跳过语义 / EMA 数学 / 注入视图时序错位兜底 /
 * 时区查表 / parseTurnSignal 容错 / parsePatch 扩字段后回归 / clear 生命周期 / 开关与 allowlist。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'persona-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');

const {
  relationStateStore, computeMiss, familiarityTier, energyOfHour, shanghaiHour,
  personaTrackEnabled, personaInjectEnabled,
} = await import('../src/relation-state-store.js');
const { parseTurnSignal, parsePatch } = await import('../src/memory-extractor.js');
const { stylePoolStore, hawkingMass, crystalScore, shouldCrystallize } = await import('../src/style-pool-store.js');
const { childInsightStore, confidenceOf } = await import('../src/child-insight-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');
const { traitStore, computeTraitDeltas, detectAssistantFeatures, clampTrait, TRAIT_BASELINE } = await import('../src/trait-store.js');

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1;
  else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}
function approx(name: string, got: number, want: number, eps = 1e-9): void {
  if (Math.abs(got - want) <= eps) pass += 1;
  else { fail += 1; console.error(`FAIL ${name} got=${got} want=${want}`); }
}

const H = 3600_000;
const MIN = 60_000;

// ---------- 纯函数 ----------
eq('miss-1 零间隔', computeMiss(0), 0);
approx('miss-2 36h 半程', computeMiss(36 * H), 0.5);
eq('miss-3 72h 饱和', computeMiss(72 * H), 1);
eq('miss-4 超饱和封顶', computeMiss(300 * H), 1);
eq('miss-5 负值防御', computeMiss(-5), 0);

eq('tier-1 天数不足', familiarityTier(100, 6), '新朋友');
eq('tier-2 次数不足', familiarityTier(9, 100), '新朋友');
eq('tier-3 中间态', familiarityTier(10, 10), '渐渐熟悉');
eq('tier-4 老朋友', familiarityTier(40, 30), '老朋友');
eq('tier-5 天够次不够', familiarityTier(39, 100), '渐渐熟悉');

// 时区：UTC 22:00 = 沪 6:00 → 早晨 0.9（codex 3.5 禁依赖进程时区）
eq('tz-1 UTC22=沪6', shanghaiHour(Date.UTC(2026, 7, 25, 22, 0, 0)), 6);
eq('tz-2 早晨档', energyOfHour(6), 0.9);
eq('tz-3 白天档', energyOfHour(12), 0.7);
eq('tz-4 傍晚档', energyOfHour(19), 0.5);
eq('tz-5 夜间档', energyOfHour(23), 0.3);
eq('tz-6 凌晨档', energyOfHour(2), 0.3);

// ---------- recordTurn 生命周期 ----------
const A = 'acct-test-1';
const T0 = Date.UTC(2026, 7, 1, 4, 0, 0); // 固定基准时刻

eq('rt-1 首见', relationStateStore.recordTurn(A, { ts: T0, sampleKey: 'k1' }), 'first');
let s = relationStateStore.getState(A)!;
eq('rt-2 首见计数', s.session_count, 1);
eq('rt-3 首见冻结值', s.miss_at_session_start, 0);

// 29min 不切会话
eq('rt-4 29min applied', relationStateStore.recordTurn(A, { ts: T0 + 29 * MIN, sampleKey: 'k2' }), 'applied');
s = relationStateStore.getState(A)!;
eq('rt-5 29min 不切', s.session_count, 1);

// 31min 切会话（相对 last_seen=T0+29min）
const T1 = T0 + 29 * MIN + 31 * MIN;
relationStateStore.recordTurn(A, { ts: T1, sampleKey: 'k3' });
s = relationStateStore.getState(A)!;
eq('rt-6 31min 切会话', s.session_count, 2);
eq('rt-7 prev_session_end', s.prev_session_end_at, T0 + 29 * MIN);
approx('rt-8 冻结值=gap/72h', s.miss_at_session_start, (31 * MIN) / (72 * H));

// 乱序拒收（codex 2.3）：后到的旧发起时刻不得覆盖
eq('rt-9 乱序 stale', relationStateStore.recordTurn(A, { ts: T1 - 5000, sampleKey: 'kold', valence: -1 }), 'stale');
s = relationStateStore.getState(A)!;
eq('rt-10 乱序不改状态', [s.session_count, s.valence_sample_count, s.last_sample_key], [2, 0, 'k3']);

// EMA：省略跳过（契约 §4.2 省略≠0）
relationStateStore.recordTurn(A, { ts: T1 + MIN, sampleKey: 'k4' });
s = relationStateStore.getState(A)!;
eq('rt-11 省略不进 EMA', [s.valence_ema, s.valence_sample_count], [0, 0]);

// EMA 数学：0 起步 ×0.3 一步
relationStateStore.recordTurn(A, { ts: T1 + 2 * MIN, sampleKey: 'k5', valence: 0.8, engagement: 0.9 });
s = relationStateStore.getState(A)!;
approx('rt-12 valence EMA', s.valence_ema, 0.3 * 0.8);
approx('rt-13 engagement EMA', s.engagement_ema, 0.3 * 0.9 + 0.7 * 0.5);
eq('rt-14 样本计数', [s.valence_sample_count, s.engagement_sample_count], [1, 1]);

// sampleKey 防重（codex 2.4）：close 补抽评同一条输入，EMA 不重复计入，last_seen 仍推进
const emaBefore = s.valence_ema;
relationStateStore.recordTurn(A, { ts: T1 + 3 * MIN, sampleKey: 'k5', valence: 0.8 });
s = relationStateStore.getState(A)!;
eq('rt-15 同 key 不重复计入', [s.valence_ema, s.valence_sample_count], [emaBefore, 1]);
eq('rt-16 同 key 仍推进 last_seen', s.last_seen_at, T1 + 3 * MIN);

// 值域 clip
relationStateStore.recordTurn(A, { ts: T1 + 4 * MIN, sampleKey: 'k6', valence: 5 });
s = relationStateStore.getState(A)!;
approx('rt-17 valence clip 到 1', s.valence_ema, 0.3 * 1 + 0.7 * emaBefore);

// ---------- 注入视图 ----------
// 时序错位兜底：写路径未切会话（last_seen 2h 前），注入现算 miss 而非读旧冻结值
const NOW = T1 + 4 * MIN + 2 * H;
let view = relationStateStore.getInjectionView(A, NOW)!;
approx('view-1 gap>30min 现算 miss', view.miss, computeMiss(2 * H));
eq('view-2 样本<3 无气氛', view.mood, null);
eq('view-3 档位', view.tier, '新朋友');

// 会话中读冻结值
view = relationStateStore.getInjectionView(A, T1 + 5 * MIN)!;
approx('view-4 会话中读冻结值', view.miss, (31 * MIN) / (72 * H));

// 样本≥3 后气氛出现
relationStateStore.recordTurn(A, { ts: NOW, sampleKey: 'k7', valence: 0.5 });
relationStateStore.recordTurn(A, { ts: NOW + MIN, sampleKey: 'k8', valence: 0.5 });
view = relationStateStore.getInjectionView(A, NOW + 2 * MIN)!;
eq('view-5 样本≥3 有气氛', view.mood !== null, true);

// 未知账号
eq('view-6 未知账号 null', relationStateStore.getInjectionView('nobody', NOW), null);

// ---------- clear 生命周期（codex 3.2） ----------
eq('clr-1 清除', relationStateStore.clear(A), true);
eq('clr-2 清后为空', relationStateStore.getState(A), null);
eq('clr-3 幂等', relationStateStore.clear(A), false);

// ---------- 回填只补不覆盖 ----------
const bf = {
  account_id: 'acct-bf', first_seen_at: T0, last_seen_at: T1, prev_session_end_at: null,
  current_session_started_at: T1, miss_at_session_start: 0, session_count: 7,
  valence_ema: 0, engagement_ema: 0.5, valence_sample_count: 0, engagement_sample_count: 0,
  last_sample_key: '', last_processed_ts: T1,
};
eq('bf-1 空表可回填', relationStateStore.upsertBackfill(bf), true);
eq('bf-2 有行拒绝覆盖', relationStateStore.upsertBackfill({ ...bf, session_count: 99 }), false);
eq('bf-3 原值保留', relationStateStore.getState('acct-bf')!.session_count, 7);

// ---------- parseTurnSignal 容错 ----------
eq('pts-1 合法', parseTurnSignal('{"turn_valence":0.8,"turn_engagement":0.9}'), { valence: 0.8, engagement: 0.9 });
eq('pts-2 越界 clip', parseTurnSignal('{"turn_valence":-3}'), { valence: -1 });
eq('pts-3 非数字丢弃', parseTurnSignal('{"turn_valence":"开心"}'), null);
eq('pts-4 字段缺失', parseTurnSignal('{"nickname":"朵朵"}'), null);
eq('pts-5 带说明文字', parseTurnSignal('好的，输出如下：{"turn_valence":0.5}'), { valence: 0.5 });
eq('pts-6 空对象', parseTurnSignal('{}'), null);
eq('pts-7 非 JSON', parseTurnSignal('无更新'), null);

// ---------- parsePatch 扩字段后回归：老字段不受影响 ----------
const fakeMember = {
  id: 'x', account_id: 'x', nickname: '', birthday: '', gender: '', interests: [],
  preferred_address: '', personality_notes: '', recent_emotion: '', game_progress: [],
  created_at: 0, updated_at: 0,
} as never;
eq('pp-1 混合输入老字段正常', parsePatch('{"recent_emotion":"考试开心","turn_valence":0.8}', fakeMember)?.recent_emotion, '考试开心');
eq('pp-2 纯评分无画像 patch', parsePatch('{"turn_valence":0.8}', fakeMember), null);
eq('pp-3 空对象', parsePatch('{}', fakeMember), null);

// ---------- 开关与 allowlist ----------
delete process.env.PERSONA_STATE_TRACK;
delete process.env.PERSONA_STATE_INJECT;
eq('sw-1 默认双关', [personaTrackEnabled('a'), personaInjectEnabled('a')], [false, false]);
process.env.PERSONA_STATE_TRACK = '1';
process.env.PERSONA_STATE_INJECT = '1';
eq('sw-2 开且无名单=放开', [personaTrackEnabled('a'), personaInjectEnabled('a')], [true, true]);
process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST = 'acct-canary, acct-2';
eq('sw-3 名单内', personaTrackEnabled('acct-canary'), true);
eq('sw-4 名单外', personaInjectEnabled('a'), false);
delete process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST;


// ---------- M4 风格晶化 ----------
approx('st-1 hawking 满血', hawkingMass(3, Date.now(), Date.now()), 3, 1e-6);
approx('st-2 hawking 30天半衰', hawkingMass(3, Date.now() - 693 * 3600_000, Date.now()), 2.0, 0.05);
eq('st-3 基底不蒸发', hawkingMass(1, 0, Date.now()) >= 1, true);
eq('st-4 无信号不判定', crystalScore(undefined, undefined, 5), 0);
approx('st-5 复合分', crystalScore(0.8, 0.9, 4), 0.5 * 0.8 + 0.3 * 0.9 + 0.2);
eq('st-6 门通过', shouldCrystallize(0.8, 0.9, 4), true);
eq('st-7 负 valence 不过门', shouldCrystallize(-0.8, 0.9, 4), false);

const SA = 'acct-style';
eq('st-8 新建', stylePoolStore.crystallize(SA, [0.5, 0.8, 0.9, 0.5], '讲个恐龙故事', '讲了霸王龙的故事'), 'new');
eq('st-9 近邻合并', stylePoolStore.crystallize(SA, [0.52, 0.79, 0.88, 0.5], '再讲一个', '讲了三角龙'), 'merged');
eq('st-10 池数=1', stylePoolStore.count(SA), 1);
eq('st-11 远情境新建', stylePoolStore.crystallize(SA, [0.1, 0.2, 0.2, 0.1], '早安', '早上好呀'), 'new');
const hits = stylePoolStore.retrieve(SA, [0.5, 0.8, 0.9, 0.5], 1);
eq('st-12 检索命中近邻', hits[0].child_said.includes('恐龙') || hits[0].xiaoke_did.includes('霸王龙'), true);
eq('st-13 clear', stylePoolStore.clear(SA) >= 2, true);

// ---------- M3 行为画像 ----------
eq('in-1 置信分级', [confidenceOf(19), confidenceOf(20), confidenceOf(50)], ['low', 'directional', 'stable']);
childInsightStore.set('acct-ins', { curiosity_mode: { observation: '爱问为什么', evidence: '为什么天是蓝的', strength: 'high' } }, 34, 7);
const ins = childInsightStore.get('acct-ins')!;
eq('in-2 存取', [ins.confidence, ins.dims.curiosity_mode.observation], ['directional', '爱问为什么']);
eq('in-3 clear', childInsightStore.clear('acct-ins'), true);

// ---------- M5 concern ----------
const CA = 'acct-concern';
const addedC = memoryItemStore.addItems(CA, [
  { type: 'concern', content: '明天有数学考试有点紧张', due_text: '明天' },
  { type: 'concern', content: '下周要换牙', due_text: '下周' },
]);
eq('cn-1 入库', addedC, 2);
const selC = memoryItemStore.selectForInjection(CA);
eq('cn-2 选择器返回', selC.concerns.length, 2);
// 「明天」可解析精确日期；「下周」不带星期按设计落 unknown(due_at=null)——与 promise 同规则
eq('cn-3 明天已解析', selC.concerns.some((x: { due_at: number | null }) => x.due_at !== null), true);
eq('cn-4 due 近者优先', selC.concerns[0].content.includes('数学考试'), true);
eq('cn-5 幂等去重', memoryItemStore.addItems(CA, [{ type: 'concern', content: '明天有数学考试有点紧张', due_text: '明天' }]), 0);

// ---------- M6 narrative ----------
relationStateStore.recordTurn('acct-nar', { ts: Date.now(), sampleKey: 'n1' });
eq('na-1 set', relationStateStore.setNarrative('acct-nar', '我和朵朵认识两天了，她爱听故事。'), true);
eq('na-2 get', relationStateStore.getNarrative('acct-nar')!.text.includes('朵朵'), true);
eq('na-3 未知账号', relationStateStore.getNarrative('nobody'), null);
eq('na-4 listAccounts 含', relationStateStore.listAccounts().includes('acct-nar'), true);


// ---------- 成长账本（因果链 V1.1 Phase A） ----------
const LA = 'acct-ledger';
growthLedgerStore.record(LA, { module: 'trait', dimension: '故事倾向', from: 0.5, to: 0.52, triggerQuote: '再讲一个白鲸的', rule: 'reinforce_story_pos', theory: 'reinforcement', note: '讲故事有效' });
const led = growthLedgerStore.list(LA);
eq('gl-1 记账读取', [led.length, led[0].dimension, led[0].theory], [1, '故事倾向', 'reinforcement']);
eq('gl-2 数值格式化', [led[0].from_val, led[0].to_val], ['0.5', '0.52']);
growthLedgerStore.record(LA, { module: 'relation', dimension: 'valence_ema', rule: 'ema_valence_a0.3', theory: 'attachment', note: 'x' });
eq('gl-3 module 筛选', growthLedgerStore.list(LA, { module: 'trait' }).length, 1);
eq('gl-4 dimension 筛选', growthLedgerStore.topContributors(LA, '故事倾向').length, 1);
// 危机内容引用置空但事件保留
growthLedgerStore.record(LA, { module: 'relation', dimension: 'valence_ema', triggerQuote: '我不想活了', rule: 'r', theory: 'attachment', note: 'n' });
const crisisEv = growthLedgerStore.list(LA, { limit: 1 })[0];
eq('gl-5 危机引用置空', crisisEv.trigger_quote, '');
eq('gl-6 count', growthLedgerStore.count(LA), 3);
eq('gl-7 clear', growthLedgerStore.clear(LA), 3);

// recordTurn 联动账本：EMA 更新与会话切档产生事件
const LB = 'acct-ledger2';
relationStateStore.recordTurn(LB, { ts: T0, sampleKey: 'g1', quote: '你好呀' });
relationStateStore.recordTurn(LB, { ts: T0 + 40 * MIN, sampleKey: 'g2', valence: 0.8, quote: '太好玩了哈哈' });
const led2 = growthLedgerStore.list(LB);
eq('gl-8 切档+EMA 都记账', [led2.some((e: {dimension: string}) => e.dimension === 'session'), led2.some((e: {dimension: string}) => e.dimension === 'valence_ema')], [true, true]);
const emaEv = led2.find((e: {dimension: string}) => e.dimension === 'valence_ema')!;
eq('gl-9 EMA 事件带引用', (emaEv as {trigger_quote: string}).trigger_quote, '太好玩了哈哈');

// ---------- 特质向量（Phase B） ----------
eq('tr-1 基线读取(无行)', traitStore.get('nobody').storytelling, TRAIT_BASELINE.storytelling);
eq('tr-2 clamp 上界', clampTrait('storytelling', 0.99), TRAIT_BASELINE.storytelling + 0.35);
eq('tr-3 温柔度地板', clampTrait('gentleness', 0.1), 0.5);

// 规则引擎
// L1（2026-09-03）：逐轮长短镜像已下线——生产 17 天 194 次 −0.01 把话语量压到地板（ASR 切句假象）
eq('tr-4 逐轮长句不再动话语量', computeTraitDeltas({ childText: '今天我们在学校玩了一个特别好玩的游戏然后老师还表扬我了' }).some(d => d.dim === 'talkativeness'), false);
eq('tr-5 逐轮短句不再动话语量', computeTraitDeltas({ childText: '嗯好的' }).some(d => d.dim === 'talkativeness'), false);
eq('tr-6 玩闹镜像', computeTraitDeltas({ childText: '哈哈太好玩了' }).some(d => d.dim === 'playfulness'), true);
eq('tr-7 故事正强化', computeTraitDeltas({ childText: '再讲一个', engagement: 0.9, prevTurn: { assistantHadStory: true } }).some(d => d.dim === 'storytelling' && d.delta > 0), true);
eq('tr-8 故事负强化', computeTraitDeltas({ childText: '哦', engagement: 0.2, prevTurn: { assistantHadStory: true } }).some(d => d.dim === 'storytelling' && d.delta < 0), true);
eq('tr-9 悬念强化', computeTraitDeltas({ childText: '为什么呀', prevTurn: { assistantHadHook: true } }).some(d => d.dim === 'curiosity_feed'), true);
eq('tr-10 安抚归因', computeTraitDeltas({ childText: '好啦我开心了', valence: 0.5, prevTurn: { valence: -0.5 } }).some(d => d.dim === 'gentleness'), true);
eq('tr-11 无信号零调整', computeTraitDeltas({ childText: '今天在学校上了数学课' }).length, 0); // 8-25 字中性句：不触发长短镜像也无玩闹词
// ---------- L1 会话级话语量镜像 ----------
{
  const { computeLsmSessionDelta, isLsmQualifyingUtterance, medianOf, LSM_SESSION_DELTA } = await import('../src/trait-store.js');
  eq('lsm-1 冷启动(会话数<2)不评', computeLsmSessionDelta(12, 5, 1), null);
  eq('lsm-2 长期中位数无效不评', computeLsmSessionDelta(12, 0, 5), null);
  eq('lsm-3 比平时啰嗦 ↑0.02', computeLsmSessionDelta(9, 5, 3)?.delta, LSM_SESSION_DELTA);
  eq('lsm-4 比平时简短 ↓0.02', computeLsmSessionDelta(3, 5, 3)?.delta, -LSM_SESSION_DELTA);
  eq('lsm-5 平时水平不动(儿童 5 字中位数不再被当短句)', computeLsmSessionDelta(5, 5, 3), null);
  eq('lsm-6 应答词不算', ['嗯', '好的', '嗯嗯', '不要', '知道了', '哈哈哈'].map(isLsmQualifyingUtterance), [false, false, false, false, false, false]);
  eq('lsm-7 三字起算', [isLsmQualifyingUtterance('叫我'), isLsmQualifyingUtterance('叫我小川')], [false, true]);
  eq('lsm-8 中位数', [medianOf([5, 1, 9]), medianOf([1, 2, 3, 4]), medianOf([])], [5, 2.5, 0]);
  // 整链：会话缓冲 + 折算 + 每场最多一次
  const ACC = 'lsm-acct';
  traitStore.resetLsmSessions();
  const T0 = 1_800_000_000_000;
  const feed = (texts: string[], t0: number) => { let last: unknown = null; texts.forEach((t, i) => { const r = traitStore.lsmTurn(ACC, t, t0 + i * 1000); if (r) last = r; }); return last; };
  const short = Array.from({ length: 12 }, () => '我想玩游戏');           // 5 字 ×12
  const long = Array.from({ length: 12 }, () => '今天我们班里发生了一件特别有意思的事情'); // 19 字 ×12
  eq('lsm-9 第 1 场冷启动无 δ', feed(short, T0), null);
  eq('lsm-10 第 2 场(跨 30min)先折上一场入长期中位数', (feed(short, T0 + 3600_000), traitStore.getLsmStats(ACC)), { lenEma: 5, sessions: 1 });
  eq('lsm-11 第 3 场：会话数已到 2，长句 → ↑', (feed(long, T0 + 2 * 3600_000) as { rule?: string } | null)?.rule, 'mirror_lsm_session_long');
  eq('lsm-12 同一场第 13 轮不再评(每场一次)', traitStore.lsmTurn(ACC, '今天我们班里发生了一件特别有意思的事情', T0 + 2 * 3600_000 + 20_000), null);
  eq('lsm-13 第 4 场：与平时相当 → 不动', feed(short, T0 + 3 * 3600_000), null);
  eq('lsm-14 长期中位数按 EMA 更新', Math.round(traitStore.getLsmStats(ACC).lenEma * 100) / 100, Math.round((5 * 0.9 + 19 * 0.1) * 100) / 100);
  traitStore.resetLsmSessions();
}

// ---------- R3 每日快照 / 退回 / 每日有机位移上限 ----------
{
  const { DAILY_ORGANIC_CAP } = await import('../src/trait-store.js');
  const AC = 'r3-acct';
  traitStore.clear(AC);
  const D1 = new Date('2026-09-01T10:00:00+08:00').getTime();
  traitStore.applyDeltas(AC, [{ dim: 'playfulness', delta: 0.02, rule: 'mirror_playful', theory: 'social_mirror', note: 'x' }]);
  eq('r3-1 快照写入', traitStore.snapshotDaily(AC, D1), '2026-09-01');
  const s1 = traitStore.listSnapshots(AC);
  eq('r3-2 快照内容=当时五维', [s1.length, Math.round(s1[0]!.dims.playfulness * 100) / 100], [1, Math.round((TRAIT_BASELINE.playfulness + 0.02) * 100) / 100]);
  traitStore.applyDeltas(AC, [{ dim: 'playfulness', delta: 0.02, rule: 'mirror_playful', theory: 'social_mirror', note: 'x' }]);
  eq('r3-3 同日快照覆盖', (traitStore.snapshotDaily(AC, D1 + 3600_000), traitStore.listSnapshots(AC).length), 1);
  eq('r3-4 退回不存在的天=-1', traitStore.rollbackTo(AC, '2025-01-01'), -1);
  // 再动一下，然后退回 09-01
  traitStore.applyDeltas(AC, [{ dim: 'storytelling', delta: 0.02, rule: 'reinforce_story_pos', theory: 'reinforcement', note: 'x' }]);
  const before = traitStore.get(AC).storytelling;
  const moved = traitStore.rollbackTo(AC, '2026-09-01', new Date('2026-09-02T10:00:00+08:00').getTime());
  eq('r3-5 退回后 storytelling 回到快照值', [moved >= 1, Math.round(traitStore.get(AC).storytelling * 100) / 100 !== Math.round(before * 100) / 100], [true, true]);
  eq('r3-6 退回前把当前存成当天快照', traitStore.listSnapshots(AC).map((s) => s.day).sort(), ['2026-09-01', '2026-09-02']);
  eq('r3-7 退回记账 rule=rollback', growthLedgerStore.list(AC, { module: 'trait' }).some((e) => e.rule === 'rollback'), true);
  // 每日有机位移上限：连续 +0.02 的镜像，超过 0.06 后被跳过；档位切换不受限
  const AC2 = 'r3-cap-acct'; // 新账号：账本干净（上限按当天账本求和）
  let applied = 0;
  for (let i = 0; i < 6; i += 1) applied += traitStore.applyDeltas(AC2, [{ dim: 'playfulness', delta: 0.02, rule: 'mirror_playful', theory: 'social_mirror', note: 'x' }]);
  eq('r3-8 一天内有机位移封顶 0.06(3 次 0.02)', [applied, Math.round((traitStore.get(AC2).playfulness - TRAIT_BASELINE.playfulness) * 100) / 100], [3, DAILY_ORGANIC_CAP]);
  eq('r3-9 上限后非有机规则仍可动', traitStore.applyDeltas(AC2, [{ dim: 'playfulness', delta: 0.02, rule: 'cc_data_fix', theory: 'setpoint', note: 'x' }]), 1);
}


// 特征检测
eq('tr-12 故事特征', detectAssistantFeatures('从前有一座山').story, true);
eq('tr-13 悬念特征', detectAssistantFeatures('你猜猜看是什么？').hook, true);
eq('tr-14 普通回应', [detectAssistantFeatures('好的呀').story, detectAssistantFeatures('好的呀').hook], [false, false]);

// applyDeltas + 账本联动
const TA = 'acct-trait';
const n1 = traitStore.applyDeltas(TA, [{ dim: 'storytelling', delta: 0.02, rule: 'reinforce_story_pos', theory: 'reinforcement', note: 'x' }], '再讲一个');
approx('tr-15 应用后值', traitStore.get(TA).storytelling, TRAIT_BASELINE.storytelling + 0.02);
eq('tr-16 生效条数+账本', [n1, growthLedgerStore.list(TA, { module: 'trait' }).length], [1, 1]);
// δ 超限 clamp
traitStore.applyDeltas(TA, [{ dim: 'playfulness', delta: 0.5, rule: 'r', theory: 'reinforcement', note: 'x' }]);
approx('tr-17 单次δ clamp 0.02', traitStore.get(TA).playfulness, TRAIT_BASELINE.playfulness + 0.02);
// dailyDecay 回拉+记账
const decayN = traitStore.dailyDecay(TA);
eq('tr-18 回拉生效', decayN >= 1, true);
approx('tr-19 回拉后值', traitStore.get(TA).storytelling, TRAIT_BASELINE.storytelling + 0.01);
eq('tr-20 同日幂等', traitStore.dailyDecay(TA), 0);
eq('tr-21 回拉记账 theory', growthLedgerStore.list(TA, { module: 'trait' }).some((e: {theory: string}) => e.theory === 'setpoint'), true);
eq('tr-22 clear', traitStore.clear(TA), true);
growthLedgerStore.clear(TA); growthLedgerStore.clear(LB);

console.log(`\npersona-state: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
