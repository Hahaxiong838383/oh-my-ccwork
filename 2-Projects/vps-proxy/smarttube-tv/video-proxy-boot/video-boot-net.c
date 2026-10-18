#define _GNU_SOURCE
/* Query-only bootstrap network probe. Never sets time or changes network state. */
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define DNS_MAX 2048
#define MAX_ANSWERS 32
#define QUERY_MS 3000
#define TIME_TOTAL_MS 29000
#define EPOCH_MIN 1767225600ULL /* 2026-01-01 */
#define EPOCH_MAX 2082758400ULL /* 2036-01-01 exclusive */
#define NTP_OFFSET 2208988800ULL

struct dns_answer { char owner[254], cname[254]; uint16_t type; struct in_addr ip; };
struct time_sample { struct in_addr ip; double epoch; int64_t received_ms; };

static int64_t mono_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static uint16_t u16(const unsigned char *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t u32(const unsigned char *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static void put16(unsigned char *p, uint16_t v) { p[0] = (unsigned char)(v >> 8); p[1] = (unsigned char)v; }
static int random_bytes(void *buf, size_t n) {
    size_t done = 0;
    while (done < n) {
        ssize_t r = getrandom((char *)buf + done, n - done, GRND_NONBLOCK);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        done += (size_t)r;
    }
    return 0;
}
/* Only fixed stage names, errno, numeric peer IP and port are logged. */
static int diag_failure(const char *stage, int error, const char *ip, unsigned port) {
    struct in_addr address;
    const char *safe_ip = inet_pton(AF_INET, ip, &address) == 1 ? ip : "invalid";
    fprintf(stderr, "NET_DIAG stage=%s errno=%d server=%s port=%u\n", stage, error, safe_ip, port);
    return -1;
}
/* All network reads use connected UDP, source is checked by the kernel. */
static int udp_exchange(const char *ip, unsigned port, const char *iface, unsigned mark,
                        const void *req, size_t req_len, unsigned char *reply, size_t cap,
                        int64_t deadline, int64_t *elapsed_ms) {
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    if (!port || port > 65535 || inet_pton(AF_INET, ip, &addr.sin_addr) != 1) return diag_failure("arguments", EINVAL, ip, port);
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return diag_failure("socket", errno, ip, port);
    int rc = -1, saved_errno = 0;
    const char *stage = NULL;
    if (iface && *iface && strcmp(iface, "-")) {
        size_t n = strlen(iface);
        if (n >= IFNAMSIZ) { stage = "interface_length"; saved_errno = EINVAL; goto out; }
        if (setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, iface, (socklen_t)n + 1)) { stage = "setsockopt_bindtodevice"; saved_errno = errno; goto out; }
    }
    if (mark && setsockopt(fd, SOL_SOCKET, SO_MARK, &mark, sizeof(mark))) { stage = "setsockopt_mark"; saved_errno = errno; goto out; }
    int64_t start = mono_ms();
    if (start < 0) { stage = "monotonic_clock"; saved_errno = errno; goto out; }
    if (start >= deadline) { stage = "deadline_expired"; saved_errno = ETIMEDOUT; goto out; }
    int64_t end = start + QUERY_MS;
    if (end > deadline) end = deadline;
    unsigned before_mark = 0, after_mark = 0, send_mark = 0;
    socklen_t mark_len = sizeof(before_mark);
    if (mark && getsockopt(fd, SOL_SOCKET, SO_MARK, &before_mark, &mark_len)) { stage = "getsockopt_mark_before"; saved_errno = errno; goto out; }
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr))) { stage = "connect"; saved_errno = errno; goto out; }
    if (mark) {
        mark_len = sizeof(after_mark);
        if (getsockopt(fd, SOL_SOCKET, SO_MARK, &after_mark, &mark_len)) { stage = "getsockopt_mark_after"; saved_errno = errno; goto out; }
        /* Android bionic connect can invoke fwmarkd and rewrite SO_MARK. Reset
         * after connect, before send; Linux invalidates the socket route cache. */
        if (setsockopt(fd, SOL_SOCKET, SO_MARK, &mark, sizeof(mark))) { stage = "setsockopt_mark_after_connect"; saved_errno = errno; goto out; }
        mark_len = sizeof(send_mark);
        if (getsockopt(fd, SOL_SOCKET, SO_MARK, &send_mark, &mark_len)) { stage = "getsockopt_mark_send"; saved_errno = errno; goto out; }
        fprintf(stderr, "NET_MARK requested=%u before_connect=%u after_connect=%u before_send=%u server=%s port=%u\n", mark, before_mark, after_mark, send_mark, ip, port);
        if (send_mark != mark) { stage = "mark_verification"; saved_errno = EIO; goto out; }
    }
    ssize_t sent = send(fd, req, req_len, 0);
    if (sent != (ssize_t)req_len) { stage = "send"; saved_errno = sent < 0 ? errno : EIO; goto out; }
    for (;;) {
        int64_t now = mono_ms();
        if (now < 0) { stage = "monotonic_clock"; saved_errno = errno; goto out; }
        if (now >= end) { stage = "poll_timeout"; saved_errno = ETIMEDOUT; goto out; }
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int r = poll(&pfd, 1, (int)(end - now));
        if (r < 0 && errno == EINTR) continue;
        if (r < 0) { stage = "poll"; saved_errno = errno; goto out; }
        if (r == 0) { stage = "poll_timeout"; saved_errno = ETIMEDOUT; goto out; }
        if (!(pfd.revents & POLLIN)) {
            int socket_error = 0; socklen_t error_len = sizeof(socket_error);
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_len)) socket_error = errno;
            stage = "poll_socket_error"; saved_errno = socket_error ? socket_error : EIO; goto out;
        }
        ssize_t n = recv(fd, reply, cap, MSG_TRUNC);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n < 0) { stage = "recv"; saved_errno = errno; goto out; }
        if ((size_t)n > cap) { stage = "recv_truncated"; saved_errno = EMSGSIZE; goto out; }
        int64_t received = mono_ms();
        if (received < start || received > end) { stage = "recv_deadline"; saved_errno = ETIMEDOUT; goto out; }
        *elapsed_ms = received - start;
        rc = (int)n;
        break;
    }
