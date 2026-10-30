#[path = "../src/listening_buffer.rs"]
mod listening_buffer;
#[path = "../src/listening_mode.rs"]
mod listening_mode;

use listening_buffer::*;
use listening_mode::*;

fn mode() -> ListeningMode {
    ListeningMode::new("trace-1").unwrap()
}
fn command(seq: u64, action: Action) -> Command {
    Command {
        seq,
        request_id: format!("trace-1:{seq}"),
        action,
    }
}
fn listening(scene: Scene) -> ListeningMode {
    let mut m = mode();
    m.renew_lease(1, 15_000, 0).unwrap();
    let entered = m
        .handle(
            command(
                1,
                Action::Enter {
                    scene: scene,
                    epoch: 0,
                },
            ),
            0,
        )
        .unwrap();
    m.capture_drained(entered.epoch, 1).unwrap();
    m.handle(
        command(
            2,
            Action::LocalReady {
                epoch: entered.epoch,
            },
        ),
        10,
    )
    .unwrap();
    m
}

#[test]
fn disabled_has_no_entry_or_automatic_speech_policy_change() {
    let mut m = mode();
    assert_eq!(m.snapshot().phase, Phase::Normal);
    assert!(m.permits_audio(0, 10, 0));
    assert_eq!(
        m.handle(
            command(
                1,
                Action::Enter {
                    scene: Scene::Story,
                    epoch: 0
                }
            ),
            0
        ),
        Err(Reject::NotAuthorized)
    );
    assert_eq!(m.snapshot().phase, Phase::Normal);
}
#[test]
fn enter_needs_both_capture_drain_and_android_ready_in_either_order() {
    for local_first in [false, true] {
        let mut m = mode();
        m.renew_lease(1, 15000, 0).unwrap();
        let s = m
            .handle(
                command(
                    1,
                    Action::Enter {
                        scene: Scene::Story,
                        epoch: 0,
                    },
                ),
                0,
            )
            .unwrap();
        assert_eq!(s.phase, Phase::Entering);
        assert!(!m.permits_audio(s.epoch, 1, 1));
        if local_first {
            assert_eq!(
                m.handle(command(2, Action::LocalReady { epoch: s.epoch }), 1)
                    .unwrap()
                    .phase,
                Phase::Entering
            );
            assert_eq!(
                m.capture_drained(s.epoch, 1).unwrap().phase,
                Phase::Listening
            );
        } else {
            assert_eq!(
                m.capture_drained(s.epoch, 1).unwrap().phase,
                Phase::Entering
            );
            assert_eq!(
                m.handle(command(2, Action::LocalReady { epoch: s.epoch }), 1)
                    .unwrap()
                    .phase,
                Phase::Listening
            );
        }
    }
}
#[test]
fn duplicates_do_not_grant_another_feedback_and_changed_payload_is_rejected() {
    let mut m = listening(Scene::Story);
    let c = command(
        3,
        Action::Feedback {
            epoch: m.snapshot().epoch,
        },
    );
    let s = m.handle(c.clone(), 20).unwrap();
    let replay = m.handle(c, 21).unwrap();
    assert!(replay.duplicate);
    assert_eq!(s.epoch, replay.epoch);
    assert_eq!(
        m.handle(
            command(
                3,
                Action::Exit {
                    epoch: m.snapshot().epoch
                }
            ),
            22
        ),
        Err(Reject::SequenceConflict)
    );
    let mut forged = command(
        4,
        Action::Feedback {
            epoch: m.snapshot().epoch,
        },
    );
    forged.request_id = "trace-1:3".into();
    assert_eq!(m.handle(forged, 23), Err(Reject::InvalidRequest));
}
#[test]
fn feedback_permit_is_consumed_once_and_frames_require_the_active_turn() {
    let mut m = listening(Scene::Sharing);
    let s = m
        .handle(
            command(
                3,
                Action::Feedback {
                    epoch: m.snapshot().epoch,
                },
            ),
            20,
        )
        .unwrap();
    assert_eq!(s.phase, Phase::FeedbackReserved);
    assert!(!m.permits_audio(s.epoch, 99, 21));
    m.begin_feedback(s.epoch, 99, 21).unwrap();
    assert!(m.permits_audio(s.epoch, 99, 22));
    assert!(!m.permits_audio(s.epoch, 100, 22));
    assert!(!m.permits_audio(s.epoch - 1, 99, 22));
    assert_eq!(m.begin_feedback(s.epoch, 100, 22), Err(Reject::NotReady));
    assert_eq!(m.feedback_done(98, 22), Err(Reject::StaleTurn));
    m.feedback_done(99, 22).unwrap();
    assert_eq!(m.snapshot().phase, Phase::Listening);
    assert!(!m.permits_audio(s.epoch, 99, 23));
}
#[test]
fn new_speech_cancels_reserved_or_playing_feedback_and_never_resumes_it() {
    for active in [false, true] {
        let mut m = listening(Scene::Story);
        let s = m
            .handle(
                command(
                    3,
                    Action::Feedback {
                        epoch: m.snapshot().epoch,
                    },
                ),
                20,
            )
            .unwrap();
        if active {
            m.begin_feedback(s.epoch, 5, 21).unwrap();
        }
        m.user_speech(20);
        assert_eq!(m.snapshot().phase, Phase::Listening);
        assert!(!m.permits_audio(s.epoch, 5, 22));
        assert_eq!(m.feedback_done(5, 22), Err(Reject::StaleTurn));
    }
}
#[test]
fn expired_lease_closes_output_even_before_tick_and_never_returns_to_chat() {
    let mut m = listening(Scene::Singing);
    let s = m
        .handle(
            command(
                3,
                Action::Feedback {
                    epoch: m.snapshot().epoch,
                },
            ),
            20,
        )
        .unwrap();
    m.begin_feedback(s.epoch, 5, 21).unwrap();
    assert!(!m.permits_audio(s.epoch, 5, 15000));
    m.tick(15000);
    assert_eq!(m.snapshot().phase, Phase::Paused);
    assert_eq!(
        m.handle(
            command(
                4,
                Action::Exit {
                    epoch: m.snapshot().epoch
                }
            ),
            15001
        ),
        Err(Reject::CloseRequired)
    );
    m.renew_lease(2, 30000, 15001).unwrap();
    assert_eq!(m.snapshot().phase, Phase::Paused);
}
#[test]
fn revoked_and_old_lease_versions_cannot_reenable_the_room() {
    let mut m = listening(Scene::Story);
    m.revoke(2);
    assert_eq!(m.renew_lease(1, 20000, 10000), Err(Reject::StalePolicy));
    assert_eq!(m.renew_lease(2, 20000, 10000), Err(Reject::StalePolicy));
    assert_eq!(m.snapshot().phase, Phase::Paused);
}
#[test]
fn bad_lease_deadlines_and_old_epoch_ready_are_rejected() {
    let mut m = mode();
    assert_eq!(m.renew_lease(1, 15001, 0), Err(Reject::InvalidLease));
    assert_eq!(m.renew_lease(1, 0, 0), Err(Reject::InvalidLease));
    m.renew_lease(1, 15000, 0).unwrap();
    let s = m
        .handle(
            command(
                1,
                Action::Enter {
                    scene: Scene::Story,
                    epoch: 0,
                },
            ),
            0,
        )
        .unwrap();
    assert_eq!(m.capture_drained(s.epoch + 1, 1), Err(Reject::StaleEpoch));
    assert_eq!(
        m.handle(command(2, Action::LocalReady { epoch: s.epoch + 1 }), 1),
        Err(Reject::StaleEpoch)
    );
    assert_eq!(m.snapshot().phase, Phase::Entering);
}
#[test]
fn explicit_exit_clears_scene_and_invalidates_prior_audio_epoch() {
    let mut m = listening(Scene::Story);
    let old = m.snapshot().epoch;
    let s = m
        .handle(
            command(
                3,
                Action::Exit {
                    epoch: m.snapshot().epoch,
                },
            ),
            30,
        )
        .unwrap();
    assert_eq!(s.phase, Phase::Normal);
    assert!(s.scene.is_none());
    assert!(s.listening_id.is_none());
    assert!(!m.permits_audio(old, 1, 31));
    assert!(m.permits_audio(s.epoch, 2, 31));
}
#[test]
fn evicted_old_sequence_cannot_execute_again() {
    let mut m = listening(Scene::Story);
    for n in 3..50 {
        m.handle(command(n, Action::State), n).unwrap();
    }
    assert_eq!(
        m.handle(
            command(
                1,
                Action::Enter {
                    scene: Scene::Story,
                    epoch: 0
                }
            ),
            50
        ),
        Err(Reject::StaleSequence)
    );
    assert_eq!(m.snapshot().phase, Phase::Listening);
}
#[test]
fn state_queries_cannot_reopen_expired_modes_and_new_entry_cannot_erase_active_story() {
    let mut m = listening(Scene::Story);
    let id = m.snapshot().listening_id;
    assert_eq!(
        m.handle(
            command(
                3,
                Action::Enter {
                    scene: Scene::Singing,
                    epoch: m.snapshot().epoch
                }
            ),
            20
        ),
        Err(Reject::NotReady)
    );
    assert_eq!(m.snapshot().listening_id, id);
    assert_eq!(
        m.handle(command(3, Action::State), 15000).unwrap().phase,
        Phase::Paused
    );
}
#[test]
fn maximum_session_deadline_pauses_even_if_lease_was_refreshed() {
    let mut m = listening(Scene::Story);
    for now in (5_000..1_800_000).step_by(5_000) {
        m.renew_lease(1, now + 15_000, now).unwrap();
    }
    assert_eq!(m.snapshot().phase, Phase::Listening);
    m.tick(1_800_000);
    assert_eq!(m.snapshot().phase, Phase::Paused);
}
#[test]
fn late_feedback_from_a_previous_epoch_cannot_start_another_reply() {
    let mut m = listening(Scene::Story);
    let before = m.snapshot().epoch;
    let s = m
        .handle(command(3, Action::Feedback { epoch: before }), 20)
        .unwrap();
    m.begin_feedback(s.epoch, 1, 21).unwrap();
    m.feedback_done(1, 22).unwrap();
    assert_eq!(
        m.handle(command(4, Action::Feedback { epoch: before }), 22),
        Err(Reject::StaleEpoch)
    );
}

