import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { describeVmSmoke } from '../helpers/runVmSmoke';
import { installYrSpawnerProbe } from '../../../src/games/yr/spawnerProbe';
import { inspectPe32 } from '../../../src/vm86/peProbe';

let probe: ReturnType<typeof installYrSpawnerProbe>;
describeVmSmoke('YR 原生启动执行 Spawner 初始化点探针', {
  gameId: 'yr',
  clicks: [[1, 1]],
  hoverOnly: true,
  timeoutMs: 60_000,
  targetCalls: 4_000,
  memoryBytes: 768 * 1024 * 1024,
  prepareGuest(memory, executable, reserve) {
    probe = installYrSpawnerProbe(
      memory,
      createHash('sha256').update(executable).digest('hex'),
      reserve,
      inspectPe32(executable),
    );
  },
  assertFinalState(_shim, memory) {
    const read = (address: number) => new DataView(memory.read_memory(address, 4).slice().buffer).getUint32(0, true);
    const count = read(probe.countAddress),
      esp = read(probe.stackAddress);
    console.log(`YR Spawner 初始化点：命中 ${count} 次，入口 ESP=0x${esp.toString(16)}`);
    expect(count).toBe(1);
    expect(esp).toBeGreaterThan(0);
    expect(esp % 4).toBe(0);
  },
});
