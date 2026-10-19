/* #470/#472 OFFLINE TEST LAUNCHER ONLY. No runtime imports or privileged host changes.
 *
 * plain:      launcher DIR... -- EXE ARGS
 *             Validate fd 0-3, restrict before exec/threads (Landlock ABI >= 3, no_new_privs), close fds >= 4, exec.
 * --supervise launcher --supervise --report-fd=N DIR... -- EXE ARGS
 *             Unconfined subreaper S. Confines only the forked worker (pre-exec); when the worker exits, revokes every
 *             remaining descendant using pidfds and reports on its private report channel (fd N, never given to workers).
 * --reaper    launcher --reaper --report-fd=N -- EXE ARGS
 *             Unconfined test-only cleanup subreaper R. Never confines, never reads fault points. Reports its direct
 *             child's exit and, on SIGTERM, revokes every remaining descendant using pidfds.
 *
 * Refuse unsupported kernels or layouts; never run an unsandboxed worker fallback. Fault points (F2_LAUNCHER_FAULT=
 * role:name) exist only in this test launcher, apply only to the matching role, and can only cause a refusal or a
 * BLOCKED report, never an exec or a completion record. A writable private hardlink alias still needs Step 3.
 * Completion is single-host process-tree evidence under the documented assumptions, not production revocation.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef P_PIDFD
#define P_PIDFD 3
#endif
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif
#ifndef SYS_close_range
#define SYS_close_range 436
#endif

enum mode { PLAIN, SUPERVISE, REAPER };
static enum mode mode = PLAIN;
static int report_fd = -1;
static const char *fault = NULL; /* role-matched fault name, or NULL */

/* Diagnostics are written only after fd 2 itself is a verified endpoint, so a smuggled file is never modified. */
static int stderr_trusted = 0;
static int fail(const char *what) { if (stderr_trusted) perror(what); return 125; }
static int refuse(const char *what) { if (stderr_trusted) fprintf(stderr, "LAUNCHER_REFUSED %s\n", what); return 125; }
static int fault_is(const char *name) { return fault && !strcmp(fault, name); }

static void select_fault(const char *role) {
    const char *spec = getenv("F2_LAUNCHER_FAULT");
    size_t n = strlen(role);
    if (spec && !strncmp(spec, role, n) && spec[n] == ':') fault = spec + n + 1;
}

static pid_t trusted_spawner(void) {
    /* R is spawned directly by the trusted test parent: always getppid(). An inner launcher started by R inherits
     * R's verified spawner identity through F2_TRUSTED_SPAWNER_PID, which only R (or the test parent) sets. */
    const char *env = getenv("F2_TRUSTED_SPAWNER_PID");
    if (mode != REAPER && env && *env) return (pid_t)strtol(env, NULL, 10);
    return getppid();
}

/* Unnamed AF_UNIX stream socket whose peer credentials are the trusted spawner (Node creates stdio/ipc pairs). */
static int peer_is(int fd, pid_t spawner) {
    struct stat st; int domain = 0, type = 0; socklen_t len = sizeof(int);
    if (fstat(fd, &st) || !S_ISSOCK(st.st_mode)) return 0;
    if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &len) || domain != AF_UNIX) return 0;
    len = sizeof(int);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) || type != SOCK_STREAM) return 0;
    struct sockaddr_un addr; socklen_t alen = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &alen) || alen != sizeof(sa_family_t)) return 0;
    struct ucred cred; socklen_t clen = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &clen)) return 0;
    return cred.pid == spawner && cred.uid == getuid();
}

static int validate_layout(void) {
    pid_t spawner = trusted_spawner();
    struct stat st;
    if (!peer_is(2, spawner)) return 125; /* absent or untrusted fd 2: refuse silently */
    stderr_trusted = 1;
    if (!peer_is(1, spawner)) return refuse("fd1-untrusted-endpoint");
    if (fstat(0, &st) || !S_ISCHR(st.st_mode) || st.st_rdev != makedev(1, 3)) return refuse("fd0-not-dev-null");
    if (fcntl(3, F_GETFD) == -1) { if (errno != EBADF) return fail("fd3"); }
    else if (!peer_is(3, spawner)) return refuse("fd3-untrusted-endpoint");
    if (mode != PLAIN) {
        if (report_fd < 4 || !peer_is(report_fd, spawner)) return refuse("report-fd-untrusted-endpoint");
        if (fcntl(report_fd, F_SETFD, FD_CLOEXEC)) return fail("report fd cloexec");
    }
    return 0;
}

