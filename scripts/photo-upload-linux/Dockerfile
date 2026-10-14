FROM node:20.20.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
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
ENV NODE_ENV=test TSX_DISABLE_CACHE=1 TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp PRODUCT_PHOTO_DIR=/work/photos
CMD ["sleep", "infinity"]
ADD --checksum=sha256:e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564 https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz /tmp/libwebp.tar.gz
RUN mkdir /tmp/codec-src && tar xzf /tmp/libwebp.tar.gz -C /tmp/codec-src --strip-components=1 && cd /tmp/codec-src && test "$(uname -m)" = x86_64 && ./configure --build=x86_64-pc-linux-gnu --disable-shared --enable-static --prefix=/opt/codec > /opt/codec-configure.log && make -j2 > /opt/codec-build.log && make install > /opt/codec-install.log
RUN gcc -O2 -Wall -Wextra -Werror -I/opt/codec/include -o scripts/photo-upload-linux/codec-probe scripts/photo-upload-linux/codec-probe.c /opt/codec/lib/libwebp.a /opt/codec/lib/libsharpyuv.a -lm -lpthread && gcc --version > /opt/codec-compiler.txt
RUN sha256sum /tmp/libwebp.tar.gz /opt/codec/lib/libwebp.a /opt/codec/lib/libsharpyuv.a scripts/photo-upload-linux/codec-probe > /opt/codec-provenance.txt && ldd scripts/photo-upload-linux/codec-probe >> /opt/codec-provenance.txt && grep -E "^(CFLAGS|CPPFLAGS|LDFLAGS|CC) =" /tmp/codec-src/Makefile >> /opt/codec-provenance.txt
