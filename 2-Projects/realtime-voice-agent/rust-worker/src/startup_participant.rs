//! Recovery is restricted to startup: no SearchSession/ordered turn exists yet.
//! An established pipeline must close normally; rebuilding it in the same room
//! would race the durable search session close and reuse first-turn state.
pub const STARTUP_BUDGET_MS: u64 = 60_000;

#[derive(Debug, PartialEq)]
pub enum Departure { Ignore, AwaitReplacement, Close }

pub struct StartupParticipant {
    identity: Option<String>,
    sid: Option<String>,
    started: bool,
    deadline_ms: u64,
    departed: bool,
}
impl StartupParticipant {
    pub fn new(identity: Option<String>) -> Self {
        Self { identity, sid: None, started: false, deadline_ms: STARTUP_BUDGET_MS, departed: false }
    }
    pub fn accepts(&self, identity: &str, sid: &str) -> bool {
        self.identity.as_deref().is_none_or(|i| i == identity)
            && self.sid.as_deref().is_none_or(|s| s == sid)
            && !self.departed
    }
    /// Only called for a participant still current in the SDK snapshot.
    /// Returns true when startup resources from a previous SID need discarding.
    pub fn connected(&mut self, identity: &str, sid: &str, now_ms: u64) -> bool {
        if self.identity.as_deref() != Some(identity) || self.started { return false; }
        let replaced = self.departed || self.sid.as_deref().is_some_and(|s| s != sid);
        if replaced { self.deadline_ms = (now_ms + 10_000).min(STARTUP_BUDGET_MS); }
        self.sid = Some(sid.into());
        self.departed = false;
        replaced
    }
    pub fn started(&mut self, identity: &str, sid: &str) {
        self.identity = Some(identity.into());
        self.sid = Some(sid.into());
        self.started = true;
    }
    pub fn disconnected(&mut self, identity: &str, sid: &str, now_ms: u64) -> Departure {
        // Non-device debug rooms keep the original teardown contract.
        if self.identity.is_none() { return Departure::Close; }
        if self.identity.as_deref() != Some(identity)
            || self.sid.as_deref().is_some_and(|s| s != sid) || self.departed {
            return Departure::Ignore;
        }
        if self.started { return Departure::Close; }
        self.sid = Some(sid.into());
        self.departed = true;
        self.deadline_ms = (now_ms + 3_000).min(self.deadline_ms);
        Departure::AwaitReplacement
    }
    pub fn expired(&self, now_ms: u64) -> bool { !self.started && now_ms >= self.deadline_ms }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device() -> StartupParticipant { StartupParticipant::new(Some("dev-SN".into())) }
    #[test] fn duplicate_before_mic_preserves_replacement() {
        let mut p=device(); p.connected("dev-SN","old",0);
        assert_eq!(p.disconnected("dev-SN","old",4_000),Departure::AwaitReplacement);
        assert!(!p.expired(4_010)); assert!(p.connected("dev-SN","new",4_010));
        assert_eq!(p.disconnected("dev-SN","old",4_020),Departure::Ignore);
        assert!(!p.accepts("dev-SN","old")); assert!(p.accepts("dev-SN","new"));
        p.started("dev-SN","new"); assert!(!p.expired(90_000));
        assert_eq!(p.disconnected("dev-SN","new",90_001),Departure::Close);
    }
    #[test] fn connected_before_old_departure_is_safe() {
        let mut p=device();p.connected("dev-SN","old",0);assert!(p.connected("dev-SN","new",10));
        assert_eq!(p.disconnected("dev-SN","old",11),Departure::Ignore);
        p.started("dev-SN","new");assert_eq!(p.disconnected("dev-SN","old",12),Departure::Ignore);
    }
    #[test] fn real_departure_has_bounded_grace() {
        let mut p=device(); p.connected("dev-SN","old",0);
        assert_eq!(p.disconnected("dev-SN","old",100),Departure::AwaitReplacement);
        assert!(!p.expired(3099));assert!(p.expired(3100));
        assert_eq!(p.disconnected("dev-SN","old",2000),Departure::Ignore);
        assert!(p.expired(3100));
    }
    #[test] fn foreign_participant_neither_closes_nor_extends() {
        let mut p=device();p.connected("dev-SN","old",0);
        assert!(!p.connected("observer","x",59_000));assert!(!p.accepts("observer","x"));
        assert_eq!(p.disconnected("observer","x",59_001),Departure::Ignore);assert!(p.expired(60_000));
    }
    #[test] fn replacement_without_microphone_is_bounded() {
        let mut p=device();p.connected("dev-SN","old",0);p.disconnected("dev-SN","old",100);
        p.connected("dev-SN","new",200);assert!(!p.expired(10_199));assert!(p.expired(10_200));
    }
    #[test] fn replacement_storm_cannot_extend_total_startup_budget() {
        let mut p=device();for i in 0..60 {p.connected("dev-SN",&i.to_string(),i*1_000);}
        assert!(p.expired(60_000));
    }
    #[test] fn active_pipeline_keeps_terminal_close_contract() {
        let mut p=device();p.connected("dev-SN","old",0);p.started("dev-SN","old");
        assert!(!p.connected("dev-SN","new",20));assert!(!p.accepts("dev-SN","new"));
        assert_eq!(p.disconnected("dev-SN","old",21),Departure::Close);
    }
    #[test] fn legacy_room_departure_closes() {
        assert_eq!(StartupParticipant::new(None).disconnected("web","p",0),Departure::Close);
    }
}
