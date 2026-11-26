# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data APP_VERSION=$APP_VERSION NODE_NO_WARNINGS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
