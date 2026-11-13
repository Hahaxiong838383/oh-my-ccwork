//! B50 §4:用户字幕 final 的**延迟发布门**——让「端侧收到非空 LOCAL final」真正蕴含
//! 「这句会被处理」。
//!
//! 病灶(B49 §D,trace `83f57014`):`on_final()` 里 `tr.user_final()` 无条件先把 final 字幕
//! 发给端侧,**之后**才在 `on_tick` 的 commit 裁决里判回声。被判回声的句子零 commit、零 LLM、
//! 零 TTS,而 wire 上那句「用户说了 X」既不撤回也无终结信号 → Android `awaitResponse()` 空等
//! 到 120 秒上限。契约事件(`UserTranscriptFinal` 有、`UserTurnCommitted` 无)只是 journald
//! 日志,**不发包**,端侧看不见。
//!
//! 做法:final 到达时**立刻轮换段 id**(下一段 interim 不会覆盖本段)但**不发**,把 (seg, text)
//! 压进缓冲;等 commit 裁决出来再决定发还是丢。
//!
//! ## 为什么默认发、只有回声门显式丢(B50 §4 的边界)
//!
//! `on_tick` 有 8 条 return,只有 3 条是回声门。其余(STOP/EXIT 吞句、设备命令轮、账本压制、
//! 音量提示、普通 LLM 轮)**都必须照发**:
//! - **STOP / SESSION_EXIT 是有效控制输入**,虽然不起 LLM 轮。`SESSION_EXIT_SIGNAL_ENABLED=0`
//!   的部署靠这条 LOCAL final 让端侧退出——当回声删掉 = 砍掉退出出口。
//! - **设备命令**(含被账本压制的同句重复)是有效输入,零 LLM 不等于该丢。
//!
//! 所以判决默认 `Publish`,只有三处回声门显式 `mark_echo_drop()`。将来 `on_tick` 新增
//! return 分支**自动继承 Publish**——失效方向是「多发一条可见字幕」而不是「静默丢失」。
//!
//! ## 与 `turn_gate.pending` 的一一对应(不重不漏的根据)
//!
//! `turn::Gate::pending` 只有两个写点:`on_final` 追加(空串直接 return 不入)、`poll_commit`
//! 整体 `mem::take`。**没有「不 commit 就丢弃」的路径。** 本门照此镜像:空 final 不入缓冲
//! (由调用方立即发,空 final 在端侧不启动等待),非空 final 一条一条入,裁决时整体 drain。
//! 多条 final 合成一次 commit 时,缓冲里就是那几条,按原序整体发或整体丢。
//!
//! ## 这不是「final 必有回复」的承诺
//!
//! 只保留「有资格被处理」的 final;工具/生成失败仍可能没有回复。端侧有界保护继续保留。

/// B52 §6.2:**控制出口白名单**——这些文本即便被回声门吞掉不成轮,它们的 LOCAL final 字幕
/// **仍必须发给端侧**,否则端侧失去控制出口。
///
/// 为什么必须有这个:B51 我声称「控制出口全保留」,依据是 `on_tick_inner` 里 stop_only /
/// session_exit 分支不调 `mark_echo_drop`。**codex B52 §6.2 指出这个推理错了**——单字/本地
/// 回声库门排在那些分支**之前**,开场 15 秒窗内一个单字「停」会先被它吞掉并丢字幕,根本走不到
/// 后面的默认 Publish。判据套在了错误的层上(同族 [[feedback_criteria_must_match_object_variant]])。
///
/// 四类出口:
/// - `stop`：急停词(`cfg.hotwords`)——端侧靠它清「等回复」状态
/// - `exit_exact`：退出词精确命中(`cfg.exit_hotwords`)
/// - `exit_tail`：复合句尾部/碎片退出意图——`SESSION_EXIT_SIGNAL_ENABLED=0` 的部署**只能**靠它退出
/// - `command`：设备命令——有效输入,零 LLM 不等于该丢
///
/// B53 时判决只影响**字幕**。B68 §3.2 起它同时是开场回声门的豁免依据
/// (`textproc::opening_echo_verdict` 与重叠窗的 `control_outlet.is_none()`):分类为 Some 的句子
/// 不再被开场回声门吞掉,而是放行到 STOP/EXIT/设备命令出口——本函数仍不执行任何打断/退出动作,
/// 只决定这句**能不能走到**那些出口。
pub fn control_outlet_kind(
    text: &str,
    hotwords: &std::collections::HashSet<String>,
    exit_hotwords: &std::collections::HashSet<String>,
    exit_tail_match: bool,
) -> Option<&'static str> {
    if let Some(path) = crate::textproc::session_exit_path(exit_hotwords, text, exit_tail_match) {
        return Some(if path == "exact" { "exit_exact" } else { "exit_tail" });
    }
    if crate::textproc::is_turn_stop(hotwords, text) {
        return Some("stop");
    }
    if crate::device_intent::match_command(text).is_some() {
        return Some("command");
    }
    None
}

