import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.util.*;
import javax.net.ssl.*;
import org.json.*;
public final class IpIdentityTest {
 static int checks;
 static void check(boolean b,String name){if(!b)throw new AssertionError(name);checks++;System.out.println("PASS "+name);}
 static SSLContext context(Path key,Path trust,char[] pass)throws Exception{
  KeyManager[] km=null;TrustManager[] tm=null;
  if(key!=null){KeyStore ks=KeyStore.getInstance("PKCS12");try(InputStream in=Files.newInputStream(key)){ks.load(in,pass);}KeyManagerFactory f=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());f.init(ks,pass);km=f.getKeyManagers();}
  if(trust!=null){KeyStore ks=KeyStore.getInstance("PKCS12");try(InputStream in=Files.newInputStream(trust)){ks.load(in,pass);}TrustManagerFactory f=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());f.init(ks);tm=f.getTrustManagers();}
  SSLContext context=SSLContext.getInstance("TLS");context.init(km,tm,null);return context;
 }
 static final class Endpoint implements AutoCloseable{
  final ServerSocket listen;final Thread thread;volatile Socket raw;volatile List<SNIServerName> sni;volatile String dest;volatile int destPort;
  Endpoint(SSLContext server)throws Exception{
   listen=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"));
   thread=new Thread(()->{try(Socket sock=listen.accept()){
    raw=sock;sock.setSoTimeout(2000);DataInputStream in=new DataInputStream(sock.getInputStream());OutputStream out=sock.getOutputStream();if(in.readUnsignedByte()!=5)throw new IOException();int n=in.readUnsignedByte();while(n-->0)in.readByte();out.write(new byte[]{5,0});out.flush();
    in.readByte();in.readByte();in.readByte();int atyp=in.readUnsignedByte();n=atyp==3?in.readUnsignedByte():atyp==1?4:16;byte[] addr=new byte[n];in.readFully(addr);dest=atyp==3?new String(addr,StandardCharsets.US_ASCII):InetAddress.getByAddress(addr).getHostAddress();destPort=in.readUnsignedShort();out.write(new byte[]{5,0,0,1,127,0,0,1,0,80});out.flush();
    SSLSocket tls=(SSLSocket)server.getSocketFactory().createSocket(sock,"localhost",sock.getPort(),false);tls.setUseClientMode(false);tls.setSoTimeout(2000);tls.startHandshake();sni=((ExtendedSSLSession)tls.getSession()).getRequestedServerNames();
    DataInputStream din=new DataInputStream(tls.getInputStream());int len=din.readUnsignedShort();byte[] q=new byte[len];din.readFully(q);YoutubeFailover.put16(q,2,0x8180);YoutubeFailover.put16(q,6,1);ByteArrayOutputStream reply=new ByteArrayOutputStream();reply.write(q);reply.write(new byte[]{(byte)0xc0,12,0,1,0,1,0,0,0,60,0,4,1,1,1,1});DataOutputStream dout=new DataOutputStream(tls.getOutputStream());dout.writeShort(reply.size());reply.writeTo(dout);dout.flush();
   }catch(Exception expected){}},"ip-san-socks-tls");thread.setDaemon(true);thread.start();
  }
  public void close()throws Exception{listen.close();if(raw!=null)raw.close();thread.join(1000);}
 }
 public static void main(String[] args)throws Exception{
  Path root=Paths.get(args[0]);char[] pass=new String(Files.readAllBytes(root.resolve("password")),StandardCharsets.UTF_8).trim().toCharArray();
  JSONObject config=new JSONObject(new String(Files.readAllBytes(Paths.get(args[1])),StandardCharsets.UTF_8));config.getJSONObject("dns").put("server_name","1.1.1.1");Path parsed=root.resolve("ip-config.json");Files.write(parsed,config.toString().getBytes(StandardCharsets.UTF_8));YoutubeFailover.Config loaded=YoutubeFailover.Config.load(parsed.toString());check("1.1.1.1".equals(loaded.dnsName),"Config.load preserves numeric TLS identity");check("1.1.1.1".equals(loaded.dnsIp),"numeric dial IP unchanged");
  SSLContext.setDefault(context(null,root.resolve("trust.p12"),pass));loaded.probeTimeoutMs=2000;loaded.connectTimeoutMs=1500;loaded.readTimeoutMs=1500;
  try(Endpoint endpoint=new Endpoint(context(root.resolve("correct.p12"),null,pass))){YoutubeFailover.Probe p=YoutubeFailover.dotProbe(loaded,new YoutubeFailover.Candidate("test",endpoint.listen.getLocalPort(),null));check(p.ok,"real DoT with matching IP SAN succeeds");check(endpoint.sni!=null&&endpoint.sni.isEmpty(),"numeric TLS identity sends no SNI on JVM");check("1.1.1.1".equals(endpoint.dest)&&endpoint.destPort==853,"SOCKS request remains numeric 1.1.1.1:853");}
  try(Endpoint endpoint=new Endpoint(context(root.resolve("wrong.p12"),null,pass))){YoutubeFailover.Probe p=YoutubeFailover.dotProbe(loaded,new YoutubeFailover.Candidate("test",endpoint.listen.getLocalPort(),null));check(!p.ok&&"SSLHandshakeException".equals(p.error),"trusted wrong IP SAN rejected");}
  try(Endpoint endpoint=new Endpoint(context(root.resolve("domain.p12"),null,pass))){YoutubeFailover.Probe p=YoutubeFailover.dotProbe(loaded,new YoutubeFailover.Candidate("test",endpoint.listen.getLocalPort(),null));check(!p.ok&&"SSLHandshakeException".equals(p.error),"trusted DNS-only SAN cannot substitute IP SAN");}
  System.out.println("PASS "+checks+" exact numeric-TLS-identity checks; no device or public network I/O");
 }
}
