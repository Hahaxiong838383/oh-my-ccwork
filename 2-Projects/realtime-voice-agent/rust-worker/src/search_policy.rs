//! Pure, bounded search intent routing. No network or foreground model calls.
use std::collections::HashSet;

#[derive(Debug, PartialEq, Eq)]
pub enum Intent { Search(String), Replace(String), Cancel, Resume, Clarify }

fn trim_outer(text: &str) -> &str {
    text.trim().trim_end_matches(|c: char| "。！!？?，,.；; ".contains(c))
}
fn addressed(text: &str) -> &str {
    let mut t = trim_outer(text);
    // Only leading address/filler words. Never remove quoting or negation.
    for _ in 0..4 {
        if let Some(rest) = ["小可小可", "小可", "嗯，", "嗯,", "那个，", "那个,"].iter().find_map(|p| t.strip_prefix(p)) {
            t = rest.trim_start_matches(|c: char| "，,:： ".contains(c));
        } else { break; }
    }
    t
}
fn trim_polite(query: &str) -> &str {
    let q = trim_outer(query);
    for suffix in ["，好不好", ",好不好", "，可以吗", ",可以吗", "，行吗", ",行吗", "，好吗", ",好吗"] {
        if let Some(t) = q.strip_suffix(suffix) { return trim_outer(t); }
    }
    q
}
fn explanation_tail(text: &str) -> bool {
    ["是什么意思", "什么意思", "是什么", "是啥", "啥意思", "是啥意思", "是干什么的", "这个词是什么意思", "这个词啥意思", "这个词是啥意思", "这句话是什么意思"].contains(&text.trim())
}
/// A question about the command itself is chat, including after a pending
/// clarification or an editable keyword rule. A named query still searches.
pub fn search_term_question(text: &str) -> bool {
    let mut t=addressed(text);
    for prefix in ["请帮我", "请", "帮我", "帮忙"] {
        if let Some(rest)=t.strip_prefix(prefix) {t=rest.trim_start();break;}
    }
    ["搜索一下", "查询一下", "查找一下", "搜索", "查询", "查找", "查一下", "查一查", "查查", "搜一下", "搜一搜", "搜搜"]
        .iter().any(|prefix|t.strip_prefix(prefix).is_some_and(explanation_tail))
}
fn task_query(query: &str, replace: bool) -> Option<Intent> {
    let q = trim_polite(query.trim_start_matches(|c: char| "，,:： ".contains(c)));
    // An explanation/quotation of the command is ordinary conversation.
    if explanation_tail(q) { return None; }
    if q.is_empty() || q.chars().count() > 128 || ["吧", "一下", "那个", "这个", "刚才那个", "它", "他", "她", "那件事", "为什么会灭绝", "为什么灭绝"].contains(&q) {
        return Some(Intent::Clarify);
    }
    Some(if replace { Intent::Replace(q.into()) } else { Intent::Search(q.into()) })
}

/// Match a whole request to resume a search result, never a substring or a
/// phonetic guess about the query. Authorization/expiry stay with SearchResume.
fn result_resume(text: &str) -> bool {
    let mut t = text;
    for _ in 0..2 {
        if let Some(rest) = ["麻烦你", "麻烦", "请你", "请", "帮我", "能不能", "嗯"]
            .iter().find_map(|p| t.strip_prefix(p)) {
            t = rest.trim_start_matches(|c: char| "，, ".contains(c));
        } else { break; }
    }
    if let Some(rest) = ["好吗", "可以吗", "吧"].iter().find_map(|s| t.strip_suffix(s)) {
        t = trim_outer(rest);
    }
    // Observed ASR prefix: "从继续…". Also allow one repeated "继续".
    // This is deliberately not a global filler/negation removal rule.
    if let Some(rest) = t.strip_prefix("从继续").or_else(|| t.strip_prefix("继续继续")) {
        return resume_object(rest);
    }
    if let Some(rest) = t.strip_prefix('把') {
        return ["继续说", "继续讲", "继续播", "继续播报", "接着说", "接着讲", "接着播"]
            .iter().any(|s| rest.strip_suffix(s).is_some_and(resume_object));
    }
    ["继续", "继续搜", "继续说", "继续讲", "继续播", "继续播报", "接着说", "接着讲", "接着播"]
        .iter().any(|p| t.strip_prefix(p).is_some_and(resume_object))
}

