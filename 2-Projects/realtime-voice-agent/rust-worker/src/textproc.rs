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

/// B23 产品首句 v1：文本去空白/标点后只剩唤醒词「小可」×1～3 → 纯唤醒，不算任务
/// （端侧本地 greet；worker 不进 LLM/TTS/垫句，不重复招呼）。带任何其它字都算任务。
pub fn is_wake_only(text: &str) -> bool {
    matches!(normalize_utterance(text).as_str(), "小可" | "小可小可" | "小可小可小可")
}

/// 退出词吞句集默认表(2026-08-17 川哥拍板,与 Android SESSION_EXIT 合同词表一致——
/// 联调 v2 §一.4/5:codex 现有 5 词+扩充 4 词+睡觉类 3 词)。Worker 只吞轮次防幽灵回答,
/// 回复/关房 100% 归 Android(退出权威不变)。
pub const DEFAULT_EXIT_HOTWORDS: &str =
    "不聊了,我不想聊了,再见,拜拜,退出对话,退出,结束,结束聊天,我要睡觉了,我去睡觉了,我要休息了";

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

/// A close command must consume the whole utterance. The configurable table
/// owns exact phrases; the legacy tail path accepts only direct command prefixes.
/// Never search for a close word inside a story, quotation or follow-up request.
pub fn session_exit_path(
    hotwords: &HashSet<String>, text: &str, tail_match: bool,
) -> Option<&'static str> {
    if is_stop_only(hotwords, text) {
        return Some("exact");
    }
    if tail_match {
        return session_exit_tail_hit(text).map(|w|
            if is_fragment_exit_word(w) { "fragment" } else { "tail" });
    }
    None
}

/// A partial configured close phrase may suppress speculative generation only.
/// It never authorizes a close: that still requires the final/committed whole
/// utterance. A later ordinary continuation immediately leaves this prefix set.
pub fn session_exit_speculation_blocked(hotwords: &HashSet<String>, text: &str, tail_match: bool) -> bool {
    if session_exit_path(hotwords, text, tail_match).is_some() { return true; }
    let t = normalize_utterance(text);
    !t.is_empty() && hotwords.iter().any(|w| w.starts_with(&t))
}

#[cfg(test)]
mod close_speculation_tests {
    use super::*;
    #[test]
    fn incomplete_close_never_opens_an_answer_or_closes_the_room() {
        let words = parse_hotwords_with(Some("小可你闭嘴,不聊了小可,别说话"), "");
        for t in ["小可你闭", "不聊了小", "别说"] {
            assert!(session_exit_speculation_blocked(&words, t, true), "{t}");
            assert!(session_exit_path(&words, t, true).is_none(), "{t}");
        }
        for t in ["", "小可你觉得怎么样", "别说话是什么意思", "不聊了小可是什么意思", "停一下直接告诉我3+5等于几"] {
            assert!(!session_exit_speculation_blocked(&words, t, true), "{t}");
            assert!(session_exit_path(&words, t, true).is_none(), "{t}");
        }
    }
}

fn direct_exit_prefix(mut prefix: &str) -> bool {
    // Long forms first. These are command wrappers, not arbitrary substrings.
    // Keep the previously verified compound/ASR forms without accepting
    // "他说退出" or "故事里的小可退出" as instructions to this assistant.
    const PREFIXES: &[&str] = &[
        "今天就到这里", "不想聊你", "不想聊了", "不想聊天", "不想聊",
        "小可", "我们", "现在", "今天", "好的", "好吧", "麻烦",
        "我", "要", "想", "请", "先", "就", "好", "那", "嗯", "哎", "啊", "哦", "行",
    ];
    for _ in 0..12 {
        if prefix.is_empty() { return true; }
        let Some(rest) = PREFIXES.iter().find_map(|p| prefix.strip_prefix(p)) else {
            return false;
        };
        prefix = rest;
    }
    prefix.is_empty()
}

/// 尾部强意图退出词(A 案 2026-08-28,「不想聊了，退出吧」漏网实证 room=…1787897185):
/// 自然复合句永远不等于词表原子,整句精确匹配对其结构性免疫;且 ASR 错转「聊了→聊你」
/// 连子串包含都救不了「不想聊了」——能稳定存活的是**句尾的意图核心词**。
/// 只收误伤面可控的强意图词:「结束」「不用了」这类日常陈述高频词不进尾表
/// (「这个游戏结束」≠退出)。命中会结束整个会话,故只允许完整命令前缀,
/// 不接受任意叙事前文或引用;具体词库仍由后台统一发布。
/// ⚠️ 长词优先序是正确性约束不是美观:「我不想聊了」必须先中「不想聊了」——
/// 若先中「不聊了」,前窗「不想」的「想」会被否定豁免误放(护栏用例 tail_hits 首条)。
const STRONG_EXIT_TAILS: &[&str] = &[
    "退出对话", "结束聊天", "结束对话", "不想聊了", "我要睡觉了", "去睡觉了", "我要休息了",
    // 「不想聊」(无了)——2026-08-28 14:47 真机第三形态:「不想聊了，退出吧」被 EOU 在逗号
    // 停顿处切半,前半提交成「我不想聊」(尾表当时只有带「了」形态),后半「退出吧」被
    // ASR 上游整段丢弃(短段丢弃老病,日志零痕迹)。「××我不想聊」误伤=沉默一轮,可接受。
    "不想聊天", "不想聊",
    "不聊了", "退出", "再见", "拜拜",
];

