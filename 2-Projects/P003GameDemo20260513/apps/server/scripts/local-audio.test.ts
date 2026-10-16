/**
 * 本地人格音频回归测试 · 跑法：npm run test:local-audio（tsx 直跑，无框架，风格同 persona-state.test）
 * 覆盖（合同 v1.1 + codex 回执四修订）：mp3 帧时长解析 / 清洗与计字 / 文案门（含负锚禁词）/
 * 触发判断全分支 / store 生命周期（复用·commitSet bump 与 no-change·归属校验·applied 触达·cleanup·clear）/
 * manifest 结构（schema_version=1、六 slot 对齐）。
 * TTS/LLM 走网络不进单测（生成链 E2E 在 D1 验收 A1/A2 用真机验）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AnyAudioSlot } from '../src/local-audio-store.js';

const tmp = mkdtempSync(join(tmpdir(), 'local-audio-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
for (const key of ['CONFIG','CONVERSATION','ACCOUNTS','FEEDBACK','DIAGNOSTICS','OTA','PAIRING','SMS','TELEMETRY']) process.env[`${key}_DB_PATH`] = join(tmp, `${key.toLowerCase()}.db`);
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.LOCAL_AUDIO_DIR = join(tmp, 'local-audio');
process.env.LOCAL_AUDIO_WRITES_PAUSED = '0';

const { mp3DurationMs, pcmToWav, parseWavHeader } = await import('../src/providers/xfyun-tts.js');
const { sanitizeClipText, countChars, gateClipText, shouldRegenerate, traitPromptLines, describeTrigger, estimateRevisionBytes, REVISION_CAP_BYTES, DEFAULT_ROUTINE_REFRESH_DAYS, PUBLISH_ITEMS_PER_SLOT, buildSlot } =
  await import('../src/local-audio-generator.js');
const { localAudioStore, LOCAL_AUDIO_SLOTS, MIN_ITEMS_PER_SLOT, REQUIRED_SLOTS } = await import('../src/local-audio-store.js');
const { TRAIT_BASELINE } = await import('../src/trait-store.js');
const { DEVICE_REPLY_SLOTS } = await import('../src/local-audio-store.js');
const { DEVICE_REPLY_TEXTS, activeDeviceReplyKeep, candidateManifestReport, DEVICE_REPLY_MAX_MS } = await import('../src/local-audio-device-reply.js');

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

// 真实音频 fixture；ID 可为历史16hex标识，SHA必须来自实际音频字节。
function stageFixture(account: string, slot: AnyAudioSlot, id: string, text: string, bytes = 48044) {
  const audio = pcmToWav(Buffer.alloc(bytes - 44));
  localAudioStore.writeAudio(account, id, audio, 'wav');
  localAudioStore.insertItem(account, { slot, id, text, sha256: createHash('sha256').update(audio).digest('hex'),
    bytes: audio.length, duration_ms: Math.round((audio.length - 44) / 48), format: 'wav' });
  return { slot, id };
}
function requiredFixture(account: string, tag = '') {
  return REQUIRED_SLOTS.flatMap(slot => [0, 1].map(n => stageFixture(account, slot,
    createHash('sha256').update(`${account}:${tag}:${slot}:${n}`).digest('hex').slice(0, 16), `短句${n}`)));
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

// ── 文案门（slot=greeting.normal 2026-09-06 起 2–6 字/1800ms，codex v237 普通唤醒口径；选句已对照全部规则分支确认真中性）──
const g1 = gateClipText('来啦聊点啥', 'greeting.normal');
eq('gate-1 正例通过', g1, { ok: true, text: '来啦聊点啥' });
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
// 字数门跟 slot 走：同一句（7 字，已逐字数过）在 cover_open(≤9) 过、normal(≤6) 拒
eq('gate-8 slot 字数差异·cover_open 过', gateClipText('欢迎回到书桌前', 'greeting.cover_open').ok, true);
eq('gate-9 slot 字数差异·normal 拒', gateClipText('欢迎回到书桌前', 'greeting.normal'), { ok: false, reason: 'too_long:7' });
// 规格锚（codex v237 §4：普通唤醒只用完整且 ≤1800ms 的动态招呼语；2–6 汉字）
const { SLOT_SPECS: SPEC_N } = await import('../src/local-audio-generator.js');
eq('gate-10 greeting.normal 规格 1800ms/2–6 字', [SPEC_N['greeting.normal'].maxDurationMs, SPEC_N['greeting.normal'].minChars, SPEC_N['greeting.normal'].maxChars], [1800, 2, 6]);
eq('gate-11 cover_open/presence_return 规格不动', [SPEC_N['greeting.cover_open'].maxDurationMs, SPEC_N['greeting.cover_open'].maxChars, SPEC_N['greeting.presence_return'].maxDurationMs], [2400, 9, 2400]);
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
  const mk = (id: string, text: string) => stageFixture(ACC, 'greeting.normal', id, text);
  mk('aaaaaaaaaaaaaaaa', '嗨你来啦');
  mk('bbbbbbbbbbbbbbbb', '我在这呢');
  mk('cccccccccccccccc', '嗨你来啦'); // 同文案重复条目不应被选两次
  const r = await buildSlot(ACC, 'greeting.normal', undefined, 2, true);
  eq('pub-4 staging 优先复用取满 target 且文案去重', { n: r.keep.length, texts: r.keep.map((k) => k.text).sort(), keptOld: r.keptOld }, { n: 2, texts: ['嗨你来啦', '我在这呢'], keptOld: false });
}

// ── traitPromptLines 不泄孩子字段（结构性红线锚：输出只含小可自己的维度词）──
const lines = traitPromptLines(T0);
eq('trait-1 五行', lines.length, 5);
ok('trait-2 无孩子字样', lines.every((l) => !l.includes('孩子') || l.includes('基线')) && !lines.join().includes('姓名'));

// ── store 生命周期 ──
const ACC = 'device-TESTSN001';

const mk = (slot: (typeof LOCAL_AUDIO_SLOTS)[number], seed: string) => {
  const id = createHash('sha256').update(`${slot}:${seed}`).digest('hex').slice(0, 16);
  return stageFixture(ACC, slot, id, `文案${seed}`);
};
eq('st-1 初始 state revision=0', localAudioStore.getState(ACC).revision, 0);
eq('st-2 初始 active 空', localAudioStore.listActive(ACC).length, 0);

// 六 slot 各 2 条 → commit → revision 1
const keep1 = LOCAL_AUDIO_SLOTS.flatMap((slot, i) => [mk(slot, String(i * 2)), mk(slot, String(i * 2 + 1))]);
eq('st-3 commit bump 到 1', localAudioStore.commitSet(ACC, keep1, { tier: '新朋友', traits: '{}' }, { expectedRevision: 0 }), 1);
eq('st-4 active=slot数x2', localAudioStore.listActive(ACC).length, LOCAL_AUDIO_SLOTS.length * 2);
eq('st-5 同集合重 commit 不 bump', localAudioStore.commitSet(ACC, keep1, { tier: '新朋友', traits: '{}' }, { expectedRevision: 1 }), null);
eq('st-6 revision 仍 1', localAudioStore.getState(ACC).revision, 1);
ok('st-7 no-change 也前移生成基准', localAudioStore.getState(ACC).last_generated_at > 0);

// J4 复用：同 slot 同 text 找得回
const found = localAudioStore.findByText(ACC, 'greeting.normal', '文案0', 'wav');
eq('st-8 findByText 命中(同 format)', found?.id, keep1[0].id);
eq('st-9 findByText 异 slot 不命中', localAudioStore.findByText(ACC, 'farewell.night', '文案0', 'wav'), null);
// WAV 迁移负锚（W4 混套事故回归）：同文案跨 format 绝不复用；staging 补足默认只出 wav
eq('st-9b 同文案 mp3 查询不命中 wav 条目', localAudioStore.findByText(ACC, 'greeting.normal', '文案0', 'mp3'), null);
eq('st-9c staging 补足(wav)不含 mp3 遗留', localAudioStore.listStagedBySlot(ACC, 'greeting.normal', 'wav').length, 0);

// 换掉一个 slot 的一条 → bump 到 2；被换条目 active=0 但仍可下载（切换窗口）
const swapped = mk('greeting.normal', 'ff');
const keep2 = [keep1[1], swapped, ...keep1.slice(2)];
eq('st-10 变更 commit bump 到 2', localAudioStore.commitSet(ACC, keep2, { tier: '新朋友', traits: '{}' }, { expectedRevision: 1 }), 2);
const dropped = keep1[0];
ok('st-11 被换条目仍可按归属取到', localAudioStore.getItem(ACC, dropped.id) !== null);
ok('st-12 被换条目已不在 active', !localAudioStore.listActive(ACC).some((i) => i.id === dropped.id));

// 归属与格式校验
eq('st-13 别家账号取不到', localAudioStore.getItem('device-OTHER', dropped.id), null);
eq('st-14 非法 id 格式拒', localAudioStore.getItem(ACC, '../etc/passwd'), null);
ok('st-15 读音频字节', localAudioStore.readAudio(ACC, swapped.id, 'wav')?.subarray(0, 4).toString() === 'RIFF');

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
writeFileSync(localAudioStore.audioPath(ACC, dropped.id, 'wav') + '.pin', '0');
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
eq('cl-3 清后文件读不到', localAudioStore.readAudio(ACC, swapped.id, 'wav'), null);

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

  const mkw = (slot, seed, format) => {
    const id = createHash('sha256').update(`${slot}:${seed}:${format}`).digest('hex').slice(0, 16);
    return stageFixture(A2, slot, id, `w${seed}`);
  };
  const keepW = LOCAL_AUDIO_SLOTS.flatMap((slot, i) => [mkw(slot, `${i}a`, 'wav'), mkw(slot, `${i}b`, 'wav')]);
  eq('wf-1 wav 套 commit', localAudioStore.commitSet(A2, keepW, { tier: 't', traits: '{}' }, { expectedRevision: 0 }), 1);
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
    const id = ch3('sha256').update(`p:${slot}:${seed}`).digest('hex').slice(0, 16);
    return stageFixture(A3, slot, id, `p${slot}${seed}`);
  };
  const keep6 = REQUIRED_SLOTS.flatMap((slot, i) => [mkp(slot, `${i}a`), mkp(slot, `${i}b`)]);
  eq('p-16 六必选套 commit rev=1', localAudioStore.commitSet(A3, keep6, { tier: 't', traits: '{}' }, { expectedRevision: 0 }), 1);
  const m6 = localAudioStore.buildManifest(A3);
  eq('p-17 manifest 恰六键', Object.keys(m6.slots).length, 6);
  ok('p-18 无 posture 键（缺失=键不存在非空数组）', !('posture.adjust' in m6.slots) && !('posture.no_face' in m6.slots));
  const keepP = [...keep6, mkp('posture.adjust', 'pa'), mkp('posture.adjust', 'pb')];
  eq('p-19 加姿态套 commit rev=2', localAudioStore.commitSet(A3, keepP, { tier: 't', traits: '{}' }, { expectedRevision: 1 }), 2);
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
  ok('ew-7 干净文案不受影响', gateClipText('嗨，聊点啥', 'greeting.normal').ok === true);
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
    const id = ch4('sha256').update(`g:${slot}:${seed}`).digest('hex').slice(0, 16);
    return stageFixture(A4, slot, id, `g${slot}${seed}`);
  };
  const keepR = REQUIRED_SLOTS.flatMap((slot, i) => [mk4(slot, `${i}a`), mk4(slot, `${i}b`)]);
  eq('g1-11 minRevision=5 跳号', localAudioStore.commitSet(A4, keepR, { tier: 't', traits: '{}' }, { expectedRevision: 0, minRevision: 5 }), 5);
  const keepG = [...keepR, mk4('g1.progress.coin_earned', 'ca'), mk4('g1.progress.coin_earned', 'cb')];
  eq('g1-12 跳号后续自然 +1', localAudioStore.commitSet(A4, keepG, { tier: 't', traits: '{}' }, { expectedRevision: 5 }), 6);
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
  eq('g1-15 低 minRevision 不倒退', localAudioStore.commitSet(A4, keepR, { tier: 't', traits: '{}' }, { expectedRevision: 6, minRevision: 3 }), 7);
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


// ---------- 设备回复十八槽（合同 v3.1 §5，2026-09-05）----------
{
  const ACC = 'device-BJP00326060100200099';
  eq('dr-1 十八槽数量', DEVICE_REPLY_SLOTS.length, 18);
  eq('dr-2 文本表覆盖全部槽且非空', DEVICE_REPLY_SLOTS.every((s) => (DEVICE_REPLY_TEXTS[s] ?? '').length > 0), true);
  eq('dr-3 文本互不重复', new Set(Object.values(DEVICE_REPLY_TEXTS)).size, 18);
  eq('dr-4 冻结文本样点（codex 调整的三条）', [DEVICE_REPLY_TEXTS['device_reply.applied_absolute'], DEVICE_REPLY_TEXTS['device_reply.boundary.generic'], DEVICE_REPLY_TEXTS['device_reply.not_now']], ['好的，已经调好了', '已经调到头啦', '现在暂时不能这样调']);
  ok('dr-5 时长上限 3200ms', DEVICE_REPLY_MAX_MS === 3200);
  // 现役：真实六必选槽各两条；后续追加十八条固定回复。
  const mk = (slot: string, id: string, bytes: number) => stageFixture(ACC, slot as AnyAudioSlot, id, `t-${id}`, bytes);
  const required = requiredFixture(ACC);
  const rev1 = localAudioStore.commitSet(ACC, required, { tier: 't', traits: '{}' }, { expectedRevision: 0 });
  ok('dr-6 现役集合发布 revision≥1', (rev1 ?? 0) >= 1);
  // 十八条入 staging（active=0）：不进 manifest、不进 activeDeviceReplyKeep
  const drRows = DEVICE_REPLY_SLOTS.map((slot, i) => { const id = `d${String(i).padStart(15, '0')}`; mk(slot, id, 96000); return { id, bytes: 96000 }; });
  eq('dr-7 staging 不进现役 manifest', Object.keys(localAudioStore.buildManifest(ACC).slots).filter((k) => k.startsWith('device_reply.')).length, 0);
  eq('dr-8 日常搬运只认已 active 的设备回复条目（staging 为 0）', activeDeviceReplyKeep(ACC).length, 0);
  const rep = candidateManifestReport(ACC, drRows, 5 * 1024 * 1024);
  eq('dr-9 候选 manifest = 现役 ∪ 十八条按 id 去重求和', { files: rep.candidate_unique_files, bytes: rep.candidate_bytes, dr: rep.device_reply_items }, { files: 30, bytes: 12 * 48044 + 18 * 96000, dr: 18 });
  eq('dr-10 旧槽计数与未丢失证明', { gn: rep.old_slot_counts['greeting.normal'], short: rep.old_slots_short }, { gn: 2, short: [] });
  ok('dr-11 在 5MiB 内且余量为正', rep.within_cap && rep.headroom_bytes > 0);
  const over = candidateManifestReport(ACC, drRows.map((r) => ({ ...r, bytes: 300000 })), 5 * 1024 * 1024);
  ok('dr-12 超限判定翻红（每条 300KB×18 + 现役 > 5MiB）', over.within_cap === false && over.headroom_bytes < 0);
  // 显式发布：现役 ∪ 十八条 → 新 revision；之后日常搬运能看见 18 条
  const rev2 = localAudioStore.commitSet(ACC, [
    ...localAudioStore.listActive(ACC).map((i) => ({ slot: i.slot, id: i.id })),
    ...DEVICE_REPLY_SLOTS.map((slot, i) => ({ slot, id: `d${String(i).padStart(15, '0')}` })),
  ], { tier: 't', traits: '{}' }, { expectedRevision: 1 });
  eq('dr-13 显式发布 bump revision', (rev2 ?? 0), (rev1 ?? 0) + 1);
  const m = localAudioStore.buildManifest(ACC);
  eq('dr-14 发布后 manifest 含十八槽各 1 条', DEVICE_REPLY_SLOTS.every((s) => (m.slots[s] ?? []).length === 1), true);
  eq('dr-15 发布后日常搬运带上 18 条', activeDeviceReplyKeep(ACC).length, 18);
  eq('dr-16 旧槽仍各 2 条（未丢失）', (m.slots['greeting.normal'] ?? []).length + (m.slots['farewell.general'] ?? []).length, 4);
  // dr-17：设备回复槽的 staging 条目豁免 14 天清理（等 APK 期间 SHA 不能变）
  const ACC2 = 'device-BJP00326060100200098';
  mk('greeting.normal', 'eeeeeeeeeeeeeee1', 1000);
  stageFixture(ACC2, 'device_reply.already', 'fffffffffffffff1', '现在就是这样啦');
  stageFixture(ACC2, 'greeting.normal', 'fffffffffffffff2', '我在呢');
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.PROFILE_DB_PATH!);
    db.prepare(`UPDATE local_audio_item SET created_at = ? WHERE account_id = ? AND active = 0`).run(Date.now() - 15 * 86_400_000, ACC2);
    db.close();
  }
  writeFileSync(localAudioStore.audioPath(ACC2, 'fffffffffffffff2', 'wav') + '.pin', '0');
  eq('dr-17 过期 staging 只清人格槽，设备回复槽豁免', localAudioStore.cleanup(ACC2), 1);
  ok('dr-18 设备回复 staging 条目仍在', localAudioStore.getItem(ACC2, 'fffffffffffffff1') !== null && localAudioStore.getItem(ACC2, 'fffffffffffffff2') === null);
}

// ---- 回声库内置兜底(2026-09-06 0001 首日实证) ----
{
  const { builtinGreetingTexts, BUILTIN_GREETING_TEXTS } = await import('../src/local-audio-store.js');
  const ACC3 = 'device-echo-builtin-test';
  const t0 = localAudioStore.listTextsForEcho(ACC3);
  ok('eb-1 无动态套的账号回声库=内置招呼语(greeting.builtin)', t0.length === BUILTIN_GREETING_TEXTS.length && t0.every((r) => r.slot === 'greeting.builtin'));
  ok('eb-2 内置含 0001 首日被当用户话的两句', t0.some((r) => r.text === '来啦，想聊点啥？') && t0.some((r) => r.text === '哟，你来啦。'));
  const echoSet = requiredFixture(ACC3);
  localAudioStore.commitSet(ACC3, echoSet, { tier: '新朋友', traits: '{}' }, { expectedRevision: 0 });
  const t1 = localAudioStore.listTextsForEcho(ACC3);
  ok('eb-3 有动态套时=动态在前 ∪ 内置', t1.some(r => r.slot === 'greeting.normal' && r.text === '短句0') && t1.length === 12 + BUILTIN_GREETING_TEXTS.length && t1[0]?.slot !== 'greeting.builtin');
  process.env.LOCAL_AUDIO_BUILTIN_GREETING_TEXTS = '测试追加句, 来啦。';
  ok('eb-4 env 追加去重', builtinGreetingTexts().length === BUILTIN_GREETING_TEXTS.length + 1 && localAudioStore.listTextsForEcho(ACC3).some((r) => r.text === '测试追加句'));
  delete process.env.LOCAL_AUDIO_BUILTIN_GREETING_TEXTS;
}

// ---- 绑定即生成门(2026-09-06) ----
{
  const { shouldKickoffLocalAudioOnOpen } = await import('../src/local-audio-generator.js');
  const fresh = { revision: 0, last_generated_at: 0 };
  ok('kick-1 开关开+从未生成 → 触发', shouldKickoffLocalAudioOnOpen(fresh, true));
  ok('kick-2 已生成过(revision>0) → 不触发', !shouldKickoffLocalAudioOnOpen({ revision: 1, last_generated_at: 1 }, true));
  ok('kick-2b 生成过但未发布(revision 0, last_generated_at>0) → 不触发', !shouldKickoffLocalAudioOnOpen({ revision: 0, last_generated_at: 5 }, true));
  ok('kick-3 开关关 → 不触发', !shouldKickoffLocalAudioOnOpen(fresh, false));
}

// ---- 绑定即生成唯一入口(2026-09-06 codex §3:重试/幂等恢复不得反复生成) ----
{
  const { kickoffLocalAudioOnce } = await import('../src/local-audio-generator.js');
  ok('kick-4 开关未开 → skipped_disabled(不起生成)', kickoffLocalAudioOnce('device-kick-test', 'unit') === 'skipped_disabled');
}

// ---------- G1 设置引导三句（Android codex 需求 2026-09-17，A 方案上限；gs-*）----------
{
  const { G1_SETTINGS_SLOTS } = await import('../src/local-audio-store.js');
  const { G1_SETTINGS_TEXTS, G1_SETTINGS_MAX_BYTES, G1_SETTINGS_MAX_MS, validateG1SettingsWav, resolveG1SettingsClips, stageG1SettingsClips, currentG1SettingsRows, activeG1SettingsKeep, publishG1Settings } =
    await import('../src/local-audio-g1-settings.js');
  const { carriedFrozenKeep } = await import('../src/local-audio-generator.js');
  const A1 = 'device-BJP00326060100200097';
  const A2 = 'device-BJP00326060100200096';
  eq('gs-1 三槽 + 冻结文本逐字', [G1_SETTINGS_SLOTS.length, G1_SETTINGS_TEXTS['g1.settings.enter'], G1_SETTINGS_TEXTS['g1.settings.intro'], G1_SETTINGS_TEXTS['g1.settings.exit']], [3, '向下滑动，进入设置。', '在这里，可以把灯光设置成你喜欢的亮度和色温，调节音量大小，来试试吧。', '学会啦，向上滑动，回到方舟继续使用吧。']);
  eq('gs-2 上限（A 方案：400KiB / 3000·8000·5500ms）', { b: G1_SETTINGS_MAX_BYTES, ms: G1_SETTINGS_MAX_MS }, { b: 409600, ms: { 'g1.settings.enter': 3000, 'g1.settings.intro': 8000, 'g1.settings.exit': 5500 } });
  const wavOf = (pcmBytes: number) => pcmToWav(Buffer.alloc(pcmBytes));
  const enterWav = wavOf(120000);
  const introWav = wavOf(353280);
  const exitWav = wavOf(238080);
  eq('gs-3 校验：真值三句均过（2500/7360/4960ms）', [validateG1SettingsWav('g1.settings.enter', enterWav), validateG1SettingsWav('g1.settings.intro', introWav), validateG1SettingsWav('g1.settings.exit', exitWav)].map((v) => (v.ok ? v.durationMs : v.reason)), [2500, 7360, 4960]);
  const badSr = wavOf(48000);
  badSr.writeUInt32LE(22050, 24);
  badSr.writeUInt32LE(44100, 28);
  eq('gs-4 校验拒：intro 8.1s / exit 401KiB / 22.05k 采样率 / 非 WAV', [validateG1SettingsWav('g1.settings.intro', wavOf(388800)), validateG1SettingsWav('g1.settings.exit', wavOf(409600)), validateG1SettingsWav('g1.settings.enter', badSr), validateG1SettingsWav('g1.settings.enter', Buffer.from('not a wav'))].map((v) => (v.ok ? 'ok' : v.reason.split(':')[0])), ['too_long_audio', 'file_too_big', 'bad_format', 'bad_wav']);
  // 基线现役：六必选槽齐全，所有字节与清单一致。
  for (const acc of [A1, A2]) {
    const required = requiredFixture(acc);
    localAudioStore.commitSet(acc, required, { tier: 't', traits: '{}' }, { expectedRevision: 0 });
  }
  const revA1 = localAudioStore.getState(A1).revision;
  let synthCalls = 0;
  const fakeSynth = async (text: string) => {
    synthCalls += 1;
    const w = text === G1_SETTINGS_TEXTS['g1.settings.enter'] ? enterWav : text === G1_SETTINGS_TEXTS['g1.settings.intro'] ? introWav : exitWav;
    return { audio: w, durationMs: parseWavHeader(w)!.durationMs };
  };
  const r1 = await resolveG1SettingsClips([A1, A2], { synthesize: fakeSynth });
  eq('gs-5 首次 resolve：每槽合成一次、零拒', { calls: synthCalls, n: Object.keys(r1.clips).length, rej: r1.rejected.length, origins: G1_SETTINGS_SLOTS.map((s) => r1.clips[s]?.origin) }, { calls: 3, n: 3, rej: 0, origins: ['synthesized', 'synthesized', 'synthesized'] });
  const rows1 = stageG1SettingsClips([A1, A2], r1.clips);
  const idsA1 = rows1.filter((r) => r.account_id === A1).map((r) => r.id);
  const idsA2 = rows1.filter((r) => r.account_id === A2).map((r) => r.id);
  eq('gs-6 扇出：两账号同槽同 id（同字节同 id）且 id=sha 前 16 位', { same: JSON.stringify(idsA1) === JSON.stringify(idsA2), hex: idsA1.every((id) => /^[0-9a-f]{16}$/.test(id)), pref: rows1.every((r) => r.sha256.startsWith(r.id)) }, { same: true, hex: true, pref: true });
  eq('gs-7 staging 不进 manifest / 不进搬运 / report 可见', { m: Object.keys(localAudioStore.buildManifest(A1).slots).filter((k) => k.startsWith('g1.settings.')).length, keep: activeG1SettingsKeep(A1).length, cur: currentG1SettingsRows(A1).map((r) => r.origin) }, { m: 0, keep: 0, cur: ['staged', 'staged', 'staged'] });
  synthCalls = 0;
  const r2 = await resolveG1SettingsClips([A1], { synthesize: fakeSynth });
  eq('gs-8 再次 resolve：复用已有条目，零合成', { calls: synthCalls, origins: G1_SETTINGS_SLOTS.map((s) => r2.clips[s]?.origin) }, { calls: 0, origins: ['reused', 'reused', 'reused'] });
  const rows2 = stageG1SettingsClips([A1], r2.clips);
  eq('gs-9 重复 stage 幂等（existing，不重写）', rows2.map((r) => r.origin), ['existing', 'existing', 'existing']);
  const rep = candidateManifestReport(A1, rows1.filter((r) => r.account_id === A1), REVISION_CAP_BYTES);
  eq('gs-10 候选预算 = 现役 12 条 + 三句', { files: rep.candidate_unique_files, bytes: rep.candidate_bytes, within: rep.within_cap }, { files: 15, bytes: 12 * 48044 + enterWav.length + introWav.length + exitWav.length, within: true });
  const pub = publishG1Settings(A1, rows1.filter((r) => r.account_id === A1));
  const m1 = localAudioStore.buildManifest(A1);
  eq('gs-11 发布：revision +1，三槽各 1 条，旧槽不丢', { before: pub.before, after: pub.after, g1: G1_SETTINGS_SLOTS.map((s) => (m1.slots[s] ?? []).length), old: (m1.slots['greeting.normal'] ?? []).length, rev: m1.revision }, { before: revA1, after: revA1 + 1, g1: [1, 1, 1], old: 2, rev: revA1 + 1 });
  const introEntry = (m1.slots['g1.settings.intro'] ?? [])[0] as Record<string, unknown>;
  eq('gs-12 manifest 字段由真 WAV 回读', { f: introEntry.format, c: introEntry.codec, sr: introEntry.sample_rate, ch: introEntry.channels, b: introEntry.bits_per_sample, bytes: introEntry.bytes, ms: introEntry.duration_ms, sha: (introEntry.sha256 as string).length, url: introEntry.url, text: introEntry.text }, { f: 'wav', c: 'pcm_s16le', sr: 24000, ch: 1, b: 16, bytes: introWav.length, ms: 7360, sha: 64, url: `/v1/device/local-audio/file/${idsA1[1]}`, text: G1_SETTINGS_TEXTS['g1.settings.intro'] });
  eq('gs-13 发布后日常搬运带上三句（carriedFrozenKeep）', { g1: activeG1SettingsKeep(A1).length, frozen: carriedFrozenKeep(A1).filter((k) => String(k.slot).startsWith('g1.settings.')).length }, { g1: 3, frozen: 3 });
  eq('gs-14 重复发布内容未变不 bump（keep 去重）', publishG1Settings(A1, rows2).after, null);
  const rows2b = stageG1SettingsClips([A1], r2.clips);
  eq('gs-15 发布后再 stage 不把现役打回 staging', { origins: rows2b.map((r) => r.origin), still: activeG1SettingsKeep(A1).length }, { origins: ['existing', 'existing', 'existing'], still: 3 });
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.PROFILE_DB_PATH!);
    db.prepare(`UPDATE local_audio_item SET created_at = ? WHERE account_id = ? AND active = 0`).run(Date.now() - 15 * 86_400_000, A2);
    db.close();
  }
  eq('gs-16 过期 staging 清理豁免 g1.settings.*（A2 三句仍在）', { cleaned: localAudioStore.cleanup(A2), left: currentG1SettingsRows(A2).length }, { cleaned: 0, left: 3 });
  eq('gs-17 listAccounts 含两账号', [A1, A2].every((a) => localAudioStore.listAccounts().includes(a)), true);
}

console.log(`\nlocal-audio tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
