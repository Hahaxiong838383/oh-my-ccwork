//! cascade 编排(P3b-W1:判停/打断语义对齐 livekit-agents 框架实际行为):
//!
//! - 判停 v2:VAD 停说锚点 + EOT sidecar 语义选挡(prob<0.3550 → MAX 否则 MIN),
//!   EOT 在说话中静音累积 ≥200ms 时刻拿最近 1.2s 音频预测(说话恢复作废重来)。
//! - 打断 v2(pause→false-timer→resume/abort 三段,对齐 agent_activity):
//!   VAD 语音 ≥MIN_INTERRUPTION_DURATION(0.5s)+ 字数门(≥1 字)→ **pause**(非 abort,
//!   RTC 内 ≤200ms 尾音自然放完);VAD 停说起 FALSE_INTERRUPTION_TIMEOUT(1.5s)定时,
//!   超时无 turn → resume 续播 + 契约 FalseInterruption;期间用户 turn 提交 → 才真 abort。
//! - AEC warmup(首次开口起 0.5s one-shot):窗口内禁音频路打断(框架同款)。
//! - 急停白名单:标准化精确命中 → 绕过字数门直接硬打断。
//! - 打断历史截断:按已播样本把 assistant 历史修正为真实说出的部分(句级+比例近似)。
//! - 契约日志:`契约 {事件} turn={id}` 逐字段对齐 pipeline/session.py。
//!
//! 未做(P3b-W2/W3):S1 投机、filler、剥承接词、TTS 池、metrics publish、STT 重连、
//! 声纹、音乐工具。

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::contract::Contract;
use crate::candidate::is_silent_result;
use crate::say_defer::{success_reply_silent, DeferredSay};
use crate::control;
use crate::eot::{EOT_MAX_SAMPLES, EotClient, UNLIKELY_THRESHOLD_ZH};
use crate::filler::FillerBank;
use crate::llm::{self, ChatOutcome, Llm, LlmConfig};
use crate::playout::{self, PlayoutControl};
use crate::preflight::{PreflightConfig, PreflightGate};
use crate::segmenter::Segmenter;
use crate::speaker_id::SpeakerSidecar;
use crate::stt_volc::{self, AsrEnd, SttConfig, SttEvent};
use crate::textproc::{normalize_utterance, parse_hotwords};
use crate::transcript_pub::{self, TranscriptPub, sentence_spans};
use crate::tts::TtsCfg;
use crate::turn::TurnGate;
use crate::vad::{SileroVad, VadEvent, VadGate, WINDOW};

pub struct PipelineConfig {
    pub min_endpointing_delay: Duration,
    pub max_endpointing_delay: Duration,
    pub unlikely_threshold: f32,
    pub min_interruption_words: usize,
    pub min_interruption_duration: f32,
    pub false_interruption_timeout: Duration,
    pub aec_warmup_duration: Duration,
    /// B(2026-09-09 codex GO,只在隔离 POC env 置 1):commit 来自 ordered 终局时,普通 filler 改为语义桶最短完整条。
    /// 默认关;生产 env 不设;打断轮/非 ordered 轮不受影响。
    pub ordered_filler_shortest: bool,
    /// B9 #3（只在隔离 POC env 置 1）：ordered 每条 held final 到达即起投机 LLM（复用 S1v3 start_speculation），
    /// commit 时文本+历史版本相同才消费，否则丢弃；不改 commit 时序与任何门。
    pub ordered_spec_on_final: bool,
    /// B11（只在隔离 POC env 置 1）：ordered 提交且投机命中时跳过垫句——正文 ≈+0.3 s 起播，不再等最短垫句 0.96 s。
    pub ordered_skip_filler_on_spec: bool,
    /// B11：投机至少领先这么多毫秒才跳垫句（突发/A 型房投机 lead≈20 ms，跳了就是 ~1 s 静默；B 型真机 lead≈1.1 s 才值得跳）。
    pub ordered_skip_filler_min_lead_ms: u64,
    /// TTS 回声对撞窗(2026-08-26 关灯自嗨实证:确认语「好的…」被端侧回声收回,播完 48ms 后
    /// 从 EOU 正门 commit 成用户轮——打断门只管播放期间,不管回声轮次)。播放中或播完后
    /// 此窗内 commit 的文本若是最近播出文本的子串 → 判回声丢弃。0 = 关闭该门。
    /// 默认 800ms:回声 commit 机理上限≈0.8s(EOU 0.6+ASR 尾 0.2,实测迟到仅 48ms);真人
    /// 「选择题复述应答」(答案恰是刚播文本子串)的 commit 下沿≈1.45s——800 落两分布空隙。
    pub echo_suppress_window: Duration,
    /// 本地音频回声对撞窗(2026-09-01「刚打了个盹儿」幽灵轮实证):设备本地招呼语 WAV
    /// 不进 WebRTC render reference(端侧 AEC 消不掉)、文案也不是 worker 播的(上面的
    /// TTS 对撞库对不上)。会话开始此窗内的 commit 若模糊命中该设备本地音频文案
    /// (LCS≥0.8,回声只掉字不加字)→判回声丢弃。招呼语只在开场播,窗外零对撞零误伤面。
    /// 0 = 关闭该门(零二进制回滚)。
    pub local_audio_echo_window: Duration,
    /// 最长本地招呼语时长(开场重叠窗时间锚;server 生成器 greeting 各槽 maxDurationMs≤3000,取 3200 留余量)。
    /// 0 = 关闭开场重叠放宽门(零二进制回滚),原 LCS≥0.8 门不受影响。
    pub local_audio_greeting_max: Duration,
    /// 芯片候选播放窗持有(2026-09-06 v230 灯控实证:LLM 回复「帮你调亮一点」被喇叭念出,芯片麦路径无 AEC
    /// 参考,听回成第二个 label 4 → worker 直接提案+硬打断在播回复=一次语音两次执行、回复截成「这」)。
    /// 开:在播或播完 ECHO_SUPPRESS_WINDOW_MS 内到达的芯片候选**不提案、不 abort**,记为等 ASR 的候选
    /// (同句真人 ASR/LLM 命中才执行;worker 自己的 VAD/ASR 打断门与急停词照旧负责真人打断)。
    /// env DEVICE_CHIP_PLAYBACK_HOLD,默认开;0 = 旧行为(零二进制回滚)。
    pub chip_playback_hold: bool,
    /// 命令句单出口(同一实证的另一半):已被芯片提案/端侧认领的说话轮次不起 filler/LLM,
    /// 唯一出口是结果驱动的冻结短句——从源头去掉「LLM 复述命令词」与双出口。
    /// env DEVICE_CMD_SINGLE_EXIT,默认开;0 = 旧行为(LLM 叙述 + 追加短句)。
    pub cmd_single_exit: bool,
    pub tts_min_sentence_len: usize,
    pub greeting_text: String,
    /// 连接后是否自动播固定开场白。P003 安卓 demo 要求关掉(2026-08-15 联调)。
    /// 默认 true —— 其余环境行为不变。
    pub greeting_enabled: bool,
    /// S2B1 canary.say 联调通道。默认关;identity 白名单空=全部拒绝(fail-closed)。
    pub canary_say_enabled: bool,
    pub canary_identity_allow: Vec<String>,
    pub vad_model_path: String,
    pub hotwords: HashSet<String>,
    /// 退出词吞句集(EXIT_SWALLOW_HOTWORDS):整句命中→只吞轮次(防幽灵回答轮),
    /// 回复/关房归 Android。与急停表分开配置,词表须与 Android SESSION_EXIT 一致。
    pub exit_hotwords: HashSet<String>,
    /// A 案(2026-08-28):exit 尾部匹配开关(EXIT_TAIL_MATCH,默认开;置 0 回退纯精确匹配)。
    pub exit_tail_match: bool,
}

/// 是否播开场白。抽成函数是为了让**生产用的那条判据**能被单测直接调用——
/// 在测试里重写一遍条件等于没测它。
fn should_greet(enabled: bool, text: &str) -> bool {
    enabled && !text.trim().is_empty()
}

/// 布尔型 env 解析。**非法值回退默认值而不是 panic**:开场白开关误配
/// 不该让整个 worker 起不来——它是体验开关,不是安全开关。
fn parse_flag(raw: Option<&str>, default: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) => match v.as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default, // 含空字符串
        },
        None => default,
    }
}

impl PipelineConfig {
    /// 单独暴露给 main.rs 的 VAD 预加载(vad::preload)——与 from_env 同源,防两处路径漂移。
    pub fn vad_model_path_from_env() -> String {
        std::env::var("VAD_MODEL_PATH").unwrap_or_else(|_| {
            format!("{}/assets/silero_vad.onnx", env!("CARGO_MANIFEST_DIR"))
        })
    }

