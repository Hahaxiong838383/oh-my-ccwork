//! Worker-owned mode adapter. Authentication precedes every control mutation.
//! Capture admission and mode changes share a lock; no lock is held across audio IO.
use crate::listening_buffer::{Context, ListeningBuffer};
use crate::listening_mode::*;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone)]
pub struct Binding {
    pub room: String,
    pub session: String,
    pub trace: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputPurpose {
    Ordinary,
    Feedback,
    Search,
    Device,
}
struct Shared {
    mode: ListeningMode,
    captures: usize,
    voice_transition: bool,
    output: Option<(u64, u64, OutputPurpose)>,
}
#[derive(Clone)]
pub struct AudioPermit {
    shared: Arc<Mutex<Shared>>,
    epoch: u64,
    turn: u64,
    purpose: OutputPurpose,
    anchor: Instant,
}
pub struct CaptureTicket {
    shared: Arc<Mutex<Shared>>,
}
impl Drop for CaptureTicket {
    fn drop(&mut self) {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.captures = shared.captures.saturating_sub(1);
    }
}
fn purpose_allowed(
    mode: &ListeningMode,
    purpose: OutputPurpose,
    epoch: u64,
    turn: u64,
    now: u64,
) -> bool {
    let phase = mode.snapshot().phase;
    let purpose_ok = if phase == Phase::Normal {
        purpose != OutputPurpose::Feedback
    } else {
        purpose == OutputPurpose::Feedback
    };
    purpose_ok && mode.permits_audio(epoch, turn, now)
}
impl AudioPermit {
    pub fn allowed(&self) -> bool {
        self.allowed_at(self.anchor.elapsed().as_millis() as u64)
    }
    pub fn begin_capture(&self) -> Option<CaptureTicket> {
        self.begin_capture_at(self.anchor.elapsed().as_millis() as u64)
    }
    pub fn allowed_at(&self, now: u64) -> bool {
        self.shared
            .lock()
            .map(|s| {
                !s.voice_transition
                    && s.output == Some((self.epoch, self.turn, self.purpose))
                    && purpose_allowed(&s.mode, self.purpose, self.epoch, self.turn, now)
            })
            .unwrap_or(false)
    }
    pub fn begin_capture_at(&self, now: u64) -> Option<CaptureTicket> {
        let mut s = self.shared.lock().ok()?;
        if s.voice_transition
            || s.output != Some((self.epoch, self.turn, self.purpose))
            || !purpose_allowed(&s.mode, self.purpose, self.epoch, self.turn, now)
        {
            return None;
        }
        s.captures += 1;
        Some(CaptureTicket {
            shared: self.shared.clone(),
        })
    }
}
pub struct ListeningSession {
    pub binding: Binding,
    expected_participant: String,
    shared: Arc<Mutex<Shared>>,
    anchor: Instant,
    entry: Option<Command>,
    entry_deadline: Option<u64>,
    buffer: ListeningBuffer,
    segment: u64,
}
impl ListeningSession {
    pub fn new(binding: Binding) -> Result<Self, Reject> {
        let (sn, suffix) = binding
            .room
            .strip_prefix("sn-")
            .and_then(|r| r.rsplit_once('-'))
            .ok_or(Reject::InvalidRequest)?;
        if sn.len() != 20
            || !sn.starts_with("BJP003")
            || !sn[6..].bytes().all(|b| b.is_ascii_digit())
            || suffix.is_empty()
            || suffix.len() > 20
            || !suffix.bytes().all(|b| b.is_ascii_digit())
            || binding.session.is_empty()
            || binding.session.len() > 128
            || !binding
                .session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(Reject::InvalidRequest);
        }
        let expected_participant = format!("dev-{sn}");
        let mode = ListeningMode::new(&binding.trace)?;
        Ok(Self {
            binding,
            expected_participant,
            shared: Arc::new(Mutex::new(Shared {
                mode,
                captures: 0,
                voice_transition: false,
                output: None,
            })),
            anchor: Instant::now(),
            entry: None,
            entry_deadline: None,
            buffer: ListeningBuffer::new(12000, 4000, 1200).unwrap(),
            segment: 0,
        })
    }
    #[cfg(test)]
    pub fn advance_clock(&mut self, ms: u64) {
        self.anchor -= std::time::Duration::from_millis(ms);
    }
    pub fn now_ms(&self) -> u64 {
        self.anchor.elapsed().as_millis() as u64
    }
    pub fn renew_lease(&mut self, revision: u64, until: u64, now: u64) -> Result<(), Reject> {
        self.shared
            .lock()
            .map_err(|_| Reject::NotAuthorized)?
            .mode
            .renew_lease(revision, until, now)
    }
    pub fn precheck(&self, c: &Command) -> Result<Option<Snapshot>, Reject> {
        self.shared
            .lock()
            .map_err(|_| Reject::NotAuthorized)?
            .mode
            .precheck(c)
    }
    pub fn authenticated(&self, participant: Option<&str>, trace: &str) -> bool {
        participant == Some(self.expected_participant.as_str()) && trace == self.binding.trace
    }
    pub fn configure(&mut self, session_ms: u64, duration_ms: u64, cooldown_ms: u64) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.configure(session_ms, duration_ms, cooldown_ms);
        }
    }
    pub fn reserve_voice_feedback(&mut self, epoch: u64, now: u64) -> Result<(), Reject> {
        self.shared
            .lock()
            .map_err(|_| Reject::NotAuthorized)?
            .mode
            .reserve_voice_feedback(epoch, now)
    }
    pub fn cancel_feedback(&mut self) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.cancel_feedback();
        }
    }
    pub fn summary_ticket(&self) -> Option<crate::listening_buffer::SummaryTicket> {
        self.buffer.summary_ticket()
    }
    pub fn apply_summary(&mut self, t: crate::listening_buffer::SummaryTicket, text: &str) -> bool {
        self.buffer.apply_summary(t, text)
    }
    pub fn raw_chars(&self) -> usize {
        self.buffer.raw_chars()
    }
    pub fn control(
        &mut self,
        participant: Option<&str>,
        trace: &str,
        command: Command,
        now: u64,
    ) -> Result<Snapshot, Reject> {
        if participant != Some(self.expected_participant.as_str()) || trace != self.binding.trace {
            return Err(Reject::NotAuthorized);
        }
        let mut shared = self.shared.lock().map_err(|_| Reject::NotAuthorized)?;
        let snapshot = shared.mode.handle(command.clone(), now)?;
        if matches!(command.action, Action::Enter { .. }) && !snapshot.duplicate {
            self.entry = Some(command);
            self.entry_deadline = Some(now.saturating_add(5000));
            self.buffer = ListeningBuffer::new(12000, 4000, 1200).unwrap();
            self.segment = 0;
        }
        if snapshot.phase != Phase::Entering {
            self.entry_deadline = None;
        }
        Ok(snapshot)
    }
    pub fn snapshot(&self) -> Snapshot {
        self.shared
            .lock()
            .map(|s| s.mode.snapshot())
            .unwrap_or(Snapshot {
                phase: Phase::Paused,
                epoch: u64::MAX,
                scene: None,
                listening_id: None,
                duplicate: false,
            })
    }
    pub fn hold_voice_transition(&mut self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.voice_transition = true;
            shared.output = None;
        }
    }
    pub fn release_voice_transition(&mut self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.voice_transition = false;
            shared.output = None;
        }
    }
    pub fn active(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.voice_transition || s.mode.snapshot().phase != Phase::Normal)
            .unwrap_or(true)
    }
    pub fn output_permit(
        &self,
        purpose: OutputPurpose,
        turn: u64,
        now: u64,
    ) -> Option<AudioPermit> {
        let mut shared = self.shared.lock().ok()?;
        let epoch = shared.mode.snapshot().epoch;
        if shared.voice_transition
            || turn == 0
            || !purpose_allowed(&shared.mode, purpose, epoch, turn, now)
        {
            return None;
        }
        shared.output = Some((epoch, turn, purpose));
        let permit = AudioPermit {
            shared: self.shared.clone(),
            epoch,
            turn,
            purpose,
            anchor: self.anchor,
        };
        Some(permit)
    }
    pub fn capture_is_drained(&self) -> bool {
        self.shared.lock().map(|s| s.captures == 0).unwrap_or(false)
    }
    /// Caller must clear the NativeAudioSource AFTER this drain, BEFORE sending completed.
    pub fn capture_drained(&mut self, epoch: u64, now: u64) -> Result<Snapshot, Reject> {
        let mut shared = self.shared.lock().map_err(|_| Reject::NotAuthorized)?;
        if shared.captures != 0 {
            return Err(Reject::NotReady);
        }
        let snapshot = shared.mode.capture_drained(epoch, now)?;
        if snapshot.phase != Phase::Entering {
            self.entry_deadline = None;
        }
        Ok(snapshot)
    }
    pub fn entry_command(&self) -> Option<&Command> {
        self.entry.as_ref()
    }
    pub fn begin_feedback(&mut self, epoch: u64, turn: u64, now: u64) -> Result<(), Reject> {
        self.shared
            .lock()
            .map_err(|_| Reject::NotAuthorized)?
            .mode
            .begin_feedback(epoch, turn, now)
    }
    pub fn feedback_done(&mut self, turn: u64, now: u64) -> Result<(), Reject> {
        self.shared
            .lock()
            .map_err(|_| Reject::NotAuthorized)?
            .mode
            .feedback_done(turn, now)
    }
    pub fn input_active(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.mode.input_active())
            .unwrap_or(true)
    }
    pub fn speech_start(&mut self, now: u64) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.user_speech(now);
        }
    }
    pub fn speech_end(&mut self, now: u64) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.user_speech_ended(now);
        }
    }
    pub fn final_text(&mut self, text: &str) {
        if self.active() && self.snapshot().phase != Phase::Paused {
            self.segment += 1;
            self.buffer.upsert(self.segment, 1, text);
        }
    }
    /// Restore text accepted before command classification, even if its mode lease
    /// has since ended. The entry key binds this to the original buffer, not a new
    /// mode epoch; this grants no input, feedback, output, or lease permission.
    pub fn restore_held_text(&mut self, entry_request_id: &str, text: &str) -> bool {
        if self.entry.as_ref().map(|e| e.request_id.as_str()) != Some(entry_request_id) {
            return false;
        }
        self.segment += 1;
        self.buffer.upsert(self.segment, 1, text);
        true
    }
    pub fn context(&self) -> Context {
        self.buffer.context()
    }
    pub fn pause_pending_entry(&mut self) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.pause_pending_entry();
        }
    }
    pub fn tick(&mut self, now: u64) {
        if let Ok(mut s) = self.shared.lock() {
            s.mode.tick(now);
            if s.mode.snapshot().phase == Phase::Entering
                && self.entry_deadline.map(|d| now >= d).unwrap_or(false)
            {
                s.mode.pause_unavailable();
                self.entry_deadline = None;
            }
        }
    }
}
