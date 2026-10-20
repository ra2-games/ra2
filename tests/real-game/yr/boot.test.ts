import { describeVmSmoke } from '../helpers/runVmSmoke';

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number(raw) | 0;
}

describeVmSmoke('尤里的復仇 boot', {
  gameId: 'yr',
  clicks: [[1, 1]],
  hoverOnly: true,
  timeoutMs: integer('VM_TIMEOUT_MS', 60_000),
  enableFastRead: process.env.VM_ENABLE_FAST_READ !== '0',
  memoryBytes: integer('VM_MEMORY_MB', 768) * 1024 * 1024,
  targetCalls: integer('VM_TARGET_CALLS', 4_000),
  skipFrameCheck: process.env.VM_SKIP_FRAME_CHECK === '1',
});
