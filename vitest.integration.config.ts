import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    fileParallelism: false,
    include: ['packages/**/*.integration.test.ts'],
    testTimeout: 60_000,
  },
});
