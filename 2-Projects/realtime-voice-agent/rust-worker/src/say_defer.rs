//! 设备命令固定短句的「追加」语义(2b 合同 v2 §3.4:result 回来后固定短句**追加**在 LLM 回复之后;
//! 用户抢话即取消)。2026-09-03 M1 实证:回复还在播时直接 start_turn(Say) 会与在播轮抢同一音频源
//! → `capture_frame InvalidState`,短句一帧没播、回复被截。本槽把短句压到当前轮自然播完(PlayedOut)后再开播。
#[derive(Debug, Default)]
pub struct DeferredSay {
    slot: Option<String>,
}

impl DeferredSay {
    /// agent 轮在播 → 暂存(新覆盖旧)返回 None;空闲 → 原样返回让调用方立刻开播。
    pub fn offer(&mut self, turn_in_flight: bool, text: String) -> Option<String> {
        if turn_in_flight {
            self.slot = Some(text);
            None
        } else {
            Some(text)
        }
    }

    /// 当前轮自然播完 → 取出追加播放。
    pub fn take_on_played_out(&mut self) -> Option<String> {
        self.slot.take()
    }

    /// 用户抢话/硬打断/新命令 → 作废(合同:用户抢话走短促桶取消)。返回是否真丢了一条。
    pub fn clear_on_abort(&mut self) -> bool {
        self.slot.take().is_some()
    }

    pub fn is_some(&self) -> bool {
        self.slot.is_some()
    }
}

/// 2026-09-03 口径（川哥拍板，回执 A 增量提案）：成功态短句在慢路回复之后显迟且重复——
/// `succeeded` 且命令来自 L2（LLM 回复本身已认领动作）且 result 到达时回复仍在播 → 不追加成功句（灯已变 + 回复已说）；
/// 失败 / 边界 / already_applied / 超时 仍追加（必须纠正 LLM 的乐观回复）；L1 快路无 LLM 回复，成功句照播。
pub fn success_reply_silent(status: &str, lane: &str, turn_in_flight: bool) -> bool {
    status == "succeeded" && lane == "L2" && turn_in_flight
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_says_now_busy_defers_until_played_out() {
        let mut d = DeferredSay::default();
        assert_eq!(d.offer(false, "好，调了一点".into()), Some("好，调了一点".into()));
        assert!(!d.is_some());
        assert_eq!(d.offer(true, "好，调了一点".into()), None);
        assert!(d.is_some());
        assert_eq!(d.take_on_played_out(), Some("好，调了一点".into()));
        assert_eq!(d.take_on_played_out(), None, "取一次即清");
    }

    #[test]
    fn success_silent_only_for_l2_with_reply_in_flight() {
        assert!(success_reply_silent("succeeded", "L2", true), "慢路成功且回复在播=静默");
        assert!(!success_reply_silent("succeeded", "L2", false), "回复已播完/被打断=照说");
        assert!(!success_reply_silent("succeeded", "L1", true), "快路无 LLM 回复=照说");
        for st in ["already_applied", "rejected", "failed", "timeout"] {
            assert!(!success_reply_silent(st, "L2", true), "{st} 必须追加纠正");
        }
    }

    #[test]
    fn newer_overrides_and_abort_drops() {
        let mut d = DeferredSay::default();
        d.offer(true, "好的，正在调整".into());
        d.offer(true, "好，调了一点".into());
        assert_eq!(d.take_on_played_out(), Some("好，调了一点".into()), "新覆盖旧");
        d.offer(true, "刚刚没有调成功，再试一次吧".into());
        assert!(d.clear_on_abort(), "抢话作废");
        assert!(!d.clear_on_abort());
        assert_eq!(d.take_on_played_out(), None);
    }
}
