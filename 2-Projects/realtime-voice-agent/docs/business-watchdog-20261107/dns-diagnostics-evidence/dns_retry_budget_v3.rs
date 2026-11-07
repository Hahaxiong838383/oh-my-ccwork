use hickory_resolver::{TokioResolver,config::{ResolverConfig,NameServerConfig},net::runtime::TokioRuntimeProvider,
    proto::{op::{Message,OpCode},rr::{Record,RData,RecordType,rdata::{A,CNAME}}}};
use std::{sync::{Arc,Mutex},collections::HashMap,time::{Duration,Instant}};
use tokio::net::UdpSocket;
use serde_json::json;

async fn scenario(mode:&'static str)->serde_json::Value {
    let socket=UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut server=NameServerConfig::udp("127.0.0.1".parse().unwrap());
    server.connections[0].port=socket.local_addr().unwrap().port();
    let mut builder=TokioResolver::builder_with_config(ResolverConfig::from_name_servers(vec![server]),TokioRuntimeProvider::default());
    builder.options_mut().timeout=Duration::from_secs(1);builder.options_mut().attempts=2;
    let resolver=builder.build().unwrap();let start=Instant::now();
    let events=Arc::new(Mutex::new(Vec::new()));let observed=events.clone();
    let task=tokio::spawn(async move {
        let mut buf=[0;2048];let mut counts=HashMap::new();let mut began=HashMap::new();
        let mut pending=Vec::new();
        loop {
            tokio::select! {
                incoming=socket.recv_from(&mut buf)=>{
                    let (n,peer)=incoming.unwrap();let req=Message::from_vec(&buf[..n]).unwrap();let q=req.queries[0].clone();
                    let name=q.name().to_string();let count=counts.entry(name.clone()).or_insert(0);*count+=1;
                    began.entry(name.clone()).or_insert_with(Instant::now);
                    observed.lock().unwrap().push(json!({"qname":name,"count":*count,"id":req.metadata.id,"source_port":peer.port(),"at_ms":start.elapsed().as_millis()}));
                    pending.push((req,peer));
                },
                _=tokio::time::sleep(Duration::from_millis(10))=>{},
            }
            let mut waiting=Vec::new();
            for (req,peer) in pending.drain(..) {
                let q=req.queries[0].clone();let name=q.name().to_string();let initial=name=="slow.example.";
                let due=began[&name].elapsed()>=Duration::from_millis(if initial{2800}else{1900});
                if mode=="silent" || !due {waiting.push((req,peer));continue;}
                let mut resp=Message::response(req.metadata.id,OpCode::Query);resp.add_query(q.clone());
                if initial && mode=="cname" {resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::CNAME(CNAME("target.example.".parse().unwrap())))]);}
                else {resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,1)))]);}
                socket.send_to(&resp.to_vec().unwrap(),peer).await.unwrap();
            }
            pending=waiting;
        }
    });
    let result=tokio::time::timeout(Duration::from_secs(8),resolver.lookup("slow.example.",RecordType::A)).await;
    let elapsed=start.elapsed().as_millis();task.abort();let _=task.await;
    let rows=events.lock().unwrap().clone();
    let success=matches!(&result,Ok(Ok(_)));
    let output=json!({"mode":mode,"success":success,"outer_timeout":result.is_err(),"elapsed_ms":elapsed,"queries":rows});
    println!("{output}");
    match mode {
        "cname"=>{assert!(success && (4400..5500).contains(&elapsed));assert!(rows.iter().any(|r|r["qname"]=="target.example."));},
        "direct"=>{assert!(success && (2600..3500).contains(&elapsed));assert!(rows.len()>=3);},
        _=>{assert!(!success && !result.is_err() && (2800..3700).contains(&elapsed));assert!(rows.len()>=3);},
    }
    output
}
#[tokio::main]
async fn main(){for mode in ["cname","direct","silent"]{scenario(mode).await;}println!("HYPOTHESIS_FIXTURE_PASS_NOT_HISTORICAL_PROOF");}
