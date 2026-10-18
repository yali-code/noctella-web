# Stage 5 F2 — Step 2/5 offline process-authority proof — #472

Base: `cd66b551f9569d752fbd0a98654af622d6432c96` (PR #482 merged into #471's branch). Branch: `test/stage5-f2-process-authority-472`. Test launcher, one test file, one fixture, the required gate and this document only. No `apps/api/src`, migration, Render or Contract 1 change. The 470 LIMIT reproduction and the untracked step-0 lab are untouched (the lab is neither executed nor promoted). No AGENTS.md or LOOP.md exists in this baseline.

**Step 2 is not complete until the required Linux CI gate and independent review pass.** Runtime Photo F2 remains HIGH/FAIL; byte immutability NOT PROVED; production availability NOT ACCEPTED; official progress 4/12.

## Launcher modes (`scripts/photo-publication-capability/landlock-worker.c`, test-only)

- **Layout validation (all modes, before anything is printed or executed).** fd 2 then fd 1: unnamed `AF_UNIX`/`SOCK_STREAM` sockets whose `SO_PEERCRED` pid/uid is the trusted spawner; fd 0: `/dev/null` (`S_ISCHR`, rdev 1:3); fd 3: absent, or a peer-verified socket (Node IPC); report fd (supervise/reaper): a peer-verified socket at fd >= 4, made close-on-exec. Diagnostics are printed only after fd 2 is verified, so a smuggled file is never written.
- **Trusted spawner through wrappers.** The reaper is spawned directly by the test parent and always uses `getppid()`. It passes that verified identity to its inner launcher as `F2_TRUSTED_SPAWNER_PID`; the inner launcher still verifies every endpoint's actual peer credentials against it (a forged value is refused, case D5d). Both variables are scrubbed before any worker exec.
- **plain**: validate, Landlock ABI >= 3 + `no_new_privs`, `close_range(4..)`, exec.
- **`--supervise --report-fd=N`**: an unconfined subreaper S checks prerequisites (subreaper, `pidfd_open`, `/proc`, `close_range`, Landlock ABI) before forking; only the forked worker is confined pre-exec and all fds >= 4 become close-on-exec in it. When the worker exits, S revokes remaining descendants and writes exactly one record to its private channel: `COMPLETE`, `BLOCKED` or `SETUP_FAILED`.
- **`--reaper --report-fd=N`**: unconfined, test-only cleanup subreaper. Reads no fault points. After forking its single inner command it closes every fd >= 3 except its own channel (so an inner supervisor's channel reaches EOF exactly at that supervisor's exit), reports `INNER_EXIT pid= code|signal=`, and on SIGTERM sweeps and reports `REAPER_COMPLETE`/`REAPER_BLOCKED`.

### Revocation with stable identity
A `/proc` scan yields candidates (`ppid == self`). Each candidate is pinned with `pidfd_open`, proven to be our own child with `waitid(P_PIDFD, WNOHANG|WNOWAIT)` (`ECHILD` = stale candidate, skipped), signalled with `pidfd_send_signal` and reaped through the same pidfd. No raw PID is signalled; only the sweeping process reaps its children, so a pinned child cannot be replaced. Missing pidfd/`P_PIDFD`/`close_range` support refuses before any worker starts. Completion is `ECHILD` from `waitid(P_ALL)`.

### Why ECHILD means completion here — and its limits
With S a live subreaper, an orphan reparents to the nearest live subreaper ancestor, which is inside S's subtree or S itself (double forks, `setsid` and `CLONE_PARENT` stay inside it). Every live descendant therefore has a live ancestor chain ending at a child of S, and `ECHILD` (evaluated atomically by the kernel) means none exists. Assumptions:
- **A1 No external spawn service** (systemd user instance, D-Bus activation, at/cron, any daemon reachable through a unix socket). Its children are not S's descendants. Landlock ABI 3 does not scope unix sockets.
- **A2** ptrace does not change `real_parent`; a confined worker cannot ptrace or open `/proc/<pid>/fd` of a process outside its Landlock domain (S, R and the test parent are unconfined; case S1).
- **A3** Inherited IPC endpoints never spawn or signal on request (trusted test parent only).
- **A4** S survives until it reports. A same-UID worker can SIGKILL S (signal scoping needs Landlock ABI 6); that yields no completion → BLOCKED (case T3).
- **A5** Single host, single kernel. This is not all-writer, cross-host or production revocation evidence.

### Completion authenticity
The test accepts completion only when (1) S's private channel (never held by workers: close-on-exec in the worker, closed in R) contains exactly one `COMPLETE supervisor=<pid>` record, (2) that channel reached EOF, and (3) R's own private channel reports `INNER_EXIT pid=<same pid> code=0`. Worker stdout/stderr is never evidence; case S1 forges the record on stdout and stderr and attempts fd 4 and `/proc/<S>/fd/4`.

### Fault points
`F2_LAUNCHER_FAULT=<role>:<name>` applies only to the matching role (`plain` or `supervise`); the reaper reads none. A fault can only refuse or report BLOCKED. Timing: `sweep-blocked` fires **after** the worker tree started (S records the live candidates it observed); `subreaper/pidfd/proc/close-range/landlock-unavailable` in supervise mode fire **before any fork**; plain `landlock-unavailable` fires before confinement and plain `close-range-unavailable` after confinement but before exec. Real deadlines (5 s sweep, 15 s waits) are failure bounds only; no case passes because a deadline expired.

## Acceptance cases (`apps/api/tests/publicationProcessAuthority472.test.ts`)
Controls C0-0..C0-4 (regular file at each reserved slot and fd 4 is a real write capability without the launcher); refusals D0..D3; closure D4, proven by file identity (no descriptor in the worker refers to the inherited file's dev/ino; positive control C0-4p) rather than by probing fd number 4, because Node/libuv reuse the lowest free numbers for internal descriptors after exec (run 39151957938: probing fd 9 hit such a descriptor, exit 4); worker execution is shown by an explicit `WORKER_RAN` marker, and its absence is asserted in refusal cases; endpoint identity D5a (named FIFO), D5b (foreign socket peer), D5c (absent fd 2), D5d (forged spawner); Landlock path denial D6; accepted layouts D7a (direct with IPC) and D7b (through the reaper with IPC); T1 supervisor completion over a `setsid` grandchild and a double-fork orphan; T2/P2/P3 direct child exit is not revocation while confined survivors stay alive and denied; T3 supervisor killed by the worker; T4 deterministic post-start sweep fault; S1 completion spoofing; FI fault isolation under the reaper; fault points for both roles; role isolation; real setup failures (missing/non-directory/symlinked directory, missing separator/command, nonexistent executable, post-fork exec failure). The 470 suite (including LIMIT), both unwrapped F2 reproductions and Contract 1 run unchanged in the same required job.

## Known production evidence (narrow)
Observed: shell identity UID/GID 1000; `/var/data` `root:render` mode `2775`; observed processes UID/GID 1000. These establish nothing about canonical-file permissions, confinement, Landlock ABI/enforcement, spawn services (A1), deploy overlap or cross-host writers.

## Compatibility note
Existing tracked callers (470 suite, LIMIT test) use Node `pipe`/`ipc` stdio, which satisfies the stricter layout. The untracked step-0 lab spawns the launcher with plain pipes and would now be refused; it is not executed here.

## Evidence status
Local machine: Windows 11 with no C compiler and no Linux distribution — the launcher was **not compiled** and **no native case was executed** locally. Native evidence requires the required Linux CI gate (`w2-live-adoption-gate`: compile with `-Wall -Wextra -Werror`, `F2_CAPABILITY_REQUIRE_LINUX=1` guard, zero skips).
