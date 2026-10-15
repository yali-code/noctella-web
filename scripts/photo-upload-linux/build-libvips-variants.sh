#!/usr/bin/env bash
# #390 DIAGNOSTIC ONLY: rebuild the exact sharp-libvips recipe used by sharp 0.34.5
# (@img/sharp-libvips-linux-x64 1.2.4 = libvips 8.17.3 + libwebp 1.6.0) twice in one
# toolchain: "unmodified" and "patched" (vips-rgb-free.patch). Then run the webpsave
# path check natively and under valgrind memcheck and require byte-identical outputs.
# Production Sharp/libvips binaries are never modified; outputs go to $1 only.
set -euo pipefail
out="$(mkdir -p "$1" && cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
SHARP_LIBVIPS_SHA=20b5e899954907a3039d6e3d4c200aaa0ec52c4c # tag v1.2.4
VIPS_SHA256=41e9a1439cd57dcc6d4435a085e2cfe181d9da1962fa84a484f09e8b536e4b77 # vips-8.17.3.tar.xz
work="$(mktemp -d)"
sl="$work/sharp-libvips"

git -c advice.detachedHead=false clone --quiet https://github.com/lovell/sharp-libvips.git "$sl"
git -C "$sl" checkout --quiet "$SHARP_LIBVIPS_SHA"
. "$sl/versions.properties"
[ "$VERSION_VIPS" = 8.17.3 ] && [ "$VERSION_WEBP" = 1.6.0 ] || { echo "Unexpected pinned versions"; exit 1; }
curl -sSfL --retry 3 -o "$sl/vips-8.17.3.tar.xz" https://github.com/libvips/libvips/releases/download/v8.17.3/vips-8.17.3.tar.xz
echo "$VIPS_SHA256  $sl/vips-8.17.3.tar.xz" | sha256sum -c -
cp "$here/vips-rgb-free.patch" "$sl/"

# Build-tool-only fix: `cargo install cargo-c --locked` now resolves openssl-sys 0.9.117, which supports
# OpenSSL >= 1.1.0 only, but the pinned Amazon Linux 2 image provides openssl-devel 1.0.2k. Use the distro's
# own openssl11-devel (1.1.1, conflicts with openssl-devel) for that one install. cargo-c only drives the
# librsvg build; no image-processing library links system OpenSSL, and TLS verification is unchanged.
dockerfile="$sl/platforms/linux-x64/Dockerfile"
cp "$dockerfile" "$work/Dockerfile.upstream"
[ "$(grep -cxF '    openssl-devel \' "$dockerfile")" = 1 ] && [ "$(grep -cxF '  cargo install cargo-c --locked && \' "$dockerfile")" = 1 ] || { echo "Toolchain anchors changed"; exit 1; }
CARGO_C_LINE='  OPENSSL_INCLUDE_DIR="$(rpm -ql openssl11-devel | sed -n '"'"'s#/openssl/opensslv.h$##p'"'"')" OPENSSL_LIB_DIR="$(rpm -ql openssl11-devel | sed -n '"'"'s#/libssl.so$##p'"'"')" cargo install cargo-c --locked && \' \
  awk '$0 == "    openssl-devel \\" { print "    openssl11-devel \\"; next } $0 == "  cargo install cargo-c --locked && \\" { print ENVIRON["CARGO_C_LINE"]; next } { print }' "$work/Dockerfile.upstream" > "$dockerfile"
[ "$(diff "$work/Dockerfile.upstream" "$dockerfile" | grep -c '^>')" = 2 ] || { echo "Toolchain fix not applied"; exit 1; }

