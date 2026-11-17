//! 播放中附和词(2026-09-14 川哥拍板):小可正在播长文本(讲故事/科普)时,孩子随口「嗯/对/是」
//! 是在听、不是在插话——整句命中表内词(两字以内)则不打断、不起新轮、不投机,只记日志。
//!
//! 三条边界:
//! ① 只在 agent 正在播放 且 本轮回复 LLM 已产出字数 ≥ `min_reply_chars` 时生效(短回答照常可被打断);
//! ② 整句 normalize 后**精确等于**表内词,子串不算——「嗯，换一个」照常打断;
//! ③ 控制词硬黑名单永远不当附和(即使误配进词表也剔除):急停/退出/换一个/唤醒词/句子开头词。
//!
//! 模式:词表空=off;`observe`(默认)只记候选、行为不变;`enforce` 才真吞并续播。
//! 词表由后台「热词管理·播放中附和词」发布到 env `BACKCHANNEL_HOTWORDS`;
//! `BACKCHANNEL_MODE` / `BACKCHANNEL_MIN_REPLY_CHARS` 走 env(改后随发布链重启生效)。
//! 判定顺序在 pipeline 里排在急停/退出吞句之后、TTS 回声对撞之前——「停」永远先赢。
use std::collections::HashSet;

use crate::textproc::normalize_utterance;

pub const DEFAULT_MIN_REPLY_CHARS: usize = 120;
/// 附和词最长两字(川哥 2026-09-14 口径:B 组三字催更词不进)
pub const MAX_WORD_CHARS: usize = 2;
/// 永远不当附和的控制词(与服务端 hotword-store BACKCHANNEL_BLACKLIST 同源;这里是最后一道兜底)
pub const CONTROL_BLACKLIST: &[&str] = &[
    "停", "停止", "停停", "停下", "停一下", "等等", "等一下", "别说了", "别说", "闭嘴", "安静",
    "换一个", "换", "不", "不要", "别", "不听", "不想听",
    "退出", "结束", "再见", "拜拜", "不聊了", "不用了",
    "喂", "小可", "小可小可",
    "我", "这个", "那个", "就是", "然后", "那", "你", "它", "他", "她",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Observe,
    Enforce,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 不是附和(未开/回复太短/没命中/是控制词)→ 走原有打断/commit 链
    NotCandidate,
    /// observe:是附和候选,只记日志,行为不变
    Observe,
    /// enforce:真吞——不 commit、不起 LLM、续播
    Ignore,
}

#[derive(Clone, Debug)]
pub struct BackchannelCfg {
    pub words: HashSet<String>,
    pub mode: Mode,
    pub min_reply_chars: usize,
}

