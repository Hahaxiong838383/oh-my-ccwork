//! Single-device canary boundaries; no audio-loop IO.
use serde::Deserialize;
pub const AGENT: &str = "p003-search-canary-20261021";
pub const BASE: &str = "https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1";
#[derive(Deserialize, Clone)]
pub struct Window { pub enabled: bool, pub sn: String, pub expires_at_ms: u64, pub generation: String }
pub fn valid_base(s: &str) -> bool { s.trim_end_matches('/') == BASE }
pub fn accepts(w: &Window, room: &str, metadata: &str, now: u64) -> bool {
 let Some(suffix)=room.strip_prefix(&format!("sn-{}-",w.sn)) else{return false};
 let Ok(m)=serde_json::from_str::<serde_json::Value>(metadata) else{return false};
 let c=&m["search_canary"];
 w.enabled && w.sn=="BJP00326070803800006" && !suffix.is_empty() && suffix.len()<=20
 && suffix.bytes().all(|b|b.is_ascii_digit()) && w.expires_at_ms>now && w.expires_at_ms-now<=7_200_000
 && c["sn"].as_str()==Some(w.sn.as_str()) && c["expires_at_ms"].as_u64()==Some(w.expires_at_ms)
 && c["generation"].as_str()==Some(w.generation.as_str()) && !w.generation.is_empty()
}
pub fn now_ms()->u64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
pub fn window()->Option<Window> {
 let p=std::env::var("P003_SEARCH_CANARY_WINDOW_FILE").ok()?;
 let bytes=std::fs::read(p).ok()?;if bytes.len()>2048{return None};serde_json::from_slice(&bytes).ok()
}
pub fn job_allowed(agent:&str,room:&str,metadata:&str)->bool {
 agent!=AGENT || window().is_some_and(|w| accepts(&w,room,metadata,now_ms()))
}
pub fn validate_startup(agent:&str,max:usize)->anyhow::Result<()> {
 if agent!=AGENT{return Ok(())}
 let get=|k:&str|std::env::var(k).unwrap_or_default();
 anyhow::ensure!(max==1 && valid_base(&get("LLM_BASE_URL")),"canary_config");
 anyhow::ensure!(get("P003_SEARCH_DEVICE_ALLOWLIST")=="BJP00326070803800006" && window().is_some(),"canary_window");
 anyhow::ensure!(get("EOT_SOCK")=="/run/p003-search-canary/eot.sock","canary_sidecar_isolation");
 anyhow::ensure!(get("LLM_FALLBACK_BASE_URL").is_empty(),"canary_fallback_must_be_disabled");
 Ok(())
}
static LAST_SIGNAL:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
pub fn signal(connected:bool){LAST_SIGNAL.store(if connected {now_ms()}else{0},std::sync::atomic::Ordering::Relaxed);}
pub async fn health_loop(agent:String,state:std::sync::Arc<crate::worker::WorkerState>) {
 if agent!=AGENT{return}
 let Ok(path)=std::env::var("P003_SEARCH_CANARY_HEALTH_FILE")else{return};
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().expect("canary health client");
 let query=std::env::var("LLM_URL_QUERY").unwrap_or_default();
 let token=reqwest::Url::parse(&format!("https://localhost/?{}",query)).ok().and_then(|u|u.query_pairs().find(|(k,_)|k=="token").map(|(_,v)|v.to_string())).unwrap_or_default();
 let key=std::env::var("LLM_API_KEY").unwrap_or_default();
 let generation=std::env::var("P003_SEARCH_CANARY_GENERATION").unwrap_or_default();
 let mut timer=tokio::time::interval(std::time::Duration::from_secs(5));
 loop {
  timer.tick().await;
  let now=now_ms();let last=LAST_SIGNAL.load(std::sync::atomic::Ordering::Relaxed);
  let payload=serde_json::json!({"agent":agent,"at_ms":now,"registered":last>0&&now.saturating_sub(last)<45000,"jobs":state.active_jobs.load(std::sync::atomic::Ordering::Relaxed),"ordered_pcm_v1":true,"generation":generation});
  let _=client.post(format!("{}/internal/canary-health",BASE)).header("x-p003-worker-token",&token).bearer_auth(&key).json(&payload).send().await;
  let temp=format!("{}.tmp",path);
  if tokio::fs::write(&temp,payload.to_string()).await.is_ok(){let _=tokio::fs::rename(&temp,&path).await;}
 }
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn exact_https_prefix_only() {
  assert!(valid_base(BASE)); assert!(valid_base(&(BASE.to_owned()+"/")));
  for s in ["http://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1","https://evil.test/v1","https://kidshub-ai.hahaxiong.cc:444/_canary/search-20261021/v1","https://a:b@kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1","https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v10","https://kidshub-ai.hahaxiong.cc/v1"] {assert!(!valid_base(s));}
 }
 #[test] fn trusted_metadata_deadline_and_exact_sn() {
  let w=Window{enabled:true,sn:"BJP00326070803800006".into(),expires_at_ms:9000,generation:"test".into()};
  let m=r#"{"search_canary":{"sn":"BJP00326070803800006","expires_at_ms":9000,"generation":"test"}}"#;
  assert!(accepts(&w,"sn-BJP00326070803800006-123",m,1000));
  assert!(!accepts(&w,"sn-BJP00326060100200003-123",m,1000));
  assert!(!accepts(&w,"sn-BJP00326070803800006-123","{}",1000));
  assert!(!accepts(&w,"sn-BJP00326070803800006-123",m,9000));
  let mut closed=w.clone();closed.enabled=false; assert!(!accepts(&closed,"sn-BJP00326070803800006-123",m,1000));
  let mut changed=w.clone();changed.generation="new".into();assert!(!accepts(&changed,"sn-BJP00326070803800006-123",m,1000));
 }
}
