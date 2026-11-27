/* Android/Linux. List only by default when invoked as "check IP". Purge
 * invalidates DNS translations for this TV and the retired resolver. The
 * kernel matches the original tuple and conntrack ID on delete, protecting a
 * socket that reuses the tuple between the dump and deletion. */
#include <arpa/inet.h>
#include <errno.h>
#include <linux/netfilter/nfnetlink.h>
#include <linux/netfilter/nfnetlink_conntrack.h>
#include <linux/netlink.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

struct request {
    struct nlmsghdr h;
    struct nfgenmsg gen;
    unsigned char attrs[512];
};
union packet {
    struct nlmsghdr header;
    unsigned char buf[65536];
};

static const struct nlattr *attr(const void *data, size_t len, unsigned type) {
    const unsigned char *p = data;
    while (len >= NLA_HDRLEN) {
        const struct nlattr *a = (const struct nlattr *)p;
        if (a->nla_len < NLA_HDRLEN || a->nla_len > len) break;
        if ((a->nla_type & NLA_TYPE_MASK) == type) return a;
        size_t used = NLA_ALIGN(a->nla_len);
        if (used > len) break;
        p += used;
        len -= used;
    }
    return NULL;
}
static const struct nlattr *nested(const struct nlattr *a, unsigned type) {
    return a ? attr((const char *)a + NLA_HDRLEN, a->nla_len - NLA_HDRLEN, type) : NULL;
}
static bool eq(const struct nlattr *a, const void *v, size_t n) {
    return a && a->nla_len == NLA_HDRLEN+n && !memcmp((const char *)a+NLA_HDRLEN,v,n);
}
static bool match(const struct nlattr *orig, const struct nlattr *reply,
                  const struct in_addr *tv, const struct in_addr *old) {
    const struct nlattr *oip = nested(orig,CTA_TUPLE_IP), *rip = nested(reply,CTA_TUPLE_IP);
    const struct nlattr *op = nested(orig,CTA_TUPLE_PROTO), *rp = nested(reply,CTA_TUPLE_PROTO);
    uint16_t dns = htons(53);
    uint8_t tcp = IPPROTO_TCP, udp = IPPROTO_UDP;
    return eq(nested(oip,CTA_IP_V4_SRC),tv,4) && eq(nested(rip,CTA_IP_V4_SRC),old,4)
        && eq(nested(rip,CTA_IP_V4_DST),tv,4) && eq(nested(op,CTA_PROTO_DST_PORT),&dns,2)
        && eq(nested(rp,CTA_PROTO_SRC_PORT),&dns,2)
        && ((eq(nested(op,CTA_PROTO_NUM),&tcp,1) && eq(nested(rp,CTA_PROTO_NUM),&tcp,1))
            || (eq(nested(op,CTA_PROTO_NUM),&udp,1) && eq(nested(rp,CTA_PROTO_NUM),&udp,1)));
}
static int channel(void) {
    int fd = socket(AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_NETFILTER);
    if (fd < 0) return -1;
    struct sockaddr_nl nl = {.nl_family=AF_NETLINK};
    struct timeval timeout = {.tv_sec=2};
    if (bind(fd,(void *)&nl,sizeof(nl)) || connect(fd,(void *)&nl,sizeof(nl))
        || setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout))) {
        close(fd); return -1;
    }
    return fd;
}
static struct request request(unsigned type, unsigned flags, unsigned seq) {
    struct request r = {0};
    r.h.nlmsg_len = NLMSG_LENGTH(sizeof(r.gen));
    r.h.nlmsg_type = (NFNL_SUBSYS_CTNETLINK<<8)|type;
    r.h.nlmsg_flags = NLM_F_REQUEST|flags;
    r.h.nlmsg_seq = seq;
    r.gen.nfgen_family = AF_INET;
    return r;
}
static bool append(struct request *r, const struct nlattr *a) {
    if (!a) return false;
    size_t start = NLMSG_ALIGN(r->h.nlmsg_len), n = NLA_ALIGN(a->nla_len);
    if (start+n > sizeof(*r)) return false;
    memcpy((char *)r+start,a,a->nla_len);
    r->h.nlmsg_len = start+n;
    return true;
}
static int remove_one(int fd, const struct nlattr *orig, const struct nlattr *id,
                      const struct nlattr *zone, unsigned seq) {
    struct request r = request(IPCTNL_MSG_CT_DELETE,NLM_F_ACK,seq);
    if (!id || id->nla_len != NLA_HDRLEN+4 || !append(&r,orig) || !append(&r,id)
        || (zone && !append(&r,zone))) { errno=EPROTO; return -1; }
    if (send(fd,&r,r.h.nlmsg_len,0) != (ssize_t)r.h.nlmsg_len) return -1;
    union packet response;
    ssize_t nr = recv(fd,response.buf,sizeof(response.buf),0);
    if (nr < 0) return -1;
    const struct nlmsghdr *h=&response.header;
    if (!NLMSG_OK(h,(unsigned)nr) || h->nlmsg_seq != seq || h->nlmsg_type != NLMSG_ERROR ||
        h->nlmsg_len < NLMSG_LENGTH(sizeof(struct nlmsgerr))) { errno=EPROTO; return -1; }
    int error=((struct nlmsgerr *)NLMSG_DATA(h))->error;
    if (!error || error == -ENOENT) return 0;
    errno=-error; return -1;
}
/* Refuse truncated, interrupted or malformed dumps instead of reporting an
 * incomplete scan as clean. An expired object is harmless during deletion. */
