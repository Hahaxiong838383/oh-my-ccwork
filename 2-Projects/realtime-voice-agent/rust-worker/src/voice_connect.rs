//! Candidate-only asynchronous DNS and staggered address racing.
//! Cache lifetimes come from DNS; credentials and signed URLs never enter here.
use anyhow::{bail, Result};
use hickory_resolver::{TokioResolver, lookup::Lookup, proto::rr::{DNSClass, Name, RData, RecordType}};
use std::{net::{IpAddr, SocketAddr}, time::{Duration, Instant}};
use tokio::net::TcpStream;

pub struct Connected { pub socket: TcpStream, pub dns_ms: u64, pub tcp_ms: u64 }

pub async fn connect(host: &str, port: u16) -> Result<Connected> {
    static RESOLVER: std::sync::OnceLock<std::result::Result<TokioResolver, String>> = std::sync::OnceLock::new();
    let resolver = RESOLVER.get_or_init(|| {
        let mut builder = TokioResolver::builder_tokio().map_err(|_| "resolver_config".to_owned())?;
        builder.options_mut().timeout = Duration::from_secs(1);
        builder.options_mut().attempts = 2;
        builder.build().map_err(|_| "resolver_init".to_owned())
    }).as_ref().map_err(|_| anyhow::anyhow!("resolver_init"))?;
    dial(resolver, host, port).await
}

async fn addresses_connect(addresses: Vec<SocketAddr>) -> Result<TcpStream> {
    let mut attempts = tokio::task::JoinSet::new();
    // All tasks are owned by this scope: success, timeout and interruption drop
    // the losing sockets/futures. Limit the fan-out even for large DNS replies.
    for (index, address) in addresses.into_iter().take(8).enumerate() {
        attempts.spawn(async move {
            tokio::time::sleep(Duration::from_millis(index as u64 * 250)).await;
            TcpStream::connect(address).await
        });
    }
    while let Some(result) = attempts.join_next().await {
        if let Ok(Ok(socket)) = result { return Ok(socket); }
    }
    bail!("connect_failed")
}

async fn family(resolver: &TokioResolver, host: &str, port: u16, v6: bool) -> Result<Connected> {
    let start=Instant::now();
    let lookup=resolver.lookup(host,if v6 {RecordType::AAAA} else {RecordType::A}).await
        .map_err(|_| anyhow::anyhow!("resolve_failed"))?;
    let (addresses,uncache_names)=lookup_addresses(&lookup,port,v6)?;
    if !uncache_names.is_empty() {
        // Hickory 0.26 caches a response by ANSWER TTL, which can outlive
        // a target in ADDITIONAL. Do not cache this shape at application level.
        // Invalidate only this family and the observed alias chain, never the
        // shared resolver globally. Normal ANSWER records keep their cache.
        let kind=if v6 {RecordType::AAAA} else {RecordType::A};
        resolver.clear_lookup_cache(host,kind);
        for name in uncache_names {resolver.clear_lookup_cache(name,kind);}
    }
    let dns_ms=start.elapsed().as_millis() as u64;let tcp=Instant::now();
    let socket=addresses_connect(addresses).await?;
    Ok(Connected{socket,dns_ms,tcp_ms:tcp.elapsed().as_millis() as u64})
}

