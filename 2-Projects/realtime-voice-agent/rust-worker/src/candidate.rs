//! 2b 合同 v2 终值①(codex 2026-09-02):Android 硬件候选 ID 的 worker 侧持有槽。
//! 语义:turn-scoped、无固定 commit 等待上限、proposal 发出即清、新候选覆盖旧、job 结束随 Orchestrator drop。
//! 单例槽(同一时刻至多一个候选)——Android 同设备域候选只拦截不重复发布,与之对齐。
//!
//! ⚠️ **没有任何按时间清状态的路径**(codex 2026-09-02 裁定,`CODEX_…_V193_ANDROID_FOLLOWUP_ACK` §2):
//! 固定 TTL 会把长 turn 的 M4 `already_applied` 退化成 null-ID → Android 当无候选 L2 放行 = 同一意图二次执行。
//! 超时只有 `candidate_orphan_watchdog` 一条诊断日志:不清候选、不改 proposal、不触发执行。
use std::time::{Duration, Instant};

/// 孤儿候选观测阈值:候选驻留 ≥ 此值仍未被消费/覆盖/清除,在**下一个转换点**
/// (consume / override / clear / job_end)记一行 `candidate_orphan_watchdog`(trace/candidate/age/event,无正文)。
/// **只记日志**——判读规则:这行不是故障,是「候选到了但没有任何 proposal 用它」的观测。
pub const CANDIDATE_ORPHAN_WATCHDOG: Duration = Duration::from_secs(10);

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
    /// 记录候选(新覆盖旧)。`next_turn_id`=到达时刻的 turn 计数。被覆盖的旧候选若已驻留超阈值→watchdog 记一行。
    pub fn record(&mut self, trace_id: &str, id: &str, next_turn_id: u64, at: Instant) {
        if let Some(old) = self.inner.take() {
            watchdog(&old, "override", at);
        }
        self.inner = Some(Candidate {
            trace_id: trace_id.to_string(),
            id: id.to_string(),
            for_turn: next_turn_id + 1,
            at,
        });
    }

    /// 为本 turn 的 L2 proposal 取候选:**消费即清**(不匹配也清——它已不可能被后续正确消费)。
    /// 匹配 = 同 trace && 属于本 turn。**不看时间**(长 turn 迟到的同 ID 照样关联,让 Android 回 already_applied)。
    pub fn take_for(&mut self, device_trace: Option<&str>, cur_turn: u64, now: Instant) -> Option<String> {
        let c = self.inner.take()?;
        watchdog(&c, "consume", now);
        let same_trace = device_trace == Some(c.trace_id.as_str());
        (same_trace && c.for_turn == cur_turn).then_some(c.id)
    }

    /// 任何 lane 的 proposal 发出即清(L1 快路命中=同句候选已被快路用掉;L2 已 take)。
    pub fn clear(&mut self, now: Instant) {
        if let Some(c) = self.inner.take() {
            watchdog(&c, "clear", now);
        }
    }

    pub fn is_some(&self) -> bool {
        self.inner.is_some()
    }
}

impl Drop for CandidateSlot {
    /// job 结束(Orchestrator drop)时槽里还有候选 = 整个 job 没有任何 proposal 用过它 → 只记日志。
    fn drop(&mut self) {
        if let Some(c) = self.inner.take() {
            watchdog(&c, "job_end", Instant::now());
        }
    }
}

/// 纯判定(测试锚):驻留 ≥ 阈值 → Some(age_ms);否则 None。不碰任何状态。
pub fn orphan_age_ms(at: Instant, now: Instant) -> Option<u64> {
    let age = now.saturating_duration_since(at);
    (age >= CANDIDATE_ORPHAN_WATCHDOG).then(|| age.as_millis() as u64)
}

