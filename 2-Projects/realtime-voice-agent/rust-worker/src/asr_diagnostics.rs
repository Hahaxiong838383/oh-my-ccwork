//! Bounded metadata only. Enqueue success is NOT provider receipt. A completed
//! websocket sink write is NOT recognition. Neither counter contains PCM/text.
use std::{sync::{Arc, Mutex}, time::{Instant, SystemTime, UNIX_EPOCH}};
use serde::Serialize;
use tokio::sync::mpsc;

#[derive(Default, Debug, Clone, Serialize)]
pub struct PcmCount { pub samples: u64, pub nonzero: u64, pub abs_sum: u64, pub peak: u16 }
impl PcmCount {
    pub fn push(&mut self, pcm: &[i16]) {
        self.samples = self.samples.saturating_add(pcm.len() as u64);
        for s in pcm {
            let a = s.unsigned_abs();
            self.nonzero = self.nonzero.saturating_add(u64::from(a != 0));
            self.abs_sum = self.abs_sum.saturating_add(u64::from(a));
            self.peak = self.peak.max(a);
        }
    }
}

#[derive(Default, Debug, Clone, Serialize)]
pub struct QueueStats {
    pub accepted: PcmCount, pub full: PcmCount, pub closed: PcmCount,
    pub rtc_seen: PcmCount, pub rtc_ignored_before_switch: PcmCount,
    pub observed_high_water_blocks: usize, pub phase: &'static str,
}
pub struct InputDiagnostic { pub id: String, state: Mutex<QueueStats> }
impl InputDiagnostic {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { id: uuid::Uuid::new_v4().to_string(), state: Mutex::new(QueueStats { phase: "preconnect", ..Default::default() }) })
    }
    pub fn for_room(room: &str) -> Option<Arc<Self>> {
        let until = std::env::var("P003_ASR_DIAGNOSTICS_UNTIL_MS").ok()?.parse::<u64>().ok()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
        let allow = std::env::var("P003_ASR_DIAGNOSTICS_SN_ALLOW").ok()?;
        if !enabled_for(room, &allow, until, now) { return None; }
        Some(Self::new())
    }
    pub fn phase(&self, phase: &'static str) { self.state.lock().unwrap_or_else(|p| p.into_inner()).phase = phase; }
    pub fn snapshot(&self) -> QueueStats { self.state.lock().unwrap_or_else(|p| p.into_inner()).clone() }
}
fn enabled_for(room: &str, allow: &str, until: u64, now: u64) -> bool {
    let Some(sn)=room.strip_prefix("sn-").and_then(|s|s.split('-').next()) else {return false};
    now < until && !sn.is_empty() && allow.split(',').any(|v| !v.trim().is_empty() && v.trim()==sn)
}
impl Drop for InputDiagnostic {
    fn drop(&mut self) {
        tracing::info!(input_generation=%self.id, stats=%serde_json::to_string(&self.snapshot()).unwrap_or_default(), "asr diagnostic input summary");
    }
}

