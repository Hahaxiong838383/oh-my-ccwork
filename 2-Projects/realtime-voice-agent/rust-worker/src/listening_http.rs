//! Frozen main-Brain contract. Credentials and content deliberately have no Debug impl.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub sn: String,
    pub room: String,
    pub session_id: String,
    pub trace_id: String,
    pub account_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tuning {
    pub max_session_sec: u64,
    pub feedback_max_chars: usize,
    pub feedback_max_duration_sec: u64,
    pub feedback_cooldown_sec: u64,
    pub summary_interval_sec: u64,
    pub summary_trigger_chars: usize,
    pub voice_invitation_enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub raw_chars: usize,
    pub recent_chars: usize,
    pub summary_chars: usize,
    pub lease_ttl_ms: u64,
    pub lease_refresh_ms: u64,
    pub lease_request_budget_ms: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub scenes: Vec<String>,
    pub tuning: Tuning,
    pub limits: Limits,
    pub sha256: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceControl {
    pub version: u8,
    pub capability: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub voice_control: Option<VoiceControl>,
    pub version: u8,
    pub authority: String,
    pub grant: String,
    pub session: Session,
    pub grant_expires_at_ms: u64,
    pub agent: String,
    pub worker_build_sha: String,
    pub snapshot: Snapshot,
}
#[derive(Clone)]
pub struct Client {
    service: Service,
    pub meta: Metadata,
}
#[derive(Clone)]
pub struct Service {
    http: reqwest::Client,
    base: reqwest::Url,
    key: String,
    token: String,
}
pub fn hash(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
    )
}
impl Snapshot {
    pub fn valid(&self) -> bool {
        let t = &self.tuning;
        let l = &self.limits;
        self.revision > 0
            && self.revision <= 9_007_199_254_740_991
            && !self.scenes.is_empty()
            && self.scenes.len() <= 3
            && self
                .scenes
                .iter()
                .all(|s| ["story", "sharing", "singing"].contains(&s.as_str()))
            && self
                .scenes
                .iter()
                .enumerate()
                .all(|(i, s)| !self.scenes[..i].contains(s))
            && (300..=1800).contains(&t.max_session_sec)
            && (40..=160).contains(&t.feedback_max_chars)
            && (5..=30).contains(&t.feedback_max_duration_sec)
            && (1..=30).contains(&t.feedback_cooldown_sec)
            && (60..=600).contains(&t.summary_interval_sec)
            && (1000..=8000).contains(&t.summary_trigger_chars)
            && (
                l.raw_chars,
                l.recent_chars,
                l.summary_chars,
                l.lease_ttl_ms,
                l.lease_refresh_ms,
                l.lease_request_budget_ms,
            ) == (12000, 4000, 1200, 15000, 5000, 1000)
            && self.sha256
                == hash(
                    &json!({"revision":self.revision,"scenes":self.scenes,"tuning":self.tuning,"limits":self.limits}),
                )
    }
}
impl Client {
    #[cfg(test)]
    pub fn joint(v: &Value) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let base = reqwest::Url::parse(v["url"].as_str().unwrap()).unwrap();
        assert_eq!(base.host_str(), Some("127.0.0.1"));
        Self {
            service: Service {
                http: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
                base,
                key: v["key"].as_str().unwrap().into(),
                token: v["token"].as_str().unwrap().into(),
            },
            meta: serde_json::from_value(v["metadata"].clone()).unwrap(),
        }
    }

    pub fn new(
        cfg: &crate::llm::LlmConfig,
        meta: Metadata,
        room: &str,
        trace: Option<&str>,
        session: Option<&str>,
    ) -> Option<Self> {
        let base = reqwest::Url::parse(&format!(
            "{}/internal/listening/",
            cfg.base_url.trim_end_matches('/')
        ))
        .ok()?;
        if base.as_str() != "https://kidshub-ai.hahaxiong.cc/v1/internal/listening/"
            || meta.version != 1
            || meta.authority != "p003-main-brain"
            || meta.session.room != room
            || trace != Some(meta.session.trace_id.as_str())
            || session != Some(meta.session.session_id.as_str())
            || meta.session.room.strip_prefix("sn-")?.rsplit_once('-')?.0 != meta.session.sn
            || meta.grant.is_empty()
            || meta.grant.len() > 8192
            || meta.voice_control.as_ref().is_some_and(|v| {
                v.version != 1
                    || v.capability != "listening_voice_control_v1"
                    || !meta.snapshot.tuning.voice_invitation_enabled
            })
            || !meta.snapshot.valid()
            || meta.grant_expires_at_ms <= unix_ms()
            || meta.agent.is_empty()
            || meta.worker_build_sha.len() != 40
            || !meta.worker_build_sha.bytes().all(|c| c.is_ascii_hexdigit())
            || cfg.api_key.trim().is_empty()
            || cfg.api_key == "sk-noauth"
        {
            return None;
        }
        let q = reqwest::Url::parse(&format!("https://localhost/?{}", cfg.url_query)).ok()?;
        let tokens: Vec<_> = q
            .query_pairs()
            .filter(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
            .collect();
        if tokens.len() != 1 || tokens[0].is_empty() {
            return None;
        }
        Some(Self {
            service: Service::new(cfg)?,
            meta,
        })
    }
    pub async fn request(&self, endpoint: &str, body: Value) -> Result<Value, ()> {
        self.service
            .request(endpoint, body, Some(&self.meta.grant))
            .await
    }
    pub async fn lease(&self, mut body: Value, applied: Option<&Snapshot>) -> Result<Lease, ()> {
        let started = Instant::now();
        body["applied_snapshot_sha256"] = applied.map(|s| json!(s.sha256)).unwrap_or(Value::Null);
        let response = self.request("lease", body.clone()).await?;
        let snapshot: Snapshot =
            serde_json::from_value(response.get("snapshot").ok_or(())?.clone()).map_err(|_| ())?;
        if !snapshot.valid()
            || response["policy_revision"]
                .as_u64()
                .is_none_or(|r| r < snapshot.revision || r > 9_007_199_254_740_991)
        {
            return Err(());
        }
        if response["version"] != 1 || response["request_id"] != body["request_id"] {
            return Err(());
        }
        if response.get("authorized").and_then(Value::as_bool) == Some(false) {
            if response["lease_expires_at_ms"] != 0 {
                return Err(());
            }
            return Ok(Lease {
                snapshot,
                revision: response["policy_revision"].as_u64().ok_or(())?,
                ttl_ms: 0,
                received: Instant::now(),
            });
        }
        if applied.is_none_or(|s| s.sha256 != snapshot.sha256) {
            return Err(());
        }
        let remaining = lease_remaining(
            &response,
            body["request_id"].as_str().ok_or(())?,
            started.elapsed().as_millis() as u64,
        )?;
        let grant_remaining = self.meta.grant_expires_at_ms.saturating_sub(unix_ms());
        let ttl = remaining.min(grant_remaining);
        if ttl == 0 {
            return Err(());
        }
        Ok(Lease {
            snapshot,
            revision: response["policy_revision"].as_u64().ok_or(())?,
            ttl_ms: ttl,
            received: Instant::now(),
        })
    }
}
pub struct Lease {
    pub snapshot: Snapshot,
    pub revision: u64,
    pub ttl_ms: u64,
    pub received: Instant,
}
pub fn lease_remaining(v: &Value, id: &str, elapsed: u64) -> Result<u64, ()> {
    if v["version"] != 1
        || v["request_id"] != id
        || v["authorized"] != true
        || v["refresh_after_ms"] != 5000
        || v["request_budget_ms"] != 1000
        || v["lease_id"].as_str().is_none_or(str::is_empty)
    {
        return Err(());
    }
    let ttl = v["lease_expires_at_ms"]
        .as_u64()
        .ok_or(())?
        .checked_sub(v["server_time_ms"].as_u64().ok_or(())?)
        .ok_or(())?;
    if ttl > 15000 || ttl <= elapsed || v["policy_revision"].as_u64().unwrap_or(0) == 0 {
        return Err(());
    }
    Ok(ttl - elapsed)
}
pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listening_lease_subtracts_elapsed_and_rejects_replay_or_expired() {
        let v = json!({"version":1,"request_id":"r1","authorized":true,"lease_id":"lease","refresh_after_ms":5000,"request_budget_ms":1000,"lease_expires_at_ms":15000,"server_time_ms":0,"policy_revision":3});
        assert_eq!(lease_remaining(&v, "r1", 1000), Ok(14000));
        assert!(lease_remaining(&v, "r2", 0).is_err());
        assert!(lease_remaining(&v, "r1", 15000).is_err());
        let mut bad = v.clone();
        bad["lease_expires_at_ms"] = json!(15001);
        assert!(lease_remaining(&bad, "r1", 0).is_err());
    }
    #[test]
    fn listening_frozen_snapshot_hash_and_every_tuning_bound() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../4-Assets/contracts/p003-listening-http-v1.json"
        ))
        .unwrap();
        let s: Snapshot =
            serde_json::from_value(contract["metadata"]["shape"]["snapshot"].clone()).unwrap();
        assert!(s.valid());
        for key in [
            "max_session_sec",
            "feedback_max_chars",
            "feedback_max_duration_sec",
            "feedback_cooldown_sec",
            "summary_interval_sec",
            "summary_trigger_chars",
        ] {
            let mut v = serde_json::to_value(&s).unwrap();
            v["tuning"][key] = json!(0);
            v["sha256"] = json!(hash(
                &json!({"revision":v["revision"],"scenes":v["scenes"],"tuning":v["tuning"],"limits":v["limits"]})
            ));
            assert!(
                !serde_json::from_value::<Snapshot>(v).unwrap().valid(),
                "{key}"
            );
        }
        let mut v = s.clone();
        v.tuning.voice_invitation_enabled = !v.tuning.voice_invitation_enabled;
        assert!(!v.valid());
    }
}

