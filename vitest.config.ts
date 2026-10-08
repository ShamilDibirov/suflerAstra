import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts','apps/api/src/**/*.test.ts'],env:{DEMO_MODE:'true',REDIS_URL:'',DATABASE_URL:''},testTimeout:10000}});
