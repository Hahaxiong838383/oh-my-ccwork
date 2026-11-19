//! Read-only isolated transport experiment. Does not join RTC or play audio.
//! Never print credentials, signed URLs, audio bytes or provider error bodies.
use anyhow::{Result, bail};
use base64::{Engine as _,engine::general_purpose::STANDARD as B64};
use futures_util::{SinkExt,StreamExt};
use hmac::{Hmac,Mac};
use sha2::Sha256;
use serde_json::{Value,json};
use std::time::{Instant,Duration};
use tokio_tungstenite::{tungstenite::{Message,client::IntoClientRequest},MaybeTlsStream};
#[path="../../../src/voice_connect.rs"] mod voice_connect;
const HOST:&str="cbm01.cn-huabei-1.xf-yun.com";
const PATH:&str="/v1/private/mcd9m97e6";
fn auth()->Result<String>{
 let key=std::env::var("XFYUN_TTS_API_KEY")?;let secret=std::env::var("XFYUN_TTS_API_SECRET")?;
 let date=chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
 let mut mac=<Hmac<Sha256>>::new_from_slice(secret.as_bytes())?;
 mac.update(format!("host: {HOST}\ndate: {date}\nGET {PATH} HTTP/1.1").as_bytes());
 let sig=B64.encode(mac.finalize().into_bytes());
 let authorization=B64.encode(format!("api_key=\"{key}\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"{sig}\""));
 Ok(reqwest::Url::parse_with_params(&format!("wss://{HOST}{PATH}"), &[("host",HOST),("date",date.as_str()),("authorization",authorization.as_str())])?.to_string())
}
fn emit(v:Value){println!("{v}");}
async fn trial(mode:&str,id:usize)->Value{
 let start=Instant::now();let mut phase="auth";
 let mut stats=json!({"id":id,"mode":mode,"at":chrono::Utc::now().to_rfc3339(),"probe":true});
 let res=async{
 let url=auth()?;phase="connect";
 let conn=tokio::time::timeout(Duration::from_secs(10),async{
  if mode=="legacy" {return tokio_tungstenite::connect_async(url).await.map(|v|v.0).map_err(|_|anyhow::anyhow!("handshake"));}
  phase="dns";let d=Instant::now();
  let sock=if mode=="async"{let c=voice_connect::connect(HOST,443).await?;stats["dns_ms"]=json!(c.dns_ms);stats["tcp_ms"]=json!(c.tcp_ms);c.socket}
  else{let a:Vec<_>=tokio::net::lookup_host((HOST,443)).await?.collect();stats["dns_ms"]=json!(d.elapsed().as_millis());phase="tcp";let t=Instant::now();let s=tokio::net::TcpStream::connect(a.as_slice()).await?;stats["tcp_ms"]=json!(t.elapsed().as_millis());s};
  stats["peer"]=json!(sock.peer_addr()?.to_string());stats["local"]=json!(sock.local_addr()?.to_string());
  emit(json!({"event":"tcp_connected","id":id,"mode":mode,"local":stats["local"],"peer":stats["peer"],"at":chrono::Utc::now().to_rfc3339()}));
  phase="tls_ws";let t=Instant::now();let req=url.into_client_request()?;
  let (ws,_)=tokio_tungstenite::client_async_tls_with_config(req,sock,None,None).await.map_err(|_|anyhow::anyhow!("handshake"))?;
  stats["tls_ws_ms"]=json!(t.elapsed().as_millis());Ok(ws)
 }).await;
 let mut ws=match conn{Ok(Ok(w))=>w,Ok(Err(_))=>bail!("connect_failed"),Err(_)=>bail!("connect_timeout")};
 stats["connect_ms"]=json!(start.elapsed().as_millis());
 if let MaybeTlsStream::Rustls(s)=ws.get_ref(){stats["peer"]=json!(s.get_ref().0.peer_addr()?.to_string());stats["local"]=json!(s.get_ref().0.local_addr()?.to_string());}
 emit(json!({"event":"ws_connected","id":id,"mode":mode,"local":stats["local"],"peer":stats["peer"],"at":chrono::Utc::now().to_rfc3339()}));
 let text="你好呀。今天我们一起读一个有趣的小故事。";
 let app=std::env::var("XFYUN_TTS_APP_ID")?;
 let vcn=std::env::var("XFYUN_TTS_VCN").unwrap_or("x6_lingxiaoxuan_pro".into());
 let speed=std::env::var("XFYUN_TTS_SPEED").ok().and_then(|s|s.parse::<i64>().ok()).unwrap_or(50);
 let oral=std::env::var("XFYUN_TTS_ORAL_LEVEL").unwrap_or("mid".into());
 let req=json!({"header":{"app_id":app,"status":2},"parameter":{"oral":{"oral_level":oral},"tts":{"vcn":vcn,"speed":speed,"volume":50,"pitch":50,"audio":{"encoding":"raw","sample_rate":24000,"channels":1,"bit_depth":16,"frame_size":0}}},"payload":{"text":{"encoding":"utf8","compress":"raw","format":"plain","status":2,"seq":1,"text":B64.encode(text.as_bytes())}}});
 phase="send";ws.send(Message::Text(req.to_string().into())).await?;let sent=Instant::now();
 let mut chunks=Vec::new();let mut total=0usize;phase="receive";
 loop{
  let msg=tokio::time::timeout(Duration::from_secs(12),ws.next()).await.map_err(|_|anyhow::anyhow!("receive_timeout"))?;
  let raw=match msg{Some(Ok(Message::Text(v)))=>v,Some(Ok(Message::Ping(_)))=>continue,_=>bail!("receive_end")};
  let v:Value=serde_json::from_str(&raw)?;
  let code=v.pointer("/header/code").and_then(Value::as_i64).unwrap_or(0);
  if code!=0{stats["provider_code"]=json!(code);bail!("provider_error");}
  if let Some(b64)=v.pointer("/payload/audio/audio").and_then(Value::as_str){let n=B64.decode(b64)?.len();if n>0{total+=n;chunks.push(json!({"at_ms":sent.elapsed().as_millis(),"audio_ms":n/48}));}}
  stats["chunks"]=json!(chunks);stats["audio_ms"]=json!(total/48);
  if v.pointer("/payload/audio/status").and_then(Value::as_i64)==Some(2){break;}
 }
 stats["stream_ms"]=json!(sent.elapsed().as_millis());phase="close";
 let _=tokio::time::timeout(Duration::from_millis(500),ws.close(None)).await;
 Ok::<_,anyhow::Error>(())
 }.await;
 stats["status"]=json!(if res.is_ok(){"ok"}else{"failed"});stats["phase"]=json!(phase);stats["elapsed_ms"]=json!(start.elapsed().as_millis());stats
}
#[tokio::main]
async fn main(){
 let _=rustls::crypto::ring::default_provider().install_default();
 for name in ["XFYUN_TTS_APP_ID","XFYUN_TTS_API_KEY","XFYUN_TTS_API_SECRET"]{if std::env::var(name).unwrap_or_default().is_empty(){emit(json!({"status":"missing_config"}));std::process::exit(2);}}
 let n=std::env::var("PROBE_ROUNDS").ok().and_then(|s|s.parse::<usize>().ok()).unwrap_or(4).min(12);
 for i in 0..n{let order=if i%2==0{["legacy","current","async"]}else{["async","current","legacy"]};for (j,mode) in order.iter().enumerate(){emit(trial(mode,i*3+j).await);tokio::time::sleep(Duration::from_millis(800)).await;}}
}
