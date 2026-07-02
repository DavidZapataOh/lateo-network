import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.test.ts'],
    // Postgres-touching tests run serially per file (they share one test database).
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
