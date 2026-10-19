#!/usr/bin/env bash
# Stage 5 F2 closure Stage 1 — STAGING resource sampler for protected mode. Reads the service's cgroup v2 counters (the
# whole API + confined-preparer process tree shares the container cgroup) every 250 ms until stopped (Ctrl-C), then
# prints a summary judged by the EXISTING accepted thresholds (scripts/photo-upload-linux/policy.mjs):
#   memory.max == 512 MiB, memory.swap.max == 0, memory.peak <= 384 MiB (TARGET_BYTES), and no new oom / oom_kill /
#   max events. Per-process VmRSS/VmHWM of node and landlock-worker processes is supplementary only.
# Read-only: it reads /sys/fs/cgroup and /proc; it writes only to stdout.
set -u
CG=/sys/fs/cgroup
for f in memory.current memory.peak memory.max memory.events; do [ -r "$CG/$f" ] || { echo "SAMPLE INCONCLUSIVE: $CG/$f unreadable (cgroup v2 namespace not visible)"; exit 3; }; done
ev() { awk -v k="$1" '$1==k{print $2}' "$CG/memory.events"; }
start_oom=$(ev oom); start_kill=$(ev oom_kill); start_max=$(ev max); start_peak=$(cat "$CG/memory.peak")
echo "SAMPLE_START max=$(cat $CG/memory.max) swap_max=$(cat $CG/memory.swap.max 2>/dev/null || echo n/a) peak_at_start=$start_peak"
summary() {
  peak=$(cat "$CG/memory.peak"); max=$(cat "$CG/memory.max"); swap=$(cat "$CG/memory.swap.max" 2>/dev/null || echo n/a)
  d_oom=$(( $(ev oom) - start_oom )); d_kill=$(( $(ev oom_kill) - start_kill )); d_max=$(( $(ev max) - start_max ))
  verdict=PASS
  [ "$max" = "536870912" ] && [ "$swap" = "0" ] || verdict=INCONCLUSIVE
  [ "$peak" -le 402653184 ] || verdict=FAIL
  [ "$d_oom" -eq 0 ] && [ "$d_kill" -eq 0 ] && [ "$d_max" -eq 0 ] || verdict=FAIL
  # memory.peak is a lifetime high-water mark; a peak_at_start above the target makes the run INCONCLUSIVE (restart first).
  [ "$start_peak" -le 402653184 ] || { [ "$verdict" = PASS ] && verdict=INCONCLUSIVE; }
  echo "SAMPLE_SUMMARY verdict=$verdict peak=$peak target=402653184 max=$max swap_max=$swap d_oom=$d_oom d_oom_kill=$d_kill d_max=$d_max"
  exit 0
}
trap summary INT TERM
while :; do
  rss=$(for p in /proc/[0-9]*; do n=$(cat "$p/comm" 2>/dev/null) || continue; case "$n" in node|landlock-worke*) awk -v n="$n" '/^VmRSS|^VmHWM/{printf "%s:%s=%s ", n, $1, $2}' "$p/status" 2>/dev/null;; esac; done)
  echo "SAMPLE t=$(date +%s.%N) current=$(cat $CG/memory.current) peak=$(cat $CG/memory.peak) oom=$(ev oom) oom_kill=$(ev oom_kill) max=$(ev max) $rss"
  sleep 0.25
done
