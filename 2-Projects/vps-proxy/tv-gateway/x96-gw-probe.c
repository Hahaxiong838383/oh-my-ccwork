/* ARMv7 Android. Test the selected LAN gateway directly, independently of the current default. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define DNS_NAME "i.ytimg.com"
#define HTTP_HOST "connectivitycheck.gstatic.com"
#define PROBE_MARK 0x40000000U
#define DEADLINE_MS 4000

struct probe {
    struct in_addr gateway;
    int proxy_port;
    int64_t deadline;
    const char *dns_result;
};

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static bool wait_fd(int fd, short events, int64_t deadline) {
    struct pollfd p = {.fd = fd, .events = events};
    for (;;) {
        int remaining = (int)(deadline - now_ms());
        if (remaining <= 0) return false;
        int n = poll(&p, 1, remaining);
        if (n >= 0) return n == 1 && (p.revents & events);
        if (errno != EINTR) return false;
    }
}

static bool dial(int fd, struct in_addr gateway, int port, int64_t deadline) {
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(port), .sin_addr = gateway};
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) return true;
    if (errno != EINPROGRESS || !wait_fd(fd, POLLOUT, deadline)) return false;
    int error = 0;
    socklen_t len = sizeof(error);
    return getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len) == 0 && error == 0;
}

static bool transfer(int fd, void *data, size_t size, bool writing, int64_t deadline) {
    unsigned char *p = data;
    while (size) {
        if (!wait_fd(fd, writing ? POLLOUT : POLLIN, deadline)) return false;
        ssize_t n = writing ? send(fd, p, size, MSG_NOSIGNAL) : recv(fd, p, size, 0);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
        if (n <= 0) return false;
        p += n;
        size -= (size_t)n;
    }
    return true;
}

static bool valid_dns(const unsigned char *buf, size_t len, uint16_t id) {
    ns_msg msg;
    ns_rr rr;
    if (ns_initparse(buf, (int)len, &msg) || ns_msg_id(msg) != id ||
        !ns_msg_getflag(msg, ns_f_qr) || ns_msg_getflag(msg, ns_f_tc) ||
        ns_msg_getflag(msg, ns_f_opcode) != ns_o_query || ns_msg_getflag(msg, ns_f_rcode) != ns_r_noerror ||
        ns_msg_count(msg, ns_s_qd) != 1 || ns_parserr(&msg, ns_s_qd, 0, &rr) ||
        strcasecmp(ns_rr_name(rr), DNS_NAME) || ns_rr_type(rr) != ns_t_a || ns_rr_class(rr) != ns_c_in) return false;

    char owner[NS_MAXDNAME] = DNS_NAME;
    for (int hop = 0; hop < 10; ++hop) {
        char alias[NS_MAXDNAME] = "";
        for (int i = 0; i < ns_msg_count(msg, ns_s_an); ++i) {
            if (ns_parserr(&msg, ns_s_an, i, &rr)) return false;
            if (ns_rr_class(rr) != ns_c_in || strcasecmp(ns_rr_name(rr), owner)) continue;
            if (ns_rr_type(rr) == ns_t_a && ns_rr_rdlen(rr) == 4) {
                const unsigned char *ip = ns_rr_rdata(rr);
                if (ip[0] && ip[0] < 224 && ip[0] != 127) return true;
            }
            if (ns_rr_type(rr) == ns_t_cname &&
                ns_name_uncompress(buf, buf + len, ns_rr_rdata(rr), alias, sizeof(alias)) < 0) return false;
        }
        if (!alias[0] || !strcasecmp(alias, owner)) return false;
        strcpy(owner, alias);
    }
    return false;
}

static const char *dns_exchange(int fd, const struct probe *probe) {
    /* Without the explicit mark an OUTPUT DNAT could silently test the active gateway twice. */
    uint32_t mark = PROBE_MARK, actual = 0;
    socklen_t length = sizeof(actual);
    if (setsockopt(fd, SOL_SOCKET, SO_MARK, &mark, sizeof(mark))) return "mark_denied";
    if (!dial(fd, probe->gateway, 53, probe->deadline)) return "connect";
    if (getsockopt(fd, SOL_SOCKET, SO_MARK, &actual, &length) || !(actual & mark)) return "mark_lost";

    unsigned char query[] = {0,0, 0,0,1,0,0,1,0,0,0,0,0,0,
                             1,'i',5,'y','t','i','m','g',3,'c','o','m',0,0,1,0,1};
    uint16_t id = (uint16_t)arc4random();
    query[1] = sizeof(query) - 2;
    query[2] = (unsigned char)(id >> 8);
    query[3] = (unsigned char)id;
    unsigned char size[2], reply[4096];
    if (!transfer(fd, query, sizeof(query), true, probe->deadline) ||
        !transfer(fd, size, sizeof(size), false, probe->deadline)) return "io";
    size_t n = (size_t)size[0] * 256 + size[1];
    if (n < 12 || n > sizeof(reply)) return "length";
    if (!transfer(fd, reply, n, false, probe->deadline)) return "io";
    return valid_dns(reply, n, id) ? "ok" : "no_valid_a";
}

