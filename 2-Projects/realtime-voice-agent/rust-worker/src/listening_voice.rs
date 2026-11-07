//! Explicit STT phrases only; wire fields remain in the Brain-owned contract.
use crate::listening_mode::Scene;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    Enter(Scene),
    Exit,
    Feedback { singing_only: bool },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Utterance {
    pub intent: Intent,
    pub tail: String,
}
fn phrases() -> Vec<(&'static str, Intent)> {
    vec![
        ("小可先听我讲个故事", Intent::Enter(Scene::Story)),
        ("小可先听我讲故事", Intent::Enter(Scene::Story)),
        ("小可先听我说一会儿", Intent::Enter(Scene::Sharing)),
        ("小可先听我分享一下", Intent::Enter(Scene::Sharing)),
        ("小可听我唱首歌", Intent::Enter(Scene::Singing)),
        ("小可先听我唱歌", Intent::Enter(Scene::Singing)),
        ("小可结束倾听恢复聊天", Intent::Exit),
        ("小可退出倾听模式", Intent::Exit),
        (
            "小可我讲完了请说说你的看法",
            Intent::Feedback {
                singing_only: false,
            },
        ),
        (
            "小可我说完了请给我反馈",
            Intent::Feedback {
                singing_only: false,
            },
        ),
        (
            "小可我唱完了请给我反馈",
            Intent::Feedback { singing_only: true },
        ),
    ]
}
fn separator(c: char) -> bool {
    c.is_whitespace() || "，。？！、；：,.?!;:".contains(c)
}
fn normalized(text: &str) -> (String, Vec<usize>) {
    let mut ends = vec![];
    let value = text
        .char_indices()
        .filter_map(|(i, c)| {
            if separator(c) {
                None
            } else {
                ends.push(i + c.len_utf8());
                Some(c)
            }
        })
        .collect();
    (value, ends)
}
pub fn parse(text: &str) -> Option<Utterance> {
    parse_rules(text, phrases())
}

// Short exits are meaningful only inside an already-authorized listening mode.
// The Adapter supplies that state; do not add these to the global command table.
const ACTIVE_EXITS: &[&str] = &[
    "结束倾听恢复聊天", "结束倾听模式恢复聊天", "结束倾听", "结束倾听模式",
    "退出倾听", "退出倾听模式", "恢复聊天", "恢复普通聊天",
];
fn active_exit_text(text: &str) -> String {
    let value = normalized(text).0;
    value.strip_prefix("小可小可").or_else(|| value.strip_prefix("小可"))
        .unwrap_or(&value).to_owned()
}
pub fn parse_active_exit(text: &str) -> Option<Utterance> {
    let value = active_exit_text(text);
    ACTIVE_EXITS.contains(&value.as_str())
        .then(|| Utterance { intent: Intent::Exit, tail: String::new() })
}
pub fn possible_active_exit_prefix(text: &str) -> bool {
    let value = active_exit_text(text);
    !value.is_empty() && ACTIVE_EXITS.iter().any(|phrase| phrase.starts_with(&value))
}
fn parse_rules(text: &str, rules: Vec<(&str, Intent)>) -> Option<Utterance> {
    let (normal, ends) = normalized(text);
    for (phrase, intent) in rules {
        if !normal.starts_with(phrase) {
            continue;
        }
        let raw_tail = &text[ends[phrase.chars().count() - 1]..];
        let tail = raw_tail.trim_start_matches(separator);
        if matches!(intent, Intent::Enter(_)) {
            // Preserve the original boundary: no arbitrary starts_with on a quoted/question suffix.
            if raw_tail[..raw_tail.len() - tail.len()].contains(['？', '?'])
                || (!tail.is_empty() && !raw_tail.starts_with(separator))
                || [
                    "吗",
                    "么",
                    "是什么意思",
                    "怎么说",
                    "这句话",
                    "是台词",
                    "这是台词",
                    "这句歌词",
                ]
                .iter()
                .any(|p| tail.starts_with(p))
            {
                return None;
            }
        } else if !normal.eq(phrase) {
            continue;
        }
        return Some(Utterance {
            intent,
            tail: tail.to_owned(),
        });
    }
    None
}

fn natural_phrases() -> Vec<(&'static str, Intent)> {
    use Scene::*;
    [
        ("先听我讲个故事", Story), ("先听我讲故事", Story), ("先听我讲一个故事", Story),
        ("我给你讲一个故事", Story), ("我给你讲个故事", Story),
        ("我要给你讲一个故事", Story), ("我要给你讲个故事", Story),
        ("我想给你讲一个故事", Story), ("我想给你讲个故事", Story),
        ("先听我说一会儿", Sharing), ("先听我分享一下", Sharing),
        ("我想和你分享一件事", Sharing), ("我给你分享一件事", Sharing),
        ("听我唱首歌", Singing), ("先听我唱歌", Singing),
        ("我给你唱首歌", Singing), ("我要给你唱首歌", Singing),
        ("我给你唱一首歌", Singing), ("我要给你唱一首歌", Singing),
    ].into_iter().map(|(p, s)| (p, Intent::Enter(s))).collect()
}
pub fn parse_natural_enter(text: &str) -> Option<Utterance> {
    let u = parse_rules(text, natural_phrases())?;
    // Conservative exclusions for direct requests followed by a qualification.
    if ["不", "别", "但", "可是", "不过", "好吗", "好不好", "行吗", "可以吗",
        "是歌词", "这是歌词", "这句台词", "是个例子", "是示例"]
        .iter().any(|p| u.tail.starts_with(p)) { return None; }
    Some(u)
}

