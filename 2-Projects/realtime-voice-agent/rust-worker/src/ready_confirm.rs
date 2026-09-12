//! B46/B48:`session.input_ready` 的**一次有界状态补确认**(codex B46 §2–§4、B48 §3)。
//!
//! 背景:B39/B41/B44 三轮对账把 ready 的发送侧排干净(publish_ok=true、三包参数一致、
//! 同 participant 的 input_phase 能到),问题锁在交付段而无法定位。既然一次性事件会丢,
//! 端侧就需要一条**只读的有限状态查询**:`session.input_ready.request` → worker 在
//! 真实输入管线仍就绪时,把**现有** `session.input_ready` 重述一次。
//!
//! 重述的精确口径(B48 §3 末段):与首次发射**同构造、同输入就绪语义**,`timings` 保持
//! 首次发射时的原值;`ts_ms` 是重述时刻、`output_ready` 是重述时的真实值;payload 追加
//! `request_seq`。**不是**整包字节与首次完全相同。
//!
//! 纪律(全部由本状态机保证,pipeline 只做校验与发送):
//! - **不伪造就绪**:只有真实 ready 已到(`on_real_ready` 记录过快照)才重述;快照里的
//!   timings 就是当初那次的真值,不重算。
//! - **请求早于真实 ready**:只留一个 pending,真实 ready 到达时经现有事件路径回应,不轮询。
//! - **每 job 预算 1**:首次有效查询必答;重复/后续查询不再应答,避免发送风暴。
//! - **生命周期分两种,不能混(B48 §3)**:
//!   - `on_interrupt`(**停**/插话 cancel):只打断在说的 turn,会话与输入管线都还在,
//!     补确认能力**原封不动**——pending/快照/预算全保留。「停只打断,不聊了才关房」。
//!   - `on_session_exit`(**退出**/真实会话终止):终态。此后任何请求 → `Closed`,
//!     不登记 pending、不重述;迟到的真实 ready 也不回应。幂等,不可逆。
//!     绝不因请求新建或复活会话。
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
    /// 会话已终止(退出):记一行,不做任何事——终态,先于预算判定
    Closed,
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
    closed: bool,
    budget: u8,
    snapshot: Option<ReadySnapshot>,
    pending_seq: Option<i64>,
}

impl ReadyConfirm {
    pub fn new(enabled: bool) -> Self {
        Self { enabled, closed: false, budget: 1, snapshot: None, pending_seq: None }
    }

    pub fn budget_left(&self) -> u8 {
        self.budget
    }

    pub fn snapshot(&self) -> Option<&ReadySnapshot> {
        self.snapshot.as_ref()
    }

