use super::*;
struct FixtureChild(std::process::Child);
impl std::ops::Deref for FixtureChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for FixtureChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for FixtureChild {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn req(n: i64, action: &str) -> control::Envelope {
    serde_json::from_value(json!({"trace_id":"trace","ts_ms":100,"src":"android","seq":n,"type":"voice_onboarding.request","lane":"voice_onboarding","payload":{"v":1,"session_id":"session","lesson_id":"lesson","request_id":format!("r{n}"),"action":action,"entry":"scheduled"}})).unwrap()
}
fn raw(e: control::Envelope) -> Vec<u8> {
    serde_json::to_vec(&json!({"trace_id":e.trace_id,"ts_ms":e.ts_ms,"src":e.src,"type":e.kind,"lane":e.lane,"seq":e.seq,"payload":e.payload})).unwrap()
}
fn session() -> Session {
    Session::new("trace".into(), "session".into(), "dev-synthetic".into())
}
fn ready(s: &mut Session) {
    s.control(&req(1, "begin"), Some("dev-synthetic"), 0, false);
    s.brain_reply(json!({"revision":0,"memory_write":"none","missing":["age","gender","nickname"],"result":"ready"}),1);
}
fn done(s: &mut Session, n: i64, now: u64) -> Vec<Effect> {
    let mut e = req(n, "audio_complete");
    e.payload["audio_token"] = s.state["audio_token"].clone();
    e.payload["audio_status"] = json!("complete");
    s.control(&e, Some("dev-synthetic"), now, false)
}
#[test]
fn entry_parser_and_trust_fences() {
    let raw = raw(req(1, "begin"));
    assert!(matches!(
        control::parse(&raw).unwrap().1,
        control::Inbound::VoiceOnboarding
    ));
    let mut s = session();
    assert!(
        s.control(&req(1, "begin"), Some("intruder"), 0, false)
            .is_empty()
    );
    let mut wrong = req(1, "begin");
    wrong.trace_id = "old".into();
    assert!(
        s.control(&wrong, Some("dev-synthetic"), 0, false)
            .is_empty()
    );
    assert!(!s.active());
}
#[test]
fn no_answer_until_audio_complete_and_saved_only_after_brain() {
    let mut s = session();
    ready(&mut s);
    assert_eq!(s.state["audio_prompt"], "wake_reply");
    assert!(s.answer("八岁", 2).is_empty());
    done(&mut s, 2, 3);
    assert_eq!(s.state["audio_prompt"], "ask_age");
    assert!(s.answer("八岁", 4).is_empty());
    done(&mut s, 3, 5);
    assert_eq!(s.state["stage"], "waiting_answer");
    assert!(
        s.answer("八岁", 6)
            .iter()
            .any(|e| matches!(e, Effect::Brain(_)))
    );
    assert_ne!(s.state["memory_write"], "saved");
    s.brain_reply(json!({"revision":1,"memory_write":"saved","missing":["gender","nickname"],"result":"saved"}),7);
    assert_eq!(s.state["memory_write"], "saved");
    assert_eq!(s.state["audio_prompt"], "ask_gender");
}
#[test]
fn duplicates_conflicts_and_old_audio_never_replay() {
    let mut s = session();
    ready(&mut s);
    let before = s.state.clone();
    assert!(
        s.control(&req(1, "begin"), Some("dev-synthetic"), 2, false)
            .iter()
            .all(|e| !matches!(e, Effect::Brain(_)))
    );
    assert_eq!(s.state, before);
    let mut conflict = req(1, "cancel");
    assert!(
        s.control(&conflict, Some("dev-synthetic"), 3, false)
            .is_empty()
    );
    conflict = req(2, "audio_complete");
    conflict.payload["audio_token"] = json!("old");
    conflict.payload["audio_status"] = json!("complete");
    assert!(
        s.control(&conflict, Some("dev-synthetic"), 4, false)
            .is_empty()
    );
    assert_eq!(s.state, before);
}
#[test]
fn ttl_is_fixed_and_cancel_invalidates_late_save() {
    let mut s = session();
    ready(&mut s);
    done(&mut s, 2, 170000);
    assert_eq!(s.deadline(), Some(180000));
    s.tick(180000);
    assert!(!s.active());
    assert_eq!(s.state["stage"], "failed");
    s.brain_reply(
        json!({"revision":1,"memory_write":"saved","missing":[],"result":"saved"}),
        180001,
    );
    assert_ne!(s.state["memory_write"], "saved");
}
#[test]
fn known_profile_exit_and_normal_chat_keep_room() {
    let mut s = session();
    s.control(&req(1, "begin"), Some("dev-synthetic"), 0, false);
    s.brain_reply(
        json!({"revision":0,"memory_write":"none","missing":[],"result":"ready"}),
        1,
    );
    done(&mut s, 2, 2);
    assert_eq!(s.state["audio_prompt"], "complete_exit");
    done(&mut s, 3, 3);
    assert_eq!(s.state["stage"], "waiting_exit");
    s.answer("我们继续聊恐龙吧", 4);
    assert_eq!(s.state["stage"], "normal_chat");
    assert!(!s.active());
}
#[test]
fn quiet_failed_audio_decline_and_listening_exclusion() {
    let mut s = session();
    assert!(
        s.control(&req(1, "begin"), Some("dev-synthetic"), 0, true)
            .is_empty()
    );
    ready(&mut s);
    done(&mut s, 2, 2);
    done(&mut s, 3, 3);
    s.control(
        &req(4, "request_exit_prompt"),
        Some("dev-synthetic"),
        4,
        false,
    );
    assert_eq!(s.state["audio_prompt"], "quiet_exit");
    let mut e = req(5, "audio_complete");
    e.payload["audio_token"] = s.state["audio_token"].clone();
    e.payload["audio_status"] = json!("failed");
    s.control(&e, Some("dev-synthetic"), 5, false);
    assert_eq!(s.state["stage"], "failed");
}

#[tokio::test]
async fn worker_control_transport_to_real_brain_http_and_sqlite() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|p| p.join("docs/voice-onboarding-20261117/TASK.md").exists())
        .unwrap();
    let server = root.join("2-Projects/P003GameDemo20260513/apps/server");
    let mut child = FixtureChild(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/voice-onboarding-worker-fixture.ts",
            ])
            .current_dir(server)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let setup: Value = serde_json::from_str(&line).expect("synthetic fixture starts");
    let mut r = Runtime::from_metadata(
        Some(&setup["metadata"]),
        Some("trace"),
        Some("session"),
        Some("dev-synthetic"),
        setup["base"].as_str().unwrap(),
        setup["query"].as_str().unwrap(),
    )
    .unwrap();
    async fn wait(r: &mut Runtime) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let v = r.poll().await;
                if !v.is_empty() {
                    return v;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    let (e, k) = control::parse(&raw(req(1, "begin"))).unwrap();
    assert!(matches!(k, control::Inbound::VoiceOnboarding));
    r.control(&e, Some("dev-synthetic"), false);
    let states = wait(&mut r).await;
    assert_eq!(states[0]["payload"]["audio_prompt"], "wake_reply");
    for n in [2, 3] {
        let mut e = req(n, "audio_complete");
        e.payload["audio_token"] = r.session.state["audio_token"].clone();
        e.payload["audio_status"] = json!("complete");
        r.control(&e, Some("dev-synthetic"), false);
        wait(&mut r).await;
    }
    assert!(
        r.reject_asr(),
        "late playback ASR without fresh speech stays blocked"
    );
    r.speech();
    assert!(!r.reject_asr());
    r.answer("我今年八岁了");
    let states = wait(&mut r).await;
    assert_eq!(states[0]["payload"]["memory_write"], "saved");
    assert_eq!(states[0]["payload"]["audio_prompt"], "ask_gender");
    let url = setup["base"]
        .as_str()
        .unwrap()
        .trim_end_matches("/v1")
        .to_owned()
        + "/synthetic-observation";
    let saved: Value = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["age_years"], 8);
    assert_eq!(saved["birthday"], "");
    assert!(saved["age_observed_at"].as_i64().unwrap() > 0);
    r.cancel();
    wait(&mut r).await;
    assert!(!r.active());
    drop(r);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}
