# ---------------------------------------------------------------------------
# Client image — the Canvas viewport.
#
#   deps    -> install dependencies
#   dev     -> Vite dev server with HMR (opt-in via docker-compose.dev.yml)
#   build   -> `vite build` emits the static bundle (client/dist)
#   runtime -> nginx serves the static files; no Node, no source at run time
#
# VITE_WS_URL is baked into the browser bundle at BUILD time (it's compiled into
# the JS), so it is a build ARG here, not a runtime env var.
# ---------------------------------------------------------------------------
# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- dev: Vite dev server with HMR -----------------------------------------
FROM deps AS dev
WORKDIR /app
COPY . .
EXPOSE 5173
# `--host` binds Vite to 0.0.0.0 so the dev server is reachable from the host.
CMD ["npm", "run", "dev:client", "--", "--host"]

# --- build: emit the static bundle -----------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
ARG VITE_WS_URL
ENV VITE_WS_URL=${VITE_WS_URL}
RUN npx vite build

# --- runtime: static files behind nginx ------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