    /// 真实 ready 发出时调用(现有发射点)。返回 `Some(seq)` = 有 pending 且预算够,
    /// 调用方应立即用同一快照重述并带上该 `request_seq`。会话已终止 → 不记快照、不回应。
    pub fn on_real_ready(&mut self, snap: ReadySnapshot) -> Option<i64> {
        if self.closed {
            self.pending_seq = None;
            return None;
        }
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

    /// 收到一条已通过 sender/trace/幂等校验的请求。判定顺序:开关 → 终态 → 预算 → 快照 → pending。
    pub fn on_request(&mut self, seq: i64) -> Decision {
        if !self.enabled {
            return Decision::Disabled;
        }
        if self.closed {
            return Decision::Closed;
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

    /// **停**/插话 cancel:只打断在说的 turn,会话与输入管线都在,补确认状态**不变**。
    /// 显式写成方法而不是「pipeline 什么都不调」,是为了让映射可测:注入「停=终态」这种
    /// 错误时测试必须变红。
    pub fn on_interrupt(&mut self) {
        // 有意为空:pending/快照/预算全保留。
    }

    /// **退出**/真实会话终止:终态,幂等。pending 作废,此后不再登记也不再重述。
    pub fn on_session_exit(&mut self) {
        self.closed = true;
        self.pending_seq = None;
    }

    /// 按生命周期分派。pipeline 只调这一个入口,映射表在 `swallow_lifecycle` /
    /// `cancel_lifecycle`——单测锁死的那张表就是生产用的那张表。
    pub fn apply(&mut self, lc: Lifecycle) {
        match lc {
            Lifecycle::Interrupt => self.on_interrupt(),
            Lifecycle::Exit => self.on_session_exit(),
        }
    }
}

/// B48 §3:一次事件对补确认生命周期的作用。**停和退出是两件事,不能混。**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// 停/插话:只打断在说的 turn,会话与输入管线都还在
    Interrupt,
    /// 退出/真实会话终止:终态
    Exit,
}

/// 吞句 kind → 生命周期。这是**「停只打断,不聊了才关房」的唯一落点**:
/// pipeline 的吞句分支直接调它,改这里就是改生产行为(不是只给测试看的影子实现)。
/// 未知 kind → None(不动生命周期),新增吞句类型必须显式归类才生效。
pub fn swallow_lifecycle(kind: &str) -> Option<Lifecycle> {
    match kind {
        "stop_only" => Some(Lifecycle::Interrupt),
        "session_exit" => Some(Lifecycle::Exit),
        _ => None,
    }
}

/// `cancel` 包 → 生命周期。worker **无法**从包本身分辨「停」和「退出」
/// (`Inbound::Cancel` 不带原因字段),唯一可靠判据是它有没有终结在途的退出信令
/// (v140 §4.3:Android 本地 exact 命中会先发 cancel 充当退出终态)。
/// **默认按停处理**——绝不把所有 cancel 置终态(B48 §3 明令:那会损坏「停了还能接着聊」)。
pub fn cancel_lifecycle(terminated_exit_signal: bool) -> Lifecycle {
    if terminated_exit_signal { Lifecycle::Exit } else { Lifecycle::Interrupt }
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

    /// 重述用的是真实 ready 那一刻的快照,不重算——这是「不伪造就绪」的载体。
    #[test]
    fn snapshot_is_the_original_timings() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        assert_eq!(r.snapshot(), Some(&snap()));
    }

    // ---------- B48 §3:两种生命周期,两种命运 ----------

    /// 退出①(codex 探针序列 `on_real_ready → cancel → on_request(7)` 原本得 Restated):
    /// 真实 ready 已到 → **退出** → 迟到查询必须 Closed,不重述、不扣预算。
    #[test]
    fn session_exit_after_ready_closes_late_request() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        r.on_session_exit();
        assert_eq!(r.on_request(7), Decision::Closed);
        assert_eq!(r.budget_left(), 1, "终态不消耗预算");
        assert_eq!(r.on_request(8), Decision::Closed, "终态不可逆");
    }

    /// 退出②(codex 探针序列 `cancel → on_request(8) → on_real_ready` 原本得 Pending→Some(8)):
    /// **退出** → 迟到查询 Closed,不登记 pending;之后哪怕来一次真实 ready 也不回应、不记快照。
    #[test]
    fn session_exit_before_ready_never_pends_nor_replies() {
        let mut r = ReadyConfirm::new(true);
        r.on_session_exit();
        assert_eq!(r.on_request(8), Decision::Closed);
        assert_eq!(r.on_real_ready(snap()), None, "终态后真实 ready 不回应任何东西");
        assert_eq!(r.snapshot(), None, "终态后不再记快照,后续也无从重述");
        assert_eq!(r.on_request(9), Decision::Closed);
    }

    /// 退出③:已有 pending 时退出 → pending 作废;之后的真实 ready 不得回应一个已作废的请求。
    #[test]
    fn pending_then_session_exit_then_ready_does_not_reply() {
        let mut r = ReadyConfirm::new(true);
        assert_eq!(r.on_request(9), Decision::Pending);
        r.on_session_exit();
        assert_eq!(r.on_real_ready(snap()), None, "退出过的 pending 不能被回应");
        assert_eq!(r.budget_left(), 1, "没回应就不扣预算");
    }

