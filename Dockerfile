FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
COPY package.json /package.json
RUN npm run build

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    SWITCHBOARD_DATA_DIR=/data \
    SWITCHBOARD_PORT=8770
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY plugins ./plugins
COPY docs ./docs
COPY --from=web /web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/
VOLUME /data
EXPOSE 8770
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8770/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
