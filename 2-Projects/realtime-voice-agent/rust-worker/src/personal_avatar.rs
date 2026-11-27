//! Voice interaction with the avatar actually mounted on the assigned personal phone.
use livekit::prelude::{LocalParticipant, PerformRpcData};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Intent {
    Current,
    List { all: bool },
    Show(String), // Empty means the caller asked for a demonstration.
}

fn strip_prefix<'a>(text: &'a str, options: &[&str]) -> &'a str {
    options
        .iter()
        .find_map(|p| text.strip_prefix(*p))
        .unwrap_or(text)
}

fn strip_suffix<'a>(text: &'a str, options: &[&str]) -> &'a str {
    options
        .iter()
        .find_map(|p| text.strip_suffix(*p))
        .unwrap_or(text)
}

fn compact(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !"，。！？、·,.!?".contains(*c))
        .collect()
}

// Spoken shorthand for an explicit command. Resolution still requires a matching
// label from the active avatar; a broad emotion in ordinary conversation never acts.
fn spoken_labels(target: &str) -> &[&str] {
    match target {
        "笑" | "微笑" | "笑笑" | "笑一个" | "笑一笑" | "笑一下" | "开心" | "高兴" => {
            &["开心", "开心笑眼", "大笑"]
        }
        "哈哈大笑" | "大笑" => &["大笑", "开心笑眼", "开心"],
        "眨眼" | "眨眨眼" | "眨个眼" | "眨一下眼" => &["俏皮眨眼", "眨眼"],
        "惊讶" | "惊喜" | "吃惊" => &["惊讶瞪眼", "惊喜"],
        "哭" | "哭泣" | "哭一个" | "哭一下" | "大哭" | "流泪" => {
            &["哭泣", "流泪", "难过", "低落失落"]
        }
        "委屈" | "难过" | "伤心" => &["难过", "低落失落", "哭泣"],
        "害羞" | "害羞一下" => &["害羞"],
        "生气" | "生气一下" | "发火" => &["生气", "生气瞪眼"],
        "思考" | "沉思" => &["思考", "抬头思考", "低头沉思"],
        "点头" | "点点头" | "点个头" => &["点头确认"],
        "摇头" | "摇摇头" => &["摇头拒绝", "转头否认"],
        "转圈" | "转个圈" | "转一圈" => &["转圈互动", "环绕", "等待·绕圈"],
        "比心" | "爱心" => &["心动爱心"],
        "搞怪" | "鬼脸" | "扮个鬼脸" => &["俏皮", "俏皮眨眼", "转圈互动", "好奇"],
        _ => &[],
    }
}

pub fn intent(text: &str) -> Option<Intent> {
    if text.len() > 240 {
        return None;
    }
    let norm = compact(text);
    let mut t = strip_prefix(&norm, &["小可小可", "小可"]);
    t = strip_suffix(
        t,
        &[
            "好不好",
            "可以吗",
            "行不行",
            "好吗",
            "吧",
            "呀",
            "啊",
            "呢",
            "吗",
            "么",
        ],
    );
    // Each optional component consumes at most once. Only a full command can match.
    t = strip_prefix(t, &["请问", "我想知道", "我想让你"]);
    t = strip_prefix(t, &["请你", "请", "你"]);
    let about = strip_prefix(t, &["知道自己", "自己的", "自己", "的"]);
    let about = strip_prefix(about, &["现在", "当前", "此刻"]);
    let about = strip_prefix(about, &["脸上", "的"]);
    if matches!(
        about,
        "是什么表情"
            | "什么表情"
            | "在做什么表情"
            | "表情是什么"
            | "是什么样子"
            | "是什么造型"
            | "是什么头像"
            | "用的什么头像"
    ) {
        return Some(Intent::Current);
    }
    if matches!(
        about,
        "会的所有表情"
            | "列出所有表情"
            | "列出你的所有表情"
            | "把所有表情都说一遍"
            | "还有什么表情"
            | "全部表情有哪些"
    ) {
        return Some(Intent::List { all: true });
    }
    let capability = strip_prefix(about, &["都", "还"]);
    let rest = strip_prefix(
        capability,
        &["会做", "可以做", "能做出", "能做", "会", "有"],
    );
    if capability == "表情有哪些"
        || rest != capability && matches!(rest, "哪些表情" | "什么表情" | "多少种表情" | "表情")
    {
        return Some(Intent::List { all: false });
    }
    t = strip_prefix(t, &["能不能", "可不可以", "能否", "可以", "能"]);
    let directed = t.starts_with("给我") || t.starts_with("帮我");
    t = strip_prefix(t, &["给我", "帮我"]);
    t = strip_prefix(t, &["随便"]);
    t = strip_suffix(
        t,
        &[
            "给我看一下",
            "给我看看",
            "给我看",
            "我看看",
            "看一看",
            "看看",
        ],
    );
    let switch = strip_prefix(t, &["把表情换成", "把表情切换到", "表情切换成", "表情换成"]);
    if switch != t && !switch.is_empty() && switch.chars().count() <= 16 {
        return Some(Intent::Show(switch.to_owned()));
    }
    let requested = strip_prefix(
        t,
        &[
            "给我做",
            "做出",
            "做",
            "变成",
            "变",
            "切换到",
            "来",
            "换成",
            "换",
            "摆",
            "表演",
            "展示",
            "演示",
            "露出",
            "模仿",
        ],
    );
    let has_verb = requested.len() < t.len();
    let requested = strip_prefix(requested, &["一个", "一下", "一种", "个"]);
    let named = requested
        .strip_suffix("表情")
        .map(|s| strip_suffix(s, &["的"]));
    if let Some(name) = named
        && has_verb
        && name.chars().count() <= 16
    {
        return Some(Intent::Show(
            if ["随便", "任意", "不同", "别", "好玩", "有趣"].contains(&name) {
                String::new()
            } else {
                name.to_owned()
            },
        ));
    }
    if !spoken_labels(requested).is_empty()
        && (has_verb
            || directed
            || matches!(
                requested,
                "笑一个"
                    | "笑一笑"
                    | "笑一下"
                    | "眨眨眼"
                    | "眨个眼"
                    | "点点头"
                    | "摇摇头"
                    | "转个圈"
                    | "比心"
                    | "扮个鬼脸"
            ))
    {
        return Some(Intent::Show(requested.to_owned()));
    }
    None
}

