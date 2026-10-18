import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONObject;

/** Query/selector guard, derived from NetflixCdnWatchdog bounded transport and HTTP parser.
 * Inactive by default. No main sing-box restart, activity launch, clock or TUN writes. */
public final class YoutubeFailover {
    static final int PROBE_BYTES=262144, MAX_API_BYTES=4*1024*1024;
    static final String PROBE_HOST="speed.cloudflare.com", PROBE_PATH="/__down?bytes=262144";
    static final String USER_AGENT="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    static class TypedError extends IOException {
        TypedError(String type) { super(type); }
    }
    interface Work<T> { T run(Cancellation cancellation) throws Exception; }
    static final class Cancellation {
        volatile boolean cancelled;
        private volatile Socket socket;
        private volatile Process process;
        synchronized void socket(Socket s) throws IOException {
            if (cancelled) { s.close(); throw new InterruptedIOException(); }
            socket = s;
        }
        synchronized void process(Process p) throws IOException {
            if (cancelled) { p.destroyForcibly(); throw new InterruptedIOException(); }
            process = p;
        }
        void cancel() {
            cancelled = true;
            Socket s = socket;
            if (s != null) try { s.close(); } catch (IOException ignored) {}
            Process p = process;
            if (p != null) {
                p.destroy();
                if (p.isAlive()) p.destroyForcibly();
            }
        }
    }

    /** Deadline covers DNS, SOCKS, TLS, headers, all body reads and cleanup. */
    static <T> T bounded(Work<T> work, long timeoutMs) throws Exception {
        final Cancellation cancellation = new Cancellation();
        ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "youtube-guard-operation");
            t.setDaemon(true);
            return t;
        });
        Future<T> future = executor.submit(() -> work.run(cancellation));
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            // Closing a Java Socket is not a graceful TLS shutdown and unblocks stalled I/O.
            cancellation.cancel();
            throw new TypedError("DeadlineExceeded");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new TypedError("WorkerError");
        } finally {
            cancellation.cancel();
            executor.shutdownNow();
        }
    }

    static final class Response {
        final int status;
        final Map<String,String> headers;
        final byte[] body;
        final long bytes;
        Response(int s, Map<String,String> h, byte[] b, long count) { status=s; headers=h; body=b; bytes=count; }
    }

    /** Minimal one-response HTTP/1.1 parser. Reads exactly the response entity; no redirects/retries. */
    static Response response(InputStream raw, int maxBytes, boolean collect, AtomicLong progress,
                             boolean requireProbe) throws Exception {
        BufferedInputStream in = new BufferedInputStream(raw, 16384);
        String statusLine = line(in, 8192);
        if (!statusLine.matches("HTTP/1\\.[01] [0-9]{3}(?: .*)?")) throw new TypedError("InvalidHttpStatus");
        int status = Integer.parseInt(statusLine.substring(9,12));
        Map<String,String> headers = new HashMap<>();
        int headerBytes = statusLine.length();
        while (true) {
            String h = line(in,8192);
            headerBytes += h.length() + 2;
            if (headerBytes > 65536) throw new TypedError("HeadersTooLarge");
            if (h.isEmpty()) break;
            int colon=h.indexOf(':');
            if (colon <= 0) throw new TypedError("InvalidHttpHeader");
            String key=h.substring(0,colon).trim().toLowerCase(Locale.ROOT), value=h.substring(colon+1).trim();
            if (headers.containsKey(key) && (key.equals("content-length") || key.equals("transfer-encoding")))
                throw new TypedError("DuplicateFramingHeader");
            headers.put(key,value);
        }
        if (requireProbe && status != 200) throw new TypedError("ProbeHttpStatus");
        if (requireProbe && !headers.getOrDefault("content-encoding", "identity").equalsIgnoreCase("identity"))
            throw new TypedError("UnexpectedContentEncoding");
        ByteArrayOutputStream out = collect ? new ByteArrayOutputStream() : null;
        if (status == 204 || status == 304 || (status >= 100 && status < 200))
            return new Response(status,headers,collect ? out.toByteArray() : null,0);
        String transfer=headers.get("transfer-encoding"), length=headers.get("content-length");
        if (transfer != null && length != null) throw new TypedError("AmbiguousHttpFraming");
        if (transfer != null) {
            if (!transfer.equalsIgnoreCase("chunked")) throw new TypedError("UnsupportedTransferEncoding");
            while (true) {
                String chunk=line(in,128);
                int semi=chunk.indexOf(';'); if (semi>=0) chunk=chunk.substring(0,semi);
                if (!chunk.matches("[0-9A-Fa-f]{1,15}")) throw new TypedError("InvalidChunk");
                long n=Long.parseLong(chunk,16);
                if (n==0) {
                    int trailerBytes=0;
                    while (true) {
                        String trailer=line(in,8192); trailerBytes+=trailer.length()+2;
                        if (trailerBytes>65536) throw new TypedError("TrailersTooLarge");
                        if (trailer.isEmpty()) break;
                    }
                    break;
                }
                copy(in,out,n,maxBytes,progress,true);
                if (!line(in,2).isEmpty()) throw new TypedError("InvalidChunkTerminator");
            }
        } else if (length != null) {
            if (!length.matches("[0-9]{1,15}")) throw new TypedError("InvalidContentLength");
            copy(in,out,Long.parseLong(length),maxBytes,progress,true);
        } else {
            copy(in,out,Long.MAX_VALUE,maxBytes,progress,false);
        }
        long count=progress.get();
        if (requireProbe && count != PROBE_BYTES) throw new TypedError("ProbeByteCountMismatch");
        return new Response(status,headers,collect ? out.toByteArray() : null,count);
    }
    static String line(InputStream in,int max) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        while (true) {
            int c=in.read();
            if (c<0) throw new EOFException();
            if (c=='\n') {
                byte[] bytes=out.toByteArray();
                if (bytes.length==0 || bytes[bytes.length-1]!='\r') throw new TypedError("InvalidHttpLineEnding");
                return new String(bytes,0,bytes.length-1,StandardCharsets.ISO_8859_1);
            }
            out.write(c);
            if (out.size()>max) throw new TypedError("HttpLineTooLong");
        }
    }
    static void copy(InputStream in,ByteArrayOutputStream out,long count,int max,AtomicLong progress,boolean exact) throws IOException {
        if (exact && count>max-progress.get()) throw new TypedError("BodyTooLarge");
        byte[] block=new byte[16384];
        while (count>0) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
            int n=in.read(block,0,(int)Math.min(block.length,count));
            if (n<0) { if (exact) throw new EOFException(); else break; }
            if (n==0) continue;
            progress.addAndGet(n);
            if (progress.get()>max) throw new TypedError("BodyTooLarge");
            if (out!=null) out.write(block,0,n);
            count-=n;
        }
    }

    static final class Candidate {
        final String tag,worker; final int port;
        Candidate(String t,int p,String w){tag=t;port=p;worker=w;}
    }
    static final class Config {
        String secretFile,stateFile,enabledMarker,bootGuardFile,releaseIdFile,workerctl;
        String bootIdFile="/proc/sys/kernel/random/boot_id", selector="youtube-video",dnsSelector="dns-uplink";
        String dnsIp="1.1.1.1",dnsName="cloudflare-dns.com",dnsQuery="www.youtube.com";
        boolean dryRun=true;
        int apiPort=19090,intervalMs=30000,retryMs=2000,connectTimeoutMs=6000,readTimeoutMs=6000;
        int probeTimeoutMs=12000,apiTimeoutMs=12000,foregroundTimeoutMs=4000,recoveryIntervalMs=60000,recoverySuccesses=3,recoveryHoldMs=300000;
        Candidate[] candidates={new Candidate("yt-rack-hy2",19101,"rack"),new Candidate("yt-rack-reality",19102,null),new Candidate("yt-zgo-reality",19103,null),new Candidate("yt-zgo-hy2",19104,"zgo")};
        Candidate[] dnsCandidates={new Candidate("dns-rack-reality",19111,null),new Candidate("dns-zgo-reality",19112,null)};
        static Config load(String path)throws Exception{
            JSONObject j=new JSONObject(new String(readFile(new File(path),65536),StandardCharsets.UTF_8)); Config c=new Config();
            c.secretFile=absolute(j.getString("secret_file"));c.stateFile=absolute(j.getString("state_file"));
            c.enabledMarker=absolute(j.getString("enabled_marker"));c.bootGuardFile=absolute(j.getString("boot_guard_file"));
            c.bootIdFile=absolute(j.optString("boot_id_file",c.bootIdFile));c.workerctl=absolute(j.getString("workerctl"));
            c.releaseIdFile=absolute(j.optString("release_id_file",new File(new File(c.workerctl).getParentFile(),"release-id").getPath()));
            Set<String> paths=new HashSet<>();for(String p:new String[]{c.secretFile,c.stateFile,c.enabledMarker,c.bootGuardFile,c.bootIdFile,c.workerctl,c.releaseIdFile})
                if(!paths.add(new File(p).getCanonicalPath()))throw new TypedError("ConflictingPaths");
            c.dryRun=j.optBoolean("dry_run",true);c.selector=tag(j.optString("selector",c.selector));
            if(!"youtube-video".equals(c.selector))throw new TypedError("UnexpectedSelector");
            c.apiPort=integer(j,"api_port",c.apiPort,1,65535);c.intervalMs=integer(j,"interval_ms",c.intervalMs,1000,300000);
            c.retryMs=integer(j,"retry_ms",c.retryMs,2000,10000);c.probeTimeoutMs=integer(j,"probe_timeout_ms",c.probeTimeoutMs,500,12000);
            c.apiTimeoutMs=integer(j,"api_timeout_ms",c.apiTimeoutMs,500,12000);c.foregroundTimeoutMs=integer(j,"foreground_timeout_ms",c.foregroundTimeoutMs,100,5000);
            c.recoveryIntervalMs=integer(j,"recovery_interval_ms",c.recoveryIntervalMs,60000,3600000);
            c.recoverySuccesses=integer(j,"recovery_successes",c.recoverySuccesses,3,10);c.recoveryHoldMs=integer(j,"recovery_hold_ms",c.recoveryHoldMs,300000,86400000);
            c.candidates=parseCandidates(j.getJSONArray("candidates"),c.candidates);
            JSONObject dns=j.getJSONObject("dns");c.dnsSelector=tag(dns.optString("selector",c.dnsSelector));
            if(!"dns-uplink".equals(c.dnsSelector))throw new TypedError("UnexpectedDnsSelector");
            c.dnsCandidates=parseCandidates(dns.getJSONArray("candidates"),c.dnsCandidates);
            c.dnsIp=dns.optString("server_ip",c.dnsIp);ipv4(c.dnsIp);c.dnsName=hostname(dns.optString("server_name",c.dnsName));
            c.dnsQuery=hostname(dns.optString("query_host",c.dnsQuery));
            Set<Integer> ports=new HashSet<>();ports.add(c.apiPort);
            for(Candidate x:c.candidates)if(!ports.add(x.port))throw new TypedError("DuplicatePort");
            for(Candidate x:c.dnsCandidates)if(!ports.add(x.port))throw new TypedError("DuplicatePort");
            return c;
        }
        static Candidate[] parseCandidates(JSONArray list,Candidate[] required)throws Exception{
            if(list.length()!=required.length)throw new TypedError("CandidateCount");Candidate[] result=new Candidate[required.length];
            for(int i=0;i<required.length;i++){JSONObject j=list.getJSONObject(i);String tag=tag(j.getString("tag"));
                String worker=j.has("worker")?j.getString("worker"):null;
                if(!required[i].tag.equals(tag)||!Objects.equals(required[i].worker,worker))throw new TypedError("CandidateOrderOrWorker");
                result[i]=new Candidate(tag,integer(j,"socks_port",required[i].port,1,65535),worker);}
            return result;
        }
        static int integer(JSONObject j,String k,int d,int min,int max)throws Exception{int v=j.optInt(k,d);if(v<min||v>max)throw new TypedError("InvalidConfiguration");return v;}
        static String absolute(String s)throws Exception{if(!new File(s).isAbsolute()||s.indexOf('\0')>=0)throw new TypedError("InvalidPath");return s;}
        static String tag(String s)throws Exception{if(!s.matches("[A-Za-z0-9_-]{1,64}"))throw new TypedError("InvalidTag");return s;}
        static String hostname(String s)throws Exception{if(!s.matches("[A-Za-z0-9.-]{1,253}"))throw new TypedError("InvalidHostname");return s;}
    }
    static final class Gate {
        final Config c;final String boot;
        Gate(Config c)throws Exception{this.c=c;boot=smallText(c.bootIdFile);if(!boot.matches("[A-Za-z0-9-]{1,64}"))throw new TypedError("InvalidBootId");}
        boolean allowed(){try{return !c.dryRun&&boot.equals(smallText(c.bootIdFile))&&boot.equals(markerText(c.bootGuardFile))
            &&!markerText(c.releaseIdFile).isEmpty()&&markerText(c.releaseIdFile).equals(markerText(c.enabledMarker));}catch(Exception e){return false;}}
        void require()throws Exception{if(!allowed())throw new TypedError("MutationGateClosed");}
    }
    static String markerText(String path)throws Exception{
        Path p=Paths.get(path);PosixFileAttributes a=Files.readAttributes(p,PosixFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!a.isRegularFile()||a.isSymbolicLink()||!a.permissions().equals(EnumSet.of(PosixFilePermission.OWNER_READ,PosixFilePermission.OWNER_WRITE)))throw new TypedError("MarkerPermissions");
        try(InputStream in=Files.newInputStream(p,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){return new String(readLimited(in,256),StandardCharsets.US_ASCII).trim();}
    }
    static String smallText(String path)throws Exception{return new String(readFile(new File(path),256),StandardCharsets.US_ASCII).trim();}
    static byte[] ipv4(String value)throws Exception{String[] parts=value.split("\\.",-1);if(parts.length!=4)throw new TypedError("InvalidIPv4");byte[] b=new byte[4];for(int i=0;i<4;i++){if(!parts[i].matches("[0-9]{1,3}"))throw new TypedError("InvalidIPv4");int n=Integer.parseInt(parts[i]);if(n>255)throw new TypedError("InvalidIPv4");b[i]=(byte)n;}return b;}
    static final class Probe {
        boolean ok,primaryOk,youtubeOk;long bytes,elapsedMs,at,round;String error,tag;
        static Probe failed(String error){Probe p=new Probe();p.error=error;p.at=monotonic();return p;}
    }
    interface ProbeProvider {Probe probe(Candidate candidate,boolean dns);}
    static SSLSocket tls(Config config,Candidate lane,String host,int port,boolean numeric,Cancellation cancel)throws Exception{
        Socket raw=new Socket(new Proxy(Proxy.Type.SOCKS,new InetSocketAddress("127.0.0.1",lane.port)));cancel.socket(raw);
        InetSocketAddress address=numeric?new InetSocketAddress(InetAddress.getByAddress(ipv4(config.dnsIp)),port):InetSocketAddress.createUnresolved(host,port);
        raw.connect(address,config.connectTimeoutMs);raw.setSoTimeout(config.readTimeoutMs);
        SSLSocket tls=(SSLSocket)((SSLSocketFactory)SSLSocketFactory.getDefault()).createSocket(raw,host,port,true);
        tls.setSoTimeout(config.readTimeoutMs);SSLParameters parameters=tls.getSSLParameters();parameters.setEndpointIdentificationAlgorithm("HTTPS");tls.setSSLParameters(parameters);tls.startHandshake();return tls;
    }
    static Probe httpsProbe(Config c,Candidate lane,boolean youtube){
        Probe p=new Probe();AtomicLong progress=new AtomicLong();long start=monotonic();
        try{bounded(cancel->{String host=youtube?"www.youtube.com":PROBE_HOST,path=youtube?"/":PROBE_PATH;
            SSLSocket s=tls(c,lane,host,443,false,cancel);
            String request="GET "+path+" HTTP/1.1\r\nHost: "+host+"\r\nAccept-Encoding: identity\r\nConnection: close\r\nCache-Control: no-cache\r\nUser-Agent: "+USER_AGENT+"\r\n\r\n";
            s.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));s.getOutputStream().flush();
            Response r=response(s.getInputStream(),youtube?2*1024*1024:PROBE_BYTES,youtube,progress,!youtube);
            if(youtube&&(r.status!=200||r.bytes<4096||!r.headers.getOrDefault("content-encoding","identity").equalsIgnoreCase("identity")||!new String(r.body,StandardCharsets.UTF_8).contains("ytInitialData")))throw new TypedError("YouTubeMeaningfulBodyMissing");
            return true;},c.probeTimeoutMs);p.ok=true;
        }catch(Exception e){p.error=errorType(e);}p.bytes=progress.get();p.at=monotonic();p.elapsedMs=p.at-start;return p;
    }
    static Probe pairProbe(Config c,Candidate lane){
        ExecutorService pool=Executors.newFixedThreadPool(2,daemonFactory("youtube-pair"));long start=monotonic();
        Future<Probe> primary=pool.submit(()->httpsProbe(c,lane,false)),youtube=pool.submit(()->httpsProbe(c,lane,true));
        try{Probe a=primary.get(c.probeTimeoutMs+1000L,TimeUnit.MILLISECONDS);long remain=c.probeTimeoutMs+1500L-(monotonic()-start);
            Probe b=youtube.get(Math.max(1,remain),TimeUnit.MILLISECONDS);Probe p=new Probe();p.primaryOk=a.ok;p.youtubeOk=b.ok;p.ok=a.ok&&b.ok;p.bytes=a.bytes+b.bytes;p.at=monotonic();p.elapsedMs=p.at-start;p.error=p.ok?null:(!a.ok?"Primary_"+a.error:"YouTube_"+b.error);return p;
        }catch(Exception e){return Probe.failed(errorType(e));}finally{primary.cancel(true);youtube.cancel(true);pool.shutdownNow();}
    }
    static ThreadFactory daemonFactory(String name){return r->{Thread t=new Thread(r,name);t.setDaemon(true);return t;};}
    static int u16(byte[] b,int p){return (b[p]&255)*256+(b[p+1]&255);}
    static void put16(byte[] b,int p,int v){b[p]=(byte)(v>>>8);b[p+1]=(byte)v;}
    static byte[] dnsRequest(String host,int id)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();byte[] h=new byte[12];put16(h,0,id);put16(h,2,0x100);put16(h,4,1);b.write(h);for(String label:host.split("\\.")){if(label.isEmpty()||label.length()>63)throw new TypedError("DnsLabel");b.write(label.length());b.write(label.getBytes(StandardCharsets.US_ASCII));}b.write(new byte[]{0,0,1,0,1});return b.toByteArray();}
    static String dnsName(byte[] b,int[] offset)throws Exception{int pos=offset[0],resume=-1;StringBuilder name=new StringBuilder();for(int hops=0;hops<128;hops++){
        if(pos>=b.length)throw new TypedError("DnsBounds");int n=b[pos]&255;
        if((n&192)==192){if(pos+1>=b.length)throw new TypedError("DnsBounds");int next=((n&63)<<8)|(b[pos+1]&255);if(next>=pos)throw new TypedError("DnsPointer");if(resume<0)resume=pos+2;pos=next;continue;}
        if((n&192)!=0)throw new TypedError("DnsLabel");pos++;if(n==0){offset[0]=resume<0?pos:resume;return name.toString().toLowerCase(Locale.ROOT);}
        if(pos+n>b.length||name.length()+n+1>254)throw new TypedError("DnsBounds");if(name.length()>0)name.append('.');
        for(int i=0;i<n;i++){char ch=(char)(b[pos+i]&255);if(!(Character.isLetterOrDigit(ch)||ch=='-'||ch=='_'))throw new TypedError("DnsLabel");name.append(ch);}pos+=n;}throw new TypedError("DnsPointerLoop");}
    static boolean validDns(byte[] b,int id,String query)throws Exception{
        if(b.length<12||u16(b,0)!=id||(u16(b,2)&0x8000)==0||(u16(b,2)&0x7a0f)!=0||u16(b,4)!=1||u16(b,6)<1||u16(b,6)>64)throw new TypedError("DnsHeader");
        int[] p={12};if(!dnsName(b,p).equals(query)||p[0]+4>b.length||u16(b,p[0])!=1||u16(b,p[0]+2)!=1)throw new TypedError("DnsQuestion");p[0]+=4;
        Set<String> addresses=new HashSet<>();Map<String,String> aliases=new HashMap<>();
        for(int i=0;i<u16(b,6);i++){String owner=dnsName(b,p);if(p[0]+10>b.length)throw new TypedError("DnsBounds");int type=u16(b,p[0]),cls=u16(b,p[0]+2),len=u16(b,p[0]+8);p[0]+=10;int end=p[0]+len;if(end>b.length)throw new TypedError("DnsBounds");
            if(cls==1&&type==1){if(len!=4)throw new TypedError("DnsAddressLength");int first=b[p[0]]&255;if(first>0&&first!=127&&first<224)addresses.add(owner);}
            if(cls==1&&type==5){int[] t={p[0]};String target=dnsName(b,t);if(t[0]!=end)throw new TypedError("DnsCnameLength");aliases.put(owner,target);}p[0]=end;}
        String target=query;for(int i=0;i<65&&target!=null;i++){if(addresses.contains(target))return true;target=aliases.get(target);}throw new TypedError("DnsNoMatchingAddress");
    }
    static Probe dotProbe(Config c,Candidate lane){Probe p=new Probe();long start=monotonic();try{
        bounded(cancel->{SSLSocket s=tls(c,lane,c.dnsName,853,true,cancel);int id=new java.security.SecureRandom().nextInt(65536);byte[] q=dnsRequest(c.dnsQuery,id);
            DataOutputStream out=new DataOutputStream(s.getOutputStream());out.writeShort(q.length);out.write(q);out.flush();DataInputStream in=new DataInputStream(s.getInputStream());int length=in.readUnsignedShort();if(length<12||length>4096)throw new TypedError("DnsMessageLength");byte[] data=new byte[length];in.readFully(data);validDns(data,id,c.dnsQuery);p.bytes=length;return true;},c.probeTimeoutMs);p.ok=true;
        }catch(Exception e){p.error=errorType(e);}p.at=monotonic();p.elapsedMs=p.at-start;return p;}
    static final class Api {
        final Config c;final String secret;final Gate gate;
        Api(Config c,String token,Gate gate){this.c=c;secret=token;this.gate=gate;}
        Response request(String method,String path,byte[] body)throws Exception{
            if(!"GET".equals(method))gate.require();
            return bounded(cancel->{Socket socket=new Socket();cancel.socket(socket);socket.connect(new InetSocketAddress("127.0.0.1",c.apiPort),c.connectTimeoutMs);socket.setSoTimeout(c.readTimeoutMs);
                String headers=method+" "+path+" HTTP/1.1\r\nHost: 127.0.0.1:"+c.apiPort+"\r\nAuthorization: Bearer "+secret+"\r\nAccept: application/json\r\nConnection: close\r\n";
                if(body!=null)headers+="Content-Type: application/json\r\nContent-Length: "+body.length+"\r\n";
                OutputStream out=socket.getOutputStream();out.write((headers+"\r\n").getBytes(StandardCharsets.UTF_8));if(body!=null)out.write(body);out.flush();return response(socket.getInputStream(),MAX_API_BYTES,true,new AtomicLong(),false);},c.apiTimeoutMs);
        }
        String selection(Channel channel)throws Exception{Response r=request("GET","/proxies/"+channel.selector,null);if(r.status!=200)throw new TypedError("ApiGetStatus");JSONObject j=new JSONObject(new String(r.body,StandardCharsets.UTF_8));
            if(!"selector".equalsIgnoreCase(j.optString("type")))throw new TypedError("ApiNotSelector");String selected=Config.tag(j.getString("now"));Set<String> tags=new HashSet<>();JSONArray all=j.getJSONArray("all");for(int i=0;i<all.length();i++)tags.add(all.getString(i));for(Candidate x:channel.lanes)if(!tags.contains(x.tag))throw new TypedError("ApiMissingCandidate");return selected;}
        void put(Channel channel,String target)throws Exception{Response r=request("PUT","/proxies/"+channel.selector,new JSONObject().put("name",target).toString().getBytes(StandardCharsets.UTF_8));if(r.status!=200&&r.status!=204)throw new TypedError("ApiPutStatus");}
        JSONArray connections()throws Exception{Response r=request("GET","/connections",null);if(r.status!=200)throw new TypedError("ApiConnectionsStatus");return new JSONObject(new String(r.body,StandardCharsets.UTF_8)).getJSONArray("connections");}
        int cleanup(Channel channel,String old,String expected)throws Exception{
            if(!expected.equals(selection(channel)))throw new TypedError("CleanupSelectionChanged");Set<String> ids=new HashSet<>();JSONArray connections=connections();
            for(int i=0;i<connections.length();i++){JSONObject item=connections.getJSONObject(i);if(!chainHas(item,channel.selector)||!chainHas(item,old))continue;
                String id=item.getString("id");if(!id.matches("[A-Za-z0-9._-]{1,128}"))throw new TypedError("UnsafeConnectionId");
                if(!expected.equals(selection(channel)))throw new TypedError("CleanupSelectionChanged");
                Response r=request("DELETE","/connections/"+id,null);if(r.status!=200&&r.status!=204&&r.status!=404)throw new TypedError("ApiDeleteStatus");ids.add(id);}
            JSONArray remaining=connections();for(int i=0;i<remaining.length();i++){JSONObject item=remaining.getJSONObject(i);if(ids.contains(item.getString("id"))||(chainHas(item,channel.selector)&&chainHas(item,old)))throw new TypedError("ConnectionDeletionNotVerified");}return ids.size();
        }
    }
    static boolean chainHas(JSONObject item,String name)throws Exception{JSONArray chain=item.optJSONArray("chains");if(chain==null)return false;for(int i=0;i<chain.length();i++)if(name.equals(chain.getString(i)))return true;return false;}
    static final Pattern FOREGROUND=Pattern.compile("^\\s*mResumedActivity\\s*[:=]\\s*ActivityRecord\\{[^\\r\\n]*\\s(org\\.smarttube\\.(?:beta|stable|smarttubetv)|com\\.google\\.android\\.youtube\\.tv)/[^\\s}]+(?=\\s|\\})[^\\r\\n]*$");
    static boolean foregroundText(String text){for(String line:text.split("\r?\n"))if(FOREGROUND.matcher(line).matches())return true;return false;}
    static boolean foreground(Config c)throws Exception{return bounded(cancel->{Process p=new ProcessBuilder("/system/bin/dumpsys","activity","activities").redirectErrorStream(true).start();cancel.process(p);byte[] out=readLimited(p.getInputStream(),1024*1024);if(p.waitFor()!=0)throw new TypedError("ForegroundFailed");return foregroundText(new String(out,StandardCharsets.UTF_8));},c.foregroundTimeoutMs);}
    static final class Channel {
        final String selector;final Candidate[] lanes;final boolean dns;
        String selected,pendingOld,pendingTarget;long selectedSince,lastRecovery;
        final Map<String,Integer> successes=new HashMap<>();
        Channel(String s,Candidate[] lanes,boolean dns){selector=s;this.lanes=lanes;this.dns=dns;}
        int index(String tag){for(int i=0;i<lanes.length;i++)if(lanes[i].tag.equals(tag))return i;return -1;}
        Candidate candidate(String tag){int i=index(tag);return i<0?null:lanes[i];}
        void observed(String tag,long now){if(!Objects.equals(selected,tag)){selected=tag;selectedSince=now;successes.clear();lastRecovery=0;}}
        JSONObject json()throws Exception{return new JSONObject().put("selected",nullable(selected)).put("selected_since",selectedSince).put("last_recovery",lastRecovery).put("successes",new JSONObject(successes)).put("pending_old",nullable(pendingOld)).put("pending_target",nullable(pendingTarget));}
        void restore(JSONObject j)throws Exception{selected=j.isNull("selected")?null:j.getString("selected");selectedSince=j.getLong("selected_since");lastRecovery=j.optLong("last_recovery",0);pendingOld=j.isNull("pending_old")?null:j.getString("pending_old");pendingTarget=j.isNull("pending_target")?null:j.getString("pending_target");JSONObject s=j.optJSONObject("successes");if(s!=null)for(Candidate c:lanes)successes.put(c.tag,s.optInt(c.tag,0));}
    }
    static final class WorkerState {
        final String worker,tag;boolean pending;long nextAllowed,cooldownUntil;int cycleAttempts;final ArrayDeque<Long> attempts=new ArrayDeque<>();
        WorkerState(String worker,String tag){this.worker=worker;this.tag=tag;}
        void failed(long now){if(!pending){pending=true;nextAllowed=Math.max(nextAllowed,now+60000);}}
        boolean eligible(long now){while(!attempts.isEmpty()&&now-attempts.peekFirst()>=900000)attempts.removeFirst();
            if(now<cooldownUntil||now<nextAllowed)return false;
            if(attempts.size()>=3){cooldownUntil=now+1800000;return false;}
            if(cycleAttempts>=3){cycleAttempts=0;}return pending;}
        void beforeAttempt(long now){attempts.addLast(now);cycleAttempts++;nextAllowed=now+(cycleAttempts==1?180000:600000);if(cycleAttempts>=3)cooldownUntil=now+1800000;}
        JSONObject json()throws Exception{return new JSONObject().put("pending",pending).put("next_allowed",nextAllowed).put("cooldown_until",cooldownUntil).put("cycle_attempts",cycleAttempts).put("attempts",new JSONArray(attempts));}
        void restore(JSONObject j)throws Exception{pending=j.getBoolean("pending");nextAllowed=j.getLong("next_allowed");cooldownUntil=j.getLong("cooldown_until");cycleAttempts=j.getInt("cycle_attempts");JSONArray a=j.getJSONArray("attempts");if(a.length()>3)throw new TypedError("InvalidRestartState");for(int i=0;i<a.length();i++)attempts.add(a.getLong(i));if(nextAllowed<0||cooldownUntil<0||cycleAttempts<0||cycleAttempts>3)throw new TypedError("InvalidRestartState");}
    }
    interface Activity {boolean active()throws Exception;}
    interface Clock {long now();void sleep(long ms)throws Exception;}
    static final class RealClock implements Clock {public long now(){return monotonic();}public void sleep(long ms)throws Exception{Thread.sleep(ms);}}
    interface StateSink {void save(JSONObject state)throws Exception;}
    interface WorkerRunner {void restart(String worker)throws Exception;}
    final Config config;final Gate gate;final Api api;final Channel video,dns;final Map<String,WorkerState> workers=new LinkedHashMap<>();
    final ProbeProvider prober;final Activity activity;final Clock clock;final StateSink sink;final WorkerRunner workerRunner;
    long round;String error;boolean active;
    YoutubeFailover(Config c,String token)throws Exception{this(c,token,null,null,null,null,null);}
    YoutubeFailover(Config c,String token,ProbeProvider p,Activity a,Clock clock,StateSink sink,WorkerRunner runner)throws Exception{
        config=c;gate=new Gate(c);api=new Api(c,token,gate);video=new Channel(c.selector,c.candidates,false);dns=new Channel(c.dnsSelector,c.dnsCandidates,true);
        for(Candidate lane:c.candidates)if(lane.worker!=null)workers.put(lane.worker,new WorkerState(lane.worker,lane.tag));
        prober=p==null?(lane,isDns)->isDns?dotProbe(c,lane):pairProbe(c,lane):p;
        this.clock=clock==null?new RealClock():clock;
        activity=a==null?()->{boolean foreground=false;try{foreground=foreground(c);}catch(Exception e){log("foreground_error",null,errorType(e));}if(foreground)return true;JSONArray links=api.connections();for(int i=0;i<links.length();i++)if(chainHas(links.getJSONObject(i),c.selector))return true;return false;}:a;
        this.sink=sink==null?this::writeState:sink;
        workerRunner=runner==null?worker->bounded(cancel->{gate.require();Process process=new ProcessBuilder("/system/bin/sh",c.workerctl,"restart",worker).redirectErrorStream(true).start();cancel.process(process);readLimited(process.getInputStream(),65536);if(process.waitFor()!=0)throw new TypedError("WorkerRestartFailed");return true;},20000):runner;
    }
    Map<String,Probe> probeAll(Channel channel,Candidate[] lanes)throws Exception{
        long thisRound=++round;ExecutorService pool=Executors.newFixedThreadPool(Math.max(1,lanes.length),daemonFactory("youtube-round"));Map<String,Future<Probe>> jobs=new LinkedHashMap<>();
        for(Candidate lane:lanes)jobs.put(lane.tag,pool.submit(()->prober.probe(lane,channel.dns)));
        long deadline=monotonic()+config.probeTimeoutMs+2500L;Map<String,Probe> out=new LinkedHashMap<>();
        try{for(Map.Entry<String,Future<Probe>> job:jobs.entrySet()){Probe p;try{p=job.getValue().get(Math.max(1,deadline-monotonic()),TimeUnit.MILLISECONDS);}catch(Exception e){p=Probe.failed(errorType(e));}
                p.round=thisRound;p.tag=job.getKey();p.at=clock.now();out.put(job.getKey(),p);logProbe(channel.selector,job.getKey(),p);
                if(!channel.dns){Candidate lane=channel.candidate(job.getKey());if(lane.worker!=null&&(p.ok||p.youtubeOk))workers.get(lane.worker).pending=false;}}
            if(!channel.dns&&lanes.length>=2){boolean anyPrimary=false,anyYouTube=false;for(Probe p:out.values()){anyPrimary|=p.primaryOk;anyYouTube|=p.youtubeOk;}
                if(!anyPrimary&&anyYouTube){for(Probe p:out.values())p.ok=p.youtubeOk;log("primary_endpoint_unavailable",channel.selector,"YouTubeBodyEvidenceOnly");}}
            return out;
        }finally{for(Future<Probe> job:jobs.values())job.cancel(true);pool.shutdownNow();}
    }
    void proof(Probe p,String expected)throws Exception{if(p==null||!p.ok||!Objects.equals(p.tag,expected)||p.round!=round||clock.now()<p.at||clock.now()-p.at>config.apiTimeoutMs*2L+config.probeTimeoutMs)throw new TypedError("MissingFreshHealthyProbe");}
    boolean switchTo(Channel channel,String expected,String target,Probe p,boolean failedPath)throws Exception{
        if(channel.index(target)<0||target.equals(expected))throw new TypedError("InvalidSwitchTarget");proof(p,target);
        if(!gate.allowed()){log("dry_run_switch",target,null);return false;}
        if(!channel.dns&&!activity.active())throw new TypedError("PlaybackNoLongerActive");
        String before=api.selection(channel);channel.observed(before,clock.now());if(!expected.equals(before))throw new TypedError("ConcurrentSelectionChange");
        if(failedPath){channel.pendingOld=expected;channel.pendingTarget=target;sink.save(state());}
        api.put(channel,target);String verified=api.selection(channel);channel.observed(verified,clock.now());
        if(!target.equals(verified))throw new TypedError("SelectionVerificationMismatch");
        sink.save(state());log("selection_verified",channel.selector+":"+target,null);
        if(failedPath)finishCleanup(channel,p);
        return true;
    }
    void finishCleanup(Channel channel,Probe currentProof)throws Exception{
        if(channel.pendingOld==null||!Objects.equals(channel.pendingTarget,channel.selected))return;proof(currentProof,channel.selected);gate.require();
        if(!channel.dns&&!activity.active())throw new TypedError("PlaybackNoLongerActive");
        String old=channel.pendingOld;int deleted=api.cleanup(channel,old,channel.pendingTarget);
        channel.pendingOld=channel.pendingTarget=null;
        if(!channel.dns){Candidate failed=channel.candidate(old);if(failed!=null&&failed.worker!=null)workers.get(failed.worker).failed(clock.now());}
        sink.save(state());log("cleanup_verified",channel.selector+":"+deleted,null);
    }
    void channelStep(Channel channel)throws Exception{
        channel.observed(api.selection(channel),clock.now());Candidate current=channel.candidate(channel.selected);if(current==null)throw new TypedError("UnmanagedSelection");
        Probe first=probeAll(channel,new Candidate[]{current}).get(current.tag);
        if(first.ok){if(channel.pendingOld!=null){if(gate.allowed())finishCleanup(channel,first);}
            recover(channel,current,null);
            return;}
        clock.sleep(config.retryMs);
        Map<String,Probe> results=probeAll(channel,channel.lanes);if(results.get(current.tag).ok){recover(channel,current,results);return;}
        channel.successes.clear();
        for(Candidate lane:channel.lanes)if(!lane.tag.equals(current.tag)&&results.get(lane.tag).ok){switchTo(channel,current.tag,lane.tag,results.get(lane.tag),true);return;}
        log("all_candidates_unhealthy",channel.selector,"NoSwitchNoRestart");
    }
    void recover(Channel channel,Candidate current,Map<String,Probe> available)throws Exception{
        if(clock.now()-channel.lastRecovery<config.recoveryIntervalMs)return;
        channel.lastRecovery=clock.now();Candidate[] higher=Arrays.copyOf(channel.lanes,channel.index(current.tag));
        LinkedHashMap<String,Candidate> maintenance=new LinkedHashMap<>();for(Candidate lane:higher)maintenance.put(lane.tag,lane);
        // Recovery priority and worker maintenance are separate: the last-ranked
        // ZGO HY2 must still be repaired when rank 0 is healthy and selected.
        if(!channel.dns)for(Candidate lane:channel.lanes)if(lane.worker!=null&&!lane.tag.equals(current.tag))maintenance.put(lane.tag,lane);
        if(maintenance.isEmpty())return;
        Map<String,Probe> results=available==null?probeAll(channel,maintenance.values().toArray(new Candidate[0])):available;
        for(Candidate lane:higher){Probe p=results.get(lane.tag);int count=p.ok?Math.min(config.recoverySuccesses,channel.successes.getOrDefault(lane.tag,0)+1):0;channel.successes.put(lane.tag,count);}
        if(!channel.dns)for(Candidate lane:maintenance.values()){Probe p=results.get(lane.tag);if(lane.worker!=null&&!p.primaryOk&&!p.youtubeOk)workers.get(lane.worker).failed(clock.now());}
        // Only higher priority candidates can trigger normal recovery. A healthy
        // lower-ranked standby never displaces the current healthy route.
        for(Candidate lane:higher)if(channel.successes.getOrDefault(lane.tag,0)>=config.recoverySuccesses&&clock.now()-channel.selectedSince>=config.recoveryHoldMs){switchTo(channel,current.tag,lane.tag,results.get(lane.tag),false);break;}
    }
    boolean workerSafe(String worker)throws Exception{
        gate.require();WorkerState state=workers.get(worker);if(state==null)throw new TypedError("UnknownWorker");
        if(state.tag.equals(api.selection(video)))return false;
        JSONArray connections=api.connections();for(int i=0;i<connections.length();i++)if(chainHas(connections.getJSONObject(i),state.tag))return false;return true;
    }
    void restartEligible()throws Exception{
        for(WorkerState w:workers.values())if(w.eligible(clock.now())&&gate.allowed()){
            if(!activity.active()||video.pendingOld!=null||!workerSafe(w.worker))continue;
            String currentTag=api.selection(video);Candidate current=video.candidate(currentTag);if(current==null)continue;
            Probe route=probeAll(video,new Candidate[]{current}).get(currentTag);
            if(!route.ok&&!route.youtubeOk)continue;
            // Reconfirm the isolated worker is still bad; a stale fault cannot
            // restart a now-healthy stream or a worker during probe-site outage.
            Probe fresh=probeAll(video,new Candidate[]{video.candidate(w.tag)}).get(w.tag);
            if(fresh.ok||fresh.youtubeOk||!w.pending||!workerSafe(w.worker))continue;
            w.beforeAttempt(clock.now());video.successes.put(w.tag,0);sink.save(state());
            try{workerRunner.restart(w.worker);log("worker_restarted",w.worker,null);}catch(Exception e){log("worker_restart_error",w.worker,errorType(e));}
            video.successes.put(w.tag,0);sink.save(state());
        }
    }
    void step(){error=null;try{active=activity.active();if(active)channelStep(video);else video.successes.clear();}catch(Exception e){error=errorType(e);log("video_error",video.selected,error);}
        try{channelStep(dns);}catch(Exception e){error=errorType(e);log("dns_error",dns.selected,error);}
        try{if(active)restartEligible();sink.save(state());}catch(Exception e){error=errorType(e);log("state_or_restart_error",null,error);}
    }
    JSONObject state()throws Exception{JSONObject j=new JSONObject().put("schema",1).put("boot_id",gate.boot).put("updated_at",utc()).put("active",active).put("dry_run",config.dryRun).put("mutation_gate",gate.allowed()).put("error",nullable(error)).put("video",video.json()).put("dns",dns.json());JSONObject ws=new JSONObject();for(WorkerState w:workers.values())ws.put(w.worker,w.json());return j.put("workers",ws);}
    void restore(JSONObject state)throws Exception{if(state.getInt("schema")!=1)throw new TypedError("StateSchema");if(!gate.boot.equals(state.getString("boot_id")))return;
        video.restore(state.getJSONObject("video"));dns.restore(state.getJSONObject("dns"));JSONObject ws=state.getJSONObject("workers");for(WorkerState w:workers.values())w.restore(ws.getJSONObject(w.worker));
        // A JVM restart never manufactures consecutive probe successes.
        video.successes.clear();dns.successes.clear();
    }
    void writeState(JSONObject j)throws Exception{
        File target=new File(config.stateFile),temp=new File(target.getParentFile(),"."+target.getName()+"."+Os.getpid()+".tmp");
        FileDescriptor fd=Os.open(temp.getAbsolutePath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_EXCL,0600);boolean renamed=false;
        try{try(FileOutputStream out=new FileOutputStream(fd)){out.write((j.toString()+"\n").getBytes(StandardCharsets.UTF_8));out.getFD().sync();}Os.rename(temp.getAbsolutePath(),target.getAbsolutePath());renamed=true;}
        finally{if(!renamed)temp.delete();}
    }
    static Object nullable(Object x){return x==null?JSONObject.NULL:x;}
    static long monotonic(){return System.nanoTime()/1000000L;}
    static String utc(){SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT);f.setTimeZone(TimeZone.getTimeZone("UTC"));return f.format(new Date());}
    static String errorType(Throwable e){return e instanceof TypedError?e.getMessage():e.getClass().getSimpleName();}
    static void log(String event,String target,String error){try{JSONObject j=new JSONObject().put("time",utc()).put("event",event).put("target",nullable(target)).put("error",nullable(error));System.out.println(j.toString());}catch(Exception ignored){}}
    static void logProbe(String selector,String tag,Probe p){try{JSONObject j=new JSONObject().put("time",utc()).put("event","probe").put("selector",selector).put("tag",tag).put("ok",p.ok).put("primary_ok",p.primaryOk).put("youtube_ok",p.youtubeOk).put("bytes",p.bytes).put("elapsed_ms",p.elapsedMs).put("error",nullable(p.error));System.out.println(j.toString());}catch(Exception ignored){}}
    static byte[] readFile(File file,int max) throws IOException {
        try(InputStream in=new FileInputStream(file)){return readLimited(in,max);}
    }
    static byte[] readLimited(InputStream in,int max) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        copy(in,out,Long.MAX_VALUE,max,new AtomicLong(),false);return out.toByteArray();
    }
    static String secret(String path) throws Exception {
        StructStat stat=Os.lstat(path);
        if(!OsConstants.S_ISREG(stat.st_mode) || (stat.st_mode & 0777)!=0600)throw new TypedError("SecretFilePermissions");
        // O_NOFOLLOW also prevents swapping in a symlink after lstat.
        FileDescriptor fd=Os.open(path,OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
        byte[] bytes;
        try(InputStream in=new FileInputStream(fd)) {
            StructStat opened=Os.fstat(fd);
            if(!OsConstants.S_ISREG(opened.st_mode) || (opened.st_mode & 0777)!=0600)throw new TypedError("SecretFilePermissions");
            bytes=readLimited(in,8192);
        }
        String token=new String(bytes,StandardCharsets.UTF_8).trim();Arrays.fill(bytes,(byte)0);
        if(token.isEmpty() || !token.matches("[\\x21-\\x7e]+"))throw new TypedError("InvalidSecretFile");
        return token;
    }
    public static void main(String[] args){try{
        if(args.length==2&&"--check-config".equals(args[0])){
            Config c=Config.load(args[1]);secret(c.secretFile);Gate gate=new Gate(c);JSONObject markers=new JSONObject();
            String[] names={"enabled","boot_guard","release_id"},paths={c.enabledMarker,c.bootGuardFile,c.releaseIdFile};
            for(int i=0;i<names.length;i++){String status;try{markerText(paths[i]);status="valid_permissions";}catch(NoSuchFileException e){status="missing";}catch(Exception e){status=errorType(e);}markers.put(names[i],status);}
            System.out.println(new JSONObject().put("config_valid",true).put("candidate_count",c.candidates.length).put("dns_candidate_count",c.dnsCandidates.length).put("authorized",gate.allowed()).put("dry_run",c.dryRun).put("markers",markers).toString());
            return;
        }
        boolean workerCheck=args.length==3&&"--worker-safe".equals(args[0]);
        if(!workerCheck&&args.length!=1)throw new TypedError("UsageConfigOrWorkerSafe");
        Config c=Config.load(args[workerCheck?1:0]);YoutubeFailover guard=new YoutubeFailover(c,secret(c.secretFile));
        if(workerCheck){boolean safe=guard.workerSafe(args[2]);log("worker_safe",args[2],safe?null:"WorkerInUse");System.exit(safe?0:1);return;}
        File state=new File(c.stateFile);if(state.exists())guard.restore(new JSONObject(new String(readFile(state,65536),StandardCharsets.UTF_8)));
        guard.sink.save(guard.state());log("started",c.selector,c.dryRun?"DryRun":null);
        while(!Thread.currentThread().isInterrupted()){long start=monotonic();guard.step();Thread.sleep(Math.max(1,c.intervalMs-(monotonic()-start)));}
    }catch(InterruptedException e){Thread.currentThread().interrupt();}catch(Exception e){log("fatal",null,errorType(e));System.exit(1);}}
}
