# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS production-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Runtime image: deps already installed; never run pnpm at startup.
FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY package.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
# Custom server + serial console proxy (tsx resolves ~/ via tsconfig paths)
COPY server.ts tsconfig.json ./
COPY app ./app
COPY scripts ./scripts
COPY public ./public

EXPOSE 3000
USER node
# Invoke the binary directly — `pnpm start` would re-check deps and try to install.
# CronJobs override command to: tsx ./scripts/snapshot-run.ts
CMD ["./node_modules/.bin/tsx", "./server.ts"]
