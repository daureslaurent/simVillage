# ---------------------------------------------------------------------------
# LLM Engine image — the village's single brain-stem. The one process that talks
# to the lone llama server; the backend POSTs all its LLM work here over HTTP.
#
# Same multi-stage shape as the backend: esbuild bundles the engine into a
# single self-contained ESM file, run on plain `node` as a non-root user. The
# `dev` stage (tsx watch) is used only by docker-compose.dev.yml.
# ---------------------------------------------------------------------------
# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build: bundle to a single ESM file ------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx esbuild llm/src/index.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=dist/llm.mjs

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
USER node
EXPOSE 8090
CMD ["node", "dist/llm.mjs"]

# --- dev: hot-reloading engine (opt-in via docker-compose.dev.yml) ---------
FROM deps AS dev
ENV NODE_ENV=development
WORKDIR /app
COPY . .
EXPOSE 8090
CMD ["npm", "run", "dev:llm"]