#[derive(Deserialize)]
struct Expression {
    id: String,
    label: String,
}

#[derive(Deserialize)]
struct Avatar {
    family: String,
    variant: String,
    name: String,
    current: Option<String>,
    expressions: Vec<Expression>,
}

#[derive(Deserialize)]
struct Receipt {
    ok: bool,
    avatar: Avatar,
}

impl Receipt {
    fn confirms(&self, expected: &Avatar, chosen: &Expression) -> bool {
        self.ok
            && self.avatar.family == expected.family
            && self.avatar.variant == expected.variant
            && self.avatar.current.as_deref() == Some(&chosen.id)
    }
}

impl Avatar {
    fn valid(&self) -> bool {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 90
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
        };
        let label = |s: &str| {
            !s.trim().is_empty() && s.chars().count() <= 40 && !s.chars().any(char::is_control)
        };
        id(&self.family)
            && id(&self.variant)
            && label(&self.name)
            && (1..=96).contains(&self.expressions.len())
            && self
                .expressions
                .iter()
                .all(|e| id(&e.id) && label(&e.label))
    }

    fn choice(&self, requested: &str) -> Option<&Expression> {
        if requested.is_empty() {
            return ["开心", "开心笑眼", "俏皮", "兴奋", "转圈互动", "好奇"]
                .iter()
                .filter_map(|label| self.expressions.iter().find(|e| &e.label == label))
                .chain(self.expressions.iter())
                .find(|e| self.current.as_deref() != Some(&e.id))
                .or_else(|| self.expressions.first());
        }
        if let Some(e) = self
            .expressions
            .iter()
            .find(|e| compact(&e.label) == requested)
        {
            return Some(e);
        }
        for label in spoken_labels(requested) {
            if let Some(e) = self.expressions.iter().find(|e| &e.label == label) {
                return Some(e);
            }
        }
        // A shortened Chinese name is unambiguous only when exactly one label contains it.
        if requested.chars().count() < 2 {
            return None;
        }
        let mut hits = self
            .expressions
            .iter()
            .filter(|e| compact(&e.label).contains(requested));
        let first = hits.next()?;
        hits.next().is_none().then_some(first)
    }

    fn list(&self, all: bool) -> String {
        let limit = if all { self.expressions.len() } else { 6 };
        let names: Vec<_> = self
            .expressions
            .iter()
            .take(limit)
            .map(|e| e.label.as_str())
            .collect();
        let head = if names.len() == self.expressions.len() {
            "分别是"
        } else {
            "比如"
        };
        format!(
            "我现在是{}，会做{}种表情，{}{}。",
            self.name,
            self.expressions.len(),
            head,
            names.join("、")
        )
    }
}

async fn rpc(lp: &LocalParticipant, device: &str, request: Value) -> Option<Receipt> {
    let call = PerformRpcData::new(device, "personal.avatar.v1")
        .with_payload(request.to_string())
        .with_max_round_trip_latency(Duration::from_millis(1100))
        .with_response_timeout(Duration::from_millis(2200));
    match lp.perform_rpc(call).await {
        Ok(raw) => {
            let receipt: Receipt = serde_json::from_str(&raw).ok()?;
            receipt.avatar.valid().then_some(receipt)
        }
        Err(error) => {
            tracing::info!(code = error.code, "personal avatar RPC unavailable");
            None
        }
    }
}

