//! 设备 → worker 的入站控制通道(S2-B1,2026-08-15)。
//!
//! 在此之前 worker 的 DataChannel **只出不进**:订阅的 7 个 `RoomEvent` 里没有
//! `DataReceived`,两处 `publish_data` 全是出站。于是设备**没有任何办法通知云端「停」**——
//! 本地喊停设备可以自己不放声音,但云端会继续合成、继续计费,恢复时还会从半句接上。
//!
//! 协议 envelope 与 Android 侧对齐(见 `VOICE-RUST-WORKER-ANDROID-CONTRACT-S2B1.md` §8):
//! topic 固定 `control`,reliable + ordered。
//!
//! ```jsonc
//! { "trace_id":"...", "ts_ms":0, "src":"android", "type":"cancel",
//!   "lane":"L2", "seq":1, "payload":{"reason":"user_barge"} }
//! ```
//!
//! 纪律:
//! - **只认 `src=android`**。worker 自己发的 ack 也走同一 topic,不过滤会自己吃自己。
//! - 幂等键是 `(trace_id, seq)`;重复 cancel 回 `already_done=true` 而**不是报错**。
//! - 解析失败一律丢弃并只记 debug——控制通道是外部输入,不能让畸形包影响主链路。

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

pub const TOPIC: &str = "control";
/// S2-B2 设备命令出站(worker → android,合同 §4.3)
pub const DEVICE_CMD_TOPIC: &str = "p003.device.command.v1";
/// S2-B2 设备结果入站(android → worker,合同 §4.4)
pub const DEVICE_RESULT_TOPIC: &str = "p003.device.command.result.v1";
/// 幂等表上限:一个 job 内的控制包不会多到这个量级,超了说明对端在刷,截断即可。
const SEEN_MAX: usize = 512;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Envelope {
    pub trace_id: String,
    #[serde(default)]
    pub ts_ms: i64,
    pub src: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub lane: Option<String>,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// 停止本轮生成与播放(川哥 2026-08-15 拍板:走硬 abort,不进假打断窗口——
    /// 用户明确按了停,不该再等 1.5s 定时器判断他是不是说错话了)
    Cancel,
    /// 芯片唤醒 / VAD 起止 / 无参数命令词(旧 APK):旁路记录,**不改变 worker 的 turn 判定**
    Bypass,
    /// 带 label 的命令词(2026-08-18 晚修订,从 Bypass 拆出):VAD 芯片命中→Android 暂存
    /// →进房转发,worker 按目录生成 proposed——早说空窗(命令早于 input_ready 540ms
    /// 真机实证)的补链。Android 仍不直接执行,worker 保持设备命令权威。
    /// 2b 合同 v2:Android 硬件候选 ID(`vad:<trace_id>:<seq>`,原样透传不解析;v185 前老包=None)
    CommandWord { label: u32, before_ready: bool, candidate_id: Option<String> },
    /// S2B1 联调:确定性长句走**正式** TTS→segmenter→playout 链路(合同真值
    /// tests/fixtures/s2b1_canary_control_contract.json,rust 侧用 include_str! 锁死)
    CanarySay,
    /// v140 退出信令 ACK(android → worker,合同 §4.3):同 seq 幂等回执。
    /// worker 收到即停重试(payload 的 accepted/already_done 只记日志)。
    SessionExitAck,
    /// 2b 合同 v2:Android 能力声明(随 wake 包 `payload.device_command_contract_version`);
    /// <2 或缺失=该 room 只观察不发 L2。缺字段的 wake 仍映射 Bypass(老 APK 兼容)。
    Capability { contract_version: u32 },
}