#[cfg(test)]
mod natural_control_outlet_tests {
    use super::*;
    use crate::textproc::{parse_hotwords, parse_hotwords_with};
    #[test]
    fn natural_stop_and_close_share_the_caption_and_echo_exemption() {
        let stop=parse_hotwords(None);
        let exit=parse_hotwords_with(Some("闭嘴,别说话"), "");
        for text in ["小可你先闭嘴", "你能不能先别说话了", "行了别讲了"] {
            assert_eq!(control_outlet_kind(text,&stop,&exit,true),Some("exit_tail"));
        }
        for text in ["先听我说", "别念了", "小可安静点", "别说了"] {
            assert_eq!(control_outlet_kind(text,&stop,&exit,true),Some("stop"));
        }
        for text in ["闭嘴是什么意思", "别念了这个词怎么读", "小可先听我讲个故事", "别不说话"] {
            assert_eq!(control_outlet_kind(text,&stop,&exit,true),None);
        }
    }
}

/// 一条等待裁决的用户 final 字幕:段 id 在 final 到达那刻就定下并轮换,内容照原样。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFinal {
    pub seg: String,
    pub text: String,
}

/// 本 tick 对缓冲里那批 final 的裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 本 tick 没有 commit 裁决 → 继续缓冲,一条都不发
    Hold,
    /// commit 已裁决且该句有资格被处理 → 整批按序发
    Publish,
    /// 判为回声/无效输入 → 整批丢弃,端侧永不会因它启动等待
    Drop,
}

/// 裁决结果(调用方据此动作;`Hold` 时缓冲原样留着)。
#[derive(Debug, PartialEq, Eq)]
pub enum Flush {
    Hold,
    Publish(Vec<PendingFinal>),
    /// 判回声:这批 final 不发。**但段 id 要带出来**——`on_interim` 是无条件发布的,
    /// 那些段上已经有 interim 文本;若 final 既不发也不收尾,端侧会永远挂着一条
    /// 未收尾的字幕段(B52 后台审计发现,是 B51 延迟发布引入的回归:改之前 final 总会发,
    /// 段天然收尾)。调用方应对每个段发一条**空 final** 撤回并收尾。
    Drop(Vec<PendingFinal>),
}

pub struct CaptionGate {
    enabled: bool,
    verdict: Verdict,
    buf: Vec<PendingFinal>,
    published_total: u32,
    dropped_total: u32,
}