# Split the pinned recipe: dependencies are built once, the libvips section twice.
posix="$sl/build/posix.sh"
start='mkdir ${DEPS}/vips'
end='copydeps ${VIPS_CPP_DEP} ${TARGET}/lib-filtered'
[ "$(grep -cxF "$start" "$posix")" = 1 ] && [ "$(grep -cxF "$end" "$posix")" = 1 ] && [ "$(grep -cxF 'cd ${DEPS}/vips' "$posix")" = 1 ] || { echo "Recipe anchors changed"; exit 1; }
{
  awk -v s="$start" '$0 == s { exit } { print }' "$posix"
  echo 'cp -a ${TARGET} /target.deps'
  echo 'for variant in unmodified patched; do'
  echo 'rm -rf ${DEPS}/vips ${TARGET} && cp -a /target.deps ${TARGET}'
  echo '('
  awk -v s="$start" -v e="$end" '
    $0 == s { p = 1 }
    p && index($0, "libvips/libvips/releases/download") { print "tar xJC ${DEPS}/vips --strip-components=1 < /packaging/vips-${VERSION_VIPS}.tar.xz"; next }
    p { print }
    p && $0 == "cd ${DEPS}/vips" { print "if [ \"$variant\" = patched ]; then patch -p1 --no-backup-if-mismatch < /packaging/vips-rgb-free.patch; fi" }
    $0 == e { exit }' "$posix"
  echo ')'
  echo 'mkdir -p /packaging/out/$variant && cp ${TARGET}/lib-filtered/${VIPS_CPP_DEP} /packaging/out/$variant/'
  echo 'if [ "$variant" = unmodified ]; then cp -a ${TARGET}/include /packaging/out/include && cp -a ${TARGET}/lib-filtered/glib-2.0 /packaging/out/glib-2.0; fi'
  echo 'done'
  echo 'chmod -R a+rX /packaging/out'
} > "$sl/variants.sh"
[ "$(grep -c 'vips-rgb-free.patch' "$sl/variants.sh")" = 1 ] && [ "$(grep -c '< /packaging/vips-${VERSION_VIPS}.tar.xz' "$sl/variants.sh")" = 1 ] || { echo "Variant script generation failed"; exit 1; }

docker build --pull -t vips-dev-linux-x64 "$sl/platforms/linux-x64"
docker run --rm -v "$sl:/packaging" vips-dev-linux-x64 bash /packaging/variants.sh

cp -r "$sl/out/unmodified" "$sl/out/patched" "$out/"
{
  echo "sharp-libvips $SHARP_LIBVIPS_SHA (v1.2.4)"
  echo "vips tarball sha256 $VIPS_SHA256"
  echo "patch sha256 $(sha256sum "$here/vips-rgb-free.patch" | cut -d' ' -f1)"
  echo "variants.sh sha256 $(sha256sum "$sl/variants.sh" | cut -d' ' -f1)"
  echo "build image base $(docker image inspect --format '{{json .RepoDigests}}' amazonlinux:2)"
  echo "toolchain Dockerfile change (build tools only):"
  diff "$work/Dockerfile.upstream" "$dockerfile" || true
  docker run --rm vips-dev-linux-x64 bash -c 'cc --version | head -1; rustc --version; meson --version; cargo cinstall --version; rpm -q openssl11-devel openssl11-libs'
  cat "$sl/versions.properties"
  sha256sum "$out"/unmodified/* "$out"/patched/*
} > "$out/provenance.txt"
cp "$sl/variants.sh" "$out/variants.sh"

# Native memory-safety and parity check of the touched webpsave paths.
docker run --rm -e VIPS_CONCURRENCY=1 -v "$sl/out:/out" -v "$here:/src:ro" debian:bookworm-slim bash -euo pipefail -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libc6-dev valgrind > /dev/null
  gcc -O1 -g -Wall -Wextra -Werror -I/out/include -I/out/include/glib-2.0 -I/out/glib-2.0/include -o /tmp/check /src/vips-variant-check.c -L/out/unmodified -l:libvips-cpp.so.8.17.3
  for v in unmodified patched; do
    mkdir -p /out/check/$v /out/check/$v-valgrind
    LD_LIBRARY_PATH=/out/$v /tmp/check /out/check/$v
    LD_LIBRARY_PATH=/out/$v valgrind --tool=memcheck --leak-check=no --log-file=/out/check/$v-valgrind.log /tmp/check /out/check/$v-valgrind
    grep "ERROR SUMMARY" /out/check/$v-valgrind.log
    if grep -qE "Invalid (read|write|free)|Mismatched free|Source and destination overlap|Process terminating" /out/check/$v-valgrind.log; then echo "MEMCHECK FAIL $v"; exit 1; fi
  done
  for f in /out/check/unmodified/*.webp; do n=$(basename $f); cmp $f /out/check/patched/$n; cmp $f /out/check/unmodified-valgrind/$n; cmp $f /out/check/patched-valgrind/$n; done
  (cd /out/check && sha256sum */*.webp) > /out/check/sha256.txt
  valgrind --version >> /out/check/sha256.txt
  chmod -R a+rX /out/check'
mkdir -p "$out/check" && cp "$sl/out/check/"*.log "$sl/out/check/sha256.txt" "$out/check/"
echo "VARIANTS_OK"