fn lookup_addresses(lookup: &Lookup, port: u16, v6: bool) -> Result<(Vec<SocketAddr>,Vec<Name>)> {
    // Hickory preserves DNS sections. A successful CNAME lookup can have its
    // target address in ADDITIONAL, not ANSWER. Follow only the answer's CNAME
    // chain and select that owner; unrelated additional/glue is not a target.
    let mut owner=lookup.query().name().clone();
    let mut seen=std::collections::HashSet::new();seen.insert(owner.clone());
    while let Some(next)=lookup.answers().iter().find_map(|r| {
        if r.name!=owner || r.dns_class!=DNSClass::IN{return None;}
        match &r.data {RData::CNAME(name)=>Some(name.0.clone()),_=>None}
    }) {
        if !seen.insert(next.clone()){bail!("resolve_cname_cycle");}
        owner=next;
    }
    let mut addresses=Vec::new();let mut uses_additional=false;
    for (r,additional) in lookup.answers().iter().map(|r|(r,false)).chain(lookup.additionals().iter().map(|r|(r,true))) {
        if r.name!=owner || r.dns_class!=DNSClass::IN{continue;}
        let address=match r.data {
            RData::A(a) if !v6=>SocketAddr::new(IpAddr::V4(a.0),port),
            RData::AAAA(a) if v6=>SocketAddr::new(IpAddr::V6(a.0),port),_=>continue,
        };
        uses_additional|=additional;
        if !addresses.contains(&address){addresses.push(address);}
    }
    Ok((addresses,if uses_additional {seen.into_iter().collect()} else {Vec::new()}))
}