/// 解析入站包。返回 None = 丢弃(非 android / 未知类型 / 畸形)。
pub fn parse(raw: &[u8]) -> Option<(Envelope, Inbound)> {
    let ev: Envelope = serde_json::from_slice(raw).ok()?;
    if ev.src != "android" {
        return None; // worker 自己的 ack 也在这个 topic 上,必须挡掉
    }
    let kind = match ev.kind.as_str() {
        "cancel" => Inbound::Cancel,
        "wake" => match ev.payload.get("device_command_contract_version").and_then(|v| v.as_u64()) {
            Some(v) if v <= u32::MAX as u64 => Inbound::Capability { contract_version: v as u32 },
            _ => Inbound::Bypass,
        },
        "vad" => Inbound::Bypass,
        // command_word 带合法 label → 动作源;无 label(旧 APK 无参数 Hook)→ 旁路兼容
        "command_word" => match ev.payload.get("label").and_then(|v| v.as_u64()) {
            Some(l) if l <= u32::MAX as u64 => Inbound::CommandWord {
                label: l as u32,
                before_ready: ev
                    .payload
                    .get("observed_before_input_ready")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                candidate_id: ev
                    .payload
                    .get("vad_candidate_id")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            },
            _ => Inbound::Bypass,
        },
        "canary.say" => Inbound::CanarySay,
        "session_exit_detected.ack" => Inbound::SessionExitAck,
        _ => return None,
    };
    Some((ev, kind))
}

/// `(trace_id, seq)` 幂等表。
#[derive(Default)]
pub struct Dedup {
    seen: HashSet<(String, i64)>,
}

impl Dedup {
    /// 只查不记:canary 的校验链要先判重复再决定是否执行,执行成功才 first_time 落表
    /// (被 already_running/invalid 拒掉的 seq 必须可重试,不能被误记成已执行)。
    pub fn seen(&self, trace_id: &str, seq: i64) -> bool {
        self.seen.contains(&(trace_id.to_string(), seq))
    }

    /// 首次见到返回 true;重复返回 false(调用方据此回 already_done)。
    pub fn first_time(&mut self, trace_id: &str, seq: i64) -> bool {
        if self.seen.len() >= SEEN_MAX {
            self.seen.clear(); // 简单截断优于无界增长;重放窗口丢失可接受
        }
        self.seen.insert((trace_id.to_string(), seq))
    }
}

/// 构造 `cancel.ack`。`cancelled`=本次是否真的执行了取消动作。
pub fn cancel_ack(
    trace_id: &str,
    seq: i64,
    ts_ms: i64,
    cancelled: bool,
    already_done: bool,
) -> Value {
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "cancel.ack",
        "lane": "L2",
        "seq": seq,
        "payload": {"cancelled": cancelled, "already_done": already_done},
    })
}

/// 构造 `session_exit_detected`(v140 合同 §4.1:worker → android 退出信令)。
/// 纪律:**禁带原始转写文本/凭据/完整 SN**——payload 只有冻结枚举两枚。
/// reply_kind=general|goodbye|night;path=exact|tail|fragment;重试必须同 seq。
pub fn session_exit_detected(
    trace_id: &str,
    ts_ms: i64,
    seq: i64,
    reply_kind: &str,
    path: &str,
) -> Value {
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "session_exit_detected",
        "lane": "L2",
        "seq": seq,
        "payload": {"reply_kind": reply_kind, "path": path},
    })
}

/// input_ready 各分段时延(合同 2026-08-18:dispatch 时刻 worker 观测不到,故第一段
/// 以 room 名尾部的签发 unix 秒为锚——秒级精度+跨机 NTP 误差,仅供观测不进门禁)。
pub struct ReadyTimings {
    pub issue_to_assignment_ms: Option<i64>,
    pub job_room_connect_ms: i64,
    pub track_to_input_loop_ms: i64,
}

