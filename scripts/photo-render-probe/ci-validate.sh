#!/usr/bin/env bash
# DISPOSABLE validation of the F2 Render probe package on a CI/Linux machine (NOT Render evidence).
# Builds a stand-in "/var/data" in a temp dir with a canonical directory holding one existing file, runs the real
# probe exactly as the owner would, and asserts: PASS verdict, actual denial, canonical untouched, probe root removed.
# Also asserts the refusals: non-fresh root, symlinked root, tampered launcher source, symlinked canonical.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
PARENT="$(mktemp -d)"; trap 'rm -rf -- "$PARENT"' EXIT
CANON="$PARENT/product-photos"; mkdir "$CANON"; printf 'existing product photo bytes' > "$CANON/existing.webp"
snapshot() { (cd "$CANON" && find . -printf '%p %i %s %m\n' | sort && sha256sum existing.webp); }
BEFORE="$(snapshot)"

stage() { # owner bootstrap: fresh root + pkg with the reviewed files
  local r="$PARENT/f2-probe-$(cat /proc/sys/kernel/random/uuid)"
  mkdir -m 700 -- "$r"; mkdir -m 700 -- "$r/pkg"
  cp -- "$REPO/scripts/photo-publication-capability/landlock-worker.c" "$HERE/probe-parent.cjs" "$HERE/probe-worker.cjs" "$r/pkg/"
  echo "$r"
}
expect() { if ! grep -qE "$1" <<<"$2"; then echo "CI_VALIDATE FAIL: expected /$1/"; echo "$2"; exit 1; fi; }

# 1. Real run.
R="$(stage)"
OUT="$(bash "$HERE/f2-render-probe.sh" "$R" "$CANON" || true)"; echo "$OUT"
expect '^F2_PROBE_VERDICT PASS$' "$OUT"
expect '^PROBE_HARDLINK PASS ' "$OUT"
expect '^PROBE_FS same_device=yes$' "$OUT"
expect '^PROBE_CHECK PASS control.unconfined-write-succeeds' "$OUT"
expect '^PROBE_CHECK PASS launcher.reported-abi>=3 abi=[3-9]' "$OUT"
expect '^PROBE_CHECK PASS worker.ran-with-fresh-nonce' "$OUT"
expect '^PROBE_CHECK PASS allowed.write-succeeded' "$OUT"
expect '^PROBE_CHECK PASS sibling.in-place-write-denied (EACCES|EPERM)' "$OUT"
expect '^PROBE_CHECK PASS sibling.bytes-unchanged' "$OUT"
expect '^PROBE_CHECK PASS sibling.create-denied' "$OUT"
expect '^PROBE_CLEANUP removed probe root$' "$OUT"
[ ! -e "$R" ] || { echo "CI_VALIDATE FAIL: probe root not removed"; exit 1; }
[ "$BEFORE" = "$(snapshot)" ] || { echo "CI_VALIDATE FAIL: canonical directory changed"; exit 1; }
if grep -qiE 'DATABASE_URL|PASSWORD|SECRET|TOKEN=' <<<"$OUT"; then echo "CI_VALIDATE FAIL: environment leaked"; exit 1; fi

# 2. Refusals (each leaves everything except its own staged root untouched).
R="$(stage)"; touch "$R/stray"
OUT="$(bash "$HERE/f2-render-probe.sh" "$R" "$CANON" || true)"; expect '^PROBE_REFUSED root is not fresh' "$OUT"; [ -e "$R/stray" ] || { echo "CI_VALIDATE FAIL: refused run removed files"; exit 1; }
rm -rf -- "$R"
R="$(stage)"; L="$PARENT/f2-probe-$(cat /proc/sys/kernel/random/uuid)"; ln -s "$R" "$L"
OUT="$(bash "$HERE/f2-render-probe.sh" "$L" "$CANON" || true)"; expect '^PROBE_REFUSED root is a symlink' "$OUT"; [ -d "$R/pkg" ] || { echo "CI_VALIDATE FAIL: symlink target touched"; exit 1; }
rm -f -- "$L"; rm -rf -- "$R"
R="$(stage)"; printf '\n/* tampered */\n' >> "$R/pkg/landlock-worker.c"
OUT="$(bash "$HERE/f2-render-probe.sh" "$R" "$CANON" || true)"; expect '^PROBE_FAIL launcher source hash mismatch' "$OUT"; expect '^F2_PROBE_VERDICT FAIL$' "$OUT"
R="$(stage)"; LINKED="$PARENT/linked-canonical"; ln -s "$CANON" "$LINKED"
OUT="$(bash "$HERE/f2-render-probe.sh" "$R" "$LINKED" || true)"; expect '^PROBE_FAIL canonical is not a plain directory' "$OUT"; expect '^F2_PROBE_VERDICT FAIL$' "$OUT"
[ "$BEFORE" = "$(snapshot)" ] || { echo "CI_VALIDATE FAIL: canonical directory changed"; exit 1; }
echo "CI_VALIDATE PASS (disposable CI environment; not Render evidence)"
