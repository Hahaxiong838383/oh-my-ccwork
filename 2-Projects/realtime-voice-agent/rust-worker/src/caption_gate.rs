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
    Drop(usize),
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
    pub fn mark_echo_drop(&mut self) {
        if self.enabled {
            self.verdict = Verdict::Drop;
        }
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
                let n = self.buf.len();
                self.buf.clear();
                self.dropped_total += n as u32;
                if n == 0 { Flush::Hold } else { Flush::Drop(n) }
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
        g.mark_echo_drop();
        assert_eq!(g.take_flush(), Flush::Drop(1));
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
        g.mark_echo_drop();
        assert_eq!(g.take_flush(), Flush::Drop(1));

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
        g2.mark_echo_drop();
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
}