/// 构造 `session.input_ready`(codex 冻结 2026-08-18):绑定 Room 会话级 activeTraceId
/// (经 token agents[0].metadata → job.metadata 受信通道,非设备 payload 自述)。
/// 只能在输入消费循环真实收到首帧后调用;每 job 至多一次(幂等由 pipeline 首帧标志保证)。
pub fn input_ready(
    trace_id: &str,
    ts_ms: i64,
    room: &str,
    output_ready: bool,
    t: &ReadyTimings,
) -> Value {
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "session.input_ready",
        "lane": "L2",
        "payload": {
            "room": room,
            "user_track_subscribed": true,
            "input_loop_started": true,
            "output_ready": output_ready,
            "timings_ms": {
                "issue_to_assignment": t.issue_to_assignment_ms,
                "job_room_connect": t.job_room_connect_ms,
                "track_to_input_loop": t.track_to_input_loop_ms,
            },
        },
    })
}

/// 构造 `session.output_ready`(合同 §5.4:仅诊断,不作为 Android 任何门)。
pub fn output_ready(trace_id: &str, ts_ms: i64, room: &str) -> Value {
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "session.output_ready",
        "lane": "L2",
        "payload": {"room": room, "agent_track_subscribed": true},
    })
}

// ── S2-B2 设备命令(合同 CC_P003_S2B2_ONLINE_DEVICE_COMMANDS_HANDOFF_20260818 §4.3/§4.4) ──

/// 构造 `device.command.proposed`。差异声明(交接文档同步):合同 schema 的
/// asr_confidence 字段暂缺——当前火山 final 事件未暴露置信度,Android 校验勿依赖。
#[allow(clippy::too_many_arguments)]
pub fn device_command_proposed(
    trace_id: &str,
    ts_ms: i64,
    idempotency_key: &str,
    semantic_label: u32,
    action: &str,
    canonical_phrase: &str,
    normalized_text: &str,
    match_type: &str,
    lane: &str,
    vad_candidate_id: Option<&str>,
) -> Value {
    json!({
        "version": "1.0",
        "type": "device.command.proposed",
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "lane": lane,
        "idempotency_key": idempotency_key,
        "payload": {
            "semantic_label": semantic_label,
            "action": action,
            "canonical_phrase": canonical_phrase,
            "normalized_text": normalized_text,
            "match_type": match_type,
            "vad_candidate_id": vad_candidate_id,
        },
    })
}

/// device.command.result 入站解析。None=丢弃(非 android / 类型不符 / 缺关键字段)。
/// status 合同枚举:accepted/succeeded/already_applied/rejected/failed/timeout。
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceResult {
    pub trace_id: String,
    /// 2b:Android 原样回写 proposal 的 lane(L1|L2);老 APK 无字段=L1
    pub lane: String,
    pub idempotency_key: String,
    pub semantic_label: u64,
    pub status: String,
    pub reason: String,
    /// v217+ 增量透传(2026-09-04):payload 里 semantic_label/action/status/reason 之外的键
    /// (规范化读数/来源/image_distance_boundary_conflict/observed_state…)紧凑 JSON,截 400 字符。
    /// 只进日志对撞(`device command result … extra=`),不参与任何判定;老 APK 无增量键=空串。
    pub extra: String,
}

/// result payload 增量键透传(见 DeviceResult.extra):剔除已知键后为空 → ""。
pub fn device_result_extra(payload: &Value) -> String {
    const KNOWN: [&str; 4] = ["semantic_label", "action", "status", "reason"];
    let Some(obj) = payload.as_object() else {
        return String::new();
    };
    let m: serde_json::Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| !KNOWN.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if m.is_empty() {
        return String::new();
    }
    let s = Value::Object(m).to_string();
    if s.chars().count() > 400 {
        s.chars().take(400).collect()
    } else {
        s
    }
}

