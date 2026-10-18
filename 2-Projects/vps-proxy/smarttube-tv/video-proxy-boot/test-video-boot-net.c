#define VIDEO_BOOT_NET_TEST
#include "video-boot-net.c"
#include <sys/wait.h>
#define CHECK(label, cond) do { if (!(cond)) { fprintf(stderr, "FAIL: %s (line %d)\n", label, __LINE__); exit(1); } printf("PASS: %s\n", label); } while (0)

struct stderr_capture { int pipefd[2], saved; };
static struct stderr_capture capture_begin(void) {
    struct stderr_capture c;
    if (pipe(c.pipefd)) exit(2);
    fflush(stderr); c.saved=dup(STDERR_FILENO);
    if (c.saved<0 || dup2(c.pipefd[1],STDERR_FILENO)<0) exit(2);
    return c;
}
static void capture_end(struct stderr_capture c, char *out, size_t cap) {
    fflush(stderr);
    if(dup2(c.saved,STDERR_FILENO)<0)exit(2);
    close(c.saved);close(c.pipefd[1]);
    size_t used=0;ssize_t n;
    while(used+1<cap && (n=read(c.pipefd[0],out+used,cap-used-1))>0)used+=(size_t)n;
    out[used]=0;close(c.pipefd[0]);
}
static void put32(unsigned char *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static int dns_reply(unsigned char *buf, size_t query_len) {
    put16(buf + 2, 0x8180); put16(buf + 6, 1);
    size_t p = query_len;
    buf[p++] = 0xc0; buf[p++] = 12; put16(buf + p, 1); p += 2; put16(buf + p, 1); p += 2;
    put32(buf + p, 60); p += 4; put16(buf + p, 4); p += 2;
    buf[p++] = 1; buf[p++] = 1; buf[p++] = 1; buf[p++] = 1;
    return (int)p;
}
static void ntp_reply(unsigned char *buf, const unsigned char nonce[8]) {
    memset(buf, 0, 48); buf[0] = 0x24; buf[1] = 2;
    memcpy(buf + 24, nonce, 8);
    put32(buf + 32, (uint32_t)(EPOCH_MIN + NTP_OFFSET + 500));
    put32(buf + 40, (uint32_t)(EPOCH_MIN + NTP_OFFSET + 500));
}
static void parse_tests(void) {
    unsigned char good[512], work[512]; uint16_t id;
    int q = dns_request("www.youtube.com", good, sizeof(good), &id);
    CHECK("DNS request built", q > 0);
    int n = dns_reply(good, (size_t)q); struct in_addr ips[4];
    CHECK("valid DNS A response", dns_parse(good, n, id, "www.youtube.com", ips, 4) == 1 && ntohl(ips[0].s_addr) == 0x01010101);
    CHECK("DNS truncated header rejected", dns_parse(good, 11, id, "www.youtube.com", ips, 4) < 0);
    CHECK("DNS truncated RDATA rejected", dns_parse(good, n - 1, id, "www.youtube.com", ips, 4) < 0);
    CHECK("DNS ID mismatch rejected", dns_parse(good, n, id ^ 1, "www.youtube.com", ips, 4) < 0);
    CHECK("DNS question mismatch rejected", dns_parse(good, n, id, "other.example", ips, 4) < 0);
    memcpy(work, good, n); put16(work + 2, 0x0180);
    CHECK("DNS missing QR rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); put16(work + 2, 0x8380);
    CHECK("DNS truncation bit rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); put16(work + 2, 0x8183);
    CHECK("DNS NXDOMAIN rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); put16(work + q - 4, 28);
    CHECK("DNS wrong QTYPE rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); work[q + 1] = (unsigned char)q;
    CHECK("DNS compression self-cycle rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); work[q + 1] = (unsigned char)(q + 3);
    CHECK("DNS forward compression pointer rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); work[12] = 0x80;
    CHECK("DNS reserved label prefix rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); work[12] = 63;
    CHECK("DNS truncated label rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); put16(work + q + 10, 5);
    CHECK("DNS incorrect A length rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    memcpy(work, good, n); memset(work + n - 4, 0, 4);
    CHECK("DNS unusable zero address rejected", dns_parse(work, n, id, "www.youtube.com", ips, 4) < 0);
    CHECK("DNS hostname shell metacharacters rejected", !valid_host("www.youtube.com;echo"));
    /* CNAME then address under the canonical owner, wire pointers included. */
    memcpy(work, good, q); put16(work + 6, 2); size_t p = q;
    work[p++] = 0xc0; work[p++] = 12; put16(work+p,5); p+=2; put16(work+p,1); p+=2; put32(work+p,60);p+=4;put16(work+p,8);p+=2;
    size_t canonical = p; work[p++]=5;memcpy(work+p,"alias",5);p+=5;work[p++]=0xc0;work[p++]=16;
    work[p++]=0xc0;work[p++]=(unsigned char)canonical;put16(work+p,1);p+=2;put16(work+p,1);p+=2;put32(work+p,60);p+=4;put16(work+p,4);p+=2;
    memset(work+p,1,4);p+=4;
    CHECK("DNS compressed CNAME chain accepted", dns_parse(work,p,id,"www.youtube.com",ips,4)==1);
    unsigned char nonce[8] = {1,2,3,4,5,6,7,8}; double epoch;
    ntp_reply(good, nonce);
    CHECK("valid NTP response", !ntp_parse(good,48,nonce,100,&epoch) && epoch > EPOCH_MIN + 500 && epoch < EPOCH_MIN + 501);
    CHECK("NTP truncated response rejected", ntp_parse(good,47,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[0]|=0xc0;
    CHECK("NTP unsynchronized LI rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[0]=0x23;
    CHECK("NTP reflected client mode rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[0]=0x14;
    CHECK("NTP old version rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[1]=0;
    CHECK("NTP KoD stratum rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[1]=16;
    CHECK("NTP invalid stratum rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);work[24]^=1;
    CHECK("NTP incorrect origin nonce rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);put32(work+32,(uint32_t)(EPOCH_MIN+NTP_OFFSET-1));
    CHECK("NTP out-of-range old time rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    memcpy(work,good,48);put32(work+40,(uint32_t)(EPOCH_MAX+NTP_OFFSET));
    CHECK("NTP out-of-range future time rejected", ntp_parse(work,48,nonce,100,&epoch)<0);
    CHECK("NTP excessive monotonic RTT rejected", ntp_parse(good,48,nonce,3001,&epoch)<0);
    CHECK("NTP negative monotonic RTT rejected", ntp_parse(good,48,nonce,-1,&epoch)<0);
    struct time_sample samples[2] = {0}; uint64_t result;
    inet_pton(AF_INET,"1.1.1.1",&samples[0].ip); inet_pton(AF_INET,"2.2.2.2",&samples[1].ip);
    samples[0].epoch=EPOCH_MIN+100; samples[0].received_ms=1000;
    samples[1].epoch=EPOCH_MIN+110; samples[1].received_ms=11000;
    CHECK("two-source consensus adjusts serial sample time", !consensus(samples,2,12000,&result) && result==EPOCH_MIN+111);
    samples[1].epoch+=4;
    CHECK("two-source disagreement rejected", consensus(samples,2,12000,&result)<0);
    samples[1].epoch-=4; samples[1].ip=samples[0].ip;
    CHECK("duplicate IP cannot provide consensus", consensus(samples,2,12000,&result)<0);
    CHECK("single source cannot provide consensus", consensus(samples,1,12000,&result)<0);
}
/* Real local UDP sockets exercise exchange+parser, with no external network. */
static int server(unsigned *port) {
    int fd=socket(AF_INET,SOCK_DGRAM,0); if(fd<0)exit(2);
    struct sockaddr_in a={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    if(bind(fd,(struct sockaddr*)&a,sizeof(a)))exit(2);
    socklen_t n=sizeof(a); if(getsockname(fd,(struct sockaddr*)&a,&n))exit(2);
    *port=ntohs(a.sin_port); return fd;
}
static void socket_case(int ntp, int bad) {
    unsigned port; int fd=server(&port); pid_t pid=fork(); if(pid<0)exit(2);
    if(pid==0) {
        unsigned char b[512]; struct sockaddr_in client; socklen_t clen=sizeof(client);
        struct timeval tv={.tv_sec=2}; setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&tv,sizeof(tv));
        ssize_t n=recvfrom(fd,b,sizeof(b),0,(struct sockaddr*)&client,&clen); if(n<0)_exit(2);
        if(ntp) { unsigned char nonce[8];memcpy(nonce,b+40,8);ntp_reply(b,nonce);n=48;if(bad)b[24]^=1; }
        else { n=dns_reply(b,(size_t)n);if(bad)put16(b+2,0x8182); }
        if(sendto(fd,b,(size_t)n,0,(struct sockaddr*)&client,clen)!=n)_exit(2);
        close(fd);_exit(0);
    }
    close(fd); int rc; char diagnostics[4096]; struct stderr_capture capture=capture_begin();
    if(ntp) {struct time_sample s;rc=ntp_query("127.0.0.1",port,NULL,0,mono_ms()+QUERY_MS,&s);}
    else {struct in_addr ips[4];rc=dns_query("www.youtube.com","127.0.0.1",port,NULL,0,mono_ms()+QUERY_MS,ips,4);}
    capture_end(capture,diagnostics,sizeof(diagnostics));
    if(bad) CHECK(ntp?"NTP rejection classified in actual stderr":"DNS rejection classified in actual stderr",strstr(diagnostics,ntp?"stage=ntp_parse errno=":"stage=dns_parse errno=") && strstr(diagnostics,"server=127.0.0.1"));
    else CHECK("successful local query emits no error diagnostics",diagnostics[0]==0);
    int status;waitpid(pid,&status,0);
    CHECK("local UDP responder completed",WIFEXITED(status)&&WEXITSTATUS(status)==0);
    if(ntp) CHECK(bad?"local UDP fake NTP nonce rejected":"local UDP valid NTP accepted", bad?rc<0:rc==0);
    else CHECK(bad?"local UDP DNS SERVFAIL rejected":"local UDP valid DNS accepted", bad?rc<0:rc>0);
}
static void deadline_tests(void) {
    unsigned port; int fd=server(&port); struct time_sample sample;
    char diagnostics[4096]; struct stderr_capture capture=capture_begin();
    int64_t before=mono_ms();
    int rc=ntp_query("127.0.0.1",port,NULL,0,before+120,&sample);
    int64_t elapsed=mono_ms()-before;close(fd);
    capture_end(capture,diagnostics,sizeof(diagnostics));
    CHECK("silent UDP classified as poll timeout",strstr(diagnostics,"stage=poll_timeout errno=110"));
    CHECK("silent UDP responder deadline rejects",rc<0 && elapsed>=100 && elapsed<1000);
    struct in_addr ip;capture=capture_begin();
    rc=dns_query("www.youtube.com","127.0.0.1",53,NULL,0,mono_ms()-1,&ip,1);
    capture_end(capture,diagnostics,sizeof(diagnostics));
    CHECK("expired deadline has distinct classification",strstr(diagnostics,"stage=deadline_expired errno=110"));
    CHECK("already expired DNS deadline rejects",rc<0);
    capture=capture_begin();
    rc=dns_query("www.youtube.com","127.0.0.1",53,"vboot-noexist",0,mono_ms()+1000,&ip,1);
    capture_end(capture,diagnostics,sizeof(diagnostics));
    CHECK("missing interface fails before sending",rc<0);
    CHECK("missing interface classified as setsockopt",strstr(diagnostics,"stage=setsockopt_bindtodevice errno="));
    capture=capture_begin();
    rc=time_probe("vboot-noexist");
    capture_end(capture,diagnostics,sizeof(diagnostics));
    CHECK("time failure is nonzero",rc!=0);
    CHECK("time failure counts actual DNS and NTP attempts",strstr(diagnostics,"TIME_FAIL reason=no_consensus dns_valid=0 dns_attempts=6 ntp_valid=0 ntp_attempts=0"));
}
int main(void) {
    parse_tests(); socket_case(0,0);socket_case(0,1);socket_case(1,0);socket_case(1,1);deadline_tests();
    puts("ALL TESTS PASSED (parser and real local UDP negative paths)");return 0;
}
