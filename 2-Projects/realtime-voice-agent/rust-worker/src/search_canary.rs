//! Bounded-device canary boundaries; no audio-loop IO.
use serde::Deserialize;
pub const AGENT: &str = "p003-search-canary-20261021";
pub const BASE: &str = "https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1";
pub const VERIFICATION_AGENT: &str = "p003-search-verification-20261026";
const VERIFICATION_SN: &str = "BJP00399999999999901";
const VERIFICATION_BASE: &str = "https://kidshub-ai.hahaxiong.cc/_canary/search-verification-20261026/v1";
#[derive(Clone, Copy)]
struct Profile { base: &'static str, eot: &'static str, max_jobs: usize, verification: bool }
fn profile(agent: &str) -> Option<Profile> {
 match agent {
  AGENT=>Some(Profile{base:BASE,eot:"/run/p003-search-canary/eot.sock",max_jobs:2,verification:false}),
  VERIFICATION_AGENT=>Some(Profile{base:VERIFICATION_BASE,eot:"/run/p003-search-verification/eot.sock",max_jobs:1,verification:true}),
  _=>None,
 }
}
pub fn is_candidate(agent: &str) -> bool { profile(agent).is_some() }
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Window { pub enabled: bool, #[serde(default)] pub sn: String, #[serde(default)] pub allowlist: Vec<String>, pub expires_at_ms: u64, pub generation: String }
pub fn valid_base(s: &str) -> bool { s.trim_end_matches('/') == BASE }
fn valid_sn(sn:&str)->bool { sn.len()==20 && sn.starts_with("BJP003") && sn.as_bytes()[6..].iter().all(u8::is_ascii_digit) }
fn valid_list(list:&[String])->bool { !list.is_empty() && list.len()<=2 && list.iter().all(|s|valid_sn(s)) && (list.len()==1 || list[0]!=list[1]) }
fn allowed(w:&Window)->Vec<String> {
 let list=if w.allowlist.is_empty(){vec![w.sn.clone()]}else if w.sn.is_empty(){w.allowlist.clone()}else{return vec![]};
 if valid_list(&list){list}else{vec![]}
}
fn matches_environment(w:&Window,raw:&str)->bool {
 let mut configured:Vec<String>=raw.split(',').map(str::to_owned).collect(); let mut list=allowed(w);
 if !valid_list(&configured) || list.is_empty(){return false};configured.sort();list.sort();configured==list
}
fn matches_profile(p:Profile,w:&Window,raw:&str)->bool {
 matches_environment(w,raw) && (!p.verification || allowed(w)==[VERIFICATION_SN])
}
pub fn accepts(w: &Window, room: &str, metadata: &str, now: u64) -> bool {
 let Ok(m)=serde_json::from_str::<serde_json::Value>(metadata) else{return false};
 let c=&m["search_canary"];let Some(sn)=c["sn"].as_str() else{return false};
 if !allowed(w).iter().any(|s|s==sn){return false}
 let Some(suffix)=room.strip_prefix(&format!("sn-{}-",sn)) else{return false};
 w.enabled && !suffix.is_empty() && suffix.len()<=20
 && suffix.bytes().all(|b|b.is_ascii_digit()) && w.expires_at_ms>now && w.expires_at_ms-now<=168*3600_000
 && c["expires_at_ms"].as_u64()==Some(w.expires_at_ms)
 && c["generation"].as_str()==Some(w.generation.as_str()) && !w.generation.is_empty()
}
pub fn now_ms()->u64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
pub fn window()->Option<Window> {
 let p=std::env::var("P003_SEARCH_CANARY_WINDOW_FILE").ok()?;
 let bytes=std::fs::read(p).ok()?;if bytes.len()>2048{return None};serde_json::from_slice(&bytes).ok()
}
pub fn job_allowed(agent:&str,room:&str,metadata:&str)->bool {
 let Some(p)=profile(agent)else{return !agent.starts_with("p003-search-")};
 window().is_some_and(|w| matches_profile(p,&w,&std::env::var("P003_SEARCH_DEVICE_ALLOWLIST").unwrap_or_default()) && accepts(&w,room,metadata,now_ms()))
}
pub fn validate_startup(agent:&str,max:usize)->anyhow::Result<()> {
 let get=|k:&str|std::env::var(k).unwrap_or_default();
 validate_config(agent,max,&get,window().as_ref())
}
fn validate_config(agent:&str,max:usize,get:&impl Fn(&str)->String,w:Option<&Window>)->anyhow::Result<()> {
 let Some(p)=profile(agent)else{anyhow::ensure!(!agent.starts_with("p003-search-"),"canary_agent");return Ok(())};
 anyhow::ensure!((1..=p.max_jobs).contains(&max) && get("LLM_BASE_URL").trim_end_matches('/')==p.base,"canary_config");
 anyhow::ensure!(w.is_some_and(|w| matches_profile(p,w,&get("P003_SEARCH_DEVICE_ALLOWLIST"))),"canary_window");
 anyhow::ensure!(get("EOT_SOCK")==p.eot,"canary_sidecar_isolation");
 anyhow::ensure!(get("LLM_FALLBACK_BASE_URL").is_empty(),"canary_fallback_must_be_disabled");
 if p.verification {
  for (key,expected) in [
   ("P003_SEARCH_CANARY_WINDOW_FILE","/opt/p003-search-verification-20261026/window.json"),
   ("P003_SEARCH_CANARY_HEALTH_FILE","/run/p003-search-verification/health.json"),
   ("P003_ROOM_CLEANUP_DIR","/opt/p003-search-verification-20261026/room-cleanup"),
   ("P003_ROOM_CLEANUP_STATUS_FILE","/opt/p003-search-verification-20261026/cleanup-status.json"),
   ("P003_ROOM_CLEANUP_V1","1"),
  ] {anyhow::ensure!(get(key)==expected,"canary_verification_isolation");}
 }
 Ok(())
}
static LAST_SIGNAL:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
pub fn signal(connected:bool){LAST_SIGNAL.store(if connected {now_ms()}else{0},std::sync::atomic::Ordering::Relaxed);}
pub(crate) fn recent_registration(now: u64) -> bool {
    let last = LAST_SIGNAL.load(std::sync::atomic::Ordering::Relaxed);
    last > 0 && now.saturating_sub(last) < 45_000
}
pub async fn health_loop(agent:String,state:std::sync::Arc<crate::worker::WorkerState>) {
 let Some(profile)=profile(&agent)else{return};
 let Ok(path)=std::env::var("P003_SEARCH_CANARY_HEALTH_FILE")else{return};
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).redirect(reqwest::redirect::Policy::none()).build().expect("canary health client");
 let query=std::env::var("LLM_URL_QUERY").unwrap_or_default();
 let token=reqwest::Url::parse(&format!("https://localhost/?{}",query)).ok().and_then(|u|u.query_pairs().find(|(k,_)|k=="token").map(|(_,v)|v.to_string())).unwrap_or_default();
 let key=std::env::var("LLM_API_KEY").unwrap_or_default();
 let generation=std::env::var("P003_SEARCH_CANARY_GENERATION").unwrap_or_default();
 let mut timer=tokio::time::interval(std::time::Duration::from_secs(5));
 loop {
  timer.tick().await;
  let now=now_ms();
  let mut payload=serde_json::json!({"agent":agent,"at_ms":now,"registered":recent_registration(now),"jobs":state.active_jobs.load(std::sync::atomic::Ordering::Relaxed),"ordered_pcm_v1":true,"generation":generation});
  if std::env::var("P003_ROOM_CLEANUP_V1").is_ok_and(|v|v=="1") {
   let raw=match std::env::var("P003_ROOM_CLEANUP_STATUS_FILE") {
    Ok(path)=>tokio::fs::read_to_string(path).await.unwrap_or_default(),Err(_)=>String::new(),
   };
   payload["cleanup"]=crate::room_cleanup::health(&raw,now);
  }
  let _=client.post(format!("{}/internal/canary-health",profile.base)).header("x-p003-worker-token",&token).bearer_auth(&key).json(&payload).send().await;
  let temp=format!("{}.tmp",path);
  if tokio::fs::write(&temp,payload.to_string()).await.is_ok(){let _=tokio::fs::rename(&temp,&path).await;}
 }
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn r17_verifier_cannot_bypass_device_and_window_guards() {
  let agent="p003-search-verification-20261026";
  assert!(!job_allowed(agent,"sn-BJP00326060100100004-123","{}"));
  assert!(validate_startup(agent,3).is_err());
 }
 #[test] fn r17_unknown_reserved_agent_is_not_an_ordinary_worker() {
  assert!(validate_startup("p003-search-verification-typo",1).is_err());
  assert!(!job_allowed("p003-search-verification-typo","sn-BJP00326070803800006-123","{}"));
  assert!(validate_startup("rust-worker",1).is_ok());
  assert!(job_allowed("rust-worker","ordinary-room","{}"));
 }
 #[test] fn r17_verification_keeps_candidate_features_with_separate_identity_and_paths() {
  assert!(is_candidate(AGENT));assert!(is_candidate(VERIFICATION_AGENT));assert!(!is_candidate("rust-worker"));
  let w=Window{enabled:true,sn:VERIFICATION_SN.into(),allowlist:vec![],expires_at_ms:9000,generation:"verify".into()};
  let env=std::collections::HashMap::from([
   ("LLM_BASE_URL",VERIFICATION_BASE),("EOT_SOCK","/run/p003-search-verification/eot.sock"),
   ("P003_SEARCH_DEVICE_ALLOWLIST",VERIFICATION_SN),
   ("P003_SEARCH_CANARY_WINDOW_FILE","/opt/p003-search-verification-20261026/window.json"),
   ("P003_SEARCH_CANARY_HEALTH_FILE","/run/p003-search-verification/health.json"),
   ("P003_ROOM_CLEANUP_DIR","/opt/p003-search-verification-20261026/room-cleanup"),
   ("P003_ROOM_CLEANUP_STATUS_FILE","/opt/p003-search-verification-20261026/cleanup-status.json"),
   ("P003_ROOM_CLEANUP_V1","1"),
  ]);
  let get=|key:&str|env.get(key).copied().unwrap_or_default().to_owned();
  assert!(validate_config(VERIFICATION_AGENT,1,&get,Some(&w)).is_ok());
  assert!(validate_config(VERIFICATION_AGENT,2,&get,Some(&w)).is_err());
  assert!(validate_config(AGENT,1,&get,Some(&w)).is_err());
  for key in env.keys() {
   let mixed=|k:&str|if k==*key {"wrong".into()}else{get(k)};
   assert!(validate_config(VERIFICATION_AGENT,1,&mixed,Some(&w)).is_err(),"{key}");
  }
  let real=Window{sn:"BJP00326060100100004".into(),..w.clone()};
  assert!(!matches_profile(profile(VERIFICATION_AGENT).unwrap(),&real,"BJP00326060100100004"));
  let meta=serde_json::json!({"search_canary":{"sn":w.sn,"expires_at_ms":9000,"generation":"verify"}}).to_string();
  assert!(accepts(&w,&format!("sn-{VERIFICATION_SN}-123"),&meta,1000));
  assert!(!accepts(&w,&format!("sn-{VERIFICATION_SN}-123"),&meta,9000));
 }
 #[test] fn exact_https_prefix_only() {
  assert!(valid_base(BASE)); assert!(valid_base(&(BASE.to_owned()+"/")));
  for s in ["http://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1","https://evil.test/v1","https://kidshub-ai.hahaxiong.cc:444/_canary/search-20261021/v1","https://a:b@kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1","https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v10","https://kidshub-ai.hahaxiong.cc/v1"] {assert!(!valid_base(s));}
 }
 #[test] fn r16_explicitly_bounded_week_window() {
  let mut w=Window{allowlist:vec![],enabled:true,sn:"BJP00326070803800006".into(),expires_at_ms:1000+168*3600_000,generation:"test".into()};
  let meta=|w:&Window|serde_json::json!({"search_canary":{"sn":w.sn,"expires_at_ms":w.expires_at_ms,"generation":w.generation}}).to_string();
  let room="sn-BJP00326070803800006-123";
  assert!(accepts(&w,room,&meta(&w),1000));
  w.expires_at_ms+=1;assert!(!accepts(&w,room,&meta(&w),1000));
  assert!(!accepts(&w,room,&meta(&w),w.expires_at_ms));
 }
 #[test] fn trusted_metadata_deadline_and_exact_sn() {
  let w=Window{allowlist:vec![],enabled:true,sn:"BJP00326070803800006".into(),expires_at_ms:9000,generation:"test".into()};
  let m=r#"{"search_canary":{"sn":"BJP00326070803800006","expires_at_ms":9000,"generation":"test"}}"#;
  assert!(accepts(&w,"sn-BJP00326070803800006-123",m,1000));
  assert!(!accepts(&w,"sn-BJP00326060100200003-123",m,1000));
  assert!(!accepts(&w,"sn-BJP00326070803800006-123","{}",1000));
  assert!(!accepts(&w,"sn-BJP00326070803800006-123",m,9000));
  let mut closed=w.clone();closed.enabled=false; assert!(!accepts(&closed,"sn-BJP00326070803800006-123",m,1000));
  let mut changed=w.clone();changed.generation="new".into();assert!(!accepts(&changed,"sn-BJP00326070803800006-123",m,1000));
 }
 #[test] fn bounded_two_device_scope_and_expiry() {
  let a="BJP00326070803800006";let b="BJP00326060100100004";
  let mut w=Window{enabled:true,sn:String::new(),allowlist:vec![a.into(),b.into()],expires_at_ms:9000,generation:"pair".into()};
  let meta=|sn:&str|serde_json::json!({"search_canary":{"sn":sn,"expires_at_ms":9000,"generation":"pair"}}).to_string();
  for sn in [a,b] {assert!(accepts(&w,&format!("sn-{sn}-123"),&meta(sn),1000));assert!(!accepts(&w,&format!("sn-{sn}-123"),&meta(sn),9000));}
  assert!(!accepts(&w,&format!("sn-{a}-123"),&meta(b),1000));
  let other="BJP00326060100200003";assert!(!accepts(&w,&format!("sn-{other}-123"),&meta(other),1000));
  assert!(matches_environment(&w,&format!("{b},{a}")));assert!(!matches_environment(&w,a));
  w.enabled=false;assert!(!accepts(&w,&format!("sn-{b}-123"),&meta(b),1000));w.enabled=true;
  w.allowlist.push(other.into());assert!(!accepts(&w,&format!("sn-{a}-123"),&meta(a),1000));
  w.allowlist=vec![a.into(),a.into()];assert!(!matches_environment(&w,&format!("{a},{a}")));
  w.allowlist=vec![a.into(),"00100004".into()];assert!(!accepts(&w,&format!("sn-{a}-123"),&meta(a),1000));
 }
 #[test] fn legacy_window_and_conflicting_lists() {
  let raw=r#"{"enabled":true,"sn":"BJP00326070803800006","expires_at_ms":9000,"generation":"old"}"#;
  let mut w:Window=serde_json::from_str(raw).unwrap();assert!(matches_environment(&w,"BJP00326070803800006"));
  w.allowlist=vec!["BJP00326060100100004".into()];assert!(allowed(&w).is_empty());
 }

}
