//! B46:`session.input_ready` 的**一次有界状态补确认**(codex B46 §2–§4)。
//!
//! 背景:B39/B41/B44 三轮对账把 ready 的发送侧排干净(publish_ok=true、三包参数一致、
//! 同 participant 的 input_phase 能到),问题锁在交付段而无法定位。既然一次性事件会丢,
//! 端侧就需要一条**只读的有限状态查询**:`session.input_ready.request` → worker 在
//! 真实输入管线仍就绪时,把**现有** `session.input_ready` 原样重述一次。
//!
//! 纪律(全部由本状态机保证,pipeline 只做校验与发送):
//! - **不伪造就绪**:只有真实 ready 已到(`on_real_ready` 记录过快照)才重述;快照里的
//!   timings 就是当初那次的真值,不重算。
//! - **请求早于真实 ready**:只留一个 pending,真实 ready 到达时经现有事件路径回应,不轮询。
//! - **每 job 预算 1**:首次有效查询必答;重复/后续查询不再应答,避免发送风暴。
//! - **取消/关房清 pending**,绝不因请求新建或复活会话。
//! - 默认关:开关只在 `PipelineConfig::ready_confirm_enabled` 一处读 env(`ONESHOT_READY_CONFIRM_ENABLED`),
//!   本模块不再读环境——同一开关两处读会分叉(B44 坑一同族)。关 → 一切请求 `Disabled`。

/// 真实 ready 发出那一刻抓下的快照:重述时原样复用,不重算。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadySnapshot {
    pub issue_to_assignment_ms: Option<i64>,
    pub job_room_connect_ms: i64,
    pub track_to_input_loop_ms: i64,
}

/// 对一次请求的判决(写进日志的枚举,不带任何载荷内容)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 开关关:记一行,不做任何事
    Disabled,
    /// 真实 ready 已到 → 重述一次(消耗预算)
    Restated,
    /// 真实 ready 未到 → 留 pending,等真实 ready 时回应
    Pending,
    /// 已有 pending,本次不再登记
    AlreadyPending,
    /// 本 job 预算已用尽
    BudgetExhausted,
}

pub struct ReadyConfirm {
    enabled: bool,
    budget: u8,
    snapshot: Option<ReadySnapshot>,
    pending_seq: Option<i64>,
}

impl ReadyConfirm {
    pub fn new(enabled: bool) -> Self {
        Self { enabled, budget: 1, snapshot: None, pending_seq: None }
    }

    pub fn budget_left(&self) -> u8 {
        self.budget
    }

    pub fn snapshot(&self) -> Option<&ReadySnapshot> {
        self.snapshot.as_ref()
    }

    /// 真实 ready 发出时调用(现有发射点)。返回 `Some(seq)` = 有 pending 且预算够,
    /// 调用方应立即用同一快照重述并带上该 `request_seq`。
    pub fn on_real_ready(&mut self, snap: ReadySnapshot) -> Option<i64> {
        self.snapshot = Some(snap);
        if !self.enabled {
            self.pending_seq = None;
            return None;
        }
        let seq = self.pending_seq.take()?;
        if self.budget == 0 {
            return None;
        }
        self.budget -= 1;
        Some(seq)
    }

    /// 收到一条已通过 sender/trace/幂等校验的请求。
    pub fn on_request(&mut self, seq: i64) -> Decision {
        if !self.enabled {
            return Decision::Disabled;
        }
        if self.budget == 0 {
            return Decision::BudgetExhausted;
        }
        if self.snapshot.is_some() {
            self.budget -= 1;
            return Decision::Restated;
        }
        if self.pending_seq.is_some() {
            return Decision::AlreadyPending;
        }
        self.pending_seq = Some(seq);
        Decision::Pending
    }

    /// 取消/关房:pending 作废。预算与快照保留(取消后不再有真实 ready,自然无处回应)。
    pub fn on_cancel(&mut self) {
        self.pending_seq = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> ReadySnapshot {
        ReadySnapshot { issue_to_assignment_ms: Some(400), job_room_connect_ms: 150, track_to_input_loop_ms: 5 }
    }

    /// 默认关是安全根基:关着时任何请求都只记 Disabled,真实 ready 也不留 pending。
    #[test]
    fn disabled_never_restates_or_pends() {
        let mut r = ReadyConfirm::new(false);
        assert_eq!(r.on_request(1), Decision::Disabled);
        assert_eq!(r.on_real_ready(snap()), None);
        assert_eq!(r.on_request(2), Decision::Disabled);
        assert_eq!(r.budget_left(), 1, "关着时预算一分不动");
        // 正锚:开着时同样的序列必须有动作,否则「关着不动」与「状态机坏了」不可区分
        let mut on = ReadyConfirm::new(true);
        on.on_real_ready(snap());
        assert_eq!(on.on_request(1), Decision::Restated);
    }

    /// codex §6 自动验收①:首 ready 先到 → 首次有效查询必须重述,不能被「已发过」吞掉。
    #[test]
    fn ready_first_then_request_restates_once() {
        let mut r = ReadyConfirm::new(true);
        assert_eq!(r.on_real_ready(snap()), None, "无 pending 时真实 ready 不触发重述");
        assert_eq!(r.on_request(7), Decision::Restated);
        assert_eq!(r.budget_left(), 0);
        assert_eq!(r.on_request(8), Decision::BudgetExhausted, "第二次查询不再应答");
    }

    /// codex §6 自动验收②:请求先到 → 留 pending → 真实 ready 时回应,带原 seq。
    #[test]
    fn request_first_then_ready_fulfils_pending_with_seq() {
        let mut r = ReadyConfirm::new(true);
        assert_eq!(r.on_request(3), Decision::Pending);
        assert_eq!(r.on_request(4), Decision::AlreadyPending, "第二次请求不重复登记");
        assert_eq!(r.on_real_ready(snap()), Some(3), "真实 ready 时回应**第一个** pending 的 seq");
        assert_eq!(r.budget_left(), 0);
        assert_eq!(r.on_request(5), Decision::BudgetExhausted);
    }

    /// 取消后 pending 作废;之后再来的真实 ready 不得凭空回应一个已作废的请求。
    #[test]
    fn cancel_clears_pending_and_later_ready_does_not_reply() {
        let mut r = ReadyConfirm::new(true);
        assert_eq!(r.on_request(9), Decision::Pending);
        r.on_cancel();
        assert_eq!(r.on_real_ready(snap()), None, "取消过的 pending 不能被回应");
        assert_eq!(r.budget_left(), 1, "没回应就不扣预算");
    }

    /// 重述用的是真实 ready 那一刻的快照,不重算——这是「不伪造就绪」的载体。
    #[test]
    fn snapshot_is_the_original_timings() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        assert_eq!(r.snapshot(), Some(&snap()));
    }
}
