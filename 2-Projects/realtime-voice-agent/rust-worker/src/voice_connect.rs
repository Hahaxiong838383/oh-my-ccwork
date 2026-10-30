//! Candidate-only asynchronous DNS and staggered address racing.
//! Cache lifetimes come from DNS; credentials and signed URLs never enter here.
use anyhow::{bail, Result};
use hickory_resolver::{TokioResolver, config::{NameServerConfig, ResolverConfig},
    net::runtime::TokioRuntimeProvider, proto::rr::{RData, RecordType}};
use std::{net::{IpAddr, SocketAddr}, time::{Duration, Instant}};
use tokio::net::TcpStream;

pub struct Connected { pub socket: TcpStream, pub dns_ms: u64, pub tcp_ms: u64, pub dns_path: &'static str }

pub async fn connect(host: &str, port: u16) -> Result<Connected> {
    static RESOLVER: std::sync::OnceLock<std::result::Result<TokioResolver, String>> = std::sync::OnceLock::new();
    let resolver = RESOLVER.get_or_init(|| {
        let mut builder = TokioResolver::builder_tokio().map_err(|_| "resolver_config".to_owned())?;
        builder.options_mut().timeout = Duration::from_secs(1);
        builder.options_mut().attempts = 2;
        builder.build().map_err(|_| "resolver_init".to_owned())
    }).as_ref().map_err(|_| anyhow::anyhow!("resolver_init"))?;
    let fallback=if hedge_enabled(host,std::env::var("P003_TTS_DNS_HEDGE_V1").ok().as_deref()) {
        static UPSTREAM: std::sync::OnceLock<Option<TokioResolver>> = std::sync::OnceLock::new();
        UPSTREAM.get_or_init(||{
            let resolver=configured_upstream();
            tracing::info!(available=resolver.is_some(),"tts DNS independent fallback initialized");
            resolver
        }).as_ref()
    } else {None};
    dial_resolvers(resolver,fallback,host,port).await
}

fn hedge_enabled(host: &str, flag: Option<&str>) -> bool {
    // This connector is called only by the candidate async-DNS path. Never
    // bypass local/split-horizon policies for arbitrary names or new callers.
    flag==Some("1") && host.eq_ignore_ascii_case("cbm01.cn-huabei-1.xf-yun.com")
}

fn upstream_servers(managed_stub: bool, config: &str) -> Vec<IpAddr> {
    if !managed_stub {return vec![];}
    let mut ips=Vec::new();
    for line in config.lines() {
        let mut words=line.split_whitespace();
        if words.next()!=Some("nameserver"){continue;}
        if let Some(ip)=words.next().and_then(|v|v.parse::<IpAddr>().ok()) {
            if !ip.is_loopback()&&!ip.is_unspecified()&&!ip.is_multicast()&&!ips.contains(&ip){ips.push(ip);}
        }
        if ips.len()==2 {break;}
    }
    ips
}

fn configured_upstream() -> Option<TokioResolver> {
    let stub=std::path::Path::new("/run/systemd/resolve/stub-resolv.conf").canonicalize().ok()?;
    let managed=std::path::Path::new("/etc/resolv.conf").canonicalize().ok()?==stub;
    let config=std::fs::read_to_string("/run/systemd/resolve/resolv.conf").ok()?;
    let ips=upstream_servers(managed,&config);
    if ips.is_empty(){return None;}
    let config=ResolverConfig::from_name_servers(ips.into_iter().map(NameServerConfig::udp_and_tcp).collect());
    let mut builder=TokioResolver::builder_with_config(config,TokioRuntimeProvider::default());
    builder.options_mut().timeout=Duration::from_secs(1);
    builder.options_mut().attempts=1;
    builder.build().ok()
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

async fn family(resolver: &TokioResolver, fallback: Option<&TokioResolver>, host: &str, port: u16, v6: bool) -> Result<Connected> {
    let start=Instant::now();
    let kind=if v6 {RecordType::AAAA} else {RecordType::A};
    static HEDGES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let result=match fallback {
        Some(upstream)=>lookup_with_fallback(resolver,upstream,host,kind,Duration::from_millis(200),&HEDGES).await,
        None=>resolver.lookup(host,kind).await.map(|l|(l,"system_resolver")).map_err(anyhow::Error::from),
    };
    let (lookup,dns_path)=result.map_err(|_|anyhow::anyhow!("resolve_failed"))?;
    let addresses=lookup.answers().iter().filter_map(|r|match r.data {
        RData::A(a) if !v6 => Some(SocketAddr::new(IpAddr::V4(a.0),port)),
        RData::AAAA(a) if v6 => Some(SocketAddr::new(IpAddr::V6(a.0),port)),_=>None,
    }).collect();
    let dns_ms=start.elapsed().as_millis() as u64;let tcp=Instant::now();
    let socket=addresses_connect(addresses).await?;
    Ok(Connected{socket,dns_ms,tcp_ms:tcp.elapsed().as_millis() as u64,dns_path})
}

// Hedge only a pending DNS lookup, never a healthy lookup or a slow TCP/TLS
// connection. No queue, blocking OS lookup, new public DNS, or detached task.
async fn lookup_with_fallback(
    resolver: &TokioResolver, fallback: &TokioResolver, host: &str, kind: RecordType,
    delay: Duration, limit: &tokio::sync::Semaphore,
) -> Result<(hickory_resolver::lookup::Lookup,&'static str)> {
    let primary=resolver.lookup(host,kind);tokio::pin!(primary);
    tokio::select! {
        result=&mut primary=>return Ok((result?,"system_resolver")),
        _=tokio::time::sleep(delay)=>{}
    }
    let Ok(_permit)=limit.try_acquire()else{return Ok((primary.await?,"system_resolver"));};
    tracing::info!(record_type=?kind,"tts slow DNS: bounded configured-upstream lookup started");
    // An absolute name avoids search-domain suffixes on the public fallback.
    let absolute=format!("{}.",host.trim_end_matches('.'));
    let secondary=fallback.lookup(absolute.as_str(),kind);tokio::pin!(secondary);
    tokio::select! {
        result=&mut primary=>match result {Ok(l)=>Ok((l,"system_resolver")),Err(_)=>Ok((secondary.await?,"configured_upstream"))},
        result=&mut secondary=>match result {Ok(l)=>Ok((l,"configured_upstream")),Err(_)=>Ok((primary.await?,"system_resolver"))},
    }
}

#[cfg(test)]
async fn dial(resolver: &TokioResolver, host: &str, port: u16) -> Result<Connected> {
    dial_resolvers(resolver,None,host,port).await
}

async fn dial_resolvers(resolver: &TokioResolver, fallback: Option<&TokioResolver>, host: &str, port: u16) -> Result<Connected> {
    if let Ok(ip)=host.parse::<IpAddr>() {
        let start=Instant::now();let socket=TcpStream::connect(SocketAddr::new(ip,port)).await?;
        return Ok(Connected{socket,dns_ms:0,tcp_ms:start.elapsed().as_millis() as u64,dns_path:"literal_ip"});
    }
    // Independent families: a missing AAAA response cannot delay working A,
    // and a stalled IPv4 TCP connect cannot prevent IPv6 success. This applies
    // the racing principle of RFC8305; it does not claim full RFC conformance.
    let v4=family(resolver,fallback,host,port,false);
    let v6=async {tokio::time::sleep(Duration::from_millis(50)).await;family(resolver,fallback,host,port,true).await};
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
        proto::{op::{Message, OpCode}, rr::{Record, rdata::{A, AAAA}}}};
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
                    if mode!="v6_only" {
                        if mode=="slow_a" {tokio::time::sleep(Duration::from_millis(600)).await;}
                        if mode=="refused_first" {resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,2)))]);}
                        resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::A(A::new(127,0,0,1)))]);
                    }
                } else if q.query_type()==RecordType::AAAA && mode=="v6_only" {
                    resp.add_answers(vec![Record::from_rdata(q.name().clone(),1,RData::AAAA(AAAA(std::net::Ipv6Addr::LOCALHOST)))]);
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
    async fn r26_slow_stub_uses_independent_upstream_before_dns_timeout() {
        let primary=dns_server("slow_a").await;
        let fallback=dns_server("a_only").await;
        let limit=tokio::sync::Semaphore::new(2);
        let result=tokio::time::timeout(Duration::from_millis(300),lookup_with_fallback(
            &primary.resolver,&fallback.resolver,"voice.test.",RecordType::A,
            Duration::from_millis(40),&limit)).await;
        assert!(result.is_ok_and(|r|r.is_ok()),"a slow stub must not hold a healthy independent upstream");
        assert_eq!(fallback.a.load(Ordering::SeqCst),1);
        assert_eq!(limit.available_permits(),2);
    }

    #[tokio::test]
    async fn r26_fast_primary_does_not_query_upstream_and_cache_obeys_ttl() {
        let primary=dns_server("a_only").await;let fallback=dns_server("a_only").await;
        let limit=tokio::sync::Semaphore::new(2);
        for _ in 0..2 {
            let (_,path)=lookup_with_fallback(&primary.resolver,&fallback.resolver,"voice.test.",RecordType::A,Duration::from_millis(40),&limit).await.unwrap();
            assert_eq!(path,"system_resolver");
        }
        assert_eq!(primary.a.load(Ordering::SeqCst),1);assert_eq!(fallback.a.load(Ordering::SeqCst),0);
        tokio::time::sleep(Duration::from_millis(1150)).await;
        lookup_with_fallback(&primary.resolver,&fallback.resolver,"voice.test.",RecordType::A,Duration::from_millis(40),&limit).await.unwrap();
        assert_eq!(primary.a.load(Ordering::SeqCst),2);assert_eq!(fallback.a.load(Ordering::SeqCst),0);
    }

    #[tokio::test]
    async fn r26_failed_upstream_preserves_primary_and_full_limit_never_queues() {
        let primary=dns_server("slow_a").await;let fallback=dns_server("v6_only").await;
        let limit=tokio::sync::Semaphore::new(1);
        // These assertions cover liveness and ownership, not the latency gate.
        // Allow the resolver's UDP retry budget when the CI scheduler is busy.
        let (_,path)=tokio::time::timeout(Duration::from_secs(2),lookup_with_fallback(
            &primary.resolver,&fallback.resolver,"voice.test.",RecordType::A,Duration::from_millis(40),&limit)).await.unwrap().unwrap();
        assert_eq!(path,"system_resolver");assert_eq!(limit.available_permits(),1);
        let permit=limit.acquire().await.unwrap();let queries=fallback.a.load(Ordering::SeqCst);
        // A fresh fixture keeps queued UDP retries from the previous slow query
        // out of this separate capacity-limit case.
        let primary=dns_server("slow_a").await;
        tokio::time::timeout(Duration::from_secs(2),lookup_with_fallback(
            &primary.resolver,&fallback.resolver,"other.test.",RecordType::A,Duration::from_millis(40),&limit)).await.unwrap().unwrap();
        assert_eq!(fallback.a.load(Ordering::SeqCst),queries);drop(permit);
    }

    #[tokio::test]
    async fn r26_cancellation_releases_hedge_capacity() {
        let primary=dns_server("silent").await;let fallback=dns_server("silent").await;
        let limit=tokio::sync::Semaphore::new(1);
        assert!(tokio::time::timeout(Duration::from_millis(100),lookup_with_fallback(
            &primary.resolver,&fallback.resolver,"voice.test.",RecordType::A,Duration::from_millis(20),&limit)).await.is_err());
        assert_eq!(limit.available_permits(),1);
    }

    #[tokio::test]
    async fn r26_fallback_connects_ipv6_when_primary_dns_is_silent() {
        let primary=dns_server("silent").await;let fallback=dns_server("v6_only").await;
        let server=TcpListener::bind("[::1]:0").await.unwrap();
        let connected=tokio::time::timeout(Duration::from_millis(500),dial_resolvers(
            &primary.resolver,Some(&fallback.resolver),"voice.test.",server.local_addr().unwrap().port())).await.unwrap().unwrap();
        assert!(connected.socket.peer_addr().unwrap().is_ipv6());
        assert_eq!(connected.dns_path,"configured_upstream");
    }

    #[test]
    fn r26_only_known_tts_opt_in_and_managed_upstream_config_are_allowed() {
        assert!(hedge_enabled("cbm01.cn-huabei-1.xf-yun.com",Some("1")));
        for raw in [None,Some("0"),Some("true")]{assert!(!hedge_enabled("cbm01.cn-huabei-1.xf-yun.com",raw));}
        for host in ["localhost","internal.local","example.com","cbm01.cn-huabei-1.xf-yun.com.evil"]{assert!(!hedge_enabled(host,Some("1")));}
        let text="nameserver 127.0.0.53\nnameserver ::1\nnameserver invalid\nnameserver 0.0.0.0\nnameserver 224.0.0.1\nnameserver 192.0.2.1\nnameserver 192.0.2.1\nnameserver 192.0.2.2 # configured\nnameserver 192.0.2.3\n";
        assert!(upstream_servers(false,text).is_empty());
        assert_eq!(upstream_servers(true,text),["192.0.2.1".parse::<IpAddr>().unwrap(),"192.0.2.2".parse().unwrap()]);
    }
}
