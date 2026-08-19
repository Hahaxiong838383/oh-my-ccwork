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

/// 退出词吞句集默认表(2026-08-17 川哥拍板,与 Android SESSION_EXIT 合同词表一致——
/// 联调 v2 §一.4/5:codex 现有 5 词+扩充 4 词+睡觉类 3 词)。Worker 只吞轮次防幽灵回答,
/// 回复/关房 100% 归 Android(退出权威不变)。
pub const DEFAULT_EXIT_HOTWORDS: &str =
    "不聊了,我不想聊了,再见,拜拜,退出对话,不用了,退出,结束,结束聊天,我要睡觉了,我去睡觉了,我要休息了";

/// 逗号分隔 → 标准化词集;显式设空串=禁用;未设=用 default_src。
pub fn parse_hotwords_with(raw: Option<&str>, default_src: &str) -> HashSet<String> {
    let src = raw.unwrap_or(default_src);
    src.split(',')
        .map(normalize_utterance)
        .filter(|w| !w.is_empty())
        .collect()
}

/// INTERRUPT_HOTWORDS 逗号分隔 → 标准化词集;显式设空串=禁用白名单;未设=默认词表。
pub fn parse_hotwords(raw: Option<&str>) -> HashSet<String> {
    parse_hotwords_with(raw, DEFAULT_INTERRUPT_HOTWORDS)
}

/// 语气词前缀(2026-08-19 Phase 1a):「嗯退出」「那退出」「好关灯」类真实 miss(journal 归因)。
/// 与 device_intent 的礼貌句式表(POLITE_PREFIX)职责分开:这里只管吞句场景的单字语气词。
const MODAL_PREFIX: &[char] = &['好', '那', '嗯', '哎'];

/// stop_only 吞句判定(2026-08-17 生命周期统一):整句标准化后精确等于急停词 → true。
/// 精确匹配天然保护混合句:「停，换个故事」normalize 后 != 任何纯急停词,不吞。
/// 白名单被显式禁用(空集)时恒 false。
/// 语气词前缀至多剥 2 字后重查(「嗯退出」「嗯嗯退出」)——剥后仍须完整命中,
/// 「好的呀」剥「好」后「的呀」不中=不吞,子串纪律不变。
pub fn is_stop_only(hotwords: &HashSet<String>, text: &str) -> bool {
    if hotwords.is_empty() {
        return false;
    }
    let mut s = normalize_utterance(text);
    if hotwords.contains(&s) {
        return true;
    }
    for _ in 0..2 {
        let Some(c) = s.chars().next() else { break };
        if !MODAL_PREFIX.contains(&c) {
            break;
        }
        s = s.chars().skip(1).collect();
        if hotwords.contains(&s) {
            return true;
        }
    }
    false
}

