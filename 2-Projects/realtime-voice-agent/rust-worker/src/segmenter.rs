//! 中文流式切句(行为对齐 StreamAdapter+blingfire min_sentence_len=6 的生产语义):
//! 句末标点触发 flush,但累计不足 min_len 先攒(防孤立短段打碎 TTS);流结束余量整段 flush。

const SENTENCE_ENDINGS: &[char] = &['。', '！', '？', '；', '!', '?', ';', '…', '~', '～', '\n'];

pub struct Segmenter {
    min_len: usize,
    buf: String,
}

impl Segmenter {
    pub fn new(min_len: usize) -> Self {
        Self { min_len, buf: String::new() }
    }

    /// 喂一段 LLM delta,返回攒出的完整句(可能 0..n 句)。
    pub fn feed(&mut self, delta: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ch in delta.chars() {
            self.buf.push(ch);
            if SENTENCE_ENDINGS.contains(&ch) && self.buf.chars().count() >= self.min_len {
                let s = std::mem::take(&mut self.buf);
                let trimmed = s.trim();
                if !trimmed.is_empty() {
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
}