fn resume_object(text: &str) -> bool {
    ["刚才的搜索结果", "刚才的查询结果", "刚才查到的结果", "刚刚查到的结果", "刚才查的结果", "刚才的搜索", "刚才的查询"]
        .contains(&text)
}

pub fn intent(text: &str) -> Option<Intent> {
    if search_term_question(text) {return None;}
    let t = addressed(text);
    if ["如果", "假如", "例如", "比如"].iter().any(|p| t.starts_with(p)) { return None; }
    if ["，不要真的查", ",不要真的查", "，但不用搜索", ",但不用搜索"].iter().any(|p| t.contains(p)) { return None; }
    if ["搜索引擎", "搜索算法", "搜索功能", "查询功能"].iter().any(|p| t.starts_with(p)) { return None; }
    // Scoped, explicit replacement can supersede a preceding cancellation.
    if let Some((old, new)) = t.split_once('，') {
        if (old.starts_with("不查") || old.starts_with("先别查")) && old.ends_with('了') {
            if let Some(q) = new.trim().strip_prefix("改查") { return task_query(q, true); }
        }
    }
    if let Some((old, new)) = t.split_once("改查") {
        if (old.starts_with("不查") || old.starts_with("先别查")) && old.ends_with('了') { return task_query(new, true); }
    }
    let control = t.strip_suffix('吧').unwrap_or(t);
    if ["别查了", "不用查了", "取消搜索", "停止搜索", "不用查了，取消刚才的搜索", "不用查了取消刚才的搜索", "取消刚才的搜索", "取消刚才的查询", "不用搜索了", "别搜了", "停止查询", "取消查询"].contains(&control)
        || ["不用查了，", "不用查了,", "别查了，", "别查了,"].iter().any(|p| control.starts_with(p))
        // ASR joins clause finals with spaces. Match the explicit cancel clause
        // and a bounded chat handoff, without stripping negation or quotations.
        || ["不用查了", "别查了"].iter().any(|p|control.strip_prefix(p).is_some_and(|tail|
            ["我们聊", "聊"].iter().any(|next|tail.trim_start().starts_with(next)))) {
        return Some(Intent::Cancel);
    }
    if ["继续刚才的搜索结果", "刚才查到了吗", "刚才的搜索结果呢", "继续播刚才的搜索结果", "刚才查的结果呢", "查好了吗", "搜到了吗", "接着说刚才查到的", "刚才查到什么了", "搜索结果呢"].contains(&control)
        || result_resume(control) { return Some(Intent::Resume); }
    if ["不要", "不用", "别", "我自己", "我说", "他说", "她说", "你说", "“", "‘", "\"", "'"].iter().any(|p| t.starts_with(p)) { return None; }
    if let Some(q) = t.strip_prefix("我查一下") {
        return if q.contains("就回来") || q.contains("再告诉") { None } else { Some(Intent::Clarify) };
    }
    // Topic first is accepted only with a complete, explicit trailing request.
    for suffix in ["，帮我查一下", ",帮我查一下", "，帮我查查", ",帮我查查", "，请帮我查一下"] {
        if let Some(q) = t.strip_suffix(suffix) { return task_query(q, false); }
    }
    for suffix in ["帮我查一下", "帮我查查", "帮我查一查", "帮我搜一搜", "帮我搜一下"] {
        if let Some(q) = t.strip_suffix(suffix) {
            if !q.is_empty() && !["请", "请你", "能不能", "能", "你能", "你能不能", "你可以", "可以", "可不可以", "麻烦", "麻烦你", "我想请你", "我想让你"].contains(&q) { return task_query(q, false); }
        }
    }
    let mut t = t;
    for _ in 0..3 {
        if let Some(rest) = ["我想请你", "我想让你", "请你", "你能不能", "你可以", "你能", "能不能", "可不可以", "可以", "能", "麻烦你", "麻烦", "请"].iter().find_map(|p| t.strip_prefix(p)) {
            t = rest.trim_start_matches(|c: char| "，, ".contains(c));
        } else { break; }
    }
    for prefix in ["改为查询", "换查", "改查"] {
        if let Some(q) = t.strip_prefix(prefix) { return task_query(q, true); }
    }
    let mut explicit_helper = false;
    for prefix in ["帮我在网上", "帮我上网", "帮忙", "帮我", "在网上", "上网", "联网"] {
        if let Some(rest) = t.strip_prefix(prefix) { t = rest.trim_start(); explicit_helper = true; break; }
    }
    for prefix in ["搜索一下", "查询一下", "查找一下", "搜索", "查询", "查找", "查一下", "查一查", "查查", "搜一下", "搜一搜", "搜搜"] {
        if let Some(q) = t.strip_prefix(prefix) { return task_query(q, false); }
    }
    if explicit_helper {
        if let Some(q) = t.strip_prefix('查').or_else(|| t.strip_prefix('搜')) { return task_query(q, false); }
    }
    None
}

