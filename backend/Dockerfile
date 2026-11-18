# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies from the lockfile alone so the layer is cached until
# package.json actually changes.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package*.json ./
# `npm ci --omit=dev` installs exactly what production needs, no tsx/typescript.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Run as the unprivileged user that ships with the node image. The container
# holds a dispenser private key, so it must never run as root.
USER node

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package*.json ./

EXPOSE 3000

# The health endpoint is the readiness signal: it verifies the chain ID, the
# dispenser role and Redis, so a container that cannot serve claims stays out of
# rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/faucet/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