/// 尾部语气助词(逐层剥离,每层剥 1 字后重查——「退出吧」「再见啦」「睡觉了哈」)。
/// 「了」必须在表里(「我要退出了」),但查序=先查原句再剥,故「不聊了」原句即中不受剥损。
const TAIL_MODAL: &[char] = &[
    '吧', '呀', '啦', '哦', '咯', '喽', '呗', '嘛', '哈', '啊', '哟', '呢', '了',
];

/// 疑问豁免:句里带疑问语素=在**问**退出而不是**要**退出(「怎么退出」「要不要退出」「退出吗」)。
const QUESTION_MARKERS: &[&str] = &[
    "怎么", "如何", "为什么", "什么", "吗", "能不能", "可不可以", "要不要", "还是",
];

/// 否定豁免:命中词前方 3 字窗(「我不想退出」「别退出」「不是不聊了」,以及否定词与
/// 意图词隔一个动词的「不要**说**再见」——v140 合同 §2 负向向量,紧邻 2 字窗够不到)。
/// 判据:窗内 contains 双字否定词任一,或窗末字为单字否定。裸「不」不做 contains
/// (太宽:「不散再见」会误豁免),只认末字紧邻形态。
/// hit_start 为 normalize 串内的字节偏移(由 ends_with 推得,必为合法边界)。
fn negated_before(s: &str, hit_start: usize) -> bool {
    let prefix: Vec<char> = s[..hit_start].chars().collect();
    let n = prefix.len();
    if n >= 1 && matches!(prefix[n - 1], '不' | '别' | '没') {
        return true;
    }
    let window: String = prefix[n.saturating_sub(3)..].iter().collect();
    const NEG2: &[&str] = &["不想", "不要", "不用", "不许", "不准", "没有", "不是", "先不", "别再"];
    NEG2.iter().any(|neg| window.contains(neg))
}

/// A 案尾部退出判定(2026-08-28 川哥拍板):normalize 后逐层剥尾部语气词(至多 3 层),
/// 每层查「以强意图退出词结尾」,命中再过否定豁免;疑问豁免对整句先行。
/// 只用于 exit 吞句路径(急停词纪律不变);开关 EXIT_TAIL_MATCH(默认开,置 0 回退纯精确)。
pub fn is_session_exit_tail(text: &str) -> bool {
    session_exit_tail_hit(text).is_some()
}

/// 同上但返回命中的强意图词(v140 信令的 path=tail|fragment 分桶需要知道命中了谁)。
pub fn session_exit_tail_hit(text: &str) -> Option<&'static str> {
    let s = normalize_utterance(text);
    if s.is_empty() {
        return None;
    }
    for q in QUESTION_MARKERS {
        if s.contains(q) {
            return None;
        }
    }
    let mut t = s;
    for _ in 0..=3 {
        for w in STRONG_EXIT_TAILS {
            if t.ends_with(w) {
                if negated_before(&t, t.len() - w.len()) {
                    return None;
                }
                if direct_exit_prefix(&t[..t.len() - w.len()]) {
                    return Some(w);
                }
            }
        }
        let Some(c) = t.chars().last() else { break };
        if !TAIL_MODAL.contains(&c) {
            break;
        }
        t.truncate(t.len() - c.len_utf8());
    }
    None
}

/// v140 合同 §2/§3:「不想聊/不想聊天」是 EOU 碎片形态词(整句即意图核心,非句尾附着)
/// ——信令 path 标 fragment,与 tail(复合句尾部命中)分桶。与 Android exact 新增四词对应
/// (我方 normalize+剥人称前缀后核心即此二词)。
pub fn is_fragment_exit_word(w: &str) -> bool {
    matches!(w, "不想聊" | "不想聊天")
}

/// v140 信令 reply_kind 三态映射(合同 §4.1 冻结枚举):Android 按此挑本地告别音。
/// 判据用 normalize 后全文 contains——exact 路径拿不到命中词,全文判对三路统一适用。
pub fn exit_reply_kind(text: &str) -> &'static str {
    let s = normalize_utterance(text);
    if s.contains("睡觉") || s.contains("休息") || s.contains("晚安") {
        "night"
    } else if s.contains("再见") || s.contains("拜拜") || s.contains("回见") || s.contains("下次见") {
        "goodbye"
    } else {
        "general"
    }
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

