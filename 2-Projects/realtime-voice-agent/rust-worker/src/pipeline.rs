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
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tracing::{info, warn, Instrument};

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
    /// B46:ready 有界补确认(默认关;单机灰度 unit 显式 ONESHOT_READY_CONFIRM_ENABLED=1 才开)
    pub ready_confirm_enabled: bool,
    /// B50 §4:用户 final 字幕延迟到 commit 裁决后再发(默认关,只进灰度专属 env)。
    /// 开 → 被回声门判掉的句子不再向端侧发非空 LOCAL final,端侧不会空等。
    pub caption_defer_enabled: bool,
    /// B9 #3（只在隔离 POC env 置 1）：ordered 每条 held final 到达即起投机 LLM（复用 S1v3 start_speculation），
    /// commit 时文本+历史版本相同才消费，否则丢弃；不改 commit 时序与任何门。
    pub ordered_spec_on_final: bool,
    /// B11（只在隔离 POC env 置 1）：ordered 提交且投机命中时跳过垫句——正文 ≈+0.3 s 起播，不再等最短垫句 0.96 s。
    pub ordered_skip_filler_on_spec: bool,
    /// B11：投机至少领先这么多毫秒才跳垫句（突发/A 型房投机 lead≈20 ms，跳了就是 ~1 s 静默；B 型真机 lead≈1.1 s 才值得跳）。
    pub ordered_skip_filler_min_lead_ms: u64,
    /// 本地承接 v1（2026-09-09 川哥拍板「放行」）：正文门截止 = 设备 end 到达 + 此值（ms）；到点放行（fail-open），不取消整代。
    /// 3000 = 端侧最长条目 2400 + 600 余量：到点本地声必已结束，放行不重叠。
    pub ordered_local_receipt_max_ms: u64,
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
    /// B17（POC env `TTS_FIRST_CLAUSE_MIN`，默认 0=关）：本轮第一段 TTS 累计 ≥N 字遇全角逗号即切，
    /// 不等句末标点；只影响首段，后续段落仍按 tts_min_sentence_len + 句末标点。见 segmenter.rs。
    pub tts_first_clause_min: usize,
    /// B23：首句逗号切默认只对 ordered 首句轮生效（env `TTS_FIRST_CLAUSE_ORDERED_ONLY`，默认 1）；0 = 所有轮次含未签设备——上产前拍板。
    pub tts_first_clause_ordered_only: bool,
    pub tts_latency_v1: bool,
    /// B23 产品首句 v1：input_ready 后这么久没有 begin → 视为端侧没走首句，切回 RTC（env `ORDERED_BEGIN_TIMEOUT_MS`，默认 2500）。
    pub ordered_begin_timeout_ms: u64,
    /// B25（codex §3.4 回声反例）：首句→RTC 切换时回灌多少毫秒的 RTC 追补音频（env `ORDERED_RTC_CATCHUP_MS`）。
    /// **默认 0 = 关**：追补窗口 [end 到达, 切换] 恰好压在端侧播本地承接音／worker 播垫句的窗口上，
    /// 回灌等于把自声喂进第二条 STT（文本过滤不是 AEC）。宁可丢承接音期间的插话（那本来就是 barge-in，
    /// 现役 AEC warmup 期本就禁打断），也不要造幽灵轮。开启时仍会跳过有本地承接／垫句的轮次。
    pub ordered_rtc_catchup_ms: u64,
    pub greeting_text: String,
    /// 连接后是否自动播固定开场白。P003 安卓 demo 要求关掉(2026-08-15 联调)。
    /// 默认 true —— 其余环境行为不变。
    pub greeting_enabled: bool,
    /// S2B1 canary.say 联调通道。默认关;identity 白名单空=全部拒绝(fail-closed)。
    pub canary_say_enabled: bool,
    pub canary_identity_allow: Vec<String>,
    pub vad_model_path: String,
    pub hotwords: HashSet<String>,
    /// 退出词集(EXIT_SWALLOW_HOTWORDS):明确结束整段对话时取消输出并有界关房。
    /// 与仅停止当前播放的急停表分开,由后台统一发布。
    pub exit_hotwords: HashSet<String>,
    /// A 案(2026-08-28):exit 尾部匹配开关(EXIT_TAIL_MATCH,默认开;置 0 回退纯精确匹配)。
    pub exit_tail_match: bool,
    /// 播放中附和词(2026-09-14):词表/模式/长文本阈值,见 backchannel.rs
    pub backchannel: crate::backchannel::BackchannelCfg,
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
            ready_confirm_enabled: std::env::var("ONESHOT_READY_CONFIRM_ENABLED").map(|v| v == "1").unwrap_or(false),
            caption_defer_enabled: std::env::var("ONESHOT_CAPTION_DEFER_ENABLED").map(|v| v == "1").unwrap_or(false),
            ordered_spec_on_final: std::env::var("ORDERED_SPEC_ON_FINAL_ENABLED").map(|v| v == "1").unwrap_or(false),
            ordered_skip_filler_on_spec: std::env::var("ORDERED_SKIP_FILLER_ON_SPEC").map(|v| v == "1").unwrap_or(false),
            ordered_skip_filler_min_lead_ms: std::env::var("ORDERED_SKIP_FILLER_MIN_LEAD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(600),
            ordered_local_receipt_max_ms: std::env::var("ORDERED_LOCAL_RECEIPT_MAX_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(3000),
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
            tts_first_clause_min: std::env::var("TTS_FIRST_CLAUSE_MIN")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            tts_first_clause_ordered_only: std::env::var("TTS_FIRST_CLAUSE_ORDERED_ONLY").map(|v| v != "0").unwrap_or(true),
            tts_latency_v1: crate::tts::latency_mode(),
            ordered_begin_timeout_ms: std::env::var("ORDERED_BEGIN_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2500),
            ordered_rtc_catchup_ms: std::env::var("ORDERED_RTC_CATCHUP_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
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
            backchannel: crate::backchannel::BackchannelCfg::from_env(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentState {
    Listening,
    Thinking,
    Speaking,
}

/// B32-A:控制面发送失败只回**枚举类别**,绝不回原文。LiveKit 的错误链里可能带信令
/// URL 与 query——token 就在 query 里,整条打进 journal 等于把凭据落盘。
/// B34-A:判决点上下文闩的最长有效期。超过就退化成 unknown,不拿旧轮冒充「判决时在播」。
const CTX_LATCH_MAX_AGE_MS: i64 = 200;

/// B34-A:把「发送结果」这条结构化日志抽出来单独可测,**并且不带 room**。
///
/// B33 我写了「不打印房名」,而代码里就是 `room = %room`——房名形如 `sn-<SN>-<ts>`,
/// 带完整设备 SN。而我当时的测试只测 `publish_fail_class` 返回枚举:那个函数确实不泄漏,
/// **外围字段照样泄漏**,判据套在了错的对象上(codex B34 §2 P0-A,属实)。
/// 关联键用已经受信的 trace(UUID),足够把两端对上。
fn emit_publish_result(
    event: &'static str,
    trace: &str,
    since_pipeline_ms: i64,
    send_ms: i64,
    err: Option<&str>,
) {
    match err {
        None => info!(
            event,
            trace, since_pipeline_ms, send_ms, publish_ok = true, "control publish result"
        ),
        Some(e) => warn!(
            event,
            trace,
            since_pipeline_ms,
            send_ms,
            publish_ok = false,
            fail_class = publish_fail_class(e),
            "control publish result"
        ),
    }
}

fn publish_fail_class(raw: &str) -> &'static str {
    let s = raw.to_ascii_lowercase();
    if s.contains("not connected") || s.contains("disconnect") {
        "not_connected"
    } else if s.contains("timeout") || s.contains("timed out") {
        "timeout"
    } else if s.contains("too large") || s.contains("payload") {
        "payload"
    } else if s.contains("closed") {
        "closed"
    } else {
        "other"
    }
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

/// B23 产品首句 v1：输入相位。FirstTurn = ordered 首句代次进行中（RTC 帧只计数，留追补环）；
/// Rtc = 代次终态/begin 超时后切回 RTC 多轮（第二条 STT 接管）；NotOrdered = 现役房（零行为变化）。不可逆。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputPhase {
    NotOrdered,
    FirstTurn,
    Rtc,
}

enum TurnKind {
    Say(String),
    // Web evidence must not enter the ordinary chat history / downstream memory extractor.
    BackgroundSay(String),
    BackgroundClip(String, Vec<u8>),
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
    search_context: Option<Value>,
    text: String,
    version: u64,
    started: Instant,
    task: JoinHandle<Result<ChatOutcome>>,
    rx: mpsc::Receiver<String>,
}

struct AgentTurn {
    search_progress: Option<Arc<StdMutex<crate::search_progress::SearchProgress>>>,
    id: u64,
    task: JoinHandle<()>,
    ctl: PlayoutControl,
    synth_text: Arc<StdMutex<String>>,
    /// 每句合成完成后追加 (累计字符数, 累计样本数),打断截断用。
    progress: Arc<StdMutex<Vec<(usize, u64)>>>,
    /// 本轮回复 LLM 已产出字数(含尚未合成的部分)——附和词判「长文本」用,孩子第 3 秒说「嗯」也按整篇算。
    llm_chars: Arc<AtomicUsize>,
    /// B 观测:本轮 filler 的 24k 样本数(0=无 filler);turn 起始时刻;分段日志阶段(0/1/2)。
    filler_samples: u64,
    started: Instant,
    business_until: Instant,
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
    search: Option<crate::search_tasks::SearchSession>,
    search_turn: bool,
    search_user_speaking: bool,
    /// One-shot v0.3:有序 PCM 代次(Some=实验模式;None=现役 RTC,本字段零参与)
    ordered: Option<crate::ordered_pcm::Session>,
    /// B23：输入相位（见 `InputPhase`）
    input_phase: InputPhase,
    /// B23：切换请求（代次终态 / begin 超时置位；主循环消费：换 STT、回灌追补环、发 `session.input_phase`）
    pending_phase_switch: Option<String>,
    /// B23：首句期间最近 ≤1 s 的 RTC 帧（到达时刻 + 样本）；切换时只回灌 end 到达之后的帧
    rtc_catchup: std::collections::VecDeque<(Instant, Vec<i16>)>,
    rtc_catchup_samples: usize,
    /// B23：本轮首句逗号切阈值（commit 时按「ordered 首句轮 / 全局开关」决定，start_turn 消费）
    turn_first_clause_min: usize,
    /// ordered_pcm:待执行的「主动收流」(drop 唯一 ASR 发送端);由主循环消费,因为发送端不在 Orchestrator 里
    ordered_end_stream_pending: bool,
    /// B9 #2：本 job 是否已记过候选日志（ack 字段幂等，只记第一次）。
    ordered_end_candidate_logged: bool,
    /// B12：ordered held final 时提前预建的 TTS 连接（真机 …1684：commit 后 TTS 预热 632 ms + 首块 410 ms = 1.04 s 静默）；start_turn 取走。
    pending_tts_warm: Option<crate::tts::Prewarm>,
    /// 本地承接 v1：设备 end 被接受的时刻（worker 单调钟）= 正文门截止锚。
    ordered_end_seen_at: Option<Instant>,
    /// 本地承接 v1：commit 时定下的正文门截止；start_turn 取走并包装本轮 PCM 管道（只对该轮生效）。
    pending_local_receipt_deadline: Option<Instant>,
    /// 本地承接 v1：当前轮正文门的放行句柄（receipt_done → true，幂等）。
    local_receipt_release: Option<tokio::sync::watch::Sender<bool>>,
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
    onboarding: Option<crate::voice_onboarding::Runtime>,
    onboarding_deferred: Option<(control::Envelope, Option<String>, Instant)>,
    /// v140 退出信令灰度(合同 §8.3 先仅 0010;fail-closed:env 未配=不发,吞句照常)
    exit_signal_on: bool,
    /// 退出信令 seq(per-job 单调;重试必须同 seq——只在新命中时自增)
    exit_seq: i64,
    /// 在途退出信令:等 ACK/cancel/room close 任一终态;800ms 无终态同 seq 重发,至多 3 发
    exit_pending: Option<ExitSignalPending>,
    session_close: crate::session_close::CloseDeadline,
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
    search_history_handoff: Arc<StdMutex<Option<(u64, String)>>>,
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
    /// B32-B 打断取证快照(INTERRUPT_SNAPSHOT_ENABLED≠1 = None,零行为变化、不新增任何文件)
    isnap: Option<crate::eot_snapshot::InterruptSnap>,
    /// B34-C 取证专用上行环。**只在诊断开启时分配**(8s@16k≈256KB/job);关 = None = 一个字节不占。
    /// 独立于 eot_ring 是因为后者是输入环的局部变量,ASR 判决点够不着,而判决点必须能**立刻**取证。
    isnap_ring: Option<std::collections::VecDeque<i16>>,
    /// 最后一次向取证环写入样本的 job 单调时刻(用于标「窗口末端离判决多远」,不拿落盘调度时间冒充)
    isnap_last_sample_ms: i64,
    /// B34-B abort 前闩住的播放上下文
    ctx_latch: crate::eot_snapshot::CtxLatch,
    /// B46 ready 有界补确认状态机(默认关)
    ready_confirm: crate::ready_confirm::ReadyConfirm,
    caption_gate: crate::caption_gate::CaptionGate,
    /// B50 §5:一次性 30s 上行取证窗口(默认不存在;Drop 即写盘收口)
    audit: Option<crate::audit_capture::AuditCapture>,
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
/// 任务所有权随预热产物转交；产物被丢弃或流水线被取消时停止 ASR，不留后台重试。
pub struct SttPre {
    pub pcm_tx: crate::asr_diagnostics::PcmSender,
    pub ev_rx: mpsc::Receiver<SttEvent>,
    pub task: crate::owned_task::OwnedTask<()>,
}

// Called only before any PCM is submitted to this preconnection, including
// the spare prepared before the ordered-to-RTC transition. A queued interruption
// belongs to that idle episode, not to the user's upcoming first utterance.
// Keep healthy/in-flight connections regardless of age; do not restart an
// active recognition stream or renew its bounded connection episode.
async fn take_stt_preconnect(mut pre: SttPre, rebuild: impl FnOnce() -> SttPre) -> Result<SttPre> {
    let mut ended = pre.pcm_tx.is_closed() || pre.ev_rx.is_closed();
    // Snapshot the bounded queue: never wait for or discard events produced
    // after handoff. A live reconnect retains its original task/PCM channel.
    for _ in 0..pre.ev_rx.len() {
        match pre.ev_rx.try_recv() {
            Ok(SttEvent::Closed) => ended = true,
            Ok(_) => {},
            Err(_) => break,
        }
    }
    if !ended && !pre.pcm_tx.is_closed() && !pre.ev_rx.is_closed() {
        return Ok(pre);
    }
    let SttPre { pcm_tx, ev_rx, mut task } = pre;
    task.abort();
    anyhow::ensure!(tokio::time::timeout(Duration::from_millis(500), &mut task).await.is_ok(),
        "failed_asr_preconnect_abort_timeout");
    drop(pcm_tx);
    drop(ev_rx);
    info!("replacing failed idle ASR preconnection before PCM handoff");
    Ok(rebuild())
}

/// 该房的 ASR 配置:env 基线 + 二遍识别 per-SN 灰度(命中即切 bigmodel_async + enable_nonstream,必须同调:
/// 老 bigmodel 静默忽略此参数)。非命中房间零变化。
pub fn stt_cfg_for_room(room_name: &str) -> SttConfig {
    let mut stt_cfg = SttConfig::from_env();
    stt_cfg.preserve_search_ack(
        crate::search_enrollment::for_room(room_name),
        std::env::var("P003_SEARCH_ACK_ASR_V1").is_ok_and(|v|v=="1"));
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
    let diagnostic = crate::asr_diagnostics::InputDiagnostic::for_room(room_name);
    let stt_pcm_tx = crate::asr_diagnostics::PcmSender::new(stt_pcm_tx, diagnostic.clone());
    info!(room = %room_name, nonstream = stt_cfg.nonstream, "asr stream task spawned (preconnect)");
    let rn = room_name.to_string();
    let span = tracing::info_span!("asr_stream", room = %room_name);
    let task = tokio::spawn(async move {
        let mut pcm_rx = stt_pcm_rx;
        let mut fails = 0u32;
        loop {
            if stt_ev_tx.is_closed() || (pcm_rx.is_closed() && pcm_rx.is_empty()) { break; }
            let started = Instant::now();
            match stt_volc::run_asr_stream_observed(stt_cfg.clone(), &mut pcm_rx, stt_ev_tx.clone(), diagnostic.clone()).await {
                Ok(AsrEnd::InputDone | AsrEnd::Unused) => break,
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
                    // DNS/address attempts already share the connection budget.
                    // Do not renew it six times while the 25s audio queue fills
                    // and silently discards the user's first utterance.
                    if e.is::<stt_volc::ConnectFailure>() { break; }
                }
            }
            // A closed input is terminal, including provider rejection of its
            // final empty packet. Never reconnect an abandoned prewarm stream.
            if pcm_rx.is_closed() || stt_ev_tx.is_closed() { break; }
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
    }.instrument(span));
    SttPre { pcm_tx: stt_pcm_tx, ev_rx: stt_ev_rx, task: crate::owned_task::OwnedTask::new(task) }
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
        // 有界灾备仅故障时启动；禁止备用生成式预热，避免每次开房额外调用。
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

/// B23：签发 metadata 里与 ordered 输入相关的受信声明（job 层解析，pipeline 只认这里，不认设备自述）。
#[derive(Clone, Debug, Default)]
pub struct OrderedCtx {
    /// `local_receipt:"v1"`——允许 begin 声明本地承接（false = 即使 env 开也回 ignored）
    pub local_receipt: bool,
    /// `oneshot_first_turn:"v1"`——首句代次终态后同房切回 RTC 多轮；false = POC 一房一代旧语义
    pub first_turn_rtc: bool,
    /// `session_id`——OPCM 包头逐条对撞（None = 不对撞）
    pub session_id: Option<String>,
}

pub struct ReadyCtx {
    pub onboarding: Option<serde_json::Value>,
    pub session_id: Option<String>,
    pub business: Option<crate::business_runtime::Runtime>,
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
    // 受信 ordered 声明（local_receipt / oneshot_first_turn / session_id），与 input_mode 同源自签发 metadata。
    ordered_ctx: OrderedCtx,
    beat: std::sync::Arc<std::sync::atomic::AtomicU64>,
    ready: ReadyCtx,
    prebuilt: Option<Prebuilt>,
    filler_policy: Option<crate::filler::FillerPolicy>,
    mut shutdown:Option<tokio::sync::oneshot::Receiver<()>>,
) -> Result<()> {
    // 预组装接管(2026-09-07):job 层在 assignment 到达即开始的重活(VAD 模型/填充语库/声纹库/LLM·TTS 客户端与预热/
    // 回声库拉取/ASR 预连)此处直接接管;无预组装路径(web 调试直连)原地组装,行为一致。
    let Prebuilt { cfg, tts_cfg, llm, echo_local_texts, speaker, mut vad, mut bank, stt, started_at: prebuilt_at } = match prebuilt {
        Some(p) => p,
        None => prebuild(room_name.clone()).await?,
    };
    if let (Some(bank), Some(policy)) = (bank.as_mut(), filler_policy) {
        bank.apply_policy(policy, &room_name);
    }
    // B46:cfg 随后整体 move 进 orch 字面量(字段按源码顺序求值),开关先取成局部值
    let ready_confirm_enabled = cfg.ready_confirm_enabled;
    let caption_defer_enabled = cfg.caption_defer_enabled;
    // B50 §5:取证窗口只对真实首句 ordered_pcm 轮武装(自动欢迎/presence_return 房 false)
    let audit_first_turn = ordered_ctx.first_turn_rtc;
    info!(room = %room_name, prebuilt_age_ms = prebuilt_at.elapsed().as_millis() as u64, "pipeline takeover prebuilt");
    // One-shot v0.3:受信输入模式在第一帧前固定。ordered_pcm=RTC 帧从第一帧起不进 VAD/ASR/EOT/投机,只吃有序 PCM 代次;
    // 现役房 None,下方所有 `orch.ordered` 分支不触发(零行为变化)。
    let ordered_session = match input_mode {
        crate::ordered_pcm::InputMode::OrderedPcm => {
            info!(room = %room_name, "ordered_pcm 实验模式启用(受信 metadata):等待有序 PCM 代次,RTC 音频只计数丢弃");
            let mut limits = crate::ordered_pcm::Limits::from_env();
            // 本地承接 v1：env 开关 ∧ 签发 metadata 同时成立才接受 begin 声明；批次 2 未签的房恒回 ignored。
            limits.local_receipt_enabled = limits.local_receipt_enabled && ordered_ctx.local_receipt;
            // B23：产品首句 v1 只认签发 metadata（env 开不了）；POC 旧房无此字段 = 一房一代旧语义
            limits.first_turn_rtc = ordered_ctx.first_turn_rtc;
            info!(room = %room_name, local_receipt_enabled = limits.local_receipt_enabled, meta_local_receipt = ordered_ctx.local_receipt,
                  first_turn_rtc = limits.first_turn_rtc, begin_to_end_timeout_ms = limits.begin_to_end_timeout_ms,
                  max_total_s = limits.max_total_samples / crate::ordered_pcm::SAMPLE_RATE as usize,
                  session_bound = ordered_ctx.session_id.is_some(), "ordered_pcm local receipt v1");
            Some(crate::ordered_pcm::Session::new(ready.trace_id.clone(), limits).with_expected_session(ordered_ctx.session_id.clone()))
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
    let stt = take_stt_preconnect(stt, || spawn_stt(stt_cfg_for_room(&room_name), &room_name)).await?;
    let SttPre { pcm_tx: stt_pcm_tx, ev_rx: mut stt_ev_rx, task: mut stt_task } = stt;
    // ordered_pcm 需要主动收流(drop 唯一发送端 → 供应商 LastNoSeq → 唯一裁决点);现役路径永远是 Some,行为不变
    stt_pcm_tx.phase("ordered_or_initial");
    let mut stt_pcm_tx = Some(stt_pcm_tx);
    let mut stt_closed = false;
    // B23：首句 end 收流后预连的第二条 STT（与首答并行建连），切 RTC 时接管；首条任务句柄留到收尾
    let mut stt2: Option<(SttPre, Instant)> = None;
    let mut stt_tasks_done: Vec<crate::owned_task::OwnedTask<()>> = Vec::new();

    let (turn_ev_tx, mut turn_ev_rx) = mpsc::channel::<TurnEvent>(16);
    let (eot_tx, mut eot_rx) = mpsc::channel::<(u64, f32)>(8);

    let participant2 = participant.clone();
    // 输出门 fail-closed 传导:OutputGate 包装层超时 → fatal_rx → 统一收尾后返回 Err
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
    let input_phase0 = if ordered_session.is_some() { InputPhase::FirstTurn } else { InputPhase::NotOrdered };
    let search = llm.try_lock().ok().and_then(|g| crate::search_tasks::SearchSession::from_config(&g.prewarm_parts().1, tts_cfg.provider_name(), tts_cfg.voice()));
    let onboarding = crate::llm::LlmConfig::from_env().and_then(|cfg| crate::voice_onboarding::Runtime::from_metadata(ready.onboarding.as_ref(), ready.trace_id.as_deref(), ready.session_id.as_deref(), crate::ordered_pcm::expected_device_identity(&room_name).as_deref(), &cfg.base_url, &cfg.url_query));
    let mut orch = Orchestrator {
        onboarding,
        onboarding_deferred: None,
        search,
        search_turn: false,
        search_user_speaking: false,
        output_gate: crate::gate::OutputGate::new(ready.out_rx.clone()),
        fatal_tx,
        device_commands_on,
        exit_signal_on,
        exit_seq: 0,
        exit_pending: None,
        session_close: crate::session_close::CloseDeadline::default(),
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
        search_history_handoff: Arc::new(std::sync::Mutex::new(None)),
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
        isnap: crate::eot_snapshot::InterruptSnap::from_env(),
        isnap_ring: None,
        isnap_last_sample_ms: 0,
        ctx_latch: crate::eot_snapshot::CtxLatch::new(),
        ready_confirm: crate::ready_confirm::ReadyConfirm::new(ready_confirm_enabled),
        caption_gate: crate::caption_gate::CaptionGate::new(caption_defer_enabled),
        audit: crate::audit_capture::AuditCapture::arm_from_env(ready.trace_id.as_deref(), audit_first_turn),
        ordered: ordered_session,
        input_phase: input_phase0,
        pending_phase_switch: None,
        rtc_catchup: std::collections::VecDeque::new(),
        rtc_catchup_samples: 0,
        turn_first_clause_min: 0,
        ordered_end_stream_pending: false,
        ordered_end_candidate_logged: false,
        pending_tts_warm: None,
        ordered_end_seen_at: None,
        pending_local_receipt_deadline: None,
        local_receipt_release: None,
    };
    // B34-C:诊断开启才分配取证环(8s@16k ≈ 256KB/job);关 = None = 一个字节不占。
    if orch.isnap.is_some() {
        orch.isnap_ring =
            Some(std::collections::VecDeque::with_capacity(crate::eot_snapshot::SNAP_WINDOW));
    }

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
    let mut input_stats = crate::business_watchdog::AudioStats::default();
    let mut business_last_played: Option<(u64, u64, Instant)> = None;
    let mut business_ordered_until: Option<Instant> = None;
    let mut in_report = Instant::now();
    // input_ready 只发一次:独立标志,不复用 in_frames(它被 10s 水位报告清零,
    // 生产实证 2026-08-18 06:20 同 job 每 10s 重发一次 input_ready——Android 幂等兜住但脏)
    let mut input_ready_fired = false;
    let mut exit_error = None;

    loop {
        // B23 产品首句 v1:执行输入相位切换(代次终态 / begin 超时后置位,每 job 一次):换 STT、回灌追补环、发 session.input_phase。
        if let Some(reason) = orch.pending_phase_switch.take() {
            let (pre, mut spawned_at) = match stt2.take() {
                Some(x) => x,
                None => (spawn_stt(stt_cfg_for_room(&room_name), &room_name), Instant::now()),
            };
            let pre = match take_stt_preconnect(pre, || {
                spawned_at = Instant::now();
                spawn_stt(stt_cfg_for_room(&room_name), &room_name)
            }).await {
                Ok(pre) => pre,
                Err(error) => { exit_error = Some(error); break; }
            };
            let SttPre { pcm_tx, ev_rx, task } = pre;
            // 首条(ordered)STT 在此显式收流(若尚未收);之后 EndStream 动作一律不得再碰发送端——否则会把第二条关掉
            // (2026-09-11 模拟实证:begin 超时/取消路径的 fail→EndStream 在切换后到达,关的是刚接管的第二条 → job 收尾)
            drop(stt_pcm_tx.take());
            pcm_tx.phase("rtc");
            stt_pcm_tx = Some(pcm_tx);
            stt_ev_rx = ev_rx;
            stt_closed = false;
            stt_tasks_done.push(std::mem::replace(&mut stt_task, task));
            if let Some(w) = &ready.business { w.first_turn_to_rtc(Instant::now()); }
            orch.input_phase = InputPhase::Rtc;
            // 未终态就切(begin 超时):先把代次关成 timeout 终态,迟到的 begin 之后一律 input_conflict 拒绝
            let mut acts = Vec::new();
            if let Some(o) = orch.ordered.as_mut()
                && o.phase() != crate::ordered_pcm::Phase::Terminal
            {
                acts = o.fail(crate::ordered_pcm::FailReason::Timeout);
            }
            orch.apply_ordered_actions(acts);
            orch.pending_phase_switch = None; // apply 可能再置位,切换只一次
            orch.ordered_end_stream_pending = false; // 首句流已关;不得把第二条 STT 的发送端 take 掉
            // 追补环(B25 收紧):三道门全过才回灌——
            //   ① env 开(默认 0=关);② 完整闭合(committed/no_task,失败/超时不回灌);
            //   ③ **本轮没有任何本地播放**:本地承接 accepted 或 worker 垫句在播时,追补窗口
            //      [end 到达, 切换] 就是自声窗口(codex B25 §3.4),回灌 = 把回声喂进第二条 STT。
            // 采样边界口径:按到达墙钟截断,误差预算 = 端侧 704 ms 判停静音带(详见回执 B26 §2)。
            let cutoff = orch.ordered_end_seen_at;
            let frames: Vec<(Instant, Vec<i16>)> = orch.rtc_catchup.drain(..).collect();
            orch.rtc_catchup_samples = 0;
            // 自声窗口:端侧本地承接 accepted / worker 本轮已挑垫句 / 有任务(worker 必出垫句或正文)——
            // 三者任一成立,追补窗口里的 RTC 上行就含自声。
            let local_audio_window = orch.ordered.as_ref().map(|o| o.local_receipt_accepted()).unwrap_or(false)
                || !orch.echo_cur_filler.is_empty()
                || reason == "first_turn_committed";
            let complete = reason == "first_turn_committed" || reason == "first_turn_no_task";
            let catchup_skipped = if orch.cfg.ordered_rtc_catchup_ms == 0 {
                Some("disabled")
            } else if !complete {
                Some("not_complete")
            } else if local_audio_window {
                Some("local_audio_window")
            } else {
                None
            };
            let mut fed = 0usize;
            if catchup_skipped.is_none()
                && let Some(cut) = cutoff
            {
                for (t, f) in frames {
                    if t >= cut {
                        fed += f.len();
                        stt_buf.extend_from_slice(&f);
                    }
                }
            }
            let ordered_info = orch.ordered.as_ref().map(|o| json!({
                "input_id": o.input_id(), "session_id": o.session_id(), "end_sample": o.end_sample_opt(), "outcome": o.outcome_str(),
                "no_task_reason": o.no_task_reason(),
            })).unwrap_or(Value::Null);
            let catchup_info = json!({"samples": fed, "skipped": catchup_skipped});
            if let Some(trace) = ready.trace_id.as_deref() {
                let v = control::input_phase(trace, now_unix_ms(), &room_name, &reason, ordered_info,
                    spawned_at.elapsed().as_millis() as i64, catchup_info);
                orch.publish_json(control::TOPIC, v);
            }
            info!(room = %room_name, reason = %reason, catchup_samples = fed,
                  catchup_skipped = catchup_skipped.unwrap_or("-"),
                  stt2_spawned_ms_ago = spawned_at.elapsed().as_millis() as u64, "ordered_pcm input phase → rtc");
        }
        tokio::select! {
            _ = async {if let Some(rx)=&mut shutdown {let _=rx.await;}else{std::future::pending::<()>().await;}} => {break;},
            // 输出门 fail-closed(冻结 2026-08-18):首个待播 PCM 起 5s Android 仍未订阅
            // agent 轨 → 整 job 收摊关房,绝不带着半聋房间继续跑
            Some(msg) = fatal_rx.recv() => {
                exit_error = Some(anyhow::anyhow!("output gate fail-closed: {msg}"));
                break;
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
                if let Some(tx)=&stt_pcm_tx {tx.rtc_input(&samples, orch.input_phase == InputPhase::FirstTurn);}
                // B50 §5:一次性取证窗口旁路收音(默认不存在)。只做一次 extend,不进任何判定链。
                if let Some(a) = orch.audit.as_mut() {
                    a.push(&samples);
                }
                in_frames += 1;
                input_stats.push(&samples);
                if let Some(w) = &ready.business { w.input_frame(Instant::now(), samples.len()); }
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
                            // B32-A:published 只代表**已排队**(publish_json 是 spawn 即返回);
                            // 真实 publish_data 结果在下面那条 traced 行,别把这行当送达。
                            orch.publish_json_traced(control::TOPIC, v, "session.input_ready", trace.to_string());
                            info!(trace, "session.input_ready published(scheduled)");
                            // B46:记下这次真实 ready 的快照;若端侧的补确认请求先到过(pending),
                            // 就在**同一事件路径**上用同一快照重述一次——不轮询、不另起管线。
                            let snap = crate::ready_confirm::ReadySnapshot {
                                issue_to_assignment_ms: ready.issue_to_assignment_ms,
                                job_room_connect_ms: ready.connect_ms as i64,
                                track_to_input_loop_ms: track_to_loop,
                            };
                            if let Some(req_seq) = orch.ready_confirm.on_real_ready(snap) {
                                let rv = control::input_ready_restated(
                                    trace,
                                    now_unix_ms(),
                                    &room_name,
                                    orch.output_gate.is_open(),
                                    &control::ReadyTimings {
                                        issue_to_assignment_ms: ready.issue_to_assignment_ms,
                                        job_room_connect_ms: ready.connect_ms as i64,
                                        track_to_input_loop_ms: track_to_loop,
                                    },
                                    req_seq,
                                );
                                orch.publish_json_traced(control::TOPIC, rv, "session.input_ready.restated", trace.to_string());
                                info!(trace, request_seq = req_seq, decision = "pending_fulfilled", "input_ready.request");
                            }
                        }
                        // 老 token/调试房:无受信 trace 可绑,合同禁 pending → 降级不发
                        None => warn!(room = %room_name, "input_ready skipped: 无 trace(老 token 或非 Session API 房)"),
                    }
                }
                orch.input_loop_started_at.get_or_insert(Instant::now());
                if orch.ordered_first_turn_active() {
                    // ordered_pcm 首句代次:RTC 帧到此为止——不进幅度统计/ASR 队列/EOT 环/声纹/投机/VAD(只计数)。
                    // B23:v1 房留最近 ≤1 s 追补环(到达时刻+样本),切 RTC 时只回灌 end 到达之后的帧
                    // (设备冻结在 end 发送之前 → 这些帧必在首句之后,不会把首句尾巴再识别成幽灵轮)。
                    let v1 = orch.ordered.as_ref().map(|o| o.first_turn_rtc()).unwrap_or(false);
                    if let Some(o) = orch.ordered.as_mut() {
                        o.note_rtc_frame_dropped();
                    }
                    // B25:容量按 env(默认 0=不留环,零内存零回灌)
                    let cap = (orch.cfg.ordered_rtc_catchup_ms as usize) * 16;
                    if v1 && cap > 0 {
                        orch.rtc_catchup_samples += samples.len();
                        orch.rtc_catchup.push_back((Instant::now(), samples.to_vec()));
                        while orch.rtc_catchup_samples > cap {
                            match orch.rtc_catchup.pop_front() {
                                Some((_, f)) => orch.rtc_catchup_samples -= f.len(),
                                None => break,
                            }
                        }
                    }
                    continue;
                }
                if !samples.is_empty() {
                    in_amp_acc += samples.iter().map(|s| u64::from(s.unsigned_abs())).sum::<u64>()
                        / samples.len() as u64;
                }
                stt_buf.extend_from_slice(&samples); // Exit grammar remains available during local cues; onboarding gates all profile answers.
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
                if orch.onboarding.as_ref().is_some_and(|o|o.blocks_input()) {
                    vad_buf.clear();
                    continue;
                }
                orch.on_pf_frame(&samples).await;
                vad_buf.extend_from_slice(&samples);
                while vad_buf.len() >= WINDOW {
                    let chunk: Vec<i16> = vad_buf.drain(..WINDOW).collect();
                    if let Ok(p) = vad.predict(&chunk) {
                        let active = p >= gate.activation_threshold;
                        if active { if let Some(o)=orch.onboarding.as_mut(){o.speech();} if let Some(w) = &ready.business { w.asr_speech(Instant::now()); } }
                        let ev = gate.feed(p);
                        orch.on_vad_frame(&gate, ev, active, &eot_ring).await;
                    }
                }
            }
            // One-shot v0.3:有序 PCM 包(现役房通道永远空,分支不触发)
            Some(pkt) = hist_rx.recv() => {
                let was_idle = orch.ordered.as_ref().is_some_and(|o| o.phase() == crate::ordered_pcm::Phase::Idle);
                let submitted = orch.on_ordered_packet(&pkt, &stt_pcm_tx);
                if let Some(w) = &ready.business {
                    w.input_frame(Instant::now(), submitted);
                    if was_idle && orch.ordered.as_ref().is_some_and(|o| o.phase() == crate::ordered_pcm::Phase::Receiving) {
                        business_ordered_until = orch.ordered.as_ref().map(|o| Instant::now() + Duration::from_millis(o.business_input_budget_ms()));
                    }
                }
                if orch.ordered_end_stream_pending && orch.input_phase == InputPhase::Rtc {
                    orch.ordered_end_stream_pending = false; // B23:已切 RTC,首句流早已关,忽略
                }
                if orch.ordered_end_stream_pending {
                    orch.ordered_end_stream_pending = false;
                    stt_pcm_tx.take(); // 主动收流:供应商回 LastNoSeq → Closed → 裁决
                    // B23:首句已收流 → 立即预连第二条 STT(与首答 final/LLM/TTS/本地承接并行),切 RTC 时直接接管
                    if stt2.is_none() && orch.ordered.as_ref().map(|o| o.first_turn_rtc()).unwrap_or(false) {
                        stt2 = Some((spawn_stt(stt_cfg_for_room(&room_name), &room_name), Instant::now()));
                    }
                }
            }
            ev = stt_ev_rx.recv(), if !stt_closed => match ev {
                Some(SttEvent::Interim(t)) => {
                    if orch.ordered_first_turn_active() {
                        if let Some(o) = orch.ordered.as_mut() { o.on_stt_interim(); }
                    } else {
                        orch.on_interim(t)
                    }
                }
                Some(SttEvent::Final(t)) => {
                    info!(room = %room_name, trace = ready.trace_id.as_deref().unwrap_or("-"),
                        chars = t.chars().count(), phase = ?orch.input_phase, "asr final received");
                    if orch.ordered_first_turn_active() {
                        let acts = orch.ordered.as_mut().map(|o| o.on_stt_final(t, unix_ms_now())).unwrap_or_default();
                        orch.apply_ordered_actions(acts);
                        orch.on_ordered_final_held().await;
                    } else {
                        if let Some(w) = &ready.business { w.asr_final(Instant::now()); }
                        orch.on_final(t)
                    }
                }
                Some(SttEvent::Interrupted) => {
                    // 现役:连接由 stt 任务重连,这里只记日志;ordered_pcm:代次作废(意外 EOF/断连 ≠ LastNoSeq,不得提交半段 final)
                    if orch.ordered_first_turn_active() {
                        let acts = orch.ordered.as_mut().map(|o| o.on_stream_interrupted()).unwrap_or_default();
                        orch.apply_ordered_actions(acts);
                    } else {
                        info!(room = %room_name, "stt 连接中断(现役:等待 stt 任务重连)");
                    }
                }
                Some(SttEvent::Closed) | None => {
                    if orch.ordered_first_turn_active() {
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
                // watchdog 心跳(assignment 起单调毫秒):主循环卡死(如等锁)时停跳,job 层 5s 无跳即惊闸关房
                beat.store(
                    ready.t_assign.elapsed().as_millis().max(1) as u64,
                    std::sync::atomic::Ordering::Relaxed,
                );
                if in_report.elapsed() >= Duration::from_secs(10) {
                    let mean_amp = if in_frames > 0 { in_amp_acc / in_frames } else { 0 };
                    info!(room = %room_name, trace = ready.trace_id.as_deref().unwrap_or("-"),
                        frames = in_frames, mean_amp, samples = input_stats.samples,
                        nonzero_samples = input_stats.nonzero, peak = input_stats.peak,
                        mean_abs = input_stats.mean_abs(), "audio in (10s)");
                    input_stats = crate::business_watchdog::AudioStats::default();
                    in_frames = 0;
                    in_amp_acc = 0;
                    in_report = Instant::now();
                }
                orch.poll_device_timeout(Instant::now());
                orch.poll_ledger(Instant::now());
                orch.on_tick().await;
                if let Some(w) = &ready.business {
                    use crate::business_watchdog::Activity;
                    let now = Instant::now();
                    if let Some(turn) = &orch.agent_turn {
                        let samples = turn.ctl.captured_samples();
                        if samples > 0 && business_last_played.map(|(id,count,_)| (id,count)) != Some((turn.id,samples)) {
                            w.progress(now); business_last_played = Some((turn.id,samples,now));
                        }
                    } else { business_last_played = None; }
                    // Initial provider/output gates have fixed deadlines. Later
                    // sentence connection allowance is anchored to actual PCM,
                    // never to this polling tick or an unfinished-task flag.
                    w.activity_until(Activity::Reply, orch.agent_turn.as_ref().filter(|t| !t.task.is_finished())
                        .map(|t| crate::business_runtime::reply_deadline(t.business_until,
                            business_last_played.filter(|(id,_,_)| *id == t.id).map(|(_,_,at)| at))));
                    w.activity_until(Activity::Command, orch.pending_cmd.as_ref()
                        .map(|p| p.sent_at + if p.accepted_acked { DEVICE_RESULT_DEADLINE * 3 } else { DEVICE_RESULT_DEADLINE }));
                    w.activity_until(Activity::Listening, orch.onboarding.as_ref().and_then(|o|o.deadline()));
                    w.activity_until(Activity::Search, orch.search.as_ref().and_then(|s| s.business_deadline()));
                    // Record the accepted terminal handoff before clearing the
                    // old input hold; the actual switch is applied next loop.
                    if orch.pending_phase_switch.is_some() { w.first_turn_to_rtc(now); }
                    let input_until = orch.ordered.as_ref().and_then(|o| match o.phase() {
                        crate::ordered_pcm::Phase::Idle if o.first_turn_rtc() && orch.input_phase == InputPhase::FirstTurn =>
                            orch.input_loop_started_at.and_then(|t| t.checked_add(Duration::from_millis(orch.cfg.ordered_begin_timeout_ms))),
                        crate::ordered_pcm::Phase::Receiving | crate::ordered_pcm::Phase::Ended => business_ordered_until,
                        _ => None,
                    });
                    w.activity_until(Activity::Input,input_until.map(|at| w.input_transition_deadline(at)));
                }
                if orch.ordered_end_stream_pending && orch.input_phase == InputPhase::Rtc {
                    orch.ordered_end_stream_pending = false; // B23:已切 RTC,忽略
                }
                if orch.ordered_end_stream_pending {
                    orch.ordered_end_stream_pending = false;
                    stt_pcm_tx.take();
                    if stt2.is_none() && orch.ordered.as_ref().map(|o| o.first_turn_rtc()).unwrap_or(false) {
                        stt2 = Some((spawn_stt(stt_cfg_for_room(&room_name), &room_name), Instant::now()));
                    }
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
        if orch.session_close.due(Instant::now()) {
            info!(room = %room_name, "session_exit_close: signal grace ended → closing job");
            break;
        }
    }

    orch.hard_abort_current();
    if let Some(search)=&mut orch.search {search.close();}
    if let Some(sp) = orch.spec.take() {
        sp.task.abort();
    }
    if let Some(o) = orch.ordered.as_mut() {
        // job 收尾时代次若未终态(设备断房/输出门 fail-closed)→ room_closed 终态,证据里不留悬空代次
        let _ = o.fail(crate::ordered_pcm::FailReason::RoomClosed);
        info!(room = %room_name, evidence = %o.evidence(), "ordered_pcm summary");
    }
    drop(stt_pcm_tx);
    for t in stt_tasks_done { t.abort(); }
    if let Some((pre, _)) = stt2.take() { pre.task.abort(); }
    let _ = tokio::time::timeout(Duration::from_secs(3), stt_task).await;
    info!(room = %room_name, "pipeline closed");
    match exit_error { Some(error) => Err(error), None => Ok(()) }
}

impl Orchestrator {
    /// B23:ordered 首句代次是否仍在消费 OPCM(RTC 帧丢弃)。Rtc 相位后 `ordered` 仍保留(收 receipt_done/证据),但不再吃帧。
    fn ordered_first_turn_active(&self) -> bool {
        self.ordered.is_some() && self.input_phase == InputPhase::FirstTurn
    }
    /// B23:请求切回 RTC(只在 v1 ∧ FirstTurn ∧ 未置位);主循环执行。
    fn request_phase_switch(&mut self, reason: String) {
        if self.input_phase == InputPhase::FirstTurn
            && self.ordered.as_ref().map(|o| o.first_turn_rtc()).unwrap_or(false)
            && self.pending_phase_switch.is_none()
        {
            self.pending_phase_switch = Some(reason);
        }
    }

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
    fn on_ordered_packet(&mut self, pkt: &crate::ordered_pcm::Packet, stt_tx: &Option<crate::asr_diagnostics::PcmSender>) -> usize {
        let mut submitted = 0;
        let now_ms = unix_ms_now();
        let was_idle = self.ordered.as_ref().map(|o| o.phase() == crate::ordered_pcm::Phase::Idle).unwrap_or(false);
        let mut acts = self.ordered.as_mut().map(|o| o.on_packet(pkt, now_ms)).unwrap_or_default();
        // B14 早 begin 对账：begin 被接受的时刻（相对管线启动；job 层 `input gate open` 行带 since-assignment）+ 设备钟原值
        if was_idle && self.ordered.as_ref().map(|o| o.phase() == crate::ordered_pcm::Phase::Receiving).unwrap_or(false) {
            info!(room = %self.room_name, since_pipeline_ms = self.now_ms() as u64, device_sent_at_ms = pkt.header.sent_at_ms.unwrap_or(0),
                  local_receipt = self.ordered.as_ref().map(|o| o.local_receipt_accepted()).unwrap_or(false),
                  "ordered_pcm begin accepted");
        }
        // 本地承接 v1：设备 end 被接受的时刻 = 正文门截止锚（worker 单调钟，不用设备 sent_at_ms）
        if self.ordered_end_seen_at.is_none() && self.ordered.as_ref().map(|o| o.end_seen()).unwrap_or(false) {
            self.ordered_end_seen_at = Some(Instant::now());
        }
        if let Some(o) = self.ordered.as_mut() {
            let more = o.drain_submits(|block| match stt_tx {
                Some(tx) => { let n = block.len(); let ok = tx.try_send(block).is_ok(); if ok { submitted += n; } ok },
                None => false,
            });
            acts.extend(more);
            // B14：首块真正进 ASR 队列的时刻（早 begin 的收益只能在这一点对撞，不能拿 begin 提前量机械相加）
            if o.note_submit_time(now_ms) {
                info!(room = %self.room_name, since_pipeline_ms = self.now_ms() as u64, "ordered_pcm first block submitted to ASR");
            }
        }
        self.apply_ordered_actions(acts);
        submitted
    }

    /// 代次动作:result 记日志(无 PCM/无文本)+ 出站(同 topic、OPCM 线格式、空 PCM);收流交主循环执行。
    fn apply_ordered_actions(&mut self, acts: Vec<crate::ordered_pcm::Action>) {
        for a in acts {
            match a {
                crate::ordered_pcm::Action::EndStream => self.ordered_end_stream_pending = true,
                // 本地承接 v1：端侧本地短语播完 → 放行正文门（轮未起时 Session 已记住，start_turn 让门一开始就是开的）
                crate::ordered_pcm::Action::ReleaseBody => {
                    let turn_active = self.local_receipt_release.is_some();
                    if let Some(tx) = &self.local_receipt_release {
                        let _ = tx.send(true);
                    }
                    info!(room = %self.room_name, turn_active, "ordered_pcm receipt_done accepted → body release");
                }
                crate::ordered_pcm::Action::Publish(v) => {
                    if v["t"] == "result" {
                        info!(room = %self.room_name, result = %v, "ordered_pcm result");
                        // B23:任何失败终态(cancel/timeout/missing_seq/...)也切 RTC——不重试、不重发、不 commit
                        if v["status"] == "failed" {
                            let r = v["reason"].as_str().unwrap_or("unknown").to_string();
                            self.request_phase_switch(format!("first_turn_failed:{r}"));
                        }
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
                self.request_phase_switch("first_turn_committed".into());
            }
            crate::ordered_pcm::Decision::NoTask(text, why) => {
                // B23/B25:纯唤醒/无内容——不进 LLM/TTS/垫句,不招呼(端侧本地 greet);同房等真正的问题。
                // reason 区分 wake_only(用户只叫了一声)与 no_final(供应商没给 final,不能断言没说话)。
                info!(room = %self.room_name, chars = text.chars().count(), reason = why.as_str(),
                      "ordered_pcm generation complete → no_task (不进 LLM)");
                self.request_phase_switch("first_turn_no_task".into());
            }
            crate::ordered_pcm::Decision::Discard(r) => {
                info!(room = %self.room_name, reason = r.as_str(), "ordered_pcm generation discarded (zero commit)");
                self.request_phase_switch(format!("first_turn_failed:{}", r.as_str()));
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

    /// B32-A(codex §3A):只给 `session.input_ready` 用的**真实发送结果**通道。
    /// 旧 `publish_json` 是 spawn 即返回,那行 `published` 只证明**排进了队**,不证明
    /// `publish_data` 成功;而失败原本只落 `debug!`,INFO 级 journal 里根本看不见。
    /// 这里 await 真结果并按 INFO/WARN 打出来。**不重发**:全函数只有一次 publish_data。
    fn publish_json_traced(&self, topic: &'static str, v: Value, event: &'static str, trace: String) {
        let p = self.participant.clone();
        // 字段定义(B44 坑二更正):since_pipeline_ms = 相对 cascade pipeline 启动(self.t0)的毫秒,
        // **不是**相对 job 受理(那是 input_loop_started 行的 elapsed_ms)。它是排队发送时点,
        // 不是发送完成时点,更不是设备已收到。完成耗时看 send_ms。
        let since_pipeline_ms = self.now_ms() as i64;
        tokio::spawn(async move {
            let packet = DataPacket {
                payload: v.to_string().into_bytes(),
                topic: Some(topic.to_string()),
                reliable: true,
                ..Default::default()
            };
            let t0 = Instant::now();
            let r = p.publish_data(packet).await;
            let send_ms = t0.elapsed().as_millis() as i64;
            let e = r.err().map(|e| e.to_string());
            emit_publish_result(event, &trace, since_pipeline_ms, send_ms, e.as_deref());
        });
    }

    /// B34-B:只由 turn 本身判定 filler/正文。
    /// `played_samples` 是 **Worker 排播进度**,不等于设备物理扬声器声源——
    /// 取值名里写 worker_ 前缀就是为了不让它被读成后者(codex B34 §2 P0-B)。
    fn playing_of(turn: &AgentTurn) -> &'static str {
        if !turn.ctl.audio_started() {
            "turn_no_audio_yet"
        } else if turn.filler_samples == 0 || turn.ctl.played_samples() >= turn.filler_samples {
            "worker_body"
        } else {
            "worker_filler"
        }
    }

    /// B34-C:判决点**立即**取证,不再等下一 PCM 帧。
    ///
    /// B33 的实现挂在输入环的 mic 分支上,靠「下一帧 ≤20ms」提交。可用户退出时上行会
    /// 立刻停,那条分支根本不再触发——于是**最需要取证的退出/打断恰好取不到**,把 B31
    /// 「房②零快照」原样复现一遍(codex B34 §2 P0-C,属实)。现在用 self 上的取证环当场落。
    ///
    /// 配额用尽也**照写事件**:没有文件不等于没有这次 ASR,那正是 B31 判不了的另一种形态。
    fn request_interrupt_snapshot(&mut self, decision: &'static str, reason: String) {
        if self.isnap.is_none() || self.snap.is_none() {
            return;
        }
        let now_ms = self.now_ms() as i64;

        // 现算的「此刻在播」。设备侧本地承接只标**门状态**:worker 只知道门没放行,
        // 并不知道设备扬声器此刻是否真在响,不冒充播放事实。
        let live = if let Some(t) = self.agent_turn.as_ref() {
            Some(crate::eot_snapshot::PlaybackCtx {
                turn_id: t.id as u64,
                playing: Self::playing_of(t),
                at_ms: now_ms,
            })
        } else if self.pending_local_receipt_deadline.is_some() && self.local_receipt_release.is_none() {
            Some(crate::eot_snapshot::PlaybackCtx {
                turn_id: 0,
                playing: "device_local_receipt_gate",
                at_ms: now_ms,
            })
        } else {
            None
        };
        let (ctx, ctx_source) = self.ctx_latch.resolve(live, now_ms, CTX_LATCH_MAX_AGE_MS);

        let Some((gate, taken, cap_max)) = self
            .isnap
            .as_mut()
            .map(|is| (is.try_take(), is.taken(), is.max_per_room()))
        else {
            return;
        };

        let pcm: Vec<i16> = match self.isnap_ring.as_ref() {
            Some(r) => r.iter().copied().collect(),
            None => Vec::new(),
        };
        // 窗口末端离判决多远(真实采样口径)。环里没样本时给 -1,不拿 0 冒充「刚采到」。
        let last_sample_age_ms = if pcm.is_empty() { -1 } else { now_ms - self.isnap_last_sample_ms };

        // 措辞按 codex B34 §2 收紧:snapshot 返回 seq 只代表**已排队** spawn_blocking,
        // 不代表 WAV 写完。落盘失败由 SnapshotSink 自己按 path(含 seq)告警,可关联。
        let capture = match gate {
            crate::eot_snapshot::Capture::Capped => "quota_capped".to_string(),
            crate::eot_snapshot::Capture::Go if pcm.is_empty() => "ring_empty".to_string(),
            crate::eot_snapshot::Capture::Go => match self.snap.as_mut().and_then(|s| s.snapshot(&pcm)) {
                Some(seq) => format!("queued:t{seq:04}"),
                None => "sink_capped".to_string(),
            },
        };

        let quota = format!("{taken}/{cap_max}");
        let turn_id_s = ctx.turn_id.to_string();
        let decide_s = now_ms.to_string();
        let samples_s = pcm.len().to_string();
        let age_s = last_sample_age_ms.to_string();
        if let Some(s) = self.snap.as_mut() {
            s.event_bg(
                "interrupt_snapshot",
                &[
                    ("decision", decision),
                    ("reason", &reason),
                    ("playing", ctx.playing),
                    ("turn_id", &turn_id_s),
                    ("ctx_source", ctx_source),
                    ("decide_ms", &decide_s),
                    ("capture", &capture),
                    ("samples", &samples_s),
                    ("last_sample_age_ms", &age_s),
                    ("quota", &quota),
                ],
            );
        }
        // 这条 info 同样不带 room(房名含 SN);对账用 events.jsonl 的 job(room_hash)。
        info!(
            decision,
            reason = %reason,
            playing = ctx.playing,
            turn_id = ctx.turn_id,
            ctx_source,
            capture = %capture,
            samples = pcm.len(),
            last_sample_age_ms,
            quota = %quota,
            "interrupt snapshot"
        );
    }

    fn now_ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }

    /// S1v3 触发器逐帧喂音频;fire → 起投机。
    async fn on_pf_frame(&mut self, samples: &[i16]) {
        let now_ms = self.now_ms();
        // B34-C:取证环在这里维护。诊断关 = isnap_ring 为 None = 不分配、不拷贝。
        if let Some(r) = self.isnap_ring.as_mut() {
            r.extend(samples.iter().copied());
            while r.len() > crate::eot_snapshot::SNAP_WINDOW {
                r.pop_front();
            }
        }
        if self.isnap_ring.is_some() {
            self.isnap_last_sample_ms = now_ms as i64;
        }
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
        if self.session_close.active() || self.onboarding.as_ref().is_some_and(|o|o.active()) { return; }
        if self.search_ack(&text,false){return;}
        let search_context=self.search.as_ref().and_then(|s|s.dialogue_context());
        if self.search_history_handoff.lock().unwrap_or_else(|e| e.into_inner()).is_some() { return; }
        if self.search.is_some() && crate::search_policy::intent(&text).is_some() { return; }
        // 吞句词不投机(codex 合同 §3.3「零 LLM」严格判据):急停/退出词的 interim 会先于
        // commit 触发 preflight→投机 LLM 白跑一次再被吞句分支作废——在源头跳过。
        if crate::textproc::is_turn_stop(&self.cfg.hotwords, &text)
            || crate::textproc::session_exit_speculation_blocked(&self.cfg.exit_hotwords, &text, self.cfg.exit_tail_match)
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
        let request_context=search_context.clone();
        let task = tokio::spawn(async move { llm::stream_chat_with_context(&client, &cfg, messages, tx,request_context).await });
        self.spec = Some(Speculation {
            search_context,
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
        // B12：TTS 预建连也提前到这里（原来在 start_turn 才起，commit 后要等 225–632 ms 握手）。
        if self.pending_tts_warm.is_none() {
            self.pending_tts_warm = Some(self.tts_cfg.start_prewarm());
        }
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
        self.search_user_speaking = gate.speaking() || active_frame;
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
        if self.onboarding.as_ref().is_some_and(|o|o.reject_asr()) { return; }
        if self.session_close.active() { return; }
        self.contract.user_transcript_interim();
        self.tr.user_interim(&t);
        self.tele_text = t.clone();
        let now_ms = self.now_ms();
        self.pf.on_interim(&t, now_ms);
        self.check_hotword(&t);
        self.latest_interim = t;
    }

    fn on_final(&mut self, t: String) {
        if let Some(o)=self.onboarding.as_ref() {
            let exit=crate::textproc::session_exit_path(&self.cfg.exit_hotwords,&t,self.cfg.exit_tail_match);
            match o.input_route(exit.is_some()) {
                crate::voice_onboarding::InputRoute::Drop => return,
                crate::voice_onboarding::InputRoute::Exit => {
                    self.contract.user_transcript_final(); self.tr.user_final(&t);
                    self.begin_session_exit(&t,exit.unwrap()); return;
                },
                crate::voice_onboarding::InputRoute::Ordinary => {},
            }
        }
        if self.session_close.active() { return; }
        self.contract.user_transcript_final();
        // B50 §4:门开着且非空 → 只轮换段 id 并缓冲,等 commit 裁决再发(见 caption_gate.rs)。
        // 门关着或空 final → 原路立即发(空 final 在端侧不启动等待,且 turn_gate 也不收它)。
        let seg = if self.caption_gate.enabled() && !t.is_empty() {
            Some(self.tr.take_seg_for_deferred_final())
        } else {
            None
        };
        match seg {
            Some(seg) => {
                let buffered = self.caption_gate.on_final(seg, &t);
                debug_assert!(buffered, "门开着且非空必然入缓冲");
            }
            None => self.tr.user_final(&t),
        }
        self.tele_text = t.clone();
        self.pf.reset(); // definite 提交后,下个句段重新允许投机
        self.check_hotword(&t);
        self.turn_gate.on_final(&t, Instant::now());
        self.latest_interim.clear();
        if let Some(s) = &mut self.snap {
            s.event("user_final", &[("text", &self.tele_text)]);
        }
    }

    /// B50 §5:把取证锚点写进 journal——只记事件名与样本偏移,**不带任何转写正文**。
    /// 窗口不存在时整条是 no-op。
    fn audit_marker(&self, event: &str) {
        if let Some(a) = self.audit.as_ref() {
            info!(event, offset_ms = a.marker_ms(), samples = a.samples(),
                  "audit capture marker");
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
            // B50 §5:这条走 interim 分支,绕过所有回声门(B49 §B.1),是最需要声学证据的一刻。
            // 不另开采集口——本轮窗口是连续的,这里只落**索引**(事件名+样本偏移,不带转写正文)。
            self.audit_marker("check_hotword_interrupt");
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
        let resume_delay = turn.ctl.interruption_resume_delay(self.cfg.false_interruption_timeout);
        if self.paused.is_none() {
            turn.ctl.pause();
            self.paused = Some(resume_delay);
            self.set_state(AgentState::Listening);
        } else {
            // Before the first frame keep the speech hold, but do not upgrade
            // it to the already-speaking false-interruption recovery timer.
            self.paused = Some(resume_delay);
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
        // D2 B5(2026-09-23):原话无设备词 → 暗号作废(env L2_REQUIRE_DEVICE_TEXT=0 可回退)
        let device_text = !crate::device_intent::l2_require_device_text()
            || crate::device_intent::l2_device_text(user_text);
        if let Err(reason) = crate::device_intent::l2_gate(
            self.l2_execute_on, self.l2_capable, label, fast_path_pending, has_trace, device_text,
        ) {
            info!(room = %self.room_name, label, reason, "llm device intent suppressed");
            // 2026-09-04(川哥拍板):被压制的标签 LLM 回复常已自称「调好了」(003「画面调到5米」实证)
            // → 固定纠正句追加在回复之后(say_after_current);不教词表原句(TTS 念出=自触发风险)。
            // D1(2026-09-22):批次=词表全集,纠正句只挂 unknown_label(表外标签),门在 device_intent::l2_fallback_hint。
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
        if self.session_close.active() && !matches!(&kind, control::Inbound::SessionExitAck | control::Inbound::Cancel) { return; }
        if self.onboarding.as_ref().is_some_and(|o|o.active()) && matches!(&kind,control::Inbound::CanarySay|control::Inbound::CommandWord{..}) { return; }
        match kind {
            control::Inbound::VoiceOnboarding => {
                if !self.onboarding.as_ref().is_some_and(|o|o.session.trusted_origin(ev,identity)) { return; }
                if matches!(ev.payload["action"].as_str(),Some("cancel"|"finish")) {
                    self.onboarding_deferred=None;
                }
                if ev.payload["action"] == "begin" && (self.agent_turn.is_some() || self.ordered_first_turn_active() || !self.turn_gate.pending().is_empty() || !self.latest_interim.is_empty()) {
                    if self.onboarding.is_some() && self.onboarding_deferred.is_none() { self.onboarding_deferred=Some((ev.clone(),identity.map(str::to_owned),Instant::now())); }
                    return;
                }
                if let Some(o)=self.onboarding.as_mut() { o.control(ev,identity,false); }
            },
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
            control::Inbound::InputReadyRequest { version } => {
                // B46 §4.1:校验链=开关 → sender 身份 → trace → 幂等 → 状态机。任何一环不过只记枚举,
                // **绝不**落到 ASR/LLM/greet/filler/设备命令/首句提交路径,也不新建或复活会话。
                let expected = crate::ordered_pcm::expected_device_identity(&self.room_name);
                let sender_ok = expected.is_some() && identity == expected.as_deref();
                let trace_ok = self.device_trace.as_deref() == Some(ev.trace_id.as_str());
                let decision: &str = if !self.cfg.ready_confirm_enabled {
                    "disabled"
                } else if !sender_ok {
                    "rejected_sender"
                } else if !trace_ok {
                    "rejected_trace"
                } else if version != 1 {
                    "rejected_version"
                } else if !self.ctrl_dedup.first_time(&ev.trace_id, ev.seq) {
                    "duplicate_seq"
                } else {
                    use crate::ready_confirm::Decision as D;
                    match self.ready_confirm.on_request(ev.seq) {
                        D::Disabled => "disabled",
                        D::Closed => "closed",
                        D::Pending => "pending",
                        D::AlreadyPending => "already_pending",
                        D::BudgetExhausted => "budget_exhausted",
                        D::Restated => {
                            // 真实 ready 已到:用**当初那次**的快照原样重述,不重算、不伪造
                            let s = self.ready_confirm.snapshot().cloned().expect("Restated 必有快照");
                            let rv = control::input_ready_restated(
                                &ev.trace_id,
                                now_unix_ms(),
                                &self.room_name,
                                self.output_gate.is_open(),
                                &control::ReadyTimings {
                                    issue_to_assignment_ms: s.issue_to_assignment_ms,
                                    job_room_connect_ms: s.job_room_connect_ms,
                                    track_to_input_loop_ms: s.track_to_input_loop_ms,
                                },
                                ev.seq,
                            );
                            self.publish_json_traced(control::TOPIC, rv, "session.input_ready.restated", ev.trace_id.clone());
                            "restated"
                        }
                    }
                };
                // 日志纪律(B46 §4.5):只记 trace / request_seq / decision / 预算;不带 room/SN/token/原始 payload
                info!(trace_id = %ev.trace_id, request_seq = ev.seq, version, decision,
                      budget_left = self.ready_confirm.budget_left(), "input_ready.request");
            }
            control::Inbound::Cancel => {
                if self.device_trace.as_deref()==Some(ev.trace_id.as_str()) { if let Some(o)=self.onboarding.as_mut(){o.cancel();} self.onboarding_deferred=None; }
                if let Some(search) = &mut self.search { search.suppress_auto_replay(); }
                // One-shot v0.3:显式取消对有序 PCM 代次立即生效(唯一终态;已 hold 的 final 作废;收流经 pending 标志传导)
                if self.ordered.is_some() {
                    let acts = self.ordered.as_mut().map(|o| o.fail(crate::ordered_pcm::FailReason::Cancelled)).unwrap_or_default();
                    self.apply_ordered_actions(acts);
                }
                // v140 §4.3:Android 本地 exact 先命中会先发既有 cancel——cancel 亦为退出
                // 信令终态,停重试(不得形成重试风暴)。
                let terminated_exit_signal = self.exit_pending.take().is_some();
                if terminated_exit_signal {
                    info!(room = %self.room_name, "session_exit signal terminated by cancel");
                }
                // B48 §3:cancel **默认是「停」**——只打断在说的 turn,会话与输入管线都还在,
                // 补确认能力原封不动(把所有 cancel 置终态会损坏「停了还能接着聊」)。
                // 唯一例外:它终结了在途退出信令(v140 §4.3 Android 本地 exact 先命中),那是退出终态。
                self.ready_confirm.apply(crate::ready_confirm::cancel_lifecycle(terminated_exit_signal));
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

    fn search_ack(&self,text:&str,input_continues:bool)->bool {
        self.search_turn&&self.agent_turn.as_ref().is_some_and(|t|self.search.as_ref().is_some_and(|s|s.accepts_ack(text,t.ctl.audio_started(),input_continues)))
    }
    fn hard_abort_current(&mut self) {
        if self.deferred_say.clear_on_abort() {
            info!(room = %self.room_name, "deferred device reply dropped (turn aborted)");
        }
        let Some(turn) = self.agent_turn.take() else {
            return;
        };
        let was_search = std::mem::take(&mut self.search_turn);
        // B34-B:在这里把「abort 之前在播什么」抄一份。普通 commit 与 STOP/EXIT 都是
        // **先 abort 再登记**,等登记时 turn 已被 take 走,现算只会得到 none/turn_id=0,
        // 恰好在 B31「是的」那类新轮上失真。**只抄不改**,中断执行顺序一行没动。
        if self.isnap.is_some() {
            let at_ms = self.now_ms() as i64;
            self.ctx_latch.stash(crate::eot_snapshot::PlaybackCtx {
                turn_id: turn.id as u64,
                playing: Self::playing_of(&turn),
                at_ms,
            });
        }
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
        if was_search {
            if let Some(search) = &mut self.search {
                if let Some(p)=&turn.search_progress {let complete=p.lock().unwrap_or_else(|e|e.into_inner()).complete(turn.ctl.captured_samples(),false);search.finish_sentences(true,complete,played/24);}
                else {search.finish_with_progress(true, spoken.chars().count(), played as u64 / 24, sentence_spans(&synth, &progress).iter().any(|s| played >= s.end_samples));}
            }
        } else {
            self.pending_amend = Some(spoken);
        }
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
        if let Some(p)=&turn.search_progress {
            let complete=p.lock().unwrap_or_else(|e|e.into_inner()).complete(turn.ctl.captured_samples(),false);
            if let Some(search)=&mut self.search {search.record_sentences(complete,None);}
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
        if turn.seg_stage >= 2 || !turn.ctl.audio_started() {
            return;
        }
        if turn.filler_samples == 0 {
            // B12：无垫句（跳过或未选中）时，首帧即正文首帧——这是「跳垫句后静默多久」的真值口径。
            turn.seg_stage = 2;
            if self.search_turn {
                if let Some(search) = &self.search { search.log_audio_started(&room, turn.id); }
            }
            info!(room = %room, turn_id = turn.id, since_turn_ms = turn.started.elapsed().as_millis() as u64,
                  "body first frame published (no filler)");
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
            if self.search_turn {
                if let Some(search) = &self.search { search.log_audio_started(&room, turn.id); }
            }
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
                if std::mem::take(&mut self.search_turn) {
                    let spoken = self.agent_turn.as_ref().filter(|t| t.ctl.played_samples() > 0)
                        .and_then(|t| t.synth_text.lock().ok().map(|s| s.chars().count())).unwrap_or(0);
                    if let Some(search) = &mut self.search {
                        if let Some(turn)=&self.agent_turn {if let Some(p)=&turn.search_progress {
                            let p=p.lock().unwrap_or_else(|e|e.into_inner());let complete=p.complete(turn.ctl.captured_samples(),true);
                            search.finish_sentences(complete<p.sentences.len(),complete,turn.ctl.captured_samples()/24);
                        }else{search.finish(false,spoken);}}
                    }
                }
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

    /// tick 唯一出口包装(B50 §4):`on_tick_inner` 有 8 条 return,把字幕裁决的落地放在这里,
    /// 任何一条 return 都绕不过去——将来新增 return 分支自动继承默认判决 Publish。
    async fn on_tick(&mut self) {
        self.poll_exit_signal();
        if self.session_close.active() { return; }
        self.on_tick_inner().await;
        self.flush_caption_finals();
        if self.session_close.active() { return; }
        let input_pending = self.search_user_speaking || !self.turn_gate.pending().is_empty()
            || !self.latest_interim.is_empty();
        if let Some(search) = &mut self.search { search.observe_input(input_pending); }
        let safe = self.agent_turn.is_none() && self.state == AgentState::Listening
            && !self.search_user_speaking && self.turn_gate.pending().is_empty()
            && self.latest_interim.is_empty() && self.pending_cmd.is_none() && !self.ordered_first_turn_active();
        let speech = self.search.as_mut().and_then(|s| s.poll(safe));
        if self.search.as_mut().map(|s| s.take_revoked()).unwrap_or(false) && self.search_turn {
            self.hard_abort_current();
        }
        if let Some(text) = speech {
            let pcm=self.search.as_ref().and_then(|s|s.active_receipt_pcm());
            self.start_turn(match pcm {Some(pcm)=>TurnKind::BackgroundClip(text,pcm),None=>TurnKind::BackgroundSay(text)});
        }
    }

    /// B52 §6.2:回声门判掉一条 commit 时的**唯一**字幕落点。控制出口(急停/退出/设备命令)
    /// 即便被吞也必须把 LOCAL final 发出去,否则端侧失去控制通道。
    /// 三个回声门都只调这个函数,`mark_echo_drop` 在 pipeline 里没有第二个调用点——
    /// 新增回声门只要走它就自动继承这条豁免。
    fn echo_drop_caption(&mut self, user_text: &str, gate: &'static str) {
        // B52:`poll_commit` 交出来的是**合并后**的整句;「停」可能只是被合并进去的其中一条
        // final,合并文本判不出来。判定取「合并文本 **或** 任一条原始 final」——保守方向:
        // 宁可多留一批可见字幕,不可静默砍掉控制出口。
        let mut outlet = crate::caption_gate::control_outlet_kind(
            user_text,
            &self.cfg.hotwords,
            &self.cfg.exit_hotwords,
            self.cfg.exit_tail_match,
        );
        if outlet.is_none() {
            for t in self.caption_gate.buffered_texts() {
                outlet = crate::caption_gate::control_outlet_kind(
                    &t,
                    &self.cfg.hotwords,
                    &self.cfg.exit_hotwords,
                    self.cfg.exit_tail_match,
                );
                if outlet.is_some() {
                    break;
                }
            }
        }
        if !self.caption_gate.mark_echo_drop(outlet) {
            info!(room = %self.room_name, gate, outlet = outlet.unwrap_or("-"),
                  "caption kept: 控制出口被回声门吞掉,但 LOCAL final 仍发给端侧");
        }
    }

    /// 字幕裁决落地。Hold=本 tick 没裁决,缓冲原样留着。
    fn flush_caption_finals(&mut self) {
        use crate::caption_gate::Flush;
        match self.caption_gate.take_flush() {
            Flush::Hold => {}
            Flush::Publish(v) => {
                let n = v.len();
                self.tr.publish_deferred_batch(&v, false);
                info!(room = %self.room_name, segments = n,
                      published_total = self.caption_gate.published_total(),
                      dropped_total = self.caption_gate.dropped_total(),
                      "caption final published (deferred)");
            }
            Flush::Drop(v) => {
                // B52:不发内容,但要把段收尾——否则 on_interim 已发的文本会永远挂在端侧。
                let n = v.len();
                self.tr.publish_deferred_batch(&v, true);
                info!(room = %self.room_name, segments = n, retracted = n,
                      published_total = self.caption_gate.published_total(),
                      dropped_total = self.caption_gate.dropped_total(),
                      "caption final suppressed (echo; 已发空 final 撤回 interim 并收尾)");
            }
        }
    }

    fn poll_exit_signal(&mut self) {
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
    }

    fn begin_session_exit(&mut self, text: &str, path: &str) {
        if let Some(o)=self.onboarding.as_mut(){o.cancel();} self.onboarding_deferred=None;
        if !self.session_close.begin(Instant::now()) { return; }
        if let Some(lc) = crate::ready_confirm::swallow_lifecycle("session_exit") { self.ready_confirm.apply(lc); }
        self.hard_abort_current();
        if let Some(mut search) = self.search.take() { search.close(); }
        if let Some(sp) = self.spec.take() { sp.task.abort(); }
        self.pending_tts_warm = None;
        self.false_deadline = None;
        self.paused = None;
        self.resume_grace = None;
        self.latest_interim.clear();
        self.tele_text.clear();
        self.pf.reset();
        if self.exit_signal_on {
            if let Some(trace) = self.device_trace.clone() {
                self.exit_seq += 1;
                let rk = crate::textproc::exit_reply_kind(text);
                let env = control::session_exit_detected(&trace, now_unix_ms(), self.exit_seq, rk, path);
                self.publish_json(control::TOPIC, env.clone());
                self.exit_pending = Some(ExitSignalPending {
                    seq: self.exit_seq, sent_at: Instant::now(), attempts: 1, envelope: env,
                });
                info!(room = %self.room_name, seq = self.exit_seq, reply_kind = rk, path, "session_exit signal sent");
            } else {
                info!(room = %self.room_name, "session_exit signal skipped: no session trace");
            }
        }
        info!(room = %self.room_name, path, grace_ms = crate::session_close::SIGNAL_GRACE.as_millis(),
            "session_exit close armed");
    }

    async fn on_tick_inner(&mut self) {
        if self.onboarding_deferred.as_ref().is_some_and(|(_,_,at)|at.elapsed()>=Duration::from_secs(9)){self.onboarding_deferred=None;}
        if self.agent_turn.is_none() && !self.ordered_first_turn_active() && self.turn_gate.pending().is_empty() && self.latest_interim.is_empty() {
            if let Some((ev,identity,_))=self.onboarding_deferred.take() { if let Some(o)=self.onboarding.as_mut(){o.control(&ev,identity.as_deref(),false);} }
        }
        let onboarding_states=if let Some(o)=self.onboarding.as_mut(){o.poll().await}else{vec![]};
        for state in onboarding_states { self.publish_json(control::TOPIC,state); }

        // One-shot v0.3:有序 PCM 代次超时(begin 后无 end)→ 整代失败终态
        if self.ordered.is_some() {
            let now_ms = unix_ms_now();
            let acts = self.ordered.as_mut().map(|o| o.on_tick(now_ms)).unwrap_or_default();
            self.apply_ordered_actions(acts);
        }
        // B23:产品首句 v1——input_ready 后 ordered_begin_timeout_ms 内没有 begin = 端侧没走首句(旧客户端/开关关)
        // → 切 RTC 当普通会话;切换块会把代次关成 timeout 终态,迟到 begin 一律拒绝。
        let begin_timed_out = self.input_phase == InputPhase::FirstTurn
            && self.ordered.as_ref().map(|o| o.first_turn_rtc() && o.phase() == crate::ordered_pcm::Phase::Idle).unwrap_or(false)
            && self.input_loop_started_at
                .map(|t| t.elapsed() > Duration::from_millis(self.cfg.ordered_begin_timeout_ms))
                .unwrap_or(false);
        if begin_timed_out {
            info!(room = %self.room_name, timeout_ms = self.cfg.ordered_begin_timeout_ms, "ordered_pcm begin timeout → rtc (端侧未走首句)");
            self.request_phase_switch("begin_timeout".into());
        }
        // cancel 掉的 canary:turn.task.abort() 后 BufferWatch Drop 异步落槽,tick 兜底补发
        self.try_flush_canary_metrics();
        let now = Instant::now();
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
                    info!(room = %self.room_name, search_result=self.search_turn,
                        pending_chars=self.turn_gate.pending().chars().count(),
                        interim_chars=self.latest_interim.chars().count(),
                        "resumed false interrupted speech");
                }
                self.contract.false_interruption();
            }
        }
        // 判停提交
        if let Some(commit) = self.turn_gate.poll_commit(now) {
            let user_text = commit.text;
            // B50 §4:裁决已发生 → 默认「这句有资格被处理」,字幕照发。
            // 只有下面三处回声门会改判 Drop;其余 return 分支(STOP/EXIT 吞句、设备命令、
            // 账本压制、音量提示、普通 LLM 轮)自动继承 Publish——控制出口不得被当回声删掉。
            self.caption_gate.on_commit_decided();
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
                // B68 §3.2(修 B63 §7.2 的洞):控制出口分类**先于**两道开场回声门,与下方 swallow_kind
                // 用同一把尺子(`caption_gate::control_outlet_kind`)——不在这里另抄一套词表。
                // 判定对象=`poll_commit` 合并后的整句:单条「停」被合并进长句时,这里与 STOP 出口
                // 同样不认,是既有限制不是本轮引入。只在开场窗内算,窗外路径逐字不变。
                let control_outlet = crate::caption_gate::control_outlet_kind(
                    &user_text,
                    &self.cfg.hotwords,
                    &self.cfg.exit_hotwords,
                    self.cfg.exit_tail_match,
                );
                // 分层判定(单字一律吞 / 2-3字精确子串 / ≥4字 LCS)连同控制出口豁免抽在
                // textproc::opening_echo_verdict,锚测试全覆盖。调用点必须显式传 control_outlet,绕不过去。
                // 2026-09-01 00:53 实证:EOU 把回声切成「来啦」(2字)+「刚打了个盹儿」,
                // 后者被拦、前者穿过旧 len≥4 下限起了幽灵轮——短碎片层由此补上。
                // 01:00 实证第二形态:「来啦」被 ASR 错转成「那」(la→na)——子串判定对
                // 错转结构性无效,故开场窗内**非控制单字 commit 一律吞**:EOU+错转可产出任意单字,
                // 开场窗内单字成句语义≈0。
                // ⚠️ 此处旧注释「急停单字在此被吞与 stop_only 效果等价」是假的(B63 §7.2):STOP 出口会
                // 无条件硬停在途轮(含 paused 待续播的)并作废投机生成,本门只在下面的追杀条件下 abort。
                // 所以控制单字必须放行到 STOP/EXIT 出口,不能在此吞——否则开场 15 秒内轻声说「停」,
                // 字幕发了、在途播放不停,假打断超时后还会续播。
                let hit = {
                    let bank = self.echo_local_texts.lock().unwrap();
                    // R15: a real result can start before the greeting echo window
                    // expires. Exact, ended result acknowledgments must reach the
                    // search-only continue branch below; ordinary input keeps the
                    // original echo verdict and controls keep their priority.
                    crate::textproc::opening_echo_with_search_ack(
                        &nu, &bank, control_outlet,
                        self.search_ack(&user_text, self.search_user_speaking),
                    ).map(str::to_string)
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
                    self.request_interrupt_snapshot("swallowed", format!("local_audio_echo:{slot}"));
                    // B50 §4 / B52 §6.2:判回声 → 丢本批 final 字幕;但控制出口除外(见 echo_drop_caption)
                    self.echo_drop_caption(&user_text, "local_audio");
                    self.audit_marker("echo_gate_local_audio");
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
                    && !commit.input_ended // B23:ordered 首句代次结构性无 VAD 起点且端侧未播招呼语,不进放宽分支
                    && crate::textproc::overlap_vadless_qualifies(vad_onset_seen)
                {
                    let speech_end_ms = unix_ms_now() - commit.eou_delay.as_millis() as i64;
                    // B68 §3.2:同一个 control_outlet 也守这道门。下面三条内联豁免保留(EXIT_TAIL_MATCH=0
                    // 时 control_outlet 不含 tail,它们仍是唯一守 tail 的);新增的是 exit 精确词——
                    // 「不用了」对「你来了故事继续」LCS 0.33 ≥ 0.3,旧代码在无 VAD 起点的首句上会把它吞掉。
                    if control_outlet.is_none()
                        && speech_end_ms <= deadline
                        && crate::device_intent::match_command(&user_text).is_none()
                        && crate::device_grammar::executable(&user_text).is_none()
                        && !crate::textproc::is_turn_stop(&self.cfg.hotwords, &user_text)
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
                            self.request_interrupt_snapshot("swallowed", format!("local_audio_echo_overlap:{slot}"));
                            // B50 §4 / B52 §6.2:同上(开场重叠窗)
                            self.echo_drop_caption(&user_text, "overlap");
                            self.audit_marker("echo_gate_overlap");
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
            let swallow_kind = if let Some(path) = crate::textproc::session_exit_path(&self.cfg.exit_hotwords, &user_text, self.cfg.exit_tail_match) {
                    Some(("session_exit", path))
                } else if crate::textproc::is_turn_stop(&self.cfg.hotwords, &user_text) {
                    Some(("stop_only", "exact"))
                } else { None };
            if let Some((kind, path)) = swallow_kind {
                if let Some(search) = &mut self.search { search.suppress_auto_replay(); }
                info!(room = %self.room_name, path, "{kind} utterance swallowed: '{user_text}'");
                // B48 §3:停 vs 退出的分水岭。stop_only=只打断,补确认能力不变;
                // session_exit=会话终态,此后迟到的补确认查询一律 Closed(不登记 pending、不重述)。
                // ⚠️ 终态判定**不受 exit_signal_on 门控**:吞句面即判定面,信令发不发是另一回事。
                if let Some(lc) = crate::ready_confirm::swallow_lifecycle(kind) {
                    self.ready_confirm.apply(lc);
                }
                if kind == "session_exit" { self.begin_session_exit(&user_text, path); }
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
                self.request_interrupt_snapshot("swallowed", format!("{kind}:{path}"));
                return;
            }
            if self.onboarding.as_ref().is_some_and(|o|o.active()) {
                let was_exit=self.onboarding.as_ref().is_some_and(|o|o.session.state["stage"]=="waiting_exit");
                if let Some(o)=self.onboarding.as_mut(){o.answer(&user_text);}
                if !was_exit { self.latest_interim.clear(); self.tele_text.clear(); return; }
            }
            if self.search_ack(&user_text,self.search_user_speaking) {
                if let Some(sp)=self.spec.take(){sp.task.abort();}
                if self.paused.take().is_some(){if let Some(t)=&self.agent_turn {t.ctl.resume();}}
                self.false_deadline=None;self.latest_interim.clear();self.tele_text.clear();
                info!(room=%self.room_name,"background search acknowledgment continued: no chat or new task");
                self.request_interrupt_snapshot("swallowed","search_ack:exact".into());
                return;
            }
            // 播放中附和词(2026-09-14 川哥):小可正在播长文本时,孩子随口「嗯/对/是」是在听不是插话——
            // 不 commit、不起 LLM、不投机,只记日志;控制词在上面的吞句分支已先行,这里永远轮不到「停/退出」。
            // 位置=急停/退出之后、TTS 回声对撞之前。observe 只记候选行为不变;enforce 才真吞并续播。
            let backchannel = match &self.agent_turn {
                Some(turn) if !turn.task.is_finished() => {
                    let reply_chars = turn.llm_chars.load(AtomicOrdering::Relaxed);
                    Some((self.cfg.backchannel.decide(&user_text, reply_chars), reply_chars, turn.ctl.played_samples(), turn.ctl.clone()))
                }
                _ => None,
            };
            if let Some((decision, reply_chars, played_samples, ctl)) = backchannel {
                match decision {
                    crate::backchannel::Decision::NotCandidate => {}
                    crate::backchannel::Decision::Observe => {
                        info!(room = %self.room_name, text = %user_text, reply_chars, played_samples,
                              "backchannel candidate (observe): would ignore, behavior unchanged");
                    }
                    crate::backchannel::Decision::Ignore => {
                        info!(room = %self.room_name, text = %user_text, reply_chars, played_samples,
                              "backchannel utterance ignored (long reply playing): no commit, no llm, resume");
                        if let Some(sp) = self.spec.take() {
                            sp.task.abort(); // 附和词的投机生成作废(否则空转一轮 LLM 还落库)
                        }
                        if self.paused.take().is_some() {
                            ctl.resume();
                            self.resume_grace = Some(Instant::now() + Duration::from_millis(250));
                            self.set_state(AgentState::Speaking);
                        }
                        self.false_deadline = None;
                        self.latest_interim.clear();
                        self.tele_text.clear();
                        if let Some(s) = &mut self.snap {
                            s.event("swallowed", &[("text", &user_text), ("kind", "backchannel"), ("path", "exact")]);
                        }
                        self.request_interrupt_snapshot("swallowed", "backchannel:exact".to_string());
                        return;
                    }
                }
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
                        self.request_interrupt_snapshot("swallowed", "tts_echo_substring".to_string());
                        self.latest_interim.clear();
                        self.tele_text.clear();
                        // B50 §4 / B52 §6.2:同上(TTS 子串门)
                        self.echo_drop_caption(&user_text, "tts_substring");
                        self.audit_marker("echo_gate_tts_substring");
                        return;
                    }
                }
            }
            // S2-B2 设备命令轮(合同处理序 EXIT→STOP→DEVICE→LLM,禁止改序):
            // 确定性匹配命中 → 发 proposed、零 UserTurnCommitted、零 filler、零 LLM,
            // 等 Android result 播固定短句。范围外音量 → 固定提示,零事件零执行。
            if self.device_commands_on {
                // D2 语法层 L1g(2026-09-23,川哥拍板):词表精确未中 → 语法判(device_grammar,对象+方向+程度,只认结构);
                // DEVICE_GRAMMAR_MODE=observe 只记日志(默认,观察 3~5 天),execute 与 L1 完全同链路,lane 标 L1g。
                let (matched, lane): (Option<crate::device_intent::DeviceMatch>, &'static str) =
                    match crate::device_intent::match_command(&user_text) {
                        Some(m) => (Some(m), "L1"),
                        None => match crate::device_grammar::judge(&user_text) {
                            Ok(hit) => {
                                let mode = crate::device_grammar::mode();
                                info!(room = %self.room_name, label = hit.label, action = %hit.action, domain = hit.domain,
                                      mode = mode.as_str(), modal = hit.modal, text_len = user_text.chars().count(),
                                      "device grammar hit: '{user_text}' → '{}'", hit.peeled);
                                if mode == crate::device_grammar::Mode::Execute {
                                    (hit.command().map(crate::device_intent::DeviceMatch::Command), "L1g")
                                } else {
                                    (None, "L1")
                                }
                            }
                            Err(reason) => {
                                // D2.1 观察(2026-09-23 川哥「通过日志而不是通过大模型观察」):带设备词却被语法层否决的句子记一行;
                                // 原因前缀 time_future / place / statement_le 是 20 槽体检新增的三道否决,后台卡按原因计数,
                                // 并与 60 s 内同房同句的慢路提案对账(否决了但大模型开火 = 分歧,人工看)。
                                if reason != "empty" && crate::device_intent::l2_device_text(&user_text) {
                                    info!(room = %self.room_name, reason = %reason, mode = crate::device_grammar::mode().as_str(),
                                          text_len = user_text.chars().count(), "device grammar veto: '{user_text}'");
                                }
                                (None, "L1")
                            }
                        },
                    };
                match matched {
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
                        self.start_device_command(cmd, &user_text, lane, candidate, "asr", utterance);
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
            // B32-B:被 commit 的那一段也要能关联到音频本体(B31 里「是的」判不了就栽在这)
            self.request_interrupt_snapshot("committed", format!("eou:{}ms", commit.eou_delay.as_millis()));
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
            if let Some(search) = &mut self.search {
                search.on_commit();
                if let Some(action) = search.interpret(&user_text) {
                    // Preserve any prior ordinary-turn history amendment for the next ordinary reply.
                    self.pending_amend = amend;
                    if let Some(old) = self.spec.take() { old.task.abort(); }
                    let handoff=search.take_history_handoff();
                    if search.command(action) {
                        if let Some(question)=handoff {
                            *self.search_history_handoff.lock().unwrap_or_else(|e|e.into_inner())=Some((self.next_turn_id,question));
                        }
                    }
                    self.set_state(AgentState::Listening);
                    return;
                }
            }
            // S1v3 投机核销:提交文本全等 + 历史版本未变 → 复用;否则作废。
            // try_lock 同 start_speculation 的死锁红线:锁被回复流持着(上一轮孙任务
            // 尚未退出)时当 miss 丢投机,绝不阻塞主循环。
            let spec = match self.spec.take() {
                Some(sp) => match self.llm.try_lock() {
                    Ok(llm_guard) => {
                        let ver_now = llm_guard.history_version();
                        drop(llm_guard);
                        if sp.text == user_text && sp.version == ver_now && sp.search_context==self.search.as_ref().and_then(|s|s.dialogue_context()) {
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
            let shortest = (self.cfg.ordered_filler_shortest && commit.input_ended
                || self.cfg.tts_latency_v1 && self.search.is_some()) && !boost;
            // B11：投机命中 = LLM 已在流、TTS 首块 ≈0.3 s 内到——垫句反而成了唯一等待（真机 …1683：正文 +297 ms 就绪等到 +999）。
            let spec_lead_ms = spec.as_ref().map(|sp| sp.started.elapsed().as_millis() as u64).unwrap_or(0);
            // B12：投机「跑了多久」≠ 正文就绪（真机 …1684 跳了垫句仍静默 1.04 s）。改为三条件：
            // LLM 流已结束（首句文本必在）∧ TTS 预建连已完成（握手不再占 commit 后时间）∧ lead ≥ 门；否则照播最短垫句。
            let spec_done = spec.as_ref().map(|sp| sp.task.is_finished()).unwrap_or(false);
            let tts_warm_ready = self.pending_tts_warm.as_ref().map(|w| w.is_finished()).unwrap_or(false);
            let skip_filler = self.cfg.ordered_skip_filler_on_spec && commit.input_ended && !boost && spec.is_some()
                && spec_done && tts_warm_ready && spec_lead_ms >= self.cfg.ordered_skip_filler_min_lead_ms;
            // 本地承接 v1（2026-09-09 川哥拍板）：begin 声明 ∧ 房已签 ∧ 开关开 → 端侧自己播承接短语；
            // 本轮不播垫句，正文 PCM 扣到端侧 receipt_done 或截止（end 到达 + MAX_MS，到点放行）。投机/预热照常。
            // B23:首句逗号切默认只对 ordered 首句轮(未签设备零变化);env TTS_FIRST_CLAUSE_ORDERED_ONLY=0 才全局
            self.turn_first_clause_min = if commit.input_ended || !self.cfg.tts_first_clause_ordered_only { self.cfg.tts_first_clause_min } else { 0 };
            let lr_accepted = commit.input_ended && self.ordered.as_ref().map(|s| s.local_receipt_accepted()).unwrap_or(false);
            // B14（codex B13 回执 §1）：端侧候选未成立走旧收尾时发 receipt_done played_ms=0 = 「我没播」。commit 前已知 →
            // 退回 worker 自己的垫句路径，不然孩子从说完到正文全程无声；commit 后才到 → 门已在，只放行。
            let lr_declined = lr_accepted && self.ordered.as_ref().map(|s| s.receipt_done_declined()).unwrap_or(false);
            if lr_declined {
                info!(room = %self.room_name, "local receipt declined by device (receipt_done played_ms=0 before commit) → worker filler path");
            }
            let local_receipt = lr_accepted && !lr_declined;
            if self.cfg.ordered_skip_filler_on_spec && commit.input_ended && spec.is_some() && !skip_filler && !local_receipt {
                info!(room = %self.room_name, spec_lead_ms, spec_done, tts_warm_ready, "filler kept: body not imminent");
            }
            let filler = if local_receipt {
                let deadline = self.ordered_end_seen_at.unwrap_or_else(Instant::now)
                    + Duration::from_millis(self.cfg.ordered_local_receipt_max_ms);
                self.pending_local_receipt_deadline = Some(deadline);
                info!(room = %self.room_name, spec_lead_ms, spec_done, tts_warm_ready,
                      receipt_done_seen = self.ordered.as_ref().map(|s| s.receipt_done_seen()).unwrap_or(false),
                      max_ms = self.cfg.ordered_local_receipt_max_ms,
                      "filler skipped: device local receipt (body gated until receipt_done/deadline)");
                None
            } else if skip_filler {
                info!(room = %self.room_name, spec_lead_ms, spec_done, tts_warm_ready, "filler skipped: ordered + speculation hit (body imminent)");
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
        if self.onboarding.as_ref().is_some_and(|o|o.active()) { return; }
        if self.session_close.active() { return; }
        let record_history = !matches!(&kind, TurnKind::BackgroundSay(_) | TurnKind::BackgroundClip(..));
        self.search_turn = !record_history;
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
        let output_open = self.output_gate.is_open();
        let business_until = crate::business_runtime::reply_startup_deadline(turn_started,
            !output_open, self.pending_local_receipt_deadline);
        let pcm_rx = if output_open {
            pcm_rx
        } else {
            self.output_gate.wrap(pcm_rx, self.fatal_tx.clone())
        };
        // 本地承接 v1：正文门（截止即放行）。包在输出门外侧：输出门语义不变，正文门只扣住已过输出门的可听 PCM；
        // 本轮无垫句（commit 分支已置 None），管道里全是正文。receipt_done 已先到 → 门一开始就是开的。
        let pcm_rx = match self.pending_local_receipt_deadline.take() {
            Some(deadline) => {
                let already = self.ordered.as_ref().map(|s| s.receipt_done_seen()).unwrap_or(false);
                let (rtx, rrx) = tokio::sync::watch::channel(already);
                self.local_receipt_release = Some(rtx);
                crate::gate::wrap_local_receipt(pcm_rx, rrx, deadline, self.room_name.clone(), id)
            }
            None => pcm_rx,
        };
        let (playout_task, ctl) =
            playout::spawn_playout(self.source.clone(), pcm_rx, self.room_name.clone(), id);
        let search_progress=if let TurnKind::BackgroundSay(text)=&kind {if self.search.as_ref().is_some_and(|s|s.sentence_progress_enabled()){Some(Arc::new(StdMutex::new(crate::search_progress::SearchProgress::new(text))))}else{None}}else{None};
        let search_progress_task=search_progress.clone();
        let search_context=self.search.as_ref().and_then(|s|s.dialogue_context());
        let synth_text = Arc::new(StdMutex::new(String::new()));
        let progress = Arc::new(StdMutex::new(Vec::new()));
        let llm_chars = Arc::new(AtomicUsize::new(0));

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
        let search_history_handoff = self.search_history_handoff.clone();
        let room_name = self.room_name.clone();
        let ev_tx = self.turn_ev_tx.clone();
        let min_len = self.cfg.tts_min_sentence_len;
        let first_clause_min = self.turn_first_clause_min;
        let synth2 = synth_text.clone();
        let prog2 = progress.clone();
        let llm_chars2 = llm_chars.clone();
        let lp = self.participant.clone();
        // 合成侧要能看见打断信号(讯飞在 pause 期间不能裸 send,见 tts_xfyun::send_or_abort);
        // ctl 本体后面还要交给 AgentTurn,这里克隆一份进 task。
        let ctl_tts = ctl.clone();
        // turn 一开始就起预建连流水线:它与下面的 LLM 请求并行跑,
        // 等第一句文本出来时握手早已完成 → 首句省掉 ~220ms 建连。
        // (火山线返回关闭态,行为不变)
        // B12：held final 时已预热的连接优先；没有就按原样现起。
        let mut warm = if matches!(&kind,TurnKind::BackgroundClip(..)) {
            // Prepared PCM needs no provider connection. Drop any unused prewarm.
            self.pending_tts_warm.take();
            crate::tts::Prewarm::off()
        } else {self.pending_tts_warm.take().unwrap_or_else(|| tts_cfg.start_prewarm())};

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
                TurnKind::BackgroundClip(text, pcm) => {
                    track(&text,pcm.len());
                    let _ = pcm_tx.send(pcm).await;
                    drop(pcm_tx);
                    let _ = playout_task.await;
                    watcher.abort();
                    let _ = ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
                TurnKind::BackgroundSay(text) if search_progress_task.is_some() => {
                    // Register the entire trusted result before awaiting a socket or any PCM.
                    if let Ok(mut t)=synth2.lock(){*t=text.clone();}
                    let tracker=search_progress_task.as_ref().unwrap();
                    let sentences=tracker.lock().unwrap_or_else(|e|e.into_inner()).sentences.clone();
                    let mut chars=0usize;let mut samples=0u64;
                    for sentence in sentences {
                        if ctl_tts.aborted(){break;}
                        match tts_cfg.synthesize(&sentence,&pcm_tx,&ctl_tts,&mut warm).await {
                            Ok((_,bytes)) if !ctl_tts.aborted() && bytes>0 => {
                                chars+=sentence.chars().count();samples+=(bytes/2) as u64;
                                tracker.lock().unwrap_or_else(|e|e.into_inner()).synthesized((bytes/2) as u64);
                                if let Ok(mut p)=prog2.lock(){p.push((chars,samples));}
                            },
                            _=>break,
                        }
                    }
                    drop(pcm_tx);let _=playout_task.await;watcher.abort();let _=ev_tx.send(TurnEvent::PlayedOut(id)).await;
                }
                TurnKind::Say(text) | TurnKind::BackgroundSay(text) => {
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
                    if record_history { llm.lock().await.push_assistant(&text); }
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
                                if let Some((_, question)) = search_history_handoff.lock().unwrap_or_else(|e| e.into_inner()).take_if(|(after, _)| id > *after) {
                                    // A handoff owns the entire prior pair, including its partial reply.
                                    // If that reply never entered history, do not amend an unrelated assistant.
                                    let transferred = g.transfer_last_question_to_search(&question);
                                    info!(transferred, "search history handoff settled");
                                } else if let Some(spoken) = pending_amend {
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
                            let llm_ctl = ctl_tts.clone();
                            let h = tokio::spawn(async move {
                                let mut g = llm2.lock().await;
                                if llm_ctl.aborted() { return Err(anyhow::anyhow!("turn_aborted_before_llm")); }
                                // 上一轮被打断的历史修正在同一把锁内先落账,保证消息顺序
                                if let Some((_, question)) = search_history_handoff.lock().unwrap_or_else(|e| e.into_inner()).take_if(|(after, _)| id > *after) {
                                    // A handoff owns the entire prior pair, including its partial reply.
                                    // If that reply never entered history, do not amend an unrelated assistant.
                                    let transferred = g.transfer_last_question_to_search(&question);
                                    info!(transferred, "search history handoff settled");
                                } else if let Some(spoken) = pending_amend {
                                    g.set_last_assistant(&spoken);
                                }
                                g.chat_with_context(&ut, delta_tx,search_context).await
                            });
                            (delta_rx, h, false)
                        }
                    };
                    let mut seg = Segmenter::new(min_len).with_first_clause_min(first_clause_min);
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
                        llm_chars2.fetch_add(delta.chars().count(), AtomicOrdering::Relaxed);
                        let sentences = seg.feed(&delta);
                        // B17：首段由逗号切出时打点（对账「首句 TTS 提前了多少」用：与 body first sentence ready 配对）
                        if let Some(chars) = seg.take_clause_split() {
                            info!(room = %room_name, turn_id = id, chars, first_clause_min,
                                  "tts first clause split (comma, before sentence end)");
                        }
                        for sentence in sentences {
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
            search_progress,
            id,
            task,
            ctl,
            synth_text,
            progress,
            llm_chars,
            filler_samples,
            started: turn_started,
            business_until,
            seg_stage: 0,
        });
    }
}

// Forced job abort/panic is the fallback path: never detach a talking turn or
// lose the final conservative cursor merely because run_pipeline did not return.
impl Drop for Orchestrator {fn drop(&mut self){if self.search.is_some(){self.hard_abort_current();if let Some(search)=&mut self.search{search.close();}}}}

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

#[cfg(test)]
mod publish_result_tests {
    use super::{emit_publish_result, publish_fail_class};
    use std::io;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Cap(Arc<Mutex<Vec<u8>>>);
    impl io::Write for Cap {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Cap {
        type Writer = Cap;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    const TRACE: &str = "11111111-2222-3333-4444-555555555555";
    /// 真实错误链的形状:带信令 URL、query 里的 token、以及**含 SN 的房名**。
    const DIRTY: &str = "failed to publish to wss://live.example.com/rtc\
?access_token=eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG&room=sn-BJP00000000000000000-1789178706: timed out";

    fn emit_and_capture(err: Option<&str>) -> String {
        let cap = Cap::default();
        let sub = tracing_subscriber::fmt()
            .with_writer(cap.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(sub, || {
            emit_publish_result("session.input_ready", TRACE, 123, 7, err);
        });
        let bytes = cap.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    /// B34-A(codex 点名):断言的是**最终发出去的那条结构化日志**,不是脱敏函数的返回值。
    /// B33 我只测了 publish_fail_class——它确实不泄漏,而外围的 room 字段照样把 SN 打了出去。
    /// 判据必须套在真正会离开进程的那个对象上。
    #[test]
    fn emitted_log_carries_no_room_sn_token_or_url() {
        for err in [None, Some(DIRTY)] {
            let out = emit_and_capture(err);
            // 负锚:脏值必须缺席
            assert!(!out.contains("sn-"), "日志不得含房名: {out}");
            assert!(!out.contains("BJP"), "日志不得含 SN: {out}");
            assert!(!out.contains("eyJ"), "日志不得含 token: {out}");
            assert!(!out.contains("wss://"), "日志不得含信令 URL: {out}");
            assert!(!out.contains("access_token"), "日志不得含 query 参数名: {out}");
            // 正锚:这条日志真的发出来了,且关联键在。否则「干净」与「根本没打印」不可区分。
            assert!(out.contains("control publish result"), "正锚:日志必须真发出: {out}");
            assert!(out.contains(TRACE), "正锚:trace 必须在,否则两端对不上: {out}");
        }
    }

    /// 成功/失败两条路径的判别字段都要在,且字段名与口径一致。
    #[test]
    fn emitted_log_marks_ok_and_failure_with_defined_fields() {
        let ok = emit_and_capture(None);
        assert!(ok.contains("publish_ok=true"), "{ok}");
        assert!(ok.contains("send_ms=7"), "{ok}");
        assert!(ok.contains("since_pipeline_ms=123"), "口径字段名要明确: {ok}");

        let bad = emit_and_capture(Some("operation timed out"));
        assert!(bad.contains("publish_ok=false"), "{bad}");
        assert!(bad.contains("timeout"), "失败类别要在: {bad}");
    }

    /// 类别函数本身:四类必须互相分得开。全归 other 则「分类正确」与「分类器没跑」不可区分。
    #[test]
    fn fail_class_discriminates_between_shapes() {
        assert_eq!(publish_fail_class("peer is not connected"), "not_connected");
        assert_eq!(publish_fail_class("engine disconnected"), "not_connected");
        assert_eq!(publish_fail_class("operation timed out"), "timeout");
        assert_eq!(publish_fail_class("data channel closed"), "closed");
        assert_eq!(publish_fail_class("payload too large"), "payload");
        assert_eq!(publish_fail_class("某个没见过的错"), "other");
    }
}

#[cfg(test)]
mod asr_preconnect_handoff_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    fn config(addr: std::net::SocketAddr) -> SttConfig {
        let mut cfg = SttConfig::from_env();
        cfg.url = format!("ws://{addr}");
        cfg.api_key = Some("isolated-test".into());
        cfg.canon = false;
        cfg
    }

    // Only the provider boundary is simulated. The real ASR connector,
    // protocol parser, task owner, channels and handoff process the first PCM.
    async fn healthy_provider() -> (SttConfig, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cfg = config(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let init = ws.next().await.unwrap().unwrap().into_data();
            assert_eq!(crate::volc::Frame::unmarshal(&init).unwrap().msg_type, crate::volc::MsgType::FullClientRequest);
            let data = ws.next().await.unwrap().unwrap().into_data();
            let frame = crate::volc::Frame::unmarshal(&data).unwrap();
            assert_eq!(frame.msg_type, crate::volc::MsgType::AudioOnlyClient);
            use std::io::Read;
            let mut pcm = Vec::new();
            flate2::read::GzDecoder::new(frame.payload.as_slice()).read_to_end(&mut pcm).unwrap();
            assert_eq!(pcm, [42u8, 0u8].repeat(160), "the complete first PCM must reach the replacement");
            let response = crate::volc::Frame {
                msg_type: crate::volc::MsgType::FullServerResponse,
                flag: crate::volc::Flags::PositiveSeq,
                sequence: 1,
                serialization: crate::volc::SER_JSON,
                compression: crate::volc::COMP_GZIP,
                payload: crate::volc::gzip(br#"{"result":{"utterances":[{"text":"handoff test","definite":true}]}}"#),
                ..Default::default()
            };
            ws.send(Message::Binary(response.marshal().into())).await.unwrap();
        });
        (cfg, server)
    }

    async fn first_pcm_and_final(mut pre: SttPre, server: tokio::task::JoinHandle<()>) {
        pre.pcm_tx.send(vec![42; 160]).await.expect("handoff must provide a live PCM receiver");
        let ev = tokio::time::timeout(Duration::from_secs(2), pre.ev_rx.recv()).await.unwrap();
        assert!(matches!(ev, Some(SttEvent::Final(ref text)) if text == "handoff test"),
            "old preconnect events must not terminate or invalidate the new input: {ev:?}");
        drop(pre);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn closed_preconnect_is_replaced_before_first_pcm() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old = spawn_stt(config(listener.local_addr().unwrap()), "synthetic-handoff-closed");
        let (socket, _) = listener.accept().await.unwrap();
        drop(socket); // Real TCP handshake failure ends the preconnection task.
        tokio::time::timeout(Duration::from_secs(1), old.pcm_tx.closed()).await.unwrap();
        let (cfg, server) = healthy_provider().await;
        let current = take_stt_preconnect(old, || spawn_stt(cfg, "synthetic-handoff-new")).await.unwrap();
        first_pcm_and_final(current, server).await;
    }

    #[tokio::test]
    async fn reconnecting_preconnect_does_not_replay_idle_interruption_into_first_turn() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old = spawn_stt(config(listener.local_addr().unwrap()), "synthetic-handoff-interrupted");
        let old_tx = old.pcm_tx.clone();
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        ws.next().await.unwrap().unwrap(); // Provider accepted init, but no PCM has been submitted.
        ws.close(None).await.unwrap();
        drop(ws);
        tokio::time::timeout(Duration::from_secs(1), async {
            while old.ev_rx.is_empty() { tokio::task::yield_now().await; }
        }).await.unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            ws.next().await.unwrap().unwrap();
            let data = ws.next().await.unwrap().unwrap().into_data();
            let frame = crate::volc::Frame::unmarshal(&data).unwrap();
            assert_eq!(frame.msg_type, crate::volc::MsgType::AudioOnlyClient);
            use std::io::Read;
            let mut pcm = Vec::new();
            flate2::read::GzDecoder::new(frame.payload.as_slice()).read_to_end(&mut pcm).unwrap();
            assert_eq!(pcm, [42u8, 0u8].repeat(160));
            let response = crate::volc::Frame {
                msg_type: crate::volc::MsgType::FullServerResponse,
                flag: crate::volc::Flags::PositiveSeq,
                sequence: 1,
                serialization: crate::volc::SER_JSON,
                compression: crate::volc::COMP_GZIP,
                payload: crate::volc::gzip(br#"{"result":{"utterances":[{"text":"handoff test","definite":true}]}}"#),
                ..Default::default()
            };
            ws.send(Message::Binary(response.marshal().into())).await.unwrap();
        });
        let mut current = take_stt_preconnect(old, || panic!("a live reconnect episode must retain its original PCM channel")).await.unwrap();
        assert!(current.pcm_tx.same_channel(&old_tx));
        // Exercise the real ordered consumer: an idle episode's interruption
        // must not put the upcoming first turn in Terminal before its begin.
        let mut first_turn = crate::ordered_pcm::Session::new(None, crate::ordered_pcm::Limits::default());
        while let Ok(event) = current.ev_rx.try_recv() {
            if matches!(event, SttEvent::Interrupted) { first_turn.on_stream_interrupted(); }
        }
        assert_eq!(first_turn.phase(), crate::ordered_pcm::Phase::Idle);
        first_pcm_and_final(current, server).await;
    }

    #[tokio::test]
    async fn healthy_preconnect_keeps_its_latency_benefit() {
        let (cfg, server) = healthy_provider().await;
        let old = spawn_stt(cfg, "synthetic-handoff-healthy");
        let current = take_stt_preconnect(old, || panic!("healthy pending connection must be reused")).await.unwrap();
        first_pcm_and_final(current, server).await;
    }
}

#[cfg(test)]
mod asr_lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn failed_connection_episode_closes_without_resetting_budget_or_consuming_pcm() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let mut cfg=SttConfig::from_env();cfg.url=format!("ws://{addr}");cfg.api_key=Some("test".into());
        let SttPre{pcm_tx,mut ev_rx,task}=spawn_stt(cfg,"synthetic-asr-connect-failure");
        pcm_tx.send(vec![5;3200]).await.unwrap();
        let (socket,_)=listener.accept().await.unwrap();drop(socket);
        tokio::time::timeout(Duration::from_secs(1),task).await.expect("connect failure must be terminal inside its episode").unwrap();
        assert!(matches!(ev_rx.recv().await,Some(SttEvent::Interrupted)));
        assert!(matches!(ev_rx.recv().await,Some(SttEvent::Closed)));
        assert!(tokio::time::timeout(Duration::from_millis(600),listener.accept()).await.is_err());
    }
    #[tokio::test]
    async fn rejected_final_packet_does_not_reconnect_closed_input() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let (accepted,ready)=tokio::sync::oneshot::channel();
        let (release,rx)=tokio::sync::oneshot::channel();
        let server=tokio::spawn(async move {
            let (socket,_)=listener.accept().await.unwrap();
            let _=accepted.send(());let _=rx.await;drop(socket);
            tokio::time::timeout(Duration::from_millis(800),listener.accept()).await.is_err()
        });
        let mut cfg=SttConfig::from_env();cfg.url=format!("ws://{addr}");cfg.api_key=Some("test".into());
        let SttPre{pcm_tx,mut ev_rx,task}=spawn_stt(cfg,"synthetic-asr-closed");
        ready.await.unwrap();drop(pcm_tx);let _=release.send(());
        tokio::time::timeout(Duration::from_millis(400),task).await.expect("closed input must not enter backoff").unwrap();
        assert!(server.await.unwrap(),"closed input must not reconnect");
        assert!(matches!(ev_rx.recv().await,Some(SttEvent::Interrupted)));
        assert!(matches!(ev_rx.recv().await,Some(SttEvent::Closed)));
    }
    #[tokio::test]
    async fn abandoned_asr_owner_drops_socket_without_retries() {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr=listener.local_addr().unwrap();
        let mut cfg=SttConfig::from_env();cfg.url=format!("ws://{addr}");cfg.api_key=Some("test".into());
        let pre=spawn_stt(cfg,"synthetic-asr-abandoned");
        let (mut socket,_)=listener.accept().await.unwrap();drop(pre);
        use tokio::io::AsyncReadExt;
        let mut bytes=Vec::new();
        tokio::time::timeout(Duration::from_secs(1),socket.read_to_end(&mut bytes)).await.expect("abandoned ASR must close transport").unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(800),listener.accept()).await.is_err());
    }
}
