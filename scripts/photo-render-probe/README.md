# F2 Render probe — owner-run, NOT executed by engineering

This probe establishes two facts on the Render target that offline CI cannot:
- hard links work on the attached disk, in the same filesystem as `/var/data/product-photos`;
- the reviewed Landlock launcher actually confines a worker on the target kernel (ABI ≥ 3).

Running it requires separate written authorization from the owner. Nothing here deploys, activates, migrates or changes the service.

## Files
| File | Purpose |
| --- | --- |
| `scripts/photo-publication-capability/landlock-worker.c` | Reviewed launcher (unchanged). sha256 `ad1d58ec71b28696711d8808bc011eb0ba1fe94984cdf3d7e2947ce5bfe4e47a`, git blob `d723511984c9f3825f888b6db5d75f92e5b5e4fa`; identical in `dae08c43` and `24a16b8e`. |
| `scripts/photo-render-probe/f2-render-probe.sh` | Orchestrator: root checks, tool inventory, filesystem identity (stat only), hardlink, build, Landlock run, report, cleanup |
| `scripts/photo-render-probe/probe-parent.cjs` | Trusted parent. Starts the launcher in plain mode with the descriptor layout it validates: fd 0 `/dev/null`, fd 1/2 AF_UNIX sockets from this parent, nothing else. Runs an unconfined sensitivity control first |
| `scripts/photo-render-probe/probe-worker.cjs` | The worker. Writes only the disposable paths it is given and prints one JSON line |
| `scripts/photo-render-probe/ci-validate.sh` | Disposable CI validation, not Render evidence |

## What the probe mutates
**Only `/var/data/f2-probe-<uuid>`**, created by the bootstrap below, and the files beneath it:
- `pkg/` — the downloaded package;
- `hardlink/a` and `hardlink/b`;
- `bin/landlock-worker` and `bin/cc.log`;
- `control/…` and `confined/…`, each holding `allowed/` and `sibling/victim.bin`.

At the end it removes exactly that root. Removal happens only if the path matches `f2-probe-<uuid>`, the root is not a symlink, and its device:inode equals the value recorded at start (`rm -rf --one-file-system`).

`/var/data/product-photos` is only `stat`ed (device, type, owner, mode). It is never read, listed, created, modified or deleted.

The probe makes no network, database, API, environment or service changes, uses no sudo, and installs nothing. Output never contains environment variables.

## Pinned hashes (sha256 of the git blobs, LF)
| File | sha256 |
| --- | --- |
| `landlock-worker.c` | `ad1d58ec71b28696711d8808bc011eb0ba1fe94984cdf3d7e2947ce5bfe4e47a` |
| `f2-render-probe.sh` | `65807906bea970518c259d5efcfa7e37aa8ac15cb9bc76e4d706bcef3546e857` |
| `probe-parent.cjs` | `c22917eb3ad64301710235b353609f6c67814253ceae56c1b515d495941b48ec` |
| `probe-worker.cjs` | `edb038dec4a158a8825ec28de921dc6d23e9dc5044cdef6b87774a5f451ab69c` |

## Owner-run commands (Render shell of `srv-db34390m7kps73cv8l6g`)
Replace `<COMMIT>` with the pushed, reviewed commit of this package. The expected hashes are in the table under "Pinned hashes".

```sh
set -eu
U=$(cat /proc/sys/kernel/random/uuid); R=/var/data/f2-probe-$U
mkdir -m 700 "$R" && mkdir -m 700 "$R/pkg"        # refuses an existing path
C=<COMMIT>; B=https://raw.githubusercontent.com/yali-code/noctella-web/$C
for f in scripts/photo-publication-capability/landlock-worker.c scripts/photo-render-probe/f2-render-probe.sh \
         scripts/photo-render-probe/probe-parent.cjs scripts/photo-render-probe/probe-worker.cjs; do
  curl -fsSL "$B/$f" -o "$R/pkg/$(basename "$f")"
done
( cd "$R/pkg" && sha256sum -c - <<'EOF'
ad1d58ec71b28696711d8808bc011eb0ba1fe94984cdf3d7e2947ce5bfe4e47a  landlock-worker.c
65807906bea970518c259d5efcfa7e37aa8ac15cb9bc76e4d706bcef3546e857  f2-render-probe.sh
c22917eb3ad64301710235b353609f6c67814253ceae56c1b515d495941b48ec  probe-parent.cjs
edb038dec4a158a8825ec28de921dc6d23e9dc5044cdef6b87774a5f451ab69c  probe-worker.cjs
EOF
)                                                  # STOP if any line is not "OK"
bash "$R/pkg/f2-render-probe.sh" "$R"; echo "exit=$?"
ls -ld "$R" 2>&1 || true                           # expected: No such file or directory
```

