//! A terminal conversation close outlives client ACK/cancel and late ASR.
//! Audio stops immediately; allow the existing 800 ms signal retries before
//! ending the pipeline, whose job cleanup deletes the LiveKit room.
use std::time::{Duration, Instant};

pub const SIGNAL_GRACE: Duration = Duration::from_millis(2500);

#[derive(Default)]
pub struct CloseDeadline(Option<Instant>);

impl CloseDeadline {
    pub fn begin(&mut self, now: Instant) -> bool {
        if self.0.is_some() { return false; }
        self.0 = Some(now + SIGNAL_GRACE);
        true
    }
    pub fn active(&self) -> bool { self.0.is_some() }
    pub fn due(&self, now: Instant) -> bool { self.0.is_some_and(|d| now >= d) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_deadline_is_bounded_and_never_extended_by_duplicates() {
        let now = Instant::now();
        let mut close = CloseDeadline::default();
        assert!(!close.active());
        assert!(!close.due(now + SIGNAL_GRACE));
        assert!(close.begin(now));
        assert!(close.active());
        assert!(!close.begin(now + Duration::from_secs(2)));
        assert!(!close.due(now + SIGNAL_GRACE - Duration::from_millis(1)));
        assert!(close.due(now + SIGNAL_GRACE));
    }
}
