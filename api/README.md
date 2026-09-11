# Taymna API

NestJS + Prisma service. See the [repository root README](../README.md) and
[docs/](../docs/) for architecture, the WebSocket protocol, and
self-hosting -- this file only covers commands local to this package.

```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm run db:migrate:dev
npm run start:dev
```

| Command | Purpose |
|---|---|
| `npm run start:dev` | Dev server with watch mode |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | e2e tests against a real Postgres |
| `npm run build` | Production build to `dist/` |
| `npm run db:migrate:dev` | Create/apply a migration in development |
| `npm run db:migrate:deploy` | Apply pending migrations (what the Docker image runs on boot) |