fn buffer() -> ListeningBuffer {
    ListeningBuffer::new(12, 4, 6).unwrap()
}
#[test]
fn buffer_revisions_replace_instead_of_append_and_duplicates_are_ignored() {
    let mut b = buffer();
    assert_eq!(b.upsert(1, 1, "小熊上山"), Update::Added);
    assert_eq!(b.upsert(1, 1, "小熊上山"), Update::Duplicate);
    assert_eq!(b.upsert(1, 2, "小熊下山"), Update::Revised);
    assert_eq!(b.upsert(1, 1, "旧文本"), Update::Stale);
    assert_eq!(b.context().recent, "小熊下山");
    assert_eq!(b.raw_chars(), 4);
}
#[test]
fn buffer_bounds_unicode_by_chars_and_marks_content_loss() {
    let mut b = buffer();
    b.upsert(1, 1, "一二三四五六七八九十甲乙丙丁");
    assert!(b.raw_chars() <= 12);
    assert!(b.context().has_gap);
    assert!(b.context().recent.ends_with("甲乙丙丁"));
}
#[test]
fn summary_commits_only_the_frozen_prefix_and_keeps_new_tail() {
    let mut b = ListeningBuffer::new(20, 4, 6).unwrap();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    b.upsert(3, 1, "后来呢");
    let ticket = b.summary_ticket().unwrap();
    b.upsert(4, 1, "好呀");
    assert!(b.apply_summary(ticket, "熊兔各自回家"));
    let c = b.context();
    assert_eq!(c.summary.as_deref(), Some("熊兔各自回家"));
    assert!(c.recent.ends_with("好呀"));
    assert!(b.raw_chars() <= 20);
}
#[test]
fn summary_cannot_delete_revised_source_or_replace_a_newer_summary() {
    let mut b = buffer();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    b.upsert(3, 1, "后来呢");
    let stale = b.summary_ticket().unwrap();
    b.upsert(1, 2, "小熊下山");
    assert!(!b.apply_summary(stale, "上山"));
    assert!(b.context().summary.is_none());
    let fresh = b.summary_ticket().unwrap();
    let replay = fresh.clone();
    assert!(b.apply_summary(fresh, "下山"));
    assert!(!b.apply_summary(replay, "旧摘要"));
}
#[test]
fn too_late_revision_invalidates_summary_instead_of_claiming_complete_memory() {
    let mut b = buffer();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    b.upsert(3, 1, "后来呢");
    let t = b.summary_ticket().unwrap();
    assert!(b.apply_summary(t, "上山"));
    assert_eq!(b.upsert(1, 2, "其实下山"), Update::Compacted);
    assert!(b.context().summary.is_none());
    assert!(b.context().has_gap);
}
#[test]
fn oversized_summary_is_rejected_without_losing_source() {
    let mut b = buffer();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    b.upsert(3, 1, "后来呢");
    let n = b.raw_chars();
    let t = b.summary_ticket().unwrap();
    assert!(!b.apply_summary(t, "一二三四五六七"));
    assert_eq!(b.raw_chars(), n);
}
#[test]
fn segment_gaps_and_same_revision_conflicts_are_visible() {
    let mut b = ListeningBuffer::new(12, 6, 6).unwrap();
    b.upsert(1, 1, "小熊");
    b.upsert(3, 1, "小兔");
    assert!(b.context().has_gap);
    assert_eq!(b.upsert(3, 1, "小鹿"), Update::Conflict);
    assert_eq!(b.context().recent, "小熊\n小兔");
}
#[test]
fn empty_and_invalid_limits_do_not_create_fake_story_content() {
    assert!(ListeningBuffer::new(0, 4, 6).is_none());
    let mut b = buffer();
    assert_eq!(b.upsert(0, 1, "假序号"), Update::Invalid);
    assert_eq!(b.upsert(1, 0, "假版本"), Update::Invalid);
    assert_eq!(b.upsert(1, 1, "  "), Update::Invalid);
    assert!(b.summary_ticket().is_none());
}

