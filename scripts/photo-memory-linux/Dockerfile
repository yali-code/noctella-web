FROM node:20.20.0-bookworm-slim
WORKDIR /app
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY harness/ ./scripts/photo-memory-linux/
COPY source/ ./apps/api/src/
ENV NODE_ENV=test TMPDIR=/work/tmp TMP=/work/tmp TEMP=/work/tmp PRODUCT_PHOTO_DIR=/work/photos
CMD ["sleep", "infinity"]
