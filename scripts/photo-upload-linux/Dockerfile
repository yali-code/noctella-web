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
ENV NODE_ENV=test TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp PRODUCT_PHOTO_DIR=/work/photos
CMD ["sleep", "infinity"]
