FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production \
    HUB_DATA_DIR=/data \
    HUB_PORT=8770
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY plugins ./plugins
COPY docs ./docs
COPY --from=web /web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/
VOLUME /data
EXPOSE 8770
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8770/healthz >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
