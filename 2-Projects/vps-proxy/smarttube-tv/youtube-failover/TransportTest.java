import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.*;

/** Pure JVM isolation tests: local sockets and generated, disposable test certificates only. */
public final class TransportTest {
    static int checks;
    static void check(boolean value,String name) { checks++; if(!value)throw new AssertionError(name); }
    interface Checked {void run()throws Exception;}
    static void rejects(Checked f,String name)throws Exception {
        try{f.run();throw new AssertionError(name);}catch(AssertionError e){throw e;}catch(Exception expected){checks++;}
    }
    static byte[] payload(int n){return new byte[n];}
    static InputStream http(String headers,byte[] body)throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(headers.getBytes(StandardCharsets.US_ASCII));out.write(body);
        return new ByteArrayInputStream(out.toByteArray());
    }
    static void parserTests()throws Exception {
        YoutubeFailover.Response good=YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nContent-Length: 262144\r\n\r\n",payload(262144)),262144,false,new AtomicLong(),true);
        check(good.bytes==262144,"exact body succeeds");
        rejects(()->YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nContent-Length: 262144\r\n\r\n",payload(1024)),262144,false,new AtomicLong(),true),"short body rejected");
        rejects(()->YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",payload(0)),262144,false,new AtomicLong(),true),"empty 200 rejected");
        rejects(()->YoutubeFailover.response(http("HTTP/1.1 302 Found\r\nLocation: https://example.invalid/\r\nContent-Length: 262144\r\n\r\n",payload(262144)),262144,false,new AtomicLong(),true),"redirect rejected");
        rejects(()->YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nContent-Length: 262145\r\n\r\n",payload(262145)),262144,false,new AtomicLong(),true),"oversize rejected");
        rejects(()->YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nContent-Length: 262144\r\nTransfer-Encoding: chunked\r\n\r\n",payload(0)),262144,false,new AtomicLong(),true),"ambiguous framing rejected");
        ByteArrayOutputStream chunks=new ByteArrayOutputStream();
        chunks.write("40000\r\n".getBytes(StandardCharsets.US_ASCII));chunks.write(payload(262144));chunks.write("\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        YoutubeFailover.Response chunked=YoutubeFailover.response(http("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",chunks.toByteArray()),262144,false,new AtomicLong(),true);
        check(chunked.bytes==262144,"chunked exact body succeeds");
    }
    static SSLContext context(Path keyFile,Path trustFile,char[] pass)throws Exception {
        KeyManager[] km=null;TrustManager[] tm=null;
        if(keyFile!=null){KeyStore k=KeyStore.getInstance("PKCS12");try(InputStream in=Files.newInputStream(keyFile)){k.load(in,pass);}KeyManagerFactory f=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());f.init(k,pass);km=f.getKeyManagers();}
        if(trustFile!=null){KeyStore k=KeyStore.getInstance("PKCS12");try(InputStream in=Files.newInputStream(trustFile)){k.load(in,pass);}TrustManagerFactory f=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());f.init(k);tm=f.getTrustManagers();}
        SSLContext c=SSLContext.getInstance("TLS");c.init(km,tm,null);return c;
    }
    static final class SocksServer implements AutoCloseable {
        final ServerSocket listen;final Thread thread;volatile int accepted;volatile String requestLine;volatile Socket connection;
        SocksServer(SSLContext serverContext,boolean stall)throws Exception {
            listen=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));
            thread=new Thread(()->{
                try(Socket raw=listen.accept()) {
                    connection=raw;accepted++;raw.setSoTimeout(2000);
                    DataInputStream in=new DataInputStream(raw.getInputStream());OutputStream out=raw.getOutputStream();
                    if(in.readUnsignedByte()!=5)throw new IOException();int methods=in.readUnsignedByte();for(int i=0;i<methods;i++)in.readUnsignedByte();out.write(new byte[]{5,0});out.flush();
                    if(in.readUnsignedByte()!=5 || in.readUnsignedByte()!=1)throw new IOException();in.readUnsignedByte();int type=in.readUnsignedByte();
                    int length=type==3?in.readUnsignedByte():type==1?4:16;for(int i=0;i<length;i++)in.readUnsignedByte();in.readUnsignedShort();
                    out.write(new byte[]{5,0,0,1,127,0,0,1,0,80});out.flush();
                    if(stall){while(in.read()!=-1){}return;}
                    SSLSocket tls=(SSLSocket)serverContext.getSocketFactory().createSocket(raw,"localhost",raw.getPort(),false);tls.setUseClientMode(false);tls.setSoTimeout(2000);tls.startHandshake();
                    BufferedReader reader=new BufferedReader(new InputStreamReader(tls.getInputStream(),StandardCharsets.US_ASCII));requestLine=reader.readLine();
                    for(String s;(s=reader.readLine())!=null && !s.isEmpty();){}
                    OutputStream response=tls.getOutputStream();response.write("HTTP/1.1 200 OK\r\nContent-Length: 262144\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));response.write(payload(262144));response.flush();
                }catch(Exception expectedByNegativeCases){}
            },"isolated-socks-server");thread.setDaemon(true);thread.start();
        }
        public void close()throws Exception {listen.close();if(connection!=null)connection.close();thread.join(1500);}
    }
    static void transportTests(Path dir)throws Exception {
        char[] pass=new String(Files.readAllBytes(dir.resolve("password")),StandardCharsets.UTF_8).trim().toCharArray();
        SSLContext trusted=context(null,dir.resolve("trust.p12"),pass), system=context(null,null,pass);
        SSLContext matching=context(dir.resolve("matching.p12"),null,pass), wrong=context(dir.resolve("wrong.p12"),null,pass);
        SSLContext.setDefault(trusted);
        YoutubeFailover.Config c=new YoutubeFailover.Config();c.probeTimeoutMs=2000;c.connectTimeoutMs=1500;c.readTimeoutMs=1500;
        try(SocksServer s=new SocksServer(matching,false)) {
            YoutubeFailover.Probe r=YoutubeFailover.httpsProbe(c,new YoutubeFailover.Candidate("test",s.listen.getLocalPort(),null),false);
            check(r.ok && r.bytes==262144,"real local SOCKS TLS HTTP succeeds");check(s.accepted==1,"one attempt only");
            check("GET /__down?bytes=262144 HTTP/1.1".equals(s.requestLine),"production request target");
        }
        try(SocksServer s=new SocksServer(wrong,false)) {
            YoutubeFailover.Probe r=YoutubeFailover.httpsProbe(c,new YoutubeFailover.Candidate("test",s.listen.getLocalPort(),null),false);
            check(!r.ok && "SSLHandshakeException".equals(r.error),"trusted wrong hostname rejected");
        }
        SSLContext.setDefault(system);
        try(SocksServer s=new SocksServer(matching,false)) {
            YoutubeFailover.Probe r=YoutubeFailover.httpsProbe(c,new YoutubeFailover.Candidate("test",s.listen.getLocalPort(),null),false);
            check(!r.ok && "SSLHandshakeException".equals(r.error),"untrusted certificate rejected");
        }
        SSLContext.setDefault(trusted);
        try(SocksServer s=new SocksServer(matching,true)) {
            c.probeTimeoutMs=250;
            YoutubeFailover.Probe r=YoutubeFailover.httpsProbe(c,new YoutubeFailover.Candidate("test",s.listen.getLocalPort(),null),false);
            check(!r.ok && "DeadlineExceeded".equals(r.error),"overall deadline covers stalled handshake");
            check(r.elapsedMs>=200 && r.elapsedMs<1000,"deadline prompt cancellation");check(s.accepted==1,"timeout no retry");
        }
    }
    public static void main(String[] args)throws Exception {
        parserTests();transportTests(Paths.get(args[0]));
        System.out.println("PASS "+checks+" isolated checks; no device or production access");
    }
}
