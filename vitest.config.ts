import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.test.ts'],
    // Los tests que tocan Postgres corren en serie por archivo (usan una DB compartida de test).
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
