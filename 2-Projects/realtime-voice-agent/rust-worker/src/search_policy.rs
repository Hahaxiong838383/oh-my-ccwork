//! Pure search routing / playback gate. No network, LLM lock or audio side effects.

use std::collections::HashSet;

#[derive(Debug, PartialEq, Eq)]
pub enum Intent {
    Search(String),
    Replace(String),
    Cancel,
    Resume,
}

pub fn intent(text: &str) -> Option<Intent> {
    let t = text
        .trim()
        .trim_end_matches(|c: char| "。！!？?，,. ".contains(c));
    if ["别查了", "不用查了", "取消搜索", "停止搜索", "不用查了，取消刚才的搜索", "取消刚才的搜索"].contains(&t) {
        return Some(Intent::Cancel);
    }
    if ["继续刚才的搜索结果", "刚才查到了吗", "刚才的搜索结果呢"].contains(&t)
    {
        return Some(Intent::Resume);
    }
    let prefixes = [
        "请帮我查找",
        "帮我查找",
        "查找",
        "请帮我搜索一下",
        "帮我搜索一下",
        "请帮我查一下",
        "帮我查一下",
        "请搜索一下",
        "搜索一下",
        "帮我搜一下",
        "查一下",
        "改查",
    ];
    for prefix in prefixes {
        if let Some(query) = t.strip_prefix(prefix) {
            let query = query
                .trim()
                .trim_start_matches(|c: char| "，,:： ".contains(c));
            if query.is_empty() || query.chars().count() > 128 {
                return None;
            }
            return Some(if prefix == "改查" {
                Intent::Replace(query.into())
            } else {
                Intent::Search(query.into())
            });
        }
    }
    None
}

#[derive(Default)]
pub struct QueryIntent { pending_at: Option<u64> }
impl QueryIntent {
    pub fn clear(&mut self) { self.pending_at = None; }
    pub fn route(&mut self, text: &str, now_ms: u64) -> Option<Intent> {
        let previous = self.pending_at.take();
        if let Some(action) = intent(text) { return Some(action); }
        let text = text.trim().trim_end_matches(|c: char| "。！!？?，,. ".contains(c));
        if ["帮我查一下", "请帮我查一下", "查一下", "搜索一下", "帮我搜索一下", "查找"].contains(&text) {
            self.pending_at = Some(now_ms); return None;
        }
        // Narrow fragment completion only; never attach arbitrary following conversation.
        let public_topic = ["天气", "开放时间", "开放安排", "新闻", "定义"].iter().any(|topic| text.ends_with(topic));
        let personal = ["我", "你", "他", "小猫", "不要", "不用", "别查", "取消"].iter().any(|word| text.contains(word));
        if previous.is_some_and(|at| now_ms.saturating_sub(at) <= 3000) && public_topic && !personal && text.chars().count() <= 128 {
            return Some(Intent::Search(text.into()));
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
    fn split_intent_only_accepts_prompt_public_topic_and_expires() {
        let mut router=QueryIntent::default();
        assert_eq!(router.route("帮我查一下",0),None);
        assert_eq!(router.route("今天北京的天气",1000),Some(Intent::Search("今天北京的天气".into())));
        router.route("帮我查一下",2000);
        assert_eq!(router.route("我今天画了一只猫",2500),None);
        assert_eq!(router.route("北京天气",2600),None);
        router.route("帮我查一下",3000);
        assert_eq!(router.route("北京天气",7001),None);
        router.route("帮我查一下",8000);
        assert_eq!(router.route("取消搜索",8100),Some(Intent::Cancel));
        assert_eq!(router.route("北京天气",8200),None);
    }
    #[test]
    fn natural_search_and_cancel_phrases_route_without_claiming_quotes_or_negations() {
        assert_eq!(intent("查找今天北京天气"), Some(Intent::Search("今天北京天气".into())));
        assert_eq!(intent("不用查了，取消刚才的搜索。"), Some(Intent::Cancel));
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
