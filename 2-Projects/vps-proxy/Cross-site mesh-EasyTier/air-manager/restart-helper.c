/* Root-owned, no parameters, one fixed launchd service, ten-minute cooldown. */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <errno.h>
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || geteuid() != 0) return 64;
    umask(077);
    int fd = open("/var/run/cn.easytier.manager-restart.lock", O_RDWR|O_CREAT|O_NOFOLLOW, 0600);
    if (fd < 0) return 70;
    struct stat st;
    if (fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid != 0 || (st.st_mode & 077)) return 70;
    if (flock(fd, LOCK_EX|LOCK_NB)) return 75;
    char buf[64] = {0};
    ssize_t n = read(fd,buf,sizeof(buf)-1);
    if (n < 0) return 70;
    long long previous = strtoll(buf,NULL,10);
    time_t now = time(NULL);
    if (previous > 0 && (long long)now - previous < 600) return 75;
    pid_t child = fork();
    if (child < 0) return 70;
    if (child == 0) {
        char *args[] = {"/bin/launchctl", "kickstart", "-k", "system/cn.easytier.mesh", NULL};
        char *env[] = {"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", NULL};
        execve(args[0],args,env);
        _exit(71);
    }
    int status;
    while (waitpid(child,&status,0) < 0) { if (errno != EINTR) return 70; }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 71;
    if (ftruncate(fd,0) || lseek(fd,0,SEEK_SET) < 0) return 70;
    if (dprintf(fd,"%lld\n",(long long)time(NULL)) < 0 || fsync(fd)) return 70;
    close(fd);
    return 0;
}
