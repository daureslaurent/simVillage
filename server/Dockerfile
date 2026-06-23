# ---------------------------------------------------------------------------
# Backend image — the whole village in one process (world engine + minds + God
# Agent + WebSocket gateway).
#
# Multi-stage:
#   deps      -> all dependencies (incl. dev) for the build toolchain
#   build     -> esbuild bundles the TS graph into one self-contained ESM file
#   prod-deps -> production-only node_modules (mongodb, ws)
#   runtime   -> tiny image: bundled app + prod deps, plain `node`, non-root
#   dev       -> tsx watch (used only by docker-compose.dev.yml for hot reload)
#
# The runtime image carries the code baked in as a bundle; nothing is read from
# the host at run time.
# ---------------------------------------------------------------------------
# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build: bundle to a single ESM file ------------------------------------
# Prod deps stay external (re-installed in the runtime stage), so the bundle is
# just our own code. Type-checking is CI's job; the image build stays fast and
# deterministic.
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx esbuild server/src/index.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=dist/server.mjs

# --- prod-deps: production-only node_modules --------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- runtime: minimal, no source, no build tools ---------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Authored assets the minds read by path: the shared world bible + persona
# roster. The env overrides pin absolute paths so resolution never depends on
# the bundle's location.
COPY --from=build /app/agent/villagers.md /app/agent/villagers.json ./agent/
ENV VILLAGER_BIBLE_FILE=/app/agent/villagers.md \
    VILLAGER_ROSTER_FILE=/app/agent/villagers.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]

# --- dev: hot-reloading backend (opt-in via docker-compose.dev.yml) --------
FROM deps AS dev
ENV NODE_ENV=development
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["npm", "run", "dev:server"]
