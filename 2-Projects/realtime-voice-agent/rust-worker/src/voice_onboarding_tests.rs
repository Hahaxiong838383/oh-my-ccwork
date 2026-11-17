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
fn runtime_duplicate_audio_receipt_preserves_fresh_speech_but_new_cue_does_not() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let meta = json!({"version":1,"grant":"a".repeat(64),"expires_at_ms":epoch_ms()+600000});
    let mut r = Runtime::from_metadata(
        Some(&meta),
        Some("trace"),
        Some("session"),
        Some("dev-synthetic"),
        "http://127.0.0.1:1/v1",
        "token=synthetic",
    )
    .unwrap();
    ready(&mut r.session);
    done(&mut r.session, 2, 2);
    let mut ack = req(3, "audio_complete");
    ack.payload["audio_token"] = r.session.state["audio_token"].clone();
    ack.payload["audio_status"] = json!("complete");
    r.control(&ack, Some("dev-synthetic"), false);
    assert!(r.reject_asr()); // New cue completion must require new speech.
    r.speech();
    assert!(!r.reject_asr());
    let state = r.session.state.clone();
    r.control(&ack, Some("dev-synthetic"), false);
    assert_eq!(r.session.state, state);
    assert!(
        !r.reject_asr(),
        "duplicate audio receipt must not swallow the pending ASR final"
    );
    r.control(&req(1, "begin"), Some("dev-synthetic"), false);
    assert!(!r.reject_asr(), "duplicate begin is also side-effect free");
    r.control(&req(4, "request_exit_prompt"), Some("dev-synthetic"), false);
    assert!(r.reject_asr()); // A genuinely new playback invalidates old VAD.
    done(&mut r.session, 5, 5);
    assert!(r.reject_asr());
    r.speech();
    assert!(!r.reject_asr());
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

#[test]
fn v2_signed_metadata_uses_an_independent_client_owned_protocol() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let metadata = json!({"version":2,"grant":"a".repeat(64),"expires_at_ms":epoch_ms()+60000});
    let r = Runtime::from_metadata(
        Some(&metadata),
        Some("trace"),
        Some("session"),
        Some("dev-synthetic"),
        "http://127.0.0.1:1/v1",
        "token=synthetic",
    );
    assert!(r.is_some(), "signed v2 capability needs its own runtime");
}

