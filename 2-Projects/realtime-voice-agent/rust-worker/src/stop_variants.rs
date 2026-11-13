//! Bounded whole-command grammar, not substring/fuzzy matching or an LLM call.
//! A complete command may have address/politeness particles, never arbitrary
//! narration. Partial text only suppresses speculation; it cannot close a room.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent { Close, StopTurn, CancelSearch, ExitListening }

const CLOSE: &[&str] = &[
    "闭嘴", "把嘴闭上", "闭上嘴", "闭上你的嘴", "把你的嘴闭上", "闭上嘴巴", "把嘴巴闭上",
    "不要说", "不用说", "别再说", "不要再说", "不用再说",
    "别说话", "不要说话", "不用说话", "别再说话", "不要再说话",
    "别讲话", "不要讲话", "别再讲话", "不要再讲话",
    "别讲", "不要讲", "不用讲", "别再讲", "不要再讲", "不用再讲",
    "别播报", "不要播报", "不用播报", "停止说话", "停止讲话", "停止回答",
    "停止播报", "停止朗读", "别吵", "不要吵", "别吵我", "不要吵我",
    "别吵吵", "别唠叨", "不要唠叨", "别啰嗦", "不要啰嗦",
    "别叨叨", "不要叨叨", "别说个没完", "不要再开口", "别再开口",
    "别出声", "不要出声",
    // Product decision 2026-11-14: A/B stop-speech phrases close the session.
    // Pure turn-yielding commands (停一下 / 先听我说) remain separate below.
    "别说", "别念", "不要念", "不用念", "别再念", "不要再念", "别读", "不要读",
    "别解释", "不要解释", "不用解释", "别再解释", "不用再解释",
    "安静", "安静点", "安静一点", "保持安静", "bequiet",
    "安静点儿", "安静一点儿", "消停点", "消停点儿", "消停一下", "嘘",
    "先别说", "先不用说", "先不要说", "暂时不要说话", "暂时别说话",
    "不要发声", "别发声", "停止发声", "静音", "把你自己静音", "把自己静音",
    "滚", "够了", "不用了", "不要了", "你休息", "您休息", "休息", "关闭", "关机",
    "我不想听", "我不想听你说", "我不想听你说话", "我不想听你讲",
    "我不想听你讲话", "不想听", "不想听你说", "不想听你说话",
    "我不想再听你念", "我不想再听你读", "我不想再听你解释",
    "不聊", "不聊了", "不想聊", "不想聊了", "我不聊", "我不想聊",
    "我不想和你聊", "我不想跟你聊", "不跟你聊", "不和你聊",
    "退出", "退出对话", "退出聊天", "结束聊天", "结束对话", "结束这次对话",
    "关闭对话", "关闭聊天", "挂断", "挂了", "挂断通话", "退下",
    "聊到这里", "聊到这", "聊到这儿", "到这里", "到这儿", "到此为止",
    "今天就到这里", "今天就到这儿", "今天先聊到这里", "今天先聊到这儿",
    "再见", "拜拜", "回见", "下次聊", "下次再聊", "下次见",
    "我要睡觉", "我要休息", "我去睡觉", "我去休息",
    "我先去忙", "先这样", "不用了再见", "shutup",
];
const STOP_TURN: &[&str] = &[
    "停", "停止", "停下", "停下来", "暂停", "停一停", "停一下", "停会儿", "停一会儿", "停一会",
    "等等", "等一下", "等一等", "等会", "等会儿", "等一会", "等一会儿",
    "暂停回答", "暂停播报", "暂停朗读", "暂停说话", "暂停一下",
    "停止当前回答", "停止当前播报", "停下当前回答", "停下当前播报",
    "听我说", "听我讲", "听我说完", "听我讲完", "让我说", "让我讲",
    "让我说完", "让我讲完", "让我把话说完", "我还没说完", "我还没讲完",
    "听我把话说完", "听我把话讲完",
    "等我说完", "等我讲完", "等我一下", "别打断我", "不要打断我",
    "别插话", "不要插话", "别抢话", "不要抢话", "别抢着说",
    "stop", "pause", "打住", "稍等", "稍等一下", "稍等一会儿",
    "听我说完再说", "等我说完再说", "让我说完再说",
    "停止播放", "暂停播放", "暂停音乐", "停止放歌",
];
const CANCEL_SEARCH: &[&str] = &[
    "取消搜索", "停止搜索", "结束搜索", "取消查询", "停止查询", "结束查询",
    "取消这次搜索", "取消这次查询", "取消刚才的搜索", "取消刚才的查询",
    // The parser retains the task intent; the 2026-11-14 voice policy closes
    // the session for B4, including a bare refusal, before search cancellation.
    "别查", "不要查", "不用查", "不查", "别再查", "不要再查", "不用再查",
    "别搜", "不要搜", "不用搜", "不搜", "别再搜", "不要再搜", "不用再搜",
    "别查了", "不要查了", "不用查了", "不查了", "别再查了", "不要再查了", "不用再查了",
    "别搜了", "不要搜了", "不用搜了", "不搜了", "别再搜了", "不要再搜了", "不用再搜了",
    "别搜索了", "不要搜索了", "不用搜索了", "别查询了", "不要查询了", "不用查询了",
];
const EXIT_LISTENING: &[&str] = &[
    "退出倾听", "退出倾听模式", "结束倾听", "结束倾听模式",
    "结束倾听恢复聊天", "结束倾听模式恢复聊天", "退出倾听恢复聊天", "退出倾听模式恢复聊天", "恢复聊天", "恢复普通聊天",
];
const PREFIXES: &[&str] = &[
    "小可小可", "小可", "我想请你", "我想让你", "我让你", "我要你", "给我", "求你",
    "你能不能", "您能不能", "你可不可以", "您可不可以", "能不能", "可不可以",
    "请你", "请您", "麻烦你", "麻烦您", "拜托你", "拜托您", "麻烦", "拜托",
    "可以", "能", "请", "你", "您", "我们", "咱们", "现在", "暂时", "先", "就",
    "行了", "得了", "够了", "好了", "好啦", "好吧", "好的", "那", "嗯", "哎呀", "哎", "喂", "好",
    "话太多了", "太啰嗦了", "太吵了",
    "我在会议中", "我正在开会", "我在开会", "我在写作业",
];
const SUFFIXES: &[&str] = &[
    "行不行", "好不好", "可以吗", "好吗", "行吗", "小可", "谢谢", "拜托了",
    "了", "吧", "呀", "啦", "啊", "哦", "哈", "呢", "嘛", "呗", "你",
];

