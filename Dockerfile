# --- build frontend ---
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- build backend (native module compile) ---
FROM node:22-bookworm-slim AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
# SHA del commit, lo pasa el workflow; el panel lo muestra y lo compara con la
# imagen `latest` de GHCR para avisar de actualizaciones. Vacío en builds locales.
ARG GIT_SHA=
ENV NODE_ENV=production \
    DB_PATH=/data/limitarr.db \
    GIT_SHA=$GIT_SHA
WORKDIR /app/server
COPY --from=server-build /server/node_modules ./node_modules
COPY --from=server-build /server/package.json ./package.json
COPY --from=server-build /server/src ./src
COPY --from=web-build /web/dist ../web/dist

VOLUME ["/data"]
EXPOSE 5150

# Sin esto Docker solo sabe si el proceso node sigue vivo, no si de verdad
# responde peticiones (podría estar colgado esperando algo). Usa node en vez de
# curl/wget para no meter paquetes extra en la imagen final.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5150/api/auth/me', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
