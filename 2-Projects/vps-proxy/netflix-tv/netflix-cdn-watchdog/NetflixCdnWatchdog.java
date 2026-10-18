import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
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

/** Standalone Android app_process entry point. No Activity or device configuration writes. */
public final class NetflixCdnWatchdog {
    static final int PROBE_BYTES = 262144;
    static final String PROBE_HOST = "speed.cloudflare.com";
    static final String PROBE_PATH = "/__down?bytes=262144";
    static final int MAX_API_BYTES = 4 * 1024 * 1024;
    static final Pattern PLAYER = Pattern.compile(
        "^\\s*mResumedActivity\\s*[:=]\\s*ActivityRecord\\{[^\\r\\n]*\\s"
        + "com\\.netflix\\.mediaclient/(?:\\.ui\\.player\\.PlayerActivity|"
        + "com\\.netflix\\.mediaclient\\.ui\\.player\\.PlayerActivity)(?=\\s|\\})[^\\r\\n]*$"
    );

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
            Thread t = new Thread(r, "netflix-watchdog-operation");
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

    static final class Config {
        String secretFile, stateFile, selector = "zgo-video", hy2 = "zgo-hy2", reality = "zgo-netflix";
        int socksPort = 1081, apiPort = 19090;
        int intervalMs = 30000, connectTimeoutMs = 6000, readTimeoutMs = 6000;
        int probeTimeoutMs = 12000, apiTimeoutMs = 12000, foregroundTimeoutMs = 4000;
        int fallbackFailures = 2, recoverySuccesses = 3, recoveryHoldMs = 180000;
        static Config load(String filename) throws Exception {
            File file = new File(filename).getAbsoluteFile();
            JSONObject j = new JSONObject(new String(readFile(file, 65536), StandardCharsets.UTF_8));
            Config c = new Config();
            c.secretFile = absolute(j.getString("secret_file"));
            c.stateFile = absolute(j.optString("state_file", new File(file.getParentFile(), "watchdog-state.json").getPath()));
            if (new File(c.secretFile).getCanonicalFile().equals(new File(c.stateFile).getCanonicalFile()))
                throw new TypedError("StateSecretPathConflict");
            c.selector = tag(j.optString("selector", c.selector));
            c.hy2 = tag(j.optString("hy2", c.hy2));
            c.reality = tag(j.optString("reality", c.reality));
            if (c.selector.equals(c.hy2) || c.selector.equals(c.reality) || c.hy2.equals(c.reality))
                throw new TypedError("DuplicateProxyTags");
            c.socksPort = integer(j, "socks_port", c.socksPort, 1, 65535);
            c.apiPort = integer(j, "api_port", c.apiPort, 1, 65535);
            c.intervalMs = integer(j, "interval_ms", c.intervalMs, 50, 3600000);
            c.connectTimeoutMs = integer(j, "connect_timeout_ms", c.connectTimeoutMs, 50, 60000);
            c.readTimeoutMs = integer(j, "read_timeout_ms", c.readTimeoutMs, 50, 60000);
            c.probeTimeoutMs = integer(j, "probe_timeout_ms", c.probeTimeoutMs, 50, 12000);
            c.apiTimeoutMs = integer(j, "api_timeout_ms", c.apiTimeoutMs, 50, 12000);
            c.foregroundTimeoutMs = integer(j, "foreground_timeout_ms", c.foregroundTimeoutMs, 50, 12000);
            c.fallbackFailures = integer(j, "fallback_failures", c.fallbackFailures, 1, 100);
            c.recoverySuccesses = integer(j, "recovery_successes", c.recoverySuccesses, 1, 100);
            c.recoveryHoldMs = integer(j, "recovery_hold_ms", c.recoveryHoldMs, 0, 86400000);
            return c;
        }
        static int integer(JSONObject j, String key, int def, int min, int max) throws Exception {
            int value = j.optInt(key, def);
            if (value < min || value > max) throw new TypedError("InvalidConfiguration");
            return value;
        }
        static String absolute(String s) throws Exception {
            if (!new File(s).isAbsolute() || s.indexOf('\0') >= 0) throw new TypedError("InvalidPath");
            return s;
        }
        static String tag(String s) throws Exception {
            if (!s.matches("[A-Za-z0-9_-]{1,64}")) throw new TypedError("InvalidProxyTag");
            return s;
        }
    }