static int scan(int dump, int del, const struct in_addr *tv, const struct in_addr *old,
                bool purge, unsigned seq) {
    struct request r=request(IPCTNL_MSG_CT_GET,NLM_F_DUMP,seq);
    if (send(dump,&r,r.h.nlmsg_len,0) != (ssize_t)r.h.nlmsg_len) return -1;
    int matches=0;
    for (;;) {
        union packet response;
        ssize_t nr=recv(dump,response.buf,sizeof(response.buf),MSG_TRUNC);
        if (nr < 0) return -1;
        if (!nr || (size_t)nr > sizeof(response.buf)) { errno=EMSGSIZE; return -1; }
        int remaining=(int)nr;
        for (struct nlmsghdr *h=&response.header; remaining > 0 && NLMSG_OK(h,(unsigned)remaining); h=NLMSG_NEXT(h,remaining)) {
            if (h->nlmsg_seq != seq || (h->nlmsg_flags & NLM_F_DUMP_INTR)) { errno=EINTR; return -1; }
            if (h->nlmsg_type == NLMSG_DONE) {
                int status=0;
                if (h->nlmsg_len >= NLMSG_LENGTH(sizeof(status))) memcpy(&status,NLMSG_DATA(h),sizeof(status));
                if (status) { errno=status<0?-status:EPROTO; return -1; }
                return matches;
            }
            if (h->nlmsg_type == NLMSG_ERROR) {
                if (h->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr))) errno=-((struct nlmsgerr *)NLMSG_DATA(h))->error;
                else errno=EPROTO;
                return -1;
            }
            if (h->nlmsg_type != ((NFNL_SUBSYS_CTNETLINK<<8)|IPCTNL_MSG_CT_NEW) ||
                h->nlmsg_len < NLMSG_LENGTH(sizeof(struct nfgenmsg))) { errno=EPROTO; return -1; }
            const struct nfgenmsg *gen=NLMSG_DATA(h);
            if (gen->nfgen_family != AF_INET) continue;
            const char *data=(const char *)gen+NLMSG_ALIGN(sizeof(*gen));
            size_t len=h->nlmsg_len-NLMSG_LENGTH(sizeof(*gen));
            const struct nlattr *orig=attr(data,len,CTA_TUPLE_ORIG);
            if (match(orig,attr(data,len,CTA_TUPLE_REPLY),tv,old)) {
                ++matches;
                if (purge && remove_one(del,orig,attr(data,len,CTA_ID),attr(data,len,CTA_ZONE),matches)) return -1;
            }
        }
        if (remaining) { errno=EPROTO; return -1; }
    }
}
int main(int argc,char **argv) {
    if (argc!=3 || (strcmp(argv[1],"purge") && strcmp(argv[1],"check"))
        || (strcmp(argv[2],"192.168.1.19") && strcmp(argv[2],"192.168.1.254"))) return 2;
    struct in_addr tv,old;
    inet_pton(AF_INET,"192.168.1.144",&tv);
    inet_pton(AF_INET,argv[2],&old);
    int dump=channel(), del=channel();
    if (dump<0 || del<0) { perror("conntrack socket"); return 2; }
    bool purge=!strcmp(argv[1],"purge");
    int n=scan(dump,del,&tv,&old,purge,1);
    if (n<0) { perror("conntrack scan"); return 2; }
    if (purge && n) n=scan(dump,del,&tv,&old,false,2);
    if (n<0) { perror("conntrack verification"); return 2; }
    if (n) fprintf(stderr,"matching stale DNS flows: %d\n",n);
    return n?1:0;
}
