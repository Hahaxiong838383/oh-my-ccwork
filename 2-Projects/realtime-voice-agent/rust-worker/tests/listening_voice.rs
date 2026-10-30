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