fn normalized(text: &str) -> String {
    // Keep quotation marks, colons, and every ordinary word: punctuation alone
    // must not turn a quote, definition, or continuation into a control action.
    text.chars().filter(|c| !c.is_whitespace() && !"，。！？!?.、~～…".contains(*c)).collect()
}

fn core(text: &str) -> Option<Intent> {
    if STOP_TURN.contains(&text) { return Some(Intent::StopTurn); }
    if CANCEL_SEARCH.contains(&text) { return Some(Intent::CancelSearch); }
    if EXIT_LISTENING.contains(&text) { return Some(Intent::ExitListening); }
    if CLOSE.contains(&text) { return Some(Intent::Close); }
    None
}

/// Match the *entire* remaining command, allowing a few discourse particles.
/// Asking how/why, quoting a command, negating it, or appending a new task leaves
/// unmatched material, so no action is produced.
fn command(text: &str, request: bool) -> Option<Intent> {
    let asked = text.strip_suffix(['吗', '么']);
    let mut t = if request || asked.is_some_and(|s| EXIT_LISTENING.contains(&s)) {
        asked.unwrap_or(text)
    } else { text };
    for _ in 0..=5 {
        if let Some(intent) = core(t) { return Some(intent); }
        // Repeated short commands still have to consume the whole utterance.
        for words in [CLOSE, STOP_TURN] {
            for w in words {
                if t.starts_with(w) && t.len() <= w.len()*4 && t.len()%w.len()==0
                    && w.repeat(t.len()/w.len()) == t {
                    return core(w);
                }
                for particle in ["了", "吧", "啊"] {
                    let token = format!("{w}{particle}");
                    if t.starts_with(&token) && t.len() <= token.len()*4
                        && t.len()%token.len()==0 && token.repeat(t.len()/token.len()) == t {
                        return core(w);
                    }
                }
            }
        }
        if let Some(rest) = SUFFIXES.iter().find_map(|s| t.strip_suffix(s)) { t = rest; }
        else { break; }
    }
    // Temporary modifiers keep the chosen product action. B3 now closes;
    // an actual turn-yielding command (停一下) still keeps the room.
    for suffix in ["一下", "一会儿", "一会", "一小会", "一小会儿"] {
        if let Some(rest) = t.strip_suffix(suffix) {
            if core(rest) == Some(Intent::Close) { return Some(Intent::Close); }
            if ["停", "暂停"].contains(&rest) { return Some(Intent::StopTurn); }
        }
    }
    None
}

