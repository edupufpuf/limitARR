# --- build frontend ---
FROM node:20-bookworm-slim AS web-build
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- build backend (native module compile) ---
FROM node:20-bookworm-slim AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src

# --- runtime ---
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DB_PATH=/data/limitarr.db
WORKDIR /app/server
COPY --from=server-build /server/node_modules ./node_modules
COPY --from=server-build /server/package.json ./package.json
COPY --from=server-build /server/src ./src
COPY --from=web-build /web/dist ../web/dist

VOLUME ["/data"]
EXPOSE 5150
CMD ["node", "src/index.js"]