#[test]
fn renewal_after_expiry_cannot_hide_the_expired_interval() {
    let mut m = listening(Scene::Story);
    m.renew_lease(1, 30000, 15000).unwrap();
    assert_eq!(m.snapshot().phase, Phase::Paused);
}
#[test]
fn retransmitted_compacted_source_preserves_valid_summary() {
    let mut b = buffer();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    let t = b.summary_ticket().unwrap();
    assert_eq!(t.text(), "小熊上山");
    assert!(t.previous_summary.is_none());
    assert!(b.apply_summary(t, "上山"));
    assert_eq!(b.upsert(1, 1, "小熊上山"), Update::Duplicate);
    assert_eq!(b.context().summary.as_deref(), Some("上山"));
    assert_eq!(b.upsert(1, 1, "小熊下山"), Update::Conflict);
}
#[test]
fn clipped_source_retransmission_is_still_a_duplicate() {
    let mut b = buffer();
    let text = "一二三四五六七八九十甲乙丙丁";
    b.upsert(1, 1, text);
    assert_eq!(b.upsert(1, 1, text), Update::Duplicate);
}
#[test]
fn unsummarized_context_omission_is_visible() {
    let mut b = buffer();
    b.upsert(1, 1, "小熊上山");
    b.upsert(2, 1, "小兔回家");
    assert!(b.context().has_gap);
    assert_eq!(b.context().recent, "小兔回家");
    let t = b.summary_ticket().unwrap();
    assert!(b.apply_summary(t, "上山"));
    assert!(!b.context().has_gap);
}
#[test]
fn summary_cannot_cross_buffer_instances() {
    let mut a = buffer();
    let mut b = buffer();
    for target in [&mut a, &mut b] {
        target.upsert(1, 1, "小熊上山");
        target.upsert(2, 1, "小兔回家");
    }
    assert!(!b.apply_summary(a.summary_ticket().unwrap(), "上山"));
}
#[test]
fn speech_started_before_request_prevents_feedback() {
    let mut m = listening(Scene::Singing);
    m.user_speech(20);
    assert!(m
        .handle(
            command(
                3,
                Action::Feedback {
                    epoch: m.snapshot().epoch
                }
            ),
            20
        )
        .is_err());
}