#[test]
fn every_phase_can_finish_or_cancel_without_waiting_for_audio() {
    for action in ["finish", "cancel"] {
        let mut s = session();
        ready(&mut s);
        s.control(&req(2, action), Some("dev-synthetic"), 2, false);
        assert!(!s.active(), "{action}");
        assert_eq!(s.state["stage"], "completed");
    }
}
#[test]
fn retired_audio_and_old_revision_do_not_advance() {
    let mut s = session();
    ready(&mut s);
    let old = s.state["audio_token"].clone();
    done(&mut s, 2, 2);
    let before = s.state.clone();
    let mut e = req(3, "audio_complete");
    e.payload["audio_token"] = old;
    e.payload["audio_status"] = json!("complete");
    assert!(s.control(&e, Some("dev-synthetic"), 3, false).is_empty());
    e.payload["audio_token"] = s.state["audio_token"].clone();
    e.payload["revision"] = json!(0);
    assert!(s.control(&e, Some("dev-synthetic"), 4, false).is_empty());
    assert_eq!(s.state, before);
}
#[test]
fn input_gate_keeps_exit_but_drops_playback_answers_and_late_asr() {
    assert_eq!(
        route_input(false, false, false, false),
        InputRoute::Ordinary
    );
    assert_eq!(route_input(true, true, true, false), InputRoute::Drop);
    assert_eq!(route_input(true, false, false, false), InputRoute::Drop);
    assert_eq!(route_input(true, true, false, true), InputRoute::Exit);
    assert_eq!(route_input(true, false, true, false), InputRoute::Ordinary);
}
#[test]
fn full_missing_flow_all_questions_then_exit_and_strict_revisions() {
    let mut s = session();
    let mut begin = req(1, "begin");
    begin.payload["entry"] = json!("early_wake");
    s.control(&begin, Some("dev-synthetic"), 0, false);
    s.brain_reply(json!({"revision":0,"memory_write":"none","missing":["age","gender","nickname"],"result":"ready"}),1);
    assert_eq!(s.state["audio_prompt"], "early_intro");
    done(&mut s, 2, 2);
    let mut tokens = std::collections::HashSet::new();
    let mut rev = s.state["revision"].as_u64().unwrap();
    for (i, cue, answer, missing) in [
        (0, "ask_age", "八岁", vec!["gender", "nickname"]),
        (1, "ask_gender", "我是女孩", vec!["nickname"]),
        (2, "ask_nickname", "叫我星星", vec![]),
    ] {
        assert_eq!(s.state["audio_prompt"], cue);
        assert!(tokens.insert(s.state["audio_token"].as_str().unwrap().to_owned()));
        done(&mut s, 3 + i, 3 + i as u64);
        s.answer(answer, 10 + i as u64);
        s.brain_reply(
            json!({"revision":i+1,"memory_write":"saved","missing":missing,"result":"saved"}),
            20 + i as u64,
        );
        assert!(s.state["revision"].as_u64().unwrap() > rev);
        rev = s.state["revision"].as_u64().unwrap();
    }
    assert_eq!(s.state["audio_prompt"], "complete_exit");
    assert_eq!(tokens.len(), 3);
}
#[test]
fn refuse_failure_and_cancel_reject_late_saved_reply() {
    for mode in ["declined", "failure", "cancel"] {
        let mut s = session();
        ready(&mut s);
        done(&mut s, 2, 2);
        done(&mut s, 3, 3);
        s.answer("不告诉你", 4);
        if mode == "declined" {
            s.brain_reply(json!({"revision":0,"memory_write":"skipped","missing":["age"],"result":"declined"}),5);
            assert_eq!(s.state["stage"], "declined");
        } else if mode == "failure" {
            s.brain_failure();
            assert_eq!(s.state["stage"], "failed");
        } else {
            s.cancel();
        }
        let final_state = s.state.clone();
        s.brain_reply(
            json!({"revision":1,"memory_write":"saved","missing":[],"result":"saved"}),
            6,
        );
        assert_eq!(s.state, final_state);
        assert!(!s.active());
    }
}
#[tokio::test]
async fn cancellation_during_actual_http_does_not_commit_late_answer() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .find(|p| p.join("docs/voice-onboarding-20261117/TASK.md").exists())
        .unwrap();
    let mut child = FixtureChild(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/voice-onboarding-worker-fixture.ts",
            ])
            .env("SYNTHETIC_ANSWER_DELAY_MS", "800")
            .current_dir(root.join("2-Projects/P003GameDemo20260513/apps/server"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let setup: Value = serde_json::from_str(&line).unwrap();
    let mut r = Runtime::from_metadata(
        Some(&setup["metadata"]),
        Some("trace"),
        Some("session"),
        Some("dev-synthetic"),
        setup["base"].as_str().unwrap(),
        setup["query"].as_str().unwrap(),
    )
    .unwrap();
    r.control(&req(1, "begin"), Some("dev-synthetic"), false);
    for _ in 0..200 {
        r.poll().await;
        if r.session.state["stage"] == "intro_speaking" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    for n in [2, 3] {
        let mut e = req(n, "audio_complete");
        e.payload["audio_token"] = r.session.state["audio_token"].clone();
        e.payload["audio_status"] = json!("complete");
        r.control(&e, Some("dev-synthetic"), false);
        r.poll().await;
    }
    r.speech();
    r.answer("八岁");
    let url = setup["base"]
        .as_str()
        .unwrap()
        .trim_end_matches("/v1")
        .to_owned()
        + "/synthetic-observation";
    let client = reqwest::Client::new();
    let mut received = false;
    for _ in 0..100 {
        let v: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
        if v["answerReceived"] == 1 {
            received = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(received);
    r.control(&req(4, "cancel"), Some("dev-synthetic"), false);
    r.poll().await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    r.poll().await;
    let v: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert!(v["age_years"].is_null());
    assert_ne!(r.session.state["memory_write"], "saved");
    drop(r);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

#[test]
fn cancel_before_deferred_begin_prevents_late_lesson_start() {
    for action in ["cancel", "finish"] {
        let mut s = session();
        s.control(&req(2, action), Some("dev-synthetic"), 10, false);
        assert_eq!(s.state["stage"], "completed");
        assert!(
            s.control(&req(1, "begin"), Some("dev-synthetic"), 20, false)
                .is_empty()
        );
        assert!(!s.active());
    }
}
