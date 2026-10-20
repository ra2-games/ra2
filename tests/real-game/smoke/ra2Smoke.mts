/**
 * Red Alert 2 real-EXE smoke entry.
 *
 * The smoke tests now live in per-game Vitest suites (tests/real-game/ra2/boot.test.ts). Forward all VM_* environment variables to preserve pnpm run test:vm:ra2 usage.
 */
import { spawnSync } from 'node:child_process';

if (process.env.VM_GAME && process.env.VM_GAME !== 'ra2') {
  throw new Error(`ra2Smoke 不接受 VM_GAME=${process.env.VM_GAME}`);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/real-game/ra2/boot.test.ts', '--disableConsoleIntercept'],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(result.status ?? 1);