fn watchdog(c: &Candidate, event: &'static str, now: Instant) {
    if let Some(age_ms) = orphan_age_ms(c.at, now) {
        tracing::info!(trace_id = %c.trace_id, candidate = %c.id, event, age_ms, "candidate_orphan_watchdog");
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
    fn no_time_based_clearing_long_turn_and_late_same_id_both_consume() {
        // codex 2026-09-02 裁定:删除固定 TTL 的状态变更。9.5s / 11s / 60s 的迟到同 ID 都必须关联(M4 already_applied 路径)。
        let mut s = CandidateSlot::default();
        let t = t0();
        for secs_ms in [9_500u64, 11_000, 60_000] {
            s.record("tr", "vad:tr:9", 6, t);
            assert!(s.is_some(), "驻留 {secs_ms}ms 前槽仍有候选");
            assert_eq!(
                s.take_for(Some("tr"), 7, t + Duration::from_millis(secs_ms)),
                Some("vad:tr:9".into()),
                "驻留 {secs_ms}ms 仍关联,无任何时间上限"
            );
        }
    }

    #[test]
    fn orphan_watchdog_is_pure_threshold_and_touches_no_state() {
        let t = t0();
        assert_eq!(orphan_age_ms(t, t + Duration::from_millis(9_999)), None, "<10s 不报");
        assert_eq!(orphan_age_ms(t, t + Duration::from_secs(10)), Some(10_000), "=10s 报 age_ms");
        assert_eq!(orphan_age_ms(t, t), None, "0 驻留不报");
        // 超阈值后:record 覆盖 / clear / take 的状态语义与阈值前完全相同(只多日志行)
        let mut s = CandidateSlot::default();
        s.record("tr", "vad:tr:1", 0, t);
        s.record("tr", "vad:tr:2", 0, t + Duration::from_secs(30));
        assert_eq!(s.take_for(Some("tr"), 1, t + Duration::from_secs(45)), Some("vad:tr:2".into()), "覆盖后新候选照常消费");
        s.record("tr", "vad:tr:3", 0, t);
        s.clear(t + Duration::from_secs(30));
        assert!(!s.is_some(), "clear 只清,不因超时改变语义");
        // Drop 路径(job_end)带孤儿候选不 panic
        let mut d = CandidateSlot::default();
        let past = Instant::now().checked_sub(Duration::from_secs(11)).unwrap_or_else(Instant::now);
        d.record("tr", "vad:tr:4", 0, past);
        drop(d);
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
        s.clear(t);
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
        let v = control::device_command_proposed(&ev.trace_id, 1, "voice:r:1:6", 6, "brightness_down", "调暗一级", "太亮了", "llm", "L2", Some(&picked), 4);
        assert_eq!(v["lane"], "L2");
        assert_eq!(v["payload"]["vad_candidate_id"], "vad:tr:7", "proposal 原样回传同 ID");
        assert_eq!(v["payload"]["match_type"], "llm");
    }

    #[test]
    fn m4_late_same_id_after_long_turn_is_still_carried() {
        // M4:Android 1000ms fallback 已执行后,worker 长 turn(>10s)迟到的 L2 仍带同 ID → Android 回 already_applied
        // (若 worker 丢 ID 发 null-ID,Android 会当无候选 L2 放行=二次执行,这正是删 TTL 的理由)
        let mut s = CandidateSlot::default();
        let t = t0();
        s.record("tr", "vad:tr:5", 2, t);
        let picked = s.take_for(Some("tr"), 3, t + Duration::from_secs(25));
        assert_eq!(picked.as_deref(), Some("vad:tr:5"), "25s 后同 ID 照带");
    }

    #[test]
    fn m5_candidate_conflict_is_silent_others_are_not() {
        assert!(is_silent_result("rejected", "candidate_conflict"), "M5:静默不播失败句");
        assert!(!is_silent_result("rejected", "boundary_reached"), "边界拒绝照播边界句");
        assert!(!is_silent_result("already_applied", "vad_fallback_already_applied"), "M4:照播 already_applied 句");
        assert!(!is_silent_result("succeeded", "state_confirmed"));
    }
}
