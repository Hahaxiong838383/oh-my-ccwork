//! One-shot 历史输入 v0.3（codex 复核 2026-09-08 `P003_CC_ONESHOT_HANDOFF_20260908.md` §3）：
//! **单一有序 PCM 路径 + 首句完整性门**。默认关闭（job.metadata 无 `input_mode=ordered_pcm` 即 RTC 现役路径，
//! 本模块零参与）。隔离实现，不上线。
//!
//! 设计要点（逐条对应复核 §2/§3）：
//! - 入口竞态：输入模式来自**受信 job.metadata**（Session API 签 token 时写入），job 第一帧前固定；ordered 模式下
//!   RTC 音频帧从第一帧起不进识别（pipeline 只计数丢弃），不存在「begin 到达前已送 ASR」窗口。
//! - 样本切点：设备给**绝对样本索引**的半开区间 `[start,end)`；worker 只接受连续区间，不跨 data-channel/RTP 用相关峰猜切点。
//! - 代次：wire `input_id` 独立唯一并绑定 trace/session/capture_epoch/wake_generation；同 job 只认**一个不可替换**的
//!   输入代次；完全相同的 begin 幂等，冲突 begin 只拒绝该消息、不取消合法代次。
//! - ACK 与信用：`received_next`（连续已接收）与 `queued_next`（已 `try_send` 进 worker 的 ASR 发送队列，**队列水位，
//!   不是已写供应商 socket**，更不是识别完成）分开命名；`credit_samples` 是 worker 组包器还能缓冲的样本数（8 s 预算是
//!   受控队列容量，不宣称无背压：ASR 队列 128 块满即 `queue_full` 终态）。Android 不得拿 `queued_next` 判 ASR ready/云端成功。
//! - 单包上限三条同时成立：总包 ≤ 15 KiB、头 JSON ≤ 2 KiB、PCM ≤ 7168 样本（14 KiB PCM + 2 KiB 头 > 15 KiB 会被拒）。
//! - 供应商流结束两种：LastNoSeq 正常终局 → 裁决；中途断连/协议错误/收流后 EOF → `Interrupted` → 整代作废，
//!   已 hold 的半段 final 绝不提交。
//! - 预算：历史积压上限 ≥ 7 s（默认 8 s），单代总样本上限 12 s；不足一块的尾巴按实际样本数 flush，**不静默丢尾**。
//! - 完整性门：ASR 的 interim/final 只 hold，不进投机/命令/退出/LLM；`end` 后补尾静音并主动收流，供应商 LastNoSeq
//!   之后（流结束）才裁决：完整 → 一次 commit（走现役 commit 路径）；任一失败 → 终态，旧 final 全部作废，不放行残余 RTC。
//! - 失败终态唯一且不可逆；终态后到达的 final/包只计数不消费（按 input_id 过滤，不是「跳过第一条」）。
//! - 队列满：`try_send` 失败 → 计数 + 整代失败（不是 WARN 后继续）。
//!
//! 隐私：证据只含标量与计数，不含 PCM；文本只在 commit 时经现役路径处理。

use serde::Deserialize;
use serde_json::{Value, json};

/// 数据通道 topic（与 control / 设备命令 topic 隔离；非 ordered 模式的 job 直接丢弃）。
pub const TOPIC: &str = "p003.audio.history.v1";
pub const MAGIC: &[u8; 4] = b"OPCM";
pub const WIRE_VERSION: u16 = 1;
pub const SAMPLE_RATE: u32 = 16_000;
/// 与 pipeline 的 STT_SEGMENT_SAMPLES 同值：200 ms 一块进火山。
pub const BLOCK_SAMPLES: usize = 3200;
/// 头部 JSON 上限（防畸形包）。
pub const MAX_HEADER_BYTES: usize = 2048;
/// 单包 PCM 上限：14 KiB 载荷（LiveKit 单包 15 KiB 为保守应用预算，不当作底层保证）。
pub const MAX_CHUNK_SAMPLES: usize = 7168;
/// 整包（头+PCM）上限：与 Android codec 同款三条限制（总包 ≤ 15 KiB、头 ≤ 2 KiB、PCM ≤ 7168 样本）。
pub const MAX_PACKET_BYTES: usize = 15 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputMode {
    /// 现役：RTC 音轨进 VAD/ASR（零行为变化）。
    Rtc,
    /// 实验：只吃有序 PCM，RTC 帧从第一帧起丢弃计数。
    OrderedPcm,
}

impl InputMode {
    /// 受信来源=job.metadata（服务端签发）；缺省/未知值一律现役。
    pub fn from_meta(v: Option<&str>) -> Self {
        match v {
            Some("ordered_pcm") => InputMode::OrderedPcm,
            _ => InputMode::Rtc,
        }
    }
}

