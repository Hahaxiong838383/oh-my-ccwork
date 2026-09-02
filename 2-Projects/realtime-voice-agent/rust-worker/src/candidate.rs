//! 2b 合同 v2 终值①(codex 2026-09-02):Android 硬件候选 ID 的 worker 侧持有槽。
//! 语义:turn-scoped、无固定 commit 等待上限、proposal 发出即清、新候选覆盖旧、job 结束随 Orchestrator drop。
//! 单例槽(同一时刻至多一个候选)——Android 同设备域候选只拦截不重复发布,与之对齐。
use std::time::{Duration, Instant};

/// 「候选后根本没有任何 commit」的残留兜底。**不是 commit 等待上限**(一句话的 ASR final 远短于此):
/// 没有它,几分钟后下一 turn 的慢路句会带上旧 ID→Android 回 already_applied→worker 播「现在已经是这个状态了」错话术。
pub const CANDIDATE_STALE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub trace_id: String,
    pub id: String,
    /// 候选到达时 next_turn_id+1 = 它所属的(其后第一个 commit 的)turn
    pub for_turn: u64,
    pub at: Instant,
}

#[derive(Debug, Default)]
pub struct CandidateSlot {
    inner: Option<Candidate>,
}

impl CandidateSlot {
    /// 记录候选(新覆盖旧)。`next_turn_id`=到达时刻的 turn 计数。
    pub fn record(&mut self, trace_id: &str, id: &str, next_turn_id: u64, at: Instant) {
        self.inner = Some(Candidate {
            trace_id: trace_id.to_string(),
            id: id.to_string(),
            for_turn: next_turn_id + 1,
            at,
        });
    }

    /// 为本 turn 的 L2 proposal 取候选:**消费即清**(不匹配也清——它已不可能被后续正确消费)。
    /// 匹配 = 同 trace && 属于本 turn && 非残留。
    pub fn take_for(&mut self, device_trace: Option<&str>, cur_turn: u64, now: Instant) -> Option<String> {
        let c = self.inner.take()?;
        let same_trace = device_trace == Some(c.trace_id.as_str());
        let fresh = now.saturating_duration_since(c.at) < CANDIDATE_STALE;
        (same_trace && c.for_turn == cur_turn && fresh).then_some(c.id)
    }

    /// 任何 lane 的 proposal 发出即清(L1 快路命中=同句候选已被快路用掉;L2 已 take)。
    pub fn clear(&mut self) {
        self.inner = None;
    }

    pub fn is_some(&self) -> bool {
        self.inner.is_some()
    }
}

/// result 处置(纯函数):Android 候选冲突裁决=静默(不播失败句,只记 suppress);其余走 device_reply。
pub fn is_silent_result(status: &str, reason: &str) -> bool {
    status == "rejected" && reason == "candidate_conflict"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control;
    use serde_json::json;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn turn_scoped_only_the_next_commit_turn_consumes() {
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr", "vad:tr:1", 3, t);
        assert_eq!(s.take_for(Some("tr"), 4, t + Duration::from_secs(1)), Some("vad:tr:1".into()), "属于 turn 4");
        s.record("tr", "vad:tr:2", 3, t);
        assert_eq!(s.take_for(Some("tr"), 5, t + Duration::from_secs(1)), None, "turn 5 不得消费属于 turn 4 的候选");
        s.record("tr", "vad:tr:3", 3, t);
        assert_eq!(s.take_for(Some("tr"), 3, t + Duration::from_secs(1)), None, "上一 turn 也不得消费");
    }

    #[test]
    fn long_turn_has_no_fixed_wait_cap_but_stale_residue_is_dropped() {
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr", "vad:tr:9", 6, t);
        assert_eq!(s.take_for(Some("tr"), 7, t + Duration::from_millis(9500)), Some("vad:tr:9".into()), "9.5s 长句仍关联(无 2000ms 类上限)");
        s.record("tr", "vad:tr:10", 6, t);
        assert_eq!(s.take_for(Some("tr"), 7, t + Duration::from_secs(11)), None, "候选后 >10s 无 commit=残留,丢弃");
    }

    #[test]
    fn proposal_consumes_and_explicit_clear_empties_slot() {
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr", "vad:tr:1", 0, t);
        assert!(s.take_for(Some("tr"), 1, t).is_some());
        assert!(!s.is_some(), "take 即清");
        assert_eq!(s.take_for(Some("tr"), 1, t), None, "再取为空");
        s.record("tr", "vad:tr:2", 0, t);
        s.clear();
        assert!(!s.is_some(), "L1 proposal 发出后 clear 清空");
        assert_eq!(s.take_for(Some("tr"), 1, t), None);
    }

    #[test]
    fn newer_candidate_overrides_older() {
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr", "vad:tr:1", 0, t);
        s.record("tr", "vad:tr:2", 0, t);
        assert_eq!(s.take_for(Some("tr"), 1, t), Some("vad:tr:2".into()));
    }

    #[test]
    fn m10_job_isolation_and_cross_trace_replay_rejected() {
        // 新 job = 新 Orchestrator = 新 slot:旧 job 的候选 ID 不存在于新 slot
        let mut fresh_job = CandidateSlot::default();
        assert_eq!(fresh_job.take_for(Some("tr-new"), 1, t0()), None, "跨 job 重放:新 slot 为空,proposal ID=null");
        // 同 job 内 trace 不同(异 trace 候选)不关联
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr-old", "vad:tr-old:1", 0, t);
        assert_eq!(s.take_for(Some("tr-new"), 1, t), None, "异 trace 候选不关联,且已被消费清空");
        assert!(!s.is_some());
    }

    #[test]
    fn m3_synthetic_same_id_envelope_end_to_end() {
        // Android command_word(带 ID) → worker 解析 → 记录 → 本 turn L2 proposal 原样回传同 ID
        let raw = json!({"trace_id":"tr","ts_ms":1,"src":"android","type":"command_word","seq":2,
            "payload":{"label":6,"observed_before_input_ready":false,"vad_candidate_id":"vad:tr:7"}}).to_string();
        let (ev, kind) = control::parse(raw.as_bytes()).unwrap();
        let control::Inbound::CommandWord { candidate_id: Some(id), .. } = kind else { panic!("应解析出候选 ID") };
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record(&ev.trace_id, &id, 0, t);
        let picked = s.take_for(Some("tr"), 1, t + Duration::from_millis(1500)).expect("同 trace 本 turn 关联");
        let v = control::device_command_proposed(&ev.trace_id, 1, "voice:r:1:6", 6, "brightness_down", "调暗一级", "太亮了", "llm", "L2", Some(&picked));
        assert_eq!(v["lane"], "L2");
        assert_eq!(v["payload"]["vad_candidate_id"], "vad:tr:7", "proposal 原样回传同 ID");
        assert_eq!(v["payload"]["match_type"], "llm");
    }

    #[test]
    fn m5_candidate_conflict_is_silent_others_are_not() {
        assert!(is_silent_result("rejected", "candidate_conflict"), "M5:静默不播失败句");
        assert!(!is_silent_result("rejected", "boundary_reached"), "边界拒绝照播边界句");
        assert!(!is_silent_result("already_applied", "vad_fallback_already_applied"), "M4:照播 already_applied 句");
        assert!(!is_silent_result("succeeded", "state_confirmed"));
    }
}