#[derive(Default)]
pub struct QueryIntent { pending_at: Option<(u64, bool)>, recent_question: Option<(u64, String)>, handoff: Option<String>, resume_at: Option<u64> }
impl QueryIntent {
    pub fn take_handoff(&mut self) -> Option<String> { self.handoff.take() }
    pub fn clear(&mut self) { self.pending_at = None; self.recent_question = None; self.handoff=None; self.resume_at=None; }
    pub fn route(&mut self, text: &str, now_ms: u64) -> Option<Intent> {
        if search_term_question(text) {self.clear();return None;}
        self.handoff=None;
        let resume=self.resume_at.take();
        if trim_outer(text)=="结果" && resume.is_some_and(|at|now_ms.saturating_sub(at)<=1500) { return Some(Intent::Resume); }
        let previous = self.pending_at.take();
        let recent = self.recent_question.take();
        if let Some(action) = intent(text) {
            if action==Intent::Resume { self.resume_at=Some(now_ms); }
            if action == Intent::Clarify {
                // ASR can commit "故宫明天开放吗" and "帮我查一下"
                // separately, within the same breath. Bind only an explicit,
                // empty request to the immediately preceding public question.
                if ["帮我查一下", "帮我查查", "帮我查一查", "帮我搜一下", "帮我搜一搜", "请帮我查一下"].contains(&addressed(text)) {
                    if let Some((at, question)) = recent {
                        if now_ms.saturating_sub(at) <= 1500 { self.handoff=Some(question.clone()); return Some(Intent::Search(question)); }
                    }
                }
                self.pending_at = Some((now_ms, addressed(text).starts_with("改查") || addressed(text).starts_with("换查")));
            }
            return Some(action);
        }
        let text = trim_outer(text);
        // Only the very next committed utterance, after a real clarification.
        // Do not concatenate personal chat, negations, quotes or commands.
        let public_title=text.starts_with("我的世界")&&!text.starts_with("我的世界观");
        let unrelated = ["我", "你", "他", "她", "我们", "不要", "不用", "别", "取消", "停", "算了", "继续", "讲", "聊", "好的", "好", "嗯", "“", "\""].iter().any(|p| text.starts_with(p) && !text.starts_with("我国")&&!public_title);
        if previous.is_some_and(|(at,_)| now_ms.saturating_sub(at) <= 10_000) && !unrelated && text.chars().count() >= 2 {
            return task_query(text, previous.unwrap().1);
        }
        let quoted_or_conditional = ["如果", "假如", "例如", "比如", "‘", "'"].iter().any(|p| text.starts_with(p));
        let question = ["吗", "什么", "为什么", "多少", "怎么", "哪里", "哪年", "哪条", "哪个", "何时", "谁"].iter().any(|p| text.contains(p));
        if previous.is_none() && !unrelated && !quoted_or_conditional && question
            && (2..=128).contains(&text.chars().count())
            && !text.contains('查') && !text.contains('搜') {
            self.recent_question = Some((now_ms, text.into()));
        }
        None
    }
}

