/**
 * Fixed hypercall-return workload measuring host scheduling overhead, not game FPS.
 * An old worktree path can be supplied to remeasure the baseline with the same workload.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PeImport } from '../../src/vm86/pe';

const helper = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2], 'tests/helpers/guestMemory.ts'))
  : new URL('../../tests/helpers/guestMemory.ts', import.meta.url);
const { createGuestMemory, createTestShim, callShim } = (await import(
  helper.href
)) as typeof import('../../tests/helpers/guestMemory');
const imported: PeImport = {
  id: 1,
  dll: 'KERNEL32.DLL',
  name: 'GetTickCount',
  key: 'KERNEL32.DLL!GetTickCount',
  slot: 0,
  stub: 0,
  argBytes: 0,
};
for (const count of [1, 4, 8]) {
  const shim = createTestShim(createGuestMemory());
  for (let i = 1; i < count; i++) callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0, 0x401000, 0, 0, 0]);
  const call = { imported, args: [] };
  const result = {};
  for (let i = 0; i < 20000; i++) shim.prepareGuestThreadReturn(call, result);
  const samples: number[] = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    for (let i = 0; i < 100000; i++) shim.prepareGuestThreadReturn(call, result);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${count} 线程，10 万次返回：${samples[3]!.toFixed(2)} ms（7 批中位数）`);
  shim.dispose();
}