    pub fn from_env() -> Self {
        let f = |k: &str, d: f32| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d)
        };
        Self {
            min_endpointing_delay: Duration::from_secs_f32(f("MIN_ENDPOINTING_DELAY", 0.55)),
            max_endpointing_delay: Duration::from_secs_f32(f("MAX_ENDPOINTING_DELAY", 0.6)),
            unlikely_threshold: f("POC_EOU_UNLIKELY_THRESHOLD", UNLIKELY_THRESHOLD_ZH),
            min_interruption_words: std::env::var("MIN_INTERRUPTION_WORDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1),
            min_interruption_duration: f("MIN_INTERRUPTION_DURATION", 0.5),
            false_interruption_timeout: Duration::from_secs_f32(f(
                "FALSE_INTERRUPTION_TIMEOUT",
                1.5,
            )),
            aec_warmup_duration: Duration::from_secs_f32(f("AEC_WARMUP_DURATION", 0.5)),
            ordered_filler_shortest: std::env::var("ORDERED_FILLER_SHORTEST").map(|v| v == "1").unwrap_or(false),
            ordered_spec_on_final: std::env::var("ORDERED_SPEC_ON_FINAL_ENABLED").map(|v| v == "1").unwrap_or(false),
            ordered_skip_filler_on_spec: std::env::var("ORDERED_SKIP_FILLER_ON_SPEC").map(|v| v == "1").unwrap_or(false),
            ordered_skip_filler_min_lead_ms: std::env::var("ORDERED_SKIP_FILLER_MIN_LEAD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(600),
            echo_suppress_window: Duration::from_millis(
                std::env::var("ECHO_SUPPRESS_WINDOW_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(800),
            ),
            local_audio_echo_window: Duration::from_millis(
                std::env::var("LOCAL_AUDIO_ECHO_WINDOW_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(15_000),
            ),
            local_audio_greeting_max: Duration::from_millis(
                std::env::var("LOCAL_AUDIO_GREETING_MAX_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(3_200),
            ),
            chip_playback_hold: parse_flag(std::env::var("DEVICE_CHIP_PLAYBACK_HOLD").ok().as_deref(), true),
            cmd_single_exit: parse_flag(std::env::var("DEVICE_CMD_SINGLE_EXIT").ok().as_deref(), true),
            tts_min_sentence_len: std::env::var("TTS_MIN_SENTENCE_LEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(6),
            greeting_text: std::env::var("AGENT_GREETING")
                .unwrap_or_else(|_| "你好，我在。你可以直接打断我。".into()),
            greeting_enabled: parse_flag(
                std::env::var("AGENT_GREETING_ENABLED").ok().as_deref(),
                true,
            ),
            canary_say_enabled: parse_flag(
                std::env::var("CANARY_SAY_ENABLED").ok().as_deref(),
                false,
            ),
            canary_identity_allow: std::env::var("CANARY_SAY_IDENTITY_ALLOW")
                .unwrap_or_default()
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect(),
            vad_model_path: Self::vad_model_path_from_env(),
            hotwords: parse_hotwords(std::env::var("INTERRUPT_HOTWORDS").ok().as_deref()),
            exit_hotwords: crate::textproc::parse_hotwords_with(
                std::env::var("EXIT_SWALLOW_HOTWORDS").ok().as_deref(),
                crate::textproc::DEFAULT_EXIT_HOTWORDS,
            ),
            exit_tail_match: parse_flag(std::env::var("EXIT_TAIL_MATCH").ok().as_deref(), true),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentState {
    Listening,
    Thinking,
    Speaking,
}

#[derive(Debug)]
enum TurnEvent {
    AudioStarted(u64),
    PlayedOut(u64),
    /// 2b:LLM task 剥出的 [[DEV:N]] 意图回主循环(执行需 &mut self:pending_cmd/trace/publish)
    /// v3.1(codex 复核 §2):带创建时捕获的 turn id 与说话轮次,消费前过 device_ledger::l2_event_gate
    DevIntent { label: u32, text: String, turn_id: u64, utterance: u64 },
}

/// S2-B2 命令轮槽(合同 §4.3/4.4):发布 proposed 后等 result,终态播固定短句。
/// 单槽语义:新命令覆盖旧槽,旧 result 迟到按 idempotency_key 不匹配丢弃。
struct PendingCmd {
    idempotency_key: String,
    action: &'static str,
    /// 相对调节动作(成功句「好嘞，调好啦」;其余「好的，已经调好了」)
    relative: bool,
    sent_at: Instant,
    /// accepted 已播「好的，正在调整」(只播一次,终态还会再播终句)
    accepted_acked: bool,
    /// 命令来源 lane("L1" 快路 / "L2" 慢路):成功句是否静默按它判(say_defer::success_reply_silent)
    lane: &'static str,
}

/// Worker 等 result 的兜底超时(合同缺口,守恒默认 8s——交接文档待 codex 确认;
/// Android 自身有 timeout status,这里兜的是 Android 整个没回的情况)
const DEVICE_RESULT_DEADLINE: Duration = Duration::from_secs(8);
/// 命令句单出口的长度豁免线:超过它视为「命令+闲聊」混合句,仍交 LLM。
const CMD_SINGLE_EXIT_MAX_CHARS: usize = 20;

/// 相对调节动作(成功句「好嘞，调好啦」;绝对/目标动作「好的，已经调好了」)。
fn is_relative_action(action: &str) -> bool {
    matches!(
        action,
        "brightness_up" | "brightness_down" | "color_temperature_warmer"
            | "color_temperature_cooler" | "color_temperature_cycle_down"
            | "motor_up_step" | "motor_down_step" | "virtual_image_farther_step"
            | "virtual_image_nearer_step" | "volume_up_5" | "volume_down_5_min_5"
    )
}

enum TurnKind {
    Say(String),
    Reply {
        user_text: String,
        pending_amend: Option<String>,
        /// 承接音(文案, 24k pcm):先于回复音频入轨,同轨串行(C1 v2 语义)。
        filler: Option<(String, Vec<u8>)>,
        /// S1v3 投机命中:直接消费投机流,不再发正式 LLM 请求。
        spec: Option<Speculation>,
    },
}

/// 投机生成(preflight 触发的提前 LLM 流;命中=提交文本全等+历史版本未变)。
struct Speculation {
    text: String,
    version: u64,
    started: Instant,
    task: JoinHandle<Result<ChatOutcome>>,
    rx: mpsc::Receiver<String>,
}

struct AgentTurn {
    id: u64,
    task: JoinHandle<()>,
    ctl: PlayoutControl,
    synth_text: Arc<StdMutex<String>>,
    /// 每句合成完成后追加 (累计字符数, 累计样本数),打断截断用。
    progress: Arc<StdMutex<Vec<(usize, u64)>>>,
    /// B 观测:本轮 filler 的 24k 样本数(0=无 filler);turn 起始时刻;分段日志阶段(0/1/2)。
    filler_samples: u64,
    started: Instant,
    seg_stage: u8,
}

/// 在途 canary.say:turn 结束(播完或取消)后从 stats 槽取终态发 metrics。
struct CanaryPending {
    test_id: String,
    trace_id: String,
    seq: i64,
    turn_id: u64,
    stats: std::sync::Arc<std::sync::Mutex<Option<crate::playout::FinalStats>>>,
}

/// 在途退出信令(v140 合同 §4:重试同 seq,ACK/cancel/room close 任一终态即停)。
struct ExitSignalPending {
    seq: i64,
    sent_at: Instant,
    attempts: u8,
    envelope: Value,
}

struct Orchestrator {
    /// One-shot v0.3:有序 PCM 代次(Some=实验模式;None=现役 RTC,本字段零参与)
    ordered: Option<crate::ordered_pcm::Session>,
    /// ordered_pcm:待执行的「主动收流」(drop 唯一 ASR 发送端);由主循环消费,因为发送端不在 Orchestrator 里
    ordered_end_stream_pending: bool,
    /// B9 #2：本 job 是否已记过候选日志（ack 字段幂等，只记第一次）。
    ordered_end_candidate_logged: bool,
    /// 输出门(gate.rs):Android 未订 agent 轨前扣住可听 PCM,首个待播起 5s fail-closed
    output_gate: crate::gate::OutputGate,
    /// 门超时 → 主循环 fail-closed 的传导通道
    fatal_tx: mpsc::Sender<String>,
    /// S2-B2:本房是否开设备命令(启动时按 room+env 定一次)
    device_commands_on: bool,
    /// S2-B2 命令轮单槽:同时最多一个 pending 命令(新命令覆盖旧槽,迟到 result 按 key 忽略)
    pending_cmd: Option<PendingCmd>,
    /// 2b §3.4:设备短句追加槽(回复在播时压后,播完再说;抢话作废)
    deferred_say: DeferredSay,
    /// v3.1(codex R1–R4 修正):设备命令账本——同句归属按语音段时序、所有权统一裁决 L1/L2、精确去重键、L0 门序
    /// (device_ledger.rs,纯逻辑单测)。取代 3 s 时间窗 FirstWins。
    ledger: crate::device_ledger::Ledger,
    /// v3.1:Android 能力声明原值(wake 包 contract_version;0=未声明);≥3 才启用 claimed/deferred 电机等 ASR 语义
    contract_version: u32,
    /// S2-B2:会话级 trace(input_ready 同源,命令事件绑它;None=不发命令)
    device_trace: Option<String>,
    /// v140 退出信令灰度(合同 §8.3 先仅 0010;fail-closed:env 未配=不发,吞句照常)
    exit_signal_on: bool,
    /// 退出信令 seq(per-job 单调;重试必须同 seq——只在新命中时自增)
    exit_seq: i64,
    /// 在途退出信令:等 ACK/cancel/room close 任一终态;800ms 无终态同 seq 重发,至多 3 发
    exit_pending: Option<ExitSignalPending>,
    /// 2b:本房 LLM 慢路执行开关(启动时按 room+env 定一次,默认关=2a 观察)
    l2_execute_on: bool,
    /// 2b:Android 能力声明(wake 包 contract_version>=2 才允许发 L2;room 级,job 结束即弃)
    l2_capable: bool,
    /// 本地音频回声对撞库(2026-09-01):(slot, normalize 后文案)。job 开始异步拉取填充,
    /// 拉不到=空(fail-open)。只装 greeting.*(farewell 播于关房时刻不需要;且退出词
    /// 与 farewell 文案对撞会误吞真退出意图——greeting 生成门本就禁退出/命令词,双保险)。
    echo_local_texts: Arc<StdMutex<Vec<(String, String)>>>,
    /// 会话起点(本地音频回声窗基准;招呼语只在开场播)
    session_started_at: Instant,
    /// 开场窗内对撞 miss 的短 commit(≤3字)时刻——错转碎片追杀标(01:00「那」实证)
    echo_short_turn_at: Option<Instant>,
    /// 开场重叠窗截止(unix ms):建房秒(≈唤醒)+ 最长招呼语 + 余量;None = 非设备房/放宽门关闭。
    /// 说完时刻 ≤ 此值的 commit 视为「招呼语可能还在播」,回声门放宽到 LCS≥0.3(textproc::local_audio_echo_overlap_hit)。
    opening_overlap_deadline_ms: Option<i64>,
    /// 输入环启动时刻(首帧到达;开场重叠窗起点判据基准)
    input_loop_started_at: Option<Instant>,
    /// 本会话首个 VAD 语音起点(只记一次)
    first_speech_onset_at: Option<Instant>,
    /// 用户 commit 计数(含被吞的;放宽分支只看第 1 句)
    user_commit_count: u32,
    cfg: PipelineConfig,
    tts_cfg: TtsCfg,
    llm: Arc<Mutex<Llm>>,
    source: NativeAudioSource,
    participant: LocalParticipant,
    room_name: String,
    contract: Contract,
    turn_gate: TurnGate,
    state: AgentState,
    agent_turn: Option<AgentTurn>,
    next_turn_id: u64,
    /// Some(timeout)=当前回答被 pause(假打断窗口),timeout 为 VAD 停说后起的定时时长。
    paused: Option<Duration>,
    false_deadline: Option<Instant>,
    aec_deadline: Option<Instant>,
    aec_armed: bool,
    resume_grace: Option<Instant>,
    /// TTS 回声对撞:最近一次播出的全部文本(filler+正文/say;被打断时=真实播出的 spoken 部分)
    echo_tts_text: String,
    /// 最近一次播出结束时刻(PlayedOut 自然播完或 hard_abort),对撞窗从这里起算
    echo_playout_end: Option<Instant>,
    /// 当前在途 turn 的 filler 文案(不能混进 synth_text——会错位打断截断,单独暂存)
    echo_cur_filler: String,
    latest_interim: String,
    /// 打断遥测快照(对齐 _tele_interim:最近一次转写文本,telemetry 行后清空)。
    tele_text: String,
    /// 真插话时刻(interim 非空的 speaking→listening),5s 窗内的 turn=打断轮 filler 必播。
    last_interrupt_at: Option<Instant>,
    turn_ev_tx: mpsc::Sender<TurnEvent>,
    eot_tx: mpsc::Sender<(u64, f32)>,
    eot_gap_gen: u64,
    eot_requested: bool,
    pending_amend: Option<String>,
    bank: Option<FillerBank>,
    pf: PreflightGate,
    spec: Option<Speculation>,
    speaker: Option<SpeakerSidecar>,
    /// 字幕发布(legacy Transcription 包,页面气泡消费)。
    tr: TranscriptPub,
    /// 当前 turn 已发 interim(句进入播出)/final(句播完)的句数游标。
    tr_started: usize,
    tr_finaled: usize,
    /// 入站 cancel 的 (trace_id, seq) 幂等表
    ctrl_dedup: control::Dedup,
    /// canary.say 独立幂等表(与 cancel 分表:两类消息的 seq 空间互不干扰)
    canary_dedup: control::Dedup,
    /// 在途 canary:等 playout 终态就绪后发 final metrics(单发)
    canary_pending: Option<CanaryPending>,
    t0: Instant,
    /// EOT 判停快照采集(上线前置① D1;EOT_SNAPSHOT_DIR 未设=None,零行为变化)
    snap: Option<crate::eot_snapshot::SnapshotSink>,
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 回声对撞归一:只留字母/数字/汉字(is_alphanumeric 对 CJK 为 true)并小写——
/// ASR 转写与 TTS 原文的标点/空白差异不参与判定。
fn normalize_echo(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn unix_ms_now() -> i64 {
    now_unix_ms()
}

/// 合同 §8:normalized_text_hash(sha256 前 16 hex,日志对撞用非隐私承诺)。
fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// S2-B2 固定短回复表(合同 §4.5;不走 LLM)。
/// 边界句约定(2026-08-19 v58 交接已确认):reason 含 "boundary" 时按 action 方向播边界句;
/// 其余 rejected 统一「现在暂时不能这样调」。
/// executed_unconfirmed(v58 新语义:命令已执行但状态快照未刷新,≠失败):播中性完成句,
/// 不声称精确档位、不触发重试——话术过度自信会在罕见未生效场景误导用户。
fn device_reply(status: &str, relative: bool, reason: &str, action: &str) -> String {
    // 文本=合同 v3.1 十八槽冻结值(codex 2026-09-05 阶段 B GO §3),与端侧本地音频 text 同表,两端不得自行润色。
    match status {
        "succeeded" => {
            if reason == "executed_unconfirmed" {
                "已发送调整，暂未确认".to_string() // 下发未确认≠物理成功,不说「调好了」
            } else if relative {
                "好嘞，调好啦".to_string()
            } else {
                "好的，已经调好了".to_string()
            }
        }
        "already_applied" => "现在就是这样啦".to_string(),
        "rejected" => {
            if reason.contains("boundary") {
                boundary_reply(action)
            } else if reason == "unsupported_device_type" {
                "这台设备不支持调画面距离".to_string()
            } else {
                "现在暂时不能这样调".to_string()
            }
        }
        // failed/timeout/未知状态统一「未确认」句(守恒:未知不冒充成功;也不催促立即重试)
        _ => "暂时没能确认调整结果".to_string(),
    }
}

/// 边界句按动作族措辞(2026-09-04 003 实证:`virtual_image_farthest` 不含 "farther",曾落到「已经到最低了」)。
/// 族由动作名前缀定(虚像 远/近、亮度 亮/暗、色温 暖/冷、音量 大/小、升降 高/低);
/// 方向词 `_up`/max/farth/warm=上限,down/min/near/cool/cold=下限;辨不出方向=中性到头句(不冒充方向)。
fn boundary_reply(action: &str) -> String {
    let up = action.contains("_up") || action.contains("max") || action.contains("farth") || action.contains("warm");
    let down = action.contains("down")
        || action.contains("min")
        || action.contains("near")
        || action.contains("cool")
        || action.contains("cold");
    let (hi, lo) = if action.starts_with("virtual_image") {
        ("画面已经是最远的了", "画面已经是最近的了")
    } else if action.starts_with("brightness") {
        ("亮度已经是最高了", "亮度已经是最低了")
    } else if action.starts_with("color_temperature") {
        ("色温已经是最暖的了", "色温已经是最冷的了")
    } else if action.starts_with("volume") {
        ("音量已经是最大了", "音量已经是最小了")
    } else {
        ("高度已经是最高了", "高度已经是最低了")
    };
    match (up, down) {
        (true, false) => hi.to_string(),
        (false, true) => lo.to_string(),
        _ => "已经调到头啦".to_string(),
    }
}

/// job 层传入的就绪上下文(input_ready 合同 2026-08-18):trace 绑定 + 输出门信号 + 打点基准。
/// 预连 ASR 句柄(2026-09-07):job 层在 assignment 到达后立刻 spawn,火山 ASR websocket 握手(实测 0.4–0.6 s)与
/// 建房/发布出声轨/等用户音轨并行;pipeline 启动时直接接管。此前握手在 pipeline 内起,落在输入环启动后
/// +380–614ms(今早四房实读),真人「提示音一停就说」的首段语音只能在 channel 里排队等握手,首个转写整体延后。
/// job 在 pipeline 启动前退出时句柄随之丢弃:sender drop → 流发空尾段按 InputDone 自然收尾。
pub struct SttPre {
    pub pcm_tx: mpsc::Sender<Vec<i16>>,
    pub ev_rx: mpsc::Receiver<SttEvent>,
    pub task: tokio::task::JoinHandle<()>,
}

/// 该房的 ASR 配置:env 基线 + 二遍识别 per-SN 灰度(命中即切 bigmodel_async + enable_nonstream,必须同调:
/// 老 bigmodel 静默忽略此参数)。非命中房间零变化。
pub fn stt_cfg_for_room(room_name: &str) -> SttConfig {
    let mut stt_cfg = SttConfig::from_env();
    if crate::device_intent::asr_nonstream_enabled_for(room_name) {
        stt_cfg.nonstream = true;
        stt_cfg.url = stt_volc::ASYNC_ASR_URL.to_string();
        info!(room = %room_name, "ASR 二遍识别灰度命中(bigmodel_async+nonstream)");
    }
    stt_cfg
}

/// 起 STT 长连任务(断线重连:改进项,Python 版死流;连续 5 败放弃)。返回 pcm 发送端/事件接收端/任务句柄。
pub fn spawn_stt(stt_cfg: SttConfig, room_name: &str) -> SttPre {
    let (stt_pcm_tx, stt_pcm_rx) = mpsc::channel::<Vec<i16>>(128);
    let (stt_ev_tx, stt_ev_rx) = mpsc::channel::<SttEvent>(64);
    info!(room = %room_name, nonstream = stt_cfg.nonstream, "asr stream task spawned (preconnect)");
    let rn = room_name.to_string();
    let task = tokio::spawn(async move {
        let mut pcm_rx = stt_pcm_rx;
        let mut fails = 0u32;
        loop {
            let started = Instant::now();
            match stt_volc::run_asr_stream(stt_cfg.clone(), &mut pcm_rx, stt_ev_tx.clone()).await {
                Ok(AsrEnd::InputDone) => break,
                Ok(AsrEnd::InputDoneEof) => {
                    // 收流后未见 LastNoSeq 即 EOF:输入已结束不重连,但先报 Interrupted(ordered_pcm 不得提交半段 final)
                    warn!(room = %rn, "asr 收流后未见 LastNoSeq 即被关闭(意外 EOF)");
                    let _ = stt_ev_tx.send(SttEvent::Interrupted).await;
                    break;
                }
                Ok(AsrEnd::ServerClosed) => {
                    let _ = stt_ev_tx.send(SttEvent::Interrupted).await;
                }
                Err(e) => {
                    warn!(room = %rn, error = %e, "火山 ASR 流异常");
                    let _ = stt_ev_tx.send(SttEvent::Interrupted).await;
                }
            }
            if started.elapsed() > Duration::from_secs(10) {
                fails = 0; // 长稳连接后的断开不算连败
            }
            fails += 1;
            if fails > 5 {
                warn!(room = %rn, "asr 连续 {fails} 次失败,放弃重连");
                break;
            }
            let backoff = Duration::from_millis(500 * 2u64.pow((fails - 1).min(3)));
            warn!(room = %rn, attempt = fails, backoff_ms = backoff.as_millis() as u64, "asr 断线重连");
            tokio::time::sleep(backoff).await;
        }
        let _ = stt_ev_tx.send(SttEvent::Closed).await;
    });
    SttPre { pcm_tx: stt_pcm_tx, ev_rx: stt_ev_rx, task }
}

/// 预组装产物(2026-09-07):不依赖音轨/房间对象的全部重活。job 收到 assignment 即起 `prebuild`,与建房/发布出声轨/
/// 等用户音轨并行;订到轨后 pipeline 直接接管,把「订到音轨 → 输入环启动」从 176–337 ms(VAD 模型 + 填充语库读盘为主,
/// 期间麦克风帧在 NativeAudioStream 队列里溢出丢帧)压到接管尾巴。无预组装路径在 run_pipeline 内原地调用同一函数。
pub struct Prebuilt {
    pub cfg: PipelineConfig,
    pub tts_cfg: TtsCfg,
    pub llm: Arc<Mutex<Llm>>,
    pub echo_local_texts: Arc<StdMutex<Vec<(String, String)>>>,
    pub speaker: Option<SpeakerSidecar>,
    pub vad: SileroVad,
    pub bank: Option<FillerBank>,
    pub stt: SttPre,
    pub started_at: Instant,
}

pub async fn prebuild(room_name: String) -> Result<Prebuilt> {
    let started_at = Instant::now();
    // ASR 预连最先起(握手最长,0.4–0.6 s)
    let stt = spawn_stt(stt_cfg_for_room(&room_name), &room_name);
    let cfg = PipelineConfig::from_env();
    let tts_cfg = TtsCfg::from_env()?;
    info!(
        room = %room_name,
        tts_provider = tts_cfg.provider_name(),
        tts_voice = %tts_cfg.voice(),
        "tts provider 生效值"   // 音色对不上时一眼对账,别靠猜 env 生效没生效
    );
    let mut llm_cfg = LlmConfig::from_env().ok_or_else(|| anyhow::anyhow!("LLM_BASE_URL 未配置"))?;
    // per-device 身份路由:room(sn-<SN>-<ts>)随 query 传大脑,由大脑按 SN 反查该设备 brain 账号
    // (多设备防串号;非 sn- 房间大脑忽略 room 走 token 兜底语义)。
    llm_cfg.room = room_name.clone();
    // 本地音频回声对撞库(2026-09-01):异步拉该设备文案,拉不到=空库 fail-open。
    // 只对 sn- 设备房拉(web/probe 房没有本地音频,省一次空转)。
    let echo_local_texts: Arc<StdMutex<Vec<(String, String)>>> = Arc::new(StdMutex::new(Vec::new()));
    if !cfg.local_audio_echo_window.is_zero() && room_name.starts_with("sn-") {
        let ecfg = llm_cfg.clone();
        let etexts = echo_local_texts.clone();
        let rn = room_name.clone();
        tokio::spawn(async move {
            match llm::fetch_local_audio_texts(&ecfg, &ecfg.room).await {
                Some(list) => {
                    let greetings: Vec<(String, String)> = list
                        .into_iter()
                        .filter(|(slot, _)| slot.starts_with("greeting."))
                        .map(|(slot, text)| (slot, normalize_echo(&text)))
                        .collect();
                    let n = greetings.len();
                    *etexts.lock().unwrap() = greetings;
                    info!(room = %rn, texts = n, "local-audio echo bank loaded");
                }
                None => info!(room = %rn, "local-audio echo bank unavailable (fail-open)"),
            }
        });
    }
    let mut llm_inner = Llm::new(llm_cfg);
    // 预热(藏进「用户说首句+判停」窗口):LLM TLS 建连 + TTS 池首连
    {
        let (client, mut pcfg) = llm_inner.prewarm_parts();
        // 预热剥身份(2026-09-01「hi」假对话实证):预热唯一目的=建 TLS 连接,带身份 query
        // 会被大脑当真对话走全链路(注 prompt+Gemini+**写对话历史**)——每次开机落一对
        // 「hi/开场白」进聊天记录,并虚增人格 session 记账。匿名预热(与灾备路同款语义)
        // =authContext null=大脑不注个性化不落历史;TLS/连接池按 host 复用,预热价值不变。
        pcfg.url_query = String::new();
        pcfg.room = String::new();
        tokio::spawn(llm::prewarm(pcfg, client));
        // 赛马兜底路同 prewarm(Python 同款:兜底冷连接会吃掉它的竞速价值)
        if let Some((fc, fcfg)) = llm_inner.fallback_prewarm_parts() {
            tokio::spawn(llm::prewarm(fcfg, fc));
        }
        let tc = tts_cfg.clone();
        tokio::spawn(async move { tc.prewarm().await });
    }
    // 重活进 blocking 线程(VAD 模型 / 填充语库 93 条读盘 / 声纹注册库),不占 runtime 线程——建房与等音轨正在并行 await。
    let vad_path = cfg.vad_model_path.clone();
    let (vad, bank, speaker) = tokio::task::spawn_blocking(move || -> Result<(SileroVad, Option<FillerBank>, Option<SpeakerSidecar>)> {
        let vad = SileroVad::load(&vad_path)?;
        let bank = FillerBank::load_from_env();
        // 声纹旁路(SPEAKER_ID_ENABLED=1 且注册库在):粘滞身份槽接入 LLM 近因位
        let speaker = SpeakerSidecar::load_from_env();
        Ok((vad, bank, speaker))
    })
    .await
    .map_err(|e| anyhow::anyhow!("prebuild join: {e}"))??;
    if let Some(s) = &speaker {
        llm_inner.set_speaker_slot(s.sticky_slot());
    }
    let llm = Arc::new(Mutex::new(llm_inner));
    info!(
        room = %room_name,
        elapsed_ms = started_at.elapsed().as_millis() as u64,
        has_fillers = bank.is_some(),
        has_speaker = speaker.is_some(),
        "pipeline prebuilt"
    );
    Ok(Prebuilt { cfg, tts_cfg, llm, echo_local_texts, speaker, vad, bank, stt, started_at })
}

pub struct ReadyCtx {
    /// Room 会话级 activeTraceId(token metadata 受信通道);None=老 token/调试房,ready 不发
    pub trace_id: Option<String>,
    /// 输出方向就绪信号(job 层 LocalTrackSubscribed 时置 true)
    pub out_rx: tokio::sync::watch::Receiver<bool>,
    /// assignment 到达时刻(elapsed_ms 基准)
    pub t_assign: Instant,
    /// user 轨订到时刻(track_to_input_loop 基准)
    pub t_user_track: Instant,
    pub connect_ms: u64,
    pub issue_to_assignment_ms: Option<i64>,
}

#[allow(clippy::too_many_arguments)] // job→pipeline 的装配线,拆 struct 反而断上下文
pub async fn run_pipeline(
    mut mic: NativeAudioStream,
    source: NativeAudioSource,
    participant: LocalParticipant,
    room_name: String,
    route: transcript_pub::Route,
    mut ctrl_rx: mpsc::Receiver<(control::Envelope, control::Inbound, Option<String>)>,
    mut devres_rx: mpsc::Receiver<(control::DeviceResult, Option<String>)>,
    mut hist_rx: mpsc::Receiver<crate::ordered_pcm::Packet>,
    input_mode: crate::ordered_pcm::InputMode,
    beat: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ready: ReadyCtx,
    prebuilt: Option<Prebuilt>,
) -> Result<()> {
    // 预组装接管(2026-09-07):job 层在 assignment 到达即开始的重活(VAD 模型/填充语库/声纹库/LLM·TTS 客户端与预热/
    // 回声库拉取/ASR 预连)此处直接接管;无预组装路径(web 调试直连)原地组装,行为一致。
    let Prebuilt { cfg, tts_cfg, llm, echo_local_texts, speaker, mut vad, bank, stt, started_at: prebuilt_at } = match prebuilt {
        Some(p) => p,
        None => prebuild(room_name.clone()).await?,
    };
    info!(room = %room_name, prebuilt_age_ms = prebuilt_at.elapsed().as_millis() as u64, "pipeline takeover prebuilt");
    // One-shot v0.3:受信输入模式在第一帧前固定。ordered_pcm=RTC 帧从第一帧起不进 VAD/ASR/EOT/投机,只吃有序 PCM 代次;
    // 现役房 None,下方所有 `orch.ordered` 分支不触发(零行为变化)。
    let ordered_session = match input_mode {
        crate::ordered_pcm::InputMode::OrderedPcm => {
            info!(room = %room_name, "ordered_pcm 实验模式启用(受信 metadata):等待有序 PCM 代次,RTC 音频只计数丢弃");
            Some(crate::ordered_pcm::Session::new(ready.trace_id.clone(), crate::ordered_pcm::Limits::from_env()))
        }
        crate::ordered_pcm::InputMode::Rtc => None,
    };
    let mut gate = VadGate::new(
        std::env::var("VAD_ACTIVATION_THRESHOLD")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.6),
        std::env::var("VAD_MIN_SPEECH_DURATION")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.15),
        0.3,
    );

    // STT 长连:由预组装接管(握手已在建房阶段完成)。
    let SttPre { pcm_tx: stt_pcm_tx, ev_rx: mut stt_ev_rx, task: stt_task } = stt;
    // ordered_pcm 需要主动收流(drop 唯一发送端 → 供应商 LastNoSeq → 唯一裁决点);现役路径永远是 Some,行为不变
    let mut stt_pcm_tx = Some(stt_pcm_tx);
    let mut stt_closed = false;

    let (turn_ev_tx, mut turn_ev_rx) = mpsc::channel::<TurnEvent>(16);
    let (eot_tx, mut eot_rx) = mpsc::channel::<(u64, f32)>(8);

    let participant2 = participant.clone();
    // 输出门 fail-closed 传导:OutputGate 包装层超时 → fatal_rx → 主循环 return Err
    // → job 收尾(关房删房),设备走既有重连路径。容量 1:一次 fatal 就收摊。
    let (fatal_tx, mut fatal_rx) = mpsc::channel::<String>(1);

    let device_commands_on = crate::device_intent::commands_enabled_for(&room_name);
    if device_commands_on {
        info!(room = %room_name, "S2-B2 设备命令已启用(canary 命中)");
    }
    let exit_signal_on = crate::device_intent::exit_signal_enabled_for(&room_name);
    if exit_signal_on {
        info!(room = %room_name, "session_exit 信令已启用(v140 canary 命中)");
    }
    let l2_execute_on = crate::device_intent::l2_execute_enabled_for(&room_name);
    if l2_execute_on {
        info!(room = %room_name, "LLM 慢路执行已启用(2b canary 命中;仍需 Android capability>=2)");
    }
    // 开场重叠窗时间锚(2026-09-06 0006 实证:动态招呼语尾巴错转穿过 0.8 门)。房名时间戳=server 建房秒≈唤醒时刻。
    // SN 例外表(codex v237 §7.3):端侧「提示音播完才开麦」的设备,就绪后立刻说的真人首句会落进估算窗——跳过放宽分支。
    let opening_overlap_skip = crate::device_intent::overlap_gate_skipped_for(&room_name);
    let opening_overlap_deadline_ms = if cfg.local_audio_greeting_max.is_zero() || opening_overlap_skip {
        None
    } else {
        crate::textproc::room_unix_secs(&room_name)
            .map(|s| crate::textproc::opening_overlap_deadline_ms(s, cfg.local_audio_greeting_max.as_millis() as u64))
    };
    if opening_overlap_skip {
        info!(room = %room_name, "local-audio opening-overlap gate skipped for this SN (v237 full-prompt-then-mic)");
    }
    let mut orch = Orchestrator {
        output_gate: crate::gate::OutputGate::new(ready.out_rx.clone()),
        fatal_tx,
        device_commands_on,
        exit_signal_on,
        exit_seq: 0,
        exit_pending: None,
        l2_execute_on,
        l2_capable: false,
        echo_local_texts,
        session_started_at: Instant::now(),
        echo_short_turn_at: None,
        opening_overlap_deadline_ms,
        input_loop_started_at: None,
        first_speech_onset_at: None,
        user_commit_count: 0,
        pending_cmd: None,
        deferred_say: DeferredSay::default(),
        ledger: crate::device_ledger::Ledger::new(),
        contract_version: 0,
        device_trace: ready.trace_id.clone(),
        turn_gate: TurnGate::new(
            cfg.min_endpointing_delay,
            cfg.max_endpointing_delay,
            cfg.unlikely_threshold,
        ),
        cfg,
        tts_cfg,
        llm,
        source,
        participant,
        room_name: room_name.clone(),
        contract: Contract::new(),
        state: AgentState::Listening,
        agent_turn: None,
        next_turn_id: 0,
        paused: None,
        false_deadline: None,
        aec_deadline: None,
        aec_armed: false,
        resume_grace: None,
        echo_tts_text: String::new(),
        echo_playout_end: None,
        echo_cur_filler: String::new(),
        latest_interim: String::new(),
        tele_text: String::new(),
        last_interrupt_at: None,
        turn_ev_tx,
        eot_tx,
        eot_gap_gen: 0,
        eot_requested: false,
        pending_amend: None,
        bank,
        pf: PreflightGate::new(PreflightConfig::from_env()),
        spec: None,
        speaker,
        tr: TranscriptPub::new(participant2, route),
        tr_started: 0,
        tr_finaled: 0,
        ctrl_dedup: control::Dedup::default(),
        canary_dedup: control::Dedup::default(),
        canary_pending: None,
        t0: Instant::now(),
        snap: crate::eot_snapshot::SnapshotSink::from_env(&room_name),
        ordered: ordered_session,
        ordered_end_stream_pending: false,
        ordered_end_candidate_logged: false,
    };

    // EOT 环形缓冲:采集关=最近 1.2s(原状);采集开=8s(smart-turn 窗,快照落盘用,
    // predict 仍只取尾 1.2s,判停行为不变)
    let ring_keep = crate::eot_snapshot::SnapshotSink::ring_keep(orch.snap.is_some(), EOT_MAX_SAMPLES);
    let mut eot_ring: VecDeque<i16> = VecDeque::with_capacity(ring_keep + WINDOW);
    let mut vad_buf: Vec<i16> = Vec::with_capacity(WINDOW * 2);
    // 火山按段消化音频:攒 200ms(3200 样本)一发,对齐 Python segment_duration_ms=200。
    const STT_SEGMENT_SAMPLES: usize = 3200;
    let mut stt_buf: Vec<i16> = Vec::with_capacity(STT_SEGMENT_SAMPLES * 2);
    let mut commit_tick = tokio::time::interval(Duration::from_millis(50));

    // greeting(session.say 语义:入历史、可被打断、走同一播放机)
    // 门禁(P003 安卓联调 2026-08-15):AGENT_GREETING_ENABLED=0 关闭;文本为空同样不播,
    // 对齐 Python 侧「AGENT_GREETING 为空即静默」的既有约定(tier_a_cascade 的 elif 落空)。
    // 关闭路径**不建 Say turn** —— 不碰 TTS、不产 PCM、不写历史、不发字幕,停在 Listening。
    // 日志只记两个布尔,不带开场白文本(联调日志会外发)。
    let greeting = orch.cfg.greeting_text.clone();
    if should_greet(orch.cfg.greeting_enabled, &greeting) {
        orch.start_turn(TurnKind::Say(greeting));
    } else {
        info!(
            room = %room_name,
            enabled = orch.cfg.greeting_enabled,
            text_empty = greeting.trim().is_empty(),
            "开场白已关闭,保持 Listening"
        );
    }

    // 输入水位观测(2026-08-12 聋窗排查加装):每 10s 一行 frames+均幅。聋时一眼分层——
    // frames=0=源侧断流(mute/息屏);frames 正常 amp≈0=送的是静音;都正常=下游(火山)问题。
    let mut in_frames: u64 = 0;
    let mut in_amp_acc: u64 = 0;
    let mut in_report = Instant::now();
    // input_ready 只发一次:独立标志,不复用 in_frames(它被 10s 水位报告清零,
    // 生产实证 2026-08-18 06:20 同 job 每 10s 重发一次 input_ready——Android 幂等兜住但脏)
    let mut input_ready_fired = false;

    loop {
        tokio::select! {
            // 输出门 fail-closed(冻结 2026-08-18):首个待播 PCM 起 5s Android 仍未订阅
            // agent 轨 → 整 job 收摊关房,绝不带着半聋房间继续跑
            Some(msg) = fatal_rx.recv() => {
                return Err(anyhow::anyhow!("output gate fail-closed: {msg}"));
            }
            // 入站控制包(设备 → worker)。放在最前面:cancel 的时效性高于音频帧处理。
            ctrl = ctrl_rx.recv() => {
                // channel 关闭不退主循环——控制通道是可选能力,断了不该拖垮通话
                if let Some((ev, kind, identity)) = ctrl {
                    orch.on_control(&ev, kind, identity.as_deref()).await;
                }
            }
            frame = mic.next() => {
                let Some(frame) = frame else { break };
                let samples: Vec<i16> = frame.data.to_vec();
                in_frames += 1;
                if !input_ready_fired {
                    input_ready_fired = true;
                    // input_ready 发射点(合同硬性要求 3):输入消费循环真实收到首帧,
                    // 不是"循环该启动了"——PCM 确实在流动才算就绪
                    let track_to_loop = ready.t_user_track.elapsed().as_millis() as i64;
                    info!(
                        room = %room_name,
                        elapsed_ms = ready.t_assign.elapsed().as_millis() as u64,
                        track_to_input_loop_ms = track_to_loop,
                        "input_loop_started"
                    );
                    match ready.trace_id.as_deref() {
                        Some(trace) => {
                            let v = control::input_ready(
                                trace,
                                now_unix_ms(),
                                &room_name,
                                orch.output_gate.is_open(),
                                &control::ReadyTimings {
                                    issue_to_assignment_ms: ready.issue_to_assignment_ms,
                                    job_room_connect_ms: ready.connect_ms as i64,
                                    track_to_input_loop_ms: track_to_loop,
                                },
                            );
                            orch.publish_json(control::TOPIC, v);
                            info!(room = %room_name, "session.input_ready published");
                        }
                        // 老 token/调试房:无受信 trace 可绑,合同禁 pending → 降级不发
                        None => warn!(room = %room_name, "input_ready skipped: 无 trace(老 token 或非 Session API 房)"),
                    }
                }
                orch.input_loop_started_at.get_or_insert(Instant::now());
                if let Some(o) = orch.ordered.as_mut() {
                    // ordered_pcm:RTC 帧到此为止——不进幅度统计/ASR 队列/EOT 环/声纹/投机/VAD(只计数)
                    o.note_rtc_frame_dropped();
                    continue;
                }
                if !samples.is_empty() {
                    in_amp_acc += samples.iter().map(|s| u64::from(s.unsigned_abs())).sum::<u64>()
                        / samples.len() as u64;
                }
                stt_buf.extend_from_slice(&samples);
                if stt_buf.len() >= STT_SEGMENT_SAMPLES {
                    // 满则丢段不阻塞热路径(channel 128 段 ≈ 25s 缓冲,正常永远不满)
                    if let Some(tx) = &stt_pcm_tx {
                        let _ = tx.try_send(std::mem::take(&mut stt_buf));
                    }
                }
                eot_ring.extend(samples.iter().copied());
                while eot_ring.len() > ring_keep {
                    eot_ring.pop_front();
                }
                if let Some(sp) = orch.speaker.as_mut() {
                    sp.ring.append(&samples); // 声纹 ring:写入即幅度过滤
                }
                orch.on_pf_frame(&samples).await;
                vad_buf.extend_from_slice(&samples);
                while vad_buf.len() >= WINDOW {
                    let chunk: Vec<i16> = vad_buf.drain(..WINDOW).collect();
                    if let Ok(p) = vad.predict(&chunk) {
                        let active = p >= gate.activation_threshold;
                        let ev = gate.feed(p);
                        orch.on_vad_frame(&gate, ev, active, &eot_ring).await;
                    }
                }
            }
            // One-shot v0.3:有序 PCM 包(现役房通道永远空,分支不触发)
            Some(pkt) = hist_rx.recv() => {
                orch.on_ordered_packet(&pkt, &stt_pcm_tx);
                if orch.ordered_end_stream_pending {
                    orch.ordered_end_stream_pending = false;
                    stt_pcm_tx.take(); // 主动收流:供应商回 LastNoSeq → Closed → 裁决
                }
            }
            ev = stt_ev_rx.recv(), if !stt_closed => match ev {
                Some(SttEvent::Interim(t)) => {
                    if let Some(o) = orch.ordered.as_mut() { o.on_stt_interim(); } else { orch.on_interim(t) }
                }
                Some(SttEvent::Final(t)) => {
                    if let Some(o) = orch.ordered.as_mut() {
                        let acts = o.on_stt_final(t, unix_ms_now());
                        orch.apply_ordered_actions(acts);
                        orch.on_ordered_final_held().await;
                    } else {
                        orch.on_final(t)
                    }
                }
                Some(SttEvent::Interrupted) => {
                    // 现役:连接由 stt 任务重连,这里只记日志;ordered_pcm:代次作废(意外 EOF/断连 ≠ LastNoSeq,不得提交半段 final)
                    if orch.ordered.is_some() {
                        let acts = orch.ordered.as_mut().map(|o| o.on_stream_interrupted()).unwrap_or_default();
                        orch.apply_ordered_actions(acts);
                    } else {
                        info!(room = %room_name, "stt 连接中断(现役:等待 stt 任务重连)");
                    }
                }
                Some(SttEvent::Closed) | None => {
                    if orch.ordered.is_some() {
                        // ordered_pcm:流结束=唯一裁决点。完整 → 一次 final 走现役 commit 路径;否则整代作废。
                        // job 不在此退出(回复要播完),由设备断房/输出门收尾。
                        stt_closed = true;
                        orch.on_ordered_stream_end();
                    } else {
                        warn!(room = %room_name, "stt 事件流结束(重连=W2,job 收尾)");
                        break;
                    }
                }
            },
            Some((gap_gen, prob)) = eot_rx.recv() => {
                let accepted = gap_gen == orch.eot_gap_gen;
                if accepted {
                    orch.turn_gate.on_eot_prob(prob);
                    tracing::debug!(probability = prob, threshold = orch.cfg.unlikely_threshold, "eot prediction");
                }
                if let Some(s) = &mut orch.snap {
                    s.event("eot_prob", &[
                        ("gap_gen", &gap_gen.to_string()),
                        ("prob", &format!("{prob:.6}")),
                        ("accepted", if accepted { "1" } else { "0" }),
                    ]);
                }
            }
            Some(te) = turn_ev_rx.recv() => orch.on_turn_event(te),
            _ = commit_tick.tick() => {
                // watchdog 心跳(epoch ms):主循环卡死(如等锁)时停跳,job 层 5s 无跳即惊闸关房
                beat.store(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    std::sync::atomic::Ordering::Relaxed,
                );
                if in_report.elapsed() >= Duration::from_secs(10) {
                    let mean_amp = if in_frames > 0 { in_amp_acc / in_frames } else { 0 };
                    info!(room = %room_name, frames = in_frames, mean_amp, "audio in (10s)");
                    in_frames = 0;
                    in_amp_acc = 0;
                    in_report = Instant::now();
                }
                orch.poll_device_timeout(Instant::now());
                orch.poll_ledger(Instant::now());
                orch.on_tick().await;
                if orch.ordered_end_stream_pending {
                    orch.ordered_end_stream_pending = false;
                    stt_pcm_tx.take();
                }
            }
            // S2-B2:Android 设备命令执行结果(独立 topic 独立管道)
            r = devres_rx.recv() => {
                if let Some((r, identity)) = r {
                    orch.on_device_result(r, identity.as_deref());
                }
                // channel 关闭不退主循环——命令通道是可选能力
            }
        }
    }

    if let Some(t) = orch.agent_turn.take() {
        t.ctl.abort();
        t.task.abort();
    }
    if let Some(sp) = orch.spec.take() {
        sp.task.abort();
    }
    if let Some(o) = orch.ordered.as_mut() {
        // job 收尾时代次若未终态(设备断房/输出门 fail-closed)→ room_closed 终态,证据里不留悬空代次
        let _ = o.fail(crate::ordered_pcm::FailReason::RoomClosed);
        info!(room = %room_name, evidence = %o.evidence(), "ordered_pcm summary");
    }
    drop(stt_pcm_tx);
    let _ = tokio::time::timeout(Duration::from_secs(3), stt_task).await;
    info!(room = %room_name, "pipeline closed");
    Ok(())
}

impl Orchestrator {
    /// agent 状态迁移:telemetry 行(speaking→listening)+ 契约事件(bridge 同款,
    /// 进 listening 一律发 AgentSpeechStopped——含 thinking→listening 的 quirk)
    /// + speaking 状态 publish(topic=state,租户图标 UI 状态机依赖)。
    fn set_state(&mut self, new: AgentState) {
        if self.state == new {
            return;
        }
        if self.state == AgentState::Speaking && new == AgentState::Listening {
            let snap: String = self.tele_text.chars().take(40).collect();
            info!(room = %self.room_name, "interrupt telemetry: speaking→listening interim='{snap}'");
            if !self.tele_text.is_empty() {
                // interim 非空的 speaking→listening=真插话,记时刻供打断轮 filler 必播
                self.last_interrupt_at = Some(Instant::now());
            }
            self.tele_text.clear();
        }
        match new {
            AgentState::Speaking => {
                self.contract.agent_speech_started();
                self.publish_json("state", json!({"k": "speaking", "speaking": true}));
            }
            AgentState::Listening => {
                self.contract.agent_speech_stopped();
                if self.state == AgentState::Speaking {
                    self.publish_json("state", json!({"k": "speaking", "speaking": false}));
                }
            }
            AgentState::Thinking => {
                if self.state == AgentState::Speaking {
                    self.publish_json("state", json!({"k": "speaking", "speaking": false}));
                }
            }
        }
        self.state = new;
    }

    /// publish_data 到 room(web 延迟面板/租户状态机消费;失败只记不抛)。
    /// One-shot v0.3:有序 PCM 包 → 代次状态机 → 按 3200 块写 ASR 队列(try_send 失败=计数+整代失败)→ 执行动作。
    fn on_ordered_packet(&mut self, pkt: &crate::ordered_pcm::Packet, stt_tx: &Option<mpsc::Sender<Vec<i16>>>) {
        let now_ms = unix_ms_now();
        let mut acts = self.ordered.as_mut().map(|o| o.on_packet(pkt, now_ms)).unwrap_or_default();
        if let Some(o) = self.ordered.as_mut() {
            let more = o.drain_submits(|block| match stt_tx {
                Some(tx) => tx.try_send(block).is_ok(),
                None => false,
            });
            acts.extend(more);
        }
        self.apply_ordered_actions(acts);
    }

    /// 代次动作:result 记日志(无 PCM/无文本)+ 出站(同 topic、OPCM 线格式、空 PCM);收流交主循环执行。
    fn apply_ordered_actions(&mut self, acts: Vec<crate::ordered_pcm::Action>) {
        for a in acts {
            match a {
                crate::ordered_pcm::Action::EndStream => self.ordered_end_stream_pending = true,
                crate::ordered_pcm::Action::Publish(v) => {
                    if v["t"] == "result" {
                        info!(room = %self.room_name, result = %v, "ordered_pcm result");
                    }
                    if v["t"] == "ack" && v["end_candidate"] == true && !self.ordered_end_candidate_logged {
                        self.ordered_end_candidate_logged = true;
                        info!(room = %self.room_name, quiet_ms = v["end_candidate_quiet_ms"].as_u64().unwrap_or(0),
                              "ordered_pcm end candidate published (held final + trailing quiet)");
                    }
                    self.publish_raw(crate::ordered_pcm::TOPIC, crate::ordered_pcm::encode_packet(&v, &[]));
                }
            }
        }
    }

    /// 供应商流结束(LastNoSeq→Closed)=唯一裁决点:完整 → 一条 final 走现役 on_final→判停→commit 路径
    /// (退出/急停/回声/设备命令/LLM 门全部照常);否则整代作废,零 commit。
    fn on_ordered_stream_end(&mut self) {
        let (decision, acts) = match self.ordered.as_mut() {
            Some(o) => o.on_stream_end(unix_ms_now()),
            None => return,
        };
        self.apply_ordered_actions(acts);
        match decision {
            crate::ordered_pcm::Decision::Commit(text) => {
                info!(room = %self.room_name, chars = text.chars().count(), "ordered_pcm generation complete → final 进现役 commit 路径");
                self.on_final(text);
                // B6(2026-09-09 真机 7/7 房 eou 400–448 ms 全是空等):输入已由设备 end 宣告结束且完整性门已裁决,
                // 终局 final 免 MIN_ENDPOINTING_DELAY——下一 tick 即 commit;退出/急停/回声/命令/LLM 门照常在 commit 后。
                self.turn_gate.mark_input_ended();
            }
            crate::ordered_pcm::Decision::Discard(r) => {
                info!(room = %self.room_name, reason = r.as_str(), "ordered_pcm generation discarded (zero commit)");
            }
        }
        if let Some(o) = &self.ordered {
            info!(room = %self.room_name, evidence = %o.evidence(), "ordered_pcm decision evidence");
        }
    }

    fn publish_raw(&self, topic: &'static str, payload: Vec<u8>) {
        let p = self.participant.clone();
        tokio::spawn(async move {
            let packet = DataPacket {
                payload,
                topic: Some(topic.to_string()),
                reliable: true,
                ..Default::default()
            };
            if let Err(e) = p.publish_data(packet).await {
                tracing::debug!(error = %e, "publish_data failed");
            }
        });
    }

    fn publish_json(&self, topic: &'static str, v: Value) {
        let p = self.participant.clone();
        tokio::spawn(async move {
            let packet = DataPacket {
                payload: v.to_string().into_bytes(),
                topic: Some(topic.to_string()),
                reliable: true,
                ..Default::default()
            };
            if let Err(e) = p.publish_data(packet).await {
                tracing::debug!(error = %e, "publish_data failed");
            }
        });
    }

    fn now_ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    /// S1v3 触发器逐帧喂音频;fire → 起投机。
    async fn on_pf_frame(&mut self, samples: &[i16]) {
        let now_ms = self.now_ms();
        if let Some((text, sil, quiet)) = self.pf.on_frame(samples, now_ms) {
            let tail_snip: String = text
                .chars()
                .rev()
                .take(16)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            info!(
                room = %self.room_name,
                "S1v3 preflight emitted (silence={sil:.0}ms quiet={quiet:.0}ms tail='{tail_snip}')"
            );
            self.start_speculation(text).await;
        }
    }

    /// 起投机 LLM(不含 TTS;历史快照版本随身,提交时校验)。旧投机作废。
    ///
    /// ⚠️ 死锁红线(2026-08-16 voice-test-rust 卡死实证):主循环内**禁止阻塞等 llm 锁**。
    /// 回复孙任务持锁跨整个 LLM 流;真打断 pause 悬置时 playout 不消费 → pcm 满 →
    /// 回复任务停收 delta → delta 满 → 孙任务挂在 send 上锁永不释放;而 pause 的
    /// 解除路径(假打断定时/下轮提交)全在主循环——主循环一等锁即四环死锁。
    /// 投机是可丢的优化:拿不到锁=放弃本次,零损失。
    async fn start_speculation(&mut self, text: String) {
        // 吞句词不投机(codex 合同 §3.3「零 LLM」严格判据):急停/退出词的 interim 会先于
        // commit 触发 preflight→投机 LLM 白跑一次再被吞句分支作废——在源头跳过。
        if crate::textproc::is_stop_only(&self.cfg.hotwords, &text)
            || crate::textproc::is_stop_only(&self.cfg.exit_hotwords, &text)
        {
            info!(room = %self.room_name, "speculation skipped: swallow-word tail");
            return;
        }
        if let Some(old) = self.spec.take() {
            old.task.abort();
        }
        let Ok(llm_guard) = self.llm.try_lock() else {
            info!(room = %self.room_name, "speculation skipped: llm busy(回复流持锁中)");
            return;
        };
        let (client, cfg, messages, version) = llm_guard.speculation_request(&text);
        drop(llm_guard);
        let (tx, rx) = mpsc::channel::<String>(1024);
        let task = tokio::spawn(async move { llm::stream_chat(&client, &cfg, messages, tx).await });
        self.spec = Some(Speculation {
            text,
            version,
            started: Instant::now(),
            task,
            rx,
        });
    }

    /// B9 #3：ordered 模式 held final 到达即投机 LLM（RTC 路径的 preflight 在此模式旁路，故显式挂钩）。
    /// 文本 = 已 hold 的 final 拼接（与裁决合并口径同源）；commit 时 sp.text==user_text 且历史版本相同才消费。
    async fn on_ordered_final_held(&mut self) {
        if !self.cfg.ordered_spec_on_final {
            return;
        }
        let text = self.ordered.as_ref().map(|o| o.held_text()).unwrap_or_default();
        if text.trim().is_empty() {
            return;
        }
        info!(room = %self.room_name, chars = text.chars().count(), "ordered_pcm speculation on held final");
        self.start_speculation(text).await;
    }

    fn aec_active(&self, now: Instant) -> bool {
        self.aec_deadline.map(|d| now < d).unwrap_or(false)
    }

    async fn on_vad_frame(
        &mut self,
        gate: &VadGate,
        ev: VadEvent,
        active_frame: bool,
        eot_ring: &VecDeque<i16>,
    ) {
        let now = Instant::now();
        match ev {
            VadEvent::SpeechStart => {
                self.first_speech_onset_at.get_or_insert(now);
                self.turn_gate.on_speech_start();
                // v3.1 账本:停说 ≥ NEW_UTTERANCE_GAP 后再开口 = 新句;上一句若从未 commit(ASR 缺失),其芯片观测作孤儿(只诊断)
                let gate_has_pending = !self.turn_gate.pending().is_empty();
                for o in self.ledger.on_speech_start(now, gate_has_pending) {
                    info!(room = %self.room_name, label = o.label, action = %o.action, ownership = ?o.ownership,
                          candidate = %o.candidate.as_deref().unwrap_or("none"), "chip_obs_orphaned");
                }
                self.contract.user_speech_started();
                self.eot_gap_gen += 1;
                self.eot_requested = false;
                if let Some(s) = &mut self.snap {
                    s.event("speech_start", &[]);
                }
                // 用户开口:取消假打断定时(保留 paused);agent 未出声(thinking)则先按住
                self.false_deadline = None;
                if self.state != AgentState::Speaking
                    && self.paused.is_none()
                    && let Some(turn) = &self.agent_turn
                    && !turn.task.is_finished()
                {
                    turn.ctl.pause();
                    self.paused = Some(Duration::ZERO); // 停说即恢复,除非升格为真打断窗
                }
            }
            VadEvent::SpeechEnd => {
                self.turn_gate
                    .on_speech_end(now, Duration::from_secs_f32(gate.min_silence_s()));
                self.ledger
                    .on_speech_end(now.checked_sub(Duration::from_secs_f32(gate.min_silence_s())).unwrap_or(now));
                self.eot_requested = false;
                if let Some(timeout) = self.paused {
                    self.false_deadline = Some(now + timeout);
                }
                if let Some(s) = &mut self.snap {
                    s.event("speech_end", &[]);
                }
            }
            VadEvent::None => {}
        }
        if gate.speaking() {
            if active_frame && self.eot_requested {
                // 说话恢复:上一静音窗的预测作废(框架 cancel_inference 同款)
                self.eot_gap_gen += 1;
                self.eot_requested = false;
                self.turn_gate.on_speech_start();
            }
            if !active_frame && !self.eot_requested && gate.silence_dur_s() >= 0.2 {
                // 静音累积 ≥200ms:跑 EOT(每静音窗一次)。ring 采集关=1.2s/开=8s,
                // predict 内部恒取尾 1.2s(EOT_MAX_SAMPLES),判停行为与 ring 容量无关。
                self.eot_requested = true;
                let gap_gen = self.eot_gap_gen;
                let snapshot: Vec<i16> = eot_ring.iter().copied().collect();
                // 采集旁路:8s 窗落 wav + 触发点事件(seq↔gap_gen 对齐概率回包)
                if let Some(s) = &mut self.snap {
                    let seq = s.snapshot(&snapshot);
                    s.event("eot_request", &[
                        ("seq", &seq.map_or("capped".into(), |v| v.to_string())),
                        ("gap_gen", &gap_gen.to_string()),
                        ("silence_ms", &format!("{:.0}", f64::from(gate.silence_dur_s()) * 1000.0)),
                        ("speech_s", &format!("{:.2}", gate.speech_dur_s())),
                    ]);
                }
                let tx = self.eot_tx.clone();
                tokio::spawn(async move {
                    if let Some(c) = EotClient::global().await
                        && let Ok(p) = c.predict(&snapshot).await
                    {
                        let _ = tx.send((gap_gen, p)).await;
                    }
                });
            }
            if gate.speech_dur_s() >= self.cfg.min_interruption_duration {
                self.try_interrupt_by_audio(now);
            }
        }
    }

    fn on_interim(&mut self, t: String) {
        self.contract.user_transcript_interim();
        self.tr.user_interim(&t);
        self.tele_text = t.clone();
        let now_ms = self.now_ms();
        self.pf.on_interim(&t, now_ms);
        self.check_hotword(&t);
        self.latest_interim = t;
    }

    fn on_final(&mut self, t: String) {
        self.contract.user_transcript_final();
        self.tr.user_final(&t);
        self.tele_text = t.clone();
        self.pf.reset(); // definite 提交后,下个句段重新允许投机
        self.check_hotword(&t);
        self.turn_gate.on_final(&t, Instant::now());
        self.latest_interim.clear();
        if let Some(s) = &mut self.snap {
            s.event("user_final", &[("text", &self.tele_text)]);
        }
    }

    /// 急停白名单(P0):仅 agent 出声中触发;标准化精确命中 → 绕字数门硬打断。
    fn check_hotword(&mut self, text: &str) {
        if self.state != AgentState::Speaking || self.cfg.hotwords.is_empty() {
            return;
        }
        let norm = normalize_utterance(text);
        if self.cfg.hotwords.contains(&norm) {
            info!(room = %self.room_name, "急停白名单命中: '{norm}' → interrupt");
            self.hard_abort_current();
        }
    }

    /// 音频活动打断(框架 _interrupt_by_audio_activity):AEC 窗内禁;字数门;
    /// 过门 → pause + 假打断窗(已 pause 则升格 timeout)。
    fn try_interrupt_by_audio(&mut self, now: Instant) {
        if self.aec_active(now) {
            return;
        }
        if self.resume_grace.map(|g| now < g).unwrap_or(false) {
            return;
        }
        if self.cfg.min_interruption_words > 0 {
            let chars = self
                .turn_gate
                .pending()
                .chars()
                .chain(self.latest_interim.chars())
                .filter(|c| !c.is_whitespace())
                .count();
            if chars < self.cfg.min_interruption_words {
                return;
            }
        }
        let Some(turn) = &self.agent_turn else { return };
        if turn.task.is_finished() {
            return;
        }
        self.false_deadline = None;
        if self.paused.is_none() {
            turn.ctl.pause();
            self.paused = Some(self.cfg.false_interruption_timeout);
            self.set_state(AgentState::Listening);
        } else {
            // thinking-pause(timeout=0)升格为真打断窗
            self.paused = Some(self.cfg.false_interruption_timeout);
        }
    }

    // ── S2-B2 设备命令轮(合同 §4.3–4.5) ──

    /// 发布 device.command.proposed 并进入等待槽。合同要求:早于任何 filler/LLM/TTS。
    /// lane:L1=快路(词表/command_word) / L2=LLM 慢路(2b);candidate=L2 关联的硬件候选 ID(原样透传)。
    fn start_device_command(
        &mut self,
        cmd: crate::device_intent::DeviceCommand,
        user_text: &str,
        lane: &'static str,
        candidate: Option<String>,
        source: &'static str,
        utterance: Option<u64>,
    ) {
        let Some(trace) = self.device_trace.clone() else {
            // 无受信 trace(老 token/调试房)不发命令——与 input_ready 同纪律,fail-visible
            warn!(room = %self.room_name, "device command skipped: 无 trace,落回闲聊");
            return;
        };
        // v3.1 §1.1:每次提案消费一个轮次号(与对话轮共用计数器),保证「用户又说了一句」的同标签命令拿到不同幂等键
        // ——此前只有中间插了 Say 轮才推进,静默成功场景会复用旧键被端侧判 already_applied。
        let turn_id = self.next_turn_id + 1;
        self.next_turn_id = turn_id;
        let key = format!("voice:{}:{}:{}", self.room_name, turn_id, cmd.semantic_label);
        let relative = is_relative_action(cmd.action);
        let v = control::device_command_proposed(
            &trace,
            unix_ms_now(),
            &key,
            cmd.semantic_label,
            cmd.action,
            cmd.canonical_phrase,
            &cmd.normalized_text,
            cmd.match_type,
            lane,
            candidate.as_deref(),
            turn_id,
        );
        self.publish_json(control::DEVICE_CMD_TOPIC, v);
        // v3.1 账本:记录去重键(utterance + action + params + source);芯片在 commit 前的提案 utterance=None,commit 时归属
        self.ledger.record_proposal(utterance, cmd.action, "", source, Instant::now());
        // 合同 §8 结构化打点(llm_started/filler_started 恒 false 是命令轮硬约束的自证)
        info!(
            room = %self.room_name,
            trace_id = %trace,
            turn_id,
            asr_final_text_length = user_text.chars().count(),
            normalized_text_hash = %short_hash(&cmd.normalized_text),
            device_match = true,
            semantic_label = cmd.semantic_label,
            action = %cmd.action,
            match_type = %cmd.match_type,
            lane,
            candidate = %candidate.as_deref().unwrap_or("none"),
            command_publish_ts_ms = unix_ms_now(),
            llm_started = false,
            filler_started = false,
            "device command proposed: '{user_text}'"
        );
        if let Some(s) = &mut self.snap {
            s.event("device_command", &[("text", user_text), ("action", cmd.action)]);
        }
        self.pending_cmd = Some(PendingCmd {
            idempotency_key: key,
            action: cmd.action,
            relative,
            sent_at: Instant::now(),
            accepted_acked: false,
            lane,
        });
        // L1 路调用前已 hard_abort(无在播轮)→Thinking 照旧;L2 路回复仍在播→保持 Speaking
        // (否则向 Android 误发 speaking:false、急停白名单与打断判定全失效,2026-09-03 复盘)
        if self.agent_turn.is_none() {
            self.set_state(AgentState::Thinking);
        }
    }

    /// 2b:LLM 慢路意图落主循环。门序在 device_intent::l2_gate(纯函数);通过则以 L2 lane
    /// 复用快路的 proposal/result/短句链路。EXECUTE=0 时静默(task 内 observed 打点已代表)。
    fn on_l2_intent(&mut self, label: u32, user_text: &str, utterance: u64) {
        if !self.l2_execute_on {
            return;
        }
        let fast_path_pending = self.pending_cmd.is_some();
        let has_trace = self.device_trace.is_some();
        if let Err(reason) = crate::device_intent::l2_gate(
            self.l2_execute_on, self.l2_capable, label, fast_path_pending, has_trace,
        ) {
            info!(room = %self.room_name, label, reason, "llm device intent suppressed");
            // 2026-09-04(川哥拍板):不在首批的标签被压制时,LLM 回复常已自称「调好了」(003「画面调到5米」实证)
            // → 固定纠正句追加在回复之后(say_after_current);不教词表原句(TTS 念出=自触发风险)。
            if let Some(hint) =
                crate::device_intent::l2_fallback_hint(reason, label, fast_path_pending, has_trace)
            {
                info!(room = %self.room_name, label, reason, "llm device intent fallback hint queued");
                self.say_after_current(hint.to_string());
            }
            return;
        }
        let Some(mut cmd) = crate::device_intent::command_by_label(label) else {
            info!(room = %self.room_name, label, reason = "unknown_label", "llm device intent suppressed");
            return;
        };
        cmd.match_type = "llm";
        cmd.normalized_text = crate::device_intent::normalize(user_text);
        // v3.1 账本(R3):claimed / ignored / unknown 所有权对 L2 同样生效;同句芯片候选原样回传;
        // 被压制时同句候选槽一并消费,不留给后续误当可执行候选
        let candidate = match self.ledger.decide(utterance, cmd.action, "") {
            crate::device_ledger::Decision::Suppress(reason) => {
                info!(room = %self.room_name, label, reason, utterance, "llm device intent suppressed");
                return;
            }
            crate::device_ledger::Decision::Propose { candidate, mismatch_with, .. } => {
                if let Some((cl, ca)) = mismatch_with {
                    info!(room = %self.room_name, chip_label = cl, chip_action = %ca, asr_label = label,
                          asr_action = %cmd.action, suppress = false, "chip_asr_mismatch");
                }
                candidate
            }
        };
        // 候选关联只认账本(codex 复核 §3:旧槽会把已作废候选带回下一句);账本无同句候选 = None 交 Android 裁决
        info!(
            room = %self.room_name,
            label,
            lane = "L2",
            candidate = %candidate.as_deref().unwrap_or("none"),
            "llm device intent executed"
        );
        self.start_device_command(cmd, user_text, "L2", candidate, "llm", Some(utterance));
    }

    /// Android result 到达:key 对撞 → 终态播固定短句清槽;accepted 播「正在调整」延时限。
    /// `identity`=收包层已按绑定设备 participant 核验过的来源身份(job.rs),这里只记日志
    fn on_device_result(&mut self, r: control::DeviceResult, identity: Option<&str>) {
        if r.lane == "L0" {
            self.on_l0_result(r, identity);
            return;
        }
        let Some(p) = &mut self.pending_cmd else {
            info!(room = %self.room_name, key = %r.idempotency_key, status = %r.status, reason = %r.reason,
                  lane = %r.lane, extra = %r.extra, "迟到/无主 device result,忽略");
            return;
        };
        if p.idempotency_key != r.idempotency_key {
            info!(room = %self.room_name, key = %r.idempotency_key, status = %r.status, reason = %r.reason,
                  extra = %r.extra, "result key 与在途命令不符(旧轮迟到),忽略");
            return;
        }
        info!(
            room = %self.room_name,
            semantic_label = r.semantic_label,
            status = %r.status,
            reason = %r.reason,
            lane = %r.lane,
            extra = %r.extra,
            result_received_ts_ms = unix_ms_now(),
            "device command result"
        );
        // 2b 合同 v2 §2.5:Android 候选冲突裁决=静默(不播失败句,只记 suppress),清槽回听
        if is_silent_result(&r.status, &r.reason) {
            info!(room = %self.room_name, key = %r.idempotency_key, lane = %r.lane,
                  reason = "rejected:candidate_conflict", "llm device intent suppressed");
            self.pending_cmd = None;
            self.set_state(AgentState::Listening);
            return;
        }
        if r.status == "accepted" {
            // 已提交未回读(电机类):播一次「正在调整」,重置计时窗等终态
            let first = !p.accepted_acked;
            p.accepted_acked = true;
            p.sent_at = Instant::now();
            if first {
                self.say_after_current("好的，正在调整".to_string());
            }
            return;
        }
        let relative = p.relative;
        let action = p.action;
        let lane = p.lane;
        self.pending_cmd = None;
        // v3.1 §1.4/§3.6:端侧已开始本地播报 → worker 不补说(重复终态不重播)
        if r.spoken_locally == Some(true) {
            info!(room = %self.room_name, lane, clip = %r.spoken_clip_key, "device reply spoken locally, worker silent");
            return;
        }
        if success_reply_silent(&r.status, lane, self.agent_turn.is_some()) {
            info!(room = %self.room_name, lane, reason = %r.reason,
                  "device success reply skipped (LLM reply in flight already acknowledged)");
            return;
        }
        let reply = device_reply(&r.status, relative, &r.reason, action);
        self.say_after_current(reply);
    }

    /// v3.1 §3.4/§3.6:L0(芯片本地执行)result——无 pending 槽,按 key 去重(只记终态);accepted 不说;
    /// 端侧已开始播报不说;候选冲突静默;其余终态按同一话术表补说。ignored observation / UI 结果不是 result,不走这里。
    fn on_l0_result(&mut self, r: control::DeviceResult, identity: Option<&str>) {
        // codex R4 门序:绑定身份(收包层已验)→ active trace → source(vad_chip|fallback)→ action 非空且与 label 目录一致
        // → status 枚举(accepted 只诊断)→ (trace,key) 去重
        let action_valid = u32::try_from(r.semantic_label)
            .ok()
            .and_then(crate::device_intent::command_by_label)
            .is_some_and(|c| c.action == r.action);
        let gate = self.ledger.l0_check(
            self.device_trace.as_deref(),
            &r.trace_id,
            &r.idempotency_key,
            &r.source,
            &r.status,
            &r.action,
            action_valid,
        );
        info!(
            room = %self.room_name,
            semantic_label = r.semantic_label,
            action = %r.action,
            status = %r.status,
            reason = %r.reason,
            lane = "L0",
            source = %r.source,
            identity = identity.unwrap_or("-"),
            spoken_locally = ?r.spoken_locally,
            clip = %r.spoken_clip_key,
            execution_ms = ?r.execution_ms,
            mcu_tx_count = ?r.mcu_tx_count,
            steps_done = ?r.steps_done,
            boundary_basis = %r.boundary_basis,
            gate = ?gate,
            extra = %r.extra,
            result_received_ts_ms = unix_ms_now(),
            "device command result"
        );
        if let crate::device_ledger::L0Outcome::Silent(reason) = gate {
            info!(room = %self.room_name, key = %r.idempotency_key, reason, "L0 result 不播报");
            return;
        }
        if r.spoken_locally == Some(true) || is_silent_result(&r.status, &r.reason) {
            return;
        }
        let reply = device_reply(&r.status, is_relative_action(&r.action), &r.reason, &r.action);
        self.say_after_current(reply);
    }

    /// v3.1 账本轮询:无语音活动时未归属的芯片观测超时 → 诊断(deferred 电机=chip_candidate_unconfirmed),不改决策
    fn poll_ledger(&mut self, now: Instant) {
        for o in self.ledger.poll(now) {
            if o.ownership == crate::device_ledger::Ownership::DeferredWaitAsr {
                info!(room = %self.room_name, label = o.label, action = %o.action,
                      candidate = %o.candidate.as_deref().unwrap_or("none"), "chip_candidate_unconfirmed");
            } else {
                info!(room = %self.room_name, label = o.label, action = %o.action, ownership = ?o.ownership, "chip_obs_orphaned");
            }
        }
    }

    /// 2b 合同 v2 §3.4:设备短句**追加**在 LLM 回复之后——回复在播就压进槽等 PlayedOut,空闲则立刻说。
    /// (M1 实证:回复在播时直接开新 Say 轮会与在播轮抢音频源,`capture_frame InvalidState`,短句丢、回复截)
    fn say_after_current(&mut self, text: String) {
        match self.deferred_say.offer(self.agent_turn.is_some(), text) {
            Some(t) => self.start_turn(TurnKind::Say(t)),
            None => info!(room = %self.room_name, "device reply deferred until current turn plays out"),
        }
    }

    /// 兜底超时(Android 整个没回;它自身的 timeout status 是另一层)。
    fn poll_device_timeout(&mut self, _now: Instant) {
        let Some(p) = &self.pending_cmd else { return };
        let limit = if p.accepted_acked {
            DEVICE_RESULT_DEADLINE * 3 // accepted 后放宽(电机行程),守恒默认 24s
        } else {
            DEVICE_RESULT_DEADLINE
        };
        if p.sent_at.elapsed() > limit {
            warn!(
                room = %self.room_name,
                key = %p.idempotency_key,
                accepted = p.accepted_acked,
                "device result 兜底超时,播失败句"
            );
            self.pending_cmd = None;
            self.say_after_current("暂时没能确认调整结果".to_string());
        }
    }

    /// 处理设备下发的控制包。cancel 走**硬 abort**(川哥 2026-08-15 拍板):
    /// 用户明确按了停,不进 pause+假打断窗口,不等 1.5s 定时器判断是不是说错话。
    async fn on_control(
        &mut self,
        ev: &control::Envelope,
        kind: control::Inbound,
        identity: Option<&str>,
    ) {
        match kind {
            control::Inbound::CanarySay => self.on_canary_say(ev, identity),
            // command_word(2026-08-18 晚合同):VAD 芯片 label 经 Android 转发,
            // 补早说空窗——事件可先于 input_ready 到达(control 通道在 job 层缓冲,
            // pipeline 起后消费,天然满足)。决策日志四态:accepted/duplicate/rejected。
            // (expired=会话已关,包无处投递,由 job 生命周期结构保证)
            control::Inbound::CommandWord { label, before_ready, candidate_id, local_action, ignore_reason } => {
                let now = Instant::now();
                // 2b:候选 ID 先于 commit 到达,记为本 turn 候选(L2 proposal 发出时消费)
                let has_candidate = candidate_id.is_some();
                // v3.1:芯片决策纯函数(device_intent::chip_decision 单测锁死矩阵):
                // 合同 <3 / 缺字段 / 未知值 → 旧策略;合同 ≥3 → claimed 不提案 / ignored 不提案 / 电机 deferred 等 ASR
                let cmd = crate::device_intent::command_by_label(label);
                let (chip, chip_reason) = crate::device_intent::chip_decision(
                    self.contract_version,
                    local_action.as_deref(),
                    label,
                    cmd.is_some(),
                );
                let mut decision = "rejected";
                let mut reason: &str = chip_reason;
                if !self.device_commands_on {
                    reason = "commands_disabled_or_not_canary";
                } else if let Some(cmd) = cmd {
                    use crate::device_intent::ChipDecision as D;
                    use crate::device_ledger::{ChipOutcome, Ownership};
                    match chip {
                        D::Propose => {
                            // 2026-09-06 v230 灯控实证:在播/播完窗内到达的芯片候选先过回声门——不提案、不 abort,
                            // 记为等 ASR 的候选(同句真人 ASR/LLM 命中才执行,候选 ID 原样回传);芯片永远不是 abort 的发起者。
                            let playing = self.agent_turn.is_some();
                            let in_window = self
                                .echo_playout_end
                                .is_some_and(|t| t.elapsed() <= self.cfg.echo_suppress_window);
                            if self.cfg.chip_playback_hold && (playing || in_window) {
                                let spoken = crate::device_intent::normalize(&self.recent_spoken_text(playing, in_window));
                                let echo_suspect = crate::device_intent::spoken_contains_label_phrase(&spoken, label);
                                let since_ms = self.echo_playout_end.map(|t| t.elapsed().as_millis() as i64).unwrap_or(-1);
                                let _ = self.ledger.on_chip(label, cmd.action, Ownership::DeferredWaitAsr, candidate_id.clone(), now);
                                decision = "held_wait_asr";
                                reason = if echo_suspect { "playback_window_echo_suspect" } else { "playback_window" };
                                info!(room = %self.room_name, trace_id = %ev.trace_id, semantic_label = label, playing,
                                      since_playout_ms = since_ms, echo_suspect, "chip candidate held in playback window");
                            } else {
                                // 旧策略(合同 2 / deferred 灯光音量):账本按语音段归属去重,候选 ID 原样带上(R3)
                                match self.ledger.on_chip(label, cmd.action, Ownership::Proposed, candidate_id.clone(), now) {
                                    ChipOutcome::ProposeNow { candidate, utterance } => {
                                        decision = "accepted";
                                        if self.agent_turn.is_some() {
                                            self.hard_abort_current();
                                        }
                                        if let Some(sp) = self.spec.take() {
                                            sp.task.abort();
                                        }
                                        self.start_device_command(cmd, &format!("[vad_label_{label}]"), "L1", candidate, "chip", utterance);
                                    }
                                    ChipOutcome::Duplicate => {
                                        decision = "duplicate";
                                        reason = "same_utterance_already_proposed";
                                    }
                                    ChipOutcome::Held => {}
                                }
                            }
                        }
                        D::Claimed => {
                            // v3.1 §1.4:端侧已认领(所有权≠物理成功),worker 不提案;同句 ASR/LLM 由账本压制
                            decision = "claimed";
                            let _ = self.ledger.on_chip(label, cmd.action, Ownership::Claimed, candidate_id.clone(), now);
                        }
                        D::DeferredWaitAsr => {
                            // v3.1 §1.2:白名单外电机——只作候选,等同句 ASR/LLM 独立命中(命中时候选原样回传)
                            decision = "deferred_wait_asr";
                            let _ = self.ledger.on_chip(label, cmd.action, Ownership::DeferredWaitAsr, candidate_id.clone(), now);
                        }
                        D::Ignored => {
                            decision = "ignored";
                            let _ = self.ledger.on_chip(label, cmd.action, Ownership::Ignored, candidate_id.clone(), now);
                        }
                        D::OwnershipUnknown => {
                            // codex R2:合同 3 所有权缺失/非法 → fail-closed,同句 ASR/LLM 也不提案
                            decision = "ownership_unknown";
                            let _ = self.ledger.on_chip(label, cmd.action, Ownership::Unknown, candidate_id.clone(), now);
                        }
                        D::NotInCatalog => {}
                    }
                }
                info!(
                    room = %self.room_name,
                    trace_id = %ev.trace_id,
                    semantic_label = label,
                    before_ready,
                    has_candidate,
                    local_action = local_action.as_deref().unwrap_or("-"),
                    ignore_reason = ignore_reason.as_deref().unwrap_or("-"),
                    contract_version = self.contract_version,
                    decision,
                    reason,
                    proposal_emitted = (decision == "accepted"),
                    "command_word 决策"
                );
            }
            control::Inbound::Capability { contract_version } => {
                // 2b 合同 v2 §2.1:wake 包能力声明,room 级保存;<2=只观察不发 L2
                self.l2_capable = contract_version >= 2;
                self.contract_version = contract_version;
                info!(room = %self.room_name, trace_id = %ev.trace_id, contract_version,
                      l2_capable = self.l2_capable, v31_chip_semantics = contract_version >= 3, "l2 capability");
            }
            control::Inbound::Bypass => {
                // 芯片唤醒/VAD/命令词:只记录,**绝不改变 worker 的 turn 判定**。
                // worker 持有完整音频流,判停与打断以它为权威(合同 §5.3)。
                info!(room = %self.room_name, trace_id = %ev.trace_id, kind = %ev.kind,
                      "control 旁路事件(不影响主链路)");
            }
            control::Inbound::SessionExitAck => {
                // v140 §4.3:同 seq ACK=终态,停重试。accepted/already_done 只记日志。
                let matched = self.exit_pending.as_ref().is_some_and(|p| p.seq == ev.seq);
                if matched {
                    self.exit_pending = None;
                }
                info!(room = %self.room_name, trace_id = %ev.trace_id, seq = ev.seq, matched,
                    accepted = ev.payload.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false),
                    already_done = ev.payload.get("already_done").and_then(|v| v.as_bool()).unwrap_or(false),
                    "session_exit ack received");
            }
            control::Inbound::Cancel => {
                // One-shot v0.3:显式取消对有序 PCM 代次立即生效(唯一终态;已 hold 的 final 作废;收流经 pending 标志传导)
                if self.ordered.is_some() {
                    let acts = self.ordered.as_mut().map(|o| o.fail(crate::ordered_pcm::FailReason::Cancelled)).unwrap_or_default();
                    self.apply_ordered_actions(acts);
                }
                // v140 §4.3:Android 本地 exact 先命中会先发既有 cancel——cancel 亦为退出
                // 信令终态,停重试(不得形成重试风暴)。
                if self.exit_pending.take().is_some() {
                    info!(room = %self.room_name, "session_exit signal terminated by cancel");
                }
                let first = self.ctrl_dedup.first_time(&ev.trace_id, ev.seq);
                // 有在说的 turn 才谈得上"取消";没有则 cancelled=false 但不报错
                let had_turn = self.agent_turn.is_some();
                let cancelled = first && had_turn;
                if cancelled {
                    self.hard_abort_current();
                    self.set_state(AgentState::Listening);
                }
                info!(room = %self.room_name, trace_id = %ev.trace_id, seq = ev.seq,
                      cancelled, already_done = !first, had_turn,
                      "control cancel");
                self.publish_json(
                    control::TOPIC,
                    control::cancel_ack(
                        &ev.trace_id,
                        ev.seq,
                        self.now_ms() as i64,
                        cancelled,
                        !first,
                    ),
                );
            }
        }
    }

    /// canary.say(S2B1 联调):校验链顺序=开关/白名单 → 文本 → 时钟偏差 → 幂等 → 忙。
    /// 只有真正启动 turn 才落幂等表——被拒的 seq 必须可重试。
    /// 完整文本绝不进日志(只打 test_id 与字符数)。
    fn on_canary_say(&mut self, ev: &control::Envelope, identity: Option<&str>) {
        // ⚠️ 必须用 epoch 毫秒:包内 ts_ms 是设备的 epoch 时间,而 self.now_ms()
        // 是 pipeline 启动起算的单调毫秒——拿它比对会恒判 stale(2026-08-16 E2E 实证)。
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let allowed = self.cfg.canary_say_enabled
            && identity
                .map(|i| self.cfg.canary_identity_allow.iter().any(|a| a == i))
                .unwrap_or(false);
        let test_id = ev
            .payload
            .get("test_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let text = ev
            .payload
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let chars = text.chars().count();

        let reject = |o: &Self, accepted: bool, already: bool, reason: &str| {
            info!(room = %o.room_name, trace_id = %ev.trace_id, seq = ev.seq,
                  test_id = %test_id, identity = identity.unwrap_or("-"),
                  text_chars = chars, accepted, reason, "canary.say rejected/acked");
            o.publish_json(
                control::TOPIC,
                control::canary_say_ack(&ev.trace_id, ev.seq, ts, accepted, already, reason),
            );
        };
        if !allowed {
            return reject(self, false, false, "disabled");
        }
        if test_id.is_empty() || chars == 0 || chars > control::CANARY_TEXT_MAX {
            return reject(self, false, false, "invalid_text");
        }
        if ev.ts_ms > 0 && (ts - ev.ts_ms).abs() > control::CANARY_STALE_SKEW_MS {
            return reject(self, false, false, "stale_trace");
        }
        if self.canary_dedup.seen(&ev.trace_id, ev.seq) {
            return reject(self, true, true, "already_done");
        }
        if self.agent_turn.is_some() || self.canary_pending.is_some() {
            return reject(self, false, false, "already_running");
        }

        self.canary_dedup.first_time(&ev.trace_id, ev.seq);
        self.start_turn(TurnKind::Say(text.to_string()));
        let Some(turn) = self.agent_turn.as_ref() else {
            // start_turn 失败不该发生;发生了宁可不留 pending,也不能让 metrics 悬空
            warn!(room = %self.room_name, "canary.say start_turn 后 turn 缺失");
            return;
        };
        self.canary_pending = Some(CanaryPending {
            test_id: test_id.clone(),
            trace_id: ev.trace_id.clone(),
            seq: ev.seq,
            turn_id: turn.id,
            stats: turn.ctl.final_stats_handle(),
        });
        info!(room = %self.room_name, trace_id = %ev.trace_id, seq = ev.seq,
              test_id = %test_id, text_chars = chars, turn_id = turn.id,
              "canary.say accepted, formal say turn started");
        self.publish_json(
            control::TOPIC,
            control::canary_say_ack(&ev.trace_id, ev.seq, ts, true, false, "ok"),
        );
    }

    /// 终态就绪(播完或取消,BufferWatch Drop 已写槽)→ 发一次 final metrics。
    /// PlayedOut 时立即调;on_tick 兜底(cancel 场景的 Drop 是异步的,晚到几十 ms)。
    fn try_flush_canary_metrics(&mut self) {
        let Some(p) = &self.canary_pending else {
            return;
        };
        let Some(fs) = p.stats.lock().ok().and_then(|g| g.clone()) else {
            return;
        };
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let msg =
            control::canary_metrics(&p.trace_id, p.seq, epoch_ms, &p.test_id, &fs);
        info!(room = %self.room_name, test_id = %p.test_id, turn_id = p.turn_id,
              audio_duration_ms = fs.played_frames * 10,
              underrun_count = fs.underrun_count, underrun_ms = fs.underrun_ms,
              buffered_audio_ms = fs.buffered_audio_ms, played_frames = fs.played_frames,
              completed = fs.completed, "canary.say final metrics sent");
        self.publish_json(control::TOPIC, msg);
        self.canary_pending = None;
    }

    /// 硬打断:杀任务+清播放队列+历史截断为真实播出部分(暂存,下轮 LLM 请求前落账)。
    /// 最近播出文本(回声对撞库):播完窗内=上一轮实际播出文本;在播=当前 filler + 已合成正文。
    /// ASR 回声门与芯片候选回声嫌疑诊断共用同一份,判据不分叉。
    fn recent_spoken_text(&self, playing: bool, in_window: bool) -> String {
        let mut recent = String::new();
        if in_window {
            recent.push_str(&self.echo_tts_text);
        }
        if playing {
            recent.push('\n');
            recent.push_str(&self.echo_cur_filler);
            if let Some(turn) = &self.agent_turn
                && let Ok(t) = turn.synth_text.lock()
            {
                recent.push_str(&t);
            }
        }
        recent
    }

    fn hard_abort_current(&mut self) {
        if self.deferred_say.clear_on_abort() {
            info!(room = %self.room_name, "deferred device reply dropped (turn aborted)");
        }
        let Some(turn) = self.agent_turn.take() else {
            return;
        };
        let played = turn.ctl.played_samples();
        turn.ctl.abort();
        turn.task.abort();
        self.source.clear_buffer();
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        let spoken = truncate_spoken(&synth, &progress, played);
        // 字幕:在播句按截断文本收尾 final(Python flush 已推送部分同义)
        self.tr_flush_on_abort(turn.id, &synth, &progress, &spoken, played);
        info!(
            room = %self.room_name,
            played_samples = played,
            synth_chars = synth.chars().count(),
            spoken_chars = spoken.chars().count(),
            "agent turn aborted, history truncated to spoken part"
        );
        // 回声对撞:被打断时只有 spoken 部分出了喇叭(截断文本),连同 filler 进对撞缓冲
        self.echo_tts_text = format!("{}{spoken}", self.echo_cur_filler);
        self.echo_playout_end = Some(Instant::now());
        self.pending_amend = Some(spoken);
        self.paused = None;
        self.false_deadline = None;
        self.set_state(AgentState::Listening);
    }

    /// 字幕逐句推进:句进入播出 → interim(整句);句播完 → final。50ms tick 驱动。
    fn publish_agent_progress(&mut self) {
        let Some(turn) = &self.agent_turn else { return };
        if !turn.ctl.audio_started() {
            return;
        }
        let played = turn.ctl.played_samples();
        let turn_id = turn.id;
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        for (i, span) in sentence_spans(&synth, &progress).iter().enumerate() {
            if i >= self.tr_started && played >= span.start_samples {
                self.tr.agent_segment(turn_id, i, &span.text, false);
                self.tr_started = i + 1;
            }
            if i >= self.tr_finaled && played >= span.end_samples {
                self.tr.agent_segment(turn_id, i, &span.text, true);
                self.tr_finaled = i + 1;
            }
        }
    }

    /// B 观测(2026-09-09 codex §4):同一 worker 钟记「filler 实际播完」与「正文首帧发布」(50 ms tick 分辨率),
    /// 只加日志;无 filler 的轮不记,正文未到不伪造。gap = 两行 since_turn_ms 之差(与 playout underrun 对账)。
    fn log_playout_segments(&mut self) {
        let room = self.room_name.clone();
        let Some(turn) = self.agent_turn.as_mut() else { return };
        if turn.filler_samples == 0 || turn.seg_stage >= 2 || !turn.ctl.audio_started() {
            return;
        }
        let played = turn.ctl.played_samples();
        if turn.seg_stage == 0 && played >= turn.filler_samples {
            turn.seg_stage = 1;
            info!(room = %room, turn_id = turn.id, filler_ms = turn.filler_samples / 24,
                  since_turn_ms = turn.started.elapsed().as_millis() as u64, "filler playout done");
        }
        if turn.seg_stage == 1 && played > turn.filler_samples {
            turn.seg_stage = 2;
            info!(room = %room, turn_id = turn.id, played_samples = played,
                  since_turn_ms = turn.started.elapsed().as_millis() as u64, "body first frame published");
        }
    }

    /// 打断收尾:已播完句补 final,在播句发截断部分 final,未开播句不发。
    fn tr_flush_on_abort(
        &mut self,
        turn_id: u64,
        synth: &str,
        progress: &[(usize, u64)],
        spoken: &str,
        played: u64,
    ) {
        let spoken_chars = spoken.chars().count();
        for (i, span) in sentence_spans(synth, progress).iter().enumerate() {
            if i < self.tr_finaled {
                continue;
            }
            if played >= span.end_samples {
                self.tr.agent_segment(turn_id, i, &span.text, true);
                self.tr_finaled = i + 1;
            } else if played > span.start_samples && spoken_chars > span.char_start {
                let partial: String = spoken.chars().skip(span.char_start).collect();
                self.tr.agent_segment(turn_id, i, &partial, true);
                self.tr_finaled = i + 1;
                break;
            } else {
                break;
            }
        }
    }

    /// 自然播完收尾:剩余未 final 的句(含 tick 竞态漏发的)全文补 final。
    fn tr_finish_turn(&mut self) {
        let Some(turn) = &self.agent_turn else { return };
        let turn_id = turn.id;
        let synth = turn
            .synth_text
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let progress = turn.progress.lock().map(|p| p.clone()).unwrap_or_default();
        let spans = sentence_spans(&synth, &progress);
        for (i, span) in spans.iter().enumerate() {
            if i >= self.tr_finaled {
                self.tr.agent_segment(turn_id, i, &span.text, true);
            }
        }
        self.tr_started = spans.len();
        self.tr_finaled = spans.len();
    }

    fn on_turn_event(&mut self, te: TurnEvent) {
        match te {
            TurnEvent::DevIntent { label, text, turn_id, utterance } => {
                // codex 复核 §2:旧 turn 的事件在新句后才被消费 → 丢弃,不按「当前」轮次查账
                let active = self.agent_turn.as_ref().map(|t| t.id);
                if let Err(reason) = crate::device_ledger::l2_event_gate(turn_id, utterance, active, self.ledger.current_utterance()) {
                    info!(room = %self.room_name, label, turn_id, utterance, active_turn = ?active,
                          current_utterance = self.ledger.current_utterance(), reason, "llm device intent dropped (stale event)");
                    return;
                }
                self.on_l2_intent(label, &text, utterance);
            }
            TurnEvent::AudioStarted(id) => {
                if self.agent_turn.as_ref().map(|t| t.id) != Some(id) {
                    return; // 已被替换的旧 turn,忽略
                }
                self.set_state(AgentState::Speaking);
                // AEC warmup:首次开口起 one-shot(框架同款,窗口内禁音频路打断)
                if !self.aec_armed {
                    self.aec_armed = true;
                    self.aec_deadline = Some(Instant::now() + self.cfg.aec_warmup_duration);
                    info!(room = %self.room_name, "aec warmup active, disabling interruptions for {:.2}s",
                        self.cfg.aec_warmup_duration.as_secs_f32());
                }
            }
            TurnEvent::PlayedOut(id) => {
                if self.agent_turn.as_ref().map(|t| t.id) != Some(id) {
                    return;
                }
                self.tr_finish_turn(); // 字幕:剩余句补 final(先于清 turn)
                // 回声对撞:自然播完=filler+全文都出了喇叭,整段进对撞缓冲(必须在清 turn 前取)
                if let Some(turn) = &self.agent_turn {
                    let synth = turn.synth_text.lock().map(|s| s.clone()).unwrap_or_default();
                    self.echo_tts_text = format!("{}{synth}", self.echo_cur_filler);
                    self.echo_playout_end = Some(Instant::now());
                }
                self.agent_turn = None; // 任务已自然结束
                // canary turn:Say 块里 playout_task.await 先于 PlayedOut,终态必已定格
                self.try_flush_canary_metrics();
                self.paused = None;
                self.false_deadline = None;
                self.contract.agent_transcript_final();
                // 自然播完≠被插话:清残留 interim,否则 set_state 的 speaking→listening
                // 会把它当"真插话"记 last_interrupt_at → 播完后 5s 内的下一轮全被误判
                // boost,barge 桶文案落在非打断语境(2026-08-16「先你的。」实证)
                self.tele_text.clear();
                self.set_state(AgentState::Listening);
                // 2b §3.4:回复播完 → 追加设备短句(若 result 已到而当时回复在播)
                if let Some(t) = self.deferred_say.take_on_played_out() {
                    info!(room = %self.room_name, "device reply appended after turn played out");
                    self.start_turn(TurnKind::Say(t));
                }
            }
        }
    }

    async fn on_tick(&mut self) {
        // One-shot v0.3:有序 PCM 代次超时(begin 后无 end)→ 整代失败终态
        if self.ordered.is_some() {
            let now_ms = unix_ms_now();
            let acts = self.ordered.as_mut().map(|o| o.on_tick(now_ms)).unwrap_or_default();
            self.apply_ordered_actions(acts);
        }
        // cancel 掉的 canary:turn.task.abort() 后 BufferWatch Drop 异步落槽,tick 兜底补发
        self.try_flush_canary_metrics();
        let now = Instant::now();
        // v140 §4.3:退出信令 800ms 无终态同 seq 重发,至多 3 发后放弃(不得重试风暴;
        // Android 侧 ACK 预算 750ms,800ms 给足单程+处理)。room close 由 job 收尾天然终止。
        if let Some(pend) = &mut self.exit_pending {
            if now.duration_since(pend.sent_at) >= Duration::from_millis(800) {
                if pend.attempts >= 3 {
                    info!(room = %self.room_name, seq = pend.seq,
                        "session_exit signal gave up (no terminal after 3 attempts)");
                    self.exit_pending = None;
                } else {
                    pend.attempts += 1;
                    pend.sent_at = now;
                    let env = pend.envelope.clone();
                    let (seq, attempt) = (pend.seq, pend.attempts);
                    self.publish_json(control::TOPIC, env);
                    info!(room = %self.room_name, seq, attempt, "session_exit signal retry (same seq)");
                }
            }
        }
        // 字幕逐句推进(按播出位置;pause 时 played 冻结自然停发)
        self.publish_agent_progress();
        self.log_playout_segments();
        // 假打断定时:超时无 turn → resume 续播(渐起由 playout 配置)+ 契约 FalseInterruption
        if let Some(dl) = self.false_deadline
            && now >= dl
        {
            self.false_deadline = None;
            if self.paused.take().is_some() {
                if let Some(turn) = &self.agent_turn
                    && !turn.task.is_finished()
                {
                    turn.ctl.resume();
                    self.resume_grace = Some(now + Duration::from_millis(250));
                    self.set_state(AgentState::Speaking);
                    info!(room = %self.room_name, "resumed false interrupted speech");
                }
                self.contract.false_interruption();
            }
        }
        // 判停提交
        if let Some(commit) = self.turn_gate.poll_commit(now) {
            let user_text = commit.text;
            self.user_commit_count += 1;
            // 本地音频回声对撞(2026-09-01「刚打了个盹儿」幽灵轮,招呼语回声第三次实证):
            // 开场窗内 commit 若模糊命中该设备本地招呼语文案(LCS≥0.8,回声只掉字不加字:
            // 「刚打了个盹儿」掉头、「我在这等你呢」掉中间,严格子串只兜得住前者)→判回声
            // 丢弃,不成 turn。位置在全部吞句/退出判定之前——「这句不是用户说的」优先于
            // 一切语义判定。len≥4 门:急停/短应答交给原有链路,不进对撞(greeting 生成门
            // 本就禁急停/命令/退出词,双保险)。误伤代价=该轮沉默,不误退出不误命令。
            if !self.cfg.local_audio_echo_window.is_zero()
                && self.session_started_at.elapsed() <= self.cfg.local_audio_echo_window
            {
                let nu = normalize_echo(&user_text);
                let n_chars = nu.chars().count();
                // 分层判定(≥4字 LCS / 2-3字精确子串)抽在 textproc,锚测试全覆盖。
                // 2026-09-01 00:53 实证:EOU 把回声切成「来啦」(2字)+「刚打了个盹儿」,
                // 后者被拦、前者穿过旧 len≥4 下限起了幽灵轮——短碎片层由此补上。
                // 01:00 实证第二形态:「来啦」被 ASR 错转成「那」(la→na)——子串判定对
                // 错转结构性无效,故开场窗内**单字 commit 一律吞**:EOU+错转可产出任意单字,
                // 开场窗内单字成句语义≈0(急停单字在此被吞与 stop_only 效果等价:都不成 turn)。
                let hit = if n_chars == 1 {
                    Some("single-char".to_string())
                } else {
                    let bank = self.echo_local_texts.lock().unwrap();
                    crate::textproc::local_audio_echo_hit(&nu, &bank).map(str::to_string)
                };
                if let Some(slot) = hit {
                    info!(room = %self.room_name, slot = %slot,
                        "local-audio echo suppressed (opening window): '{user_text}'");
                    // 追杀(01:00 实证):错转碎片(「那」)若已在本门上一轮穿门起了幽灵轮,
                    // 此刻后续碎片被确认为回声=前 2s 内那个短 commit 也是回声,撤销在途轮止损。
                    if let Some(t0) = self.echo_short_turn_at
                        && t0.elapsed() < Duration::from_secs(2)
                        && self.agent_turn.is_some()
                    {
                        self.hard_abort_current();
                        info!(room = %self.room_name, "local-audio echo chase-abort: ghost turn from short fragment");
                    }
                    self.echo_short_turn_at = None;
                    self.latest_interim.clear();
                    self.tele_text.clear();
                    if let Some(s) = &mut self.snap {
                        s.event("swallowed", &[("text", &user_text), ("kind", "local_audio_echo"), ("path", &slot)]);
                    }
                    return;
                }
                // 开场重叠窗放宽门(2026-09-06 0006 实证,详见 textproc::local_audio_echo_overlap_hit):动态招呼语
                // 2.1–2.8 s 长过 wake→input_ready(~1.8 s),尾巴被 ASR 听到并错转成「我想啊怎么了」「不行了」,
                // LCS 0.5/0.33 穿过 0.8 门→幽灵轮/打断在播回复。以「这句说完时招呼语可能还没播完」为时间锚
                // (建房秒≈唤醒 + 最长招呼语 + 余量),锚内 ≥2 字 LCS≥0.3 判回声;命令词/急停/退出词不进此门。
                // 普适判据 v4(2026-09-07 真机实证,不按 SN/APK 版本特判):只有「本会话第 1 句」且「commit 前从未出现
                // VAD 起点」才进放宽分支。昨日两条真实幽灵句 journal 无 UserSpeechStarted(招呼语尾巴电平低于 VAD 门,
                // 只有 ASR 转出 final);今早三句真人话起点 +51/+104/+674ms 全触发 VAD——有 VAD 起点=真人,一律不进。
                // v3「起点 ≤450ms」判据方向反了(真人早开口就命中,幽灵句永不命中),已废。
                let vad_onset_seen = self.first_speech_onset_at.is_some();
                let since_loop_ms = self.input_loop_started_at.map(|l| l.elapsed().as_millis() as i64).unwrap_or(-1);
                if let Some(deadline) = self.opening_overlap_deadline_ms
                    && self.user_commit_count == 1
                    && crate::textproc::overlap_vadless_qualifies(vad_onset_seen)
                {
                    let speech_end_ms = unix_ms_now() - commit.eou_delay.as_millis() as i64;
                    if speech_end_ms <= deadline
                        && crate::device_intent::match_command(&user_text).is_none()
                        && !crate::textproc::is_stop_only(&self.cfg.hotwords, &user_text)
                        && crate::textproc::session_exit_tail_hit(&user_text).is_none()
                    {
                        let overlap = {
                            let bank = self.echo_local_texts.lock().unwrap();
                            crate::textproc::opening_overlap_decision(Some(deadline), speech_end_ms, vad_onset_seen, &nu, &bank).map(|(slot, r)| (slot.to_string(), r))
                        };
                        if let Some((slot, ratio)) = overlap {
                            info!(room = %self.room_name, slot = %slot, lcs = ratio,
                                  before_deadline_ms = deadline - speech_end_ms, vad_onset_seen, since_loop_ms,
                                  "local-audio echo suppressed (opening overlap): '{user_text}'");
                            self.echo_short_turn_at = None;
                            self.latest_interim.clear();
                            self.tele_text.clear();
                            if let Some(s) = &mut self.snap {
                                let path = format!("overlap:{slot}");
                                s.event("swallowed", &[("text", &user_text), ("kind", "local_audio_echo"), ("path", &path)]);
                            }
                            return;
                        }
                    }
                }
                // 对撞 miss 的短 commit(≤3字)打标:若它其实是错转回声碎片并起了幽灵轮,
                // 紧随的后续碎片命中时按上方追杀逻辑撤销。真人短句不受影响(无后续命中=标过期)。
                if n_chars <= 3 {
                    self.echo_short_turn_at = Some(Instant::now());
                }
            }
            // v3.1 账本(R1):开新说话轮次,把语音段区间内的芯片观测归到本句;区间外 = 上一句没有 ASR 的孤儿(只诊断)。
            // ⚠️ 必须放在本地音频回声丢弃之后(2026-09-05 12:28 003 实证):回声 commit(设备自己的「我在呢」)不是
            // 用户的一句话,若先走 on_commit 会把轮次号和芯片观测一起吃掉,随后真正的「暗一点」提交被当成新句
            // → 芯片提案 + ASR 提案各一次 → 端侧 hardware_busy。急停/退出吞句是真句,消费轮次无妨。
            let commit_rep = self.ledger.on_commit(now, commit.eou_delay);
            for o in &commit_rep.orphans {
                if o.ownership == crate::device_ledger::Ownership::DeferredWaitAsr {
                    info!(room = %self.room_name, utterance = commit_rep.utterance, label = o.label, action = %o.action,
                          candidate = %o.candidate.as_deref().unwrap_or("none"), "chip_candidate_unconfirmed");
                } else {
                    info!(room = %self.room_name, utterance = commit_rep.utterance, label = o.label, action = %o.action,
                          ownership = ?o.ownership, "chip_obs_orphaned");
                }
            }
            // stop_only 吞句(2026-08-17 生命周期统一):整句=急停词 → 不成 turn,静默。
            // 否则「停」硬停旧回答后 ~43ms 又被 commit 给 LLM,起了带 barge filler 的
            // 回答轮(02:54 真机实证,当时靠 Android 泛化 vad_no_asr cancel 巧合补刀;
            // 该泛化 cancel 按生命周期合同删除后无人兜底)。契约链上该句只有
            // UserTranscriptFinal 无 UserTurnCommitted——即「这句没发生」。
            let swallow_kind = if crate::textproc::is_stop_only(&self.cfg.hotwords, &user_text) {
                Some(("stop_only", "exact"))
            } else if crate::textproc::is_stop_only(&self.cfg.exit_hotwords, &user_text) {
                // 退出词吞句(2026-08-17 川哥拍板):trace 88185b1e 实证「退出」被 commit
                // 起幽灵回答轮(filler 入轨+LLM 回 2 字),79ms 后才被 Android cancel 杀——
                // 预测式判停必然抢先 cancel,竞态改确定性。Worker 只吞轮次;
                // 退出回复/关房 100% 归 Android(退出权威不变)。
                Some(("session_exit", "exact"))
            } else if self.cfg.exit_tail_match {
                // A 案(2026-08-28「不想聊了，退出吧」漏网实证):自然复合句对整句精确匹配
                // 结构性免疫→尾部强意图词匹配,否定/疑问豁免见 textproc。语义与 exact 同=只吞。
                // path 分桶(v140 §2):碎片词(不想聊/不想聊天)=fragment,复合句尾部命中=tail。
                match crate::textproc::session_exit_tail_hit(&user_text) {
                    Some(w) if crate::textproc::is_fragment_exit_word(w) => {
                        Some(("session_exit", "fragment"))
                    }
                    Some(_) => Some(("session_exit", "tail")),
                    None => None,
                }
            } else {
                None
            };
            if let Some((kind, path)) = swallow_kind {
                info!(room = %self.room_name, path, "{kind} utterance swallowed: '{user_text}'");
                // v140 §4.1:三路命中(exact/tail/fragment)任一 → 发 session_exit_detected。
                // 纪律:envelope 不带转写正文;trace 缺失=不发(受信通道没建立,fail-closed)。
                if kind == "session_exit" && self.exit_signal_on {
                    if let Some(trace) = self.device_trace.clone() {
                        self.exit_seq += 1;
                        let rk = crate::textproc::exit_reply_kind(&user_text);
                        let env = control::session_exit_detected(
                            &trace,
                            now_unix_ms(),
                            self.exit_seq,
                            rk,
                            path,
                        );
                        self.publish_json(control::TOPIC, env.clone());
                        self.exit_pending = Some(ExitSignalPending {
                            seq: self.exit_seq,
                            sent_at: Instant::now(),
                            attempts: 1,
                            envelope: env,
                        });
                        info!(room = %self.room_name, seq = self.exit_seq, reply_kind = rk, path,
                            "session_exit signal sent");
                    } else {
                        info!(room = %self.room_name, "session_exit signal skipped: no session trace");
                    }
                }
                // 在途回答若还在(未被急停白名单/cancel 停掉,如用户轻声说「停」
                // 而 interim 未及命中)→ 此刻补硬停,保证「停=安静」
                if self.agent_turn.is_some() {
                    self.hard_abort_current();
                }
                if let Some(sp) = self.spec.take() {
                    sp.task.abort(); // 对急停词的投机生成作废
                }
                self.latest_interim.clear();
                self.tele_text.clear();
                if let Some(s) = &mut self.snap {
                    s.event("swallowed", &[("text", &user_text), ("kind", kind), ("path", path)]);
                }
                return;
            }
            // TTS 回声对撞(2026-08-26 关灯自嗨实证:确认语「好的…」回声在播完 48ms 后从
            // EOU 正门 commit 成用户轮,再触发 filler+LLM=自我对话)。位置=STOP 之后 DEVICE 之前:
            // 急停/退出安全语义零影响(合同序 EXIT→STOP 不动),且挡住回声文本含命令词
            // 再触发设备命令的最坏放大形态。判据三与:①播放中或播完后窗内 ②计字≥2(单字
            // 交给原有打断门,子串误伤面太大) ③normalize 后是最近播出文本(filler+正文)的子串。
            if !self.cfg.echo_suppress_window.is_zero() {
                let playing = self.agent_turn.is_some();
                let in_window = self
                    .echo_playout_end
                    .is_some_and(|t| t.elapsed() <= self.cfg.echo_suppress_window);
                if playing || in_window {
                    let nu = normalize_echo(&user_text);
                    let nt = normalize_echo(&self.recent_spoken_text(playing, in_window));
                    if nu.chars().count() >= 2 && !nt.is_empty() && nt.contains(&nu) {
                        let since_ms = self
                            .echo_playout_end
                            .map(|t| t.elapsed().as_millis() as i64)
                            .unwrap_or(-1);
                        info!(
                            room = %self.room_name,
                            playing,
                            since_playout_ms = since_ms,
                            "echo suppressed: '{user_text}' ⊂ recent tts"
                        );
                        if let Some(s) = &mut self.snap {
                            s.event("echo_suppressed", &[("text", &user_text)]);
                        }
                        self.latest_interim.clear();
                        self.tele_text.clear();
                        return;
                    }
                }
            }
            // S2-B2 设备命令轮(合同处理序 EXIT→STOP→DEVICE→LLM,禁止改序):
            // 确定性匹配命中 → 发 proposed、零 UserTurnCommitted、零 filler、零 LLM,
            // 等 Android result 播固定短句。范围外音量 → 固定提示,零事件零执行。
            if self.device_commands_on {
                match crate::device_intent::match_command(&user_text) {
                    Some(crate::device_intent::DeviceMatch::Command(cmd)) => {
                        // v3.1 账本(R1/R3):同句裁决按语音段归属,不按时间窗;claimed/ignored/unknown 所有权在此生效;
                        // deferred 电机被同句 ASR 独立确认时,候选 ID 原样回传
                        let cur_utterance = self.ledger.current_utterance();
                        let (candidate, utterance) = match self.ledger.decide(cur_utterance, cmd.action, "") {
                            crate::device_ledger::Decision::Suppress(reason) => {
                                info!(
                                    room = %self.room_name,
                                    semantic_label = cmd.semantic_label,
                                    utterance = self.ledger.current_utterance(),
                                    decision = "suppressed",
                                    reason,
                                    proposal_emitted = false,
                                    "asr 命中被账本压制(同句已有所有权/提案)"
                                );
                                self.latest_interim.clear();
                                self.tele_text.clear();
                                return;
                            }
                            crate::device_ledger::Decision::Propose { candidate, mismatch_with, confirmed_deferred } => {
                                if let Some((cl, ca)) = mismatch_with {
                                    info!(room = %self.room_name, chip_label = cl, chip_action = %ca,
                                          asr_label = cmd.semantic_label, asr_action = %cmd.action, suppress = false, "chip_asr_mismatch");
                                }
                                if confirmed_deferred {
                                    info!(room = %self.room_name, label = cmd.semantic_label, action = %cmd.action,
                                          candidate = %candidate.as_deref().unwrap_or("none"), "chip_candidate_confirmed_by_asr");
                                }
                                (candidate, Some(cur_utterance))
                            }
                        };
                        if self.agent_turn.is_some() {
                            self.hard_abort_current();
                        }
                        if let Some(sp) = self.spec.take() {
                            sp.task.abort();
                        }
                        self.start_device_command(cmd, &user_text, "L1", candidate, "asr", utterance);
                        self.latest_interim.clear();
                        self.tele_text.clear();
                        return;
                    }
                    Some(crate::device_intent::DeviceMatch::VolumeOutOfRange) => {
                        if self.agent_turn.is_some() {
                            self.hard_abort_current();
                        }
                        info!(room = %self.room_name, "volume out of range: '{user_text}' → 固定提示");
                        self.start_turn(TurnKind::Say(
                            crate::device_intent::VOLUME_RANGE_HINT.to_string(),
                        ));
                        self.latest_interim.clear();
                        self.tele_text.clear();
                        return;
                    }
                    None => {}
                }
            }
            // 命令句单出口(2026-09-06 v230 灯控实证):本句已被芯片提案/端侧认领 → 零 filler、零 LLM、零 UserTurnCommitted,
            // 唯一出口是结果驱动的冻结短句(on_device_result / on_l0_result)。LLM 自由叙述会复述命令词→喇叭→芯片听回。
            // 长句(>20 字)豁免:命令+闲聊混合句仍交 LLM(同句 L2 由账本压制,不会二次执行)。
            if self.cfg.cmd_single_exit && self.device_commands_on {
                let cur = self.ledger.current_utterance();
                if let Some(owner) = self.ledger.command_owner_of(cur)
                    && user_text.chars().count() <= CMD_SINGLE_EXIT_MAX_CHARS
                {
                    info!(room = %self.room_name, utterance = cur, owner, text_len = user_text.chars().count(),
                          pending = self.pending_cmd.is_some(), in_flight = self.agent_turn.is_some(),
                          "command turn single exit: filler/LLM skipped");
                    // 不 abort 在途轮:此刻若有在播的,只可能是本命令的冻结短句/「正在调整」(芯片提案时已清过旧回复;
                    // result 先于 commit 到达时它正在播,本 trace 两者只差 219 ms)——掐掉它=孩子听到半句「好嘞—」。
                    // 只作废投机生成;在途时状态也不动(PlayedOut 自然回 Listening)。
                    if let Some(sp) = self.spec.take() {
                        sp.task.abort();
                    }
                    if let Some(s) = &mut self.snap {
                        s.event("command_single_exit", &[("owner", owner)]);
                    }
                    self.latest_interim.clear();
                    self.tele_text.clear();
                    if self.agent_turn.is_none() {
                        if self.pending_cmd.is_some() {
                            self.set_state(AgentState::Thinking);
                        } else {
                            self.set_state(AgentState::Listening);
                        }
                    }
                    return;
                }
            }
            // 有在途回答(播放中/已 pause/生成中)→ 提交即接管:硬打断再开新轮
            if self.agent_turn.is_some() {
                self.hard_abort_current();
            }
            self.contract.user_turn_committed();
            if let Some(s) = &mut self.snap {
                s.event("turn_commit", &[
                    ("text", &user_text),
                    ("eou_ms", &commit.eou_delay.as_millis().to_string()),
                ]);
            }
            info!(
                room = %self.room_name,
                eou_ms = commit.eou_delay.as_millis() as u64,
                stt_ms = commit.stt_delay.as_millis() as u64,
                "turn committed: {user_text}"
            );
            self.publish_json(
                "metrics",
                json!({
                    "k": "eou",
                    "eou_ms": commit.eou_delay.as_millis() as u64,
                    "stt_ms": commit.stt_delay.as_millis() as u64,
                }),
            );
            self.latest_interim.clear();
            self.set_state(AgentState::Thinking);
            // 声纹旁路:消费本轮音频异步比对(fire-and-forget,首句识别第二句起生效)
            if let Some(sp) = self.speaker.as_mut() {
                sp.on_turn();
            }
            let amend = self.pending_amend.take();
            // S1v3 投机核销:提交文本全等 + 历史版本未变 → 复用;否则作废。
            // try_lock 同 start_speculation 的死锁红线:锁被回复流持着(上一轮孙任务
            // 尚未退出)时当 miss 丢投机,绝不阻塞主循环。
            let spec = match self.spec.take() {
                Some(sp) => match self.llm.try_lock() {
                    Ok(llm_guard) => {
                        let ver_now = llm_guard.history_version();
                        drop(llm_guard);
                        if sp.text == user_text && sp.version == ver_now {
                            info!(
                                room = %self.room_name,
                                lead_ms = sp.started.elapsed().as_millis() as u64,
                                "using preemptive generation"
                            );
                            Some(sp)
                        } else {
                            info!(
                                room = %self.room_name,
                                spec_text = %sp.text.chars().take(24).collect::<String>(),
                                "preemptive miss (text/ctx changed), discarding"
                            );
                            sp.task.abort();
                            None
                        }
                    }
                    Err(_) => {
                        info!(room = %self.room_name, "preemptive miss (llm busy), discarding");
                        sp.task.abort();
                        None
                    }
                },
                None => None,
            };
            // 承接音:打断轮(5s 窗)必播,其余按桶概率
            let boost = self
                .last_interrupt_at
                .map(|t| t.elapsed() < Duration::from_secs(5))
                .unwrap_or(false);
            let room = self.room_name.clone();
            let next_turn = self.next_turn_id + 1; // picked 的轮紧接 start_turn 用此 id
            // B(2026-09-09):ordered 首句 + 隔离开关 → 语义桶最短完整条;打断轮/普通轮/开关关 → 原策略。
            // ordered 来源随 CommitInfo 带出(gate 的标记在 poll_commit 返回前已复位,此处不能再读它)。
            let shortest = self.cfg.ordered_filler_shortest && commit.input_ended && !boost;
            // B11：投机命中 = LLM 已在流、TTS 首块 ≈0.3 s 内到——垫句反而成了唯一等待（真机 …1683：正文 +297 ms 就绪等到 +999）。
            let spec_lead_ms = spec.as_ref().map(|sp| sp.started.elapsed().as_millis() as u64).unwrap_or(0);
            let skip_filler = self.cfg.ordered_skip_filler_on_spec && commit.input_ended && !boost && spec.is_some()
                && spec_lead_ms >= self.cfg.ordered_skip_filler_min_lead_ms;
            let filler = if skip_filler {
                info!(room = %self.room_name, spec_lead_ms, "filler skipped: ordered + speculation hit (body imminent)");
                None
            } else {
                self.bank.as_mut().and_then(|b| {
                    if shortest { b.pick_shortest(&user_text, &room, next_turn) } else { b.pick(&user_text, boost, &room, next_turn) }
                })
            };
            self.start_turn(TurnKind::Reply {
                user_text,
                pending_amend: amend,
                filler,
                spec,
            });
        }
    }

    fn start_turn(&mut self, kind: TurnKind) {
        // 回声对撞:记录本 turn 的 filler 文案(Say/无 filler 轮清空)——synth_text 只有 TTS 正文,
        // filler 是预合成 pcm 直接入轨,不经它,得单独暂存才能参与对撞
        self.echo_cur_filler = match &kind {
            TurnKind::Reply { filler: Some((t, _)), .. } => t.clone(),
            _ => String::new(),
        };
        let filler_samples = match &kind {
            TurnKind::Reply { filler: Some((_, p)), .. } => (p.len() / 2) as u64,
            _ => 0,
        };
        let turn_started = Instant::now();
        self.next_turn_id += 1;
        let id = self.next_turn_id;
        // codex 复核 §2:LLM 子任务派发的 DevIntent 必须带创建时的 turn id 与说话轮次
        let utterance_at_start = self.ledger.current_utterance();
        self.tr_started = 0;
        self.tr_finaled = 0;
        let (pcm_tx, pcm_rx) = mpsc::channel::<Vec<u8>>(32);
        // 输出门(冻结 2026-08-18):Android 未订 agent 轨前,PCM 管道过包装层——
        // 首段到达起 5s 未就绪即 fatal fail-closed。门开过(绝大多数轮次)零包装零开销。
        // spawn_playout 是全部可听 PCM(TTS+filler)的唯一入口,包在它前面=全覆盖。
        let pcm_rx = if self.output_gate.is_open() {
            pcm_rx
        } else {
            self.output_gate.wrap(pcm_rx, self.fatal_tx.clone())
        };
        let (playout_task, ctl) =
            playout::spawn_playout(self.source.clone(), pcm_rx, self.room_name.clone(), id);
        let synth_text = Arc::new(StdMutex::new(String::new()));
        let progress = Arc::new(StdMutex::new(Vec::new()));

        // 开播观察者:首帧 capture → AudioStarted(agent_state=speaking 的时刻语义)。
        // 退出条件必须含 abort:hard_abort 只杀外层 turn task,detached 的观察者
        // 若 turn 未开播就被打断会永转(dev198 内存排查时发现的隐性泄漏)。
        let watch_ctl = ctl.clone();
        let watch_tx = self.turn_ev_tx.clone();
        let watcher = tokio::spawn(async move {
            loop {
                if watch_ctl.aborted() {
                    return;
                }
                if watch_ctl.audio_started() {
                    let _ = watch_tx.send(TurnEvent::AudioStarted(id)).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });

        let tts_cfg = self.tts_cfg.clone();
        let llm = self.llm.clone();
        let room_name = self.room_name.clone();
        let ev_tx = self.turn_ev_tx.clone();
        let min_len = self.cfg.tts_min_sentence_len;
        let synth2 = synth_text.clone();
        let prog2 = progress.clone();
        let lp = self.participant.clone();
        // 合成侧要能看见打断信号(讯飞在 pause 期间不能裸 send,见 tts_xfyun::send_or_abort);
        // ctl 本体后面还要交给 AgentTurn,这里克隆一份进 task。
        let ctl_tts = ctl.clone();
        // turn 一开始就起预建连流水线:它与下面的 LLM 请求并行跑,
        // 等第一句文本出来时握手早已完成 → 首句省掉 ~220ms 建连。
        // (火山线返回关闭态,行为不变)
        let mut warm = tts_cfg.start_prewarm();

        let task = tokio::spawn(async move {
            let publish = |v: Value| {
                let p = lp.clone();
                tokio::spawn(async move {
                    let _ = p
                        .publish_data(DataPacket {
                            payload: v.to_string().into_bytes(),
                            topic: Some("metrics".into()),
                            reliable: true,
                            ..Default::default()
                        })
                        .await;
                });
            };
            let mut samples_cum: u64 = 0;
            let mut chars_cum: usize = 0;
            let mut track = |sentence: &str, bytes: usize| {
                samples_cum += (bytes / 2) as u64;
                chars_cum += sentence.chars().count();
                if let Ok(mut s) = synth2.lock() {
                    s.push_str(sentence);
                }
                if let Ok(mut p) = prog2.lock() {
                    p.push((chars_cum, samples_cum));
                }
            };
            match kind {
                TurnKind::Say(text) => {
                    match tts_cfg
                        .synthesize(&text, &pcm_tx, &ctl_tts, &mut warm)
                        .await
                    {
                        Ok((ttfb, bytes)) => {
                            info!(room = %room_name, ttfb_ms = ttfb, bytes, "say synthesized");
                            publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                            track(&text, bytes);
                        }
                        Err(e) => warn!(room = %room_name, error = %e, "say tts failed"),
                    }
                    drop(pcm_tx);
                    let _ = playout_task.await;
                    watcher.abort();
                    // 自然播完:固定句全文入历史(say add_to_chat_ctx 语义)
                    llm.lock().await.push_assistant(&text);
                    let _ = ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
                TurnKind::Reply {
                    user_text,
                    pending_amend,
                    filler,
                    spec,
                } => {
                    // 承接音先入轨(同轨串行,盖住 LLM+TTS 首音;不进历史/不计截断字符
                    // ——track 空句=只登记样本偏移,截断映射因此对齐)
                    if let Some((_ftext, fpcm)) = filler {
                        track("", fpcm.len());
                        let _ = pcm_tx.send(fpcm).await;
                    }
                    // LLM 流:投机命中→消费投机流(需手动落账);未命中→常规 chat(自落账)
                    let (mut delta_rx, llm_join, spec_mode) = match spec {
                        Some(sp) => {
                            {
                                let mut g = llm.lock().await;
                                if let Some(spoken) = pending_amend {
                                    g.set_last_assistant(&spoken);
                                }
                                g.push_user(&user_text);
                            }
                            (sp.rx, sp.task, true)
                        }
                        None => {
                            let (delta_tx, delta_rx) = mpsc::channel::<String>(64);
                            let llm2 = llm.clone();
                            let ut = user_text.clone();
                            let h = tokio::spawn(async move {
                                let mut g = llm2.lock().await;
                                // 上一轮被打断的历史修正在同一把锁内先落账,保证消息顺序
                                if let Some(spoken) = pending_amend {
                                    g.set_last_assistant(&spoken);
                                }
                                g.chat(&ut, delta_tx).await
                            });
                            (delta_rx, h, false)
                        }
                    };
                    let mut seg = Segmenter::new(min_len);
                    // 2b(2026-09-03):[[DEV:N]] 在流里一解析到就派发(带内 token,见 llm::dev_inband),
                    // 不再等整段回复合成完——动作跟着回复开头走。一轮只派首个,其余 multi_label 记 suppressed。
                    let mut l2_sent = false;
                    // B 观测:正文首段 ready(TTS 首块)只记一次;tail 路径同样覆盖。
                    let mut body_ready_logged = false;
                    while let Some(delta) = delta_rx.recv().await {
                        let (early_labels, delta) = crate::llm::split_dev_inband(&delta);
                        for label in early_labels {
                            if label == crate::device_intent::SESSION_EXIT_LABEL {
                                continue; // 慢路退出意图仍只观察(流末统一打点)
                            }
                            if l2_sent {
                                info!(room = %room_name, label, reason = "multi_label", "llm device intent suppressed");
                                continue;
                            }
                            l2_sent = true;
                            let _ = ev_tx.try_send(TurnEvent::DevIntent {
                                label,
                                text: user_text.clone(),
                                turn_id: id,
                                utterance: utterance_at_start,
                            });
                        }
                        if delta.is_empty() {
                            continue;
                        }
                        for sentence in seg.feed(&delta) {
                            // 舞台指示剥离(「（笑）」被 TTS 整句念出,2026-08-16 实测):
                            // TTS/track(字幕+历史+截断映射)统一用净文本;整句是描述则跳过
                            let sentence = crate::textproc::strip_stage_directions(&sentence);
                            if sentence.trim().is_empty() {
                                continue;
                            }
                            let synth_t0 = Instant::now();
                            match tts_cfg
                                .synthesize(&sentence, &pcm_tx, &ctl_tts, &mut warm)
                                .await
                            {
                                Ok((ttfb, bytes)) => {
                                    if !std::mem::replace(&mut body_ready_logged, true) {
                                        info!(room = %room_name, turn_id = id, ttfb_ms = ttfb,
                                              body_ready_since_turn_ms = synth_t0.duration_since(turn_started).as_millis() as u64 + ttfb as u64,
                                              "body first sentence ready");
                                    }
                                    publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                                    track(&sentence, bytes);
                                }
                                Err(e) => {
                                    warn!(room = %room_name, error = %e, "tts synthesize failed");
                                }
                            }
                        }
                    }
                    if let Some(tail) = seg.flush() {
                        let tail = crate::textproc::strip_stage_directions(&tail);
                        if !tail.trim().is_empty() {
                            let synth_t0 = Instant::now();
                            match tts_cfg
                                .synthesize(&tail, &pcm_tx, &ctl_tts, &mut warm)
                                .await
                            {
                                Ok((ttfb, bytes)) => {
                                    if !std::mem::replace(&mut body_ready_logged, true) {
                                        info!(room = %room_name, turn_id = id, ttfb_ms = ttfb,
                                              body_ready_since_turn_ms = synth_t0.duration_since(turn_started).as_millis() as u64 + ttfb as u64,
                                              "body first sentence ready");
                                    }
                                    publish(json!({"k": "tts", "ttfb_ms": ttfb}));
                                    track(&tail, bytes);
                                }
                                Err(e) => {
                                    warn!(room = %room_name, error = %e, "tts synthesize failed (tail)")
                                }
                            }
                        }
                    }
                    match llm_join.await {
                        Ok(Ok(outcome)) => {
                            if spec_mode {
                                llm.lock().await.settle(&outcome);
                            }
                            // Phase 2a 观察打点(2026-08-20):LLM 输出的 [[DEV:N]] 已被
                            // DevMarkStripper 剥离(不进 TTS/字幕/历史),此处只记日志**不执行**
                            // ——LLM→DEVICE commit 被 codex 标 BLOCKED_PENDING_VAD_CANDIDATE_ID,
                            // 关联合同落地前禁止提交。统计:grep 'llm device intent observed'。
                            for label in &outcome.dev_labels {
                                if *label == crate::device_intent::SESSION_EXIT_LABEL {
                                    // B 案(2026-08-28):慢路退出意图观察打点——ASR 错转/表达
                                    // 变体兜底层,统计 grep 'llm session_exit intent observed'。
                                    info!(
                                        room = %room_name,
                                        "llm session_exit intent observed (observe-only, not executed)"
                                    );
                                } else {
                                    // 观察打点保留(2a 数据不断);执行与否由主循环 on_l2_intent 门序决定
                                    info!(
                                        room = %room_name,
                                        label,
                                        known = crate::device_intent::known_label(*label),
                                        "llm device intent observed"
                                    );
                                    // 派发已在流中提前完成(split_dev_inband);这里只留观察打点
                                }
                            }
                            // tps=字符/秒近似(SSE chunk≠token,诚实口径;web 面板显示用)
                            publish(json!({
                                "k": "llm",
                                "ttft_ms": outcome.ttft_ms,
                                "tps": outcome.tps(),
                            }));
                        }
                        Ok(Err(e)) => warn!(room = %room_name, error = %e, "llm chat failed"),
                        Err(e) => warn!(room = %room_name, error = %e, "llm task join failed"),
                    }
                    drop(pcm_tx);
                    let _ = playout_task.await;
                    watcher.abort();
                    let _ = ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
            }
        });
        self.agent_turn = Some(AgentTurn {
            id,
            task,
            ctl,
            synth_text,
            progress,
            filler_samples,
            started: turn_started,
            seg_stage: 0,
        });
    }
}

/// 已播样本数 → 真实说出的文本(整句边界 + 句内按样本比例折算字符,截断历史用)。
fn truncate_spoken(synth: &str, progress: &[(usize, u64)], played_samples: u64) -> String {
    if synth.is_empty() || progress.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = synth.chars().collect();
    let mut prev_chars = 0usize;
    let mut prev_samples = 0u64;
    for &(chars_cum, samples_cum) in progress {
        if played_samples >= samples_cum {
            prev_chars = chars_cum;
            prev_samples = samples_cum;
            continue;
        }
        // 播到本句中途:按样本比例折算字符数
        let sent_samples = samples_cum - prev_samples;
        let sent_chars = chars_cum - prev_chars;
        if sent_samples == 0 {
            break;
        }
        let frac = (played_samples - prev_samples) as f64 / sent_samples as f64;
        let extra = (sent_chars as f64 * frac).floor() as usize;
        prev_chars += extra;
        break;
    }
    chars.into_iter().take(prev_chars).collect()
}

#[cfg(test)]
mod greeting_gate_tests {
    use super::{parse_flag, should_greet};

    // --- 开关解析(codex 联调规格 §4.1 逐行对应) -------------------------------

    #[test]
    fn unset_defaults_to_enabled() {
        // 未设置 → true。这条守的是「不影响其他既有环境」的兼容承诺。
        assert!(parse_flag(None, true));
    }

    #[test]
    fn truthy_values_enable() {
        for v in ["1", "true", "yes", "on", "TRUE", "On", " yes "] {
            assert!(parse_flag(Some(v), false), "{v:?} 应解析为开启");
        }
    }

    #[test]
    fn falsy_values_disable() {
        for v in ["0", "false", "no", "off", "FALSE", "Off", " 0 "] {
            assert!(!parse_flag(Some(v), true), "{v:?} 应解析为关闭");
        }
    }

    #[test]
    fn invalid_value_falls_back_to_default_without_panic() {
        // 非法值不 panic,回退默认——且要证明「回退」是真的跟随 default,
        // 不是碰巧返回了固定值:同一个非法输入,两个 default 必须给出两个结果。
        assert!(parse_flag(Some("maybe"), true));
        assert!(!parse_flag(Some("maybe"), false));
        assert!(parse_flag(Some(""), true));
        assert!(!parse_flag(Some(""), false));
    }

    // --- 门禁判据(测的是生产那条 should_greet,不是测试里重写的条件) -----------

    #[test]
    fn enabled_with_text_greets() {
        // 正例锚:没有它,下面三条「不播」全绿也可能只是函数恒假。
        assert!(should_greet(true, "你好，我在。"));
    }

    #[test]
    fn disabled_with_nonempty_text_does_not_greet() {
        assert!(!should_greet(false, "你好，我在。"));
    }

    #[test]
    fn enabled_with_empty_text_does_not_greet() {
        // 对齐 Python 侧「AGENT_GREETING 为空即静默」的既有约定。
        assert!(!should_greet(true, ""));
    }

    #[test]
    fn enabled_with_whitespace_only_text_does_not_greet() {
        // 全空白等价于空:否则会拿空白串去合成,产出一段无声 PCM。
        assert!(!should_greet(true, "  \n\t "));
    }

    #[test]
    fn disabled_and_empty_does_not_greet() {
        assert!(!should_greet(false, ""));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_spoken_by_sentence_and_fraction() {
        // 两句:"你好呀"(3字,2400样本)+"今天天气不错"(6字,4800样本)
        let synth = "你好呀今天天气不错";
        let progress = vec![(3, 2400), (9, 7200)];
        assert_eq!(truncate_spoken(synth, &progress, 0), "");
        assert_eq!(truncate_spoken(synth, &progress, 2400), "你好呀");
        // 第二句播一半(2400/4800)→ 3 + 3 字
        assert_eq!(truncate_spoken(synth, &progress, 4800), "你好呀今天天");
        assert_eq!(
            truncate_spoken(synth, &progress, 99999),
            "你好呀今天天气不错"
        );
    }

    #[test]
    fn truncate_spoken_empty_progress_is_empty() {
        assert_eq!(truncate_spoken("文本", &[], 1000), "");
        assert_eq!(truncate_spoken("", &[(1, 100)], 1000), "");
    }
}

#[cfg(test)]
mod device_turn_tests {
    use super::*;

    /// first-wins 双向去重(PRE_INPUT_READY §4.3/§6 矩阵 2/3):
    /// 同 label 3s 窗内第二次 claim 必拒;窗外/异 label 放行。
    #[test]
    fn device_reply_table() {
        // 合同 v3.1 十八槽冻结文本(codex 2026-09-05 §3):两端同表
        assert_eq!(device_reply("succeeded", false, "state_confirmed", "led_on"), "好的，已经调好了");
        assert_eq!(device_reply("succeeded", true, "state_confirmed", "brightness_up"), "好嘞，调好啦");
        assert_eq!(
            device_reply("succeeded", false, "state_confirmed_after_result_timeout", "motor_min"),
            "好的，已经调好了"
        );
        assert_eq!(
            device_reply("succeeded", false, "executed_unconfirmed", "color_temperature_normal"),
            "已发送调整，暂未确认"
        );
        assert_eq!(device_reply("succeeded", true, "executed_unconfirmed", "brightness_up"), "已发送调整，暂未确认");
        assert_eq!(device_reply("already_applied", false, "", "led_on"), "现在就是这样啦");
        assert_eq!(device_reply("already_applied", true, "vad_fallback_already_applied", "brightness_down"), "现在就是这样啦");
        assert_eq!(device_reply("rejected", false, "whitelist", "led_on"), "现在暂时不能这样调");
        assert_eq!(device_reply("rejected", false, "unsupported_device_type", "virtual_image_farther_step"), "这台设备不支持调画面距离");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "motor_up_step"), "高度已经是最高了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "motor_down_step"), "高度已经是最低了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "virtual_image_farthest"), "画面已经是最远的了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "virtual_image_farther_step"), "画面已经是最远的了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "virtual_image_nearest"), "画面已经是最近的了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "virtual_image_nearer_step"), "画面已经是最近的了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "brightness_down"), "亮度已经是最低了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "brightness_up"), "亮度已经是最高了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "brightness_max"), "亮度已经是最高了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "brightness_min"), "亮度已经是最低了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "color_temperature_warmer"), "色温已经是最暖的了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "color_temperature_cooler"), "色温已经是最冷的了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "volume_up_5"), "音量已经是最大了");
        assert_eq!(device_reply("rejected", true, "boundary_reached", "volume_down_5_min_5"), "音量已经是最小了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "motor_max"), "高度已经是最高了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "motor_min"), "高度已经是最低了");
        assert_eq!(device_reply("rejected", false, "boundary_reached", "color_temperature_normal"), "已经调到头啦", "辨不出方向不冒充方向");
        assert_eq!(device_reply("failed", false, "", "led_on"), "暂时没能确认调整结果");
        assert_eq!(device_reply("timeout", false, "", "led_on"), "暂时没能确认调整结果");
        assert_eq!(device_reply("weird_status", false, "", "led_on"), "暂时没能确认调整结果");
    }

    #[test]
    fn relative_action_table() {
        assert!(is_relative_action("brightness_up") && is_relative_action("volume_down_5_min_5") && is_relative_action("virtual_image_nearer_step"));
        assert!(!is_relative_action("led_on") && !is_relative_action("brightness_max") && !is_relative_action("virtual_image_farthest") && !is_relative_action(""));
    }
    #[test]
    fn echo_normalize_strips_punct_and_lowercases() {
        assert_eq!(normalize_echo("好的，灯已经关上啦！"), "好的灯已经关上啦");
        assert_eq!(normalize_echo("OK, Lamp Off."), "oklampoff");
        assert_eq!(normalize_echo("…！？"), "");
    }

    #[test]
    fn echo_substring_hits_real_case() {
        // 实案:确认语「好的，正在调整」的回声被 ASR 转写成「好的」
        let tts = normalize_echo("好的，正在调整");
        assert!(tts.contains(&normalize_echo("好的")));
        // filler 回声:「哦，这样啊。」→「这样啊」
        let filler = normalize_echo("哦，这样啊。");
        assert!(filler.contains(&normalize_echo("这样啊")));
    }

    #[test]
    fn echo_no_false_hit_on_unrelated_text() {
        // 用户正常输入不是播出文本子串 → 不撞
        let tts = normalize_echo("好的，正在调整");
        assert!(!tts.contains(&normalize_echo("讲个故事")));
        // 单字判据在门外(计字≥2 才参与)——这里只锚 contains 语义本身:
        // 「灯」是子串,靠调用处的 ≥2 字门挡住误杀,见 commit 对撞门注释
        assert!(tts.contains(&normalize_echo("调整")));
    }
}