out:
    close(fd);
    if (rc < 0 && stage) diag_failure(stage, saved_errno, ip, port);
    return rc;
}

static int valid_host(const char *host) {
    size_t n = strlen(host), label = 0;
    if (!n || n > 253 || host[n - 1] == '.') return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)host[i];
        if (c == '.') { if (!label) return 0; label = 0; }
        else { if (!(isalnum(c) || c == '-') || ++label > 63) return 0; }
    }
    return label != 0;
}
static int dns_request(const char *host, unsigned char *out, size_t cap, uint16_t *id) {
    if (!valid_host(host) || cap < strlen(host) + 18) return -1;
    memset(out, 0, cap);
    if (random_bytes(id, sizeof(*id))) return -1;
    put16(out, *id); put16(out + 2, 0x0100); put16(out + 4, 1);
    size_t pos = 12;
    const char *s = host;
    while (*s) {
        const char *dot = strchr(s, '.');
        size_t n = dot ? (size_t)(dot - s) : strlen(s);
        out[pos++] = (unsigned char)n; memcpy(out + pos, s, n); pos += n;
        if (!dot) break;
        s = dot + 1;
    }
    out[pos++] = 0; put16(out + pos, 1); put16(out + pos + 2, 1);
    return (int)(pos + 4);
}
/* Decode compressed names with backward-only pointers and a finite hop bound. */
static int dns_name(const unsigned char *buf, size_t len, size_t *offset, char out[254]) {
    size_t pos = *offset, used = 0, resumed = 0;
    int jumped = 0;
    for (unsigned hops = 0; hops < 128; hops++) {
        if (pos >= len) return -1;
        unsigned c = buf[pos];
        if ((c & 0xc0) == 0xc0) {
            if (pos + 1 >= len) return -1;
            size_t ptr = ((size_t)(c & 0x3f) << 8) | buf[pos + 1];
            if (ptr >= pos || ptr >= len) return -1;
            if (!jumped) resumed = pos + 2;
            jumped = 1; pos = ptr; continue;
        }
        if (c & 0xc0) return -1;
        pos++;
        if (!c) { out[used] = 0; *offset = jumped ? resumed : pos; return 0; }
        if (c > 63 || pos + c > len || used + c + (used ? 1 : 0) > 253) return -1;
        if (used) out[used++] = '.';
        for (unsigned j = 0; j < c; j++) {
            unsigned char ch = buf[pos + j];
            if (!(isalnum(ch) || ch == '-' || ch == '_')) return -1;
            out[used++] = (char)tolower(ch);
        }
        pos += c;
    }
    return -1;
}
static int dns_parse(const unsigned char *buf, size_t len, uint16_t id, const char *host,
                     struct in_addr *ips, size_t max_ips) {
    if (len < 12 || u16(buf) != id) return -1;
    unsigned flags = u16(buf + 2), count = u16(buf + 6);
    if (!(flags & 0x8000) || (flags & 0x7800) || (flags & 0x0200) || (flags & 0x000f) || u16(buf + 4) != 1 || !count || count > MAX_ANSWERS) return -1;
    size_t pos = 12;
    char question[254];
    if (dns_name(buf, len, &pos, question) || strcasecmp(question, host) || pos + 4 > len || u16(buf + pos) != 1 || u16(buf + pos + 2) != 1) return -1;
    pos += 4;
    struct dns_answer answers[MAX_ANSWERS];
    memset(answers, 0, sizeof(answers));
    for (unsigned i = 0; i < count; i++) {
        struct dns_answer *a = &answers[i];
        if (dns_name(buf, len, &pos, a->owner) || pos + 10 > len) return -1;
        a->type = u16(buf + pos);
        unsigned klass = u16(buf + pos + 2), rdlen = u16(buf + pos + 8);
        pos += 10;
        if (pos + rdlen > len) return -1;
        if (klass != 1) a->type = 0;
        if (a->type == 1) {
            if (rdlen != 4) return -1;
            memcpy(&a->ip, buf + pos, 4);
        } else if (a->type == 5) {
            size_t rp = pos;
            if (dns_name(buf, len, &rp, a->cname) || rp != pos + rdlen) return -1;
        }
        pos += rdlen;
    }
    char target[254]; snprintf(target, sizeof(target), "%s", question);
    for (unsigned hop = 0; hop <= count; hop++) {
        size_t found = 0;
        for (unsigned i = 0; i < count; i++) {
            struct dns_answer *a = &answers[i];
            if (a->type != 1 || strcmp(a->owner, target)) continue;
            uint32_t v = ntohl(a->ip.s_addr);
            if (!v || (v >> 24) == 127 || (v >> 28) >= 14) continue;
            int duplicate = 0;
            for (size_t j = 0; j < found; j++) if (ips[j].s_addr == a->ip.s_addr) duplicate = 1;
            if (!duplicate && found < max_ips) ips[found++] = a->ip;
        }
        if (found) return (int)found;
        int next = 0;
        for (unsigned i = 0; i < count; i++) if (answers[i].type == 5 && !strcmp(answers[i].owner, target)) {
            snprintf(target, sizeof(target), "%s", answers[i].cname); next = 1; break;
        }
        if (!next) return -1;
    }
    return -1;
}
static int dns_query(const char *host, const char *server, unsigned port, const char *iface,
                     unsigned mark, int64_t deadline, struct in_addr *ips, size_t max_ips) {
    unsigned char request[512], response[DNS_MAX]; uint16_t id;
    int n = dns_request(host, request, sizeof(request), &id);
    if (n < 0) return diag_failure("dns_request", valid_host(host) ? errno : EINVAL, server, port);
    int64_t elapsed;
    n = udp_exchange(server, port, iface, mark, request, (size_t)n, response, sizeof(response), deadline, &elapsed);
    if (n < 0) return -1;
    int result = dns_parse(response, (size_t)n, id, host, ips, max_ips);
    return result < 0 ? diag_failure("dns_parse", EPROTO, server, port) : result;
}
static double ntp_timestamp(const unsigned char *p) {
    uint64_t sec = u32(p);
    if (sec < NTP_OFFSET) return -1;
    return (double)(sec - NTP_OFFSET) + (double)u32(p + 4) / 4294967296.0;
}
static int ntp_parse(const unsigned char *buf, size_t len, const unsigned char nonce[8],
                     int64_t rtt, double *epoch) {
    if (len < 48 || rtt < 0 || rtt > QUERY_MS) return -1;
    unsigned li = buf[0] >> 6, version = (buf[0] >> 3) & 7, mode = buf[0] & 7;
    if (li == 3 || (version != 3 && version != 4) || mode != 4 || buf[1] < 1 || buf[1] > 15 || memcmp(buf + 24, nonce, 8)) return -1;
    double receive = ntp_timestamp(buf + 32), transmit = ntp_timestamp(buf + 40);
    if (receive < (double)EPOCH_MIN || transmit < receive || transmit - receive > 5 || transmit >= (double)EPOCH_MAX) return -1;
    *epoch = transmit + (double)rtt / 2000.0;
    return *epoch >= (double)EPOCH_MAX ? -1 : 0;
}
static int ntp_query(const char *ip, unsigned port, const char *iface, unsigned mark,
                     int64_t deadline, struct time_sample *sample) {
    unsigned char request[48] = {0}, response[512];
    request[0] = 0x23; /* NTPv4 client, LI=0 */
    if (random_bytes(request + 40, 8)) return diag_failure("ntp_nonce", errno, ip, port);
    int64_t elapsed;
    int n = udp_exchange(ip, port, iface, mark, request, sizeof(request), response, sizeof(response), deadline, &elapsed);
    if (n < 0) return -1;
    if (ntp_parse(response, (size_t)n, request + 40, elapsed, &sample->epoch)) return diag_failure("ntp_parse", EPROTO, ip, port);
    sample->received_ms = mono_ms();
    return sample->received_ms < 0 || inet_pton(AF_INET, ip, &sample->ip) != 1 ? -1 : 0;
}
/* Compare timestamps at the same monotonic instant, rather than serial arrival times. */
static int consensus(const struct time_sample *samples, unsigned count, int64_t now, uint64_t *epoch) {
    for (unsigned i = 0; i < count; i++) for (unsigned j = i + 1; j < count; j++) {
        if (samples[i].ip.s_addr == samples[j].ip.s_addr || now < samples[i].received_ms || now < samples[j].received_ms) continue;
        double a = samples[i].epoch + (double)(now - samples[i].received_ms) / 1000.0;
        double b = samples[j].epoch + (double)(now - samples[j].received_ms) / 1000.0;
        double delta = a > b ? a - b : b - a;
        if (delta <= 3.0 && a >= EPOCH_MIN && a < EPOCH_MAX && b >= EPOCH_MIN && b < EPOCH_MAX) {
            *epoch = (uint64_t)((a + b) / 2.0 + 0.5); return 0;
        }
    }
    return -1;
}
static int time_probe(const char *iface) {
    const char *hosts[] = { "ntp3.aliyun.com", "ntp.tencent.com", "time.cloudflare.com" };
    const char *resolvers[] = { "223.5.5.5", "119.29.29.29" };
    const char *labels[] = { "aliyun", "tencent", "cloudflare" };
    struct time_sample samples[3]; unsigned count = 0, dns_valid = 0, dns_attempts = 0, ntp_attempts = 0;
    int64_t start = mono_ms(); if (start < 0) return 1;
    int64_t deadline = start + TIME_TOTAL_MS;
    for (unsigned h = 0; h < 3 && mono_ms() < deadline; h++) {
        struct in_addr ips[8]; int n = -1;
        for (unsigned r = 0; r < 2 && n < 0; r++) {
            fprintf(stderr, "TIME_STAGE host=%s phase=dns server=%s\n", labels[h], resolvers[r]);
            dns_attempts++;
            n = dns_query(hosts[h], resolvers[r], 53, iface, 255, deadline, ips, 8);
        }
        if (n < 0) continue;
        dns_valid++;
        for (int k = 0; k < n; k++) {
            int used = 0;
            for (unsigned j = 0; j < count; j++) if (samples[j].ip.s_addr == ips[k].s_addr) used = 1;
            if (used) continue;
            char ip[INET_ADDRSTRLEN];
            if (!inet_ntop(AF_INET, &ips[k], ip, sizeof(ip))) break;
            fprintf(stderr, "TIME_STAGE host=%s phase=ntp server=%s\n", labels[h], ip);
            ntp_attempts++;
            if (!ntp_query(ip, 123, iface, 255, deadline, &samples[count])) count++;
            /* At most one NTP request per independent provider, total <= 27 s. */
            break;
        }
        uint64_t epoch;
        if (!consensus(samples, count, mono_ms(), &epoch)) { printf("%llu\n", (unsigned long long)epoch); return 0; }
    }
    fprintf(stderr, "TIME_FAIL reason=no_consensus dns_valid=%u dns_attempts=%u ntp_valid=%u ntp_attempts=%u deadline_s=29\n", dns_valid, dns_attempts, count, ntp_attempts);
    return 1;
}
#ifndef VIDEO_BOOT_NET_TEST
static int number(const char *s, unsigned long max, unsigned *out) {
    char *end; errno = 0;
    if (!*s || *s == '-') return -1;
    unsigned long n = strtoul(s, &end, 10);
    if (errno || *end || n > max) return -1;
    *out = (unsigned)n; return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && (!strcmp(argv[1], "--help") || !strcmp(argv[1], "help"))) {
        puts("Query only; never sets time or changes network configuration.\n"
             "  video-boot-net time [iface]                 default eth0, mark=255, deadline=29s\n"
             "  video-boot-net dns HOST SERVER_IP PORT [iface|- [mark]]\n"
             "DNS defaults: no interface binding, no mark; each query deadline=3s.\n"
             "Success: time prints Unix epoch; dns prints DNS_OK IPv4. Failure exit=1."); return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "time") && (argc == 2 || argc == 3)) return time_probe(argc == 3 ? argv[2] : "eth0");
    if (argc >= 5 && argc <= 7 && !strcmp(argv[1], "dns")) {
        unsigned port, mark = 0;
        if (number(argv[4], 65535, &port) || !port || (argc == 7 && number(argv[6], 0xffffffffUL, &mark))) return 2;
        struct in_addr ip; int64_t now = mono_ms();
        int n = now < 0 ? -1 : dns_query(argv[2], argv[3], port, argc >= 6 ? argv[5] : NULL, mark, now + QUERY_MS, &ip, 1);
        if (n > 0) { char text[INET_ADDRSTRLEN]; if (!inet_ntop(AF_INET, &ip, text, sizeof(text))) return 1; printf("DNS_OK %s\n", text); return 0; }
        fprintf(stderr, "DNS_FAIL: no valid matching A answer\n"); return 1;
    }
    fprintf(stderr, "Invalid arguments; use --help\n"); return 2;
}
#endif
