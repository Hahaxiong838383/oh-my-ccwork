#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/types.h>
#include <stddef.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/wait.h>
/* Replay the observed Android bionic connect side effect while using actual
 * loopback UDP for connect/send/recv. Only SO_MARK is emulated; no privilege. */
static unsigned emulated_mark, observed_send_mark;
static int connect_rewrites, mark_writes, send_calls, discard_second_mark;
static int replay_setsockopt(int, int, int, const void *, socklen_t);
static int replay_getsockopt(int, int, int, void *, socklen_t *);
static int replay_connect(int, const struct sockaddr *, socklen_t);
static ssize_t replay_send(int, const void *, size_t, int);
#define setsockopt replay_setsockopt
#define getsockopt replay_getsockopt
#define connect replay_connect
#define send replay_send
#define VIDEO_BOOT_NET_TEST
#include "video-boot-net.c"
#undef setsockopt
#undef getsockopt
#undef connect
#undef send
static int replay_setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
    if(level==SOL_SOCKET && option==SO_MARK) {
        if(length!=sizeof(unsigned)){errno=EINVAL;return -1;}
        mark_writes++;
        if(!(discard_second_mark && mark_writes==2))memcpy(&emulated_mark,value,sizeof(unsigned));
        return 0;
    }
    return setsockopt(fd,level,option,value,length);
}
static int replay_getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
    if(level==SOL_SOCKET && option==SO_MARK) {
        if(*length<sizeof(unsigned)){errno=EINVAL;return -1;}
        memcpy(value,&emulated_mark,sizeof(unsigned));*length=sizeof(unsigned);return 0;
    }
    return getsockopt(fd,level,option,value,length);
}
static int replay_connect(int fd,const struct sockaddr *a,socklen_t n) {
    int rc=connect(fd,a,n);
    if(!rc){emulated_mark=786533;connect_rewrites++;}
    return rc;
}
static ssize_t replay_send(int fd,const void *p,size_t n,int flags) {
    send_calls++;observed_send_mark=emulated_mark;
    return send(fd,p,n,flags);
}
#define CHECK(label, cond) do { if(!(cond)){fprintf(stderr,"FAIL: %s\n",label);exit(1);}printf("PASS: %s\n",label); } while(0)
static int listener(unsigned *port) {
    int fd=socket(AF_INET,SOCK_DGRAM,0);if(fd<0)exit(2);
    struct sockaddr_in a={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    if(bind(fd,(struct sockaddr*)&a,sizeof(a)))exit(2);
    socklen_t n=sizeof(a);if(getsockname(fd,(struct sockaddr*)&a,&n))exit(2);
    *port=ntohs(a.sin_port);return fd;
}
int main(void) {
    unsigned port;int fd=listener(&port);pid_t pid=fork();if(pid<0)exit(2);
    if(!pid){
        unsigned char b[512];struct sockaddr_in a;socklen_t alen=sizeof(a);
        struct timeval timeout={.tv_sec=2};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
        ssize_t n=recvfrom(fd,b,sizeof(b),0,(struct sockaddr*)&a,&alen);if(n<12 || n>490)_exit(2);
        put16(b+2,0x8180);put16(b+6,1);size_t p=(size_t)n;
        const unsigned char answer[]={0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,1,1,1,1};
        memcpy(b+p,answer,sizeof(answer));p+=sizeof(answer);
        if(sendto(fd,b,p,0,(struct sockaddr*)&a,alen)!=(ssize_t)p)_exit(2);
        close(fd);_exit(0);
    }
    close(fd);struct in_addr ip;
    int rc=dns_query("www.youtube.com","127.0.0.1",port,NULL,255,mono_ms()+QUERY_MS,&ip,1);
    int status;waitpid(pid,&status,0);
    CHECK("mark replay real UDP responder completed",WIFEXITED(status)&&!WEXITSTATUS(status));
    CHECK("mark replay overwrites SO_MARK during connect",connect_rewrites==1);
    CHECK("mark replay DNS succeeds after overwrite",rc==1 && ntohl(ip.s_addr)==0x01010101);
    CHECK("mark replay actual send observed required mark",send_calls==1 && observed_send_mark==255);
    /* Negative: kernel ignores the post-connect write. Probe must refuse to
     * send rather than silently use an unexpected routing mark. */
    emulated_mark=observed_send_mark=0;connect_rewrites=mark_writes=send_calls=0;discard_second_mark=1;
    fd=listener(&port);
    rc=dns_query("www.youtube.com","127.0.0.1",port,NULL,255,mono_ms()+QUERY_MS,&ip,1);
    close(fd);
    CHECK("mark readback failure is rejected",rc<0 && emulated_mark==786533);
    CHECK("mark readback failure sends no packet",send_calls==0);
    puts("MARK OVERWRITE REPLAY PASSED (observed Android mark=786533)");return 0;
}