pub async fn answer(lp: &LocalParticipant, device: &str, intent: Intent) -> String {
    let Some(Receipt { ok: true, avatar }) = rpc(lp, device, json!({"op":"inspect"})).await else {
        return "我这次没读到手机上的头像，请确认暗夜剧场已经更新并连接。".into();
    };
    tracing::info!(family=%avatar.family, count=avatar.expressions.len(), "personal avatar inspected");
    match intent {
        Intent::Current => {
            let current = avatar
                .expressions
                .iter()
                .find(|e| avatar.current.as_deref() == Some(&e.id));
            match current {
                Some(e) => format!(
                    "你问的时候，我是{}，正显示「{}」的表情。",
                    avatar.name, e.label
                ),
                None => format!("我现在是{}，当前这一帧的表情还没读到。", avatar.name),
            }
        }
        Intent::List { all } => avatar.list(all),
        Intent::Show(target) => {
            let Some(chosen) = avatar.choice(&target) else {
                return format!(
                    "{}没有叫「{}」的表情。{}",
                    avatar.name,
                    target,
                    avatar.list(false)
                );
            };
            let done = rpc(
                lp,
                device,
                json!({"op":"express","family":avatar.family,
                "variant":avatar.variant,"expression":chosen.id}),
            )
            .await;
            if done.as_ref().is_some_and(|r| r.confirms(&avatar, chosen)) {
                tracing::info!(family=%avatar.family, expression=%chosen.id, "personal avatar expression confirmed");
                format!("看，{}！", chosen.label)
            } else {
                "手机还没有确认这个表情，你可以再试一次。".into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_and_chat_do_not_overlap() {
        for phrase in ["做个表情", "小可你给我做个表情看看", "做个表情可以吗"]
        {
            assert_eq!(
                intent(phrase),
                Some(Intent::Show(String::new())),
                "{phrase}"
            );
        }
        for (phrase, name) in [
            ("小可，笑一个！", "笑一个"),
            ("做个低头沉思的表情", "低头沉思"),
            ("你做一个哭的表情", "哭"),
            ("请你给我眨眨眼", "眨眨眼"),
        ] {
            assert_eq!(
                intent(phrase),
                Some(Intent::Show(name.to_owned())),
                "{phrase}"
            );
        }
        assert_eq!(
            intent("你知道自己现在是什么表情吗？"),
            Some(Intent::Current)
        );
        assert_eq!(intent("你会做哪些表情"), Some(Intent::List { all: false }));
        for text in [
            "我今天很开心",
            "你开心吗",
            "生气了吗",
            "他刚才做了个表情",
            "不要做表情",
            "你为什么不开心",
            "做一个苹果派",
            "怎么做一个表情包",
            "搜索怎么做表情",
            "小可你觉得他的表情代表什么",
            "你可以帮我查个天气吗",
        ] {
            assert_eq!(intent(text), None, "{text}");
        }
    }

    #[test]
    fn choose_only_real_labels_and_vary_demo() {
        let avatar: Avatar = serde_json::from_value(json!({"family":"boop","variant":"skin-102","name":"湖蓝（102）",
            "current":"success","expressions":[{"id":"success","label":"开心笑眼"},{"id":"wink","label":"俏皮眨眼"},{"id":"waiting","label":"等待·绕圈"}]})).unwrap();
        assert!(avatar.valid());
        for (requested, id) in [
            ("开心", "success"),
            ("眨眨眼", "wink"),
            ("等待绕圈", "waiting"),
            ("", "wink"),
        ] {
            assert_eq!(avatar.choice(requested).unwrap().id, id);
        }
        assert!(avatar.choice("害羞").is_none());
    }

    #[test]
    fn crying_command_requires_confirmation_from_same_skin() {
        let snapshot = json!({"family":"robot","variant":"tv-tomato","name":"番茄红电视","current":"idle",
            "expressions":[{"id":"idle","label":"待机"},{"id":"cry","label":"哭泣"}]});
        let avatar: Avatar = serde_json::from_value(snapshot.clone()).unwrap();
        let Some(Intent::Show(target)) = intent("你做一个哭的表情") else {
            panic!("production request was missed")
        };
        let chosen = avatar.choice(&target).unwrap();
        assert_eq!(chosen.id, "cry");
        let mut receipt: Receipt =
            serde_json::from_value(json!({"ok":true,"avatar":snapshot})).unwrap();
        assert!(!receipt.confirms(&avatar, chosen));
        receipt.avatar.current = Some("cry".into());
        assert!(receipt.confirms(&avatar, chosen));
        receipt.ok = false;
        assert!(!receipt.confirms(&avatar, chosen));
        receipt.ok = true;
        receipt.avatar.variant = "rectangle".into();
        assert!(!receipt.confirms(&avatar, chosen));
    }
}