fn req2(rev: u64, action: &str, q: u64) -> control::Envelope {
    let mut e = req(rev as i64 + 1, action);
    e.payload = json!({"v":2,"trace_id":"trace","session_id":"session","lesson_id":"lesson","request_id":format!("v2-{rev}"),"revision":rev,"question_index":q,"action":action});
    e
}
fn session2() -> Session {
    let mut s = session();
    s.version = 2;
    s
}
fn control2(s: &mut Session, rev: u64, action: &str, q: u64) -> Vec<Effect> {
    s.control(&req2(rev, action, q), Some("dev-synthetic"), rev, false)
}
fn response2(body: &Value, result: &str, memory: &str) -> Value {
    let mut v = body.clone();
    v.as_object_mut().unwrap().remove("text");
    v["action"] = json!("answer_result");
    v["result"] = json!(result);
    v["memory_write"] = json!(memory);
    v
}
fn answer_body(s: &mut Session, text: &str) -> Value {
    s.answer(text, 10)
        .into_iter()
        .find_map(|e| {
            if let Effect::Brain(v) = e {
                Some(v)
            } else {
                None
            }
        })
        .unwrap()
}
#[test]
fn v2_fixed_three_questions_no_prompt_and_independent_memory_result() {
    let mut s = session2();
    control2(&mut s, 0, "begin", 0);
    for (q, text, memory) in [
        (1, "八岁", "saved"),
        (2, "我是女孩", "failed"),
        (3, "叫我星星", "skipped"),
    ] {
        let rev = (q - 1) * 2 + 1;
        control2(&mut s, rev, "question_started", q);
        assert!(s.answer(text, rev).is_empty());
        control2(&mut s, rev + 1, "audio_complete", q);
        let b = answer_body(&mut s, text);
        s.brain_reply(response2(&b, "accepted", memory), 11);
        assert_eq!(s.state["result"], "accepted");
        assert_eq!(s.state["memory_write"], memory);
        assert_eq!(s.state["request_id"], format!("v2-{}", rev + 1));
        for key in [
            "audio_prompt",
            "audio_token",
            "missing",
            "text",
            "age_years",
            "nickname",
            "birthday",
            "gender",
        ] {
            assert!(s.state.get(key).is_none());
        }
        assert!(s.active());
        assert!(s.blocks_input());
        assert!(s.answer(text, 12).is_empty());
    }
    control2(&mut s, 7, "finish", 3);
    assert!(!s.active());
    assert_eq!(s.state["result"], "finished");
}
#[test]
fn v2_skip_and_stale_result_cannot_reopen_question_or_write_twice() {
    let mut s = session2();
    control2(&mut s, 0, "begin", 0);
    control2(&mut s, 1, "question_started", 1);
    control2(&mut s, 2, "audio_complete", 1);
    let b = answer_body(&mut s, "八岁");
    control2(&mut s, 3, "question_skipped", 1);
    control2(&mut s, 4, "question_started", 2);
    assert!(
        s.brain_reply(response2(&b, "accepted", "saved"), 12)
            .is_empty()
    );
    assert_eq!(s.phase, "speaking");
    assert!(control2(&mut s, 5, "question_started", 1).is_empty());
    assert!(control2(&mut s, 5, "question_started", 4).is_empty());
    assert!(
        s.control(
            &req2(2, "audio_complete", 1),
            Some("dev-synthetic"),
            13,
            false
        )
        .iter()
        .all(|e| !matches!(e, Effect::Brain(_)))
    );
    assert_eq!(s.phase, "speaking");
}
#[test]
fn v2_failure_and_decline_do_not_release_chat_isolation() {
    for result in ["failed", "declined", "unrecognized"] {
        let mut s = session2();
        control2(&mut s, 0, "begin", 0);
        control2(&mut s, 1, "question_started", 1);
        control2(&mut s, 2, "audio_complete", 1);
        let b = answer_body(&mut s, "不告诉你");
        if result == "failed" {
            s.brain_failure();
        } else {
            s.brain_reply(
                response2(
                    &b,
                    result,
                    if result == "declined" {
                        "skipped"
                    } else {
                        "none"
                    },
                ),
                12,
            );
        }
        assert!(s.active());
        assert!(s.blocks_input());
        assert_eq!(s.state["result"], result);
        control2(&mut s, 3, "question_started", 2);
        assert_eq!(s.phase, "speaking");
    }
}
#[test]
fn v2_expiry_does_not_turn_into_completion_or_open_chat() {
    let mut s = session2();
    control2(&mut s, 0, "begin", 0);
    let out = s.control(&req2(1, "finish", 0), Some("dev-synthetic"), 180000, false);
    assert!(!out.is_empty());
    assert_eq!(s.state["result"], "expired");
    assert!(!s.active());
    assert!(
        s.control(&req2(2, "finish", 0), Some("dev-synthetic"), 180001, false)
            .is_empty()
    );
    assert_eq!(s.state["result"], "expired");
    let mut s = session2();
    control2(&mut s, 0, "begin", 0);
    s.tick(180000);
    assert!(s.active());
    assert!(s.blocks_input());
    assert_eq!(s.deadline(), None);
    assert!(s.tick(180001).is_empty());
}
#[test]
fn v2_trust_revision_audio_failure_and_simulation() {
    let mut s = session2();
    let mut e = req2(0, "begin", 0);
    e.payload["simulation"] = json!(true);
    assert!(s.control(&e, Some("dev-synthetic"), 0, false).is_empty());
    assert!(
        s.control(&req2(0, "begin", 0), Some("intruder"), 0, false)
            .is_empty()
    );
    control2(&mut s, 0, "begin", 0);
    assert!(control2(&mut s, 1, "question_started", 2).is_empty());
    control2(&mut s, 1, "question_started", 1);
    let mut bad = req2(2, "audio_complete", 1);
    bad.payload["trace_id"] = json!("old");
    assert!(s.control(&bad, Some("dev-synthetic"), 2, false).is_empty());
    let mut fail = req2(2, "audio_complete", 1);
    fail.payload["audio_status"] = json!("failed");
    let fx = s.control(&fail, Some("dev-synthetic"), 2, false);
    assert!(
        fx.iter()
            .any(|e| matches!(e,Effect::Brain(v) if v["action"]=="question_skipped"))
    );
    assert!(s.blocks_input());
    assert!(s.active());
}
#[tokio::test]
async fn v2_runtime_duplicate_keeps_fresh_vad_and_no_echo_exit() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let meta = json!({"version":2,"grant":"a".repeat(64),"expires_at_ms":epoch_ms()+60000});
    let mut r = Runtime::from_metadata(
        Some(&meta),
        Some("trace"),
        Some("session"),
        Some("dev-synthetic"),
        "http://127.0.0.1:1/v1",
        "token=synthetic",
    )
    .unwrap();
    for (rev, a, q) in [(0, "begin", 0), (1, "question_started", 1)] {
        r.control(&req2(rev, a, q), Some("dev-synthetic"), false);
    }
    assert_eq!(r.input_route(true), InputRoute::Drop);
    r.control(&req2(2, "audio_complete", 1), Some("dev-synthetic"), false);
    r.speech();
    r.control(&req2(2, "audio_complete", 1), Some("dev-synthetic"), false);
    assert!(r.speech_seen);
    assert_eq!(r.input_route(true), InputRoute::Exit);
    r.answer("八岁");
    assert!(r.session.pending);
    r.control(
        &req2(3, "question_skipped", 1),
        Some("dev-synthetic"),
        false,
    );
    assert!(!r.speech_seen);
    assert!(!r.queue.iter().any(|v| v["action"] == "answer"));
    r.control(&req2(4, "cancel", 1), Some("dev-synthetic"), false);
    assert!(!r.active());
    assert!(r.queue.is_empty());
}

