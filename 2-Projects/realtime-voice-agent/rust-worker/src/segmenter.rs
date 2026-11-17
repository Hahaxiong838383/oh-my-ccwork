//! 中文流式切句(行为对齐 StreamAdapter+blingfire min_sentence_len=6 的生产语义):
//! 句末标点触发 flush,但累计不足 min_len 先攒(防孤立短段打碎 TTS);流结束余量整段 flush。

const SENTENCE_ENDINGS: &[char] = &['。', '！', '？', '；', '!', '?', ';', '…', '~', '～', '\n'];
/// B17 首句逗号切：只认全角逗号（半角逗号会切「1,000」，顿号会切并列词，都不算）。
const CLAUSE_ENDINGS: &[char] = &['，'];

pub struct Segmenter {
    min_len: usize,
    buf: String,
    /// B17（默认 0=关，POC env `TTS_FIRST_CLAUSE_MIN`）：**只对本轮第一段**放宽——累计 ≥ 该字数遇到逗号也切，
    /// 让首句 TTS 不必等到句末标点（…0274 房 24 字回复无句末标点，TTS 等了整段 LLM 流 278 ms）。
    /// 第一段切出后恢复只认句末标点，后续段落韵律不变。
    first_clause_min: usize,
    flushed_any: bool,
    clause_split_chars: Option<usize>,
}

impl Segmenter {
    pub fn new(min_len: usize) -> Self {
        Self { min_len, buf: String::new(), first_clause_min: 0, flushed_any: false, clause_split_chars: None }
    }

    /// 首段逗号切阈值（0 = 关）。
    pub fn with_first_clause_min(mut self, n: usize) -> Self {
        self.first_clause_min = n;
        self
    }

    /// 本轮第一段是否由逗号切出（一次性取走，供日志打点）。
    pub fn take_clause_split(&mut self) -> Option<usize> {
        self.clause_split_chars.take()
    }

    /// 喂一段 LLM delta,返回攒出的完整句(可能 0..n 句)。
    pub fn feed(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            self.buf.push(ch);
            let n = self.buf.chars().count();
            let sentence_end = SENTENCE_ENDINGS.contains(&ch) && n >= self.min_len;
            let clause_end = !self.flushed_any
                && self.first_clause_min > 0
                && CLAUSE_ENDINGS.contains(&ch)
                && n >= self.first_clause_min;
            if sentence_end || clause_end {
                let s = std::mem::take(&mut self.buf);
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    if !self.flushed_any && clause_end && !sentence_end {
                        self.clause_split_chars = Some(trimmed.chars().count());
                    }
                    self.flushed_any = true;
                    out.push(trimmed.to_string());
                }
            }
        }
        out
    }

    /// 流结束:余量整段吐出。
    pub fn flush(&mut self) -> Option<String> {
        let s = std::mem::take(&mut self.buf);
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_first_sentence_flushes_at_min_len() {
        let mut seg = Segmenter::new(6);
        // "好的。"只有 3 字,不 flush;续到"没问题哦!"累计过 6 才切
        assert!(seg.feed("好的。").is_empty());
        let out = seg.feed("没问题哦！");
        assert_eq!(out, vec!["好的。没问题哦！"]);
    }

    #[test]
    fn multi_sentence_delta_splits() {
        let mut seg = Segmenter::new(6);
        let out = seg.feed("今天天气很好。我们出去玩吧！还没说完");
        assert_eq!(out, vec!["今天天气很好。", "我们出去玩吧！"]);
        assert_eq!(seg.flush(), Some("还没说完".to_string()));
    }

    #[test]
    fn flush_empty_returns_none() {
        let mut seg = Segmenter::new(6);
        seg.feed("完整一句话了吗？");
        assert_eq!(seg.flush(), None);
    }

    /// B17：默认关（阈值 0）→ 逗号从不切，…0274 型 24 字无句末标点回复到流结束才整段吐出（旧行为不变）。
    #[test]
    fn b17_default_off_comma_never_splits() {
        let mut seg = Segmenter::new(6);
        assert!(seg.feed("你好呀，测试成功啦，我已经准备好陪你聊天玩耍啦").is_empty());
        assert_eq!(seg.flush(), Some("你好呀，测试成功啦，我已经准备好陪你聊天玩耍啦".to_string()));
        assert_eq!(seg.take_clause_split(), None);
    }

    /// B17：阈值 4 → 首段「你好呀，」在逗号处切出（4 字），之后只认句末标点，第二个逗号不再切。
    #[test]
    fn b17_first_clause_splits_once_then_sentence_only() {
        let mut seg = Segmenter::new(6).with_first_clause_min(4);
        let out = seg.feed("你好呀，测试成功啦，我已经准备好陪你聊天玩耍啦");
        assert_eq!(out, vec!["你好呀，"]);
        assert_eq!(seg.take_clause_split(), Some(4));
        assert_eq!(seg.take_clause_split(), None, "一次性取走");
        assert_eq!(seg.flush(), Some("测试成功啦，我已经准备好陪你聊天玩耍啦".to_string()));
    }

    /// B17：首段不足阈值的逗号不切（「嗯，」2 字），攒到句末标点按老规则切；且这次不算逗号切。
    #[test]
    fn b17_short_clause_below_threshold_waits_for_sentence_end() {
        let mut seg = Segmenter::new(6).with_first_clause_min(4);
        let out = seg.feed("嗯，好的没问题。后面还有话，再说。");
        assert_eq!(out, vec!["嗯，好的没问题。", "后面还有话，再说。"]);
        assert_eq!(seg.take_clause_split(), None);
    }

    /// B17：首段本来就以句末标点结束（…0276 型「你想测试什么内容呢？」）→ 行为与旧规则完全一致。
    #[test]
    fn b17_sentence_end_first_unchanged() {
        let mut seg = Segmenter::new(6).with_first_clause_min(4);
        let out = seg.feed("你想测试什么内容呢？可以跟我说说具体的想法哦。");
        assert_eq!(out, vec!["你想测试什么内容呢？", "可以跟我说说具体的想法哦。"]);
        assert_eq!(seg.take_clause_split(), None);
    }

    /// B17：半角逗号/顿号不算子句边界（「1,000」「苹果、香蕉」不被切）。
    #[test]
    fn b17_ascii_comma_and_enumeration_comma_do_not_split() {
        let mut seg = Segmenter::new(6).with_first_clause_min(4);
        assert!(seg.feed("大概有1,000个苹果、香蕉和橘子").is_empty());
        assert_eq!(seg.take_clause_split(), None);
    }
}