async fn dial(resolver: &TokioResolver, host: &str, port: u16) -> Result<Connected> {
    if let Ok(ip)=host.parse::<IpAddr>() {
        let start=Instant::now();let socket=TcpStream::connect(SocketAddr::new(ip,port)).await?;
        return Ok(Connected{socket,dns_ms:0,tcp_ms:start.elapsed().as_millis() as u64});
    }
    // Independent families: a missing AAAA response cannot delay working A,
    // and a stalled IPv4 TCP connect cannot prevent IPv6 success. This applies
    // the racing principle of RFC8305; it does not claim full RFC conformance.
    let v4=family(resolver,host,port,false);
    let v6=async {tokio::time::sleep(Duration::from_millis(50)).await;family(resolver,host,port,true).await};
    tokio::pin!(v4,v6);
    tokio::select! {
        result=&mut v4 => match result {Ok(c)=>Ok(c),Err(_)=>v6.await},
        result=&mut v6 => match result {Ok(c)=>Ok(c),Err(_)=>v4.await},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_resolver::{config::{ResolverConfig, NameServerConfig}, net::runtime::TokioRuntimeProvider,
        proto::{op::{Message, OpCode}, rr::{Record, rdata::{A, AAAA, CNAME}}}};
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use tokio::net::{UdpSocket,TcpListener};
    struct Dns { resolver: TokioResolver, a: Arc<AtomicUsize>, task: tokio::task::JoinHandle<()> }
    impl Drop for Dns {fn drop(&mut self){self.task.abort();}}
    async fn dns_server(mode: &'static str) -> Dns {
        let socket=UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut server=NameServerConfig::udp("127.0.0.1".parse().unwrap());
        server.connections[0].port=socket.local_addr().unwrap().port();
        let mut builder=TokioResolver::builder_with_config(ResolverConfig::from_name_servers(vec![server]),TokioRuntimeProvider::default());
        builder.options_mut().attempts=1;builder.options_mut().timeout=Duration::from_millis(800);
        let resolver=builder.build().unwrap();let a=Arc::new(AtomicUsize::new(0));let count=a.clone();
        let task=tokio::spawn(async move {
            let mut buf=[0;2048];
            loop {
                let (n,peer)=socket.recv_from(&mut buf).await.unwrap();
                let req=Message::from_vec(&buf[..n]).unwrap();let q=req.queries[0].clone();
                if mode=="silent" || (mode=="a_only" && q.query_type()==RecordType::AAAA) {continue;}
                let mut resp=Message::response(req.metadata.id,OpCode::Query);resp.add_query(q.clone());
                if q.query_type()==RecordType::A {
                    count.fetch_add(1,Ordering::SeqCst);
                    if mode=="cname_answer" {
                        resp.add_answers(vec![
                            Record::from_rdata(q.name().clone(),60,RData::CNAME(CNAME("target.voice.test.".parse().unwrap()))),
                            Record::from_rdata("target.voice.test.".parse().unwrap(),1,RData::A(A::new(127,0,0,1))),
                        ]);
                    } else if mode=="cname_recursive" {
                        let target=match q.name().to_string().as_str() {
                            "voice.test."=>Some("middle.voice.test."),
                            "middle.voice.test."=>Some("target.voice.test."),_=>None,
                        };
                        if let Some(target)=target {
                            resp.add_answers(vec![Record::from_rdata(q.name().clone(),60,RData::CNAME(CNAME(target.parse().unwrap())))]);
                        } else {
                            resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,1)))]);
                        }
                    } else if mode=="cname_additional" || mode=="cname_zero" || mode=="cname_multi_additional" {
                        let target="target.voice.test.".parse().unwrap();
                        if mode=="cname_multi_additional" {
                            resp.add_answers(vec![
                                Record::from_rdata(q.name().clone(),60,RData::CNAME(CNAME("middle.voice.test.".parse().unwrap()))),
                                Record::from_rdata("middle.voice.test.".parse().unwrap(),60,RData::CNAME(CNAME(target))),
                            ]);
                        } else {resp.add_answers(vec![Record::from_rdata(q.name().clone(),60,RData::CNAME(CNAME(target)))]);}
                        resp.add_additionals(vec![Record::from_rdata("unrelated.voice.test.".parse().unwrap(),60,RData::A(A::new(127,0,0,2)))]);
                        resp.add_additionals(vec![Record::from_rdata("target.voice.test.".parse().unwrap(),if mode=="cname_zero" {0}else{1},RData::A(A::new(127,0,0,1)))]);
                    } else if mode!="v6_only" && mode!="cname_additional_v6" {
                        if mode=="refused_first" {resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,2)))]);}
                        resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,1)))]);
                    }
                } else if q.query_type()==RecordType::AAAA && mode=="v6_only" {
                    resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::AAAA(AAAA(std::net::Ipv6Addr::LOCALHOST)))]);
                } else if q.query_type()==RecordType::AAAA && mode=="cname_additional_v6" {
                    resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::CNAME(CNAME("target.voice.test.".parse().unwrap())))]);
                    resp.add_additionals(vec![Record::from_rdata("target.voice.test.".parse().unwrap(),1,RData::AAAA(AAAA(std::net::Ipv6Addr::LOCALHOST)))]);
                }
                socket.send_to(&resp.to_vec().unwrap(),peer).await.unwrap();
            }
        });Dns{resolver,a,task}
    }
    #[tokio::test]
    async fn r16_a_success_does_not_wait_for_missing_aaaa_and_obeys_ttl() {
        let dns=dns_server("a_only").await;let server=TcpListener::bind("127.0.0.1:0").await.unwrap();let port=server.local_addr().unwrap().port();
        for _ in 0..2 {
            let c=tokio::time::timeout(Duration::from_millis(400),dial(&dns.resolver,"voice.test.",port)).await.unwrap().unwrap();
            assert!(c.socket.peer_addr().unwrap().is_ipv4());
        }
        assert_eq!(dns.a.load(Ordering::SeqCst),1);
        tokio::time::sleep(Duration::from_millis(1150)).await;
        dial(&dns.resolver,"voice.test.",port).await.unwrap();
        assert_eq!(dns.a.load(Ordering::SeqCst),2);
    }
    #[tokio::test]
    async fn r16_ipv6_and_alternate_address_remain_available() {
        let dns=dns_server("v6_only").await;let server=TcpListener::bind("[::1]:0").await.unwrap();
        let c=tokio::time::timeout(Duration::from_secs(2),dial(&dns.resolver,"voice.test.",server.local_addr().unwrap().port())).await.unwrap().unwrap();
        assert!(c.socket.peer_addr().unwrap().is_ipv6());
        let dns=dns_server("refused_first").await;let server=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let c=tokio::time::timeout(Duration::from_millis(600),dial(&dns.resolver,"voice.test.",server.local_addr().unwrap().port())).await.unwrap().unwrap();
        assert_eq!(c.socket.peer_addr().unwrap().ip(),"127.0.0.1".parse::<IpAddr>().unwrap());
    }
    #[tokio::test]
    async fn r16_dns_dial_cancellation_is_bounded() {
        let dns=dns_server("silent").await;
        assert!(tokio::time::timeout(Duration::from_millis(100),dial(&dns.resolver,"voice.test.",443)).await.is_err());
    }
    #[tokio::test]
    async fn cname_target_in_additional_is_not_discarded_as_no_addresses() {
        let dns=dns_server("cname_additional").await;
        let server=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=server.local_addr().unwrap().port();
        let _unrelated=TcpListener::bind((std::net::Ipv4Addr::new(127,0,0,2),port)).await.unwrap();
        for _ in 0..2 {
            let c=tokio::time::timeout(Duration::from_millis(400),dial(&dns.resolver,"voice.test.",port)).await.unwrap().unwrap();
            assert_eq!(c.socket.peer_addr().unwrap().ip(),std::net::Ipv4Addr::LOCALHOST);
        }
        assert_eq!(dns.a.load(Ordering::SeqCst),2,"additional response must bypass the longer alias cache");
        tokio::time::sleep(Duration::from_millis(1150)).await;
        dial(&dns.resolver,"voice.test.",port).await.unwrap();
        assert_eq!(dns.a.load(Ordering::SeqCst),3,"additional address must not extend DNS TTL");
    }
    #[tokio::test]
    async fn cname_additional_ipv6_remains_usable() {
        let dns=dns_server("cname_additional_v6").await;
        let server=TcpListener::bind("[::1]:0").await.unwrap();
        let c=tokio::time::timeout(Duration::from_millis(400),dial(&dns.resolver,"voice.test.",server.local_addr().unwrap().port())).await.unwrap().unwrap();
        assert_eq!(c.socket.peer_addr().unwrap().ip(),std::net::Ipv6Addr::LOCALHOST);
    }
    #[tokio::test]
    async fn cname_answer_preserves_the_shortest_answer_ttl() {
        let dns=dns_server("cname_answer").await;
        let server=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=server.local_addr().unwrap().port();
        for _ in 0..2 {dial(&dns.resolver,"voice.test.",port).await.unwrap();}
        assert_eq!(dns.a.load(Ordering::SeqCst),1,"ordinary CNAME answer should remain cached");
        tokio::time::sleep(Duration::from_millis(1150)).await;
        dial(&dns.resolver,"voice.test.",port).await.unwrap();
        assert_eq!(dns.a.load(Ordering::SeqCst),2);
    }
    #[tokio::test]
    async fn multihop_and_zero_ttl_additional_results_are_requeried() {
        for mode in ["cname_multi_additional","cname_zero"] {
            let dns=dns_server(mode).await;
            let server=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port=server.local_addr().unwrap().port();
            for _ in 0..2 {
                let c=tokio::time::timeout(Duration::from_secs(2),dial(&dns.resolver,"voice.test.",port)).await.unwrap().unwrap();
                assert_eq!(c.socket.peer_addr().unwrap().ip(),std::net::Ipv4Addr::LOCALHOST);
            }
            assert_eq!(dns.a.load(Ordering::SeqCst),2,"must invalidate every cached alias in the observed chain");
        }
    }
    #[tokio::test]
    async fn recursive_lookup_owner_and_cached_original_owner_both_work() {
        let dns=dns_server("cname_recursive").await;
        let server=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=server.local_addr().unwrap().port();
        for _ in 0..2 {dial(&dns.resolver,"voice.test.",port).await.unwrap();}
        assert_eq!(dns.a.load(Ordering::SeqCst),3);
        tokio::time::sleep(Duration::from_millis(1150)).await;
        dial(&dns.resolver,"voice.test.",port).await.unwrap();
        assert_eq!(dns.a.load(Ordering::SeqCst),6);
    }
}