/// 本地音频回声对撞的模糊命中率(2026-09-01「刚打了个盹儿」幽灵轮实证):
/// LCS(needle, hay) / len(needle)。回声经声学路径只会**掉字**不会加字,故三次实证形态
/// 全是「文案的子序列」——掉头(「来啦来啦，」)、掉中间(「这儿」→「这」)都被 LCS 兜住,
/// 严格子串匹配兜不住第二种。char 级 DP,needle=ASR commit(≤~30字)、hay=文案(≤80字),
/// 计算量 ~2400 cell 可忽略。
/// 本地音频回声对撞分层判定(2026-09-01 00:53 实证补层):EOU 会把回声切成任意短碎片
/// ——「来啦来啦，刚打了个盹儿」被切成「来啦」(2字)+「刚打了个盹儿」(6字)两个 commit,
/// 后者被 LCS 门拦住、前者穿过 len≥4 下限起了幽灵轮。分层:
/// - ≥4 字:LCS≥0.8(容识别掉字——「我在这等你呢」掉中间「儿」形态);
/// - 2..3 字:**精确连续子串**(短串上模糊匹配误伤面大;切分碎片必是文案连续段,
///   识别掉字在 2-3 字窗里罕见,精确判定够用且零误伤——「你好」不是任何招呼语子串);
/// - 1 字:不对撞(语气单字太泛,交给急停/打断原有链路)。
/// 返回命中条目的 slot。
pub fn local_audio_echo_hit<'a>(commit_norm: &str, bank: &'a [(String, String)]) -> Option<&'a str> {
    let n = commit_norm.chars().count();
    if n >= 4 {
        bank.iter()
            .find(|(_, t)| lcs_char_ratio(commit_norm, t) >= 0.8)
            .map(|(slot, _)| slot.as_str())
    } else if n >= 2 {
        bank.iter()
            .find(|(_, t)| t.contains(commit_norm))
            .map(|(slot, _)| slot.as_str())
    } else {
        None
    }
}

/// B68 §3.2:开场回声门(单字规则 + 本地音频词库)的**共同入口**——两条规则与控制出口豁免放在
/// 同一个函数里,调用方必须显式传入 `control_outlet`,绕不过去(同 B53 `caption_gate::mark_echo_drop`
/// 的形状:不变量在被调方,不在调用点补 `if`)。
///
/// 返回 `Some(slot)` = 判回声(`"single-char"` 或命中的词槽名),调用方吞句不成轮;`None` = 放行,
/// 交给后面的 STOP/EXIT/设备命令/LLM 裁决。
///
/// 不变量:`control_outlet.is_some()`(已被 [`crate::caption_gate::control_outlet_kind`] 分类为
/// 急停/退出/设备命令)→ **永不**返回 `Some`,单字也不例外。
///
/// 为什么单字规则要搬进来(B63 §7.2 / B68 §3.1):此前 `n_chars == 1` 写在 `pipeline.rs` 的函数外、
/// 命中即 `return`,STOP/EXIT 出口排在它**后面**根本走不到——开场 15 秒内真人说「停」,字幕发了但
/// paused 的在途轮不停、假打断超时后续播;词库日后若放进 farewell,「再见」同样会被吞掉退出。
/// 单字规则的原始动机(EOU+错转可产出任意单字,开场窗内单字成句语义≈0)对**非控制**单字继续成立。
pub fn opening_echo_verdict<'a>(
    commit_norm: &str,
    bank: &'a [(String, String)],
    control_outlet: Option<&'static str>,
) -> Option<&'a str> {
    if control_outlet.is_some() {
        return None;
    }
    if commit_norm.chars().count() == 1 {
        return Some("single-char");
    }
    local_audio_echo_hit(commit_norm, bank)
}

/// Search result acknowledgments may arrive inside the local greeting window.
/// The caller supplies the session-scoped decision (result active + first PCM +
/// exact acknowledgment + input ended), never a word-only exemption.
pub fn opening_echo_with_search_ack<'a>(
    commit_norm: &str,
    bank: &'a [(String, String)],
    control_outlet: Option<&'static str>,
    search_ack: bool,
) -> Option<&'a str> {
    if search_ack {
        return None;
    }
    opening_echo_verdict(commit_norm, bank, control_outlet)
}