pub fn parse_device_result(raw: &[u8]) -> Option<DeviceResult> {
    let v: Value = serde_json::from_slice(raw).ok()?;
    if v["src"] != "android" || v["type"] != "device.command.result" {
        return None;
    }
    let p = &v["payload"];
    Some(DeviceResult {
        trace_id: v["trace_id"].as_str()?.to_string(),
        lane: v["lane"].as_str().unwrap_or("L1").to_string(),
        idempotency_key: v["idempotency_key"].as_str()?.to_string(),
        semantic_label: p["semantic_label"].as_u64().unwrap_or(0),
        status: p["status"].as_str()?.to_string(),
        reason: p["reason"].as_str().unwrap_or("").to_string(),
        extra: device_result_extra(p),
    })
}

/// ack reason 全集——与合同 fixture 的 ack.reasons 逐项一致(单测锁死)。
pub const CANARY_REASONS: [&str; 6] = [
    "ok",
    "already_done",
    "disabled",
    "stale_trace",
    "invalid_text",
    "already_running",
];
/// 入站 ts_ms 与本机时钟偏差超过此值判 stale_trace(fixture inbound.stale_ts_skew_ms)。
pub const CANARY_STALE_SKEW_MS: i64 = 120_000;
/// canary 文本长度上限(Unicode 字符数,fixture inbound.text_max_chars)。
pub const CANARY_TEXT_MAX: usize = 300;

/// 构造 `canary.say.ack`。reason 必须取自 CANARY_REASONS(debug_assert 拦手误)。
pub fn canary_say_ack(
    trace_id: &str,
    seq: i64,
    ts_ms: i64,
    accepted: bool,
    already_done: bool,
    reason: &str,
) -> Value {
    debug_assert!(CANARY_REASONS.contains(&reason));
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "canary.say.ack",
        "lane": "L2",
        "seq": seq,
        "payload": {"accepted": accepted, "already_done": already_done, "reason": reason},
    })
}

