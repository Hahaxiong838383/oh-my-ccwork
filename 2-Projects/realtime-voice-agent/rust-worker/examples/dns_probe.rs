//! Bounded, credential-free production-connector diagnostic. No RTC registration.
#[path = "../src/voice_connect.rs"]
mod voice_connect;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde_json::json;
use hickory_resolver::{TokioResolver, proto::rr::RecordType};
const HOST: &str = "cbm01.cn-huabei-1.xf-yun.com";
fn at() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() }

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mode=args.get(1).map(String::as_str).unwrap_or("connect");
    anyhow::ensure!(["connect","lookup"].contains(&mode),"mode must be connect or lookup");
    let rounds: usize=args.get(2).map(|s|s.parse()).transpose()?.unwrap_or(6);
    anyhow::ensure!((1..=12).contains(&rounds),"rounds outside bounds");
    let mut b=TokioResolver::builder_tokio()?;
    b.options_mut().timeout=Duration::from_secs(1);
    b.options_mut().attempts=2;
    let resolver=b.build()?;
    println!("{}",json!({"kind":"start","at_ms":at(),"pid":std::process::id(),"mode":mode,"rounds":rounds,"host":HOST,"options":format!("{:?}",resolver.options())}));
    for round in 0..rounds {
        let t=Instant::now();
        if mode=="connect" {
            let first=voice_connect::connect(HOST,443);
            let spare=async {tokio::time::sleep(Duration::from_millis(650)).await;voice_connect::connect(HOST,443).await};
            // Diagnostic pair waits for both, unlike the foreground race. It sends
            // no TLS/auth/text and does not share a resolver with the live worker.
            let run=async {tokio::join!(first,spare)};
            match tokio::time::timeout(Duration::from_secs(10),run).await {
                Ok((a,b))=>{
                    for (which,r) in [("primary",a),("spare",b)] {
                        match r {
                            Ok(c)=>println!("{}",json!({"kind":"connect","at_ms":at(),"round":round,"which":which,"elapsed_pair_ms":t.elapsed().as_millis(),"dns_ms":c.dns_ms,"tcp_ms":c.tcp_ms,"peer":c.socket.peer_addr()?.to_string(),"ok":true})),
                            Err(e)=>println!("{}",json!({"kind":"connect","at_ms":at(),"round":round,"which":which,"elapsed_pair_ms":t.elapsed().as_millis(),"ok":false,"error":format!("{e:#}")})),
                        }
                    }
                },
                Err(_)=>println!("{}",json!({"kind":"connect_timeout","at_ms":at(),"round":round,"elapsed_ms":t.elapsed().as_millis()})),
            }
        } else {
            for q in [RecordType::A,RecordType::AAAA] {
                let t=Instant::now();
                let r=tokio::time::timeout(Duration::from_secs(10),resolver.lookup(HOST,q)).await;
                match r {
                    Ok(Ok(v))=>println!("{}",json!({"kind":"lookup","at_ms":at(),"round":round,"qtype":q.to_string(),"elapsed_ms":t.elapsed().as_millis(),"ok":true,"answers":format!("{:?}",v.answers())})),
                    Ok(Err(e))=>println!("{}",json!({"kind":"lookup","at_ms":at(),"round":round,"qtype":q.to_string(),"elapsed_ms":t.elapsed().as_millis(),"ok":false,"error":format!("{e:?}")})),
                    Err(_)=>println!("{}",json!({"kind":"lookup_timeout","at_ms":at(),"round":round,"qtype":q.to_string(),"elapsed_ms":t.elapsed().as_millis()})),
                }
            }
        }
        if round+1<rounds {tokio::time::sleep(Duration::from_secs(8)).await;}
    }
    println!("{}",json!({"kind":"complete","at_ms":at()}));
    Ok(())
}