impl BackchannelCfg {
    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var("BACKCHANNEL_HOTWORDS").ok().as_deref(),
            std::env::var("BACKCHANNEL_MODE").ok().as_deref(),
            std::env::var("BACKCHANNEL_MIN_REPLY_CHARS").ok().as_deref(),
        )
    }

    /// 纯函数装配(单测直接喂 env 形态字符串)。词表逗号分隔;黑名单词与超两字词在装配时剔除并计数。
    pub fn from_values(words: Option<&str>, mode: Option<&str>, min_reply: Option<&str>) -> Self {
        let words: HashSet<String> = words
            .unwrap_or("")
            .split(',')
            .map(normalize_utterance)
            .filter(|w| !w.is_empty())
            .filter(|w| w.chars().count() <= MAX_WORD_CHARS)
            .filter(|w| !CONTROL_BLACKLIST.contains(&w.as_str()))
            .collect();
        let mode = match mode.map(|m| m.trim().to_ascii_lowercase()).as_deref() {
            Some("enforce") => Mode::Enforce,
            Some("off") => Mode::Off,
            _ => Mode::Observe,
        };
        let mode = if words.is_empty() { Mode::Off } else { mode };
        let min_reply_chars = min_reply
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(DEFAULT_MIN_REPLY_CHARS);
        Self { words, mode, min_reply_chars }
    }

    pub fn is_on(&self) -> bool {
        self.mode != Mode::Off
    }

    /// 判定入口。调用方保证「agent 正在播放(含被 VAD 暂停)」;这里只看 mode / 回复长度 / 整句命中。
    pub fn decide(&self, text: &str, reply_chars: usize) -> Decision {
        if self.mode == Mode::Off || reply_chars < self.min_reply_chars {
            return Decision::NotCandidate;
        }
        let norm = normalize_utterance(text);
        if norm.is_empty() || !self.words.contains(&norm) {
            return Decision::NotCandidate;
        }
        match self.mode {
            Mode::Enforce => Decision::Ignore,
            _ => Decision::Observe,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A_LIST: &str = "嗯,嗯嗯,嗯哼,哦,哦哦,噢,唔,对,对对,对呀,对啊,是,是的,是呀,是啊,好,好的,好呀,好啊,好嘞,行,可以,啊,哈,哈哈,哇,哇塞";

    #[test]
    fn parse_drops_blacklist_and_long_words_and_defaults_to_observe() {
        let c = BackchannelCfg::from_values(Some("嗯,对对, 好的 ,停,嗯嗯嗯,换一个,,小可小可"), None, None);
        assert_eq!(c.mode, Mode::Observe, "有词表且未指定 mode → observe");
        assert_eq!(c.min_reply_chars, DEFAULT_MIN_REPLY_CHARS);
        assert!(c.words.contains("嗯") && c.words.contains("对对") && c.words.contains("好的"));
        assert!(!c.words.contains("停"), "急停词即使配进表也剔除");
        assert!(!c.words.contains("换一个") && !c.words.contains("小可小可"), "控制词/唤醒词剔除");
        assert!(!c.words.contains("嗯嗯嗯"), "超两字剔除");
        assert_eq!(c.words.len(), 3);
    }

    #[test]
    fn empty_words_means_off_even_if_enforce_requested() {
        let c = BackchannelCfg::from_values(None, Some("enforce"), None);
        assert_eq!(c.mode, Mode::Off);
        assert!(!c.is_on());
        assert_eq!(c.decide("嗯", 999), Decision::NotCandidate);
        let c2 = BackchannelCfg::from_values(Some("停,换一个"), Some("enforce"), None);
        assert_eq!(c2.mode, Mode::Off, "词表全被黑名单剔空 → off");
    }

    #[test]
    fn decide_matrix_observe_vs_enforce_vs_short_reply() {
        let obs = BackchannelCfg::from_values(Some(A_LIST), Some("observe"), Some("120"));
        let enf = BackchannelCfg::from_values(Some(A_LIST), Some("enforce"), Some("120"));
        // 回复太短(日常聊天 30-50 字)→ 永不算附和,照常可打断
        assert_eq!(enf.decide("嗯", 50), Decision::NotCandidate);
        assert_eq!(enf.decide("嗯", 119), Decision::NotCandidate);
        // 长回复播放中
        assert_eq!(obs.decide("嗯", 120), Decision::Observe);
        assert_eq!(enf.decide("嗯", 120), Decision::Ignore);
        assert_eq!(enf.decide("对", 1285), Decision::Ignore);
        assert_eq!(enf.decide("是", 800), Decision::Ignore);
        // 标点/空白变体(ASR 形态)照样整句命中
        assert_eq!(enf.decide("嗯。", 300), Decision::Ignore);
        assert_eq!(enf.decide(" 对！", 300), Decision::Ignore);
        assert_eq!(enf.decide("好的，", 300), Decision::Ignore);
    }

    #[test]
    fn substring_and_control_words_never_swallowed() {
        let enf = BackchannelCfg::from_values(Some(A_LIST), Some("enforce"), Some("120"));
        assert_eq!(enf.decide("嗯，换一个", 500), Decision::NotCandidate, "复合句照常打断");
        assert_eq!(enf.decide("换一个", 500), Decision::NotCandidate);
        assert_eq!(enf.decide("停", 500), Decision::NotCandidate);
        assert_eq!(enf.decide("停止", 500), Decision::NotCandidate);
        assert_eq!(enf.decide("别说了", 500), Decision::NotCandidate);
        assert_eq!(enf.decide("退出", 500), Decision::NotCandidate);
        assert_eq!(enf.decide("然后呢", 500), Decision::NotCandidate, "B 组三字催更词不在 A 表");
        assert_eq!(enf.decide("我", 500), Decision::NotCandidate, "句子开头词不当附和");
        assert_eq!(enf.decide("", 500), Decision::NotCandidate);
    }

    #[test]
    fn min_reply_env_parse_and_fallback() {
        let c = BackchannelCfg::from_values(Some("嗯"), Some("ENFORCE"), Some(" 200 "));
        assert_eq!(c.mode, Mode::Enforce, "mode 大小写不敏感");
        assert_eq!(c.min_reply_chars, 200);
        assert_eq!(c.decide("嗯", 199), Decision::NotCandidate);
        assert_eq!(c.decide("嗯", 200), Decision::Ignore);
        let bad = BackchannelCfg::from_values(Some("嗯"), Some("observe"), Some("abc"));
        assert_eq!(bad.min_reply_chars, DEFAULT_MIN_REPLY_CHARS, "非法阈值回默认");
    }
}
