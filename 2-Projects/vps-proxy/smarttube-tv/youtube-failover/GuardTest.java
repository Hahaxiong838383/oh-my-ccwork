import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;
import org.json.*;

/** Real local API/TLS/SOCKS I/O with deterministic policy time and no device access. */
public final class GuardTest {
    static int checks;
    static void check(boolean b,String s){checks++;if(!b)throw new AssertionError(s);}
    interface Work{void run()throws Exception;}
    static void reject(Work w,String error)throws Exception{try{w.run();throw new AssertionError("expected "+error);}catch(YoutubeFailover.TypedError e){check(error.equals(e.getMessage()),"typed failure "+error);}}
    static class Time implements YoutubeFailover.Clock {long now=1000000;public long now(){return now;}public void sleep(long ms){now+=ms;}}
    static class Fixture implements AutoCloseable {
        final HttpServer server;final Path root;final String secret=UUID.randomUUID().toString();final Time time=new Time();
        final List<String> calls=Collections.synchronizedList(new ArrayList<>());final Map<String,String[]> connections=Collections.synchronizedMap(new LinkedHashMap<>());
        final Map<String,Boolean> primary=new HashMap<>(),youtube=new HashMap<>(),dot=new HashMap<>();
        String selected="yt-rack-hy2",dnsSelected="dns-rack-reality",putOverride;boolean retainDeleted,putSeen,spawnLate;int putStatus=204,verifyStatus=200,deletes,restarts;final List<String> restartedWorkers=new ArrayList<>();JSONObject saved;
        YoutubeFailover.Config config;
        Fixture(Path base)throws Exception{
            root=Files.createTempDirectory(base,"guard-");Files.write(root.resolve("boot"),"boot-one".getBytes());Files.write(root.resolve("release-id"),"release-one".getBytes());Files.write(root.resolve("enabled"),"release-one".getBytes());Files.write(root.resolve("armed"),"boot-one".getBytes());
            server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/",this::handle);server.setExecutor(Executors.newCachedThreadPool(YoutubeFailover.daemonFactory("fixture-api")));server.start();
            config=new YoutubeFailover.Config();config.secretFile=root.resolve("secret").toString();config.stateFile=root.resolve("state.json").toString();config.enabledMarker=root.resolve("enabled").toString();config.bootGuardFile=root.resolve("armed").toString();config.releaseIdFile=root.resolve("release-id").toString();config.bootIdFile=root.resolve("boot").toString();config.workerctl=root.resolve("workerctl.sh").toString();config.dryRun=false;config.apiPort=server.getAddress().getPort();config.apiTimeoutMs=1000;
            for(YoutubeFailover.Candidate c:config.candidates){primary.put(c.tag,true);youtube.put(c.tag,true);}for(YoutubeFailover.Candidate c:config.dnsCandidates)dot.put(c.tag,true);
        }
        void handle(HttpExchange x)throws IOException{try{
            String m=x.getRequestMethod(),p=x.getRequestURI().getPath();calls.add(m+" "+p);
            if(!("Bearer "+secret).equals(x.getRequestHeaders().getFirst("Authorization"))){respond(x,401,"{}");return;}
            if(p.startsWith("/proxies/")){boolean dns=p.endsWith("dns-uplink");String now=dns?dnsSelected:selected;
                if(m.equals("GET")){JSONArray all=new JSONArray();for(YoutubeFailover.Candidate c:dns?config.dnsCandidates:config.candidates)all.put(c.tag);respond(x,putSeen?verifyStatus:200,new JSONObject().put("type","Selector").put("now",now).put("all",all).toString());}
                else if(m.equals("PUT")){String target=new JSONObject(new String(read(x.getRequestBody()),StandardCharsets.UTF_8)).getString("name");putSeen=true;if(putStatus==204){if(dns)dnsSelected=putOverride==null?target:putOverride;else selected=putOverride==null?target:putOverride;}respond(x,putStatus,"{}");}
                else respond(x,405,"{}");
            }else if(p.equals("/connections")&&m.equals("GET")){JSONArray all=new JSONArray();synchronized(connections){for(Map.Entry<String,String[]> e:connections.entrySet())all.put(new JSONObject().put("id",e.getKey()).put("chains",new JSONArray(Arrays.asList(e.getValue()))));}respond(x,200,new JSONObject().put("connections",all).toString());}
            else if(p.startsWith("/connections/")&&m.equals("DELETE")){deletes++;if(!retainDeleted)connections.remove(p.substring(13));if(spawnLate)connections.put("late-old",new String[]{"youtube-video","yt-rack-hy2"});respond(x,204,"{}");}else respond(x,404,"{}");
        }catch(Exception e){respond(x,500,"{}");}finally{x.close();}}
        static byte[] read(InputStream in)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[1024];for(int n;(n=in.read(b))!=-1;)out.write(b,0,n);return out.toByteArray();}
        static void respond(HttpExchange x,int status,String body)throws IOException{if(status==204){x.sendResponseHeaders(status,-1);return;}byte[] b=body.getBytes(StandardCharsets.UTF_8);x.sendResponseHeaders(status,b.length);x.getResponseBody().write(b);}
        YoutubeFailover guard()throws Exception{return new YoutubeFailover(config,secret,(lane,isDns)->{YoutubeFailover.Probe p=new YoutubeFailover.Probe();p.primaryOk=primary.getOrDefault(lane.tag,false);p.youtubeOk=youtube.getOrDefault(lane.tag,false);p.ok=isDns?dot.getOrDefault(lane.tag,false):p.primaryOk&&p.youtubeOk;p.error=p.ok?null:"Injected";return p;},()->true,time,state->{saved=new JSONObject(state.toString());Files.write(root.resolve("state.json"),state.toString().getBytes(StandardCharsets.UTF_8));},worker->{restarts++;restartedWorkers.add(worker);});}
        void samples(){connections.put("failed",new String[]{"yt-rack-hy2","youtube-video"});connections.put("netflix",new String[]{"zgo-hy2","zgo-video"});connections.put("unrelated",new String[]{"yt-rack-hy2","other-selector"});connections.put("healthy",new String[]{"yt-rack-reality","youtube-video"});}
        void fail(String lane){primary.put(lane,false);youtube.put(lane,false);}
        public void close(){server.stop(0);}
    }
    static void switching(Path base)throws Exception{
        try(Fixture f=new Fixture(base)){f.samples();f.fail("yt-rack-hy2");YoutubeFailover g=f.guard();g.channelStep(g.video);
            check(f.selected.equals("yt-rack-reality"),"failed selected lane falls to first healthy ordered target");check(f.deletes==1&&!f.connections.containsKey("failed"),"precise failed youtube connection removed");check(f.connections.size()==3,"Netflix and unrelated chains retained");
            int put=f.calls.indexOf("PUT /proxies/youtube-video"),del=f.calls.indexOf("DELETE /connections/failed");check(put>0&&f.calls.get(put-1).startsWith("GET /proxies/")&&f.calls.get(put+1).equals("GET /proxies/youtube-video")&&del>put+1,"real GET PUT GET before exact DELETE");check(f.calls.get(f.calls.size()-1).equals("GET /connections"),"actual deleted ID independently rechecked");check(g.workers.get("rack").pending&&f.restarts==0,"failed worker queued only after cleanup with backoff");
            check(!g.workerSafe("rack"),"worker checker preserves unrelated live use of same worker");f.connections.remove("unrelated");check(g.workerSafe("rack"),"worker checker allows only when all worker use absent");
        }
        try(Fixture f=new Fixture(base)){f.samples();f.fail("yt-rack-hy2");f.putOverride="yt-rack-hy2";YoutubeFailover g=f.guard();reject(()->g.channelStep(g.video),"SelectionVerificationMismatch");check(f.deletes==0&&f.restarts==0,"bad PUT readback cannot clean or restart");}
        try(Fixture f=new Fixture(base)){f.samples();f.fail("yt-rack-hy2");f.retainDeleted=true;YoutubeFailover g=f.guard();reject(()->g.channelStep(g.video),"ConnectionDeletionNotVerified");check(g.video.pendingOld!=null&&!g.workers.get("rack").pending,"false DELETE204 blocks worker restart");f.retainDeleted=false;g.channelStep(g.video);check(g.video.pendingOld==null&&g.workers.get("rack").pending,"pending cleanup retries through real API");}
        try(Fixture f=new Fixture(base)){f.samples();f.fail("yt-rack-hy2");f.verifyStatus=503;YoutubeFailover g=f.guard();reject(()->g.channelStep(g.video),"ApiGetStatus");check(f.deletes==0&&g.video.pendingOld!=null,"lost verification retains pending intent without delete");f.verifyStatus=200;g.channelStep(g.video);check(f.deletes==1,"later confirmed selection completes pending cleanup");}
        try(Fixture f=new Fixture(base)){f.samples();f.fail("yt-rack-hy2");f.spawnLate=true;YoutubeFailover g=f.guard();reject(()->g.channelStep(g.video),"ConnectionDeletionNotVerified");check(g.video.pendingOld!=null&&!g.workers.get("rack").pending,"new matching ID during cleanup retains pending and blocks restart");f.spawnLate=false;g.channelStep(g.video);check(!f.connections.containsKey("late-old")&&g.video.pendingOld==null,"late old flow removed on subsequent verified cleanup");}
        try(Fixture f=new Fixture(base)){YoutubeFailover g=f.guard();g.video.observed(f.selected,f.time.now);YoutubeFailover.Probe p=new YoutubeFailover.Probe();p.ok=true;p.round=0;p.at=f.time.now;g.round=1;reject(()->g.switchTo(g.video,f.selected,"yt-rack-reality",p,true),"MissingFreshHealthyProbe");check(!f.putSeen,"stale success never authorizes switch");}
    }
    static void gatesAndFaults(Path base)throws Exception{
        for(String fault:Arrays.asList("dry","no-enabled","wrong-release","wrong-boot","bad-mode","symlink-enabled"))try(Fixture f=new Fixture(base)){f.fail("yt-rack-hy2");if(fault.equals("dry"))f.config.dryRun=true;if(fault.equals("no-enabled"))Files.delete(f.root.resolve("enabled"));if(fault.equals("wrong-release"))Files.write(f.root.resolve("enabled"),"old-release".getBytes());if(fault.equals("wrong-boot"))Files.write(f.root.resolve("armed"),"old-boot".getBytes());if(fault.equals("bad-mode"))Files.setPosixFilePermissions(f.root.resolve("enabled"),java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"));if(fault.equals("symlink-enabled")){Files.delete(f.root.resolve("enabled"));Files.createSymbolicLink(f.root.resolve("enabled"),f.root.resolve("release-id"));}YoutubeFailover g=f.guard();g.channelStep(g.video);check(!f.putSeen&&f.deletes==0&&f.restarts==0,"closed "+fault+" gate blocks all mutations");}
        try(Fixture f=new Fixture(base)){for(String lane:f.primary.keySet())f.primary.put(lane,false);YoutubeFailover g=f.guard();g.channelStep(g.video);check(!f.putSeen&&f.restarts==0,"single primary endpoint outage retains working YouTube");}
        try(Fixture f=new Fixture(base)){for(String lane:f.primary.keySet())f.primary.put(lane,false);f.youtube.put("yt-rack-hy2",false);YoutubeFailover g=f.guard();g.channelStep(g.video);check(f.selected.equals("yt-rack-reality"),"primary endpoint outage plus actual current route fault still falls back using meaningful YouTube evidence");}
        try(Fixture f=new Fixture(base)){for(String lane:f.primary.keySet())f.fail(lane);YoutubeFailover g=f.guard();g.channelStep(g.video);check(!f.putSeen&&f.restarts==0,"all lanes fail: no speculative selection or restart");}
        try(Fixture f=new Fixture(base)){f.dot.put("dns-rack-reality",false);YoutubeFailover g=f.guard();g.channelStep(g.dns);check(f.dnsSelected.equals("dns-zgo-reality"),"independent DNS selector fallback");check(f.selected.equals("yt-rack-hy2")&&f.restarts==0,"DNS failure never changes video selector or restarts main");}
        check(YoutubeFailover.foregroundText("  mResumedActivity: ActivityRecord{ab u0 org.smarttube.beta/.Main t1}\n"),"actual beta package foreground recognized");
        check(YoutubeFailover.foregroundText("mResumedActivity: ActivityRecord{ab u0 com.google.android.youtube.tv/.Main t1}"),"official TV foreground recognized");
        check(!YoutubeFailover.foregroundText("mLastPausedActivity: ActivityRecord{ab u0 org.smarttube.beta/.Main t1}"),"paused app is not foreground");
        check(!YoutubeFailover.foregroundText("mResumedActivity: ActivityRecord{ab u0 org.smarttube.beta.fake/.Main t1}"),"package prefix spoof rejected");
    }
    static void persistenceAndRecovery(Path base)throws Exception{
        try(Fixture f=new Fixture(base)){f.selected="yt-zgo-reality";YoutubeFailover g=f.guard();g.video.observed(f.selected,f.time.now);f.connections.put("old-healthy",new String[]{"yt-zgo-reality","youtube-video"});
            for(int i=0;i<3;i++){f.time.now+=60000;g.channelStep(g.video);}check(!f.putSeen,"three probes cannot bypass 300 second hold");f.time.now+=120000;g.channelStep(g.video);check(f.selected.equals("yt-rack-hy2"),"three spaced successes and hold restore highest priority");check(f.deletes==0&&f.connections.containsKey("old-healthy"),"healthy recovery leaves old flow untouched");}
        try(Fixture f=new Fixture(base)){f.fail("yt-zgo-hy2");YoutubeFailover g=f.guard();g.channelStep(g.video);check(g.workers.get("zgo").pending&&!g.workers.get("rack").pending&&!f.putSeen,"rank0 healthy route maintains never-selected last-rank ZGO worker");f.time.now+=60000;g.restartEligible();check(f.restartedWorkers.equals(Arrays.asList("zgo")),"never-selected ZGO alone gets isolated restart");check(f.selected.equals("yt-rack-hy2")&&!f.putSeen&&f.deletes==0,"standby repair preserves current rank0 route and connections");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";f.fail("yt-zgo-hy2");YoutubeFailover g=f.guard();g.channelStep(g.video);check(g.workers.get("zgo").pending&&!g.workers.get("rack").pending,"healthy Reality fallback also maintains lower-ranked ZGO worker");}
        try(Fixture f=new Fixture(base)){YoutubeFailover g=f.guard();g.channelStep(g.video);f.time.now+=60000;g.channelStep(g.video);check(!f.putSeen&&f.restarts==0,"healthy lower-ranked standby never displaces rank0");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";f.fail("yt-rack-hy2");YoutubeFailover g=f.guard();g.channelStep(g.video);check(g.workers.get("rack").pending&&!f.putSeen,"never-selected dead high-priority worker queued from healthy fallback recovery");f.time.now+=60000;g.restartEligible();check(f.restarts==1,"dead boot-time worker gets bounded isolated restart");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";f.fail("yt-rack-hy2");YoutubeFailover g=f.guard();g.workers.get("rack").failed(f.time.now);f.time.now+=60000;f.fail("yt-rack-reality");g.restartEligible();check(f.restarts==0,"stale restart intent blocked when current fallback also fails");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";f.fail("yt-rack-hy2");YoutubeFailover g=f.guard();g.video.observed(f.selected,f.time.now);YoutubeFailover.WorkerState w=g.workers.get("rack");w.failed(f.time.now);g.restartEligible();check(f.restarts==0,"first restart waits one minute");
            f.time.now+=60000;g.restartEligible();check(f.restarts==1&&w.attempts.size()==1,"first restart reserved in durable state");JSONObject persisted=new JSONObject(new String(Files.readAllBytes(f.root.resolve("state.json")),StandardCharsets.UTF_8));YoutubeFailover next=f.guard();next.restore(persisted);next.restartEligible();check(f.restarts==1,"process restart cannot bypass first backoff");
            f.time.now+=180000;next.restartEligible();check(f.restarts==2,"second restart after three-minute backoff");f.time.now+=600000;next.restartEligible();check(f.restarts==3,"third restart after ten-minute backoff");JSONObject again=f.saved;YoutubeFailover third=f.guard();third.restore(again);f.time.now+=600000;third.restartEligible();check(f.restarts==3,"fresh JVM retains 30 minute cooldown");check(third.workers.get("rack").cycleAttempts==3,"restart counter persisted across process recreation");
            JSONObject different=new JSONObject(again.toString()).put("boot_id","previous-boot");YoutubeFailover fourth=f.guard();fourth.restore(different);check(!fourth.workers.get("rack").pending&&fourth.workers.get("rack").attempts.isEmpty(),"prior boot history does not arm current boot");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";YoutubeFailover g=f.guard();g.workers.get("rack").failed(f.time.now);f.time.now+=60000;g.restartEligible();check(f.restarts==0&&!g.workers.get("rack").pending,"fresh healthy worker probe cancels stale restart intent");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";f.primary.put("yt-rack-hy2",false);YoutubeFailover g=f.guard();g.workers.get("rack").failed(f.time.now);f.time.now+=60000;g.restartEligible();check(f.restarts==0,"primary-only endpoint failure never restarts YouTube-working worker");}
        try(Fixture f=new Fixture(base)){f.selected="yt-rack-reality";YoutubeFailover g=f.guard();YoutubeFailover.WorkerState w=g.workers.get("rack");w.failed(f.time.now);f.time.now+=60000;f.connections.put("still-healthy",new String[]{"yt-rack-hy2","youtube-video"});g.restartEligible();check(f.restarts==0,"live old worker flow blocks restart even when not selected");}
    }
    // Multi-connection real SOCKS + TLS endpoint; talks either HTTP or DNS-over-TLS.
    static class TlsFixture implements AutoCloseable {
        final ServerSocket listener;final SSLContext context;volatile boolean closed;boolean badDns,emptyYouTube;final List<Socket> clients=Collections.synchronizedList(new ArrayList<>());final Thread thread;
        TlsFixture(SSLContext context)throws Exception{this.context=context;listener=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));thread=new Thread(()->{while(!closed)try{Socket s=listener.accept();clients.add(s);Thread t=new Thread(()->serve(s));t.setDaemon(true);t.start();}catch(Exception e){}});thread.setDaemon(true);thread.start();}
        void serve(Socket raw){try{raw.setSoTimeout(2500);DataInputStream input=new DataInputStream(raw.getInputStream());OutputStream output=raw.getOutputStream();if(input.readUnsignedByte()!=5)return;int n=input.readUnsignedByte();while(n-->0)input.readByte();output.write(new byte[]{5,0});output.flush();input.readByte();input.readByte();input.readByte();int type=input.readUnsignedByte();n=type==3?input.readUnsignedByte():type==1?4:16;while(n-->0)input.readByte();int port=input.readUnsignedShort();output.write(new byte[]{5,0,0,1,127,0,0,1,0,80});output.flush();
            SSLSocket tls=(SSLSocket)context.getSocketFactory().createSocket(raw,"localhost",raw.getPort(),false);tls.setUseClientMode(false);tls.startHandshake();DataInputStream in=new DataInputStream(tls.getInputStream());OutputStream out=tls.getOutputStream();
            if(port==853){int length=in.readUnsignedShort();byte[] q=new byte[length];in.readFully(q);YoutubeFailover.put16(q,2,0x8180);YoutubeFailover.put16(q,6,1);if(badDns)q[0]^=1;ByteArrayOutputStream b=new ByteArrayOutputStream();b.write(q);b.write(new byte[]{(byte)0xc0,12,0,1,0,1,0,0,0,60,0,4,1,1,1,1});DataOutputStream data=new DataOutputStream(out);data.writeShort(b.size());b.writeTo(data);data.flush();}
            else{String request=YoutubeFailover.line(in,8192);for(String s;!(s=YoutubeFailover.line(in,8192)).isEmpty();){}byte[] body;if(request.contains("__down"))body=new byte[262144];else{body=new byte[8192];if(!emptyYouTube)System.arraycopy("ytInitialData".getBytes(StandardCharsets.US_ASCII),0,body,100,13);}out.write(("HTTP/1.1 200 OK\r\nContent-Length: "+body.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(body);out.flush();}
        }catch(Exception ignored){}finally{try{raw.close();}catch(Exception ignored){}}}
        public void close()throws Exception{closed=true;listener.close();synchronized(clients){for(Socket s:clients)s.close();}thread.join(500);}
    }
    static void dualTransport(Path base)throws Exception{
        char[] pass=new String(Files.readAllBytes(base.resolve("password")),StandardCharsets.UTF_8).trim().toCharArray();SSLContext trusted=TransportTest.context(null,base.resolve("trust.p12"),pass),server=TransportTest.context(base.resolve("matching.p12"),null,pass);SSLContext.setDefault(trusted);
        YoutubeFailover.Config c=new YoutubeFailover.Config();c.probeTimeoutMs=2000;c.connectTimeoutMs=1000;c.readTimeoutMs=1000;
        try(TlsFixture fixture=new TlsFixture(server)){YoutubeFailover.Candidate lane=new YoutubeFailover.Candidate("test",fixture.listener.getLocalPort(),null);YoutubeFailover.Probe pair=YoutubeFailover.pairProbe(c,lane);check(pair.ok&&pair.primaryOk&&pair.youtubeOk&&pair.bytes==270336,"real dual SOCKS TLS meaningful payload probes");
            fixture.emptyYouTube=true;pair=YoutubeFailover.pairProbe(c,lane);check(!pair.ok&&pair.primaryOk&&!pair.youtubeOk,"real empty-marker YouTube200 blocks healthy lane evidence");
            YoutubeFailover.Probe dot=YoutubeFailover.dotProbe(c,lane);check(dot.ok&&dot.bytes>12,"real numeric SOCKS TLS DNS query accepted");fixture.badDns=true;dot=YoutubeFailover.dotProbe(c,lane);check(!dot.ok&&"DnsHeader".equals(dot.error),"real DoT mismatched ID rejected");}
        byte[] request=YoutubeFailover.dnsRequest("www.youtube.com",1);reject(()->YoutubeFailover.validDns(request,1,"www.youtube.com"),"DnsHeader");
    }
    static JSONArray candidateJson(YoutubeFailover.Candidate[] lanes){
        JSONArray a=new JSONArray();for(YoutubeFailover.Candidate c:lanes){JSONObject j=new JSONObject().put("tag",c.tag).put("socks_port",c.port);if(c.worker!=null)j.put("worker",c.worker);a.put(j);}return a;
    }
    static void dualStack(Path base)throws Exception{
        YoutubeFailover.Config defaults=new YoutubeFailover.Config();
        JSONArray v=candidateJson(defaults.candidates),d=candidateJson(defaults.dnsCandidates);
        v=new JSONArray().put(v.get(0)).put(v.get(1)).put(new JSONObject().put("tag","yt-rack-reality-ipv6").put("socks_port",19105)).put(v.get(2)).put(v.get(3));
        d=new JSONArray().put(d.get(0)).put(new JSONObject().put("tag","dns-rack-reality-ipv6").put("socks_port",19113)).put(d.get(1));
        YoutubeFailover.Candidate[] video=YoutubeFailover.Config.parseCandidates(v,defaults.candidates),dns=YoutubeFailover.Config.parseCandidates(d,defaults.dnsCandidates);
        check(video.length==5&&dns.length==3&&video[2].worker==null,"explicit IPv6 profile retains independent HY2 worker ownership");
        JSONArray bad=new JSONArray(v.toString());bad.getJSONObject(2).put("worker","rack");final JSONArray wrongWorker=bad;
        reject(()->YoutubeFailover.Config.parseCandidates(wrongWorker,defaults.candidates),"CandidateOrderOrWorker");
        bad=new JSONArray(v.toString());bad.getJSONObject(2).put("tag","unmanaged");final JSONArray wrongTag=bad;
        reject(()->YoutubeFailover.Config.parseCandidates(wrongTag,defaults.candidates),"CandidateOrderOrWorker");
        reject(()->YoutubeFailover.Config.parseCandidates(new JSONArray(),defaults.candidates),"CandidateCount");
        try(Fixture f=new Fixture(base)){
            f.config.candidates=video;f.config.dnsCandidates=dns;
            for(YoutubeFailover.Candidate c:video){f.primary.put(c.tag,false);f.youtube.put(c.tag,false);}
            f.primary.put("yt-rack-reality-ipv6",true);f.youtube.put("yt-rack-reality-ipv6",true);
            f.connections.put("unrelated-netflix",new String[]{"zgo-video","zgo-hy2"});
            YoutubeFailover g=f.guard();g.channelStep(g.video);
            check(f.selected.equals("yt-rack-reality-ipv6"),"IPv6 is actually selected when other video candidates fail");
            check(f.connections.containsKey("unrelated-netflix"),"IPv6 failure switch preserves unrelated Netflix connection");
            for(YoutubeFailover.Candidate c:dns)f.dot.put(c.tag,false);f.dot.put("dns-rack-reality-ipv6",true);
            g.channelStep(g.dns);check(f.dnsSelected.equals("dns-rack-reality-ipv6"),"DNS independently fails over to IPv6");
            f.fail("yt-rack-reality-ipv6");f.primary.put("yt-zgo-reality",true);f.youtube.put("yt-zgo-reality",true);
            g.channelStep(g.video);check(f.selected.equals("yt-zgo-reality"),"failed IPv6 falls through to healthy ZGO");
            f.dot.put("dns-rack-reality-ipv6",false);f.dot.put("dns-zgo-reality",true);
            g.channelStep(g.dns);check(f.dnsSelected.equals("dns-zgo-reality"),"failed IPv6 DNS falls through to ZGO");
            JSONObject json=new JSONObject().put("secret_file",f.config.secretFile).put("state_file",f.config.stateFile)
                .put("enabled_marker",f.config.enabledMarker).put("boot_guard_file",f.config.bootGuardFile)
                .put("boot_id_file",f.config.bootIdFile).put("release_id_file",f.config.releaseIdFile).put("workerctl",f.config.workerctl)
                .put("candidates",v).put("dns",new JSONObject().put("candidates",d));
            Path p=f.root.resolve("profile.json");Files.write(p,json.toString().getBytes(StandardCharsets.UTF_8));
            check(YoutubeFailover.Config.load(p.toString()).candidates.length==5,"real config loader accepts five/three-lane profile");
            json.getJSONArray("candidates").getJSONObject(2).put("socks_port",19111);
            Files.write(p,json.toString().getBytes(StandardCharsets.UTF_8));reject(()->YoutubeFailover.Config.load(p.toString()),"DuplicatePort");
        }
    }
    public static void main(String[] args)throws Exception{Path base=Paths.get(args[0]);switching(base);gatesAndFaults(base);persistenceAndRecovery(base);dualTransport(base);dualStack(base);System.out.println("PASS "+checks+" guard integration assertions; real loopback HTTP/SOCKS/TLS plus persisted restart policy");}
}