impl CaptionGate {
    pub fn new(enabled: bool) -> Self {
        Self { enabled, verdict: Verdict::Hold, buf: Vec::new(), published_total: 0, dropped_total: 0 }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn published_total(&self) -> u32 {
        self.published_total
    }

    pub fn dropped_total(&self) -> u32 {
        self.dropped_total
    }

    /// 测试专用:断言缓冲既不泄漏也不串到下一句(生产路径只走 `take_flush`)。
    #[cfg(test)]
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// 缓冲里每条 final 的原文。用于控制出口判定:`poll_commit` 交出来的是**合并后**的
    /// 整句,而「停」可能是被合并进去的其中一条 final——只看合并文本会把它判成普通句
    /// (B52 后台审计指出)。判定取"合并文本 或 任一条原始 final"。
    pub fn buffered_texts(&self) -> Vec<String> {
        self.buf.iter().map(|p| p.text.clone()).collect()
    }

    /// 一条 final 到达。返回 `true` = 已缓冲(调用方**不要**立即发);
    /// `false` = 门关着或空 final,调用方按原路立即发。
    pub fn on_final(&mut self, seg: String, text: &str) -> bool {
        if !self.enabled || text.is_empty() {
            return false;
        }
        self.buf.push(PendingFinal { seg, text: text.to_string() });
        true
    }

    /// commit 已裁决(`poll_commit` 返回 Some 的那一刻)。默认有资格发。
    pub fn on_commit_decided(&mut self) {
        if self.enabled {
            self.verdict = Verdict::Publish;
        }
    }

    /// 三处回声门专用:判为回声 → 整批丢。只能在 `on_commit_decided` 之后调用。
    ///
    /// `control_outlet` = 该文本是不是控制出口(由 [`control_outlet_kind`] 得出)。**是 → 不丢**,
    /// 返回 `false`。把豁免放在这里而不是调用点,是为了让「控制出口不会被丢」成为**本函数的
    /// 不变量**:调用点必须显式给出判定结果,绕不过去。B51 的错就错在豁免散在调用点上,
    /// 而单字门那个调用点根本没写豁免。
    pub fn mark_echo_drop(&mut self, control_outlet: Option<&'static str>) -> bool {
        if control_outlet.is_some() {
            return false;
        }
        if self.enabled {
            self.verdict = Verdict::Drop;
        }
        true
    }

    /// Explicit mode/control cancellation retracts old pending segments, without replay on later chat.
    pub fn cancel_pending(&mut self) -> Vec<PendingFinal> {
        self.verdict=Verdict::Hold;
        let old=std::mem::take(&mut self.buf);self.dropped_total+=old.len() as u32;old
    }

    /// tick 收尾唯一出口:取出裁决并复位。`Hold` 不动缓冲。
    pub fn take_flush(&mut self) -> Flush {
        match std::mem::replace(&mut self.verdict, Verdict::Hold) {
            Verdict::Hold => Flush::Hold,
            Verdict::Publish => {
                let v: Vec<_> = self.buf.drain(..).collect();
                self.published_total += v.len() as u32;
                if v.is_empty() { Flush::Hold } else { Flush::Publish(v) }
            }
            Verdict::Drop => {
                let v: Vec<_> = self.buf.drain(..).collect();
                self.dropped_total += v.len() as u32;
                if v.is_empty() { Flush::Hold } else { Flush::Drop(v) }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(seg: &str, text: &str) -> PendingFinal {
        PendingFinal { seg: seg.into(), text: text.into() }
    }

    #[test]
    fn listening_transition_retracts_pending_captions_before_next_normal_speech() {
        let mut g=CaptionGate::new(true);g.on_final("old".into(),"先前的叙述");
        assert_eq!(g.cancel_pending(),vec![p("old","先前的叙述")]);
        assert_eq!(g.take_flush(),Flush::Hold);
        g.on_final("new".into(),"新的普通问题");g.on_commit_decided();
        assert_eq!(g.take_flush(),Flush::Publish(vec![p("new","新的普通问题")]));
    }
    /// 默认关是安全根基:门关着时一条都不缓冲,调用方走原路立即发。
    #[test]
    fn disabled_never_buffers() {
        let mut g = CaptionGate::new(false);
        assert!(!g.on_final("A".into(), "你好"), "关着时必须让调用方立即发");
        g.on_commit_decided();
        assert_eq!(g.take_flush(), Flush::Hold);
        assert_eq!(g.buffered(), 0);
        // 正锚:开着时同一序列必须缓冲并发出,否则「关着不动」与「门坏了」不可区分
        let mut on = CaptionGate::new(true);
        assert!(on.on_final("A".into(), "你好"));
        on.on_commit_decided();
        assert_eq!(on.take_flush(), Flush::Publish(vec![p("A", "你好")]));
    }

    /// 空 final 不入缓冲——镜像 `turn::Gate::on_final` 的空串早退,保持一一对应。
    #[test]
    fn empty_final_is_not_buffered() {
        let mut g = CaptionGate::new(true);
        assert!(!g.on_final("A".into(), ""), "空 final 由调用方立即发,不进缓冲");
        assert_eq!(g.buffered(), 0);
    }

    /// 没有 commit 裁决就不发:这是「延迟」的全部意义,提前发＝洞还在。
    #[test]
    fn hold_without_commit_keeps_buffer() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "小可");
        assert_eq!(g.take_flush(), Flush::Hold);
        assert_eq!(g.buffered(), 1, "未裁决前缓冲必须原样留着");
        assert_eq!(g.take_flush(), Flush::Hold, "连续多个空 tick 也不能发");
        assert_eq!(g.buffered(), 1);
    }

    /// 多条 final 合成一次 commit:按原序整批发,不重不漏。
    #[test]
    fn multi_final_one_commit_publishes_all_in_order() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "小可小可");
        g.on_final("B".into(), "说个长句");
        g.on_final("C".into(), "测试一下");
        g.on_commit_decided();
        assert_eq!(
            g.take_flush(),
            Flush::Publish(vec![p("A", "小可小可"), p("B", "说个长句"), p("C", "测试一下")])
        );
        assert_eq!(g.buffered(), 0, "发完必须清空,否则会串到下一句");
        assert_eq!(g.published_total(), 3);
    }

