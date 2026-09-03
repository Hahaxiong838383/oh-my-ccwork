/**
 * 本地人格音频回归测试 · 跑法：npm run test:local-audio（tsx 直跑，无框架，风格同 persona-state.test）
 * 覆盖（合同 v1.1 + codex 回执四修订）：mp3 帧时长解析 / 清洗与计字 / 文案门（含负锚禁词）/
 * 触发判断全分支 / store 生命周期（复用·commitSet bump 与 no-change·归属校验·applied 触达·cleanup·clear）/
 * manifest 结构（schema_version=1、六 slot 对齐）。
 * TTS/LLM 走网络不进单测（生成链 E2E 在 D1 验收 A1/A2 用真机验）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'local-audio-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.LOCAL_AUDIO_DIR = join(tmp, 'local-audio');

const { mp3DurationMs, pcmToWav, parseWavHeader } = await import('../src/providers/xfyun-tts.js');
const { sanitizeClipText, countChars, gateClipText, shouldRegenerate, traitPromptLines, describeTrigger, estimateRevisionBytes, REVISION_CAP_BYTES, DEFAULT_ROUTINE_REFRESH_DAYS, PUBLISH_ITEMS_PER_SLOT, buildSlot } =
  await import('../src/local-audio-generator.js');
const { localAudioStore, LOCAL_AUDIO_SLOTS, MIN_ITEMS_PER_SLOT } = await import('../src/local-audio-store.js');
const { TRAIT_BASELINE } = await import('../src/trait-store.js');

let pass = 0,
  fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}
function ok(name: string, cond: boolean): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}`);
  }
}

// ── mp3 帧时长（MPEG2 Layer3 24kHz 32kbps：帧长 96B，每帧 576/24000=24ms）──
const FRAME = Buffer.concat([Buffer.from([0xff, 0xf3, 0x44, 0xc0]), Buffer.alloc(92)]);
eq('mp3-1 单帧 24ms', mp3DurationMs(FRAME), 24);
eq('mp3-2 三帧 72ms', mp3DurationMs(Buffer.concat([FRAME, FRAME, FRAME])), 72);
eq('mp3-3 空 buffer', mp3DurationMs(Buffer.alloc(0)), 0);
const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10, 0xaa)]);
eq('mp3-4 跳过 ID3v2 头', mp3DurationMs(Buffer.concat([id3, FRAME, FRAME])), 48);
eq('mp3-5 垃圾字节重同步', mp3DurationMs(Buffer.concat([Buffer.from([1, 2, 3]), FRAME])), 24);
// 负锚：纯垃圾不误报时长（期望零的检查配这条期望非零的 mp3-1 做锚）
eq('mp3-6 纯垃圾为 0', mp3DurationMs(Buffer.alloc(64, 0x55)), 0);

// ── 清洗与计字 ──
eq('cn-1 去括号舞台指示', sanitizeClipText('来啦（开心地）今天聊啥'), '来啦今天聊啥');
eq('cn-2 去首尾引号', sanitizeClipText('「你来啦」'), '你来啦');
eq('cn-3 去 emoji', sanitizeClipText('嗨呀😀我们开始吧'), '嗨呀我们开始吧');
eq('cn-4 计字含中文数字字母', countChars('来啦，聊 5 分钟 ok？'), 8);
eq('cn-5 纯标点计 0', countChars('！？。'), 0);

// ── 文案门（slot=greeting.normal ≤12 字；选句已对照全部规则分支确认真中性）──
const g1 = gateClipText('来啦今天想聊点啥', 'greeting.normal');
eq('gate-1 正例通过', g1, { ok: true, text: '来啦今天想聊点啥' });
eq(
  'gate-2 超字数拒',
  gateClipText('今天我们一起来聊聊有趣的新发现吧', 'greeting.normal'),
  { ok: false, reason: 'too_long:16' },
);
eq('gate-3 禁词「好想你」拒', gateClipText('我好想你呀', 'greeting.normal').ok, false);
eq('gate-4 禁词「等你好久」拒', gateClipText('等你好久啦', 'greeting.normal').ok, false);
eq('gate-5 禁词「你终于来了」拒', gateClipText('你终于来了呀', 'greeting.normal').ok, false);
// 宁严语义：正向句里含「孤单」也拒（门认词不认语义，产品定夺过的取舍）
eq('gate-6 「孤单」正向句也拒', gateClipText('一个人也不孤单哦', 'greeting.normal').ok, false);
eq('gate-7 太短拒', gateClipText('嗯', 'greeting.normal'), { ok: false, reason: 'too_short' });
// cover_open ≤9：同一句（11 字，已逐字数过）在 normal(≤12) 过、cover_open(≤9) 拒——字数门跟 slot 走
eq('gate-8 slot 字数差异·normal 过', gateClipText('欢迎回到小书桌前坐好啦', 'greeting.normal').ok, true);
eq('gate-9 slot 字数差异·cover_open 拒', gateClipText('欢迎回到小书桌前坐好啦', 'greeting.cover_open').ok, false);
// 危机门在链上（isCrisisContent 词表独立维护，这里锚「门顺序不吞禁词」即可——见 gate-3）

// ── 触发判断全分支 ──
const T0 = { ...TRAIT_BASELINE };
const fresh = { last_generated_at: 0, gen_tier: '', gen_traits: '' };
eq('trig-1 首次', shouldRegenerate(fresh, '新朋友', T0)?.kind, 'first_time');
const NOW = 1_700_000_000_000;
const base = { last_generated_at: NOW - 86_400_000, gen_tier: '新朋友', gen_traits: JSON.stringify(T0) };
eq('trig-2 无触发', shouldRegenerate(base, '新朋友', T0, NOW), null);
eq('trig-3 档位切换', shouldRegenerate(base, '渐渐熟悉', T0, NOW)?.kind, 'tier_change');
eq(
  'trig-4 特质偏移 ≥0.05',
  shouldRegenerate(base, '新朋友', { ...T0, playfulness: T0.playfulness + 0.06 }, NOW)?.kind,
  'trait_shift',
);
eq(
  'trig-5 偏移 0.04 不触发',
  shouldRegenerate(base, '新朋友', { ...T0, playfulness: T0.playfulness + 0.04 }, NOW),
  null,
);
// 保底换新（2026-09-03 川哥定：默认 3 天，admin 设备配置可调；超期就主动更新哪怕变化很少）
eq('trig-6 默认保底天数=3', DEFAULT_ROUTINE_REFRESH_DAYS, 3);
eq(
  'trig-6a 8 天必触发(默认)',
  shouldRegenerate({ ...base, last_generated_at: NOW - 8 * 86_400_000 }, '新朋友', T0, NOW),
  { kind: 'routine', days: 3 },
);
eq('trig-6b 2.5 天不触发(默认 3)', shouldRegenerate({ ...base, last_generated_at: NOW - 2.5 * 86_400_000 }, '新朋友', T0, NOW), null);
eq('trig-6c 3 天整触发', shouldRegenerate({ ...base, last_generated_at: NOW - 3 * 86_400_000 }, '新朋友', T0, NOW)?.kind, 'routine');
eq('trig-6d 自定义 5 天:3.1 天不触发', shouldRegenerate({ ...base, last_generated_at: NOW - 3.1 * 86_400_000 }, '新朋友', T0, NOW, 5), null);
eq(
  'trig-6e 自定义 5 天:5.1 天触发且描述带天数',
  describeTrigger(shouldRegenerate({ ...base, last_generated_at: NOW - 5.1 * 86_400_000 }, '新朋友', T0, NOW, 5)!),
  '5 天保底换新',
);
eq('trig-6f 保底不抢优先级:档位变化先于保底', shouldRegenerate({ ...base, last_generated_at: NOW - 9 * 86_400_000 }, '渐渐熟悉', T0, NOW)?.kind, 'tier_change');
eq('trig-7 gen_traits 坏 JSON 容错', shouldRegenerate({ ...base, gen_traits: '{bad' }, '新朋友', T0, NOW), null);
ok('trig-8 描述可读', describeTrigger({ kind: 'routine', days: 3 }).includes('3 天'));

// ── 体积预检（2026-09-03：此前每天白合成 ~165 条后在发布门弃置）──
eq('est-1 空池=0', estimateRevisionBytes({}), 0);
eq('est-2 每槽最多取 MAX 条(新在前)+多槽求和', estimateRevisionBytes({ 'greeting.normal': [100, 100, 100, 100, 100, 100, 100], 'farewell.night': [50] }), 5 * 100 + 50);
ok(
  'est-3 14 槽×5×105KB 必超上限(与生产 abort 同向:5.66–6.49MiB)',
  estimateRevisionBytes(Object.fromEntries(LOCAL_AUDIO_SLOTS.map((s) => [s, Array(5).fill(105 * 1024)]))) > REVISION_CAP_BYTES,
);
ok(
  'est-4 12 槽老套(required×5+g1×3,95KB)在门内(与 rev5 现役 4.3MiB 同向)',
  estimateRevisionBytes(
    Object.fromEntries(
      LOCAL_AUDIO_SLOTS.filter((s) => !s.startsWith('posture.')).map((s) => [s, Array(s.startsWith('g1.') ? 3 : 5).fill(95 * 1024)]),
    ),
  ) <= REVISION_CAP_BYTES,
);
eq('est-5 上限单一真源=5MiB(codex 裁定提额时本锚随之改)', REVISION_CAP_BYTES, 5 * 1024 * 1024);

// ── 发布预算硬证明（codex 2026-09-03 5MiB 裁定 §3.1）——正向守卫：以后加槽/加条会让它翻红 ──
ok('pub-1 14 槽×2 条×160KiB ≤ 5MiB', LOCAL_AUDIO_SLOTS.length * PUBLISH_ITEMS_PER_SLOT * 160 * 1024 <= REVISION_CAP_BYTES);
ok('pub-2 发布预算 ≥ 每槽保底', PUBLISH_ITEMS_PER_SLOT >= MIN_ITEMS_PER_SLOT);
ok(
  'pub-3 预检按发布预算估:2 条/槽×14×105KB 在门内',
  estimateRevisionBytes(Object.fromEntries(LOCAL_AUDIO_SLOTS.map((s) => [s, Array(5).fill(105 * 1024)])), PUBLISH_ITEMS_PER_SLOT) <= REVISION_CAP_BYTES,
);
// staging 优先复用：够 target 就不碰 LLM/TTS（网络不可达的单测环境里能返回=没叫网络）
{
  const ACC = 'device-BJP00326060100009999';
  const mk = (id: string, text: string) => localAudioStore.insertItem(ACC, { slot: 'greeting.normal', id, text, sha256: id.repeat(4), bytes: 90_000, duration_ms: 1800, format: 'wav' });
  mk('aaaaaaaaaaaaaaaa', '来啦今天想聊点啥');
  mk('bbbbbbbbbbbbbbbb', '欢迎回来坐好啦');
  mk('cccccccccccccccc', '来啦今天想聊点啥'); // 同文案重复条目不应被选两次
  const r = await buildSlot(ACC, 'greeting.normal', undefined, 2, true);
  eq('pub-4 staging 优先复用取满 target 且文案去重', { n: r.keep.length, texts: r.keep.map((k) => k.text).sort(), keptOld: r.keptOld }, { n: 2, texts: ['来啦今天想聊点啥', '欢迎回来坐好啦'], keptOld: false });
}

// ── traitPromptLines 不泄孩子字段（结构性红线锚：输出只含小可自己的维度词）──
const lines = traitPromptLines(T0);
eq('trait-1 五行', lines.length, 5);
ok('trait-2 无孩子字样', lines.every((l) => !l.includes('孩子') || l.includes('基线')) && !lines.join().includes('姓名'));

// ── store 生命周期 ──
const ACC = 'device-TESTSN001';
const { createHash } = await import('node:crypto');
const mk = (slot: (typeof LOCAL_AUDIO_SLOTS)[number], seed: string) => {
  // sha 必须逐 seed 唯一（'1'.repeat 与 '11'.repeat 同串的坑：同 id 会互相覆盖）
  const sha = createHash('sha256').update(`${slot}:${seed}`).digest('hex');
  const id = sha.slice(0, 16);
  localAudioStore.writeAudio(ACC, id, Buffer.from(`audio-${seed}`));
  localAudioStore.insertItem(ACC, { slot, id, text: `文案${seed}`, sha256: sha, bytes: 10, duration_ms: 2000, format: 'mp3' });
  return { slot, id };
};
eq('st-1 初始 state revision=0', localAudioStore.getState(ACC).revision, 0);
eq('st-2 初始 active 空', localAudioStore.listActive(ACC).length, 0);

// 六 slot 各 2 条 → commit → revision 1
const keep1 = LOCAL_AUDIO_SLOTS.flatMap((slot, i) => [mk(slot, String(i * 2)), mk(slot, String(i * 2 + 1))]);
eq('st-3 commit bump 到 1', localAudioStore.commitSet(ACC, keep1, { tier: '新朋友', traits: '{}' }), 1);
eq('st-4 active=slot数x2', localAudioStore.listActive(ACC).length, LOCAL_AUDIO_SLOTS.length * 2);
eq('st-5 同集合重 commit 不 bump', localAudioStore.commitSet(ACC, keep1, { tier: '新朋友', traits: '{}' }), null);
eq('st-6 revision 仍 1', localAudioStore.getState(ACC).revision, 1);
ok('st-7 no-change 也前移生成基准', localAudioStore.getState(ACC).last_generated_at > 0);

// J4 复用：同 slot 同 text 找得回
const found = localAudioStore.findByText(ACC, 'greeting.normal', '文案0', 'mp3');
eq('st-8 findByText 命中(同 format)', found?.id, keep1[0].id);
eq('st-9 findByText 异 slot 不命中', localAudioStore.findByText(ACC, 'farewell.night', '文案0', 'mp3'), null);
// WAV 迁移负锚（W4 混套事故回归）：同文案跨 format 绝不复用；staging 补足默认只出 wav
eq('st-9b 同文案 wav 查询不命中 mp3 条目', localAudioStore.findByText(ACC, 'greeting.normal', '文案0', 'wav'), null);
eq('st-9c staging 补足(wav)不含 mp3 遗留', localAudioStore.listStagedBySlot(ACC, 'greeting.normal', 'wav').length, 0);

// 换掉一个 slot 的一条 → bump 到 2；被换条目 active=0 但仍可下载（切换窗口）
const swapped = mk('greeting.normal', 'ff');
const keep2 = [keep1[1], swapped, ...keep1.slice(2)];
eq('st-10 变更 commit bump 到 2', localAudioStore.commitSet(ACC, keep2, { tier: '新朋友', traits: '{}' }), 2);
const dropped = keep1[0];
ok('st-11 被换条目仍可按归属取到', localAudioStore.getItem(ACC, dropped.id) !== null);
ok('st-12 被换条目已不在 active', !localAudioStore.listActive(ACC).some((i) => i.id === dropped.id));

// 归属与格式校验
eq('st-13 别家账号取不到', localAudioStore.getItem('device-OTHER', dropped.id), null);
eq('st-14 非法 id 格式拒', localAudioStore.getItem(ACC, '../etc/passwd'), null);
ok('st-15 读音频字节', localAudioStore.readAudio(ACC, swapped.id)?.toString().startsWith('audio-') === true);

// applied 触达
localAudioStore.recordFetch(ACC, 2);
const st = localAudioStore.getState(ACC);
eq('st-16 applied_revision 记录', st.last_applied_revision, 2);
ok('st-17 last_fetch_at 记录', st.last_fetch_at > 0);
localAudioStore.recordFetch(ACC, null);
eq('st-18 无 applied 只更 fetch', localAudioStore.getState(ACC).last_applied_revision, 2);
// 触达流水（2026-09-03 对账用）：每次 GET 一行，带服务端 revision 与端侧 applied
localAudioStore.recordFetch(ACC, 1, 2);
{
  const log = localAudioStore.listFetchLog(ACC);
  eq('fetch-log 记录条数(≥3 含前面两次)', log.length >= 3, true);
  eq('fetch-log 最后一行 served/applied', [log[log.length - 1]!.served_revision, log[log.length - 1]!.applied], [2, 1]);
  eq('fetch-log sinceTs 过滤', localAudioStore.listFetchLog(ACC, Date.now() + 60_000).length, 0);
}

// cleanup：active=0 且 <14 天不清；手工把 created_at 拨老后清掉
eq('st-19 新鲜 inactive 不清', localAudioStore.cleanup(ACC), 0);
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.PROFILE_DB_PATH!);
  db.prepare(`UPDATE local_audio_item SET created_at = ? WHERE account_id = ? AND active = 0`).run(
    Date.now() - 15 * 86_400_000,
    ACC,
  );
  db.close();
}
eq('st-20 过期 inactive 清 1 条', localAudioStore.cleanup(ACC), 1);
eq('st-21 清后取不到', localAudioStore.getItem(ACC, dropped.id), null);

// manifest 结构（codex 回执 §4.1：schema_version=1 / delivery=audio / 六 slot 对齐）
const m = localAudioStore.buildManifest(ACC);
eq('mf-1 schema_version', m.schema_version, 1);
eq('mf-2 delivery', m.delivery, 'audio');
eq('mf-3 revision', m.revision, 2);
eq('mf-4 六 slot 齐', Object.keys(m.slots).sort(), [...LOCAL_AUDIO_SLOTS].sort());
const item0 = m.slots['greeting.normal'][0] as Record<string, unknown>;
ok('mf-5 条目字段齐', ['id', 'text', 'url', 'sha256', 'bytes', 'duration_ms', 'format', 'sample_rate', 'channels'].every((k) => k in item0));
ok('mf-6 url 形态', String(item0.url).startsWith('/v1/device/local-audio/file/'));
eq('mf-7 保底常量', MIN_ITEMS_PER_SLOT, 2);

// clear（重置联动第六样）
localAudioStore.clearAccount(ACC);
eq('cl-1 清后 revision 归 0', localAudioStore.getState(ACC).revision, 0);
eq('cl-2 清后 active 空', localAudioStore.listActive(ACC).length, 0);
eq('cl-3 清后文件读不到', localAudioStore.readAudio(ACC, swapped.id), null);

// ── WAV 增量（合同 CODEX_..._WAV_CONTRACT_DELTA §2）：RIFF 封装/回读/时长/严格拒收 ──
{
  // 1 秒静音 PCM（48000B）→ WAV 48044B，时长恰 1000ms
  const pcm1s = Buffer.alloc(48000);
  const wav = pcmToWav(pcm1s);
  eq('wav-1 总字节=44+data', wav.length, 48044);
  const info = parseWavHeader(wav);
  eq('wav-2 回读 sampleRate', info?.sampleRate, 24000);
  eq('wav-3 回读 channels', info?.channels, 1);
  eq('wav-4 回读 bits', info?.bitsPerSample, 16);
  eq('wav-5 回读 dataBytes', info?.dataBytes, 48000);
  eq('wav-6 时长精确 1000ms', info?.durationMs, 1000);
  // 2.4s → 2400ms（cover_open 门上限的整点对齐验证）
  eq('wav-7 2.4s 时长', parseWavHeader(pcmToWav(Buffer.alloc(115200)))?.durationMs, 2400);
  // 严格拒收（Android §2.1 口径的 server 侧镜像）
  eq('wav-8 非 RIFF 拒', parseWavHeader(Buffer.alloc(64, 0x41)), null);
  eq('wav-9 空 data 拒', parseWavHeader(pcmToWav(Buffer.alloc(0))), null);
  const nonPcm = pcmToWav(Buffer.alloc(100));
  nonPcm.writeUInt16LE(3, 20); // audio format 3 = IEEE float
  eq('wav-10 非 PCM format 拒', parseWavHeader(nonPcm), null);
  // 3s = 144044B < 160KiB(163840) 单文件门内；容量核算锚
  ok('wav-11 3s 在 160KiB 门内', pcmToWav(Buffer.alloc(144000)).length < 160 * 1024);
}

// WAV 条目 manifest 字段（codec/bits_per_sample 只在 wav 条目出现）
{
  const A2 = 'device-TESTSN002';
  const { createHash } = await import('node:crypto');
  const mkw = (slot, seed, format) => {
    const sha = createHash('sha256').update(`${slot}:${seed}:${format}`).digest('hex');
    const id = sha.slice(0, 16);
    localAudioStore.writeAudio(A2, id, Buffer.from(`a-${seed}`), format);
    localAudioStore.insertItem(A2, { slot, id, text: `w${seed}`, sha256: sha, bytes: 8, duration_ms: 1500, format });
    return { slot, id };
  };
  const keepW = LOCAL_AUDIO_SLOTS.flatMap((slot, i) => [mkw(slot, `${i}a`, 'wav'), mkw(slot, `${i}b`, 'wav')]);
  eq('wf-1 wav 套 commit', localAudioStore.commitSet(A2, keepW, { tier: 't', traits: '{}' }), 1);
  const mw = localAudioStore.buildManifest(A2);
  const it = mw.slots['greeting.normal'][0];
  eq('wf-2 format=wav', it.format, 'wav');
  eq('wf-3 codec 字段', it.codec, 'pcm_s16le');
  eq('wf-4 bits 字段', it.bits_per_sample, 16);
  ok('wf-5 wav 文件按后缀读回', localAudioStore.readAudio(A2, keepW[0].id, 'wav') !== null);
  localAudioStore.clearAccount(A2);
}
// mp3 存量条目 manifest 不带 codec（rev=1 回滚锚形态回归）
{
  const m1 = localAudioStore.buildManifest(ACC);
  ok('wf-6 清空后 slots 空(前序 clear 回归)', Object.keys(m1.slots).length === 0);
}

// ── v107 姿态 optional slot（合同 CODEX_..._POSTURE_V107 §1/§4：required/optional 分层 + 健康语义门）──
{
  const { REQUIRED_SLOTS } = await import('../src/local-audio-store.js');
  const { SLOT_SPECS } = await import('../src/local-audio-generator.js');
  eq('p-1 枚举 14 slot(6必选+2姿态+6 G1)', LOCAL_AUDIO_SLOTS.length, 14);
  eq('p-2 required 恰六个', REQUIRED_SLOTS.length, 6);
  ok('p-3 posture 不在 required', !REQUIRED_SLOTS.includes('posture.adjust') && !REQUIRED_SLOTS.includes('posture.no_face'));
  eq('p-4 adjust 规格', [SLOT_SPECS['posture.adjust'].maxDurationMs, SLOT_SPECS['posture.adjust'].maxChars], [3200, 12]);
  eq('p-5 no_face 规格', [SLOT_SPECS['posture.no_face'].maxDurationMs, SLOT_SPECS['posture.no_face'].maxChars], [3200, 12]);
  // 健康语义门正锚（人格化语气 + 动作含义都在）
  ok('p-6 adjust 正锚', gateClipText('小可陪你一起坐直呀', 'posture.adjust').ok);
  ok('p-7 no_face 正锚', gateClipText('看不清你啦，坐回来呀', 'posture.no_face').ok);
  // 负锚：动作含义不许被人格化掉（合同 §4「禁止纯卖萌替代健康提醒」的机械化）
  eq('p-8 adjust 缺动作拒', gateClipText('哎呀你歪啦', 'posture.adjust'), { ok: false, reason: 'missing_action' });
  eq('p-9 no_face 只有状态拒', gateClipText('咦，看不清你了呀', 'posture.no_face'), { ok: false, reason: 'missing_action' });
  eq('p-10 no_face 只有动作拒', gateClipText('快坐回来呀', 'posture.no_face'), { ok: false, reason: 'missing_action' });
  // 负锚：责备/恐吓/医疗式/评价外貌（forbiddenRe 先于 requiredRes 判）
  eq('p-11 责备拒', gateClipText('怎么又歪了，坐直', 'posture.adjust'), { ok: false, reason: 'slot_forbidden' });
  eq('p-12 恐吓拒', gateClipText('再不坐直就罚你', 'posture.adjust'), { ok: false, reason: 'slot_forbidden' });
  eq('p-13 医疗式拒', gateClipText('要驼背啦快坐直', 'posture.adjust'), { ok: false, reason: 'slot_forbidden' });
  // 旧 slot 不受新门影响（无 requiredRes/forbiddenRe）
  ok('p-14 greeting 无 required 门', gateClipText('嗨，你来啦', 'greeting.normal').ok);
  eq('p-15 姿态 13 字拒', gateClipText('来来来坐直腰背挺起来好精神', 'posture.adjust').ok, false);

  // manifest optional 语义：无姿态条目=键不存在（v107 兼容口径 §2.2「不得判残缺」的服务端形态）
  const A3 = 'device-TESTSN003';
  const { createHash: ch3 } = await import('node:crypto');
  const mkp = (slot: (typeof LOCAL_AUDIO_SLOTS)[number], seed: string) => {
    const sha = ch3('sha256').update(`p:${slot}:${seed}`).digest('hex');
    const id = sha.slice(0, 16);
    localAudioStore.writeAudio(A3, id, Buffer.from(`p-${seed}`), 'wav');
    localAudioStore.insertItem(A3, { slot, id, text: `p${slot}${seed}`, sha256: sha, bytes: 9, duration_ms: 2000, format: 'wav' });
    return { slot, id };
  };
  const keep6 = REQUIRED_SLOTS.flatMap((slot, i) => [mkp(slot, `${i}a`), mkp(slot, `${i}b`)]);
  eq('p-16 六必选套 commit rev=1', localAudioStore.commitSet(A3, keep6, { tier: 't', traits: '{}' }), 1);
  const m6 = localAudioStore.buildManifest(A3);
  eq('p-17 manifest 恰六键', Object.keys(m6.slots).length, 6);
  ok('p-18 无 posture 键（缺失=键不存在非空数组）', !('posture.adjust' in m6.slots) && !('posture.no_face' in m6.slots));
  const keepP = [...keep6, mkp('posture.adjust', 'pa'), mkp('posture.adjust', 'pb')];
  eq('p-19 加姿态套 commit rev=2', localAudioStore.commitSet(A3, keepP, { tier: 't', traits: '{}' }), 2);
  const m7 = localAudioStore.buildManifest(A3);
  eq('p-20 posture.adjust 2 条', ((m7.slots as Record<string, unknown[]>)['posture.adjust'] ?? []).length, 2);
  ok(
    'p-21 姿态条目五字段',
    ((m7.slots as Record<string, Array<Record<string, unknown>>>)['posture.adjust'] ?? []).every(
      (it) => it.format === 'wav' && it.codec === 'pcm_s16le' && it.sample_rate === 24000 && it.channels === 1 && it.bits_per_sample === 16,
    ),
  );
  localAudioStore.clearAccount(A3);
}

// ── 回声防线源头层：设备命令词/急停退出词禁入（2026-08-27，真机招呼语回声实证后加）──
{
  const { commandEchoReason } = await import('../src/local-audio-generator.js');
  ok('ew-1 命令词「关灯」拒', gateClipText('我帮你关灯啦', 'greeting.normal').ok === false);
  eq('ew-1b 拒因带词', (gateClipText('我帮你关灯啦', 'greeting.normal') as { ok: false; reason: string }).reason, 'device_command_word:关灯');
  ok('ew-2 短别名「调近」拒', gateClipText('咱们调近一点看', 'greeting.normal').ok === false);
  eq('ew-3 「停」字拒', (gateClipText('别停下呀快来', 'greeting.normal') as { ok: false; reason: string }).reason, 'stop_word:停');
  eq('ew-4 greeting 含「再见」拒', (gateClipText('嗨嗨，再见啦', 'greeting.normal') as { ok: false; reason: string }).reason, 'exit_word:再见');
  ok('ew-5 farewell 含「再见」豁免过', gateClipText('再见啦，明天见', 'farewell.goodbye').ok === true);
  eq('ew-6 farewell 含命令词仍拒', (gateClipText('关灯睡觉吧再见', 'farewell.night') as { ok: false; reason: string }).reason, 'device_command_word:关灯');
  ok('ew-7 干净文案不受影响', gateClipText('嗨，今天想聊点啥', 'greeting.normal').ok === true);
  ok('ew-8 词表快照 ≥200 词(同源加载非兜底集)', commandEchoReason('帮我把灯打开') !== null && commandEchoReason('虚像最近') !== null);
  eq('ew-9 filler 语义(无豁免)拒再见', commandEchoReason('那再见咯'), 'exit_word:再见');
  eq('ew-10 干净短语零命中', commandEchoReason('嗯呐，我想想'), null);
}

// ── v133 G1 奖励线（合同 CODEX_CC_P003_G1_LOCAL_AUDIO_V133_JOINT §2/§3：optional 六 slot +
//    minChars 门 + 惩罚/排名/焦虑禁 + requiredRes 区分度 + commitSet minRevision 跳号）──
{
  const { REQUIRED_SLOTS } = await import('../src/local-audio-store.js');
  const { SLOT_SPECS } = await import('../src/local-audio-generator.js');
  const G1 = [
    'g1.progress.coin_earned',
    'g1.progress.chest_earned',
    'g1.progress.final_earned',
    'g1.reward.coin_claimed',
    'g1.reward.chest_claimed',
    'g1.reward.final_claimed',
  ] as const;
  ok('g1-1 六 G1 slot 均在枚举', G1.every((s) => LOCAL_AUDIO_SLOTS.includes(s)));
  ok('g1-2 G1 不在 required', G1.every((s) => !REQUIRED_SLOTS.includes(s)));
  ok('g1-3 时长硬门全 2200 + 字数 6..9', G1.every((s) => SLOT_SPECS[s].maxDurationMs === 2200 && SLOT_SPECS[s].minChars === 6 && SLOT_SPECS[s].maxChars === 9));
  // 正锚（8..10 字 + 对象词齐）
  ok('g1-4 coin_earned 正锚', gateClipText('金币来啦你真棒呀', 'g1.progress.coin_earned').ok);
  ok('g1-5 chest_claimed 正锚', gateClipText('哇宝箱里好多惊喜呀', 'g1.reward.chest_claimed').ok);
  // minChars 门（G1 专属 8 字下限；greeting 等旧 slot 缺省 2 不受影响——ew-10 之前全绿即锚）
  eq('g1-6 5 字太短拒', gateClipText('金币到手啦', 'g1.reward.coin_claimed'), { ok: false, reason: 'too_short' });
  // requiredRes 区分度：coin slot 不点名金币=拒
  eq('g1-7 缺对象词拒', gateClipText('你这段真是太棒啦', 'g1.progress.coin_earned'), { ok: false, reason: 'missing_action' });
  // 惩罚/排名/焦虑禁（合同 §2 语义红线）
  eq('g1-8 比较表达拒', gateClipText('金币比别人拿得多', 'g1.progress.coin_earned'), { ok: false, reason: 'slot_forbidden' });
  // 回声禁入门对 G1 无豁免（急停/退出/命令词全生效）
  eq('g1-9 G1 含退出词拒', (gateClipText('金币拿好啦再见啦', 'g1.reward.coin_claimed') as { ok: false; reason: string }).reason, 'exit_word:再见');
  eq('g1-10 G1 含命令词拒', (gateClipText('领完金币就关灯咯', 'g1.reward.coin_claimed') as { ok: false; reason: string }).reason, 'device_command_word:关灯');

  // commitSet minRevision 跳号（v133 硬门 2：不得低于双机已持有值）
  const A4 = 'device-TESTSN004';
  const { createHash: ch4 } = await import('node:crypto');
  const mk4 = (slot: (typeof LOCAL_AUDIO_SLOTS)[number], seed: string) => {
    const sha = ch4('sha256').update(`g:${slot}:${seed}`).digest('hex');
    const id = sha.slice(0, 16);
    localAudioStore.writeAudio(A4, id, Buffer.from(`g-${seed}`), 'wav');
    localAudioStore.insertItem(A4, { slot, id, text: `g${slot}${seed}`, sha256: sha, bytes: 9, duration_ms: 2000, format: 'wav' });
    return { slot, id };
  };
  const keepR = REQUIRED_SLOTS.flatMap((slot, i) => [mk4(slot, `${i}a`), mk4(slot, `${i}b`)]);
  eq('g1-11 minRevision=5 跳号', localAudioStore.commitSet(A4, keepR, { tier: 't', traits: '{}' }, { minRevision: 5 }), 5);
  const keepG = [...keepR, mk4('g1.progress.coin_earned', 'ca'), mk4('g1.progress.coin_earned', 'cb')];
  eq('g1-12 跳号后续自然 +1', localAudioStore.commitSet(A4, keepG, { tier: 't', traits: '{}' }), 6);
  // manifest G1 键形态（有条目=键出现，字段五件套齐）
  const mg = localAudioStore.buildManifest(A4);
  eq('g1-13 g1 slot 2 条', ((mg.slots as Record<string, unknown[]>)['g1.progress.coin_earned'] ?? []).length, 2);
  ok(
    'g1-14 G1 条目 wav 五字段',
    ((mg.slots as Record<string, Array<Record<string, unknown>>>)['g1.progress.coin_earned'] ?? []).every(
      (it) => it.format === 'wav' && it.codec === 'pcm_s16le' && it.sample_rate === 24000 && it.channels === 1 && it.bits_per_sample === 16,
    ),
  );
  // minRevision 低于自然值时不倒退（MAX 语义负锚）
  eq('g1-15 低 minRevision 不倒退', localAudioStore.commitSet(A4, keepR, { tier: 't', traits: '{}' }, { minRevision: 3 }), 7);
  localAudioStore.clearAccount(A4);
}

// ── 容量算术锚（2026-08-28 rev5 冷同步活锁事故：限频必须覆盖合法客户端峰值+重试余量）──
{
  const { LOCAL_AUDIO_FILE_RPM_DEFAULT } = await import('../src/routes/local-audio.js');
  const { MAX_ITEMS_PER_SLOT } = await import('../src/local-audio-generator.js');
  // 冷同步=整套原子全量下载；理论最大套=slot 枚举×每 slot 上限；×1.5 留重试余量。
  // 枚举扩容会先让本锚翻红逼提额——把容量断言从「注释」升格成「随枚举收紧的测试」。
  ok('cap-1 file 限频默认 ≥ 理论最大套×1.5', LOCAL_AUDIO_FILE_RPM_DEFAULT >= LOCAL_AUDIO_SLOTS.length * MAX_ITEMS_PER_SLOT * 1.5);
  ok('cap-2 默认值即当前生产值(env 未配时行为一致)', LOCAL_AUDIO_FILE_RPM_DEFAULT === 120);
}

console.log(`\nlocal-audio tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