#[derive(Clone)]
pub struct PcmSender { inner: mpsc::Sender<Vec<i16>>, pub diagnostic: Option<Arc<InputDiagnostic>> }
impl From<mpsc::Sender<Vec<i16>>> for PcmSender {
    fn from(inner: mpsc::Sender<Vec<i16>>) -> Self { Self { inner, diagnostic: None } }
}
impl PcmSender {
    pub fn new(inner: mpsc::Sender<Vec<i16>>, diagnostic: Option<Arc<InputDiagnostic>>) -> Self { Self { inner, diagnostic } }
    pub fn is_closed(&self) -> bool { self.inner.is_closed() }
    // Legacy handoff tests await a bounded, otherwise empty channel. Production
    // still exclusively uses try_send; this adapter is absent from release builds.
    #[cfg(test)]
    pub async fn send(&self, samples: Vec<i16>) -> Result<(), mpsc::error::SendError<Vec<i16>>> {
        assert!(self.diagnostic.is_none(), "test-only send does not collect diagnostics");
        self.inner.send(samples).await
    }
    #[cfg(test)]
    pub async fn closed(&self) { self.inner.closed().await; }
    #[cfg(test)]
    pub fn same_channel(&self, other: &Self) -> bool { self.inner.same_channel(&other.inner) }
    pub fn phase(&self, phase: &'static str) { if let Some(d) = &self.diagnostic { d.phase(phase); } }
    pub fn rtc_input(&self, samples: &[i16], ignored_before_switch: bool) {
        if let Some(d)=&self.diagnostic {
            let mut s=d.state.lock().unwrap_or_else(|p|p.into_inner());
            s.rtc_seen.push(samples);
            if ignored_before_switch {s.rtc_ignored_before_switch.push(samples);}
        }
    }
    pub fn try_send(&self, samples: Vec<i16>) -> Result<(), mpsc::error::TrySendError<Vec<i16>>> {
        // Preserve the existing nonblocking send and error semantics. Never
        // hold a statistics lock across I/O, an await, or a tracing call.
        let accepted = self.diagnostic.as_ref().map(|_| { let mut c=PcmCount::default();c.push(&samples);c });
        let result = self.inner.try_send(samples);
        if let Some(d) = &self.diagnostic {
            let mut s = d.state.lock().unwrap_or_else(|p| p.into_inner());
            match &result {
                Ok(()) => {
                    let c=accepted.unwrap();
                    s.accepted.samples=s.accepted.samples.saturating_add(c.samples);
                    s.accepted.nonzero=s.accepted.nonzero.saturating_add(c.nonzero);
                    s.accepted.abs_sum=s.accepted.abs_sum.saturating_add(c.abs_sum);
                    s.accepted.peak=s.accepted.peak.max(c.peak);
                }
                Err(mpsc::error::TrySendError::Full(v)) => s.full.push(v),
                Err(mpsc::error::TrySendError::Closed(v)) => s.closed.push(v),
            }
            s.observed_high_water_blocks=s.observed_high_water_blocks.max(self.inner.max_capacity()-self.inner.capacity());
        }
        result
    }
}

#[derive(Default, Debug, Clone, Serialize)]
pub struct StreamStats {
    pub init_written: bool, pub taken: PcmCount, pub written: PcmCount,
    pub audio_writes: u64, pub first_write_ms: Option<u64>, pub last_write_ms: Option<u64>, pub max_write_ms: u64,
    pub terminator_written: bool, pub binary: u64, pub other: u64, pub responses: u64,
    pub invalid_json: u64, pub missing_result: u64, pub nonobject_result: u64,
    pub missing_utterances: u64, pub empty_utterances: u64, pub text_present: u64,
    pub definite: u64, pub empty_definite: u64, pub error_code: Option<u32>,
    pub interim_delivered: u64, pub final_delivered: u64, pub event_receiver_closed: u64,
    pub first_response_ms: Option<u64>, pub first_final_ms: Option<u64>,
}
pub struct Observation {
    pub stats: StreamStats, pub stage: &'static str, pub outcome: &'static str,
    pub diagnostic: Option<Arc<InputDiagnostic>>, pub request_id: String, started: Instant,
}
impl Observation {
    pub fn new(request_id: String, diagnostic: Option<Arc<InputDiagnostic>>) -> Self {
        Self { stats: StreamStats::default(), stage: "connect", outcome: "cancelled", diagnostic, request_id, started: Instant::now() }
    }
    pub fn enabled(&self) -> bool { self.diagnostic.is_some() }
    pub fn ms(&self) -> u64 { self.started.elapsed().as_millis() as u64 }
    pub fn response(&mut self, payload: &serde_json::Value) {
        if !self.enabled() { return; }
        self.stats.responses+=1;
        if self.stats.first_response_ms.is_none() { self.stats.first_response_ms=Some(self.ms()); }
        let Some(r)=payload.get("result") else {self.stats.missing_result+=1;return};
        if !r.is_object() {self.stats.nonobject_result+=1;}
        if r.get("text").and_then(|t|t.as_str()).is_some_and(|s|!s.is_empty()) {self.stats.text_present+=1;}
        let Some(us)=r.get("utterances").and_then(|u|u.as_array()) else {self.stats.missing_utterances+=1;return};
        if us.is_empty() {self.stats.empty_utterances+=1;}
        for u in us {
            if u.get("definite").and_then(|d|d.as_bool())==Some(true) {
                self.stats.definite+=1;
                if u.get("text").and_then(|t|t.as_str()).unwrap_or("").trim().is_empty() {self.stats.empty_definite+=1;}
            }
        }
    }
    pub async fn emit(&mut self, tx: &mpsc::Sender<crate::stt_volc::SttEvent>, event: crate::stt_volc::SttEvent) {
        let final_event=matches!(event,crate::stt_volc::SttEvent::Final(_));
        self.stage="event_send";
        let result=tx.send(event).await;
        if self.enabled() {
            if result.is_err() {self.stats.event_receiver_closed+=1;}
            else if final_event {
                self.stats.final_delivered+=1;
                if self.stats.first_final_ms.is_none() {self.stats.first_final_ms=Some(self.ms());}
            } else {self.stats.interim_delivered+=1;}
        }
        self.stage="receive";
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        if let Some(d)=&self.diagnostic {
            tracing::info!(request_id=%self.request_id,input_generation=%d.id,stage=self.stage,outcome=self.outcome,
                elapsed_ms=self.ms(),stats=%serde_json::to_string(&self.stats).unwrap_or_default(),
                queue=%serde_json::to_string(&d.snapshot()).unwrap_or_default(),"asr diagnostic connection summary");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn three_rotating_devices_are_scoped_and_share_the_expiry() {
        let allow = "SYNTHETIC001, SYNTHETIC002,SYNTHETIC003";
        for sn in ["SYNTHETIC001", "SYNTHETIC002", "SYNTHETIC003"] {
            let room = format!("sn-{sn}-123456");
            assert!(enabled_for(&room, allow, 101, 100));
            assert!(!enabled_for(&room, allow, 101, 101));
            assert!(!enabled_for(&room, "", 101, 100));
        }
        for sn in ["SYNTHETIC004", "SYNTHETIC00", "SYNTHETIC001X"] {
            assert!(!enabled_for(&format!("sn-{sn}-123456"), allow, 101, 100));
        }
    }
    #[tokio::test]
    async fn disabled_observer_keeps_nonblocking_queue_semantics() {
        let (tx, mut rx) = mpsc::channel(1);
        let tx = PcmSender::new(tx, None);
        tx.phase("rtc");
        tx.rtc_input(&[0, 17, -23], false);
        tx.try_send(vec![0, 17, -23]).unwrap();
        assert!(matches!(tx.try_send(vec![99]), Err(mpsc::error::TrySendError::Full(v)) if v == vec![99]));
        assert_eq!(rx.recv().await.unwrap(), vec![0, 17, -23]);
        drop(rx);
        assert!(matches!(tx.try_send(vec![88]), Err(mpsc::error::TrySendError::Closed(v)) if v == vec![88]));
    }
    #[tokio::test]
    async fn queue_success_full_closed_are_distinct_and_preserve_samples() {
        let (tx,mut rx)=mpsc::channel(1);let d=InputDiagnostic::new();let tx=PcmSender::new(tx,Some(d.clone()));
        tx.phase("rtc");tx.try_send(vec![0,i16::MIN,7]).unwrap();
        assert!(matches!(tx.try_send(vec![3,4]),Err(mpsc::error::TrySendError::Full(_))));
        assert_eq!(rx.recv().await.unwrap(),vec![0,i16::MIN,7]);drop(rx);
        assert!(matches!(tx.try_send(vec![8]),Err(mpsc::error::TrySendError::Closed(_))));
        let s=d.snapshot();assert_eq!(s.phase,"rtc");assert_eq!(s.accepted.samples,3);assert_eq!(s.accepted.nonzero,2);
        assert_eq!(s.accepted.peak,32768);assert_eq!(s.full.samples,2);assert_eq!(s.closed.samples,1);assert_eq!(s.observed_high_water_blocks,1);
    }
    #[test]
    fn response_shapes_do_not_store_text() {
        let mut o=Observation::new("synthetic".into(),Some(InputDiagnostic::new()));
        for p in [serde_json::json!({}),serde_json::json!({"result":null}),serde_json::json!({"result":{"text":"private-test","utterances":[]}}),serde_json::json!({"result":{"utterances":[{"text":"","definite":true}]}})] {o.response(&p);}
        assert_eq!(o.stats.missing_result,1);assert_eq!(o.stats.nonobject_result,1);assert_eq!(o.stats.empty_utterances,1);assert_eq!(o.stats.empty_definite,1);
        assert!(!serde_json::to_string(&o.stats).unwrap().contains("private-test"));
    }
    #[test]
    fn diagnostics_are_exact_identity_opt_in_and_expire_at_the_deadline() {
        assert!(enabled_for("sn-TEST123-001","TEST123",101,100));
        for (room,allow,until) in [("sn-TEST123-001","TEST12",101),("sn-TEST123-001","*",101),("sn--001","",101),("sn-TEST123-001","TEST123",100),("web-TEST123","TEST123",101)] {
            assert!(!enabled_for(room,allow,until,100));
        }
    }
}
