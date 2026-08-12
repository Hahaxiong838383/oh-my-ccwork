//! 文本处理:canonical 转写(对齐 volc_stt._canon_transcript)+ 急停白名单标准化
//! (对齐 tier_a_cascade._normalize_utterance/_parse_hotwords)。
//!
//! canonical 是 S1 投机命中的关键:PREFLIGHT 与 FINAL 都过同一函数 → 字符串全等
//! 才能复用投机。生产 VOLC_PREFLIGHT_ENABLED=1 时所有 FINAL/INTERIM 均为 canonical。

use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// NFKC 归一 + 去空白 + 去标点(Unicode P 类),保留数字间小数点("3.5" 不变 "35")。
pub fn canon_transcript(s: &str) -> String {
    let chars: Vec<char> = s.nfkc().collect();
    let n = chars.len();
    let mut out = String::with_capacity(s.len());
    for (i, &ch) in chars.iter().enumerate() {
        if ch.is_whitespace() {
            continue;
        }
        if ch == '.'
            && i > 0
            && i < n - 1
            && chars[i - 1].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
        {
            out.push(ch);
            continue;
        }
        if ch.general_category_group() == GeneralCategoryGroup::Punctuation {
            continue;
        }
        out.push(ch);
    }
    out
}

/// 默认急停词(与 Python _DEFAULT_INTERRUPT_HOTWORDS 逐字对齐)。
pub const DEFAULT_INTERRUPT_HOTWORDS: &str = "停,停停,停下,停一下,等等,等一下,别说了,别说,闭嘴,安静";

/// 转写标准化:去空白与常见中英标点(与 _HOTWORD_STRIP_RE 字符集对齐),供急停词精确比对。
pub fn normalize_utterance(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !"，。！？!?.、~～…".contains(*c))
        .collect()
}

/// INTERRUPT_HOTWORDS 逗号分隔 → 标准化词集;显式设空串=禁用白名单;未设=默认词表。
pub fn parse_hotwords(raw: Option<&str>) -> HashSet<String> {
    let src = raw.unwrap_or(DEFAULT_INTERRUPT_HOTWORDS);
    src.split(',')
        .map(normalize_utterance)
        .filter(|w| !w.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canon_strips_punct_keeps_decimal() {
        // 与 Python _canon_transcript 行为对拍
        assert_eq!(canon_transcript("今天北京的天气怎么样？"), "今天北京的天气怎么样");
        assert_eq!(canon_transcript("嗯， 好的。3.5 度！"), "嗯好的3.5度");
        assert_eq!(canon_transcript("末尾点3."), "末尾点3");
        assert_eq!(canon_transcript("ＡＢＣ　１２３"), "ABC123"); // NFKC 全角归一
    }

    #[test]
    fn hotword_normalize_and_match() {
        let words = parse_hotwords(None);
        assert!(words.contains(&normalize_utterance("停。")));
        assert!(words.contains(&normalize_utterance(" 别说了！")));
        assert!(!words.contains(&normalize_utterance("停车场怎么走")));
        // 显式空串=禁用
        assert!(parse_hotwords(Some("")).is_empty());
    }
}
