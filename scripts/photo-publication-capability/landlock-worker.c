/* #470 OFFLINE TEST LAUNCHER ONLY. No runtime imports or privileged host changes.
 * Restrict before exec/threads. Refuse unsupported kernels; never run an unsandboxed fallback.
 * Filesystem mutation is denied except beneath explicit test-private directories.
 * This is not a broker, a deployment policy, or revocation of an already-running process.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
static int fail(const char *what) { perror(what); return 125; }
int main(int argc, char **argv) {
    int split = 1;
    while (split < argc && strcmp(argv[split], "--")) split++;
    if (split < 2 || split + 1 >= argc || geteuid() == 0) {
        fprintf(stderr, "requires unprivileged user, allowed directories, -- executable args\n");
        return 125;
    }
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) { fprintf(stderr, "LANDLOCK_ABI_3_REQUIRED got=%d\n", abi); return 125; }
    uint64_t writes = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
        LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_ruleset_attr attr = { .handled_access_fs = writes };
    int rules = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (rules < 0) return fail("create rules");
    for (int i = 1; i < split; ++i) {
        int fd = open(argv[i], O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) return fail("open private directory");
        struct landlock_path_beneath_attr rule = { .allowed_access = writes, .parent_fd = fd };
        if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) return fail("add rule");
        close(fd);
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return fail("no new privs");
    if (syscall(SYS_landlock_restrict_self, rules, 0)) return fail("restrict self");
    close(rules);
    /* The test parent supplies only pipes and IPC on 0..3. Do not retain writable media descriptors. */
    if (syscall(SYS_close_range, 4U, ~0U, 0)) return fail("close inherited descriptors");
    fprintf(stderr, "LANDLOCK_ENFORCED abi=%d uid=%ld\n", abi, (long)geteuid());
    execv(argv[split + 1], &argv[split + 1]);
    return fail("exec worker");
}
