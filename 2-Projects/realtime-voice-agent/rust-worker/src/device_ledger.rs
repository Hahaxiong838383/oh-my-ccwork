//! 设备命令账本(合同 v3.1 阶段 B 修正,codex 源码复核 R1–R4,2026-09-05)——纯逻辑、无 I/O,单测载体。
//!
//! - **同句归属按 worker 自己的语音段时序**(SpeechStart 起点 → commit 时回溯的真实停说时刻),
//!   不再按 3 s 时间窗:芯片观测在 commit 时归到该说话轮次(utterance);落在区间外 = 上一句没有 ASR 的
//!   孤儿观测(只诊断,不再影响下一句)。「用户又说了一句但芯片没识别到」「上一句 claimed 开灯、这句关灯」
//!   都是不同 utterance,不吞。
//! - **所有权在同一处裁决 L1 与 L2**:claimed / deferred(电机) / ignored / unknown;同句提案原样回传候选 ID。
//! - **去重键 = trace(账本按 job 隔离) + utterance + action + normalized_params**;晚到的芯片 hint 归到上一已提交句。
//! - **L0 result 先过门**:active trace / source / status 枚举 / action 非空,再按 (trace, key) 去重(只记终态)。
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 芯片候选的所有权(端侧 `local_action` 经 device_intent::chip_decision 裁决后的账本形态)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    /// 合同 2 旧策略:worker 已据芯片标签提案
    Proposed,
    /// 合同 3:端侧已认领(所有权≠物理成功),worker 不提案
    Claimed,
    /// 合同 3:白名单外电机,只作候选,等同句 ASR/LLM 独立命中
    DeferredMotor,
    /// 端侧明确忽略(工作态/资格门),同句 worker 提案也没有执行资格
    Ignored,
    /// 已声明合同 3 却缺失/非法所有权:fail-closed,不进任何执行路径
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ChipObs {
    pub label: u32,
    pub action: &'static str,
    pub ownership: Ownership,
    pub candidate: Option<String>,
    pub at: Instant,
    /// commit 时归属的说话轮次;None = 尚未归属(当前未提交的语音段)
    pub utterance: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChipOutcome {
    /// 合同 2 旧策略:立即提案(候选 ID 原样带上;utterance=已归属的上一句(晚到 hint)或 None)
    ProposeNow { candidate: Option<String>, utterance: Option<u64> },
    /// 同句已有同键提案(晚到 hint 撞上已提交句的 ASR 提案)
    Duplicate,
    /// 只记账不提案(claimed / deferred / ignored / unknown)
    Held,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Propose {
        /// 同句芯片观测携带的候选 ID(deferred 电机确认 / 旧策略同句);None = 纯 ASR/LLM 句
        candidate: Option<String>,
        /// 同句芯片观测动作与本次不一致(诊断信号,不是芯片错的证明):(芯片 label, 芯片 action)
        mismatch_with: Option<(u32, &'static str)>,
        /// 本次是白名单外电机候选被同句 ASR/LLM 独立确认
        confirmed_deferred: bool,
    },
    /// 不提案;reason 为日志枚举
    Suppress(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum L0Outcome {
    /// 通过全部门且首次终态 → 调用方再看 spoken_locally / 候选冲突后决定补说
    Speak,
    /// 不播报;reason 为日志枚举(accepted_diagnostic 仍值得记日志)
    Silent(&'static str),
}

#[derive(Debug, Default)]
pub struct CommitReport {
    pub utterance: u64,
    /// 落在本句区间外的芯片观测(上一句没有 ASR):调用方按 ownership 记诊断
    pub orphans: Vec<ChipObs>,
}

#[derive(Debug, Clone)]
struct ProposalRec {
    utterance: Option<u64>,
    action: &'static str,
    params: String,
    source: &'static str,
    at: Instant,
}

/// 语音段起点前的容差(芯片 KWS 可能在 VAD 判定开口前一点点就命中)
pub const PRE_START_SLACK: Duration = Duration::from_millis(300);
/// 停说后的容差(芯片识别尾窗;P0 实测芯片先于 ASR final 320–985 ms,即停说后 ≤ 1 s)
pub const POST_END_SLACK: Duration = Duration::from_millis(1500);
/// 没收到 SpeechStart(VAD 漏检)时的起点兜底
pub const NO_START_FALLBACK: Duration = Duration::from_millis(3000);
/// 无语音活动时,未归属观测的诊断超时(只记 orphan,不改任何决策)
pub const IDLE_ORPHAN_AFTER: Duration = Duration::from_secs(5);
/// 停说→再开口的间隔 ≥ 此值 = 新的一句(上一句若没有 commit,即 ASR 缺失,其观测作废);
/// 更短的停顿视为同句内换气(turn.rs 的提交等待也在这个量级,有文本的话早就 commit 了)
pub const NEW_UTTERANCE_GAP: Duration = Duration::from_millis(700);
const OBS_CAP: usize = 8;
const PROP_CAP: usize = 16;
const L0_CAP: usize = 32;
const TERMINAL: [&str; 5] = ["succeeded", "already_applied", "rejected", "failed", "timeout"];
const L0_SOURCES: [&str; 2] = ["vad_chip", "fallback"];

#[derive(Debug)]
pub struct Ledger {
    utterance: u64,
    utterance_started_at: Option<Instant>,
    /// 当前未提交语音段最近一次停说时刻(再开口时判是否新句)
    last_speech_end_at: Option<Instant>,
    /// 上一已提交句 (id, start, end):晚到的芯片 hint 归到它
    last_committed: Option<(u64, Instant, Instant)>,
    obs: Vec<ChipObs>,
    proposals: Vec<ProposalRec>,
    l0_seen: VecDeque<(String, String)>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::new()
    }
}

impl Ledger {
    pub fn new() -> Self {
        Self {
            utterance: 0,
            utterance_started_at: None,
            last_speech_end_at: None,
            last_committed: None,
            obs: Vec::new(),
            proposals: Vec::new(),
            l0_seen: VecDeque::new(),
        }
    }

    pub fn current_utterance(&self) -> u64 {
        self.utterance
    }

    /// VAD 开口:记当前未提交语音段的起点。上一段已停说且间隔 ≥ NEW_UTTERANCE_GAP 而**从未 commit**(ASR 缺失)
    /// → 上一句作废:其未归属观测作孤儿返回(只诊断),提案退休;本次开口是新句起点。
    pub fn on_speech_start(&mut self, now: Instant) -> Vec<ChipObs> {
        let mut orphans = Vec::new();
        if let (Some(_), Some(end)) = (self.utterance_started_at, self.last_speech_end_at)
            && now.duration_since(end) >= NEW_UTTERANCE_GAP
        {
            let (gone, keep): (Vec<ChipObs>, Vec<ChipObs>) =
                self.obs.drain(..).partition(|o| o.utterance.is_none() && o.at <= end + POST_END_SLACK);
            self.obs = keep;
            orphans = gone;
            for p in &mut self.proposals {
                if p.utterance.is_none() && p.at <= end + POST_END_SLACK {
                    p.utterance = Some(0);
                }
            }
            self.utterance_started_at = None;
        }
        if self.utterance_started_at.is_none() {
            self.utterance_started_at = Some(now);
        }
        self.last_speech_end_at = None;
        orphans
    }

    /// VAD 停说(真实停说时刻,turn.rs 已回溯):只记时刻,commit 与否由 ASR 文本决定
    pub fn on_speech_end(&mut self, end_at: Instant) {
        if self.utterance_started_at.is_some() {
            self.last_speech_end_at = Some(end_at);
        }
    }

    /// 芯片观测到达。Proposed(合同 2 旧策略)且同句无同键提案 → ProposeNow;其余只记账。
    pub fn on_chip(
        &mut self,
        label: u32,
        action: &'static str,
        ownership: Ownership,
        candidate: Option<String>,
        now: Instant,
    ) -> ChipOutcome {
        // 晚到 hint:没有新的开口,且落在上一已提交句的尾窗内 → 归到上一句
        let late_utterance = match (self.utterance_started_at, self.last_committed) {
            (None, Some((u, _, end))) if now <= end + POST_END_SLACK => Some(u),
            _ => None,
        };
        if self.obs.len() >= OBS_CAP {
            self.obs.remove(0);
        }
        self.obs.push(ChipObs { label, action, ownership, candidate: candidate.clone(), at: now, utterance: late_utterance });
        if ownership != Ownership::Proposed {
            return ChipOutcome::Held;
        }
        // 同键去重:归属到上一句 → 对撞该句的提案;未归属 → 对撞当前未提交段的提案
        let dup = self.proposals.iter().any(|p| p.action == action && p.params.is_empty() && p.utterance == late_utterance);
        if dup {
            return ChipOutcome::Duplicate;
        }
        ChipOutcome::ProposeNow { candidate, utterance: late_utterance }
    }

    /// 记录一次已发出的提案(去重键载体)。utterance=None 表示芯片在 commit 前发出的提案,commit 时归属。
    pub fn record_proposal(&mut self, utterance: Option<u64>, action: &'static str, params: &str, source: &'static str, now: Instant) {
        if self.proposals.len() >= PROP_CAP {
            self.proposals.remove(0);
        }
        self.proposals.push(ProposalRec { utterance, action, params: params.to_string(), source, at: now });
    }

    /// ASR final 提交:开新说话轮次,把区间内的未归属观测/提案归到它;区间外的观测作孤儿返回(诊断)。
    /// `eou_delay` = 停说→提交(turn.rs CommitInfo),据此回溯真实停说时刻。
    pub fn on_commit(&mut self, now: Instant, eou_delay: Duration) -> CommitReport {
        let end = now.checked_sub(eou_delay).unwrap_or(now);
        let start = self
            .utterance_started_at
            .unwrap_or_else(|| end.checked_sub(NO_START_FALLBACK).unwrap_or(end));
        let lo = start.checked_sub(PRE_START_SLACK).unwrap_or(start);
        let hi = end + POST_END_SLACK;
        self.utterance += 1;
        let u = self.utterance;
        let mut orphans = Vec::new();
        let mut kept = Vec::with_capacity(self.obs.len());
        for mut o in self.obs.drain(..) {
            if o.utterance.is_some() {
                kept.push(o); // 已归属旧句(晚到 hint),保留到容量淘汰
            } else if o.at >= lo && o.at <= hi {
                o.utterance = Some(u);
                kept.push(o);
            } else {
                orphans.push(o);
            }
        }
        self.obs = kept;
        for p in &mut self.proposals {
            if p.utterance.is_none() {
                if p.at >= lo && p.at <= hi {
                    p.utterance = Some(u);
                } else {
                    // 上一句没有 ASR 的芯片提案:退休(记成不可能匹配的 0),不再吞下一句
                    p.utterance = Some(0);
                }
            }
        }
        self.last_committed = Some((u, start, end));
        self.utterance_started_at = None;
        self.last_speech_end_at = None;
        CommitReport { utterance: u, orphans }
    }

    /// 无语音活动时的诊断轮询:未归属观测超时 → 作孤儿返回(只诊断)。
    pub fn poll(&mut self, now: Instant) -> Vec<ChipObs> {
        if self.utterance_started_at.is_some() {
            return Vec::new();
        }
        let (stale, keep): (Vec<ChipObs>, Vec<ChipObs>) = self
            .obs
            .drain(..)
            .partition(|o| o.utterance.is_none() && now.duration_since(o.at) >= IDLE_ORPHAN_AFTER);
        self.obs = keep;
        for p in &mut self.proposals {
            if p.utterance.is_none() && now.duration_since(p.at) >= IDLE_ORPHAN_AFTER {
                p.utterance = Some(0);
            }
        }
        stale
    }

    /// 当前已提交句的 ASR / LLM 命中裁决(source = "asr" | "llm")。
    pub fn decide(&mut self, action: &'static str, params: &str, source: &'static str) -> Decision {
        let u = self.utterance;
        if let Some(p) = self.proposals.iter().find(|p| p.utterance == Some(u) && p.action == action && p.params == params) {
            return Decision::Suppress(if p.source == "chip" { "command_word_already_proposed" } else { "duplicate_same_utterance" });
        }
        let _ = source;
        let mut candidate = None;
        let mut mismatch_with = None;
        let mut confirmed_deferred = false;
        // 同句观测,最新优先
        for o in self.obs.iter().rev().filter(|o| o.utterance == Some(u)) {
            match o.ownership {
                Ownership::Claimed => {
                    return Decision::Suppress(if o.action == action { "chip_claimed_same_turn" } else { "chip_asr_mismatch_suppressed" });
                }
                Ownership::Ignored => return Decision::Suppress("chip_ignored_same_turn"),
                Ownership::Unknown => return Decision::Suppress("ownership_unknown_same_turn"),
                Ownership::DeferredMotor => {
                    if candidate.is_none() {
                        candidate = o.candidate.clone();
                    }
                    if o.action == action {
                        confirmed_deferred = true;
                    } else if mismatch_with.is_none() {
                        mismatch_with = Some((o.label, o.action));
                    }
                }
                Ownership::Proposed => {
                    if o.action != action && mismatch_with.is_none() {
                        mismatch_with = Some((o.label, o.action));
                    }
                }
            }
        }
        Decision::Propose { candidate, mismatch_with, confirmed_deferred }
    }

    /// 当前已提交句最新观测的所有权(测试锚)。
    #[cfg(test)]
    pub fn ownership_of_current(&self) -> Option<Ownership> {
        let u = self.utterance;
        self.obs.iter().rev().find(|o| o.utterance == Some(u)).map(|o| o.ownership)
    }

    /// L0(芯片本地执行)result 门序:active trace → source → action → status 枚举 → (trace,key) 去重(只记终态)。
    pub fn l0_check(&mut self, active_trace: Option<&str>, r_trace: &str, key: &str, source: &str, status: &str, action: &str) -> L0Outcome {
        match active_trace {
            Some(t) if t == r_trace => {}
            _ => return L0Outcome::Silent("stale_or_foreign_trace"),
        }
        if !L0_SOURCES.contains(&source) {
            return L0Outcome::Silent("invalid_l0_source");
        }
        if action.is_empty() {
            return L0Outcome::Silent("missing_action");
        }
        if status == "accepted" {
            return L0Outcome::Silent("accepted_diagnostic");
        }
        if !TERMINAL.contains(&status) {
            return L0Outcome::Silent("unknown_status");
        }
        let k = (r_trace.to_string(), key.to_string());
        if self.l0_seen.contains(&k) {
            return L0Outcome::Silent("duplicate_terminal");
        }
        if self.l0_seen.len() >= L0_CAP {
            self.l0_seen.pop_front();
        }
        self.l0_seen.push_back(k);
        L0Outcome::Speak
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// codex R1 反例①:第一句 chip 占有 → 同句 ASR 抑制 → **第二句只有 ASR 命中(芯片漏识)不得被吞**
    #[test]
    fn r1_second_utterance_asr_only_not_swallowed() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(600));
        assert_eq!(l.on_chip(4, "brightness_up", Ownership::Proposed, Some("vad:t:1".into()), t0), ChipOutcome::ProposeNow { candidate: Some("vad:t:1".into()), utterance: None });
        l.record_proposal(None, "brightness_up", "", "chip", t0);
        // 第一句 ASR final:停说于 t0+100,提交于 t0+300(eou 200ms)
        let rep = l.on_commit(t0 + ms(300), ms(200));
        assert_eq!((rep.utterance, rep.orphans.len()), (1, 0));
        assert_eq!(l.decide("brightness_up", "", "asr"), Decision::Suppress("command_word_already_proposed"), "同句 ASR 抑制,正确");
        // 第二句:t0+900 开口,t0+1300 提交(芯片没识别到)
        l.on_speech_start(t0 + ms(900));
        let rep2 = l.on_commit(t0 + ms(1300), ms(200));
        assert_eq!(rep2.utterance, 2);
        assert_eq!(l.decide("brightness_up", "", "asr"), Decision::Propose { candidate: None, mismatch_with: None, confirmed_deferred: false }, "下一真实句仅 ASR 命中不被上一句 chip 吞掉");
    }

    /// codex R1 反例②(合同 3 结构性):前一句 claimed 开灯、该句 ASR 缺失,下一句关灯 3 s 内到达 → 不得当 mismatch 压制
    #[test]
    fn r1_claimed_without_asr_does_not_suppress_next_utterance() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(500));
        assert_eq!(l.on_chip(2, "led_on", Ownership::Claimed, Some("vad:t:1".into()), t0), ChipOutcome::Held);
        l.on_speech_end(t0 + ms(200));
        // 第一句没有 ASR(commit 从未发生);第二句 t0+1200 开口(停说后 1 s ≥ NEW_UTTERANCE_GAP → 新句)、t0+1700 提交
        let gone = l.on_speech_start(t0 + ms(1200));
        assert_eq!((gone.len(), gone[0].ownership), (1, Ownership::Claimed), "上一句的 claimed 观测在再开口时作孤儿(只诊断)");
        let rep = l.on_commit(t0 + ms(1700), ms(200));
        assert_eq!((rep.utterance, rep.orphans.len()), (1, 0));
        assert_eq!(l.decide("led_off", "", "asr"), Decision::Propose { candidate: None, mismatch_with: None, confirmed_deferred: false }, "关灯照常提案");
    }

    /// 同句内短停顿(< NEW_UTTERANCE_GAP)不拆句:芯片观测仍归本句
    #[test]
    fn short_pause_within_utterance_keeps_association() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0);
        l.on_chip(2, "led_on", Ownership::Claimed, None, t0 + ms(500));
        l.on_speech_end(t0 + ms(600));
        assert!(l.on_speech_start(t0 + ms(900)).is_empty(), "300 ms 换气不算新句");
        l.on_commit(t0 + ms(1800), ms(300));
        assert_eq!(l.decide("led_on", "", "asr"), Decision::Suppress("chip_claimed_same_turn"));
    }

    /// 同句 claimed:同动作 ASR 吞句;不同动作 ASR 压制并标 mismatch
    #[test]
    fn claimed_same_utterance_suppresses_asr_and_l2() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(400));
        l.on_chip(2, "led_on", Ownership::Claimed, Some("vad:t:3".into()), t0);
        l.on_commit(t0 + ms(400), ms(200));
        assert_eq!(l.decide("led_on", "", "asr"), Decision::Suppress("chip_claimed_same_turn"));
        assert_eq!(l.decide("brightness_up", "", "llm"), Decision::Suppress("chip_asr_mismatch_suppressed"), "claimed → 非 L1 短语 → L2 意图仍零 proposal");
        assert_eq!(l.ownership_of_current(), Some(Ownership::Claimed));
    }

    /// codex R3:deferred 电机 → 同句 ASR 确认 → proposal 含原候选 ID;不同动作也带候选并标 mismatch(ASR 为准)
    #[test]
    fn deferred_motor_confirmed_by_same_utterance_asr_carries_candidate() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(300));
        assert_eq!(l.on_chip(33, "virtual_image_farther_step", Ownership::DeferredMotor, Some("vad:t:7".into()), t0), ChipOutcome::Held);
        l.on_commit(t0 + ms(500), ms(200));
        assert_eq!(
            l.decide("virtual_image_farther_step", "", "asr"),
            Decision::Propose { candidate: Some("vad:t:7".into()), mismatch_with: None, confirmed_deferred: true }
        );
        let mut l2 = Ledger::new();
        l2.on_speech_start(t0 - ms(300));
        l2.on_chip(33, "virtual_image_farther_step", Ownership::DeferredMotor, Some("vad:t:8".into()), t0);
        l2.on_commit(t0 + ms(500), ms(200));
        assert_eq!(
            l2.decide("virtual_image_nearer_step", "", "asr"),
            Decision::Propose { candidate: Some("vad:t:8".into()), mismatch_with: Some((33, "virtual_image_farther_step")), confirmed_deferred: false },
            "ASR 独立命中为准,候选原样回传,mismatch 只诊断"
        );
    }

    /// deferred 电机整句没有 ASR → 下一句提交时作孤儿(chip_candidate_unconfirmed 诊断);无语音时 poll 超时也作孤儿
    #[test]
    fn deferred_motor_without_asr_becomes_orphan() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(300));
        l.on_chip(30, "motor_up_step", Ownership::DeferredMotor, Some("vad:t:9".into()), t0);
        assert!(l.poll(t0 + ms(4000)).is_empty(), "开口未提交期间不作孤儿");
        let mut l2 = Ledger::new();
        l2.on_chip(30, "motor_up_step", Ownership::DeferredMotor, None, t0);
        assert!(l2.poll(t0 + ms(4000)).is_empty());
        let stale = l2.poll(t0 + ms(5100));
        assert_eq!((stale.len(), stale[0].ownership), (1, Ownership::DeferredMotor));
    }

    /// codex R2 语义在账本侧:同句 unknown 所有权 → ASR/LLM 都不提案(fail-closed);ignored 同理
    #[test]
    fn unknown_or_ignored_ownership_blocks_same_utterance_proposals() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(300));
        l.on_chip(30, "motor_up_step", Ownership::Unknown, None, t0);
        l.on_commit(t0 + ms(400), ms(200));
        assert_eq!(l.decide("motor_up_step", "", "asr"), Decision::Suppress("ownership_unknown_same_turn"));
        let mut l2 = Ledger::new();
        l2.on_speech_start(t0 - ms(300));
        l2.on_chip(2, "led_on", Ownership::Ignored, Some("vad:t:2".into()), t0);
        l2.on_commit(t0 + ms(400), ms(200));
        assert_eq!(l2.decide("led_on", "", "llm"), Decision::Suppress("chip_ignored_same_turn"));
    }

    /// 精确去重:同句同 action 不同参数不互吞;同句同键第二次(ASR 后 LLM 又提)吞
    #[test]
    fn exact_key_includes_params() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(300));
        l.on_commit(t0 + ms(400), ms(200));
        assert!(matches!(l.decide("virtual_image_target", "t50", "asr"), Decision::Propose { .. }));
        l.record_proposal(Some(1), "virtual_image_target", "t50", "asr", t0 + ms(400));
        assert!(matches!(l.decide("virtual_image_target", "t80", "llm"), Decision::Propose { .. }), "不同目标不得互吞");
        assert_eq!(l.decide("virtual_image_target", "t50", "llm"), Decision::Suppress("duplicate_same_utterance"));
    }

    /// 晚到的芯片 hint(ASR 先提交):归到上一句 → 同键 Duplicate,不发第二个提案
    #[test]
    fn late_chip_hint_after_commit_is_duplicate() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_speech_start(t0 - ms(500));
        l.on_commit(t0, ms(200));
        l.record_proposal(Some(1), "brightness_up", "", "asr", t0);
        assert_eq!(l.on_chip(4, "brightness_up", Ownership::Proposed, None, t0 + ms(400)), ChipOutcome::Duplicate);
        // 尾窗外的 hint 是新句的前奏,不归上一句
        assert!(matches!(l.on_chip(4, "brightness_up", Ownership::Proposed, None, t0 + ms(2000)), ChipOutcome::ProposeNow { utterance: None, .. }));
    }

    /// VAD 漏掉 SpeechStart:按停说前 3 s 兜底归属
    #[test]
    fn no_speech_start_falls_back_to_window_before_end() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        l.on_chip(4, "brightness_up", Ownership::Proposed, None, t0);
        l.record_proposal(None, "brightness_up", "", "chip", t0);
        let rep = l.on_commit(t0 + ms(800), ms(200));
        assert_eq!(rep.orphans.len(), 0);
        assert_eq!(l.decide("brightness_up", "", "asr"), Decision::Suppress("command_word_already_proposed"));
    }

    /// codex R4:L0 门序——旧 trace / UI 冒充 / 未知状态 / accepted / 重复终态 / 缺 action
    #[test]
    fn l0_gate_order_and_dedupe() {
        let mut l = Ledger::new();
        let ok = |l: &mut Ledger, key: &str| l.l0_check(Some("tr-1"), "tr-1", key, "vad_chip", "succeeded", "led_on");
        assert_eq!(l.l0_check(Some("tr-1"), "tr-0", "chip:tr-0:1", "vad_chip", "succeeded", "led_on"), L0Outcome::Silent("stale_or_foreign_trace"));
        assert_eq!(l.l0_check(None, "tr-1", "chip:tr-1:1", "vad_chip", "succeeded", "led_on"), L0Outcome::Silent("stale_or_foreign_trace"), "无 active trace 不播");
        assert_eq!(l.l0_check(Some("tr-1"), "tr-1", "chip:tr-1:1", "ui", "succeeded", "led_on"), L0Outcome::Silent("invalid_l0_source"));
        assert_eq!(l.l0_check(Some("tr-1"), "tr-1", "chip:tr-1:1", "vad_chip", "succeeded", ""), L0Outcome::Silent("missing_action"));
        assert_eq!(l.l0_check(Some("tr-1"), "tr-1", "chip:tr-1:1", "vad_chip", "accepted", "led_on"), L0Outcome::Silent("accepted_diagnostic"));
        assert_eq!(l.l0_check(Some("tr-1"), "tr-1", "chip:tr-1:1", "vad_chip", "weird", "led_on"), L0Outcome::Silent("unknown_status"));
        assert_eq!(ok(&mut l, "chip:tr-1:1"), L0Outcome::Speak, "未知状态/accepted 不得污染已见集合");
        assert_eq!(ok(&mut l, "chip:tr-1:1"), L0Outcome::Silent("duplicate_terminal"));
        assert_eq!(l.l0_check(Some("tr-1"), "tr-1", "chip:tr-1:2", "fallback", "rejected", "led_on"), L0Outcome::Speak, "fallback 来源合法");
    }

    /// 编排向量:识别→候选→ASR→proposal(记录待发布候选)→第二句(合同 2 旧策略全链)
    #[test]
    fn orchestration_contract2_two_utterances() {
        let t0 = Instant::now();
        let mut l = Ledger::new();
        let mut published: Vec<(&str, Option<String>)> = Vec::new();
        // 句 1:芯片先到 → 立即提案(带候选) → ASR 同句吞
        l.on_speech_start(t0);
        if let ChipOutcome::ProposeNow { candidate, utterance } = l.on_chip(2, "led_on", Ownership::Proposed, Some("vad:t:1".into()), t0 + ms(700)) {
            published.push(("led_on", candidate));
            l.record_proposal(utterance, "led_on", "", "chip", t0 + ms(700));
        }
        l.on_commit(t0 + ms(1200), ms(300));
        assert!(matches!(l.decide("led_on", "", "asr"), Decision::Suppress(_)));
        // 句 2:只有 ASR
        l.on_speech_start(t0 + ms(2500));
        l.on_commit(t0 + ms(3600), ms(300));
        if let Decision::Propose { candidate, .. } = l.decide("led_off", "", "asr") {
            published.push(("led_off", candidate));
            l.record_proposal(Some(l.current_utterance()), "led_off", "", "asr", t0 + ms(3600));
        }
        assert_eq!(published, vec![("led_on", Some("vad:t:1".into())), ("led_off", None)], "两句各一次动作,候选原样回传");
    }
}