/// 剥离 LLM 输出里的舞台指示——括号/星号包裹的动作、表情、神态描述:
/// 「（笑）」「(假装认真)」「*叹气*」「【小声】」。TTS 会把它们整句念出
/// (2026-08-16 川哥实测),segmenter 出句后统一剥,TTS/字幕/历史三处同净文本
/// (track 的字符↔样本截断映射因此保持对齐)。
///
/// 只剥**闭合**的短包裹段(内容 ≤16 字符):未闭合(描述被 segmenter 从逗号切开)
/// 不动——宁可漏念一段也不误砍正文;prompt 层已同步禁,这里是兜底。
pub fn strip_stage_directions(text: &str) -> String {
    const MAX_INNER: usize = 16;
    let pairs: &[(char, char)] = &[('（', '）'), ('(', ')'), ('【', '】'), ('[', ']'), ('*', '*')];
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some((_, close)) = pairs.iter().find(|(open, _)| *open == c) {
            // 找同段内最近的闭符;星号对要求内容非空(孤立 * 保留)
            if let Some(off) = chars[i + 1..]
                .iter()
                .take(MAX_INNER + 1)
                .position(|&x| x == *close)
                && (c != '*' || off > 0)
            {
                i += off + 2; // 跳过整段(含双侧包裹符)
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    // 剥除后清理句首残留的空白(「（笑） 腿?」→「腿?」)
    out.trim_start().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_directions_stripped() {
        // 实测形态:全角括号句首(2026-08-16 线上日志)
        assert_eq!(strip_stage_directions("（笑）腿？我连腿都没有"), "腿？我连腿都没有");
        assert_eq!(strip_stage_directions("（假装认真）行，等我学会用螺丝刀"), "行，等我学会用螺丝刀");
        // 句中/半角/星号/方括号变体
        assert_eq!(strip_stage_directions("你好(笑)呀"), "你好呀");
        assert_eq!(strip_stage_directions("*叹气*好吧"), "好吧");
        assert_eq!(strip_stage_directions("【小声】其实我也不知道"), "其实我也不知道");
        // 整句只有描述 → 空串(调用侧跳过该句)
        assert_eq!(strip_stage_directions("（摊手）"), "");
    }

    #[test]
    fn stage_directions_conservative() {
        // 未闭合(被 segmenter 从逗号切开)不剥——宁漏勿误砍
        assert_eq!(strip_stage_directions("（笑着摇摇头，"), "（笑着摇摇头，");
        // 超长括号段(>16 字)当正文保留
        let long = "（这是一个远超十六个字符上限的很长很长的括号内容）好";
        assert_eq!(strip_stage_directions(long), long);
        // 孤立星号不吞正文
        assert_eq!(strip_stage_directions("3*5等于15"), "3*5等于15");
        // 无包裹正常句无损
        assert_eq!(strip_stage_directions("哈哈，那倒是。"), "哈哈，那倒是。");
    }

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

    #[test]
    fn stop_only_swallows_pure_hotword() {
        let words = parse_hotwords(None);
        // 纯急停词(含标点/空白变体)→ 吞
        assert!(is_stop_only(&words, "停"));
        assert!(is_stop_only(&words, "停。"));
        assert!(is_stop_only(&words, " 别说了！"));
        // 显式扩充词(生产 env 形态:默认表+停止+不说了)
        let extended = parse_hotwords(Some("停,停止,别说了,不说了,闭嘴,安静"));
        assert!(is_stop_only(&extended, "停止"));
        assert!(is_stop_only(&extended, "不说了。"));
    }

    #[test]
    fn exit_words_swallow_pure_and_keep_mixed() {
        let exits = parse_hotwords_with(None, DEFAULT_EXIT_HOTWORDS);
        // 纯退出词(含标点/空白变体)→ 吞(防幽灵回答轮;退出动作归 Android)
        assert!(is_stop_only(&exits, "再见"));
        assert!(is_stop_only(&exits, "不聊了。"));
        assert!(is_stop_only(&exits, " 我要睡觉了！"));
        assert!(is_stop_only(&exits, "退出对话"));
        assert!(is_stop_only(&exits, "不用了"));
        // Phase 1a 语气词前缀(2026-08-19):剥后完整命中才吞
        assert!(is_stop_only(&exits, "嗯退出"));
        assert!(is_stop_only(&exits, "那退出"));
        assert!(is_stop_only(&exits, "嗯嗯退出"));
        assert!(is_stop_only(&exits, "好，再见"));
        // 剥后非完整退出词=不吞(子串纪律)
        assert!(!is_stop_only(&exits, "嗯你好呀"));
        assert!(!is_stop_only(&exits, "好的呀"));
        // 混合句不吞(正常成轮)
        assert!(!is_stop_only(&exits, "再见了我的朋友这首歌放一下"));
        assert!(!is_stop_only(&exits, "退出这个游戏之后干嘛"));
        // 与急停表互不串:「停」不在退出表
        assert!(!is_stop_only(&exits, "停"));
        // env 显式空=禁用
        assert!(parse_hotwords_with(Some(""), DEFAULT_EXIT_HOTWORDS).is_empty());
    }

    #[test]
    fn stop_only_keeps_mixed_and_normal() {
        let words = parse_hotwords(None);
        // 混合句(急停词+新指令)不吞——精确匹配保护
        assert!(!is_stop_only(&words, "停，换个故事"));
        assert!(!is_stop_only(&words, "别说了，我们玩个游戏吧"));
        // 普通句不吞
        assert!(!is_stop_only(&words, "一加一等于几"));
        // 白名单禁用(空集)恒不吞
        assert!(!is_stop_only(&parse_hotwords(Some("")), "停"));
    }
}
