#[path = "../src/listening_mode.rs"]
mod listening_mode;
#[path = "../src/listening_voice.rs"]
mod listening_voice;
use listening_mode::Scene;
use listening_voice::{Intent, parse, possible_prefix};
#[test]
fn explicit_first_utterance_selects_scene_and_preserves_immediate_story() {
    for (text, scene, tail) in [
        ("小可，先听我讲个故事。", Scene::Story, ""),
        (
            "小可先听我讲故事，从前有一只猫。",
            Scene::Story,
            "从前有一只猫。",
        ),
        ("小可，先听我说一会儿！", Scene::Sharing, ""),
        (
            "小可先听我分享一下，今天很开心",
            Scene::Sharing,
            "今天很开心",
        ),
        ("小可，听我唱首歌。", Scene::Singing, ""),
        ("小可先听我唱歌，月亮出来了", Scene::Singing, "月亮出来了"),
    ] {
        let u = parse(text).expect(text);
        assert_eq!(u.intent, Intent::Enter(scene));
        assert_eq!(u.tail, tail);
    }
}
#[test]
fn feedback_and_exit_are_explicit_complete_phrases() {
    for (text, expected) in [
        (
            "小可，我讲完了，请说说你的看法。",
            Intent::Feedback {
                singing_only: false,
            },
        ),
        (
            "小可，我唱完了，请给我反馈。",
            Intent::Feedback { singing_only: true },
        ),
        ("小可，结束倾听，恢复聊天。", Intent::Exit),
        ("小可退出倾听模式", Intent::Exit),
    ] {
        assert_eq!(parse(text).unwrap().intent, expected);
    }
}
#[test]
fn lyrics_quotes_partial_requests_and_ordinary_questions_do_not_command() {
    for text in [
        "小可先听我讲个故事是什么意思",
        "小可，先听我讲故事，怎么说。",
        "小可先听我讲个故事，是台词",
        "小可听我唱首歌？",
        "小可先听我分享一下今天很开心",
        "讲完了",
        "唱完了",
        "你觉得呢？",
        "再见",
        "小可先听我",
        "小可听我唱首歌吗",
        "小可你觉得呢然后继续",
        "故事里他说小可听我唱首歌",
        "他说：小可结束倾听恢复聊天",
        "“小可，听我唱首歌”",
        "小可我唱完了请给我反馈这句歌词",
        "小可结束倾听恢复聊天是台词",
        "小可，今天下雨吗",
    ] {
        assert!(parse(text).is_none(), "{text}");
    }
}
#[test]
fn interim_command_prefix_is_held_before_ordinary_speculation() {
    for text in ["小可", "小可，先听我", "小可，我唱完了", "小可，结束倾听"] {
        assert!(possible_prefix(text), "{text}");
    }
    for text in ["", "他说小可", "小可今天天气", "月亮出来了"] {
        assert!(!possible_prefix(text), "{text}");
    }
}

#[test]
fn recent_wake_accepts_finite_enter_at_ten_seconds_but_not_fifteen() {
    use listening_voice::RecentWake;
    let mut wake = RecentWake::default();
    for text in ["先听我讲个故事", "我给你讲一个故事", "我要给你讲一个故事", "我想给你讲个故事", "我想给你讲一个故事", "我给你唱一首歌", "我想和你分享一件事"] {
        wake.arm(0, 4);
        assert!(wake.take_enter(text, 9982, 4).is_some(), "{text}");
        assert!(wake.take_enter(text, 9983, 4).is_none(), "single use");
    }
    wake.arm(0, 4);
    assert!(wake.take_enter("先听我讲故事", 14999, 4).is_some());
    wake.arm(0, 4);
    assert!(wake.take_enter("先听我讲故事", 15000, 4).is_none());
}
#[test]
fn recent_wake_rejects_ordinary_quotes_negation_questions_and_cannot_authorize_feedback() {
    let mut wake = listening_voice::RecentWake::default();
    for text in ["今天下雨吗", "先听我讲故事吗", "我给你讲一个故事是什么意思", "他说我给你讲个故事",
        "“我给你讲一个故事”", "不要听我讲故事", "我给你唱首歌，这是歌词", "我给你讲个故事，好不好",
        "我给你讲一个故事，不过别进入倾听", "我唱完了请给我反馈", "退出倾听模式", "先听我"] {
        wake.arm(0, 4);
        assert!(wake.take_enter(text, 1000, 4).is_none(), "{text}");
        assert!(wake.take_enter("先听我讲故事", 1001, 4).is_none(), "ordinary/negative final consumed window");
    }
    wake.arm(0, 4);
    assert!(wake.take_enter("先听我讲故事", 1000, 5).is_none());
    assert!(wake.take_enter("先听我讲故事", 1001, 4).is_none());
    assert!(listening_voice::RecentWake::default().take_enter("我给你讲个故事", 1000, 4).is_none());
}
#[test]
fn recent_wake_partials_never_refresh_and_only_one_explicit_refresh_is_allowed() {
    let mut wake = listening_voice::RecentWake::default();
    wake.arm(0, 4);
    for now in [1000, 10000, 14999] {
        assert!(wake.possible_tail("先听我", now, 4));
        assert!(!wake.possible_tail("我", now, 4));
        assert!(!wake.possible_tail("我今天", now, 4));
    }
    assert!(!wake.possible_tail("先听我", 15000, 4));
    wake.arm(20000, 4);
    wake.arm(21000, 4);
    wake.arm(35000, 4);
    assert!(wake.take_enter("先听我讲故事", 36000, 4).is_none(), "second refresh cannot extend");
    wake.arm(40000, 4);wake.clear();
    assert!(wake.take_enter("先听我讲故事", 40001, 4).is_none());
}
