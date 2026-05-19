import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    forks: { singleFork: true },
    testTimeout: 15000,
  },
});