If `curl` is absent, fetch each file with Node instead:

```sh
node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw r.status;return r.text()}).then(t=>require('fs').writeFileSync(process.argv[2],t,{flag:'wx'}))" "$B/$f" "$R/pkg/$(basename "$f")"
```

The `sha256sum -c` check is mandatory before anything is executed.

If the probe stopped early and `$R` still exists, clean up manually after checking it is the probe root:

```sh
case "$R" in /var/data/f2-probe-*) [ ! -L "$R" ] && rm -rf --one-file-system -- "$R";; esac
```

## Expected output (PASS)
```
PROBE_HOST kernel=6.8.0-1051-aws arch=x86_64 uid=1000 gid=1000
PROBE_SOURCE landlock-worker.c sha256=ad1d58ec… expected=ad1d58ec…
PROBE_TOOLS cc=<cc|gcc|clang> node=present node_version=v…
PROBE_TOOLS landlock_header=present
PROBE_FS root_dev=66317 canonical='66317 directory 1000:1000 2755' fstype=ext2/ext3
PROBE_FS same_device=yes
PROBE_HARDLINK PASS dev:ino:nlink=66317:<ino>:2
PROBE_BINARY landlock-worker sha256=<hash of the binary built on the target>
PROBE_CHECK PASS control.worker-ran …
PROBE_CHECK PASS control.unconfined-write-succeeds WRITTEN
PROBE_CHECK PASS launcher.exit-0 code=0 signal=null
PROBE_CHECK PASS launcher.reported-abi>=3 abi=<n>
PROBE_CHECK PASS worker.ran-with-fresh-nonce pid=…
PROBE_CHECK PASS allowed.write-succeeded WRITTEN
PROBE_CHECK PASS sibling.in-place-write-denied EACCES
PROBE_CHECK PASS sibling.bytes-unchanged sha256 compared
PROBE_CHECK PASS sibling.create-denied EACCES
PROBE_LANDLOCK PASS abi=<n>
F2_PROBE_VERDICT PASS
PROBE_CLEANUP removed probe root
```

`stat -f` reports ext4 as `ext2/ext3`.

## Acceptance
**PASS** requires every `PROBE_CHECK` to be PASS, plus `HARDLINK PASS`, `same_device=yes`, a matching source hash, `abi ≥ 3`, and the root being removed. Enforcement is proven by several checks together, not by the `LANDLOCK_ENFORCED` marker alone:
- the worker actually ran (fresh nonce);
- its allowed write exists with that nonce;
- both the in-place write and the create in the sibling were denied;
- the victim's sha256 is unchanged;
- the unconfined control *can* write, so the denial is not a file-permission artifact.

**FAIL** means any of these is false; the reason is on a `PROBE_FAIL` line.

**BLOCKED** means no C compiler, no `linux/landlock.h`, or no `node` on the target. Nothing is installed.

### Alternative build if BLOCKED
Both alternatives need separate approval:
1. **Compile during the Render build.** Same image family as runtime, and this would be the eventual release path. The build command would gain `cc -std=c11 -Wall -Wextra -Werror -O2 scripts/photo-publication-capability/landlock-worker.c -o <path>`. That is a service build change, so it needs deployment authorization.
2. **Build a static binary in GitHub Actions** from the pinned reviewed source (`-static`), and publish its sha256 with the workflow run as provenance. The owner then downloads that exact artifact and verifies its hash before placing it under `$R/bin/`.

## Assumptions not yet verified on the target
- `bash`, `stat`/`find`/`sha256sum` (GNU coreutils), `node`, and `curl` or Node `fetch` exist in the Render shell.
- A C compiler and kernel UAPI headers exist. If they don't, the probe reports BLOCKED.
- Landlock is enabled in the kernel's LSM list. If not, the launcher prints `LANDLOCK_ABI_3_REQUIRED`, and the probe reports FAIL with that reason.
- The shell runs as UID 1000. The probe refuses to run as root.

## Evidence classes
The CI job `F2 Render probe package — disposable validation` runs `ci-validate.sh` on a GitHub-hosted runner, against a stand-in `/var/data`. Its result validates the **package**, not Render. Only the owner-run output above is **target evidence**.
