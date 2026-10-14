#!/usr/bin/env bash
# Offline codec-only comparison. Does not run or replace API acceptance.
set -euo pipefail
root="$RUNNER_TEMP/photo-codec-evidence"
mkdir -p "$root/control" "$root/low-memory"
image=noctella-photo-upload:isolated
wide() {
  docker run --rm --network none --memory 2g --memory-swap 2g --cpus 1 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --read-only --user "$(id -u):$(id -g)" --mount "type=bind,src=$root,dst=/codec" --mount "type=bind,src=$RUNNER_TEMP/photo-fixtures,dst=/fixtures,readonly" "$image" node scripts/photo-upload-linux/codec-fixture.cjs "$1"
}
wide prepare
for mode in 0 1; do
  label=control; if [ "$mode" = 1 ]; then label=low-memory; fi
  name="noctella-photo-codec-$label-$GITHUB_RUN_ID"
  docker create --name "$name" --network none --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --read-only --user "$(id -u):$(id -g)" --mount "type=bind,src=$root/$label,dst=/codec" --mount "type=bind,src=$root/input.rgb,dst=/codec/input.rgb,readonly" "$image" sleep infinity
  docker start "$name"
  docker inspect "$name" > "$root/$label/container.json"
  pid=$(docker inspect --format '{{.State.Pid}}' "$name")
  cg=$(awk -F: '$1 == "0" {print $3}' "/proc/$pid/cgroup")
  for file in memory.max memory.swap.max memory.current memory.peak memory.events; do cat "/sys/fs/cgroup$cg/$file" > "$root/$label/before-$file.txt"; done
  set +e
  timeout --kill-after=5s 120s docker exec "$name" /app/scripts/photo-upload-linux/codec-probe "$mode" /codec/input.rgb /codec/output.webp > "$root/$label/result.json" 2> "$root/$label/stderr.txt"
  code=$?
  set -e
  echo "$code" > "$root/$label/exit-code.txt"
  for file in memory.max memory.swap.max memory.current memory.peak memory.events; do cat "/sys/fs/cgroup$cg/$file" > "$root/$label/after-$file.txt"; done
  docker cp "$name:/opt/codec-configure.log" "$root/$label/configure.txt"
  docker cp "$name:/opt/codec-compiler.txt" "$root/$label/compiler.txt"
  docker rm --force "$name"
done
wide compare
du -ak "$root" > "$root/disk.txt"
