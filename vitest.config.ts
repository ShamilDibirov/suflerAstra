import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    env: { DEMO_MODE: 'true', REDIS_URL: '', DATABASE_URL: '' },
    testTimeout: 10000,
  },
});