/// A bounded "N秒/分钟内不要说话" is a stop request under user decision B3.
/// It closes this conversation; it never claims to set a device mute timer.
fn timed_silence(text: &str) -> bool {
    for unit in ["秒内", "分钟内"] {
        let Some((n, rest)) = text.split_once(unit) else { continue };
        if !(1..=3).contains(&n.chars().count()) || !n.chars().all(|c| c.is_ascii_digit() || "零〇一二两三四五六七八九十百".contains(c)) { continue; }
        let rest = rest.strip_prefix("请").unwrap_or(rest);
        let Some(rest) = rest.strip_prefix("不要").or_else(|| rest.strip_prefix('别')) else { continue };
        if ["回应", "说话", "出声", "发声", "讲话"].contains(&rest) { return true; }
    }
    false
}

pub fn intent(text: &str) -> Option<Intent> {
    let t = normalized(text);
    if t.len() > 240 || t.is_empty() { return None; }
    let mut body = t.as_str();
    let mut request = false;
    for _ in 0..=10 {
        if timed_silence(body) { return Some(Intent::Close); }
        if let Some(intent) = command(body, request) {
            return Some(intent);
        }
        // A bounded handoff keeps the action of its leading command.
        for tail in ["我还没说完", "我还没讲完", "听我说", "听我说完", "让我说完", "等我说完", "我来说"] {
            if let Some(head) = body.strip_suffix(tail) {
                if let Some(action @ (Intent::Close | Intent::StopTurn)) = command(head, request) { return Some(action); }
            }
        }
        for tail in ["我们聊点别的", "我们聊别的", "聊点别的", "聊别的吧", "换个话题", "我们继续聊"] {
            if body.strip_suffix(tail).is_some_and(|head| command(head, request) == Some(Intent::CancelSearch)) {
                return Some(Intent::CancelSearch);
            }
        }
        // Two bounded control clauses can strengthen an exit, but a free-form
        // story or follow-up cannot. Do not split on arbitrary keywords.
        for first in ["安静点", "安静一点", "别搜了", "不查了", "不用查了"] {
            if let Some(tail) = body.strip_prefix(first) {
                let tail = tail.strip_prefix('你').unwrap_or(tail);
                if command(tail, request) == Some(Intent::Close) { return Some(Intent::Close); }
            }
        }
        let Some((prefix, rest)) = PREFIXES.iter().find_map(|p| body.strip_prefix(p).map(|rest|(*p, rest))) else { break; };
        request |= prefix.contains('能') || prefix.contains("可以");
        body = rest;
    }
    None
}