    /// 退出④:终态幂等且不可逆——重复退出、退出后再「停」,都还是 Closed。
    #[test]
    fn session_exit_is_idempotent_and_irreversible() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        r.on_session_exit();
        r.on_session_exit();
        r.on_interrupt();
        assert_eq!(r.on_request(1), Decision::Closed);
    }

    /// 停①:真实 ready 已到 → **停**(只打断) → 查询照常重述。「停」不能把整个 job 关掉。
    #[test]
    fn interrupt_after_ready_still_restates() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        r.on_interrupt();
        assert_eq!(r.on_request(7), Decision::Restated, "停只打断,补确认能力不变");
        assert_eq!(r.budget_left(), 0);
    }

    /// 停②:查询先到(pending) → **停** → 真实 ready 到 → 照常回应原 seq。
    /// 停不作废 pending:输入管线真会就绪,那条查询就是合法未答的。
    #[test]
    fn interrupt_keeps_pending_and_ready_fulfils_it() {
        let mut r = ReadyConfirm::new(true);
        assert_eq!(r.on_request(3), Decision::Pending);
        r.on_interrupt();
        assert_eq!(r.on_real_ready(snap()), Some(3), "停不作废 pending");
    }

    /// 停③:停在一切之前 → 后续查询仍能登记 pending(会话还活着)。
    #[test]
    fn interrupt_before_anything_still_pends() {
        let mut r = ReadyConfirm::new(true);
        r.on_interrupt();
        assert_eq!(r.on_request(5), Decision::Pending);
    }

    /// 停④:多次停(用户反复打断)不消耗预算、不改变状态——预算只由重述消耗。
    #[test]
    fn repeated_interrupts_do_not_touch_budget() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        for _ in 0..5 {
            r.on_interrupt();
        }
        assert_eq!(r.budget_left(), 1);
        assert_eq!(r.on_request(1), Decision::Restated, "反复停不会把会话关掉");
    }

    /// 终态先于预算:预算已用尽后退出,查询报 Closed 而不是 BudgetExhausted——
    /// 日志读者据此能分清「会话没了」和「会话在、只是答过了」。
    #[test]
    fn closed_takes_precedence_over_budget_exhausted() {
        let mut r = ReadyConfirm::new(true);
        r.on_real_ready(snap());
        assert_eq!(r.on_request(1), Decision::Restated);
        assert_eq!(r.on_request(2), Decision::BudgetExhausted);
        r.on_session_exit();
        assert_eq!(r.on_request(3), Decision::Closed);
    }

    // ---------- B48 §3:入口映射矩阵(pipeline 用的就是这两个函数) ----------

    /// 「停只打断,不聊了才关房」的产品语义,逐条锁死。
    #[test]
    fn swallow_lifecycle_matrix() {
        assert_eq!(swallow_lifecycle("stop_only"), Some(Lifecycle::Interrupt), "停=只打断,会话还在");
        assert_eq!(swallow_lifecycle("session_exit"), Some(Lifecycle::Exit), "退出=终态");
        assert_eq!(swallow_lifecycle("chip_obs"), None, "未知 kind 不动生命周期");
        assert_eq!(swallow_lifecycle(""), None);
    }

    /// cancel 默认是停;只有终结了在途退出信令的那一发才是退出终态。
    #[test]
    fn cancel_lifecycle_matrix() {
        assert_eq!(cancel_lifecycle(false), Lifecycle::Interrupt, "普通 cancel 绝不置终态");
        assert_eq!(cancel_lifecycle(true), Lifecycle::Exit, "终结退出信令的 cancel = 退出终态");
    }

    /// 端到端:走 apply 分派,「停」的 cancel 之后仍能补确认,「退出」的 cancel 之后一律 Closed。
    #[test]
    fn apply_routes_stop_and_exit_differently() {
        let mut stop = ReadyConfirm::new(true);
        stop.on_real_ready(snap());
        stop.apply(cancel_lifecycle(false));
        assert_eq!(stop.on_request(1), Decision::Restated, "停过之后照样能补确认");

        let mut exit = ReadyConfirm::new(true);
        exit.on_real_ready(snap());
        exit.apply(cancel_lifecycle(true));
        assert_eq!(exit.on_request(1), Decision::Closed, "退出之后一律终态");

        let mut swallowed_stop = ReadyConfirm::new(true);
        swallowed_stop.on_real_ready(snap());
        swallowed_stop.apply(swallow_lifecycle("stop_only").unwrap());
        assert_eq!(swallowed_stop.on_request(1), Decision::Restated);

        let mut swallowed_exit = ReadyConfirm::new(true);
        swallowed_exit.on_real_ready(snap());
        swallowed_exit.apply(swallow_lifecycle("session_exit").unwrap());
        assert_eq!(swallowed_exit.on_request(1), Decision::Closed);
    }
}
