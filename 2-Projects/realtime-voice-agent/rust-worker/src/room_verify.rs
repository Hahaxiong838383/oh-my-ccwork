//! SID checks around foreground name-based cleanup (not compare-and-delete). A successful delete response is
//! not sufficient evidence that either participant left the original room.
use crate::config::Config;
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Outcome { Gone, Superseded, Pending, Unavailable }
pub async fn delete_exact(cfg: &Config, url: &str, room: &str, sid: &str) -> Outcome {
    // Hard total budget, including DNS and readback. Never leak HTTP errors,
    // headers, signed URLs or credentials into the diagnostic outcome.
    tokio::time::timeout(std::time::Duration::from_secs(8), delete_inner(cfg,url,room,sid))
        .await.unwrap_or(Outcome::Unavailable)
}
async fn delete_inner(cfg: &Config, url: &str, room: &str, sid: &str) -> Outcome {
    if room.is_empty() || !sid.starts_with("RM_") { return Outcome::Unavailable; }
    let Ok(mut base) = reqwest::Url::parse(url) else { return Outcome::Unavailable; };
    if !base.username().is_empty() || base.password().is_some() || base.query().is_some()
        || base.fragment().is_some() || base.path() != "/" { return Outcome::Unavailable; }
    let scheme = match base.scheme() { "wss"=>"https", "ws" if matches!(base.host_str(),Some("127.0.0.1"|"localhost"|"::1"))=>"http", _=>return Outcome::Unavailable };
    if base.set_scheme(scheme).is_err() { return Outcome::Unavailable; }
    let Ok(read_token) = crate::token::room_list_jwt(&cfg.api_key,&cfg.api_secret) else { return Outcome::Unavailable; };
    let Ok(delete_token) = crate::token::server_api_jwt(&cfg.api_key,&cfg.api_secret,room) else { return Outcome::Unavailable; };
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client=CLIENT.get_or_init(|| reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never()).build().expect("cleanup verifier client"));
    let read_url=base.join("twirp/livekit.RoomService/ListRooms").unwrap();
    let before=match read_sid(client,&read_url,&read_token,room).await { Ok(v)=>v,Err(())=>return Outcome::Unavailable };
    match before.as_deref() { None=>return Outcome::Gone,Some(value) if value!=sid=>return Outcome::Superseded,_=>{} }
    // A reused name seen before deletion is never deleted. Room names are
    // server-generated per session; always read back the original SID after.
    let _=client.post(base.join("twirp/livekit.RoomService/DeleteRoom").unwrap()).bearer_auth(delete_token)
        .json(&serde_json::json!({"room":room})).timeout(std::time::Duration::from_secs(2)).send().await;
    for attempt in 0..3 {
        match read_sid(client,&read_url,&read_token,room).await {
            Ok(None)=>return Outcome::Gone,
            Ok(Some(found)) if found!=sid=>return Outcome::Superseded,
            Err(())=>return Outcome::Unavailable,
            _=>{}
        }
        if attempt<2 { tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
    }
    Outcome::Pending
}
async fn read_sid(client:&reqwest::Client,url:&reqwest::Url,token:&str,room:&str)->Result<Option<String>,()> {
    let mut response=client.post(url.clone()).bearer_auth(token).json(&serde_json::json!({"names":[room]}))
        .timeout(std::time::Duration::from_secs(2)).send().await.map_err(|_|())?;
    if !response.status().is_success() { return Err(()); }
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|())? {
        if bytes.len()+chunk.len()>16384 { return Err(()); } bytes.extend_from_slice(&chunk);
    }
    let value:serde_json::Value=serde_json::from_slice(&bytes).map_err(|_|())?;
    let rooms=value["rooms"].as_array().ok_or(())?;
    if rooms.is_empty() { return Ok(None); }
    if rooms.len()!=1 || rooms[0]["name"].as_str()!=Some(room) { return Err(()); }
    let sid=rooms[0]["sid"].as_str().filter(|s|s.starts_with("RM_") && s.len()>3).ok_or(())?;
    Ok(Some(sid.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    async fn scenario(before: &str, after: &str, status: u16) -> (Outcome,Vec<String>) {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=format!("ws://{}",listener.local_addr().unwrap());
        let methods=Arc::new(Mutex::new(Vec::new()));let seen=methods.clone();
        let before=before.to_string();let after=after.to_string();
        let server=tokio::spawn(async move {
            let mut current_sid=if before=="race" {"RM_original".to_string()} else {before.clone()};
            loop {
                let (mut socket,_)=listener.accept().await.unwrap();let mut request=Vec::new();
                loop {let mut buf=[0;2048];let n=socket.read(&mut buf).await.unwrap();assert!(n>0 && request.len()+n<8192);request.extend_from_slice(&buf[..n]);
                    let text=String::from_utf8_lossy(&request);
                    if let Some((head,body))=text.split_once("\r\n\r\n") {let len=head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ").and_then(|v| v.parse::<usize>().ok())).unwrap();if body.len()>=len {break;}}
                }
                let request=String::from_utf8_lossy(&request);let path=request.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let method=path.rsplit('/').next().unwrap();seen.lock().unwrap().push(method.to_string());
                let (body,code)=if method=="DeleteRoom" {
                    if before=="race" {current_sid="RM_new".into();seen.lock().unwrap().push(format!("removed:{current_sid}"));}
                    current_sid=after.clone();("{}".to_string(),status)
                } else {
                    assert_eq!(method,"ListRooms");let sid=&current_sid;
                    (if sid=="invalid" {"{}".to_string()} else if sid.is_empty(){"{\"rooms\":[]}".to_string()}
                        else {serde_json::json!({"rooms":[{"name":"sn-BJP00326110799999901-123","sid":sid}]}).to_string()},200)
                };
                let response=format!("HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let cfg=Config {ws_url:url.clone(),api_key:"test".into(),api_secret:"synthetic".into(),agent_name:"rust-worker".into(),max_jobs:1};
        let outcome=delete_exact(&cfg,&url,"sn-BJP00326110799999901-123","RM_original").await;
        server.abort();let _=server.await;let recorded=methods.lock().unwrap().clone();(outcome,recorded)
    }
    #[tokio::test]
    async fn absent_readback_does_not_prove_a_racing_replacement_survived_name_delete() {
        // Real localhost HTTP: the server changes the binding only inside the
        // DeleteRoom handler, after our preflight ListRooms. The API carries
        // no expected SID. Gone is an observation, never CAS evidence.
        let (outcome,methods)=scenario("race","",200).await;
        assert_eq!(outcome,Outcome::Gone);
        assert_eq!(methods,vec!["ListRooms","DeleteRoom","removed:RM_new","ListRooms"]);
    }
    #[tokio::test]
    async fn delete_200_with_original_sid_present_is_not_success() {
        let (outcome,methods)=scenario("RM_original","RM_original",200).await;
        assert_eq!(outcome,Outcome::Pending);assert_eq!(methods.iter().filter(|m|m.as_str()=="DeleteRoom").count(),1);
    }
    #[tokio::test]
    async fn disappearance_is_verified_by_a_fresh_room_list() {
        let (outcome,methods)=scenario("RM_original","",200).await;
        assert_eq!(outcome,Outcome::Gone);assert_eq!(methods,vec!["ListRooms","DeleteRoom","ListRooms"]);
    }
    #[tokio::test]
    async fn absent_or_replaced_sid_never_deletes_a_new_room() {
        for (before,expected) in [("",Outcome::Gone),("RM_new",Outcome::Superseded)] {
            let (outcome,methods)=scenario(before,"",200).await;assert_eq!(outcome,expected);assert_eq!(methods,vec!["ListRooms"]);
        }
    }
    #[tokio::test]
    async fn malformed_readback_and_delete_failure_are_visible() {
        assert_eq!(scenario("invalid","",200).await.0,Outcome::Unavailable);
        assert_eq!(scenario("RM_original","RM_original",503).await.0,Outcome::Pending);
    }
}