static int landlock_abi(void) {
    if (fault_is("landlock-unavailable")) return -1;
    return (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

/* no_new_privs + Landlock: handled filesystem mutation denied except beneath the supplied directories. */
static int confine(char **dirs, int count) {
    int abi = landlock_abi();
    if (abi < 3) { fprintf(stderr, "LANDLOCK_ABI_3_REQUIRED got=%d\n", abi); return 125; }
    uint64_t writes = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
        LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_ruleset_attr attr = { .handled_access_fs = writes };
    int rules = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (rules < 0) return fail("create rules");
    for (int i = 0; i < count; ++i) {
        int fd = open(dirs[i], O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) return fail("open private directory");
        struct landlock_path_beneath_attr rule = { .allowed_access = writes, .parent_fd = fd };
        if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) return fail("add rule");
        close(fd);
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return fail("no new privs");
    if (syscall(SYS_landlock_restrict_self, rules, 0)) return fail("restrict self");
    close(rules);
    fprintf(stderr, "LANDLOCK_ENFORCED abi=%d uid=%ld\n", abi, (long)geteuid());
    return 0;
}

static void scrub_environment(void) { unsetenv("F2_LAUNCHER_FAULT"); unsetenv("F2_TRUSTED_SPAWNER_PID"); }

static void report(const char *line) {
    if (report_fd < 0) return;
    size_t len = strlen(line), off = 0;
    while (off < len) { ssize_t n = write(report_fd, line + off, len - off); if (n <= 0) { if (errno == EINTR) continue; return; } off += (size_t)n; }
}

static double now_s(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (double)ts.tv_sec + ts.tv_nsec / 1e9; }

static int is_number(const char *s) { if (!*s) return 0; for (; *s; ++s) if (*s < '0' || *s > '9') return 0; return 1; }

static pid_t parent_of(pid_t pid) {
    char path[64], buf[1024];
    snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, sizeof(buf) - 1); close(fd);
    if (n <= 0) return -1;
    buf[n] = 0;
    char *end = strrchr(buf, ')');
    int ppid = -1; char state;
    if (!end || sscanf(end + 2, "%c %d", &state, &ppid) != 2) return -1;
    return (pid_t)ppid;
}

/* Reap anything already exited. Returns 1 when ECHILD (no children left), 0 otherwise, -1 on error. */
static int reap_exited(pid_t watch, int *watch_status, int *watched) {
    for (;;) {
        siginfo_t info; memset(&info, 0, sizeof(info));
        if (waitid(P_ALL, 0, &info, WEXITED | WNOHANG)) return errno == ECHILD ? 1 : -1;
        if (info.si_pid == 0) return 0;
        if (watch > 0 && info.si_pid == watch && watched) { *watched = 1; if (watch_status) *watch_status = info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status; }
    }
}

/*
 * Revoke every descendant. A /proc scan only yields CANDIDATES; each candidate is pinned with a pidfd, proven to be
 * our own child with waitid(P_PIDFD, WNOWAIT) (ECHILD -> not ours, skip), signalled through the pidfd and reaped
 * through the same pidfd. No raw PID is ever signalled. Completion = ECHILD from waitid(P_ALL).
 * Returns 0 on completion, -1 on an unidentifiable state (BLOCKED), -2 on deadline (BLOCKED).
 */
static int sweep(double deadline_s, int *candidates_seen) {
    double deadline = now_s() + deadline_s;
    pid_t self = getpid();
    for (;;) {
        int state = reap_exited(0, NULL, NULL);
        if (state == 1) return 0;
        if (state < 0) return -1;
        DIR *proc = opendir("/proc");
        if (!proc) return -1;
        struct dirent *entry;
        while ((entry = readdir(proc))) {
            if (!is_number(entry->d_name)) continue;
            pid_t pid = (pid_t)strtol(entry->d_name, NULL, 10);
            if (parent_of(pid) != self) continue;
            if (candidates_seen) ++*candidates_seen;
            int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
            if (pidfd < 0) { if (errno == ESRCH) continue; closedir(proc); return -1; }
            siginfo_t info; memset(&info, 0, sizeof(info));
            if (waitid((idtype_t)P_PIDFD, (id_t)pidfd, &info, WEXITED | WNOHANG | WNOWAIT)) {
                int err = errno; close(pidfd);
                if (err == ECHILD) continue; /* stale candidate: not our child */
                closedir(proc); return -1;
            }
            if (syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) && errno != ESRCH) { close(pidfd); closedir(proc); return -1; }
            memset(&info, 0, sizeof(info));
            if (waitid((idtype_t)P_PIDFD, (id_t)pidfd, &info, WEXITED)) { close(pidfd); closedir(proc); return -1; }
            close(pidfd);
        }
        closedir(proc);
        if (now_s() > deadline) return -2;
    }
}

