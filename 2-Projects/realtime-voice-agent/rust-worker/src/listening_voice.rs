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
    let (normal, ends) = normalized(text);
    for (phrase, intent) in phrases() {
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
pub fn possible_prefix(text: &str) -> bool {
    let (normal, _) = normalized(text);
    !normal.is_empty()
        && (parse(text).is_some() || phrases().iter().any(|(p, _)| p.starts_with(&normal)))
}