pub fn lcs_char_ratio(needle: &str, hay: &str) -> f32 {
    let a: Vec<char> = needle.chars().collect();
    let b: Vec<char> = hay.chars().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut prev = vec![0u16; b.len() + 1];
    let mut cur = vec![0u16; b.len() + 1];
    for &ca in &a {
        for (j, &cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb {
                prev[j] + 1
            } else {
                prev[j + 1].max(cur[j])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    f32::from(prev[b.len()]) / a.len() as f32
}

/// 开场重叠窗放宽门(2026-09-06 0006 实证):动态招呼语 2.1–2.8 s 长过 wake→input_ready(~1.8 s),
/// 尾巴被 ASR 听到并错转——「我想啊怎么了」(←嘿我醒啦今天想玩什么,LCS 0.50)、「不行了」(←你来了故事继续,
/// LCS 0.33)穿过 0.8 门起幽灵轮/打断在播回复。字符相似度对错转结构性偏低,只能在「这句说完时招呼语可能
/// 还没播完」的时间锚内放宽:≥2 字且 LCS≥0.3 即判回声。锚外维持 local_audio_echo_hit;命令词/急停/退出词
/// 由调用方先排除。已知代价:锚内说「讲个故事」(LCS 0.5 vs 你来了故事继续)会被吞——招呼语还在播时开口,重说一次。
pub const LOCAL_AUDIO_OVERLAP_LCS: f32 = 0.3;

pub fn local_audio_echo_overlap_hit<'a>(commit_norm: &str, bank: &'a [(String, String)]) -> Option<(&'a str, f32)> {
    if commit_norm.chars().count() < 2 {
        return None;
    }
    bank.iter()
        .map(|(slot, t)| (slot.as_str(), lcs_char_ratio(commit_norm, t)))
        .filter(|(_, r)| *r >= LOCAL_AUDIO_OVERLAP_LCS)
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
}

/// 开场重叠窗决策(纯函数,编排层唯一入口):commit 前见过 VAD 起点 → 永不判回声(真人话);deadline None
/// (非设备房/门关闭/SN 在例外表)→ 不判;说完时刻晚于截止 → 不判;否则按 local_audio_echo_overlap_hit。
/// 命令/急停/退出豁免由调用方在此之前判。
pub fn opening_overlap_decision<'a>(
    deadline_ms: Option<i64>,
    speech_end_ms: i64,
    vad_onset_seen_before_commit: bool,
    commit_norm: &str,
    bank: &'a [(String, String)],
) -> Option<(&'a str, f32)> {
    if !overlap_vadless_qualifies(vad_onset_seen_before_commit) {
        return None;
    }
    let deadline = deadline_ms?;
    if speech_end_ms > deadline {
        return None;
    }
    local_audio_echo_overlap_hit(commit_norm, bank)
}

/// 开场重叠窗的「无 VAD 起点」判据(2026-09-07 真机实证,普适、不依赖 APK 版本/SN 表):
/// 昨天两条真实幽灵句(「不行了」「我想啊怎么了」)的 worker journal 里**没有 VadEvent::SpeechStart**——招呼语尾巴电平
/// 低于 VAD 门(prob≥0.6 且 ≥150ms),只有 ASR(自带更灵敏的端点检测)把它转成 final;今早三句真人话(起点 +51/+104/+674ms)
/// 全部触发了 VAD。所以「本会话第 1 句 commit 前从未出现 VAD 起点」才是回声尾巴的物理签名;有 VAD 起点的第 1 句一律
/// 不进放宽分支。v3 的「起点 ≤450ms」判据方向反了(真人早开口 +51ms 就命中,幽灵句反而永不命中),已废。
pub fn overlap_vadless_qualifies(vad_onset_seen_before_commit: bool) -> bool {
    !vad_onset_seen_before_commit
}

/// 设备房名 `sn-<SN>-<unix 秒>`(server 建房时刻≈唤醒时刻,量化到秒)→ unix 秒;非设备房/无法解析 None。
pub fn room_unix_secs(room_name: &str) -> Option<i64> {
    if !room_name.starts_with("sn-") {
        return None;
    }
    let (_, ts) = room_name.rsplit_once('-')?;
    ts.parse::<i64>().ok().filter(|v| *v > 1_600_000_000)
}

/// 招呼语最晚播完时刻(unix ms):建房秒向下量化 +1000 补量化 + 最长招呼语时长 + 500 ms 余量。
pub fn opening_overlap_deadline_ms(room_secs: i64, greeting_max_ms: u64) -> i64 {
    room_secs * 1000 + 1000 + greeting_max_ms as i64 + 500
}

#[cfg(test)]
mod tests {
    #[test]
    fn b23_wake_only_variants() {
        for t in ["小可小可", "小可小可。", "小可，小可", " 小可小可 ", "小可", "小可小可小可！", "小可小可，"] {
            assert!(super::is_wake_only(t), "{t}");
        }
    }
    #[test]
    fn b23_wake_plus_content_is_task() {
        for t in ["小可小可帮我测试一下", "小可小可小可小可", "", "你好", "小可在吗", "小可小可打开灯"] {
            assert!(!super::is_wake_only(t), "{t}");
        }
    }
    use super::*;

    /// 本地音频回声对撞正负锚(2026-09-01)。正锚=三次真机实证的实际掉字形态;
    /// 负锚=正常话/退出词不被误吞(退出词误吞=吞掉真实退出意图,代价最高的误伤)。
    #[test]
    fn lcs_local_audio_echo_anchors() {
        // 正锚 1(2026-09-01 实证):掉头形态——「来啦来啦，」整段丢
        assert!(lcs_char_ratio("刚打了个盹儿", "来啦来啦刚打了个盹儿") >= 0.8);
        // 正锚 2(2026-08-28 实证):掉头+掉中间(「嘿」「儿」丢)——严格子串兜不住这形态
        assert!(lcs_char_ratio("我在这等你呢", "嘿我在这儿等你呢") >= 0.8);
        // 负锚:正常问句/退出词/告别词对招呼语文案全部低于阈值
        assert!(lcs_char_ratio("今天天气怎么样", "来啦来啦刚打了个盹儿") < 0.8);
        assert!(lcs_char_ratio("不想聊了", "来啦来啦刚打了个盹儿") < 0.8);
        assert!(lcs_char_ratio("拜拜了", "嘿我在这儿等你呢") < 0.8);
        // 边界:空串
        assert_eq!(lcs_char_ratio("", "来啦"), 0.0);
        assert_eq!(lcs_char_ratio("来啦", ""), 0.0);
    }

    /// 分层判定锚(2026-09-01 00:53 实证「来啦」穿门后补):短碎片精确子串层。
    #[test]
    fn local_audio_echo_hit_layers() {
        let bank = vec![
            ("greeting.normal".to_string(), "来啦来啦刚打了个盹儿".to_string()),
            ("greeting.presence_return".to_string(), "嘿我在这儿等你呢".to_string()),
        ];
        // ≥4 字层:LCS(掉字容错)
        assert_eq!(local_audio_echo_hit("刚打了个盹儿", &bank), Some("greeting.normal"));
        assert_eq!(local_audio_echo_hit("我在这等你呢", &bank), Some("greeting.presence_return"));
        // 2-3 字层:精确连续子串(00:53 实证碎片)
        assert_eq!(local_audio_echo_hit("来啦", &bank), Some("greeting.normal"));
        assert_eq!(local_audio_echo_hit("盹儿", &bank), Some("greeting.normal"));
        // 2-3 字负锚:非子串短句放行(真人短句不误吞)
        assert_eq!(local_audio_echo_hit("你好", &bank), None);
        assert_eq!(local_audio_echo_hit("讲故事", &bank), None);
        // 1 字放行(语气单字)
        assert_eq!(local_audio_echo_hit("嗯", &bank), None);
        assert_eq!(local_audio_echo_hit("啦", &bank), None);
        // ≥4 字负锚:退出词不误吞
        assert_eq!(local_audio_echo_hit("不想聊了", &bank), None);
        // 空库(fail-open 拉取失败态)恒放行
        assert_eq!(local_audio_echo_hit("来啦", &[]), None);
    }

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
        // 纯退出词(含标点/空白变体)→ 关房;泛拒绝不关房
        assert!(is_stop_only(&exits, "再见"));
        assert!(is_stop_only(&exits, "不聊了。"));
        assert!(is_stop_only(&exits, " 我要睡觉了！"));
        assert!(is_stop_only(&exits, "退出对话"));
        assert!(!is_stop_only(&exits, "不用了"));
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
    fn session_exit_tail_hits_natural_compound() {
        // A 案正锚:真机漏网原句(ASR 错转形态)与自然变体
        assert!(is_session_exit_tail("不想聊你退出吧")); // 2026-08-28 room=…1787897185 原句
        assert!(is_session_exit_tail("我不想聊了")); // 长词优先护栏:先中「不想聊了」而非「不聊了」
        assert!(is_session_exit_tail("我不想聊")); // 14:47 真机第三形态:EOU 切半后的前半段
        assert!(is_session_exit_tail("不想聊天啦"));
        assert!(is_session_exit_tail("不想聊了，退出吧"));
        assert!(is_session_exit_tail("退出吧"));
        assert!(is_session_exit_tail("我们不聊了吧"));
        assert!(is_session_exit_tail("今天就到这里再见啦"));
        assert!(is_session_exit_tail("我要退出了"));
        assert!(is_session_exit_tail("小可我去睡觉了哈"));
    }

    /// codex B55 §5-2 点名的长句反锚:问「退出之后怎么再进来」不得真退出。
    /// **单开一个测试函数**是有意的——放进 `session_exit_tail_exemptions_hold` 里,
    /// 会被那支更早的「怎么退出」断言遮蔽,负向验证时先红的是别人,这条等于没验过。
    #[test]
    fn exit_tail_does_not_fire_on_question_about_reentry() {
        assert!(!is_session_exit_tail("退出后告诉我怎么进入"));
        assert_eq!(session_exit_tail_hit("退出后告诉我怎么进入"), None);
        // 正锚:同一函数对真退出句仍然命中,否则上面两条 None 只证明「函数恒返回 None」
        assert_eq!(session_exit_tail_hit("不想聊了，退出吧"), Some("退出"));
    }

    #[test]
    fn session_exit_tail_exemptions_hold() {
        // 否定豁免:误吞它们=把「还想聊」当退出处理
        assert!(!is_session_exit_tail("我不想退出"));
        assert!(!is_session_exit_tail("别退出"));
        assert!(!is_session_exit_tail("先不退出吧"));
        assert!(!is_session_exit_tail("不是不聊了"));
        // 疑问豁免:在问退出不是要退出
        assert!(!is_session_exit_tail("怎么退出"));
        assert!(!is_session_exit_tail("要不要退出"));
        assert!(!is_session_exit_tail("退出吗"));
        // 尾部不是意图词=不吞(核心词在句中不算——只认句尾)
        assert!(!is_session_exit_tail("退出这个游戏之后干嘛"));
        assert!(!is_session_exit_tail("再见了我的朋友这首歌放一下"));
        // 「结束」「不用了」不在尾表(日常陈述高频,误伤面大)
        assert!(!is_session_exit_tail("这个游戏结束"));
        assert!(!is_session_exit_tail("今天不用了"));
        assert!(!is_session_exit_tail(""));
    }

    #[test]
    fn exit_signal_path_and_reply_kind() {
        // tail_hit 返回命中词 → fragment/tail 分桶(v140 §2 行为向量)
        assert_eq!(session_exit_tail_hit("不想聊了，退出吧"), Some("退出"));
        assert!(!is_fragment_exit_word("退出")); // 复合句尾部命中 → tail
        assert_eq!(session_exit_tail_hit("我不想聊"), Some("不想聊"));
        assert!(is_fragment_exit_word("不想聊")); // EOU 碎片 → fragment
        assert_eq!(session_exit_tail_hit("我不想聊这个话题"), None); // 合同负向:不得误判
        assert_eq!(session_exit_tail_hit("不要说再见"), None); // 合同负向:否定豁免
        // reply_kind 三态(合同 §4.1 冻结枚举)
        assert_eq!(exit_reply_kind("再见"), "goodbye");
        assert_eq!(exit_reply_kind("拜拜啦"), "goodbye");
        assert_eq!(exit_reply_kind("我要睡觉了"), "night");
        assert_eq!(exit_reply_kind("不想聊了，退出吧"), "general");
        assert_eq!(exit_reply_kind("我不想聊"), "general");
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

#[cfg(test)]
mod overlap_tests {
    use super::*;

    fn bank() -> Vec<(String, String)> {
        // 0006 现役对撞库(9 内置 + 6 动态,normalize 后形态)
        [
            "哎你好呀", "嗯呐我在呢", "来啦想聊点啥", "来啦", "哎来啦来啦", "嗨我在呢", "哟你来啦", "哎哟是你呀",
            "嗨嗨等你好久啦", "嘿来啦", "亮起来咯", "在呢在呢聊点啥好呀", "嘿我醒啦今天想玩什么", "回来啦一起玩吧",
            "你来了故事继续",
        ]
        .iter()
        .map(|t| ("greeting.x".to_string(), (*t).to_string()))
        .collect()
    }

    #[test]
    fn overlap_hits_0006_ghost_fragments() {
        let b = bank();
        let (_, r) = local_audio_echo_overlap_hit("我想啊怎么了", &b).expect("我想啊怎么了 应命中");
        assert!((r - 0.5).abs() < 0.01, "lcs={r}");
        let (_, r) = local_audio_echo_overlap_hit("不行了", &b).expect("不行了 应命中");
        assert!(r >= LOCAL_AUDIO_OVERLAP_LCS && r < 0.34, "lcs={r}");
    }

    #[test]
    fn overlap_passes_real_early_commits() {
        let b = bank();
        for t in ["虚像调到5米", "画面调近一点", "测试一测试一下你说个长句", "唱首歌", "开灯"] {
            assert!(local_audio_echo_overlap_hit(t, &b).is_none(), "{t} 不该被判回声");
        }
    }

    #[test]
    fn overlap_single_char_and_empty_bank_none() {
        assert!(local_audio_echo_overlap_hit("嗯", &bank()).is_none());
        assert!(local_audio_echo_overlap_hit("我想啊怎么了", &[]).is_none());
    }

    #[test]
    fn room_secs_parse() {
        assert_eq!(room_unix_secs("sn-BJP00326070804800006-1788690141"), Some(1_788_690_141));
        assert_eq!(room_unix_secs("web-abc-1788690141"), None);
        assert_eq!(room_unix_secs("sn-BJP00326070804800006-notnum"), None);
        assert_eq!(room_unix_secs("sn-BJP00326070804800006-12"), None);
    }

    /// codex v237 §7.3 反例(编排负向)+ 今早真人早开口样本:有 VAD 起点的第 1 句永不进 swallowed(不再靠例外表);
    /// 昨日两条真实幽灵句(无 VAD 起点)正向保留。
    #[test]
    fn v237_first_sentence_after_ready_not_swallowed_when_skipped() {
        let b = bank();
        let t = 1_788_690_000i64;
        let deadline = opening_overlap_deadline_ms(t, 3200); // = t*1000 + 4700
        assert_eq!(deadline, t * 1000 + 4700);
        // 真人早开口(今早实证 +51/+104ms 也有 VAD 起点):有 VAD 起点 → 即使窗内、即使 LCS 0.5 也永不判回声
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 4000, true, "讲个故事", &b).is_none());
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 2050, true, "我想啊怎么了", &b).is_none());
        // 无 VAD 起点 + 窗内 + 相似:会被吞(已知向量:真人太轻没触发 VAD 且句子像招呼语)
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 4000, false, "讲个故事", &b).is_some());
        // 例外表/门关闭(deadline=None):永不判回声
        assert!(opening_overlap_decision(None, t * 1000 + 4000, false, "讲个故事", &b).is_none());
        // 说完时刻晚于截止:不判
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 4701, false, "我想啊怎么了", &b).is_none());
        // 昨日两条真实幽灵句(无 VAD 起点、窗内):正向保留
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 2050, false, "我想啊怎么了", &b).is_some());
        assert!(opening_overlap_decision(Some(deadline), t * 1000 + 1320, false, "不行了", &b).is_some());
    }

    /// 无 VAD 起点判据(真机样本):幽灵句 commit 前无 VAD 起点 → 进;真人话(今早 +51/+104/+674ms 均有 VAD 起点)→ 不进。
    #[test]
    fn vadless_predicate_from_real_samples() {
        assert!(overlap_vadless_qualifies(false), "昨日幽灵句「不行了」「我想啊怎么了」:journal 无 UserSpeechStarted");
        assert!(!overlap_vadless_qualifies(true), "今早「说个长句介绍一下」起点 +51ms、「长句继续测试一下」+104ms:有 VAD 起点,真人");
    }

    #[test]
    fn deadline_arith() {
        assert_eq!(opening_overlap_deadline_ms(1_788_690_141, 3200), 1_788_690_141 * 1000 + 1000 + 3200 + 500);
    }
}

