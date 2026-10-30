#[path = "../src/listening_buffer.rs"]
mod listening_buffer;
#[path = "../src/listening_mode.rs"]
mod listening_mode;
#[path = "../src/listening_runtime.rs"]
mod listening_runtime;
use listening_mode::*;
use listening_runtime::*;
fn binding() -> Binding {
    Binding {
        room: "sn-BJP00326070803800006-123".into(),
        session: "session-1".into(),
        trace: "trace-1".into(),
    }
}
fn session() -> ListeningSession {
    ListeningSession::new(binding()).unwrap()
}
fn cmd(seq: u64, action: Action) -> Command {
    Command {
        seq,
        request_id: format!("trace-1:{seq}"),
        action,
    }
}
fn enter(s: &mut ListeningSession) -> Snapshot {
    s.renew_lease(1, 15000, 0).unwrap();
    s.control(
        Some("dev-BJP00326070803800006"),
        "trace-1",
        cmd(
            1,
            Action::Enter {
                scene: Scene::Story,
                epoch: 0,
            },
        ),
        0,
    )
    .unwrap()
}
#[test]
fn real_participant_and_job_trace_are_required_before_mode_mutation() {
    let mut s = session();
    s.renew_lease(1, 15000, 0).unwrap();
    for (participant, trace) in [
        (None, "trace-1"),
        (Some("dev-BJP00326070803800007"), "trace-1"),
        (Some("dev-BJP00326070803800006"), "other-trace"),
    ] {
        assert!(
            s.control(
                participant,
                trace,
                cmd(
                    1,
                    Action::Enter {
                        scene: Scene::Story,
                        epoch: 0
                    }
                ),
                0
            )
            .is_err()
        );
        assert_eq!(s.snapshot().phase, Phase::Normal);
    }
}
#[test]
fn entered_completion_waits_for_actual_inflight_capture_and_local_ready() {
    let mut s = session();
    let permit = s.output_permit(OutputPurpose::Ordinary, 9, 0).unwrap();
    let capture = permit.begin_capture_at(0).unwrap();
    let e = enter(&mut s);
    s.control(
        Some("dev-BJP00326070803800006"),
        "trace-1",
        cmd(2, Action::LocalReady { epoch: e.epoch }),
        1,
    )
    .unwrap();
    assert!(!s.capture_is_drained());
    assert!(s.capture_drained(e.epoch, 2).is_err());
    assert!(!permit.allowed_at(2));
    drop(capture);
    assert!(s.capture_is_drained());
    assert_eq!(
        s.capture_drained(e.epoch, 3).unwrap().phase,
        Phase::Listening
    );
    assert_eq!(s.entry_command().unwrap().request_id, "trace-1:1");
    assert!(s.output_permit(OutputPurpose::Ordinary, 10, 4).is_none());
    assert!(s.output_permit(OutputPurpose::Search, 10, 4).is_none());
    assert!(s.output_permit(OutputPurpose::Device, 10, 4).is_none());
}
#[test]
fn feedback_is_one_turn_and_speechstart_revokes_every_later_frame() {
    let mut s = session();
    let e = enter(&mut s);
    s.capture_drained(e.epoch, 1).unwrap();
    s.control(
        Some("dev-BJP00326070803800006"),
        "trace-1",
        cmd(2, Action::LocalReady { epoch: e.epoch }),
        2,
    )
    .unwrap();
    let f = s
        .control(
            Some("dev-BJP00326070803800006"),
            "trace-1",
            cmd(3, Action::Feedback { epoch: e.epoch }),
            3,
        )
        .unwrap();
    assert!(s.output_permit(OutputPurpose::Ordinary, 10, 4).is_none());
    s.begin_feedback(f.epoch, 10, 4).unwrap();
    let permit = s.output_permit(OutputPurpose::Feedback, 10, 4).unwrap();
    assert!(permit.allowed_at(4));
    assert!(s.output_permit(OutputPurpose::Feedback, 11, 4).is_none());
    s.speech_start(5);
    s.speech_end(6);
    assert!(!permit.allowed_at(6));
    assert!(permit.begin_capture_at(6).is_none());
    assert_eq!(s.snapshot().phase, Phase::Listening);
}
#[test]
fn ordinary_story_collection_preserves_buffer_and_never_creates_output_permission() {
    let mut s = session();
    let e = enter(&mut s);
    s.capture_drained(e.epoch, 1).unwrap();
    s.control(
        Some("dev-BJP00326070803800006"),
        "trace-1",
        cmd(2, Action::LocalReady { epoch: e.epoch }),
        2,
    )
    .unwrap();
    s.final_text("小熊说再见，你觉得呢，帮我查一下天气");
    assert!(s.context().recent.contains("小熊说再见"));
    assert!(s.output_permit(OutputPurpose::Device, 1, 4).is_none());
    assert_eq!(s.snapshot().phase, Phase::Listening);
}
#[test]
fn renewal_failure_and_entry_timeout_pause_without_chat_fallback() {
    let mut s = session();
    let e = enter(&mut s);
    s.tick(5000);
    assert_eq!(s.snapshot().phase, Phase::Paused);
    assert!(s.capture_drained(e.epoch, 5001).is_err());
    assert!(s.output_permit(OutputPurpose::Ordinary, 1, 5001).is_none());
    s.renew_lease(2, 20000, 6000).unwrap();
    assert_eq!(s.snapshot().phase, Phase::Paused);
}
#[test]
fn snapshot_tuning_changes_duration_cooldown_and_session_deadline() {
    let mut s = session();
    s.configure(300000, 5000, 3000);
    let e = enter(&mut s);
    s.capture_drained(e.epoch, 0).unwrap();
    s.control(
        Some("dev-BJP00326070803800006"),
        "trace-1",
        cmd(2, Action::LocalReady { epoch: e.epoch }),
        0,
    )
    .unwrap();
    let f = s
        .control(
            Some("dev-BJP00326070803800006"),
            "trace-1",
            cmd(3, Action::Feedback { epoch: e.epoch }),
            10,
        )
        .unwrap();
    s.begin_feedback(f.epoch, 1, 10).unwrap();
    let p = s.output_permit(OutputPurpose::Feedback, 1, 10).unwrap();
    assert!(p.allowed_at(5009));
    assert!(!p.allowed_at(5010));
    s.tick(5010);
    assert_eq!(s.snapshot().phase, Phase::Listening);
    let f = s
        .control(
            Some("dev-BJP00326070803800006"),
            "trace-1",
            cmd(
                4,
                Action::Feedback {
                    epoch: s.snapshot().epoch,
                },
            ),
            5011,
        )
        .unwrap();
    s.begin_feedback(f.epoch, 2, 5011).unwrap();
    s.feedback_done(2, 5012).unwrap();
    assert_eq!(
        s.control(
            Some("dev-BJP00326070803800006"),
            "trace-1",
            cmd(
                5,
                Action::Feedback {
                    epoch: s.snapshot().epoch
                }
            ),
            6000
        ),
        Err(Reject::NotReady)
    );
    // Refresh through the configured 300s boundary; refresh cannot extend the session.
    for now in (10000..300000).step_by(10000) {
        s.renew_lease(1, now + 15000, now).unwrap();
    }
    s.tick(300000);
    assert_eq!(s.snapshot().phase, Phase::Paused);
}

#[test]
fn newer_normal_turn_revokes_old_turn_before_any_late_frame() {
    let s = session();
    let first = s.output_permit(OutputPurpose::Ordinary, 1, 0).unwrap();
    assert!(first.allowed_at(0));
    let second = s.output_permit(OutputPurpose::Search, 2, 0).unwrap();
    assert!(!first.allowed_at(0));
    assert!(first.begin_capture_at(0).is_none());
    assert!(second.allowed_at(0));
}
