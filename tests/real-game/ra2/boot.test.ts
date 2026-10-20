import { describeVmSmoke, type VmClick } from '../helpers/runVmSmoke';

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined ? fallback : Number(raw) | 0;
}

function clicks(): readonly VmClick[] {
  const sequence = process.env.VM_CLICK_SEQUENCE;
  if (!sequence) return [[integer('VM_CLICK_X', 1), integer('VM_CLICK_Y', 1)]];
  return sequence
    .split(';')
    .filter(Boolean)
    .map((point) => {
      const [x, y] = point.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`无效 VM_CLICK_SEQUENCE 点击点: ${point}`);
      }
      return [x!, y!] as const;
    });
}

function integerList(name: string): number[] {
  return (process.env[name] ?? '')
    .split(',')
    .filter(Boolean)
    .map((value) => Number(value) | 0);
}

describeVmSmoke('红色警戒 2 boot', {
  gameId: 'ra2',
  clicks: clicks(),
  clickGapMessages: integer('VM_CLICK_GAP_MESSAGES', 12),
  clickGaps: integerList('VM_CLICK_GAPS'),
  clickPageTitles: (process.env.VM_CLICK_EXPECT_PAGES ?? '').split(','),
  settleMessages: integer('VM_SETTLE_MESSAGES', 0),
  waitMenuReady: process.env.VM_WAIT_MENU_READY === '1',
  batchPointerClick: process.env.VM_BATCH_POINTER_CLICK === '1',
  hoverOnly: process.env.VM_HOVER_ONLY === '1',
  finalHoverOnly: process.env.VM_FINAL_HOVER_ONLY === '1',
  firstClickAfterMs: integer('VM_FIRST_CLICK_MS', 0),
  timeoutMs: integer('VM_TIMEOUT_MS', 60_000),
  enableFastRead: process.env.VM_ENABLE_FAST_READ !== '0',
  clockRate: Number(process.env.VM_CLOCK_RATE ?? 1),
  memoryBytes: integer('VM_MEMORY_MB', 768) * 1024 * 1024,
  targetCalls: integer('VM_TARGET_CALLS', 4_000),
  keys: integerList('VM_KEYS'),
  keysAfterCalls: integer('VM_KEYS_AFTER_CALLS', 0),
  skipFrameCheck: process.env.VM_SKIP_FRAME_CHECK === '1',
});
