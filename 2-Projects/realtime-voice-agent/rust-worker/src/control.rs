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
use serde_json::{json, Value};

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
    /// 首次见到返回 true;重复返回 false(调用方据此回 already_done)。
    pub fn first_time(&mut self, trace_id: &str, seq: i64) -> bool {
        if self.seen.len() >= SEEN_MAX {
            self.seen.clear(); // 简单截断优于无界增长;重放窗口丢失可接受
        }
        self.seen.insert((trace_id.to_string(), seq))
    }
}

/// 构造 `cancel.ack`。`cancelled`=本次是否真的执行了取消动作。
pub fn cancel_ack(trace_id: &str, seq: i64, ts_ms: i64, cancelled: bool, already_done: bool) -> Value {
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
        assert!(parse(&pkt("worker", "cancel")).is_none(), "src=worker 的 cancel 也必须丢");
    }

    #[test]
    fn bypass_events_do_not_map_to_cancel() {
        // 芯片 VAD/唤醒只是旁路语义,绝不能门控或打断主链路
        for k in ["wake", "vad", "command_word"] {
            assert_eq!(parse(&pkt("android", k)).unwrap().1, Inbound::Bypass, "{k}");
        }
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
