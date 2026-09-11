# Taymna Web

Next.js dashboard (App Router, PWA). See the
[repository root README](../README.md) and [docs/](../docs/) for
architecture and self-hosting -- this file only covers commands local to
this package.

```bash
yarn install
cp .env.local.example .env.local   # or just set NEXT_PUBLIC_API_URL
yarn dev
```

| Command | Purpose |
|---|---|
| `yarn dev` | Dev server |
| `yarn lint` | ESLint |
| `yarn typecheck` | `tsc --noEmit` |
| `yarn test` | Component tests (Vitest + Testing Library) |
| `yarn build` | Production build |
| `yarn start` | Serve the production build |