/// 构造 `canary.say.metrics`(final=true 单发)。字段名 2026-08-16 与 codex 冻结,
/// 改动必须先改 fixture 并双方确认。audio_duration_ms = played_frames × 10ms 帧长。
pub fn canary_metrics(
    trace_id: &str,
    seq: i64,
    ts_ms: i64,
    test_id: &str,
    fs: &crate::playout::FinalStats,
) -> Value {
    json!({
        "trace_id": trace_id,
        "ts_ms": ts_ms,
        "src": "worker",
        "type": "canary.say.metrics",
        "lane": "L2",
        "seq": seq,
        "payload": {
            "test_id": test_id,
            "audio_duration_ms": fs.played_frames * 10,
            "underrun_count": fs.underrun_count,
            "underrun_ms": fs.underrun_ms,
            "buffered_audio_ms": fs.buffered_audio_ms,
            "first_underrun_ms": fs.first_underrun_ms,
            "played_frames": fs.played_frames,
            "final": true,
            "completed": fs.completed,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_exit_signal_contract() {
        // v140 §4.1 出站 envelope 冻结字段
        let v = session_exit_detected("tr-1", 1787900000000, 77, "general", "tail");
        assert_eq!(v["src"], "worker");
        assert_eq!(v["type"], "session_exit_detected");
        assert_eq!(v["lane"], "L2");
        assert_eq!(v["seq"], 77);
        assert_eq!(v["payload"]["reply_kind"], "general");
        assert_eq!(v["payload"]["path"], "tail");
        // 纪律:不带转写正文/SN 字段
        assert!(v["payload"].get("text").is_none());
        assert!(v["payload"].get("sn").is_none());
        // 自己发的信令(src=worker)绝不会被自己的入站 parse 吃掉
        assert!(parse(v.to_string().as_bytes()).is_none());
    }

    #[test]
    fn session_exit_ack_parses() {
        // v140 §4.3 入站 ACK(src=android,同 seq)
        let raw = br#"{"trace_id":"tr-1","ts_ms":1,"src":"android","type":"session_exit_detected.ack","lane":"control","seq":77,"payload":{"accepted":true,"already_done":false,"reply_kind":"general"}}"#;
        let (ev, kind) = parse(raw).expect("ack 应可解析");
        assert_eq!(kind, Inbound::SessionExitAck);
        assert_eq!(ev.seq, 77);
        assert_eq!(ev.payload["accepted"], true);
    }

    fn pkt(src: &str, kind: &str) -> Vec<u8> {
        json!({"trace_id":"t1","ts_ms":1,"src":src,"type":kind,"lane":"L2","seq":1,
               "payload":{"reason":"user_barge"}})
        .to_string()
        .into_bytes()
    }

    #[test]
    fn accepts_android_cancel() {
        let (ev, k) = parse(&pkt("android", "cancel")).unwrap();
        assert_eq!(k, Inbound::Cancel);
        assert_eq!(ev.trace_id, "t1");
        assert_eq!(ev.seq, 1);
    }

    #[test]
    fn rejects_own_ack_on_same_topic() {
        // worker 的 ack 与设备指令同走 control topic,不挡掉就会自己取消自己
        assert!(parse(&pkt("worker", "cancel.ack")).is_none());
        assert!(
            parse(&pkt("worker", "cancel")).is_none(),
            "src=worker 的 cancel 也必须丢"
        );
    }

    #[test]
    fn bypass_events_do_not_map_to_cancel() {
        // 芯片 VAD/唤醒只是旁路语义,绝不能门控或打断主链路
        for k in ["wake", "vad", "command_word"] {
            assert_eq!(parse(&pkt("android", k)).unwrap().1, Inbound::Bypass, "{k}");
        }
    }

    #[test]
    fn canary_say_parses_and_worker_src_rejected() {
        let (ev, kind) = parse(&pkt("android", "canary.say")).unwrap();
        assert_eq!(kind, Inbound::CanarySay);
        assert_eq!(ev.seq, 1);
        assert!(
            parse(&pkt("worker", "canary.say")).is_none(),
            "src=worker 必须丢"
        );
    }

    #[test]
    fn dedup_seen_is_readonly() {
        let mut d = Dedup::default();
        assert!(!d.seen("t", 9));
        assert!(!d.seen("t", 9), "seen 不落表,连问两次都该是 false");
        assert!(d.first_time("t", 9));
        assert!(d.seen("t", 9));
    }

    #[test]
    fn contract_fixture_locks_protocol() {
        // 合同锁:rust 侧与 python 侧引用同一份 fixture,任何一侧漂移这里先红
        let raw = include_str!("../../tests/fixtures/s2b1_canary_control_contract.json");
        let c: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(c["topic"], TOPIC);
        assert_eq!(c["inbound"]["type"], "canary.say");
        assert_eq!(c["inbound"]["text_max_chars"], CANARY_TEXT_MAX as i64);
        assert_eq!(c["inbound"]["stale_ts_skew_ms"], CANARY_STALE_SKEW_MS);
        let reasons: Vec<&str> = c["ack"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            reasons,
            CANARY_REASONS.to_vec(),
            "reason 枚举与 fixture 漂移"
        );
        // metrics 字段名冻结:构造器产出的键集合 == fixture 声明的键集合
        let fs = crate::playout::FinalStats {
            underrun_count: 0,
            underrun_ms: 0,
            buffered_audio_ms: -1,
            first_underrun_ms: -1,
            played_frames: 621,
            completed: true,
        };
        let m = canary_metrics("t", 1, 0, "x", &fs);
        let mut got: Vec<String> = m["payload"].as_object().unwrap().keys().cloned().collect();
        got.sort();
        let mut want: Vec<String> = c["metrics"]["payload_fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        want.sort();
        assert_eq!(got, want, "metrics 字段与 fixture 冻结清单漂移");
        assert_eq!(m["payload"]["audio_duration_ms"], 6210, "帧长 10ms 换算");
        // ack 构造器字段
        let a = canary_say_ack("t", 1, 0, true, false, "ok");
        let mut ak: Vec<String> = a["payload"].as_object().unwrap().keys().cloned().collect();
        ak.sort();
        let mut aw: Vec<String> = c["ack"]["payload_fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        aw.sort();
        assert_eq!(ak, aw);
    }

    #[test]
    fn unknown_type_and_garbage_are_dropped_not_panicking() {
        assert!(parse(&pkt("android", "reboot_everything")).is_none());
        assert!(parse(b"not json").is_none());
        assert!(parse(b"{}").is_none());
    }

    #[test]
    fn dedup_is_per_trace_and_seq() {
        let mut d = Dedup::default();
        assert!(d.first_time("t1", 1));
        assert!(!d.first_time("t1", 1), "同 trace 同 seq 必须判重复");
        assert!(d.first_time("t1", 2), "同 trace 不同 seq 是新指令");
        assert!(d.first_time("t2", 1), "不同 trace 同 seq 是新指令");
    }

    #[test]
    fn ack_shape_matches_android_contract() {
        let a = cancel_ack("t1", 3, 99, true, false);
        assert_eq!(a["src"], "worker");
        assert_eq!(a["type"], "cancel.ack");
        assert_eq!(a["trace_id"], "t1");
        assert_eq!(a["seq"], 3);
        assert_eq!(a["payload"]["cancelled"], true);
        assert_eq!(a["payload"]["already_done"], false);
    }

    /// command_word 入站(2026-08-18 晚合同):带 label→CommandWord;无 label→Bypass(旧 APK 兼容)。
    #[test]
    fn command_word_parse_variants() {
        let with_label = r#"{"trace_id":"t","ts_ms":1,"src":"android","type":"command_word",
            "lane":"L1","seq":1,"payload":{"label":42,"source":"vad_chip","observed_before_input_ready":true}}"#;
        let (_, kind) = parse(with_label.as_bytes()).expect("合法包必须解析");
        assert_eq!(kind, Inbound::CommandWord { label: 42, before_ready: true, candidate_id: None });
        let no_label = r#"{"trace_id":"t","ts_ms":1,"src":"android","type":"command_word",
            "lane":"L1","seq":1,"payload":{}}"#;
        let (_, kind2) = parse(no_label.as_bytes()).expect("旧形态仍解析");
        assert_eq!(kind2, Inbound::Bypass, "无 label 保持旁路兼容");
        let spoofed = with_label.replace("\"src\":\"android\"", "\"src\":\"worker\"");
        assert!(parse(spoofed.as_bytes()).is_none(), "src=worker 必须丢");
    }

    /// input_ready 合同 JSON(codex 冻结 2026-08-18)逐字段锁死。
    #[test]
    fn input_ready_shape_matches_frozen_contract() {
        let t = ReadyTimings {
            issue_to_assignment_ms: Some(510),
            job_room_connect_ms: 120,
            track_to_input_loop_ms: 42,
        };
        let v = input_ready("trace-x", 1234, "sn-BJP00300000000000001-1", false, &t);
        assert_eq!(v["src"], "worker");
        assert_eq!(v["type"], "session.input_ready");
        assert_eq!(v["trace_id"], "trace-x");
        assert_eq!(v["lane"], "L2");
        assert_eq!(v["payload"]["user_track_subscribed"], true);
        assert_eq!(v["payload"]["input_loop_started"], true);
        assert_eq!(v["payload"]["output_ready"], false);
        assert_eq!(v["payload"]["timings_ms"]["issue_to_assignment"], 510);
        assert_eq!(v["payload"]["timings_ms"]["job_room_connect"], 120);
        assert_eq!(v["payload"]["timings_ms"]["track_to_input_loop"], 42);
    }

    /// S2-B2 proposed 合同 JSON 逐字段锁死(§4.3)。
    #[test]
    fn device_command_proposed_shape() {
        let v = device_command_proposed(
            "trace-d", 1787040000000, "voice:sn-X-1:3:2", 2, "led_on",
            "打开灯光", "把灯打开", "exact_alias",
            "L1",
            None,
        );
        assert_eq!(v["version"], "1.0");
        assert_eq!(v["type"], "device.command.proposed");
        assert_eq!(v["src"], "worker");
        assert_eq!(v["lane"], "L1");
        assert_eq!(v["idempotency_key"], "voice:sn-X-1:3:2");
        assert_eq!(v["payload"]["semantic_label"], 2);
        assert_eq!(v["payload"]["action"], "led_on");
        assert_eq!(v["payload"]["canonical_phrase"], "打开灯光");
        assert_eq!(v["payload"]["normalized_text"], "把灯打开");
        assert_eq!(v["payload"]["match_type"], "exact_alias");
    }

    /// S2-B2 result 入站(§4.4):android 合法包解析;worker 自述/坏类型丢弃。
    #[test]
    fn device_result_parse_and_reject() {
        let good = r#"{"version":"1.0","type":"device.command.result","trace_id":"t","ts_ms":1,
            "src":"android","lane":"L1","idempotency_key":"voice:r:3:2",
            "payload":{"semantic_label":2,"action":"led_on","status":"succeeded","reason":"state_confirmed","observed_state":{"led":1}}}"#;
        let r = parse_device_result(good.as_bytes()).expect("合法包必须解析");
        assert_eq!(r.status, "succeeded");
        assert_eq!(r.idempotency_key, "voice:r:3:2");
        assert_eq!(r.semantic_label, 2);
        let spoofed = good.replace("\"src\":\"android\"", "\"src\":\"worker\"");
        assert!(parse_device_result(spoofed.as_bytes()).is_none(), "src=worker 必须丢");
        let wrong_type = good.replace("device.command.result", "device.command.proposed");
        assert!(parse_device_result(wrong_type.as_bytes()).is_none(), "类型不符必须丢");
        assert!(parse_device_result(b"not json").is_none(), "畸形包必须丢");
    }

    /// worker 自发的 ready 事件走同一 topic:入站 parse 必须丢弃(src=worker),不得自食。
    #[test]
    fn own_ready_events_rejected_by_inbound_parse() {
        let t = ReadyTimings {
            issue_to_assignment_ms: None,
            job_room_connect_ms: 0,
            track_to_input_loop_ms: 0,
        };
        let ready = input_ready("t", 1, "r", true, &t).to_string();
        assert!(parse(ready.as_bytes()).is_none(), "input_ready 不得被自己消费");
        let oready = output_ready("t", 1, "r").to_string();
        assert!(parse(oready.as_bytes()).is_none(), "output_ready 不得被自己消费");
    }

    #[test]
    fn wake_with_contract_version_maps_capability() {
        let raw = json!({"trace_id":"t1","ts_ms":1,"src":"android","type":"wake","seq":1,
            "payload":{"device_command_contract_version":2}}).to_string();
        let (_, k) = parse(raw.as_bytes()).unwrap();
        assert_eq!(k, Inbound::Capability { contract_version: 2 });
        // 缺字段的 wake 仍是旁路(老 APK)
        assert_eq!(parse(&pkt("android", "wake")).unwrap().1, Inbound::Bypass);
    }

    #[test]
    fn command_word_carries_candidate_id() {
        let raw = json!({"trace_id":"t1","ts_ms":1,"src":"android","type":"command_word","seq":2,
            "payload":{"label":6,"observed_before_input_ready":false,"vad_candidate_id":"vad:t1:1"}}).to_string();
        let (_, k) = parse(raw.as_bytes()).unwrap();
        assert_eq!(k, Inbound::CommandWord { label: 6, before_ready: false, candidate_id: Some("vad:t1:1".into()) });
        let raw2 = json!({"trace_id":"t1","ts_ms":1,"src":"android","type":"command_word","seq":3,
            "payload":{"label":6}}).to_string();
        assert_eq!(parse(raw2.as_bytes()).unwrap().1, Inbound::CommandWord { label: 6, before_ready: false, candidate_id: None });
    }

    #[test]
    fn proposed_l2_carries_lane_and_candidate() {
        let v = device_command_proposed("t1", 1, "voice:r:3:6", 6, "brightness_down", "调暗一点", "太亮了", "llm", "L2", Some("vad:t1:1"));
        assert_eq!(v["lane"], "L2");
        assert_eq!(v["payload"]["match_type"], "llm");
        assert_eq!(v["payload"]["vad_candidate_id"], "vad:t1:1");
        let v1 = device_command_proposed("t1", 1, "voice:r:3:6", 6, "brightness_down", "调暗一点", "太亮了", "exact_alias", "L1", None);
        assert_eq!(v1["lane"], "L1");
        assert!(v1["payload"]["vad_candidate_id"].is_null(), "L1 候选恒 null");
    }

    #[test]
    fn device_result_lane_defaults_to_l1() {
        let raw = r#"{"trace_id":"r","type":"device.command.result","ts_ms":1,
            "src":"android","idempotency_key":"voice:r:3:2",
            "payload":{"semantic_label":2,"action":"led_on","status":"succeeded","reason":"state_confirmed"}}"#;
        assert_eq!(parse_device_result(raw.as_bytes()).unwrap().lane, "L1");
        let raw2 = r#"{"trace_id":"r","type":"device.command.result","ts_ms":1,"lane":"L2",
            "src":"android","idempotency_key":"voice:r:3:6",
            "payload":{"semantic_label":6,"action":"brightness_down","status":"rejected","reason":"candidate_conflict"}}"#;
        let r = parse_device_result(raw2.as_bytes()).unwrap();
        assert_eq!(r.lane, "L2");
        assert_eq!(r.reason, "candidate_conflict");
    }

    /// 2026-09-04:v217+ result 增量键(规范化读数/来源/冲突标记)原样进 extra 供双端对撞;老包为空;超长截 400。
    #[test]
    fn device_result_extra_passthrough_for_v217_fields() {
        let raw = r#"{"trace_id":"r","type":"device.command.result","ts_ms":1,"lane":"L1",
            "src":"android","idempotency_key":"voice:r:3:35",
            "payload":{"semantic_label":35,"action":"virtual_image_farthest","status":"rejected","reason":"boundary_reached",
            "image_distance_boundary_conflict":true,"image_distance_raw":120,"image_distance_source":"mcu_boundary_conflict"}}"#;
        let r = parse_device_result(raw.as_bytes()).unwrap();
        assert!(r.extra.contains("\"image_distance_boundary_conflict\":true"), "{}", r.extra);
        assert!(r.extra.contains("\"image_distance_raw\":120"), "{}", r.extra);
        assert!(r.extra.contains("\"image_distance_source\":\"mcu_boundary_conflict\""), "{}", r.extra);
        assert!(!r.extra.contains("\"status\""), "已知键不重复进 extra: {}", r.extra);
        assert_eq!(r.status, "rejected", "增量键不影响既有字段");
        let old = r#"{"trace_id":"r","type":"device.command.result","ts_ms":1,
            "src":"android","idempotency_key":"voice:r:3:2",
            "payload":{"semantic_label":2,"action":"led_on","status":"succeeded","reason":"state_confirmed"}}"#;
        assert_eq!(parse_device_result(old.as_bytes()).unwrap().extra, "", "老 APK 无增量键=空串");
        let big = format!(
            r#"{{"trace_id":"r","type":"device.command.result","ts_ms":1,"src":"android","idempotency_key":"k","payload":{{"semantic_label":2,"status":"succeeded","blob":"{}"}}}}"#,
            "x".repeat(1000)
        );
        assert_eq!(parse_device_result(big.as_bytes()).unwrap().extra.chars().count(), 400, "截 400 字符");
    }
}
