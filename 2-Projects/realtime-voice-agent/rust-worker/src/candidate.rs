//! 2b 合同 v2 的候选槽(CandidateSlot)已于 2026-09-05 阶段 B R3 修正中移除:候选关联/所有权只认一份语义账本
//! (device_ledger.rs,按说话轮次归属),旧槽按 next_turn_id 归属会把已作废的候选带回下一句(codex 复核向量
//! `orphaned_candidate_must_not_reappear_via_old_slot`)。本文件只保留 result 处置纯函数。

/// result 处置(纯函数):Android 候选冲突裁决=静默(不播失败句,只记 suppress);其余走 device_reply。
pub fn is_silent_result(status: &str, reason: &str) -> bool {
    status == "rejected" && reason == "candidate_conflict"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m5_candidate_conflict_is_silent_others_are_not() {
        assert!(is_silent_result("rejected", "candidate_conflict"), "M5:静默不播失败句");
        assert!(!is_silent_result("rejected", "boundary_reached"), "边界拒绝照播边界句");
        assert!(!is_silent_result("already_applied", "vad_fallback_already_applied"), "M4:照播 already_applied 句");
        assert!(!is_silent_result("succeeded", "state_confirmed"));
    }
}
