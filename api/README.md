# Taymna API

NestJS + Prisma service. See the [repository root README](../README.md) and
[docs/](../docs/) for architecture, the WebSocket protocol, and
self-hosting -- this file only covers commands local to this package.

```bash
yarn install
cp .env.example .env   # point DATABASE_URL at a local Postgres
yarn db:migrate:dev
yarn start:dev
```

| Command | Purpose |
|---|---|
| `yarn start:dev` | Dev server with watch mode |
| `yarn lint` | oxlint |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn test` | Unit tests (Vitest) |
| `yarn test:e2e` | e2e tests against a real Postgres |
| `yarn build` | Production build to `dist/` |
| `yarn db:migrate:dev` | Create/apply a migration in development |
| `yarn db:migrate:deploy` | Apply pending migrations (what the Docker image runs on boot) |