/// Job-owned control context only. `now` is the runtime's monotonic clock, not UTC.
/// This does not grant a lease, construct a transcript, or authorize feedback/exit.
#[derive(Default)]
pub struct RecentWake {
    pending: Option<(u64, u64)>, // (deadline_ms, mode_epoch)
    refreshed: bool,
}
impl RecentWake {
    pub fn clear(&mut self) { self.pending = None; self.refreshed = false; }
    pub fn active(&self, now: u64, epoch: u64) -> bool {
        self.pending.is_some_and(|(deadline, e)| e == epoch && now < deadline)
    }
    pub fn arm(&mut self, now: u64, epoch: u64) {
        if self.active(now, epoch) {
            if self.refreshed { return; }
            self.refreshed = true;
        } else { self.refreshed = false; }
        self.pending = Some((now.saturating_add(15000), epoch));
    }
    pub fn take_enter(&mut self, text: &str, now: u64, epoch: u64) -> Option<Utterance> {
        if text.trim().is_empty() { return None; }
        let allowed = self.active(now, epoch);
        self.clear(); // Every substantive final consumes it, including ordinary chat.
        if allowed { parse_natural_enter(text) } else { None }
    }
    pub fn possible_tail(&self, text: &str, now: u64, epoch: u64) -> bool {
        if !self.active(now, epoch) { return false; }
        let n = normalized(text).0;
        // Never hold arbitrary “我…” interims or wait 15 seconds to route ordinary chat.
        let direct = ["先听", "听我", "我给你", "我要给你", "我想给你", "我想和你"].iter().any(|p| n.starts_with(p));
        direct && (parse_natural_enter(text).is_some() || natural_phrases().iter().any(|(p, _)| p.starts_with(&n)))
    }
}
pub fn possible_prefix(text: &str) -> bool {
    let (normal, _) = normalized(text);
    !normal.is_empty()
        && (parse(text).is_some() || phrases().iter().any(|(p, _)| p.starts_with(&normal)))
}

// Only the existing, explicit feedback grammar may span finals. No suffix search,
// no arbitrary transcript concatenation, and no sliding deadline on partial input.
const FEEDBACK_FRAGMENT_MS: u64 = 5000;
const FEEDBACK_FRAGMENT_BYTES: usize = 256;
#[derive(Default)]
pub struct FeedbackFragments {
    pending: Option<FeedbackPrefix>,
}
struct FeedbackPrefix {
    epoch: u64,
    scene: Scene,
    deadline: u64,
    normal: String,
    raw: Vec<String>,
    bytes: usize,
    began_after_pause: bool,
}
#[derive(Default)]
pub struct FeedbackStep {
    pub released: Vec<String>,
    pub consumed: bool,
    pub command: Option<(Utterance, bool)>,
}
fn feedback_prefix(text: &str, scene: Scene) -> bool {
    phrases().iter().any(|(p, intent)| {
        matches!(intent, Intent::Feedback { singing_only } if *singing_only == (scene == Scene::Singing))
            && p.starts_with(text)
    })
}
impl FeedbackFragments {
    pub fn take_raw(&mut self, epoch: u64) -> Vec<String> {
        self.pending.take().filter(|p| p.epoch == epoch).map(|p| p.raw).unwrap_or_default()
    }
    pub fn clear(&mut self) { self.pending = None; }
    pub fn stale(&self, now: u64, context: Option<(u64, Scene)>) -> bool {
        self.pending.as_ref().is_some_and(|p| now >= p.deadline || context != Some((p.epoch, p.scene)))
    }
    pub fn candidate(&self, text: &str, now: u64, epoch: u64, scene: Scene) -> bool {
        if text.len() > FEEDBACK_FRAGMENT_BYTES { return false; }
        let n = normalized(text).0;
        if n.is_empty() { return false; }
        let p = self.pending.as_ref().filter(|p| now < p.deadline && p.epoch == epoch && p.scene == scene);
        let joined = p.map(|p| format!("{}{n}", p.normal)).unwrap_or(n);
        joined.starts_with("小可") && feedback_prefix(&joined, scene)
    }
    pub fn push(&mut self, text: &str, now: u64, epoch: u64, scene: Scene, after_pause: bool) -> FeedbackStep {
        let mut out = FeedbackStep::default();
        if self.stale(now, Some((epoch, scene))) { out.released = self.take_raw(epoch); }
        if !self.candidate(text, now, epoch, scene)
            || self.pending.as_ref().map_or(text.len(), |p| p.bytes.saturating_add(text.len())) > FEEDBACK_FRAGMENT_BYTES
        {
            out.released.extend(self.take_raw(epoch));
            return out;
        }
        // Singing fragments cannot turn a later breath into permission for earlier lyrics.
        if self.pending.is_none() && scene == Scene::Singing && !after_pause { return out; }
        let p = self.pending.get_or_insert_with(|| FeedbackPrefix {
            epoch, scene, deadline: now.saturating_add(FEEDBACK_FRAGMENT_MS),
            normal: String::new(), raw: vec![], bytes: 0, began_after_pause: after_pause,
        });
        p.normal.push_str(&normalized(text).0);
        p.bytes += text.len();
        p.raw.push(text.to_owned());
        out.consumed = true;
        if let Some(u) = parse(&p.normal) {
            out.command = Some((u, p.began_after_pause));
            self.pending = None;
        }
        out
    }
}