#[derive(Default)]
pub struct DeliveryGate {
    idle_since: Option<u64>,
    pending: Option<(String, String, u64)>,
    seen: HashSet<String>,
}
impl DeliveryGate {
    pub fn offer(&mut self, id: String, text: String, now: u64) {
        if !self.seen.contains(&id) && self.pending.is_none() {
            self.pending = Some((id, text, now));
        }
    }
    pub fn cancel(&mut self) {
        if let Some((id, _, _)) = self.pending.take() {
            self.seen.insert(id);
        }
        self.idle_since = None;
    }
    pub fn take_ready(&mut self, now: u64, safe: bool) -> Option<(String, String)> {
        if !safe {
            self.idle_since = None;
            return None;
        }
        let since = *self.idle_since.get_or_insert(now);
        if let Some((_, _, at)) = &self.pending {
            if now.saturating_sub(*at) >= 60_000 {
                self.cancel();
                return None;
            }
        }
        if now.saturating_sub(since) < 800 {
            return None;
        }
        let (id, text, _) = self.pending.take()?;
        self.seen.insert(id.clone());
        Some((id, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn r21_search_word_questions_are_chat_even_after_a_clarification() {
        for text in ["查查是啥", "查查是什么", "搜索啥意思", "查一下是啥意思", "查询是干什么的", "小可，查查这个词啥意思？", "请帮我查一下是什么意思"] {
            assert_eq!(intent(text),None,"{text}");
            let mut router=QueryIntent::default();
            router.route("帮我查一下",0);
            assert_eq!(router.route(text,500),None,"{text}");
            assert_eq!(router.route("恐龙",700),None,"an explanation must clear stale clarification");
        }
        for (text,query) in [("帮我查查光合作用是啥","光合作用是啥"),("搜索深空探测是干什么的","深空探测是干什么的"),("查查宝可梦主角是谁","宝可梦主角是谁")] {
            assert_eq!(intent(text),Some(Intent::Search(query.into())),"{text}");
        }
    }
    #[test]
    fn r20_observed_resume_and_suffix_fragments_keep_the_search_route() {
        for text in ["继续搜刚才的搜索结果", "继续刚才的搜索", "请继续刚才的查询"] {
            assert_eq!(intent(text),Some(Intent::Resume),"{text}");
        }
        for text in ["继续搜索恐龙", "继续刚才的故事", "他说继续搜刚才的搜索结果", "不要继续刚才的搜索"] {
            assert_eq!(intent(text),None,"{text}");
        }
        let mut router=QueryIntent::default();
        assert_eq!(router.route("继续刚才的搜索",0),Some(Intent::Resume));
        assert_eq!(router.route("结果",800),Some(Intent::Resume));
        assert_eq!(router.route("结果",900),None);
        assert_eq!(intent("羽毛球双打后发球线是哪条帮我查一查"),Some(Intent::Search("羽毛球双打后发球线是哪条".into())));
        assert_eq!(router.route("羽毛球双打后发球线是哪条",1000),None);
        assert_eq!(router.route("帮我查一下",1500),Some(Intent::Search("羽毛球双打后发球线是哪条".into())));
        assert_eq!(intent("帮我查一下为什么会灭绝"),Some(Intent::Clarify));
        router.route("帮我查一下",2000);
        assert_eq!(router.route("我的世界基岩版最近正式更新了什么",2300),Some(Intent::Search("我的世界基岩版最近正式更新了什么".into())));
    }
    #[test]
    fn r18_cancel_compound_survives_asr_space_between_clauses() {
        for text in ["不用查了 我们聊别的", "不用查了　我们聊小猫", "别查了 聊别的吧", "不用查了我们聊别的"] {
            assert_eq!(intent(text),Some(Intent::Cancel),"{text}");
        }
        for text in ["他说不用查了 我们聊别的", "如果我说不用查了 我们聊什么", "不用查了是什么意思", "不用查北京天气 我们聊小猫"] {
            assert_eq!(intent(text),None,"{text}");
        }
    }
    #[test]
    fn search_handoff_is_only_immediate_suffix_binding() {
        let mut router=QueryIntent::default();
        assert_eq!(router.route("故宫明天开放吗？",100),None);
        assert_eq!(router.route("帮我查一下",900),Some(Intent::Search("故宫明天开放吗".into())));
        assert_eq!(router.take_handoff(),Some("故宫明天开放吗".into()));
        assert_eq!(router.take_handoff(),None);
        for (question,command,delay) in [("故宫明天开放吗","帮我查一下",2000),("我喜欢小猫吗","帮我查一下",100),("故宫明天开放吗","帮我查一下火星",100),("故宫明天开放吗","取消搜索",100)] {
            let mut router=QueryIntent::default();router.route(question,100);router.route(command,100+delay);
            assert_eq!(router.take_handoff(),None);
        }
        router.route("卫星是什么",1000);router.route("帮我查一下",1100);router.clear();
        assert_eq!(router.take_handoff(),None);
    }

    #[test]
    fn split_intent_only_accepts_prompt_public_topic_and_expires() {
        let mut router=QueryIntent::default();
        assert_eq!(router.route("帮我查一下",0),Some(Intent::Clarify));
        assert_eq!(router.route("今天北京的天气",1000),Some(Intent::Search("今天北京的天气".into())));
        router.route("帮我查一下",2000);
        assert_eq!(router.route("我今天画了一只猫",2500),None);
        assert_eq!(router.route("北京天气",2600),None);
        router.route("帮我查一下",3000);
        assert_eq!(router.route("北京天气",14001),None);
        router.route("帮我查一下",8000);
        assert_eq!(router.route("取消搜索",8100),Some(Intent::Cancel));
        assert_eq!(router.route("北京天气",8200),None);
    }
    #[test]
    fn natural_search_and_cancel_phrases_route_without_claiming_quotes_or_negations() {
        assert_eq!(intent("查找今天北京天气"), Some(Intent::Search("今天北京天气".into())));
        assert_eq!(intent("不用查了，取消刚才的搜索。"), Some(Intent::Cancel));
        assert_eq!(intent("不用查了取消刚才的搜索"), Some(Intent::Cancel));
        assert_eq!(intent("不要查找北京天气"), None);
        assert_eq!(intent("我说查找天气是什么意思"), None);
    }
    #[test]
    fn explicit_search_only_and_cancel_are_separate_from_barge_in() {
        assert_eq!(
            intent("帮我查一下科技馆周末开放吗"),
            Some(Intent::Search("科技馆周末开放吗".into()))
        );
        assert_eq!(
            intent("请搜索一下火星新闻"),
            Some(Intent::Search("火星新闻".into()))
        );
        assert_eq!(
            intent("改查故宫开放时间"),
            Some(Intent::Replace("故宫开放时间".into()))
        );
        assert_eq!(intent("不用查了。"), Some(Intent::Cancel));
        assert_eq!(intent("继续刚才的搜索结果"), Some(Intent::Resume));
        for text in [
            "今天心情不好",
            "最新编一个故事",
            "停",
            "我说帮我查一下是什么意思",
            "不要搜索科技馆",
        ] {
            assert_eq!(intent(text), None, "{text}");
        }
    }
    #[test]
    fn no_claim_until_full_idle_interval_and_never_redeliver() {
        let mut gate = DeliveryGate::default();
        gate.offer("t1".into(), "结果".into(), 0);
        assert!(gate.take_ready(1000, false).is_none());
        assert!(gate.take_ready(1100, true).is_none());
        assert!(gate.take_ready(1899, true).is_none());
        assert_eq!(gate.take_ready(1900, true).unwrap().0, "t1");
        gate.offer("t1".into(), "重复".into(), 2000);
        assert!(gate.take_ready(3000, true).is_none());
    }
    #[test]
    fn speech_resets_idle_cancel_drops_ready_and_old_results_expire() {
        let mut gate = DeliveryGate::default();
        gate.offer("t1".into(), "结果".into(), 0);
        gate.take_ready(0, true);
        assert!(gate.take_ready(799, false).is_none());
        assert!(gate.take_ready(1000, true).is_none());
        assert!(gate.take_ready(1799, true).is_none());
        gate.cancel();
        assert!(gate.take_ready(2000, true).is_none());
        gate.offer("t2".into(), "旧结果".into(), 2000);
        assert!(gate.take_ready(62000, true).is_none());
    }
}

#[cfg(test)]
#[path = "search_policy_cases.rs"]
mod robustness_cases;
