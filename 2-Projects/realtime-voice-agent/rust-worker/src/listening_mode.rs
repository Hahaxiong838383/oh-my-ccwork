//! Pure listening state contract, not yet wired into production audio.
//! Caller authenticates participant, signed job and lease before using this module.
//! All times use the same monotonic clock. No audio, network, transcript or persistence here.
use std::collections::VecDeque;

pub const LEASE_TTL_MS: u64 = 15_000;
pub const MAX_SESSION_MS: u64 = 1_800_000;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const RECENT_COMMANDS: usize = 32;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scene {
    Story,
    Sharing,
    Singing,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Normal,
    Entering,
    Listening,
    FeedbackReserved,
    FeedbackActive,
    Paused,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Enter { scene: Scene, epoch: u64 },
    LocalReady { epoch: u64 },
    Feedback { epoch: u64 },
    Exit { epoch: u64 },
    State,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub seq: u64,
    pub request_id: String,
    pub action: Action,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub phase: Phase,
    pub epoch: u64,
    pub scene: Option<Scene>,
    pub listening_id: Option<String>,
    pub duplicate: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    InvalidRequest,
    NotAuthorized,
    SequenceConflict,
    StaleSequence,
    NotReady,
    StaleEpoch,
    StaleTurn,
    CloseRequired,
    StalePolicy,
    InvalidLease,
    UserSpeaking,
}
pub struct ListeningMode {
    trace: String,
    phase: Phase,
    epoch: u64,
    scene: Option<Scene>,
    listening_id: Option<String>,
    session_deadline: u64,
    policy_version: u64,
    revoked: bool,
    lease_until: u64,
    local_ready: bool,
    capture_done: bool,
    active_turn: Option<u64>,
    user_speaking: bool,
    high_sequence: u64,
    recent: VecDeque<Command>,
}
impl ListeningMode {
    pub fn new(trace: &str) -> Result<Self, Reject> {
        if trace.is_empty()
            || trace.len() > 64
            || !trace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(Reject::InvalidRequest);
        }
        Ok(Self {
            trace: trace.into(),
            phase: Phase::Normal,
            epoch: 0,
            scene: None,
            listening_id: None,
            session_deadline: 0,
            policy_version: 0,
            revoked: false,
            lease_until: 0,
            local_ready: false,
            capture_done: false,
            active_turn: None,
            user_speaking: false,
            high_sequence: 0,
            recent: VecDeque::new(),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            phase: self.phase,
            epoch: self.epoch,
            scene: self.scene,
            listening_id: self.listening_id.clone(),
            duplicate: false,
        }
    }
    pub fn renew_lease(&mut self, version: u64, until: u64, now: u64) -> Result<(), Reject> {
        self.tick(now);
        if version == 0 || until <= now || until - now > LEASE_TTL_MS {
            return Err(Reject::InvalidLease);
        }
        if version < self.policy_version
            || (version == self.policy_version && (self.revoked || until < self.lease_until))
        {
            return Err(Reject::StalePolicy);
        }
        self.policy_version = version;
        self.revoked = false;
        self.lease_until = until;
        // A refreshed lease never silently restores a paused session.
        Ok(())
    }
    pub fn revoke(&mut self, version: u64) {
        if version < self.policy_version {
            return;
        }
        self.policy_version = version;
        self.revoked = true;
        self.lease_until = 0;
        if self.phase != Phase::Normal {
            self.pause();
        }
    }
    fn authorized(&self, now: u64) -> bool {
        self.policy_version > 0 && !self.revoked && now < self.lease_until
    }
    fn change_phase(&mut self, phase: Phase) {
        self.epoch += 1;
        self.phase = phase;
        self.active_turn = None;
    }
    fn pause(&mut self) {
        if self.phase != Phase::Paused {
            self.change_phase(Phase::Paused);
        }
    }
    fn finish_entry(&mut self) {
        // This is completion of the same entry, not a new output generation.
        if self.local_ready && self.capture_done {
            self.phase = Phase::Listening;
        }
    }
    pub fn handle(&mut self, cmd: Command, now: u64) -> Result<Snapshot, Reject> {
        self.tick(now);
        if cmd.seq == 0
            || cmd.seq > MAX_SEQUENCE
            || cmd.request_id != format!("{}:{}", self.trace, cmd.seq)
        {
            return Err(Reject::InvalidRequest);
        }
        if cmd.seq <= self.high_sequence {
            if let Some(previous) = self.recent.iter().find(|c| c.seq == cmd.seq) {
                if previous != &cmd {
                    return Err(Reject::SequenceConflict);
                }
                let mut current = self.snapshot();
                current.duplicate = true;
                return Ok(current);
            }
            return Err(Reject::StaleSequence);
        }
        match cmd.action {
            Action::State => {}
            Action::Enter { scene, epoch } => {
                if epoch != self.epoch {
                    return Err(Reject::StaleEpoch);
                }
                if self.phase != Phase::Normal {
                    return Err(Reject::NotReady);
                }
                if !self.authorized(now) {
                    return Err(Reject::NotAuthorized);
                }
                self.session_deadline = now.saturating_add(MAX_SESSION_MS);
                self.scene = Some(scene);
                self.listening_id = Some(cmd.request_id.clone());
                self.local_ready = false;
                self.capture_done = false;
                self.change_phase(Phase::Entering);
            }
            Action::LocalReady { epoch } => {
                if epoch != self.epoch {
                    return Err(Reject::StaleEpoch);
                }
                if self.phase != Phase::Entering {
                    return Err(Reject::NotReady);
                }
                self.local_ready = true;
                self.finish_entry();
            }
            Action::Feedback { epoch } => {
                if epoch != self.epoch {
                    return Err(Reject::StaleEpoch);
                }
                if self.phase != Phase::Listening {
                    return Err(Reject::NotReady);
                }
                if self.user_speaking {
                    return Err(Reject::UserSpeaking);
                }
                // Permission is reserved only after the new epoch is authoritative.
                self.change_phase(Phase::FeedbackReserved);
            }
            Action::Exit { epoch } => {
                if self.phase == Phase::Paused {
                    return Err(Reject::CloseRequired);
                }
                if epoch != self.epoch {
                    return Err(Reject::StaleEpoch);
                }
                if self.phase == Phase::Normal {
                    return Err(Reject::NotReady);
                }
                self.change_phase(Phase::Normal);
                self.scene = None;
                self.listening_id = None;
                self.local_ready = false;
                self.capture_done = false;
                self.session_deadline = 0;
            }
        }
        self.high_sequence = cmd.seq;
        self.recent.push_back(cmd);
        if self.recent.len() > RECENT_COMMANDS {
            self.recent.pop_front();
        }
        Ok(self.snapshot())
    }
    pub fn capture_drained(&mut self, epoch: u64, now: u64) -> Result<Snapshot, Reject> {
        self.tick(now);
        if epoch != self.epoch {
            return Err(Reject::StaleEpoch);
        }
        if self.phase != Phase::Entering {
            return Err(Reject::NotReady);
        }
        self.capture_done = true;
        self.finish_entry();
        Ok(self.snapshot())
    }
    pub fn begin_feedback(&mut self, epoch: u64, turn: u64, now: u64) -> Result<(), Reject> {
        self.tick(now);
        if epoch != self.epoch {
            return Err(Reject::StaleEpoch);
        }
        if self.user_speaking {
            return Err(Reject::UserSpeaking);
        }
        if self.phase != Phase::FeedbackReserved || turn == 0 {
            return Err(Reject::NotReady);
        }
        self.phase = Phase::FeedbackActive;
        self.active_turn = Some(turn);
        Ok(())
    }
    pub fn feedback_done(&mut self, turn: u64, now: u64) -> Result<(), Reject> {
        self.tick(now);
        if self.phase != Phase::FeedbackActive || self.active_turn != Some(turn) {
            return Err(Reject::StaleTurn);
        }
        self.change_phase(Phase::Listening);
        Ok(())
    }
    pub fn user_speech(&mut self, now: u64) {
        self.tick(now);
        self.user_speaking = true;
        if matches!(self.phase, Phase::FeedbackReserved | Phase::FeedbackActive) {
            self.change_phase(Phase::Listening);
        }
    }
    pub fn user_speech_ended(&mut self, now: u64) {
        self.tick(now);
        self.user_speaking = false;
    }
    pub fn tick(&mut self, now: u64) {
        if self.phase != Phase::Normal
            && self.phase != Phase::Paused
            && (!self.authorized(now) || now >= self.session_deadline)
        {
            self.pause();
        }
    }
    pub fn permits_audio(&self, epoch: u64, turn: u64, now: u64) -> bool {
        if epoch != self.epoch {
            return false;
        }
        if self.phase == Phase::Normal {
            return true;
        }
        self.phase == Phase::FeedbackActive
            && !self.user_speaking
            && self.active_turn == Some(turn)
            && self.authorized(now)
            && now < self.session_deadline
    }
}