static void *dns_worker(void *arg) {
    struct probe *probe = arg;
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    probe->dns_result = fd < 0 ? "socket" : dns_exchange(fd, probe);
    if (fd >= 0) close(fd);
    return NULL;
}

static const char *http_exchange(int fd, const struct probe *probe) {
    if (!dial(fd, probe->gateway, probe->proxy_port, probe->deadline)) return "connect";
    unsigned char greet[] = {5,1,0}, reply[260];
    if (!transfer(fd, greet, sizeof(greet), true, probe->deadline) ||
        !transfer(fd, reply, 2, false, probe->deadline) || reply[0] != 5 || reply[1] != 0) return "socks_greeting";

    unsigned char request[7 + sizeof(HTTP_HOST)-1] = {5,1,0,3,sizeof(HTTP_HOST)-1};
    memcpy(request+5, HTTP_HOST, sizeof(HTTP_HOST)-1);
    request[sizeof(request)-1] = 80;
    if (!transfer(fd, request, sizeof(request), true, probe->deadline) ||
        !transfer(fd, reply, 4, false, probe->deadline) || reply[0] != 5 || reply[1] != 0 || reply[2] != 0)
        return "socks_connect";
    size_t addr_len;
    switch (reply[3]) {
        case 1: addr_len = 4; break;
        case 4: addr_len = 16; break;
        case 3:
            if (!transfer(fd, reply, 1, false, probe->deadline)) return "socks_address";
            addr_len = reply[0]; break;
        default: return "socks_address";
    }
    if (!transfer(fd, reply, addr_len+2, false, probe->deadline)) return "socks_address";
    char get[] = "GET /generate_204 HTTP/1.1\r\nHost: " HTTP_HOST "\r\nConnection: close\r\n\r\n";
    if (!transfer(fd, get, sizeof(get)-1, true, probe->deadline) ||
        !transfer(fd, reply, 13, false, probe->deadline)) return "http_io";
    bool header = !memcmp(reply, "HTTP/1.0 204", 12) || !memcmp(reply, "HTTP/1.1 204", 12);
    return header && (reply[12] == ' ' || reply[12] == '\r') ? "ok" : "http_status";
}

int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "192.168.1.19") && strcmp(argv[1], "192.168.1.254"))) {
        fputs("usage: x96-gw-probe 192.168.1.19|192.168.1.254\n", stderr);
        return 2;
    }
    struct probe probe = {.proxy_port = !strcmp(argv[1],"192.168.1.19") ? 1080 : 1081,
                          .deadline = now_ms() + DEADLINE_MS, .dns_result = "thread"};
    inet_pton(AF_INET, argv[1], &probe.gateway);
    pthread_t thread;
    if (pthread_create(&thread, NULL, dns_worker, &probe)) {
        fputs("dns=thread socks_http=unverified\n", stderr);
        return 1;
    }
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    const char *http = fd < 0 ? "socket" : http_exchange(fd, &probe);
    if (fd >= 0) close(fd);
    pthread_join(thread, NULL);
    printf("gateway=%s dns=%s socks_http=%s\n", argv[1], probe.dns_result, http);
    return strcmp(probe.dns_result, "ok") || strcmp(http, "ok");
}