#[tokio::test]
async fn v2_real_http_sqlite_serial_controls_and_retired_delayed_answer() {
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
            .env("SYNTHETIC_ONBOARDING_VERSION", "2")
            .env("SYNTHETIC_ANSWER_DELAY_MS", "400")
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
    // Deliberately no HTTP wait between local control events. Ordering must be owned by Runtime.
    for (rev, a, q) in [
        (0, "begin", 0),
        (1, "question_started", 1),
        (2, "audio_complete", 1),
    ] {
        r.control(&req2(rev, a, q), Some("dev-synthetic"), false);
    }
    r.speech();
    r.answer("八岁");
    let url = format!(
        "{}/synthetic-observation",
        setup["base"].as_str().unwrap().trim_end_matches("/v1")
    );
    let client = reqwest::Client::new();
    let mut seen = false;
    for _ in 0..100 {
        r.poll().await;
        let v: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
        if v["answerReceived"] == 1 {
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(seen);
    r.control(
        &req2(3, "question_skipped", 1),
        Some("dev-synthetic"),
        false,
    );
    for (rev, a, q) in [(4, "question_started", 2), (5, "audio_complete", 2)] {
        r.control(&req2(rev, a, q), Some("dev-synthetic"), false);
    }
    r.speech();
    r.answer("我是女孩");
    let mut result = false;
    for _ in 0..200 {
        let events = r.poll().await;
        for e in events {
            if e["payload"]["action"] == "answer_result" {
                assert_eq!(e["payload"]["question_index"], 2);
                assert_eq!(e["payload"]["request_id"], "v2-5");
                assert_eq!(e["payload"]["memory_write"], "saved");
                result = true;
            }
        }
        if result {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(result);
    let v: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert!(
        v["age_years"].is_null(),
        "retired late answer must fail against committed skip"
    );
    assert_eq!(v["birthday"], "");
    assert_eq!(v["gender"], "女孩");
    r.control(
        &req2(6, "question_started", 3),
        Some("dev-synthetic"),
        false,
    );
    r.control(&req2(7, "audio_complete", 3), Some("dev-synthetic"), false);
    r.speech();
    r.answer("叫我星星");
    for _ in 0..200 {
        r.poll().await;
        if r.session.phase == "answered" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(r.session.state["memory_write"], "saved");
    r.control(&req2(8, "finish", 3), Some("dev-synthetic"), false);
    assert!(!r.active());
    for _ in 0..40 {
        r.poll().await;
        if r.pending.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let v: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(v["nickname"], "星星");
    drop(r);
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}
