# Taymna Web

Next.js dashboard (App Router, PWA). See the
[repository root README](../README.md) and [docs/](../docs/) for
architecture and self-hosting -- this file only covers commands local to
this package.

```bash
npm install
cp .env.local.example .env.local   # or just set NEXT_PUBLIC_API_URL
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Component tests (Vitest + Testing Library) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
