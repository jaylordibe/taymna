import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Every e2e file talks to the same Postgres and clears it before it
    // runs, and each boots its own AppModule (which bootstraps the admin
    // operator). Running files in parallel therefore has them truncating
    // each other's fixtures and racing to create the same operator row --
    // so they run one at a time. Tests within a file still share a suite.
    fileParallelism: false,
  },
});
