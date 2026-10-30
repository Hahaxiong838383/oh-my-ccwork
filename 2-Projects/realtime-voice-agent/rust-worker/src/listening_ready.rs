//! Readiness is tied to an actual LiveKit registration and a compile-time approved build.
//! No deployment/env boolean can manufacture a ready capability.
use crate::listening_http::{Service, Snapshot};
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};
static APPLIED: OnceLock<Mutex<Option<(Snapshot, std::time::Instant, String, String)>>> =
    OnceLock::new();
const CAPABILITIES: [&str; 5] = [
    "listening_mode_v1",
    "listening_http_v1",
    "per_frame_output_permit_v1",
    "capture_drain_v1",
    "local_ready_ack_v1",
];
pub struct Registered {
    task: tokio::task::JoinHandle<()>,
    service: Service,
    body: Value,
}
impl Drop for Registered {
    fn drop(&mut self) {
        self.task.abort();
        if let Ok(mut applied) = APPLIED.get_or_init(|| Mutex::new(None)).lock() {
            *applied = None;
        }
        let service = self.service.clone();
        let mut body = self.body.clone();
        body["registered"] = json!(false);
        body["request_id"] = json!(format!("withdraw-{}", crate::listening_http::unix_ms()));
        tokio::spawn(async move {
            let _ = service.request("worker-ready", body, None).await;
        });
    }
}
pub fn snapshot_matches(sha: &str, agent: &str, build: &str) -> bool {
    APPLIED
        .get()
        .and_then(|v| v.lock().ok())
        .and_then(|v| v.clone())
        .is_some_and(|(v, at, a, b)| {
            v.sha256 == sha
                && a == agent
                && b == build
                && at.elapsed() < std::time::Duration::from_secs(15)
        })
}
pub fn registered(agent: &str) -> Option<Registered> {
    // Set at build time by the isolated release pipeline only; absent means no capability claim.
    let build = option_env!("P003_WORKER_BUILD_SHA")?;
    if build.len() != 40 || !build.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let cfg = crate::llm::LlmConfig::from_env()?;
    let service = Service::new(&cfg)?;
    let body = json!({"version":1,"request_id":"ready-0","agent":agent,"instance_id":format!("worker-{}-{}",std::process::id(),crate::listening_http::unix_ms()),"build_sha":build,"registered":true,"capabilities":CAPABILITIES,"applied_revision":null,"applied_config_sha256":null});
    let client = service.clone();
    let mut request = body.clone();
    let agent = agent.to_owned();
    let task = tokio::spawn(async move {
        let mut sequence = 0u64;
        loop {
            sequence += 1;
            request["request_id"] = json!(format!("ready-{sequence}"));
            match client.request("worker-ready", request.clone(), None).await {
                Ok(reply) => {
                    if let Some(policy) = offered_policy(&reply) {
                        if let Ok(mut applied) = APPLIED.get_or_init(|| Mutex::new(None)).lock() {
                            *applied = Some((
                                policy.clone(),
                                std::time::Instant::now(),
                                agent.clone(),
                                build.into(),
                            ));
                        }
                        request["applied_revision"] = json!(policy.revision);
                        request["applied_config_sha256"] = json!(policy.sha256);
                    } else {
                        if let Ok(mut applied) = APPLIED.get_or_init(|| Mutex::new(None)).lock() {
                            *applied = None;
                        }
                    }
                }
                Err(()) => {
                    if let Ok(mut applied) = APPLIED.get_or_init(|| Mutex::new(None)).lock() {
                        *applied = None;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
    Some(Registered {
        task,
        service,
        body,
    })
}
fn offered_policy(v: &Value) -> Option<Snapshot> {
    if v["version"] != 1 || v["ok"] != true {
        return None;
    }
    let p:Snapshot=serde_json::from_value(json!({"revision":v["policy_revision"],"sha256":v["config_sha256"],"scenes":v["config"]["scenes"],"tuning":v["config"]["tuning"],"limits":v["config"]["limits"]})).ok()?;
    p.valid().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listening_worker_ready_requires_valid_complete_applied_snapshot() {
        let c: Value =
            serde_json::from_str(include_str!("../../../../4-Assets/contracts/p003-listening-http-v1.json"))
                .unwrap();
        let s = c["metadata"]["shape"]["snapshot"].clone();
        let reply = json!({"version":1,"ok":true,"policy_revision":s["revision"],"config_sha256":s["sha256"],"config":s});
        assert!(offered_policy(&reply).is_some());
        let mut bad = reply.clone();
        bad["config"]["tuning"]["voice_invitation_enabled"] = json!(false);
        assert!(offered_policy(&bad).is_none());
        assert!(!snapshot_matches(
            "no-match",
            "other-agent",
            &"b".repeat(40)
        ));
    }
}
