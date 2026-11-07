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
        proposal_id: None,
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

#[test]
fn voice_transition_holds_normal_outputs_without_spending_android_epoch() {
    let mut s = session();
    let old = s.output_permit(OutputPurpose::Ordinary, 5, 0).unwrap();
    s.hold_voice_transition();
    assert!(s.active());
    assert_eq!(s.snapshot().phase, Phase::Normal);
    assert_eq!(s.snapshot().epoch, 0);
    assert!(!old.allowed_at(0));
    for purpose in [
        OutputPurpose::Ordinary,
        OutputPurpose::Search,
        OutputPurpose::Device,
    ] {
        assert!(s.output_permit(purpose, 6, 0).is_none());
    }
    s.release_voice_transition();
    assert!(!s.active());
    assert!(
        !old.allowed_at(0),
        "releasing a transition must never replay the old turn"
    );
    assert!(s.output_permit(OutputPurpose::Ordinary, 7, 0).is_some());
}
#[test]
fn voice_transition_timeout_cannot_resume_normal_chat() {
    let mut s = session();
    s.hold_voice_transition();
    s.pause_pending_entry();
    s.release_voice_transition();
    assert_eq!(s.snapshot().phase, Phase::Paused);
    assert!(s.active());
    assert!(s.output_permit(OutputPurpose::Ordinary, 1, 0).is_none());
}

#[test]
fn restored_previously_accepted_story_is_bound_to_entry_and_grants_no_permission() {
    let mut s = session(); let e = enter(&mut s);
    s.capture_drained(e.epoch, 1).unwrap();
    s.control(Some("dev-BJP00326070803800006"), "trace-1", cmd(2, Action::LocalReady { epoch: e.epoch }), 2).unwrap();
    assert!(s.restore_held_text("trace-1:1", "小可，"));
    let e = s.snapshot().epoch;
    s.control(Some("dev-BJP00326070803800006"), "trace-1", cmd(3, Action::Exit { epoch: e }), 3).unwrap();
    let e = s.snapshot().epoch;
    s.control(Some("dev-BJP00326070803800006"), "trace-1", cmd(4, Action::Enter { epoch: e, scene: Scene::Story }), 4).unwrap();
    assert!(!s.restore_held_text("trace-1:1", "上一段故事不许穿越"));
    assert!(s.context().recent.is_empty());
    assert!(s.output_permit(OutputPurpose::Feedback, 8, 5).is_none());
    s.tick(15000);
    assert_eq!(s.snapshot().phase, Phase::Paused);
    assert!(s.restore_held_text("trace-1:4", "先前接受的正文"));
    assert!(s.output_permit(OutputPurpose::Feedback, 9, 15001).is_none());
    assert_eq!(s.snapshot().phase, Phase::Paused);
}

#[test]
fn business_hold_tracks_real_lease_without_polling_renewal_or_normal_state_hold() {
    let mut s=session();
    s.renew_lease(1,15000,0).unwrap();
    assert!(s.business_deadline(0).is_none(), "metadata alone is not active listening");
    let entering=enter(&mut s);
    let entry_end=s.business_deadline(0).expect("entry has its fixed handshake deadline");
    assert_eq!(s.business_deadline(4000),Some(entry_end));
    assert!(s.business_deadline(5000).is_none());
    s.capture_drained(entering.epoch,1).unwrap();
    s.control(Some("dev-BJP00326070803800006"),"trace-1",cmd(2,Action::LocalReady{epoch:entering.epoch}),1).unwrap();
    let first=s.business_deadline(1).expect("active lease protects story silence");
    for now in [100,5000,10000,14999] {assert_eq!(s.business_deadline(now),Some(first));}
    assert!(s.business_deadline(15000).is_none(), "expiry is enforced even before tick");
    s.renew_lease(1,20000,5000).unwrap();
    assert_eq!(s.business_deadline(5000).unwrap().duration_since(first),std::time::Duration::from_millis(5000));
    let epoch=s.snapshot().epoch;
    s.control(Some("dev-BJP00326070803800006"),"trace-1",cmd(3,Action::Exit{epoch}),6000).unwrap();
    assert!(s.business_deadline(6000).is_none(), "exit removes the old lease");
}
#[test]
fn business_hold_respects_session_cap_revocation_and_paused_state() {
    let mut s=session();s.configure(60000,12000,5000);let entering=enter(&mut s);
    s.capture_drained(entering.epoch,1).unwrap();
    s.control(Some("dev-BJP00326070803800006"),"trace-1",cmd(2,Action::LocalReady{epoch:entering.epoch}),1).unwrap();
    for now in (10000..=50000).step_by(10000) {s.renew_lease(1,now+15000,now).unwrap();}
    let cap=s.business_deadline(50000).expect("still within lease and session cap");
    s.renew_lease(1,70000,55000).unwrap();assert_eq!(s.business_deadline(55000),Some(cap));
    assert!(s.business_deadline(60000).is_none());
    s.tick(60000);assert_eq!(s.snapshot().phase,Phase::Paused);
    assert!(s.business_deadline(60000).is_none());
    let mut other=session();enter(&mut other);other.pause_pending_entry();
    assert!(other.business_deadline(1000).is_none());
}

#[test]
fn accepted_exit_is_real_input_but_duplicate_queries_cannot_extend_idle() {
    let mut s=session();let e=enter(&mut s);s.capture_drained(e.epoch,1).unwrap();
    s.control(Some("dev-BJP00326070803800006"),"trace-1",cmd(2,Action::LocalReady{epoch:e.epoch}),1).unwrap();
    assert!(s.business_exit_at().is_none());
    let exit=cmd(3,Action::Exit{epoch:s.snapshot().epoch});
    assert!(s.control(Some("untrusted"),"trace-1",exit.clone(),6000).is_err());
    assert!(s.business_exit_at().is_none());
    s.control(Some("dev-BJP00326070803800006"),"trace-1",exit.clone(),6000).unwrap();
    let at=s.business_exit_at().expect("accepted exit grants one ordinary idle interval");
    assert_eq!(at,s.deadline_instant(6000).unwrap());
    assert!(s.control(Some("dev-BJP00326070803800006"),"trace-1",exit,10000).unwrap().duplicate);
    s.control(Some("dev-BJP00326070803800006"),"trace-1",cmd(4,Action::State),11000).unwrap();
    assert_eq!(s.business_exit_at(),Some(at));
}
