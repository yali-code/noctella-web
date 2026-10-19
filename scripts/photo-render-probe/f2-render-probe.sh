#!/usr/bin/env bash
# Stage 5 F2 (#472) owner-run target probe: hardlink support and ACTUAL Landlock enforcement of the reviewed launcher.
#
#   bash f2-render-probe.sh <probe-root> [canonical-dir]
#
#   <probe-root>    an EMPTY-except-"pkg" directory named <parent>/f2-probe-<uuid> that the owner created with
#                   `mkdir -m 700` (refuses existing). Everything this script creates or executes lives beneath it.
#   [canonical-dir] default /var/data/product-photos. ONLY stat()ed (no -L) to compare filesystem identity;
#                   it is never read, listed, created, modified or deleted.
#
# Mutations: only beneath <probe-root>; the whole <probe-root> is removed at the end after path and inode checks.
# No sudo, installs, chmod/chown of existing files, env changes, network, database or API access. Nothing from the
# environment is printed. Output: PROBE_* lines and a final F2_PROBE_VERDICT PASS|FAIL|BLOCKED.
set -euo pipefail
umask 077
export LC_ALL=C

EXPECTED_LAUNCHER_SHA256="ad1d58ec71b28696711d8808bc011eb0ba1fe94984cdf3d7e2947ce5bfe4e47a"
ROOT="${1:-}"
CANONICAL="${2:-/var/data/product-photos}"
VERDICT="PASS"
fail() { echo "PROBE_FAIL $*"; VERDICT="FAIL"; }
block() { echo "PROBE_BLOCKED $*"; [ "$VERDICT" = "FAIL" ] || VERDICT="BLOCKED"; }
say() { echo "PROBE_$*"; }

