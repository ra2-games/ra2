import { defineConfig } from 'vitest/config';

// Basic tests need no game assets; real games live under tests/real-game, where CI strict mode rejects missing resources.
export default defineConfig({
  test: {
    // Prevent accidental it.only / describe.only commits from making CI report success after running only part of the suite.
    allowOnly: false,
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
