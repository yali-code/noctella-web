FROM node:20.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ cmake && rm -rf /var/lib/apt/lists/*
# #390 DIAGNOSTIC allocators only (selected per scenario via LD_PRELOAD; acceptance rejects these overrides).
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 libmimalloc2.0 && rm -rf /var/lib/apt/lists/* && mkdir /opt/alloc && ln -s "$(ls /usr/lib/*/libjemalloc.so.2 | head -1)" /opt/alloc/libjemalloc.so && ln -s "$(ls /usr/lib/*/libmimalloc.so.2* | head -1)" /opt/alloc/libmimalloc.so && dpkg-query -W libjemalloc2 libmimalloc2.0 > /opt/alloc/provenance.txt && sha256sum "$(readlink -f /opt/alloc/libjemalloc.so)" "$(readlink -f /opt/alloc/libmimalloc.so)" >> /opt/alloc/provenance.txt && for lib in jemalloc mimalloc; do LD_PRELOAD=/opt/alloc/lib$lib.so node -e "const m=require('fs').readFileSync('/proc/self/maps','utf8');if(!m.includes('$lib'))process.exit(1);Buffer.alloc(64<<20).fill(1)"; done
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund && npm_config_nodedir=/usr/local npm rebuild better-sqlite3 esbuild sharp
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/scripts ./apps/api/scripts
COPY apps/api/src ./apps/api/src
COPY packages/shared ./packages/shared
RUN npm run build -w packages/shared && npm run build -w apps/api
COPY scripts/photo-upload-linux ./scripts/photo-upload-linux
RUN gcc -shared -fPIC -O2 -Wall -Wextra -Werror -o scripts/photo-upload-linux/native-alloc.so scripts/photo-upload-linux/native-alloc.c -ldl
RUN gcc -O2 -Wall -Wextra -Werror -o /tmp/native-alloc-smoke scripts/photo-upload-linux/native-alloc-smoke.c && mkdir /evidence && /tmp/native-alloc-smoke && test ! -e /evidence/native-alloc.ndjson && LD_PRELOAD=/app/scripts/photo-upload-linux/native-alloc.so NOCTELLA_NATIVE_TRACE=synthetic-only /tmp/native-alloc-smoke && node scripts/photo-upload-linux/native-alloc-smoke.cjs && rm -rf /evidence /tmp/native-alloc-smoke
# #390 DIAGNOSTIC libvips variants (only populated for native-rgbfree profiles). The npm binary stays in place;
# a variant is selected per scenario by SONAME preload, verified here and again in the measured process.
COPY vips-variants /opt/vips-variants
RUN sha256sum apps/api/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3 $(find /opt/vips-variants -name 'libvips-cpp.so.*') > /opt/vips-variants-provenance.txt && for v in $(ls /opt/vips-variants); do LD_PRELOAD=/opt/vips-variants/$v/libvips-cpp.so.8.17.3 node -e "const s=require('module').createRequire('/app/apps/api/package.json')('sharp');const m=require('fs').readFileSync('/proc/self/maps','utf8');if(!m.includes('/opt/vips-variants/$v/libvips-cpp')||m.includes('sharp-libvips-linux-x64/lib/libvips-cpp')||s.versions.vips!=='8.17.3')process.exit(1)"; done
ENV NODE_ENV=test TSX_DISABLE_CACHE=1 TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp PRODUCT_PHOTO_DIR=/work/photos
CMD ["sleep", "infinity"]
ADD --checksum=sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564 https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz /tmp/libwebp.tar.gz
RUN mkdir /tmp/codec-src && tar xzf /tmp/libwebp.tar.gz -C /tmp/codec-src --strip-components=1 && cmake -S /tmp/codec-src -B /tmp/codec-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/codec -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF > /opt/codec-configure.log && cmake --build /tmp/codec-build -j2 > /opt/codec-build.log && cmake --install /tmp/codec-build > /opt/codec-install.log
RUN gcc -O2 -Wall -Wextra -Werror -I/opt/codec/include -o scripts/photo-upload-linux/codec-probe scripts/photo-upload-linux/codec-probe.c /opt/codec/lib/libwebp.a /opt/codec/lib/libsharpyuv.a -lm -lpthread && gcc --version > /opt/codec-compiler.txt
RUN sha256sum /tmp/libwebp.tar.gz /opt/codec/lib/libwebp.a /opt/codec/lib/libsharpyuv.a scripts/photo-upload-linux/codec-probe > /opt/codec-provenance.txt && ldd scripts/photo-upload-linux/codec-probe >> /opt/codec-provenance.txt && cat /tmp/codec-build/CMakeCache.txt >> /opt/codec-provenance.txt