    static final class Policy {
        final String hy2, reality;
        final int fallbackFailures, recoverySuccesses;
        final long holdMs;
        String selected;
        int failures, successes;
        long selectedSince;
        Policy(String h, String r, int f, int s, long hold) {
            hy2 = h; reality = r; fallbackFailures = f; recoverySuccesses = s; holdMs = hold;
        }
        void observed(String selection, long now) {
            if (!Objects.equals(selected, selection)) {
                selected = selection; selectedSince = now; failures = 0; successes = 0;
            }
        }
        void inactive() { failures = 0; successes = 0; }
        String result(boolean ok, long now) {
            if (!hy2.equals(selected) && !reality.equals(selected)) return null;
            if (ok) { successes = Math.min(successes + 1, recoverySuccesses); failures = 0; }
            else { failures = Math.min(failures + 1, fallbackFailures); successes = 0; }
            if (hy2.equals(selected) && failures >= fallbackFailures) return reality;
            if (reality.equals(selected) && successes >= recoverySuccesses && now - selectedSince >= holdMs) return hy2;
            return null;
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

    static boolean foregroundText(String output) {
        for (String s:output.split("\\r?\\n")) if (PLAYER.matcher(s).matches()) return true;
        return false;
    }
    static boolean playerForeground(Config config) throws Exception {
        return bounded(c -> {
            Process p=new ProcessBuilder("/system/bin/dumpsys","activity","activities").redirectErrorStream(true).start();
            c.process(p);
            byte[] data;
            try (InputStream in=p.getInputStream()) { data=readLimited(in,1024*1024); }
            if (p.waitFor()!=0) throw new TypedError("ForegroundCommandFailed");
            return foregroundText(new String(data,StandardCharsets.UTF_8));
        },config.foregroundTimeoutMs);
    }

    static final class ProbeResult {
        boolean ok; long bytes,elapsedMs; String errorType;
    }
    static ProbeResult probe(Config config) {
        ProbeResult result=new ProbeResult();
        AtomicLong progress=new AtomicLong();
        long start=monotonic();
        try {
            bounded(c -> {
                Proxy proxy=new Proxy(Proxy.Type.SOCKS,new InetSocketAddress("127.0.0.1",config.socksPort));
                Socket raw=new Socket(proxy); c.socket(raw);
                raw.connect(InetSocketAddress.createUnresolved(PROBE_HOST,443),config.connectTimeoutMs);
                raw.setSoTimeout(config.readTimeoutMs);
                SSLSocket tls=(SSLSocket)((SSLSocketFactory)SSLSocketFactory.getDefault()).createSocket(raw,PROBE_HOST,443,true);
                tls.setSoTimeout(config.readTimeoutMs);
                SSLParameters parameters=tls.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(parameters);
                // The cancellation owner stays the raw socket: close cannot wait on TLS close_notify.
                tls.startHandshake();
                OutputStream out=tls.getOutputStream();
                String request="GET "+PROBE_PATH+" HTTP/1.1\r\nHost: "+PROBE_HOST
                    +"\r\nAccept-Encoding: identity\r\nConnection: close\r\nCache-Control: no-cache\r\n"
                    +"User-Agent: Netflix-channel-watchdog/1.0\r\n\r\n";
                out.write(request.getBytes(StandardCharsets.US_ASCII)); out.flush();
                response(tls.getInputStream(),PROBE_BYTES,false,progress,true);
                return Boolean.TRUE;
            },config.probeTimeoutMs);
            result.ok=true;
        } catch (Exception e) { result.errorType=errorType(e); }
        result.bytes=progress.get(); result.elapsedMs=monotonic()-start;
        return result;
    }

    static final class Api {
        final Config config; final String secret;
        Api(Config c,String token) { config=c; secret=token; }
        Response request(String method,String path,byte[] body) throws Exception {
            return bounded(c -> {
                Socket socket=new Socket(); c.socket(socket);
                socket.connect(new InetSocketAddress("127.0.0.1",config.apiPort),config.connectTimeoutMs);
                socket.setSoTimeout(config.readTimeoutMs);
                ByteArrayOutputStream request=new ByteArrayOutputStream();
                String headers=method+" "+path+" HTTP/1.1\r\nHost: 127.0.0.1:"+config.apiPort
                    +"\r\nAuthorization: Bearer "+secret+"\r\nAccept: application/json"
                    +"\r\nConnection: close\r\n";
                if (body!=null) headers+="Content-Type: application/json\r\nContent-Length: "+body.length+"\r\n";
                request.write(headers.getBytes(StandardCharsets.UTF_8)); request.write('\r');request.write('\n');
                if(body!=null)request.write(body);
                OutputStream out=socket.getOutputStream();request.writeTo(out);out.flush();
                return response(socket.getInputStream(),MAX_API_BYTES,true,new AtomicLong(),false);
            },config.apiTimeoutMs);
        }
        String getSelection() throws Exception {
            Response response=request("GET","/proxies/"+config.selector,null);
            if(response.status!=200)throw new TypedError("ApiGetStatus");
            JSONObject j=new JSONObject(new String(response.body,StandardCharsets.UTF_8));
            String now=j.getString("now");
            Config.tag(now);
            // Require selector metadata so an arbitrary JSON object cannot look like a verified selector.
            if(!j.optString("type").equalsIgnoreCase("Selector"))throw new TypedError("ApiNotSelector");
            JSONArray all=j.getJSONArray("all");
            boolean hasHy2=false,hasReality=false;
            for(int i=0;i<all.length();i++){hasHy2|=config.hy2.equals(all.getString(i));hasReality|=config.reality.equals(all.getString(i));}
            if(!hasHy2 || !hasReality)throw new TypedError("ApiMissingCandidate");
            return now;
        }
        void putSelection(String target) throws Exception {
            byte[] body=new JSONObject().put("name",target).toString().getBytes(StandardCharsets.UTF_8);
            Response response=request("PUT","/proxies/"+config.selector,body);
            if(response.status!=204 && response.status!=200)throw new TypedError("ApiPutStatus");
        }
        JSONArray connections() throws Exception {
            Response response=request("GET","/connections",null);
            if(response.status!=200)throw new TypedError("ApiConnectionsStatus");
            return new JSONObject(new String(response.body,StandardCharsets.UTF_8)).getJSONArray("connections");
        }
        int closeFailedHy2Connections() throws Exception {
            JSONArray connections=connections();
            Set<String> attempted=new HashSet<>();
            for(int i=0;i<connections.length();i++) {
                JSONObject connection=connections.getJSONObject(i);
                JSONArray chain=connection.optJSONArray("chains");
                if(chain==null)continue;
                boolean selector=false,hy2=false;
                for(int k=0;k<chain.length();k++){selector|=config.selector.equals(chain.getString(k));hy2|=config.hy2.equals(chain.getString(k));}
                if(!selector || !hy2)continue;
                String id=connection.getString("id");
                if(!id.matches("[A-Za-z0-9._-]{1,128}"))throw new TypedError("ApiInvalidConnectionId");
                attempted.add(id);
                Response deleted=request("DELETE","/connections/"+id,null);
                // A connection may have closed naturally between GET and DELETE.
                if(deleted.status!=200 && deleted.status!=204 && deleted.status!=404)
                    throw new TypedError("ApiDeleteStatus");
            }
            if(!attempted.isEmpty()) {
                JSONArray remaining=connections();
                for(int i=0;i<remaining.length();i++)
                    if(attempted.contains(remaining.getJSONObject(i).getString("id")))
                        throw new TypedError("ConnectionDeletionNotVerified");
            }
            return attempted.size();
        }
    }

    final Config config;
    final Api api;
    final Policy policy;
    String lastProbe,lastVerifiedSelection,lastSelectionVerifiedAt,selectedSinceWall,errorType;
    boolean foreground;
    boolean pendingHy2Cleanup;
    int lastCleanupDeleted;
    String lastCleanupError;
    ProbeResult lastResult;
    NetflixCdnWatchdog(Config c,String secret) {
        config=c;api=new Api(c,secret);
        policy=new Policy(c.hy2,c.reality,c.fallbackFailures,c.recoverySuccesses,c.recoveryHoldMs);
    }
    void observed(String selected) {
        if(!Objects.equals(policy.selected,selected))selectedSinceWall=utc();
        policy.observed(selected,monotonic());
        lastVerifiedSelection=selected;lastSelectionVerifiedAt=utc();
    }
    void step() {
        errorType=null;
        foreground=false;
        try {
            foreground=playerForeground(config);
            if(!foreground) { policy.inactive();writeState();return; }
            observed(api.getSelection());
            if(pendingHy2Cleanup) {
                if(config.reality.equals(policy.selected)) {
                    try { finishPendingCleanup(); }
                    catch(Exception e) { lastCleanupError=errorType(e);log("cleanup_error",0,0,policy.selected,lastCleanupError); }
                } else { pendingHy2Cleanup=false;lastCleanupError=null; }
            }
            if(!config.hy2.equals(policy.selected) && !config.reality.equals(policy.selected)) {
                errorType="UnmanagedSelection";log("skipped",0,0,policy.selected,errorType);writeState();return;
            }
            lastProbe=utc();
            lastResult=probe(config);
            errorType=lastResult.errorType;
            log(lastResult.ok?"success":"failure",lastResult.bytes,lastResult.elapsedMs,policy.selected,errorType);
            String target=policy.result(lastResult.ok,monotonic());
            if(target!=null) {
                // Re-check foreground immediately before mutating network routing.
                if(!playerForeground(config)) { foreground=false;policy.inactive();writeState();return; }
                switchSelection(target);
            }
            writeState();
        } catch(Exception e) {
            if(!foreground)policy.inactive();
            errorType=errorType(e);
            log("error",lastResult==null?0:lastResult.bytes,0,policy.selected,errorType);
            try { writeState(); } catch(Exception stateError) {
                log("state_error",0,0,policy.selected,errorType(stateError));
            }
        }
    }
    /** Same switch/verify/cleanup method used by the live loop and HTTP integration tests. */
    boolean switchSelection(String target) throws Exception {
        if(!config.hy2.equals(target) && !config.reality.equals(target))throw new TypedError("InvalidSwitchTarget");
        String before=policy.selected;
        // Do not overwrite a manual/concurrent selector change while the probe was running.
        String current=api.getSelection(); observed(current);
        if(!Objects.equals(before,current))return false;
        boolean fallback=config.hy2.equals(before) && config.reality.equals(target);
        // Record intent before PUT: it may apply even when its response or subsequent GET fails.
        // Pending is not permission to delete; a later successful GET must first confirm Reality.
        if(fallback)pendingHy2Cleanup=true;
        api.putSelection(target);
        String verified=api.getSelection(); observed(verified);
        if(!target.equals(verified)) {
            if(!config.reality.equals(verified))pendingHy2Cleanup=false;
            throw new TypedError("SelectionVerificationMismatch");
        }
        errorType=null;
        log("selection_verified",lastResult==null?0:lastResult.bytes,lastResult==null?0:lastResult.elapsedMs,verified,null);
        if(fallback) {
            try { finishPendingCleanup(); }
            catch(Exception e) { lastCleanupError=errorType(e);throw e; }
        } else if(config.hy2.equals(target)) {
            pendingHy2Cleanup=false;lastCleanupError=null;
        }
        return true;
    }
    void finishPendingCleanup() throws Exception {
        if(!pendingHy2Cleanup || !config.reality.equals(policy.selected))return;
        int deleted=api.closeFailedHy2Connections();
        lastCleanupDeleted=deleted;lastCleanupError=null;pendingHy2Cleanup=false;
        log(deleted>0?"failed_connections_closed":"cleanup_no_matches",0,0,policy.selected,null);
    }
    void writeState() throws Exception {
        JSONObject j=new JSONObject();
        j.put("pid",Os.getpid());j.put("updatedAt",utc());j.put("lastProbe",nullable(lastProbe));
        j.put("failures",policy.failures);j.put("successes",policy.successes);
        j.put("selected",nullable(policy.selected));j.put("lastVerifiedSelection",nullable(lastVerifiedSelection));
        j.put("lastSelectionVerifiedAt",nullable(lastSelectionVerifiedAt));j.put("selectedSince",nullable(selectedSinceWall));
        j.put("foreground",foreground);j.put("errorType",nullable(errorType));
        j.put("pendingHy2Cleanup",pendingHy2Cleanup);j.put("lastCleanupDeleted",lastCleanupDeleted);
        j.put("lastCleanupError",nullable(lastCleanupError));
        if(lastResult!=null) {
            JSONObject p=new JSONObject();p.put("ok",lastResult.ok);p.put("bytes",lastResult.bytes);p.put("elapsed",lastResult.elapsedMs);
            p.put("errorType",nullable(lastResult.errorType));j.put("lastProbeResult",p);
        }
        byte[] bytes=(j.toString()+"\n").getBytes(StandardCharsets.UTF_8);
        File target=new File(config.stateFile);
        File tmp=new File(target.getParentFile(),"."+target.getName()+"."+Os.getpid()+".tmp");
        // No symlink following or world-readable moment during creation.
        FileDescriptor fd=Os.open(tmp.getAbsolutePath(),OsConstants.O_WRONLY|OsConstants.O_CREAT|OsConstants.O_EXCL,0600);
        boolean renamed=false;
        try {
            try(FileOutputStream out=new FileOutputStream(fd)){out.write(bytes);out.getFD().sync();}
            Os.rename(tmp.getAbsolutePath(),target.getAbsolutePath());renamed=true;
        } finally { if(!renamed)tmp.delete(); }
    }

    static Object nullable(Object x){return x==null?JSONObject.NULL:x;}
    static long monotonic(){return System.nanoTime()/1000000L;}
    static String utc(){SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.ROOT);f.setTimeZone(TimeZone.getTimeZone("UTC"));return f.format(new Date());}
    static String errorType(Throwable e){return e instanceof TypedError?e.getMessage():e.getClass().getSimpleName();}
    static void log(String probe,long bytes,long elapsed,String selected,String error) {
        try {
            JSONObject j=new JSONObject();j.put("time",utc());j.put("probe",probe);j.put("bytes",bytes);
            j.put("elapsed",elapsed);j.put("selected",nullable(selected));j.put("errorType",nullable(error));
            System.out.println(j.toString());System.out.flush();
        } catch(Exception ignored) { /* Never dump exception messages or request contents. */ }
    }
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
    public static void main(String[] args) {
        if(args.length!=1){log("startup_error",0,0,null,"ConfigPathRequired");System.exit(2);return;}
        try {
            Config config=Config.load(args[0]);
            NetflixCdnWatchdog watchdog=new NetflixCdnWatchdog(config,secret(config.secretFile));
            // A selector already set to Reality is respected, with a conservative fresh hold period.
            try { watchdog.observed(watchdog.api.getSelection()); }
            catch(Exception e){watchdog.errorType=errorType(e);log("startup_api_error",0,0,null,watchdog.errorType);}
            watchdog.writeState();
            log("started",0,0,watchdog.policy.selected,watchdog.errorType);
            while(!Thread.currentThread().isInterrupted()) {
                long next=monotonic()+config.intervalMs;
                watchdog.step();
                long wait=next-monotonic();
                Thread.sleep(Math.max(1,wait));
            }
        } catch(InterruptedException e){Thread.currentThread().interrupt();}
        catch(Exception e){log("fatal",0,0,null,errorType(e));System.exit(1);}
    }
}
