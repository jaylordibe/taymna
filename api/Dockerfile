# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
# --ignore-scripts: this stage's only job is to produce node_modules for the
# build stage, which runs `prisma generate` explicitly after the full
# source (including prisma/schema.prisma) is present -- running the
# package's postinstall here would fail with the schema not found yet.
RUN yarn install --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Prisma's migration engine needs libssl to run (the query engine itself
# doesn't, per Prisma 7's no-rust-engine query compiler, but `prisma
# migrate deploy` at container startup still shells out to it).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prisma generate` is pure codegen from schema.prisma and never connects to
# a database, but loading prisma.config.ts still requires DATABASE_URL to
# resolve to *something*. This placeholder is build-time only and is never
# used to connect -- the real value comes from the container's environment
# at runtime (docker-compose.yml), not from anything baked into this image.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN yarn prisma generate
RUN yarn build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
# --ignore-scripts: the already-generated client is copied in below: no
# need (and no schema present yet at this point) to regenerate it here.
RUN yarn install --frozen-lockfile --production --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 3000

# Migrations run on every boot -- safe/idempotent (`migrate deploy` only
# applies pending migrations) and is how a self-hosted single-instance
# deployment picks up schema changes on upgrade without a separate step.
CMD ["sh", "-c", "yarn prisma migrate deploy && node dist/main.js"]
