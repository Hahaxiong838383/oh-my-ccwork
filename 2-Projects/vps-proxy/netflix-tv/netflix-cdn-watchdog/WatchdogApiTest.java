import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Mock HTTP endpoint; production Api and switchSelection/cleanup methods execute unchanged. */
public final class WatchdogApiTest {
    static int checks;
    static void check(boolean b,String message){checks++;if(!b)throw new AssertionError(message);}
    interface Checked {void run()throws Exception;}
    static void rejects(Checked f,String type)throws Exception{
        try{f.run();throw new AssertionError("expected "+type);}
        catch(NetflixCdnWatchdog.TypedError e){check(type.equals(e.getMessage()),"error type "+type);}
    }
    static final class Fixture implements AutoCloseable {
        final HttpServer server;
        final String secret=UUID.randomUUID().toString();
        final List<String> calls=Collections.synchronizedList(new ArrayList<>());
        final Map<String,String[]> connections=Collections.synchronizedMap(new LinkedHashMap<>());
        String now="zgo-hy2", putOverride;
        int getStatus=200, putStatus=204, deleteStatus=204, verificationStatus=200, connectionsStatus=200;
        boolean putSeen,retainDeleted;
        int wrongAuth;
        Fixture()throws Exception {
            server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/",this::handle);
            server.setExecutor(Executors.newCachedThreadPool(r->{Thread t=new Thread(r,"isolated-clash-api");t.setDaemon(true);return t;}));
            server.start();
        }
        void handle(HttpExchange x)throws IOException {
            try {
                String method=x.getRequestMethod(),path=x.getRequestURI().getPath();calls.add(method+" "+path);
                if(!("Bearer "+secret).equals(x.getRequestHeaders().getFirst("Authorization"))){wrongAuth++;respond(x,401,"{}");return;}
                if(path.equals("/proxies/zgo-video")) {
                    if(method.equals("GET")) {
                        int code=putSeen?verificationStatus:getStatus;
                        respond(x,code,new JSONObject().put("type","Selector").put("now",now).put("all",new JSONArray().put("zgo-hy2").put("zgo-netflix")).toString());
                    } else if(method.equals("PUT")) {
                        String target=new JSONObject(new String(read(x.getRequestBody()),StandardCharsets.UTF_8)).getString("name");
                        putSeen=true;
                        if(putStatus==200 || putStatus==204)now=putOverride==null?target:putOverride;
                        respond(x,putStatus,"{}");
                    } else respond(x,405,"{}");
                } else if(path.equals("/connections") && method.equals("GET")) {
                    JSONArray all=new JSONArray();
                    synchronized(connections){for(Map.Entry<String,String[]> e:connections.entrySet())all.put(new JSONObject().put("id",e.getKey()).put("chains",new JSONArray(Arrays.asList(e.getValue()))));}
                    respond(x,connectionsStatus,new JSONObject().put("connections",all).toString());
                } else if(path.startsWith("/connections/") && method.equals("DELETE")) {
                    if(!retainDeleted && (deleteStatus==204 || deleteStatus==200 || deleteStatus==404))connections.remove(path.substring("/connections/".length()));
                    respond(x,deleteStatus,"{}");
                } else respond(x,404,"{}");
            }catch(Exception e){respond(x,500,"{}");}finally{x.close();}
        }
        static byte[] read(InputStream in)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[1024];for(int n;(n=in.read(b))!=-1;)out.write(b,0,n);return out.toByteArray();}
        static void respond(HttpExchange x,int status,String body)throws IOException {
            byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
            if(status==204){x.sendResponseHeaders(status,-1);return;}
            x.getResponseHeaders().set("Content-Type","application/json");x.sendResponseHeaders(status,bytes.length);x.getResponseBody().write(bytes);
        }
        NetflixCdnWatchdog watchdog()throws Exception {
            NetflixCdnWatchdog.Config c=new NetflixCdnWatchdog.Config();c.apiPort=server.getAddress().getPort();c.apiTimeoutMs=2000;
            NetflixCdnWatchdog w=new NetflixCdnWatchdog(c,secret);w.observed(w.api.getSelection());calls.clear();return w;
        }
        void sampleConnections(){
            connections.put("netflix-hy2",new String[]{"zgo-hy2","zgo-video"});
            connections.put("control-hy2",new String[]{"zgo-hy2"});
            connections.put("netflix-reality",new String[]{"zgo-netflix","zgo-video"});
            connections.put("other",new String[]{"zgo-hy2","other-selector"});
        }
        public void close(){server.stop(0);}
    }
    static void goodSwitchAndCleanup()throws Exception {
        try(Fixture f=new Fixture()){
            f.sampleConnections();NetflixCdnWatchdog w=f.watchdog();
            check(w.switchSelection("zgo-netflix"),"fallback switch returns verified success");
            check("zgo-netflix".equals(w.policy.selected) && "zgo-netflix".equals(w.lastVerifiedSelection),"selected matches independent GET");
            check(f.calls.equals(Arrays.asList("GET /proxies/zgo-video","PUT /proxies/zgo-video","GET /proxies/zgo-video","GET /connections","DELETE /connections/netflix-hy2","GET /connections")),"GET PUT GET then targeted DELETE then independent GET");
            check(!f.connections.containsKey("netflix-hy2"),"old media connection gone");
            check(f.connections.size()==3 && f.connections.containsKey("control-hy2") && f.connections.containsKey("netflix-reality") && f.connections.containsKey("other"),"control Reality unrelated connections preserved");
            check(!w.pendingHy2Cleanup && w.lastCleanupDeleted==1,"cleanup completed with verified count");
            check(f.wrongAuth==0,"Bearer correct in all API calls");
            f.calls.clear();check(w.switchSelection("zgo-hy2"),"recovery selection verified");
            check(f.calls.equals(Arrays.asList("GET /proxies/zgo-video","PUT /proxies/zgo-video","GET /proxies/zgo-video")),"recovery does not list or delete connections");
            check(f.connections.containsKey("netflix-reality"),"recovery retains existing Reality connection");
        }
    }
    static void negativeSwitches()throws Exception {
        try(Fixture f=new Fixture()){
            f.sampleConnections();NetflixCdnWatchdog w=f.watchdog();f.putOverride="zgo-hy2";
            rejects(()->w.switchSelection("zgo-netflix"),"SelectionVerificationMismatch");
            check("zgo-hy2".equals(w.policy.selected) && !w.pendingHy2Cleanup,"wrong now not reported as switch");
            check(f.connections.size()==4 && f.calls.stream().noneMatch(x->x.contains("/connections")),"wrong now never cleans connections");
        }
        try(Fixture f=new Fixture()){
            NetflixCdnWatchdog w=f.watchdog();f.getStatus=503;
            rejects(()->w.switchSelection("zgo-netflix"),"ApiGetStatus");
            check("zgo-hy2".equals(w.policy.selected) && !f.putSeen,"failed precheck no mutation");
        }
        try(Fixture f=new Fixture()){
            NetflixCdnWatchdog w=f.watchdog();f.putStatus=500;
            rejects(()->w.switchSelection("zgo-netflix"),"ApiPutStatus");
            check("zgo-hy2".equals(w.policy.selected) && "zgo-hy2".equals(w.lastVerifiedSelection),"failed PUT retains last verified selection");
        }
        try(Fixture f=new Fixture()){
            NetflixCdnWatchdog w=f.watchdog();f.verificationStatus=503;
            rejects(()->w.switchSelection("zgo-netflix"),"ApiGetStatus");
            check("zgo-netflix".equals(f.now) && "zgo-hy2".equals(w.policy.selected),"actual changed but unverifiable never claims success");
            check(w.pendingHy2Cleanup && f.calls.stream().noneMatch(x->x.contains("/connections")),"failed verify retains pending but never cleans before confirmation");
            f.sampleConnections();f.verificationStatus=200;w.observed(w.api.getSelection());w.finishPendingCleanup();
            check(!w.pendingHy2Cleanup && f.connections.size()==3 && !f.connections.containsKey("netflix-hy2"),"later verified Reality triggers deferred cleanup after lost verification");
        }
        try(Fixture f=new Fixture()){
            NetflixCdnWatchdog w=f.watchdog();f.now="zgo-netflix";
            check(!w.switchSelection("zgo-netflix") && !f.putSeen,"concurrent external selection respected");
            check("zgo-netflix".equals(w.lastVerifiedSelection),"external selection recorded only from GET");
        }
    }
    static void cleanupFailuresAndRetry()throws Exception {
        try(Fixture f=new Fixture()){
            f.sampleConnections();NetflixCdnWatchdog w=f.watchdog();f.retainDeleted=true;
            rejects(()->w.switchSelection("zgo-netflix"),"ConnectionDeletionNotVerified");
            check(w.pendingHy2Cleanup && "ConnectionDeletionNotVerified".equals(w.lastCleanupError),"false DELETE 204 leaves pending evidence");
            check("zgo-netflix".equals(w.lastVerifiedSelection),"cleanup failure does not erase verified selector");
            f.retainDeleted=false;f.calls.clear();w.finishPendingCleanup();
            check(!w.pendingHy2Cleanup && !f.connections.containsKey("netflix-hy2"),"pending cleanup retry clears actual old connection");
            check(f.calls.get(f.calls.size()-1).equals("GET /connections"),"retry independently verifies disappearance");
        }
        try(Fixture f=new Fixture()){
            f.sampleConnections();NetflixCdnWatchdog w=f.watchdog();f.connectionsStatus=503;
            rejects(()->w.switchSelection("zgo-netflix"),"ApiConnectionsStatus");
            check(w.pendingHy2Cleanup && f.connections.size()==4,"connection listing error leaves pending without deletes");
            f.connectionsStatus=200;w.finishPendingCleanup();check(!w.pendingHy2Cleanup && f.connections.size()==3,"listing retry succeeds");
        }
        try(Fixture f=new Fixture()){
            f.sampleConnections();NetflixCdnWatchdog w=f.watchdog();f.deleteStatus=500;
            rejects(()->w.switchSelection("zgo-netflix"),"ApiDeleteStatus");
            check(w.pendingHy2Cleanup && f.connections.size()==4,"DELETE error leaves pending");
            f.deleteStatus=404;w.finishPendingCleanup();check(!w.pendingHy2Cleanup && f.connections.size()==3,"naturally vanished 404 verified by GET");
        }
        try(Fixture f=new Fixture()){
            NetflixCdnWatchdog w=f.watchdog();w.switchSelection("zgo-netflix");
            check(w.lastCleanupDeleted==0 && !w.pendingHy2Cleanup,"zero candidates tracked as no matches");
            check(f.calls.stream().noneMatch(x->x.startsWith("DELETE")),"zero candidates causes no DELETE");
        }
    }
    static void inactiveTests() {
        NetflixCdnWatchdog.Policy p=new NetflixCdnWatchdog.Policy("hy2","reality",2,3,180000);
        p.observed("hy2",0);p.result(false,1);p.inactive();
        check(p.failures==0 && p.successes==0,"nonplayer resets counters");
        check(p.result(false,999999)==null,"separate playback failures not combined");
        p.observed("reality",1000000);p.result(true,1000001);p.result(true,1000002);p.inactive();
        check(p.selectedSince==1000000 && p.successes==0,"inactive preserves hold start but discards success streak");
        check(p.result(true,2000000)==null && p.result(true,2000001)==null,"new session needs fresh recovery streak");
        check("hy2".equals(p.result(true,2000002)),"fresh three successes with elapsed hold restores");
    }
    public static void main(String[] args)throws Exception {
        goodSwitchAndCleanup();negativeSwitches();cleanupFailuresAndRetry();inactiveTests();
        System.out.println("PASS "+checks+" HTTP API integration checks; real production switch/cleanup methods, loopback fixture only");
    }
}