#[test]
fn late_completion_cannot_acknowledge_listening_after_expiry() {
    let mut m = mode();
    m.renew_lease(1, 15000, 0).unwrap();
    let s = m
        .handle(
            command(
                1,
                Action::Enter {
                    scene: Scene::Story,
                    epoch: 0,
                },
            ),
            0,
        )
        .unwrap();
    m.handle(command(2, Action::LocalReady { epoch: s.epoch }), 1)
        .unwrap();
    assert!(m.capture_drained(s.epoch, 15000).is_err());
    assert_eq!(m.snapshot().phase, Phase::Paused);
    let mut m = listening(Scene::Story);
    let s = m
        .handle(
            command(
                3,
                Action::Feedback {
                    epoch: m.snapshot().epoch,
                },
            ),
            20,
        )
        .unwrap();
    m.begin_feedback(s.epoch, 1, 21).unwrap();
    assert!(m.feedback_done(1, 15000).is_err());
    assert_eq!(m.snapshot().phase, Phase::Paused);
}
#[test]
fn new_feedback_requires_speech_end_and_old_entry_cannot_reenter() {
    let mut m = listening(Scene::Story);
    m.user_speech(20);
    m.user_speech_ended(21);
    let s = m
        .handle(
            command(
                3,
                Action::Feedback {
                    epoch: m.snapshot().epoch,
                },
            ),
            22,
        )
        .unwrap();
    m.begin_feedback(s.epoch, 1, 23).unwrap();
    m.user_speech(24);
    assert!(!m.permits_audio(s.epoch, 1, 25));
    m.handle(
        command(
            4,
            Action::Exit {
                epoch: m.snapshot().epoch,
            },
        ),
        26,
    )
    .unwrap();
    assert_eq!(
        m.handle(
            command(
                5,
                Action::Enter {
                    scene: Scene::Story,
                    epoch: 0
                }
            ),
            27
        ),
        Err(Reject::StaleEpoch)
    );
}