# ---------- 1. root identity (refuse anything unexpected; never follow symlinks) ----------
case "$ROOT" in
  /*/f2-probe-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "PROBE_REFUSED root must be <parent>/f2-probe-<uuid>"; echo "F2_PROBE_VERDICT FAIL"; exit 2 ;;
esac
if [ -L "$ROOT" ] || [ ! -d "$ROOT" ]; then echo "PROBE_REFUSED root is a symlink or not a directory"; echo "F2_PROBE_VERDICT FAIL"; exit 2; fi
if [ "$(stat -c %u -- "$ROOT")" != "$(id -u)" ]; then echo "PROBE_REFUSED root not owned by the current user"; echo "F2_PROBE_VERDICT FAIL"; exit 2; fi
if [ "$(id -u)" = "0" ]; then echo "PROBE_REFUSED must not run as root"; echo "F2_PROBE_VERDICT FAIL"; exit 2; fi
unexpected="$(find "$ROOT" -mindepth 1 -maxdepth 1 ! -name pkg -printf '%f\n' | head -1)"
if [ -n "$unexpected" ]; then echo "PROBE_REFUSED root is not fresh (unexpected entry)"; echo "F2_PROBE_VERDICT FAIL"; exit 2; fi
ROOT_ID="$(stat -c '%d:%i' -- "$ROOT")"
PKG="$ROOT/pkg"

cleanup() {
  # Remove ONLY the probe-owned root, after re-checking its path pattern, type and exact identity.
  if [ -n "${ROOT:-}" ] && [ -d "$ROOT" ] && [ ! -L "$ROOT" ] && [ "$(stat -c '%d:%i' -- "$ROOT")" = "$ROOT_ID" ]; then
    rm -rf --one-file-system -- "$ROOT" && echo "PROBE_CLEANUP removed probe root" || echo "PROBE_CLEANUP FAILED (remove $ROOT manually)"
  else
    echo "PROBE_CLEANUP SKIPPED identity mismatch (nothing removed)"
  fi
}
# Any unexpected error (set -e) is a FAIL, never a PASS.
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$VERDICT" = "PASS" ]; then VERDICT="FAIL"; echo "PROBE_FAIL unexpected error (exit $rc)"; fi; echo "F2_PROBE_VERDICT $VERDICT"; cleanup' EXIT

say "HOST kernel=$(uname -r) arch=$(uname -m) uid=$(id -u) gid=$(id -g)"

# ---------- 2. package integrity (reviewed launcher source) ----------
for f in landlock-worker.c probe-parent.cjs probe-worker.cjs; do [ -f "$PKG/$f" ] && [ ! -L "$PKG/$f" ] || { fail "package file missing: $f"; exit 1; }; done
SRC_SHA="$(sha256sum -- "$PKG/landlock-worker.c" | cut -d' ' -f1)"
say "SOURCE landlock-worker.c sha256=$SRC_SHA expected=$EXPECTED_LAUNCHER_SHA256"
[ "$SRC_SHA" = "$EXPECTED_LAUNCHER_SHA256" ] || { fail "launcher source hash mismatch"; exit 1; }
say "PACKAGE probe-parent.cjs sha256=$(sha256sum -- "$PKG/probe-parent.cjs" | cut -d' ' -f1)"
say "PACKAGE probe-worker.cjs sha256=$(sha256sum -- "$PKG/probe-worker.cjs" | cut -d' ' -f1)"

# ---------- 3. tool inventory (no installs) ----------
CC=""; for c in cc gcc clang; do if command -v "$c" >/dev/null 2>&1; then CC="$c"; break; fi; done
NODE="$(command -v node || true)"
say "TOOLS cc=${CC:-absent} node=$( [ -n "$NODE" ] && echo present || echo absent) node_version=$( [ -n "$NODE" ] && node --version || echo n/a)"
[ -n "$CC" ] && say "TOOLS cc_version=$("$CC" --version 2>/dev/null | head -1)"
[ -n "$CC" ] && { if printf '#include <linux/landlock.h>\nint main(void){return 0;}\n' | "$CC" -x c -fsyntax-only - 2>/dev/null; then say "TOOLS landlock_header=present"; else say "TOOLS landlock_header=absent"; fi; }

# ---------- 4. filesystem identity (stat only; canonical never touched otherwise) ----------
if [ -e "$CANONICAL" ] || [ -L "$CANONICAL" ]; then
  CAN="$(stat -c '%d %F %u:%g %a' -- "$CANONICAL")"
  ROOT_DEV="${ROOT_ID%%:*}"; CAN_DEV="${CAN%% *}"
  say "FS root_dev=$ROOT_DEV canonical='$CAN' fstype=$(stat -f -c %T -- "$ROOT")"
  case "$CAN" in *"directory"*) ;; *) fail "canonical is not a plain directory (symlink or other): $CAN" ;; esac
  [ "$ROOT_DEV" = "$CAN_DEV" ] && say "FS same_device=yes" || fail "probe root and canonical are on different devices"
else
  fail "canonical directory not found"
fi

# ---------- 5. hardlink between disposable files ----------
HL="$ROOT/hardlink"; mkdir -m 700 -- "$HL"
NONCE="$(cat /proc/sys/kernel/random/uuid)"
printf 'f2-probe-%s' "$NONCE" > "$HL/a"
if ln -- "$HL/a" "$HL/b" 2>/dev/null; then
  A="$(stat -c '%d:%i:%h' -- "$HL/a")"; B="$(stat -c '%d:%i:%h' -- "$HL/b")"
  if [ "$A" = "$B" ] && [ "${A##*:}" = "2" ] && cmp -s -- "$HL/a" "$HL/b"; then say "HARDLINK PASS dev:ino:nlink=$A"; else fail "hardlink identity/content mismatch a=$A b=$B"; fi
else
  fail "hardlink creation failed"
fi
rm -f -- "$HL/a" "$HL/b"; rmdir -- "$HL"

# ---------- 6. build the reviewed launcher inside the probe root ----------
BIN="$ROOT/bin/landlock-worker"; mkdir -m 700 -- "$ROOT/bin"
if [ -z "$CC" ]; then
  block "no C compiler on the target; see README 'Alternative build' (nothing installed)"
elif ! "$CC" -std=c11 -Wall -Wextra -Werror -O2 "$PKG/landlock-worker.c" -o "$BIN" 2>"$ROOT/bin/cc.log"; then
  block "launcher did not compile with -Wall -Wextra -Werror ($(head -3 "$ROOT/bin/cc.log" | tr '\n' ' ' | cut -c1-240))"
else
  say "BINARY landlock-worker sha256=$(sha256sum -- "$BIN" | cut -d' ' -f1)"
fi

# ---------- 7. actual Landlock enforcement through the trusted parent ----------
if [ -x "$BIN" ] && [ -n "$NODE" ]; then
  if node "$PKG/probe-parent.cjs" "$BIN" "$ROOT" "$PKG/probe-worker.cjs"; then :; else fail "Landlock enforcement not demonstrated"; fi
elif [ -z "$NODE" ]; then
  block "node not available for the trusted parent"
else
  block "launcher binary unavailable; enforcement not tested"
fi

case "$VERDICT" in PASS) exit 0 ;; BLOCKED) exit 3 ;; *) exit 1 ;; esac
