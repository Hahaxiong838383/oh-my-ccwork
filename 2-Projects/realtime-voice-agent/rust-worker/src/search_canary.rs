//! Bounded-device canary boundaries; no audio-loop IO.
use serde::Deserialize;
pub const AGENT: &str = "p003-search-canary-20261021";
pub const BASE: &str = "https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1";
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
 agent!=AGENT || window().is_some_and(|w| matches_environment(&w,&std::env::var("P003_SEARCH_DEVICE_ALLOWLIST").unwrap_or_default()) && accepts(&w,room,metadata,now_ms()))
}
pub fn validate_startup(agent:&str,max:usize)->anyhow::Result<()> {
 if agent!=AGENT{return Ok(())}
 let get=|k:&str|std::env::var(k).unwrap_or_default();
 anyhow::ensure!((1..=2).contains(&max) && valid_base(&get("LLM_BASE_URL")),"canary_config");
 anyhow::ensure!(window().is_some_and(|w| matches_environment(&w,&get("P003_SEARCH_DEVICE_ALLOWLIST"))),"canary_window");
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
  let mut payload=serde_json::json!({"agent":agent,"at_ms":now,"registered":last>0&&now.saturating_sub(last)<45000,"jobs":state.active_jobs.load(std::sync::atomic::Ordering::Relaxed),"ordered_pcm_v1":true,"generation":generation});
  if std::env::var("P003_ROOM_CLEANUP_V1").is_ok_and(|v|v=="1") {
   let raw=match std::env::var("P003_ROOM_CLEANUP_STATUS_FILE") {
    Ok(path)=>tokio::fs::read_to_string(path).await.unwrap_or_default(),Err(_)=>String::new(),
   };
   payload["cleanup"]=crate::room_cleanup::health(&raw,now);
  }
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
