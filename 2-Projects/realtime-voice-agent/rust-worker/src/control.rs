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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inbound {
    /// 停止本轮生成与播放(川哥 2026-08-15 拍板:走硬 abort,不进假打断窗口——
    /// 用户明确按了停,不该再等 1.5s 定时器判断他是不是说错话了)
    Cancel,
    /// 芯片唤醒 / VAD 起止 / 命令词:旁路记录,**不改变 worker 的 turn 判定**
    Bypass,
    /// S2B1 联调:确定性长句走**正式** TTS→segmenter→playout 链路(合同真值
    /// tests/fixtures/s2b1_canary_control_contract.json,rust 侧用 include_str! 锁死)
    CanarySay,
}

/// 解析入站包。返回 None = 丢弃(非 android / 未知类型 / 畸形)。
pub fn parse(raw: &[u8]) -> Option<(Envelope, Inbound)> {
    let ev: Envelope = serde_json::from_slice(raw).ok()?;
    if ev.src != "android" {
        return None; // worker 自己的 ack 也在这个 topic 上,必须挡掉
    }
    let kind = match ev.kind.as_str() {
        "cancel" => Inbound::Cancel,
        "wake" | "vad" | "command_word" => Inbound::Bypass,
        "canary.say" => Inbound::CanarySay,
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
}