impl Service {
    pub fn new(cfg: &crate::llm::LlmConfig) -> Option<Self> {
        let base = reqwest::Url::parse(&format!(
            "{}/internal/listening/",
            cfg.base_url.trim_end_matches('/')
        ))
        .ok()?;
        if base.as_str() != "https://kidshub-ai.hahaxiong.cc/v1/internal/listening/"
            || cfg.api_key.trim().is_empty()
            || cfg.api_key == "sk-noauth"
        {
            return None;
        }
        let q = reqwest::Url::parse(&format!("https://localhost/?{}", cfg.url_query)).ok()?;
        let tokens: Vec<_> = q
            .query_pairs()
            .filter(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
            .collect();
        if tokens.len() != 1 || tokens[0].is_empty() {
            return None;
        }
        Some(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()?,
            base,
            key: cfg.api_key.clone(),
            token: tokens[0].clone(),
        })
    }
    pub async fn request(
        &self,
        endpoint: &str,
        body: Value,
        grant: Option<&str>,
    ) -> Result<Value, ()> {
        if !["lease", "close", "summary", "feedback", "worker-ready"].contains(&endpoint)
            || (endpoint != "worker-ready" && grant.is_none())
        {
            return Err(());
        }
        let budget = if matches!(endpoint, "summary" | "feedback") {
            9000
        } else {
            1000
        };
        let work = async {
            let mut request = self
                .http
                .post(self.base.join(endpoint).map_err(|_| ())?)
                .bearer_auth(&self.key)
                .header("x-p003-worker-token", &self.token)
                .json(&body);
            if let Some(grant) = grant {
                request = request.header("x-p003-listening-grant", grant);
            }
            let res = request.send().await.map_err(|_| ())?;
            if !res.status().is_success() {
                return Err(());
            }
            let mut stream = res.bytes_stream();
            let mut bytes = Vec::new();
            use futures_util::StreamExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ())?;
                if bytes.len() + chunk.len() > 98304 {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_| ())
        };
        tokio::time::timeout(Duration::from_millis(budget), work)
            .await
            .map_err(|_| ())?
    }
}
