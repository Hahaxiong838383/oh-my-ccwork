#define _POSIX_C_SOURCE 200809L
/* Read-only acceleration for the existing boot predicates. 0=present,
 * 1=complete scan absent, 2=uncertain (caller MUST use the shell fallback).
 * No comm/PID-file filtering: renamed and orphan processes are included. */
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define LIMIT (1024u * 1024u)
static int suffix(const char *s, const char *end) {
    size_t a = strlen(s), b = strlen(end);
    return a >= b && !memcmp(s + a - b, end, b);
}
static int path(char *out, size_t cap, const char *a, const char *b, const char *c) {
    int n = snprintf(out, cap, "%s/%s/%s", a, b, c);
    return n >= 0 && (size_t)n < cap;
}
int main(int argc, char **argv) {
    if (argc != 5) return 2;
    int worker = !strcmp(argv[2], "worker");
    if ((!worker && strcmp(argv[2], "main") && strcmp(argv[2], "transaction")) ||
        (!worker && strcmp(argv[4], "dns9") && strcmp(argv[4], "rack"))) return 2;
    int txn = !strcmp(argv[2], "transaction"), rack = !strcmp(argv[4], "rack");
    char expected_exe[4096], expected_main[8192], expected_rack[8192];
    char guardian[8192], supervisor[8192], p[8192], exe[4096];
    if (strlen(argv[1]) > 3000 || strlen(argv[3]) > 3000 || strlen(argv[4]) > 3000) return 2;
    snprintf(expected_exe, sizeof(expected_exe), worker ? "%s" : "%s/sing-box", argv[3]);
    if (worker) snprintf(expected_main, sizeof(expected_main), "%s\nrun\n-c\n%s", expected_exe, argv[4]);
    else snprintf(expected_main, sizeof(expected_main), txn ? "%s\nrun\n-c\n%s/config.json" :
             "%s run -c %s/config.json ", expected_exe, argv[3]);
    snprintf(expected_rack, sizeof(expected_rack), "%s\nrun\n-c\n%s/youtube-failover/workers/rack/config.json", expected_exe, argv[3]);
    snprintf(guardian, sizeof(guardian), "YoutubeFailover\n%s/youtube-failover/guard-config.json", argv[3]);
    snprintf(supervisor, sizeof(supervisor), "%s/youtube-failover/guard-run.sh", argv[3]);
    DIR *dir = opendir(argv[1]);
    if (!dir) return 2;
    char *buf = malloc(LIMIT + 1);
    if (!buf) { closedir(dir); return 2; }
    int result = 1;
    struct dirent *ent;
    for (;;) {
        errno = 0;
        ent = readdir(dir);
        if (!ent) { if (errno) result = 2; break; }
        if (!ent->d_name[0] || strspn(ent->d_name, "0123456789") != strlen(ent->d_name)) continue;
        if (!path(p, sizeof(p), argv[1], ent->d_name, "exe")) { result = 2; break; }
        ssize_t nlink = readlink(p, exe, sizeof(exe)-1);
        int exact_exe = 0;
        if (nlink >= 0) { exe[nlink] = 0; exact_exe = !strcmp(exe, expected_exe); }
        if (!txn && !exact_exe) continue;
        if (!path(p, sizeof(p), argv[1], ent->d_name, "cmdline")) { result = 2; break; }
        /* Match the transaction's readable-file gate. Vanished processes are
         * ignored; failure after this gate is uncertain, never absent. */
        if (access(p, R_OK)) continue;
        FILE *f = fopen(p, "rb");
        if (!f) { if (access(p, F_OK) == 0) result = 2; continue; }
        size_t n = fread(buf, 1, LIMIT + 1, f);
        int bad = ferror(f);
        fclose(f);
        if (bad || n > LIMIT || (n && buf[n-1] != '\0')) { result = 2; continue; }
        for (size_t i=0; i<n; i++) if (!buf[i]) buf[i] = (txn || worker) ? '\n' : ' ';
        /* Shell command substitution strips trailing newlines, not spaces. */
        while (n && buf[n-1] == '\n') n--;
        buf[n] = 0;
        if ((exact_exe && !strcmp(buf, expected_main)) ||
            (txn && rack && exact_exe && !strcmp(buf, expected_rack)) ||
            (txn && (suffix(buf, guardian) || suffix(buf, supervisor)))) {
            result = 0; break;
        }
    }
    free(buf);
    if (closedir(dir) && result == 1) result = 2;
    return result;
}
