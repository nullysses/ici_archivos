import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