/// A plausible unfinished command can block speculative LLM generation only.
/// It never performs stop/close. Normal sentence continuations leave the set.
pub fn possible_prefix(text: &str) -> bool {
    let t = normalized(text);
    if t.is_empty() || t.len() > 240 { return false; }
    let mut body = t.as_str();
    for _ in 0..=10 {
        if !body.is_empty() && CLOSE.iter().chain(STOP_TURN).chain(CANCEL_SEARCH).chain(EXIT_LISTENING)
            .any(|c| c.starts_with(body)) { return true; }
        let Some(rest) = PREFIXES.iter().find_map(|p| body.strip_prefix(p)) else { break; };
        if rest.is_empty() && t.chars().count() >= 2 { return true; }
        body = rest;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn natural_variants_consume_whole_commands_and_keep_scope() {
        for (texts, expected) in [
            (vec!["小可你先闭嘴", "你能不能先别说话了", "可不可以别说话了", "可以别说了吗",
                "别再说了", "行了别讲了", "行了别说了", "拜托你别说了", "闭嘴闭嘴",
                "你给我闭嘴", "闭嘴吧闭嘴吧", "安静点别说话了", "别搜了你闭嘴",
                "退下", "小可退下", "你先退下吧", "别说了", "别说", "先别说了", "暂时不要说话",
                "小可安静点儿", "别念了", "别念了别念了", "别解释了", "别说了我还没说完",
                "得了别讲了", "我不想再听你念了", "请把你自己静音", "我在会议中请不要发声", "五十秒内不要回应"], Intent::Close),
            (vec!["先听我说", "停一下我来说", "哎停停停", "等我说完好吗", "稍等一下", "你先听我把话说完"], Intent::StopTurn),
            (vec!["小可请取消刚才的搜索", "能不能别再搜了", "不要再查了", "别搜了我们聊点别的", "不要查", "不用查", "别搜", "取消刚才的查询我们继续聊"], Intent::CancelSearch),
            (vec!["小可恢复聊天吧", "请结束倾听模式", "退出倾听", "结束倾听恢复聊天", "可以恢复聊天吗", "能不能恢复聊天", "恢复聊天好吗", "退出倾听模式恢复聊天"], Intent::ExitListening),
        ] {
            for t in texts { assert_eq!(intent(t), Some(expected), "{t}"); }
        }
    }
    #[test]
    fn definitions_quotes_negations_and_continuations_are_not_commands() {
        for t in ["小可先听我说一会儿", "小可先听我讲个故事", "退出吗", "别不说话",
            "不要闭嘴", "我不想退出", "你先别退出", "不要取消搜索", "不要结束倾听",
            "老师说请安静", "故事里的小可你先闭嘴", "闭嘴是什么意思", "怎么让你闭嘴",
            "五十秒内不要回应是什么意思", "我说五十秒内不要回应", "我在会议中请不要发声是台词",
            "可以别说了吗是命令吗", "停一下告诉我三加五等于几", "别念了这个词怎么读",
            "小爱同学闭嘴", "精灵退出", "退出小爱", "这里太安静了", "教室里请安静点",
            "先这样做一道题", "先这样然后再见", "这首歌名叫闭嘴", "闭嘴了的小猫叫什么",
            "安静点然后告诉我今天天气", "你别说话是什么意思", "不聊了是歌词", "闭嘴吧不是命令",
        ] { assert_eq!(intent(t), None, "false command {t}"); }
    }
    #[test]
    fn partial_commands_only_block_speculation() {
        for t in ["小可你先闭", "你能不能先", "你能不能先别说话", "先听我", "小可请取消搜"] {
            assert!(possible_prefix(t), "{t}");
        }
        for t in ["", "小可你觉得天气如何", "闭嘴是什么意思", "停一下帮我查天气"] {
            assert!(!possible_prefix(t), "{t}");
        }
        for t in ["小可你先闭", "你能不能先", "小可请取消搜"] { assert_eq!(intent(t), None); }
    }
}
