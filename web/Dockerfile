# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
# this must be the address BROWSERS will use to reach the API (e.g. this
# host's LAN IP or a domain) -- not the Docker-internal "api" hostname.
# Changing it requires rebuilding this image. See docs/self-hosting.md.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Optional: the address agents use to reach the API when it differs from the
# browser's (tunnel or public hostname). Empty means "same as API URL".
ARG NEXT_PUBLIC_AGENT_SERVER_URL=
ENV NEXT_PUBLIC_AGENT_SERVER_URL=${NEXT_PUBLIC_AGENT_SERVER_URL}
RUN yarn build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["yarn", "start"]
