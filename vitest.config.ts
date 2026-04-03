import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: ['node_modules', 'dist', 'web-ui', 'tests', 'scripts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    testTimeout: 30000,
    hookTimeout: 10000,
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@agents': path.resolve(__dirname, 'src/agents'),
      '@plugins': path.resolve(__dirname, 'src/plugins'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@config': path.resolve(__dirname, 'src/config'),
    },
  },
});