static int require_process_prereqs(void) {
    if (fault_is("subreaper-unavailable") || prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) return refuse("subreaper-unavailable");
    int probe = fault_is("pidfd-unavailable") ? -1 : (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (probe < 0) return refuse("pidfd-unavailable");
    close(probe);
    DIR *proc = fault_is("proc-unavailable") ? NULL : opendir("/proc");
    if (!proc) return refuse("proc-unavailable");
    closedir(proc);
    if (fault_is("close-range-unavailable") || syscall(SYS_close_range, ~0U, ~0U, 0)) return refuse("close-range-unavailable");
    return 0;
}

static int run_plain(char **dirs, int count, char **cmd) {
    int code = confine(dirs, count);
    if (code) return code;
    /* The test parent supplies only /dev/null, peer-verified sockets and IPC on 0..3. Drop everything else. */
    if (fault_is("close-range-unavailable") || syscall(SYS_close_range, 4U, ~0U, 0)) return refuse("close-range-unavailable");
    scrub_environment();
    execv(cmd[0], cmd);
    return fail("exec worker");
}

static int run_supervise(char **dirs, int count, char **cmd) {
    int code = require_process_prereqs();
    if (code) return code;
    if (landlock_abi() < 3) return refuse("landlock-unavailable");
    int status_pipe[2];
    if (pipe2(status_pipe, O_CLOEXEC)) return fail("status pipe");
    int sweep_blocked = fault_is("sweep-blocked");
    pid_t worker = fork();
    if (worker < 0) return fail("fork worker");
    if (worker == 0) {
        close(status_pipe[0]);
        int err = confine(dirs, count);
        /* Report fd, status pipe and every other fd >= 4 become close-on-exec: the worker never holds them. */
        if (!err && syscall(SYS_close_range, 4U, ~0U, CLOSE_RANGE_CLOEXEC)) err = 125;
        if (!err) { scrub_environment(); execv(cmd[0], cmd); }
        int e = errno ? errno : EINVAL;
        if (write(status_pipe[1], &e, sizeof(e)) < 0) { /* the supervisor treats silence as success only on exec */ }
        _exit(127);
    }
    close(status_pipe[1]);
    int child_errno = 0;
    ssize_t got = read(status_pipe[0], &child_errno, sizeof(child_errno));
    close(status_pipe[0]);
    char line[256];
    if (got > 0) {
        waitpid(worker, NULL, 0);
        snprintf(line, sizeof(line), "F2PA1 SETUP_FAILED supervisor=%d errno=%d\n", (int)getpid(), child_errno);
        report(line);
        return 125;
    }
    int worker_status = -1, watched = 0;
    while (!watched) {
        siginfo_t info; memset(&info, 0, sizeof(info));
        if (waitid(P_ALL, 0, &info, WEXITED)) { if (errno == EINTR) continue; break; }
        if (info.si_pid == worker) { watched = 1; worker_status = info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status; }
    }
    int candidates = 0;
    if (sweep_blocked) {
        /* Test-only fault AFTER the worker tree started: scan, kill nothing, report BLOCKED. */
        DIR *proc = opendir("/proc"); struct dirent *entry;
        while (proc && (entry = readdir(proc))) if (is_number(entry->d_name) && parent_of((pid_t)strtol(entry->d_name, NULL, 10)) == getpid()) ++candidates;
        if (proc) closedir(proc);
        snprintf(line, sizeof(line), "F2PA1 BLOCKED supervisor=%d reason=fault-sweep-blocked candidates=%d\n", (int)getpid(), candidates);
        report(line);
        return 124;
    }
    int result = sweep(5.0, &candidates);
    if (result) {
        snprintf(line, sizeof(line), "F2PA1 BLOCKED supervisor=%d reason=%s\n", (int)getpid(), result == -2 ? "deadline" : "unidentifiable");
        report(line);
        return 124;
    }
    snprintf(line, sizeof(line), "F2PA1 COMPLETE supervisor=%d worker_status=%d\n", (int)getpid(), worker_status);
    report(line);
    return 0;
}

static int run_reaper(char **cmd) {
    /* No fault points are read here: the cleanup reaper must stay operational in every fault case. */
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) return refuse("subreaper-unavailable");
    int probe = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (probe < 0) return refuse("pidfd-unavailable");
    close(probe);
    sigset_t set; sigemptyset(&set); sigaddset(&set, SIGTERM); sigaddset(&set, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &set, NULL)) return fail("sigprocmask");
    char spawner[32]; snprintf(spawner, sizeof(spawner), "%d", (int)getppid());
    pid_t child = fork();
    if (child < 0) return fail("fork");
    if (child == 0) {
        sigprocmask(SIG_UNBLOCK, &set, NULL);
        setenv("F2_TRUSTED_SPAWNER_PID", spawner, 1);
        execv(cmd[0], cmd);
        _exit(127);
    }
    /* R keeps only 0..2 and its own report channel: an inner supervisor's report channel must reach EOF exactly when
     * that supervisor exits, so R must not hold a copy of it. */
    if (report_fd > 3 && syscall(SYS_close_range, 3U, (unsigned)report_fd - 1, 0)) return fail("close inherited");
    if (syscall(SYS_close_range, (unsigned)report_fd + 1, ~0U, 0)) return fail("close inherited");
    char line[160];
    for (;;) {
        siginfo_t sig;
        if (sigwaitinfo(&set, &sig) < 0) { if (errno == EINTR) continue; return fail("sigwaitinfo"); }
        if (sig.si_signo == SIGCHLD) {
            for (;;) {
                siginfo_t info; memset(&info, 0, sizeof(info));
                if (waitid(P_ALL, 0, &info, WEXITED | WNOHANG) || info.si_pid == 0) break;
                if (info.si_pid == child) {
                    snprintf(line, sizeof(line), "F2PA1 INNER_EXIT pid=%d %s=%d\n", (int)child, info.si_code == CLD_EXITED ? "code" : "signal", info.si_status);
                    report(line);
                }
            }
            continue;
        }
        int result = sweep(5.0, NULL);
        report(result ? "F2PA1 REAPER_BLOCKED\n" : "F2PA1 REAPER_COMPLETE\n");
        return result ? 124 : 0;
    }
}