/// 包头（JSON，UTF-8）。`t` ∈ begin|chunk|end|cancel（设备→worker）；ack|result（worker→设备）。
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Header {
    pub t: String,
    pub input_id: String,
    pub trace_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub capture_epoch: u64,
    #[serde(default)]
    pub wake_generation: u64,
    #[serde(default)]
    pub seq: u64,
    /// 半开区间 [start, end) 的绝对样本索引（u64，跨语言按无符号 64 位）。
    #[serde(default)]
    pub start: u64,
    #[serde(default)]
    pub end: u64,
    #[serde(default)]
    pub keep_from: Option<u64>,
    #[serde(default)]
    pub boundary_kind: Option<String>,
    #[serde(default)]
    pub overlaps_local_playback: Option<bool>,
    #[serde(default)]
    pub sr: Option<u32>,
    #[serde(default)]
    pub ch: Option<u8>,
    #[serde(default)]
    pub fmt: Option<String>,
    #[serde(default)]
    pub sent_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Packet {
    pub header: Header,
    pub pcm: Vec<i16>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    TooShort,
    BadMagic,
    BadVersion(u16),
    HeaderTooLong(usize),
    BadHeaderJson,
    OddPayload,
    PayloadLenMismatch { expected: usize, actual: usize },
    PayloadOnNonChunk,
    ChunkTooLarge(usize),
    PacketTooLarge(usize),
}

/// 线格式：`OPCM` | u16 BE version | u16 BE header_len | header JSON | PCM s16le。
/// chunk 的 PCM 字节数必须等于 (end-start)*2；非 chunk 不得带 PCM。
pub fn parse_packet(raw: &[u8]) -> Result<Packet, ParseError> {
    if raw.len() > MAX_PACKET_BYTES {
        return Err(ParseError::PacketTooLarge(raw.len()));
    }
    if raw.len() < 8 {
        return Err(ParseError::TooShort);
    }
    if &raw[0..4] != MAGIC {
        return Err(ParseError::BadMagic);
    }
    let ver = u16::from_be_bytes([raw[4], raw[5]]);
    if ver != WIRE_VERSION {
        return Err(ParseError::BadVersion(ver));
    }
    let hl = u16::from_be_bytes([raw[6], raw[7]]) as usize;
    if hl > MAX_HEADER_BYTES {
        return Err(ParseError::HeaderTooLong(hl));
    }
    if raw.len() < 8 + hl {
        return Err(ParseError::TooShort);
    }
    let header: Header = serde_json::from_slice(&raw[8..8 + hl]).map_err(|_| ParseError::BadHeaderJson)?;
    let body = &raw[8 + hl..];
    if header.t == "chunk" {
        if body.len() % 2 != 0 {
            return Err(ParseError::OddPayload);
        }
        let n = body.len() / 2;
        let expected = header.end.saturating_sub(header.start) as usize;
        if n != expected {
            return Err(ParseError::PayloadLenMismatch { expected, actual: n });
        }
        if n > MAX_CHUNK_SAMPLES {
            return Err(ParseError::ChunkTooLarge(n));
        }
        let pcm: Vec<i16> = body.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        Ok(Packet { header, pcm })
    } else {
        if !body.is_empty() {
            return Err(ParseError::PayloadOnNonChunk);
        }
        Ok(Packet { header, pcm: Vec::new() })
    }
}

/// 出站封包（ack/result 也走同一 topic 同一线格式，PCM 为空）。
pub fn encode_packet(header: &Value, pcm: &[i16]) -> Vec<u8> {
    let h = serde_json::to_vec(header).unwrap_or_default();
    let mut out = Vec::with_capacity(8 + h.len() + pcm.len() * 2);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&WIRE_VERSION.to_be_bytes());
    out.extend_from_slice(&(h.len() as u16).to_be_bytes());
    out.extend_from_slice(&h);
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// 房名 `sn-<SN>-<unix秒>` → 设备参与者身份 `dev-<SN>`（Session API 固定约定）。非 sn- 房 → None（永不启用）。
/// 用于有序 PCM 包的发包者校验：begin 可能早于用户轨订阅到达，不能依赖 user_info 绑定。
pub fn expected_device_identity(room_name: &str) -> Option<String> {
    let rest = room_name.strip_prefix("sn-")?;
    let (sn, ts) = rest.rsplit_once('-')?;
    if sn.is_empty() || ts.is_empty() || !ts.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("dev-{sn}"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailReason {
    TraceMismatch,
    ProtocolError,
    BoundaryNone,
    LocalPlaybackOverlap,
    MissingSeq,
    DuplicateConflict,
    OverCap,
    Timeout,
    QueueFull,
    Cancelled,
    RoomClosed,
    AsrUnavailable,
    NoFinal,
}

impl FailReason {
    pub fn as_str(self) -> &'static str {
        match self {
            FailReason::TraceMismatch => "trace_mismatch",
            FailReason::ProtocolError => "protocol_error",
            FailReason::BoundaryNone => "boundary_none",
            FailReason::LocalPlaybackOverlap => "local_playback_overlap",
            FailReason::MissingSeq => "missing_seq",
            FailReason::DuplicateConflict => "duplicate_conflict",
            FailReason::OverCap => "over_cap",
            FailReason::Timeout => "timeout",
            FailReason::QueueFull => "queue_full",
            FailReason::Cancelled => "cancelled",
            FailReason::RoomClosed => "room_closed",
            FailReason::AsrUnavailable => "asr_unavailable",
            FailReason::NoFinal => "no_final",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// worker 侧未提交积压上限（样本）。默认 8 s ≥ 设备 7 s 环容量。
    pub max_backlog_samples: usize,
    /// 单代总样本上限（keep_from 起算）。默认 12 s。
    pub max_total_samples: usize,
    /// begin 之后多久没收到 end 判超时。默认 7000 ms（2 s lookback + 5 s 等待）。
    pub begin_to_end_timeout_ms: i64,
    /// end 后补的尾静音（让供应商按音频时间判停），默认 600 ms。
    pub tail_silence_samples: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_backlog_samples: 8 * SAMPLE_RATE as usize,
            max_total_samples: 12 * SAMPLE_RATE as usize,
            begin_to_end_timeout_ms: 7_000,
            tail_silence_samples: 9_600,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    input_id: String,
    trace_id: String,
    session_id: String,
    capture_epoch: u64,
    wake_generation: u64,
}

impl Identity {
    fn from_header(h: &Header) -> Self {
        Self {
            input_id: h.input_id.clone(),
            trace_id: h.trace_id.clone(),
            session_id: h.session_id.clone(),
            capture_epoch: h.capture_epoch,
            wake_generation: h.wake_generation,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// 未收到 begin。
    Idle,
    /// begin 已收，chunk 进行中。
    Receiving,
    /// end 已收，尾块/尾静音待提交。
    Ended,
    /// 全部已写 ASR 且已请求收流，等供应商 LastNoSeq。
    Draining,
    /// 终态（成功或失败），不可逆。
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Committed,
    Failed(FailReason),
}

/// worker 对 pipeline 的动作（纯数据，pipeline 负责执行）。
#[derive(Debug, PartialEq)]
pub enum Action {
    /// 写一块 PCM 到 ASR 队列（由 `drain_submits` 的回调执行，不在此枚举里出现）。
    /// 主动收流：drop ASR 发送端，供应商回 LastNoSeq → 流结束 → 裁决。
    EndStream,
    /// 出站 JSON（ack / result），走 `TOPIC`。
    Publish(Value),
}

/// 流结束时的裁决。
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// 完整：一次性提交的用户文本（多 definite 按序拼接）。
    Commit(String),
    /// 作废：终态原因（可能是早已失败的终态）。
    Discard(FailReason),
}

#[derive(Default, Debug, Clone)]
pub struct Counters {
    pub packets_total: u64,
    pub packets_rejected: u64,
    pub packets_after_terminal: u64,
    pub chunks_received: u64,
    pub chunks_duplicate: u64,
    pub samples_received: u64,
    pub samples_cropped_before_keep_from: u64,
    pub blocks_submitted: u64,
    pub samples_submitted: u64,
    pub tail_block_samples: u64,
    pub silence_samples_submitted: u64,
    pub queue_full_events: u64,
    pub backlog_peak_samples: u64,
    pub rtc_frames_dropped: u64,
    pub interims_held: u64,
    pub finals_held: u64,
    pub finals_after_terminal: u64,
    pub end_before_final: u64,
    pub final_before_end: u64,
    /// 供应商连接非正常结束次数（中途断连/协议错误/收流后 EOF）。
    pub stream_interrupted: u64,
}

pub struct Session {
    expected_trace: Option<String>,
    limits: Limits,
    phase: Phase,
    ident: Option<Identity>,
    keep_from: u64,
    first_sample: u64,
    begin_at_ms: i64,
    end_sample: Option<u64>,
    /// 连续已接收的下一个样本索引（received_next）。
    recv_next: u64,
    /// 已写 ASR socket 的下一个样本索引（submitted_next）。
    submitted_next: u64,
    /// 已接收未提交的样本（起点 = submitted_next）。
    buf: Vec<i16>,
    tail_done: bool,
    held_finals: Vec<String>,
    outcome: Option<Outcome>,
    /// B6 时间线(注入时钟,unix ms):首块/首 held final/end/收流裁决——证据里以 begin 相对毫秒输出。
    first_chunk_at_ms: Option<i64>,
    first_final_at_ms: Option<i64>,
    end_at_ms: Option<i64>,
    stream_end_at_ms: Option<i64>,
    pub counters: Counters,
}

impl Session {
    pub fn new(expected_trace: Option<String>, limits: Limits) -> Self {
        Self {
            expected_trace,
            limits,
            phase: Phase::Idle,
            ident: None,
            keep_from: 0,
            first_sample: 0,
            begin_at_ms: 0,
            end_sample: None,
            recv_next: 0,
            submitted_next: 0,
            buf: Vec::new(),
            tail_done: false,
            held_finals: Vec::new(),
            outcome: None,
            first_chunk_at_ms: None,
            first_final_at_ms: None,
            end_at_ms: None,
            stream_end_at_ms: None,
            counters: Counters::default(),
        }
    }

    /// 测试/证据用访问器（生产路径只经 evidence() 读字段）。
    #[allow(dead_code)]
    pub fn phase(&self) -> Phase {
        self.phase
    }

    #[allow(dead_code)]
    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    pub fn input_id(&self) -> Option<&str> {
        self.ident.as_ref().map(|i| i.input_id.as_str())
    }

    fn credit_samples(&self) -> u64 {
        (self.limits.max_backlog_samples as u64).saturating_sub(self.buf.len() as u64)
    }

    fn ack(&self) -> Value {
        json!({
            "t": "ack",
            "input_id": self.input_id().unwrap_or(""),
            "received_next": self.recv_next,
            "queued_next": self.submitted_next,
            "credit_samples": self.credit_samples(),
            "chunks_received": self.counters.chunks_received,
            "phase": phase_str(self.phase),
        })
    }

    fn result_json(&self, status: &str, reason: Option<FailReason>, extra: Value) -> Value {
        let mut v = json!({
            "t": "result",
            "input_id": self.input_id().unwrap_or(""),
            "status": status,
            "reason": reason.map(FailReason::as_str),
            "received_next": self.recv_next,
            "queued_next": self.submitted_next,
            "finals_held": self.counters.finals_held,
        });
        if let (Some(obj), Some(ex)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in ex {
                obj.insert(k.clone(), val.clone());
            }
        }
        v
    }

    /// 只拒绝这一条消息（不影响合法代次）。
    fn reject_msg(&mut self, h: &Header, reason: &str) -> Vec<Action> {
        self.counters.packets_rejected += 1;
        vec![Action::Publish(json!({
            "t": "result", "input_id": h.input_id, "status": "rejected", "reason": reason,
            "active_input_id": self.input_id(),
        }))]
    }

    /// 整代失败：唯一终态，清空缓冲与 hold 的 final，请求收流。
    pub fn fail(&mut self, reason: FailReason) -> Vec<Action> {
        if self.phase == Phase::Terminal {
            return Vec::new();
        }
        let was_draining = self.phase == Phase::Draining;
        self.phase = Phase::Terminal;
        self.outcome = Some(Outcome::Failed(reason));
        self.buf.clear();
        self.held_finals.clear();
        let mut acts = vec![Action::Publish(self.result_json("failed", Some(reason), json!({"action": "repeat_prompt"})))];
        if !was_draining {
            acts.push(Action::EndStream);
        }
        acts
    }

    fn matches_ident(&self, h: &Header) -> bool {
        match &self.ident {
            Some(i) => i.input_id == h.input_id && i.trace_id == h.trace_id,
            None => false,
        }
    }

    /// 设备→worker 包。返回待执行动作（Publish/EndStream）；PCM 提交要紧接着调 `drain_submits`。
    pub fn on_packet(&mut self, pkt: &Packet, now_ms: i64) -> Vec<Action> {
        self.counters.packets_total += 1;
        if self.phase == Phase::Terminal {
            self.counters.packets_after_terminal += 1;
            return Vec::new();
        }
        let h = &pkt.header;
        match h.t.as_str() {
            "begin" => self.on_begin(h, now_ms),
            "chunk" => self.on_chunk(pkt, now_ms),
            "end" => self.on_end(h, now_ms),
            "cancel" => {
                if !self.matches_ident(h) {
                    return self.reject_msg(h, "identity_mismatch");
                }
                self.fail(FailReason::Cancelled)
            }
            _ => self.reject_msg(h, "unknown_type"),
        }
    }

    fn on_begin(&mut self, h: &Header, now_ms: i64) -> Vec<Action> {
        // 受信 trace 对撞：错身份只拒消息
        match &self.expected_trace {
            Some(t) if *t == h.trace_id => {}
            _ => return self.reject_msg(h, FailReason::TraceMismatch.as_str()),
        }
        if self.phase != Phase::Idle {
            // 同 job 只认一个代次：完全相同的 begin 幂等（重发 ack），其它一律拒绝该消息
            let same = self.ident.as_ref() == Some(&Identity::from_header(h))
                && self.first_sample == h.start
                && self.keep_from == h.keep_from.unwrap_or(h.start);
            if same {
                return vec![Action::Publish(self.ack())];
            }
            return self.reject_msg(h, "input_conflict");
        }
        if h.input_id.is_empty() {
            return self.reject_msg(h, "input_id_empty");
        }
        // 格式：只收 16k/mono/s16le
        if h.sr.unwrap_or(SAMPLE_RATE) != SAMPLE_RATE || h.ch.unwrap_or(1) != 1 || h.fmt.as_deref().unwrap_or("s16le") != "s16le" {
            return self.reject_msg(h, "format_unsupported");
        }
        let keep_from = h.keep_from.unwrap_or(h.start);
        if keep_from < h.start {
            return self.reject_msg(h, "keep_from_before_start");
        }
        // 从这里起代次成立，后续失败是整代终态
        self.ident = Some(Identity::from_header(h));
        self.phase = Phase::Receiving;
        self.first_sample = h.start;
        self.keep_from = keep_from;
        self.recv_next = h.start;
        self.submitted_next = keep_from.max(h.start);
        self.begin_at_ms = now_ms;
        match h.boundary_kind.as_deref() {
            Some("kws_tail") | Some("wake_lookback") => {}
            _ => return self.fail(FailReason::BoundaryNone),
        }
        if h.overlaps_local_playback.unwrap_or(false) {
            return self.fail(FailReason::LocalPlaybackOverlap);
        }
        vec![Action::Publish(self.ack())]
    }

    fn on_chunk(&mut self, pkt: &Packet, now_ms: i64) -> Vec<Action> {
        let h = &pkt.header;
        if self.phase == Phase::Idle {
            return self.reject_msg(h, "chunk_before_begin");
        }
        if !self.matches_ident(h) {
            return self.reject_msg(h, "identity_mismatch");
        }
        if self.phase != Phase::Receiving {
            return self.reject_msg(h, "chunk_after_end");
        }
        if h.end <= h.start || (h.end - h.start) as usize != pkt.pcm.len() {
            return self.fail(FailReason::ProtocolError);
        }
        // 完全重复（同区间已接收）→ 幂等重发 ack；部分重叠 = 内容冲突 → 整代失败
        if h.end <= self.recv_next {
            if h.start >= self.first_sample && h.seq < self.counters.chunks_received {
                self.counters.chunks_duplicate += 1;
                return vec![Action::Publish(self.ack())];
            }
            return self.fail(FailReason::DuplicateConflict);
        }
        if h.start != self.recv_next || h.seq != self.counters.chunks_received {
            return self.fail(if h.start > self.recv_next { FailReason::MissingSeq } else { FailReason::DuplicateConflict });
        }
        // 预算：单代总样本（keep_from 起）与未提交积压
        let total_after = h.end.saturating_sub(self.keep_from) as usize;
        if total_after > self.limits.max_total_samples {
            return self.fail(FailReason::OverCap);
        }
        let mut pcm: &[i16] = &pkt.pcm;
        if h.end <= self.keep_from {
            self.counters.samples_cropped_before_keep_from += pcm.len() as u64;
            pcm = &[];
        } else if h.start < self.keep_from {
            let skip = (self.keep_from - h.start) as usize;
            self.counters.samples_cropped_before_keep_from += skip as u64;
            pcm = &pcm[skip..];
        }
        if self.buf.len() + pcm.len() > self.limits.max_backlog_samples {
            return self.fail(FailReason::OverCap);
        }
        self.buf.extend_from_slice(pcm);
        self.recv_next = h.end;
        self.counters.chunks_received += 1;
        if self.first_chunk_at_ms.is_none() {
            self.first_chunk_at_ms = Some(now_ms);
        }
        self.counters.samples_received += (h.end - h.start) as u64;
        self.counters.backlog_peak_samples = self.counters.backlog_peak_samples.max(self.buf.len() as u64);
        Vec::new() // ack 在 drain_submits 之后发（带最新 submitted_next）
    }

    fn on_end(&mut self, h: &Header, now_ms: i64) -> Vec<Action> {
        if self.phase == Phase::Idle {
            return self.reject_msg(h, "end_before_begin");
        }
        if !self.matches_ident(h) {
            return self.reject_msg(h, "identity_mismatch");
        }
        if self.phase != Phase::Receiving {
            return self.reject_msg(h, "end_duplicate");
        }
        if h.end != self.recv_next {
            return self.fail(FailReason::MissingSeq);
        }
        self.end_sample = Some(h.end);
        self.end_at_ms = Some(now_ms);
        self.phase = Phase::Ended;
        if self.held_finals.is_empty() {
            self.counters.end_before_final += 1;
        }
        Vec::new() // 尾块/尾静音/收流在 drain_submits 里
    }

    /// 把已接收样本按 3200 块写入 ASR（`send` 返回 false = 队列满 → 整代失败）。
    /// end 之后：不足一块的尾巴按实际样本数 flush（不丢），再补尾静音，最后请求收流。
    pub fn drain_submits<F: FnMut(Vec<i16>) -> bool>(&mut self, mut send: F) -> Vec<Action> {
        if !matches!(self.phase, Phase::Receiving | Phase::Ended) {
            return Vec::new();
        }
        while self.buf.len() >= BLOCK_SAMPLES {
            let block: Vec<i16> = self.buf.drain(..BLOCK_SAMPLES).collect();
            if !send(block) {
                self.counters.queue_full_events += 1;
                return self.fail(FailReason::QueueFull);
            }
            self.counters.blocks_submitted += 1;
            self.counters.samples_submitted += BLOCK_SAMPLES as u64;
            self.submitted_next += BLOCK_SAMPLES as u64;
        }
        if self.phase == Phase::Ended {
            if !self.buf.is_empty() {
                let n = self.buf.len();
                let tail: Vec<i16> = std::mem::take(&mut self.buf);
                if !send(tail) {
                    self.counters.queue_full_events += 1;
                    return self.fail(FailReason::QueueFull);
                }
                self.counters.blocks_submitted += 1;
                self.counters.samples_submitted += n as u64;
                self.counters.tail_block_samples = n as u64;
                self.submitted_next += n as u64;
            }
            if !self.tail_done {
                let mut left = self.limits.tail_silence_samples;
                while left > 0 {
                    let n = left.min(BLOCK_SAMPLES);
                    if !send(vec![0i16; n]) {
                        self.counters.queue_full_events += 1;
                        return self.fail(FailReason::QueueFull);
                    }
                    self.counters.silence_samples_submitted += n as u64;
                    left -= n;
                }
                self.tail_done = true;
            }
            self.phase = Phase::Draining;
            return vec![Action::Publish(self.ack()), Action::EndStream];
        }
        vec![Action::Publish(self.ack())]
    }

    /// ASR interim：只计数（不进投机/字幕）。
    pub fn on_stt_interim(&mut self) {
        if self.phase == Phase::Terminal {
            return;
        }
        self.counters.interims_held += 1;
    }

    /// ASR definite：hold（不 commit）；终态后到达的只计数。
    pub fn on_stt_final(&mut self, text: String, now_ms: i64) {
        if self.phase == Phase::Terminal {
            self.counters.finals_after_terminal += 1;
            return;
        }
        if self.end_sample.is_none() {
            self.counters.final_before_end += 1;
        }
        self.counters.finals_held += 1;
        if self.first_final_at_ms.is_none() {
            self.first_final_at_ms = Some(now_ms);
        }
        self.held_finals.push(text);
    }

    /// 供应商流结束（LastNoSeq → Closed）：唯一裁决点。
    pub fn on_stream_end(&mut self, now_ms: i64) -> (Decision, Vec<Action>) {
        self.stream_end_at_ms = Some(now_ms);
        if self.phase == Phase::Terminal {
            let r = match &self.outcome {
                Some(Outcome::Failed(r)) => *r,
                _ => FailReason::ProtocolError,
            };
            return (Decision::Discard(r), Vec::new());
        }
        if self.phase != Phase::Draining {
            // 流在我们收流之前就断了：供应商断连/失败
            let acts = self.fail(FailReason::AsrUnavailable);
            return (Decision::Discard(FailReason::AsrUnavailable), acts);
        }
        if self.held_finals.is_empty() {
            let acts = self.fail(FailReason::NoFinal);
            return (Decision::Discard(FailReason::NoFinal), acts);
        }
        let text: String = self.held_finals.join("");
        self.phase = Phase::Terminal;
        self.outcome = Some(Outcome::Committed);
        let acts = vec![Action::Publish(self.result_json(
            "complete",
            None,
            json!({
                "finals": self.held_finals.len(),
                "samples_queued": self.counters.samples_submitted,
                "text_chars": text.chars().count(),
            }),
        ))];
        self.held_finals.clear();
        (Decision::Commit(text), acts)
    }

    /// 供应商连接非正常结束（中途断连 / 协议错误 / 收流后未见 LastNoSeq 即 EOF）：整代作废，已 hold 的半段 final 绝不提交。
    /// 与 `on_stream_end`（LastNoSeq 正常终局）严格区分——两者在 pipeline 里都以「流结束」出现，但只有后者能 commit。
    pub fn on_stream_interrupted(&mut self) -> Vec<Action> {
        self.counters.stream_interrupted += 1;
        self.fail(FailReason::AsrUnavailable)
    }

    /// 定时器：begin 后超时未 end → 整代失败。
    pub fn on_tick(&mut self, now_ms: i64) -> Vec<Action> {
        if matches!(self.phase, Phase::Receiving | Phase::Ended) && now_ms - self.begin_at_ms > self.limits.begin_to_end_timeout_ms {
            return self.fail(FailReason::Timeout);
        }
        Vec::new()
    }

    /// RTC 帧在 ordered 模式下的去向：丢弃计数（pipeline 调）。
    pub fn note_rtc_frame_dropped(&mut self) {
        self.counters.rtc_frames_dropped += 1;
    }

    /// 机器可读证据（无 PCM、无文本）。
    pub fn evidence(&self) -> Value {
        let c = &self.counters;
        json!({
            "input_id": self.input_id(),
            "phase": phase_str(self.phase),
            "outcome": match &self.outcome { Some(Outcome::Committed) => "committed", Some(Outcome::Failed(r)) => r.as_str(), None => "none" },
            "first_sample": self.first_sample,
            "keep_from": self.keep_from,
            "end_sample": self.end_sample,
            "received_next": self.recv_next,
            "queued_next": self.submitted_next,
            "packets_total": c.packets_total,
            "packets_rejected": c.packets_rejected,
            "packets_after_terminal": c.packets_after_terminal,
            "chunks_received": c.chunks_received,
            "chunks_duplicate": c.chunks_duplicate,
            "samples_received": c.samples_received,
            "samples_cropped_before_keep_from": c.samples_cropped_before_keep_from,
            "blocks_queued": c.blocks_submitted,
            "samples_queued": c.samples_submitted,
            "stream_interrupted": c.stream_interrupted,
            "tail_block_samples": c.tail_block_samples,
            "silence_samples_submitted": c.silence_samples_submitted,
            "queue_full_events": c.queue_full_events,
            "backlog_peak_samples": c.backlog_peak_samples,
            "rtc_frames_dropped": c.rtc_frames_dropped,
            "interims_held": c.interims_held,
            "finals_held": c.finals_held,
            "finals_after_terminal": c.finals_after_terminal,
            "final_before_end": c.final_before_end,
            "end_before_final": c.end_before_final,
            // B6 时间线(相对 begin 的毫秒;缺失为 null 不编数):量 held final 领先设备 end 多少
            "first_chunk_ms": self.first_chunk_at_ms.map(|t| t - self.begin_at_ms),
            "first_final_ms": self.first_final_at_ms.map(|t| t - self.begin_at_ms),
            "end_ms": self.end_at_ms.map(|t| t - self.begin_at_ms),
            "stream_end_ms": self.stream_end_at_ms.map(|t| t - self.begin_at_ms),
            "final_lead_over_end_ms": match (self.first_final_at_ms, self.end_at_ms) { (Some(f), Some(e)) => Some(e - f), _ => None },
        })
    }
}

fn phase_str(p: Phase) -> &'static str {
    match p {
        Phase::Idle => "idle",
        Phase::Receiving => "receiving",
        Phase::Ended => "ended",
        Phase::Draining => "draining",
        Phase::Terminal => "terminal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACE: &str = "tr-1";

    fn header(t: &str, input_id: &str, seq: u64, start: u64, end: u64) -> Value {
        json!({
            "t": t, "input_id": input_id, "trace_id": TRACE, "session_id": "s1",
            "capture_epoch": 3, "wake_generation": 1, "seq": seq, "start": start, "end": end,
            "sr": 16000, "ch": 1, "fmt": "s16le",
        })
    }

    fn begin_hdr(input_id: &str, start: u64, keep_from: u64) -> Value {
        let mut h = header("begin", input_id, 0, start, start);
        h["keep_from"] = json!(keep_from);
        h["boundary_kind"] = json!("kws_tail");
        h["overlaps_local_playback"] = json!(false);
        h
    }

    fn pkt(h: Value, pcm: &[i16]) -> Packet {
        parse_packet(&encode_packet(&h, pcm)).expect("roundtrip")
    }

    fn tone(n: usize, seed: i16) -> Vec<i16> {
        (0..n).map(|i| ((i as i32 * 37 + seed as i32) % 2000 - 1000) as i16).collect()
    }

    /// 记录每次 send 的样本，模拟 ASR 队列；`cap` 为 None 时永不满。
    struct Sink {
        blocks: Vec<Vec<i16>>,
        cap: Option<usize>,
    }
    impl Sink {
        fn sender(&mut self) -> impl FnMut(Vec<i16>) -> bool + '_ {
            move |b| {
                if let Some(c) = self.cap
                    && self.blocks.len() >= c
                {
                    return false;
                }
                self.blocks.push(b);
                true
            }
        }
        fn samples(&self) -> usize {
            self.blocks.iter().map(Vec::len).sum()
        }
    }

    fn session() -> Session {
        Session::new(Some(TRACE.into()), Limits::default())
    }

    /// 把 [start,end) 的样本按 chunk_len 分片喂给 session（模拟设备 640 样本 peek 组包）。
    fn feed(s: &mut Session, sink: &mut Sink, input_id: &str, start: u64, pcm: &[i16], chunk_len: usize, seq0: u64) -> (u64, Vec<Action>) {
        let mut seq = seq0;
        let mut acts = Vec::new();
        let mut off = 0usize;
        while off < pcm.len() {
            let n = chunk_len.min(pcm.len() - off);
            let h = header("chunk", input_id, seq, start + off as u64, start + (off + n) as u64);
            acts.extend(s.on_packet(&pkt(h, &pcm[off..off + n]), 1000));
            acts.extend(s.drain_submits(sink.sender()));
            off += n;
            seq += 1;
        }
        (seq, acts)
    }

    #[test]
    fn input_mode_default_is_rtc() {
        assert_eq!(InputMode::from_meta(None), InputMode::Rtc);
        assert_eq!(InputMode::from_meta(Some("")), InputMode::Rtc);
        assert_eq!(InputMode::from_meta(Some("rtc")), InputMode::Rtc);
        assert_eq!(InputMode::from_meta(Some("ORDERED_PCM")), InputMode::Rtc, "大小写不猜");
        assert_eq!(InputMode::from_meta(Some("ordered_pcm")), InputMode::OrderedPcm);
    }

    #[test]
    fn device_identity_is_derived_from_sn_room_only() {
        assert_eq!(expected_device_identity("sn-BJPX0006-1788859897").as_deref(), Some("dev-BJPX0006"));
        assert_eq!(expected_device_identity("voice-test-rust"), None, "非设备房永不启用");
        assert_eq!(expected_device_identity("sn--1788859897"), None);
        assert_eq!(expected_device_identity("sn-BJPX0006-abc"), None, "尾段必须是 unix 秒");
        assert_eq!(expected_device_identity("sn-BJPX0006"), None);
    }

    #[test]
    fn wire_roundtrip_and_errors() {
        let h = header("chunk", "in-1", 0, 0, 640);
        let pcm = tone(640, 1);
        let raw = encode_packet(&h, &pcm);
        let p = parse_packet(&raw).unwrap();
        assert_eq!(p.pcm, pcm);
        assert_eq!(p.header.end, 640);
        assert_eq!(parse_packet(b"OPC").unwrap_err(), ParseError::TooShort);
        assert_eq!(parse_packet(b"XXXX\x00\x01\x00\x00").unwrap_err(), ParseError::BadMagic);
        assert_eq!(parse_packet(b"OPCM\x00\x02\x00\x00").unwrap_err(), ParseError::BadVersion(2));
        // 载荷长度与区间不符
        let bad = encode_packet(&header("chunk", "in-1", 0, 0, 640), &tone(639, 1));
        assert_eq!(parse_packet(&bad).unwrap_err(), ParseError::PayloadLenMismatch { expected: 640, actual: 639 });
        // 非 chunk 带载荷
        let bad2 = encode_packet(&begin_hdr("in-1", 0, 0), &tone(10, 1));
        assert_eq!(parse_packet(&bad2).unwrap_err(), ParseError::PayloadOnNonChunk);
        // 头过长
        let mut big = header("begin", "in-1", 0, 0, 0);
        big["pad"] = json!("x".repeat(MAX_HEADER_BYTES));
        assert!(matches!(parse_packet(&encode_packet(&big, &[])).unwrap_err(), ParseError::HeaderTooLong(_)));
        // 超大块
        let huge = encode_packet(&header("chunk", "in-1", 0, 0, (MAX_CHUNK_SAMPLES + 1) as u64), &tone(MAX_CHUNK_SAMPLES + 1, 1));
        assert!(matches!(parse_packet(&huge).unwrap_err(), ParseError::ChunkTooLarge(_)));
    }

    /// 矩阵「末尾 1..3199 样本、刚好 3200 样本」：交付总样本数 = 输入样本数 + 尾静音，不静默丢尾、不多补真实语音。
    #[test]
    fn tail_samples_are_flushed_exactly() {
        for total in [1usize, 640, 3199, 3200, 3201, 6400, 6401, 7 * 16000 + 1234] {
            let mut s = session();
            let mut sink = Sink { blocks: vec![], cap: None };
            s.on_packet(&pkt(begin_hdr("in-1", 100, 100), &[]), 1000);
            let pcm = tone(total, 5);
            let (seq, _) = feed(&mut s, &mut sink, "in-1", 100, &pcm, 640, 0);
            let acts = s.on_packet(&pkt(header("end", "in-1", seq, 100 + total as u64, 100 + total as u64), &[]), 1500);
            assert!(acts.is_empty());
            let acts = s.drain_submits(sink.sender());
            assert!(acts.contains(&Action::EndStream), "total={total}");
            let real: usize = sink.blocks.iter().flatten().filter(|x| **x != 0).count();
            let expected_real = pcm.iter().filter(|x| **x != 0).count();
            assert_eq!(real, expected_real, "total={total}: 真实语音样本一个不多一个不少");
            assert_eq!(sink.samples(), total + Limits::default().tail_silence_samples, "total={total}");
            // 顺序与内容逐样本一致（前 total 个）
            let flat: Vec<i16> = sink.blocks.iter().flatten().copied().collect();
            assert_eq!(&flat[..total], &pcm[..]);
            assert_eq!(s.counters.samples_submitted, total as u64);
            assert_eq!(s.counters.tail_block_samples, (total % BLOCK_SAMPLES) as u64);
            assert_eq!(s.phase(), Phase::Draining);
        }
    }

    /// 矩阵「2 秒 lookback + 4 秒 ready 等待」：6 秒全部保留，不截前三秒（上限 8 s 积压 / 12 s 总量）。
    #[test]
    fn six_seconds_backlog_is_retained() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let pcm = tone(6 * 16000, 9);
        // 先只接收不提交（模拟 ASR 未连上 → 全在 worker 缓冲），再一次性提交
        let mut seq = 0;
        let mut off = 0;
        while off < pcm.len() {
            let n = 640.min(pcm.len() - off);
            let h = header("chunk", "in-1", seq, off as u64, (off + n) as u64);
            let acts = s.on_packet(&pkt(h, &pcm[off..off + n]), 10);
            assert!(acts.is_empty(), "接收阶段无失败");
            off += n;
            seq += 1;
        }
        assert_eq!(s.counters.backlog_peak_samples, 6 * 16000);
        assert_eq!(s.phase(), Phase::Receiving);
        s.drain_submits(sink.sender());
        assert_eq!(sink.samples(), 6 * 16000);
        assert_eq!(s.counters.queue_full_events, 0);
    }

    #[test]
    fn keep_from_crops_only_prefix() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        // 环从 1000 起，用户边界 1000+700
        s.on_packet(&pkt(begin_hdr("in-1", 1000, 1700), &[]), 0);
        let pcm = tone(4000, 3);
        let (seq, _) = feed(&mut s, &mut sink, "in-1", 1000, &pcm, 640, 0);
        s.on_packet(&pkt(header("end", "in-1", seq, 5000, 5000), &[]), 10);
        s.drain_submits(sink.sender());
        let flat: Vec<i16> = sink.blocks.iter().flatten().copied().collect();
        assert_eq!(&flat[..3300], &pcm[700..]);
        assert_eq!(s.counters.samples_cropped_before_keep_from, 700);
        assert_eq!(s.counters.samples_submitted, 3300);
    }

    /// 矩阵「缺片/内容冲突/窗口超限/超时」：一个失败终态；旧输出全失效；终态后包只计数。
    #[test]
    fn missing_seq_is_single_terminal_failure() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        s.on_packet(&pkt(header("chunk", "in-1", 0, 0, 640), &tone(640, 1)), 1);
        s.on_stt_final("半句".into(), 0);
        // 跳过 seq 1
        let acts = s.on_packet(&pkt(header("chunk", "in-1", 2, 1280, 1920), &tone(640, 1)), 2);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["status"] == "failed" && v["reason"] == "missing_seq")));
        assert!(acts.contains(&Action::EndStream));
        assert_eq!(s.phase(), Phase::Terminal);
        assert_eq!(s.outcome(), Some(&Outcome::Failed(FailReason::MissingSeq)));
        // 终态后：end/chunk/final 全部只计数，不产生动作；裁决=Discard
        assert!(s.on_packet(&pkt(header("end", "in-1", 3, 1920, 1920), &[]), 3).is_empty());
        s.on_stt_final("迟到".into(), 0);
        assert_eq!(s.counters.finals_after_terminal, 1);
        assert_eq!(s.counters.packets_after_terminal, 1);
        assert!(s.drain_submits(sink.sender()).is_empty());
        assert_eq!(sink.samples(), 0, "失败后不再提交任何 PCM");
        let (d, acts) = s.on_stream_end(0);
        assert_eq!(d, Decision::Discard(FailReason::MissingSeq));
        assert!(acts.is_empty(), "终态唯一，不再发第二个 result");
    }

    #[test]
    fn duplicate_chunk_is_idempotent_and_overlap_conflict_fails() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let c0 = pkt(header("chunk", "in-1", 0, 0, 640), &tone(640, 1));
        s.on_packet(&c0, 1);
        s.drain_submits(sink.sender());
        // 完全相同重发 → 幂等 ack
        let acts = s.on_packet(&c0, 2);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["t"] == "ack")));
        assert_eq!(s.counters.chunks_duplicate, 1);
        assert_eq!(s.phase(), Phase::Receiving);
        // 部分重叠 [320,960) → 内容冲突整代失败
        let acts = s.on_packet(&pkt(header("chunk", "in-1", 1, 320, 960), &tone(640, 1)), 3);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "duplicate_conflict")));
        assert_eq!(s.phase(), Phase::Terminal);
    }

    #[test]
    fn over_cap_and_timeout_fail_whole_generation() {
        let mut s = Session::new(Some(TRACE.into()), Limits { max_total_samples: 2000, ..Limits::default() });
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        s.on_packet(&pkt(header("chunk", "in-1", 0, 0, 1280), &tone(1280, 1)), 1);
        let acts = s.on_packet(&pkt(header("chunk", "in-1", 1, 1280, 2560), &tone(1280, 1)), 2);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "over_cap")));
        assert_eq!(s.outcome(), Some(&Outcome::Failed(FailReason::OverCap)));

        let mut s2 = session();
        s2.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 1000);
        assert!(s2.on_tick(1000 + 6999).is_empty());
        let acts = s2.on_tick(1000 + 7001);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "timeout")));
        assert_eq!(s2.phase(), Phase::Terminal);
    }

    /// 矩阵「队列满」：try_send 失败 → 计数 + 整代失败，不是 WARN 后继续。
    #[test]
    fn queue_full_counts_and_fails_generation() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: Some(2) };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let pcm = tone(3 * BLOCK_SAMPLES, 1);
        let (_, acts) = feed(&mut s, &mut sink, "in-1", 0, &pcm, BLOCK_SAMPLES, 0);
        assert_eq!(sink.blocks.len(), 2);
        assert_eq!(s.counters.queue_full_events, 1);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "queue_full")));
        assert_eq!(s.outcome(), Some(&Outcome::Failed(FailReason::QueueFull)));
        assert_eq!(s.counters.blocks_submitted, 2);
        assert_eq!(s.counters.samples_submitted, 2 * BLOCK_SAMPLES as u64, "证据里 submitted 只算真写进去的");
    }

    /// 矩阵「同 epoch 新 wake、冲突 begin」：代次隔离；冲突消息被拒但合法代次继续。
    #[test]
    fn conflicting_begin_is_rejected_without_cancelling_active() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        s.on_packet(&pkt(header("chunk", "in-1", 0, 0, 640), &tone(640, 1)), 1);
        // 同 epoch 新 wake generation → 新 input_id 的 begin
        let mut h2 = begin_hdr("in-2", 5000, 5000);
        h2["wake_generation"] = json!(2);
        let acts = s.on_packet(&pkt(h2, &[]), 2);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["input_id"] == "in-2" && v["status"] == "rejected" && v["reason"] == "input_conflict")));
        assert_eq!(s.input_id(), Some("in-1"));
        assert_eq!(s.phase(), Phase::Receiving, "合法代次未被取消");
        // 旧代次的 chunk 照常继续
        s.on_packet(&pkt(header("chunk", "in-1", 1, 640, 1280), &tone(640, 1)), 3);
        assert_eq!(s.counters.chunks_received, 2);
        // 错身份的 cancel 也只拒消息
        let acts = s.on_packet(&pkt(header("cancel", "in-2", 0, 0, 0), &[]), 4);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "identity_mismatch")));
        assert_eq!(s.phase(), Phase::Receiving);
        // 完全相同的 begin 重发 → 幂等 ack
        let acts = s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 5);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["t"] == "ack")));
        assert_eq!(s.counters.packets_rejected, 2);
        let _ = s.drain_submits(sink.sender());
    }

    #[test]
    fn wrong_trace_and_missing_boundary_and_playback_overlap() {
        let mut s = session();
        let mut h = begin_hdr("in-x", 0, 0);
        h["trace_id"] = json!("other");
        let acts = s.on_packet(&pkt(h, &[]), 0);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "trace_mismatch")));
        assert_eq!(s.phase(), Phase::Idle, "错 trace 不建立代次");

        let mut s2 = session();
        let mut h = begin_hdr("in-1", 0, 0);
        h["boundary_kind"] = json!("none");
        let acts = s2.on_packet(&pkt(h, &[]), 0);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "boundary_none")));
        assert_eq!(s2.phase(), Phase::Terminal);

        let mut s3 = session();
        let mut h = begin_hdr("in-1", 0, 0);
        h["overlaps_local_playback"] = json!(true);
        let acts = s3.on_packet(&pkt(h, &[]), 0);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "local_playback_overlap")));
    }

    /// 矩阵「突发跨 VAD/端点、ASR 先 final 后 end」+「失败前后多个 final」：完整性门只在流结束裁决；
    /// 假供应商脚本：interim → final#1（end 前）→ end → final#2（尾静音后）→ LastNoSeq。
    #[test]
    fn fake_vendor_finals_before_and_after_end_commit_once_at_stream_end() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let pcm = tone(2 * 16000 + 777, 4);
        let (seq, _) = feed(&mut s, &mut sink, "in-1", 0, &pcm, 640, 0);
        s.on_stt_interim();
        s.on_stt_final("小可小可，".into(), 0); // 供应商在 end 之前就切出一句
        assert_eq!(s.counters.final_before_end, 1);
        s.on_packet(&pkt(header("end", "in-1", seq, pcm.len() as u64, pcm.len() as u64), &[]), 100);
        let acts = s.drain_submits(sink.sender());
        assert!(acts.contains(&Action::EndStream));
        s.on_stt_final("不要开灯。".into(), 0);
        // 裁决前：没有任何 commit（held 2 条），投机/命令零参与由 pipeline 不调用它们保证
        assert_eq!(s.counters.finals_held, 2);
        let (d, acts) = s.on_stream_end(0);
        assert_eq!(d, Decision::Commit("小可小可，不要开灯。".into()));
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["status"] == "complete" && v["finals"] == 2)));
        assert_eq!(s.outcome(), Some(&Outcome::Committed));
        // 之后再来的 final 只计数
        s.on_stt_final("迟到".into(), 0);
        assert_eq!(s.counters.finals_after_terminal, 1);
        let (d2, acts2) = s.on_stream_end(0);
        assert!(matches!(d2, Decision::Discard(_)));
        assert!(acts2.is_empty());
    }

    /// 矩阵「取消」：显式取消立即终态；已 hold 的 final 作废；流结束裁决=Discard(cancelled)。
    #[test]
    fn cancel_discards_held_finals_and_is_terminal() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let (seq, _) = feed(&mut s, &mut sink, "in-1", 0, &tone(16000, 2), 640, 0);
        s.on_stt_final("不要".into(), 0);
        let acts = s.on_packet(&pkt(header("cancel", "in-1", seq, 0, 0), &[]), 50);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "cancelled")));
        assert!(acts.contains(&Action::EndStream));
        let (d, _) = s.on_stream_end(0);
        assert_eq!(d, Decision::Discard(FailReason::Cancelled));
        assert_eq!(s.counters.finals_held, 1, "hold 过 1 条但已作废");
        assert!(s.drain_submits(sink.sender()).is_empty());
    }

    /// 供应商断连（我们还没收流就结束）→ asr_unavailable；流正常结束但零 final → no_final。
    #[test]
    fn stream_end_without_drain_or_finals_fails() {
        let mut s = session();
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        s.on_packet(&pkt(header("chunk", "in-1", 0, 0, 640), &tone(640, 1)), 1);
        let (d, acts) = s.on_stream_end(0);
        assert_eq!(d, Decision::Discard(FailReason::AsrUnavailable));
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["reason"] == "asr_unavailable")));

        let mut s2 = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s2.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let (seq, _) = feed(&mut s2, &mut sink, "in-1", 0, &tone(3200, 1), 640, 0);
        s2.on_packet(&pkt(header("end", "in-1", seq, 3200, 3200), &[]), 1);
        s2.drain_submits(sink.sender());
        let (d, _) = s2.on_stream_end(0);
        assert_eq!(d, Decision::Discard(FailReason::NoFinal));
    }

    /// codex Kotlin 生成的 OPCM 夹具（P003_OPCM_V03_WIRE_VECTORS_20260908，tests/fixtures/opcm）：
    /// 格式与内容逐样本对撞，并整代跑到 Draining → 流结束 commit。这是 Kotlin→Rust 互通证据。
    #[test]
    fn kotlin_fixtures_parse_and_run_through_session() {
        const BEGIN: &[u8] = include_bytes!("../tests/fixtures/opcm/00-begin.opcm");
        const CHUNK: &[u8] = include_bytes!("../tests/fixtures/opcm/01-chunk.opcm");
        const TAIL: &[u8] = include_bytes!("../tests/fixtures/opcm/02-tail.opcm");
        const END: &[u8] = include_bytes!("../tests/fixtures/opcm/03-end.opcm");
        assert_eq!((BEGIN.len(), CHUNK.len(), TAIL.len(), END.len()), (295, 1577, 305, 297), "与 verification.json 字节数一致");
        let b = parse_packet(BEGIN).unwrap();
        assert_eq!(b.header.t, "begin");
        assert_eq!(b.header.input_id, "fixture-input");
        assert_eq!(b.header.trace_id, "fixture-trace");
        assert_eq!(b.header.session_id, "fixture-session");
        assert_eq!((b.header.capture_epoch, b.header.wake_generation, b.header.seq), (1, 1, 0));
        assert_eq!(b.header.boundary_kind.as_deref(), Some("wake_lookback"));
        assert_eq!(b.header.keep_from, Some(0));
        assert_eq!(b.header.overlaps_local_playback, Some(false));
        assert_eq!((b.header.sr, b.header.ch, b.header.fmt.as_deref()), (Some(16000), Some(1), Some("s16le")));
        assert!(b.pcm.is_empty());
        let c = parse_packet(CHUNK).unwrap();
        assert_eq!((c.header.t.as_str(), c.header.seq, c.header.start, c.header.end), ("chunk", 0, 0, 640));
        assert_eq!(c.pcm.len(), 640);
        assert!(c.pcm.iter().enumerate().all(|(i, &x)| x == i as i16 - 320), "样本 -320..319 逐个一致");
        let t = parse_packet(TAIL).unwrap();
        assert_eq!((t.header.seq, t.header.start, t.header.end), (1, 640, 643));
        assert_eq!(t.pcm, vec![-32768, 32767, -1], "带符号极值尾片");
        let e = parse_packet(END).unwrap();
        assert_eq!((e.header.t.as_str(), e.header.seq, e.header.start, e.header.end), ("end", 2, 643, 643));
        assert!(e.pcm.is_empty());
        // 整代跑通：begin→chunk→tail→end→drain(尾块 643 + 尾静音)→收流→final→commit
        let mut s = Session::new(Some("fixture-trace".into()), Limits::default());
        let mut sink = Sink { blocks: vec![], cap: None };
        let acts = s.on_packet(&b, 0);
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["t"] == "ack" && v["received_next"] == 0)));
        s.on_packet(&c, 1);
        let acts = s.drain_submits(sink.sender());
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["t"] == "ack" && v["received_next"] == 640 && v["queued_next"] == 0)),
            "640 样本不足一块:received 前进、queued 不动");
        s.on_packet(&t, 2);
        s.drain_submits(sink.sender());
        assert!(s.on_packet(&e, 3).is_empty());
        let acts = s.drain_submits(sink.sender());
        assert!(acts.contains(&Action::EndStream));
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["queued_next"] == 643)));
        assert_eq!(s.phase(), Phase::Draining);
        let flat: Vec<i16> = sink.blocks.iter().flatten().copied().collect();
        let expected: Vec<i16> = c.pcm.iter().chain(t.pcm.iter()).copied().collect();
        assert_eq!(&flat[..643], &expected[..]);
        assert_eq!(sink.samples(), 643 + Limits::default().tail_silence_samples);
        assert_eq!((s.counters.chunks_received, s.counters.samples_received, s.counters.tail_block_samples), (2, 643, 643));
        s.on_stt_final("夹具".into(), 0);
        let (d, acts) = s.on_stream_end(0);
        assert_eq!(d, Decision::Commit("夹具".into()));
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["status"] == "complete" && v["samples_queued"] == 643)));
    }

    /// 供应商正常 LastNoSeq（→ on_stream_end）与意外 EOF/断连（→ on_stream_interrupted）必须区分：
    /// 后者已 hold 的半段 final 绝不提交，且终态唯一。
    #[test]
    fn interrupted_stream_never_commits_held_finals() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        let (seq, _) = feed(&mut s, &mut sink, "in-1", 0, &tone(16000, 2), 640, 0);
        s.on_packet(&pkt(header("end", "in-1", seq, 16000, 16000), &[]), 1);
        s.drain_submits(sink.sender());
        s.on_stt_final("半段".into(), 0);
        let acts = s.on_stream_interrupted();
        assert!(acts.iter().any(|a| matches!(a, Action::Publish(v) if v["status"] == "failed" && v["reason"] == "asr_unavailable")));
        assert_eq!(s.counters.stream_interrupted, 1);
        let (d, acts2) = s.on_stream_end(0);
        assert_eq!(d, Decision::Discard(FailReason::AsrUnavailable), "随后的 Closed 不得变成 commit");
        assert!(acts2.is_empty(), "终态唯一，不发第二个 result");
        // 中途断连(还没 end)同样作废
        let mut s2 = session();
        s2.on_packet(&pkt(begin_hdr("in-1", 0, 0), &[]), 0);
        s2.on_stt_final("早到的半段".into(), 0);
        let acts = s2.on_stream_interrupted();
        assert!(acts.contains(&Action::EndStream), "未收流时中断也要请求收流");
        assert_eq!(s2.outcome(), Some(&Outcome::Failed(FailReason::AsrUnavailable)));
    }

    /// 三条上限同时成立：总包 ≤ 15 KiB、头 ≤ 2 KiB、PCM ≤ 7168 样本；14 KiB PCM + 2 KiB 头 会因总包超限被拒。
    #[test]
    fn packet_total_size_limit() {
        let mut h = header("chunk", "in-1", 0, 0, 7168);
        h["pad"] = json!("x".repeat(1500)); // 头 ≈1.7 KiB(<2 KiB) + PCM 14 KiB > 15 KiB
        let raw = encode_packet(&h, &tone(7168, 1));
        assert!(raw.len() > MAX_PACKET_BYTES);
        assert!(matches!(parse_packet(&raw).unwrap_err(), ParseError::PacketTooLarge(_)));
        // 客户端实际形态:640 样本 + 短头 ≈ 1.6 KiB,放行
        let ok = encode_packet(&header("chunk", "in-1", 0, 0, 640), &tone(640, 1));
        assert!(ok.len() < 2048, "实际包 {} B", ok.len());
        assert!(parse_packet(&ok).is_ok());
    }

    /// 机器可读证据：跑一遍完整正向脚本并落盘 target/ordered_pcm_evidence.json（无 PCM、无文本）。
    /// B6 时戳(2026-09-09):证据记 begin 相对时刻——首块/首 final/end/收流裁决,以及 final 领先 end 的毫秒数
    /// (真机 B 型房 final_before_end=1 却量不出领先量,这里补上;全部注入时钟,不依赖挂钟)。
    #[test]
    fn evidence_records_timeline_relative_to_begin() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-t", 0, 0), &[]), 1000);
        let pcm = tone(3200, 9);
        s.on_packet(&pkt(header("chunk", "in-t", 0, 0, 3200), &pcm), 1100);
        s.drain_submits(sink.sender());
        s.on_stt_final("先到的句".into(), 1250);
        s.on_packet(&pkt(header("end", "in-t", 1, 3200, 3200), &[]), 1300);
        s.drain_submits(sink.sender());
        let (d, _) = s.on_stream_end(1350);
        assert_eq!(d, Decision::Commit("先到的句".into()));
        let ev = s.evidence();
        assert_eq!(ev["first_chunk_ms"], 100);
        assert_eq!(ev["first_final_ms"], 250);
        assert_eq!(ev["end_ms"], 300);
        assert_eq!(ev["stream_end_ms"], 350);
        assert_eq!(ev["final_lead_over_end_ms"], 50);
        assert_eq!(ev["final_before_end"], 1);
        // 没有 final 的代次:领先量为 null,不编数
        let mut s2 = session();
        s2.on_packet(&pkt(begin_hdr("in-u", 0, 0), &[]), 0);
        assert!(s2.evidence()["final_lead_over_end_ms"].is_null());
        assert!(s2.evidence()["first_chunk_ms"].is_null());
    }

    #[test]
    fn evidence_dump_positive_path() {
        let mut s = session();
        let mut sink = Sink { blocks: vec![], cap: None };
        s.on_packet(&pkt(begin_hdr("in-evidence", 0, 480), &[]), 0);
        let pcm = tone(2 * 16000 + 4 * 16000 + 640, 7); // 2 s lookback + 4 s 等待 + 首句片段
        let (seq, _) = feed(&mut s, &mut sink, "in-evidence", 0, &pcm, 640, 0);
        for _ in 0..3 {
            s.note_rtc_frame_dropped();
        }
        s.on_stt_interim();
        s.on_packet(&pkt(header("end", "in-evidence", seq, pcm.len() as u64, pcm.len() as u64), &[]), 100);
        s.drain_submits(sink.sender());
        s.on_stt_final("不要开灯。".into(), 0);
        let (d, _) = s.on_stream_end(0);
        assert!(matches!(d, Decision::Commit(_)));
        let ev = s.evidence();
        assert_eq!(ev["outcome"], "committed");
        assert_eq!(ev["samples_received"], pcm.len() as u64);
        assert_eq!(ev["samples_queued"], (pcm.len() - 480) as u64);
        assert_eq!(ev["stream_interrupted"], 0);
        assert_eq!(ev["rtc_frames_dropped"], 3);
        assert_eq!(ev["queue_full_events"], 0);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("ordered_pcm_evidence.json");
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&ev).unwrap()).unwrap();
        println!("evidence: {}", serde_json::to_string(&ev).unwrap());
    }
}
