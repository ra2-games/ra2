import { defineConfig } from 'vitest/config';

// Standalone package checks: protocol, client, real WS service, and distribution; no game assets are read.
export default defineConfig({
  test: {
    // Prevent accidentally committed it.only / describe.only from making CI pass after running only part of the suite.
    allowOnly: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