/* Read-only descriptor evidence. This branch never execs, writes files or changes confinement.
 * Linux 6.9 UAPI FS_IOC_GETFSUUID: external on-disk UUID, not st_dev or statfs f_fsid.
 * Local definition allows older build headers; an unsupported running kernel fails closed. */
struct photo_fsuuid { unsigned char len; unsigned char uuid[16]; };
static int storage_proof(void) {
    struct stat st;
    struct photo_fsuuid uuid = {0};
    if (geteuid() == 0 || fstat(3, &st) || (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode))) return 125;
    if (ioctl(3, _IOR(0x15, 0, struct photo_fsuuid), &uuid) || uuid.len != 16) return 125;
    unsigned int nonzero = 0;
    for (int n = 0; n < 16; ++n) nonzero |= uuid.uuid[n];
    if (!nonzero) return 125;
    for (int n = 0; n < 16; ++n) printf("%02x", uuid.uuid[n]);
    return printf("\n") < 0 ? 125 : 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--storage-proof")) return storage_proof();
    int i = 1;
    if (i < argc && !strcmp(argv[i], "--supervise")) { mode = SUPERVISE; ++i; }
    else if (i < argc && !strcmp(argv[i], "--reaper")) { mode = REAPER; ++i; }
    if (mode != PLAIN) {
        if (i >= argc || strncmp(argv[i], "--report-fd=", 12)) return refuse("report-fd-required");
        report_fd = (int)strtol(argv[i] + 12, NULL, 10); ++i;
    }
    /* Validate the descriptor layout before anything else is printed or executed. */
    if (mode == PLAIN) select_fault("plain"); else if (mode == SUPERVISE) select_fault("supervise");
    int layout = validate_layout(); if (layout) return layout;
    int first_dir = i, split = i;
    while (split < argc && strcmp(argv[split], "--")) split++;
    if (split >= argc || split + 1 >= argc || geteuid() == 0) return refuse("requires unprivileged user, allowed directories, -- executable args");
    if (mode != REAPER && split == first_dir) return refuse("allowed-directory-required");
    if (mode == REAPER) return run_reaper(&argv[split + 1]);
    if (mode == SUPERVISE) return run_supervise(&argv[first_dir], split - first_dir, &argv[split + 1]);
    return run_plain(&argv[first_dir], split - first_dir, &argv[split + 1]);
}
