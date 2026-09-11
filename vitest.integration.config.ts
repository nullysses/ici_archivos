import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    testTimeout: 60_000,
  },
});