    /// 判回声 → 整批丢,端侧一条都收不到,永不会启动等待。
    #[test]
    fn echo_drop_discards_whole_batch() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "吧");
        g.on_commit_decided();
        g.mark_echo_drop(None);
        assert_eq!(g.take_flush(), Flush::Drop(vec![p("A", "吧")]));
        assert_eq!(g.buffered(), 0);
        assert_eq!(g.dropped_total(), 1);
        assert_eq!(g.published_total(), 0);
    }

    /// 回声判决只作用于本批:下一句照常发。丢一次不能变成永久静音。
    #[test]
    fn drop_does_not_leak_into_next_utterance() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "吧");
        g.on_commit_decided();
        g.mark_echo_drop(None);
        assert_eq!(g.take_flush(), Flush::Drop(vec![p("A", "吧")]));

        g.on_final("B".into(), "讲个故事");
        g.on_commit_decided();
        assert_eq!(g.take_flush(), Flush::Publish(vec![p("B", "讲个故事")]), "上一句判回声不影响下一句");
    }

    /// **B50 §4 的硬边界**:STOP/EXIT 吞句、设备命令、账本压制、音量提示这些路径
    /// 都不调 `mark_echo_drop`,所以判决停在默认的 Publish——控制出口不能被当回声删掉。
    /// 将来 `on_tick` 新增 return 分支同样自动继承 Publish(失效方向=多发一条可见字幕)。
    #[test]
    fn commit_decided_without_echo_mark_defaults_to_publish() {
        for text in ["停", "退出", "开灯", "声音调到一百"] {
            let mut g = CaptionGate::new(true);
            g.on_final("S".into(), text);
            g.on_commit_decided();
            // 注意:此处**故意不调** mark_echo_drop,模拟那 5 条非回声 return
            assert_eq!(
                g.take_flush(),
                Flush::Publish(vec![p("S", text)]),
                "'{text}' 是有效控制/命令输入,必须保留 LOCAL final 出口"
            );
        }
    }

    /// 裁决一次性:take 之后复位成 Hold,同一个 Publish 不会连发两遍。
    #[test]
    fn verdict_resets_after_take() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "你好");
        g.on_commit_decided();
        assert!(matches!(g.take_flush(), Flush::Publish(_)));
        assert_eq!(g.take_flush(), Flush::Hold, "同一裁决不得重复生效");
        assert_eq!(g.published_total(), 1, "计数也只能加一次");
    }

    /// 裁决了但缓冲是空的(例如该 commit 的 final 全是空串)→ Hold,不产生空动作日志。
    #[test]
    fn commit_with_empty_buffer_is_hold() {
        let mut g = CaptionGate::new(true);
        g.on_commit_decided();
        assert_eq!(g.take_flush(), Flush::Hold);
        let mut g2 = CaptionGate::new(true);
        g2.on_commit_decided();
        g2.mark_echo_drop(None);
        assert_eq!(g2.take_flush(), Flush::Hold);
    }

    /// 会话中途结束、缓冲还没裁决 → 那句从未 commit 也从未回复,不发才是对的
    /// (新合同:非空 final ⇒ 会被处理;发了才是违约)。
    #[test]
    fn unresolved_buffer_is_never_published() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "小可小");
        assert_eq!(g.take_flush(), Flush::Hold);
        assert_eq!(g.published_total(), 0);
        assert_eq!(g.dropped_total(), 0);
    }

    // ---------- B52 §6.2:控制出口白名单 ----------

    fn hw(v: &[&str]) -> std::collections::HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 四类控制出口逐条锁死。任何一类失效,端侧就会丢掉对应的控制通道。
    #[test]
    fn control_outlet_matrix() {
        let stop = hw(&["停", "停下", "等等"]);
        let exit = hw(&["退出", "不聊了"]);
        assert_eq!(control_outlet_kind("停", &stop, &exit, true), Some("stop"), "急停词:端侧靠它清等答状态");
        assert_eq!(control_outlet_kind("停下", &stop, &exit, true), Some("stop"));
        assert_eq!(control_outlet_kind("退出", &stop, &exit, true), Some("exit_exact"), "精确退出词");
        assert_eq!(control_outlet_kind("不聊了", &stop, &exit, true), Some("exit_exact"));
        assert_eq!(
            control_outlet_kind("那我们不想聊了", &stop, &hw(&[]), true),
            Some("exit_tail"),
            "尾部退出意图:SESSION_EXIT_SIGNAL_ENABLED=0 的部署只能靠这条字幕退出"
        );
        // 负锚:普通话不是控制出口,否则这张白名单等于关掉了整个回声门
        assert_eq!(control_outlet_kind("讲个故事", &stop, &exit, true), None);
        assert_eq!(control_outlet_kind("好", &stop, &exit, true), None, "单字回声照旧该丢");
        assert_eq!(control_outlet_kind("琪", &stop, &exit, true), None);
        assert_eq!(control_outlet_kind("", &stop, &exit, true), None);
    }

    /// **B55 §5 真机数据锚**:B/C 两房四条 2 字错转全都不是控制出口。
    /// 记这条是为了钉死修复方向——它们走的是普通轮 commit,不是控制通道,
    /// 所以「保控制出口」那套改动对本轮自打断**一格都够不着**。
    #[test]
    fn b55_bc_misrecognitions_are_not_control_outlets() {
        let stop = hw(&["停", "停下", "等等"]);
        let exit = hw(&["退出", "不聊了"]);
        // B 房 08:40:42 / 08:40:55,C 房 08:45:19 / 08:45:46 的实际 commit 文本
        for t in ["啊急", "付出", "好起", "你说"] {
            assert_eq!(
                control_outlet_kind(t, &stop, &exit, true),
                None,
                "{t}:普通文本,不得被当成控制出口(否则回声门会被这张白名单整个架空)"
            );
        }
        // 正锚:同一调用形态下真控制词仍分得出来,否则上面四个 None 只是「分类器没跑」
        assert_eq!(control_outlet_kind("停", &stop, &exit, true), Some("stop"));
        assert_eq!(control_outlet_kind("退出", &stop, &exit, true), Some("exit_exact"));
    }

    /// `EXIT_TAIL_MATCH=0` 时尾部分支关闭,但精确退出词仍是出口。
    #[test]
    fn exit_tail_respects_switch() {
        let stop = hw(&["停"]);
        let exit = hw(&["退出"]);
        assert_eq!(control_outlet_kind("那我们不想聊了", &stop, &exit, false), None, "开关关=尾部不算出口");
        assert_eq!(control_outlet_kind("退出", &stop, &exit, false), Some("exit_exact"), "精确词不受该开关影响");
    }

    /// **codex B52 §6.2 那条缺陷的回归锚**:单字「停」在开场窗被回声门吞掉时,
    /// 字幕判决必须仍是 Publish——这正是我 B51 说错的那一格。
    #[test]
    fn stop_swallowed_as_echo_still_publishes_caption() {
        let stop = hw(&["停"]);
        let exit = hw(&["退出"]);
        let mut g = CaptionGate::new(true);
        g.on_final("S".into(), "停");
        g.on_commit_decided();
        // 模拟单字回声门命中:调用方先查白名单,命中就**不**调 mark_echo_drop
        if control_outlet_kind("停", &stop, &exit, true).is_none() {
            g.mark_echo_drop(None);
        }
        assert_eq!(g.take_flush(), Flush::Publish(vec![p("S", "停")]), "被当回声吞掉也要把 final 发出去");

        // 对照:同一条路径上的真回声必须照丢,否则这张白名单就是把门整个关掉
        let mut g2 = CaptionGate::new(true);
        g2.on_final("E".into(), "好");
        g2.on_commit_decided();
        if control_outlet_kind("好", &stop, &exit, true).is_none() {
            g2.mark_echo_drop(None);
        }
        assert_eq!(g2.take_flush(), Flush::Drop(vec![p("E", "好")]), "真回声仍然丢");
    }

    /// **强制点直测**:控制出口传进来时,`mark_echo_drop` 自己拒绝丢弃并返回 false。
    /// 这条不是测策略,是测「调用点绕不过去」这个不变量。
    #[test]
    fn mark_echo_drop_refuses_to_drop_control_outlets() {
        for outlet in ["stop", "exit_exact", "exit_tail", "command"] {
            let mut g = CaptionGate::new(true);
            g.on_final("S".into(), "停");
            g.on_commit_decided();
            assert!(!g.mark_echo_drop(Some(outlet)), "{outlet}:必须拒绝丢弃并返回 false");
            assert_eq!(g.take_flush(), Flush::Publish(vec![p("S", "停")]), "{outlet} 的字幕必须照发");
        }
        // 正锚:非控制出口照丢,否则这个不变量等于把整个回声门关掉
        let mut g = CaptionGate::new(true);
        g.on_final("E".into(), "好");
        g.on_commit_decided();
        assert!(g.mark_echo_drop(None), "普通回声必须返回 true 并丢弃");
        assert_eq!(g.take_flush(), Flush::Drop(vec![p("E", "好")]));
    }

    /// **B52 回归锚**:判回声时必须把段 id 带出来。只返回个计数的话,调用方无法对那些段
    /// 发空 final 收尾,端侧会留下永不收尾的 interim(这是 B51 延迟发布引入的回归)。
    #[test]
    fn drop_carries_segments_for_retraction() {
        let mut g = CaptionGate::new(true);
        g.on_final("S1".into(), "好");
        g.on_final("S2".into(), "琪");
        g.on_commit_decided();
        assert!(g.mark_echo_drop(None));
        match g.take_flush() {
            Flush::Drop(v) => {
                assert_eq!(v.len(), 2, "两段都要能被撤回");
                assert_eq!(v[0].seg, "S1");
                assert_eq!(v[1].seg, "S2");
            }
            other => panic!("期望 Drop(segments),得到 {other:?}"),
        }
        assert_eq!(g.buffered(), 0);
    }

    /// **合并句回归锚**:「停」被合并进一次 commit 时,合并文本不是纯急停词,
    /// 但那条原始 final 是——控制出口判定必须看得见它。
    #[test]
    fn buffered_texts_exposes_individual_finals() {
        let mut g = CaptionGate::new(true);
        g.on_final("A".into(), "讲个故事");
        g.on_final("B".into(), "停");
        assert_eq!(g.buffered_texts(), vec!["讲个故事".to_string(), "停".to_string()]);
        let stop = hw(&["停"]);
        let exit = hw(&["退出"]);
        // 合并文本判不出来
        assert_eq!(control_outlet_kind("讲个故事 停", &stop, &exit, true), None, "合并后不是纯急停词");
        // 逐条就能判出来
        assert!(
            g.buffered_texts().iter().any(|t| control_outlet_kind(t, &stop, &exit, true).is_some()),
            "逐条扫描必须命中那条「停」"
        );
    }
}

#[cfg(test)]
mod session_close_regressions {
    use super::control_outlet_kind;
    use crate::textproc::{parse_hotwords, parse_hotwords_with};
    #[test]
    fn configured_close_has_priority_over_interrupt() {
        let stop = parse_hotwords(None);
        let exit = parse_hotwords_with(Some("闭嘴,别说话,小可退出,退下"), "");
        for text in ["闭嘴", "闭嘴。", "别说话", "小可退出", "退下"] {
            assert_eq!(control_outlet_kind(text, &stop, &exit, true), Some("exit_exact"), "{text}");
        }
        for text in ["我现在再念一段话你听完说感受啊", "现在这段分享还没有结束", "停一下直接告诉我3+5等于几", "不要闭嘴", "闭嘴是什么意思", "他说闭嘴", "结束倾听恢复聊天", "恢复聊天", "小可结束倾听", "先别退出", "他说不聊了", "故事里的小可退出", "我不让你再见"] {
            assert_eq!(control_outlet_kind(text, &stop, &exit, true), None, "{text}");
        }
        assert_eq!(control_outlet_kind("停一下", &stop, &exit, true), Some("stop"));
    }
}