/// B68 §4 矩阵里能落到纯函数层的行(控制出口 vs 开场回声门)。
/// 穿过真正 `on_tick_inner` 的用例本轮做不到:`Orchestrator` 是 ~100 个字段的活对象
/// (Room / mpsc / JoinHandle / OutputGate),单测构造不出;调用点靠源码行号 + 负向注入交代(B69 回执)。
#[cfg(test)]
mod opening_echo_verdict_tests {
    use super::*;
    use crate::caption_gate::control_outlet_kind;

    fn outlet(text: &str) -> Option<&'static str> {
        let stops = parse_hotwords_with(None, DEFAULT_INTERRUPT_HOTWORDS);
        let exits = parse_hotwords_with(None, DEFAULT_EXIT_HOTWORDS);
        control_outlet_kind(text, &stops, &exits, true)
    }

    /// 词库形态 = pipeline 里 `normalize_echo` 之后(去标点);三条是 2026-09-01 / 09-06 真机实证文案。
    fn greeting_bank() -> Vec<(String, String)> {
        vec![
            ("greeting.nap".into(), "来啦来啦刚打了个盹儿".into()),
            ("greeting.wait".into(), "嘿我在这儿等你呢".into()),
            ("greeting.story".into(), "你来了故事继续".into()),
        ]
    }

    #[test]
    fn r15_search_result_ack_survives_opening_single_char_echo_gate() {
        use crate::search_dialogue::{classify_search_ack, SearchAckDecision, SearchPlaybackContext};
        for (active, pcm, speaking) in [(true,true,false),(false,true,false),(true,false,false),(true,true,true)] {
            let ctx = SearchPlaybackContext { result_active: active, first_pcm_seen: pcm, input_continues: speaking };
            for text in ["对", "哦", "嗯"] {
                let ack = classify_search_ack(true,text,&ctx)==SearchAckDecision::ContinueResult;
                let expected = if active && pcm && !speaking { None } else { Some("single-char") };
                assert_eq!(opening_echo_with_search_ack(text,&greeting_bank(),None,ack),expected,
                    "text={text}, active={active}, pcm={pcm}, speaking={speaking}");
            }
        }
        let ctx = SearchPlaybackContext { result_active:true, first_pcm_seen:true, input_continues:false };
        for text in ["那", "停", "退出", "取消搜索", "改查火星", "我想聊", "嗯我想聊小猫"] {
            let ack = classify_search_ack(true,text,&ctx)==SearchAckDecision::ContinueResult;
            assert!(!ack,"controls and complete new topics must keep their normal path");
            assert_eq!(opening_echo_with_search_ack(text,&greeting_bank(),outlet(text),ack),
                opening_echo_verdict(text,&greeting_bank(),outlet(text)));
        }
    }

    /// B61 提过的形态:日后若把 farewell.* 放进库,「再见」就是这条的精确子串。
    fn bank_with_farewell() -> Vec<(String, String)> {
        let mut b = greeting_bank();
        b.push(("farewell.goodbye".into(), "好的再见下次见哦".into()));
        b
    }

    // ── 正锚(矩阵「非控制的既有已知回声」):门没被拆 ──

    #[test]
    fn non_control_single_char_still_swallowed() {
        assert_eq!(outlet("那"), None);
        assert_eq!(opening_echo_verdict("那", &greeting_bank(), outlet("那")), Some("single-char"));
    }

    #[test]
    fn non_control_bank_hits_still_swallowed() {
        let b = greeting_bank();
        assert_eq!(opening_echo_verdict("刚打了个盹儿", &b, None), Some("greeting.nap"), "≥4 字 LCS 层");
        assert_eq!(opening_echo_verdict("来啦", &b, None), Some("greeting.nap"), "2-3 字子串层");
        assert_eq!(opening_echo_verdict("讲个故事吧", &b, None), None, "正常话放行(LCS 0.4 < 0.8)");
    }

    // ── 矩阵行 1/2/3:开场窗内单字「停」必须走到 STOP 出口 ──

    #[test]
    fn stop_single_char_reaches_stop_outlet() {
        assert_eq!(outlet("停"), Some("stop"));
        assert_eq!(opening_echo_verdict("停", &greeting_bank(), outlet("停")), None);
    }

    // ── 矩阵行 4/9:「再见」恰为告别词槽子串 ──

    #[test]
    fn goodbye_in_farewell_bank_reaches_exit_outlet() {
        let b = bank_with_farewell();
        // 先证词库这层**真会命中**——否则下面的 None 可能只是「库里本来就没有」
        assert_eq!(local_audio_echo_hit("再见", &b), Some("farewell.goodbye"));
        assert_eq!(outlet("再见"), Some("exit_exact"));
        assert_eq!(opening_echo_verdict("再见", &b, outlet("再见")), None);
    }

    // ── 矩阵行 5:退出词表与尾句语义不扩不缩,只是不被回声门吞 ──

    #[test]
    fn exit_words_and_tails_never_swallowed_even_if_bank_would_hit() {
        for t in ["退出", "不聊了", "退出对话", "我不想聊了", "不想聊了，退出吧"] {
            let norm = normalize_utterance(t);
            // 把这句本身放进库,保证词库层「必命中」(子串 / LCS 两层都覆盖)
            let b = vec![("self".to_string(), norm.clone())];
            assert!(local_audio_echo_hit(&norm, &b).is_some(), "{t}: 库必命中前提不成立");
            let o = outlet(t);
            assert!(o.is_some(), "{t} 必须是控制出口");
            assert_eq!(opening_echo_verdict(&norm, &b, o), None, "{t}");
        }
    }

    // ── 矩阵行 6:问「怎么重新进入」不是退出,也不因此免检回声 ──

    #[test]
    fn question_about_reentry_is_not_control_and_still_echo_checked() {
        let t = "退出后告诉我怎么重新进入";
        assert_eq!(outlet(t), None);
        let norm = normalize_utterance(t);
        assert_eq!(opening_echo_verdict(&norm, &greeting_bank(), None), None, "正常问句放行到 LLM");
        // 有牙齿:同一句若真在库里(LCS 1.0),非控制 → 照吞
        let b = vec![("g".to_string(), norm.clone())];
        assert_eq!(opening_echo_verdict(&norm, &b, None), Some("g"));
    }

    // ── 不变量的全称形式:出口 Some ⇒ 永不 Some,遍历两张默认词表 ──

    #[test]
    fn control_outlet_is_never_swallowed_over_default_tables() {
        let stops = parse_hotwords_with(None, DEFAULT_INTERRUPT_HOTWORDS);
        let exits = parse_hotwords_with(None, DEFAULT_EXIT_HOTWORDS);
        let mut n = 0;
        for w in stops.iter().chain(exits.iter()) {
            let b = vec![("self".to_string(), w.clone())];
            let o = control_outlet_kind(w, &stops, &exits, true);
            assert!(o.is_some(), "{w}");
            assert_eq!(opening_echo_verdict(w, &b, o), None, "{w}");
            n += 1;
        }
        assert!(n >= 20, "两张默认表合计应 ≥20 词(10+12),实际 {n}");
    }

    // ── 重叠窗(gate B)同样需要 outlet:精确退出词不在尾表也不在命令表 ──

    #[test]
    fn overlap_gate_preserves_explicit_exit_but_generic_refusal_is_not_exit() {
        let b = vec![("synthetic".to_string(), "退出".to_string())];
        assert!(opening_overlap_decision(Some(1_000), 900, false, "退出", &b).is_some());
        assert_eq!(outlet("退出"), Some("exit_exact"));
        assert_eq!(outlet("不用了"), None);
    }
}
