import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGameDir } from '../helpers/gameDir';
import { runVmSmoke, type VmClick } from '../helpers/runVmSmoke';

// This regression explicitly uses Gonghui assets and executable; an ordinary RA2 directory cannot count as successful MOD verification.
// Gonghui is an opt-in third-party MOD, so its suite runs only when VM_GONGHUI=1. Once requested, missing assets fail instead of skipping.
const requested = process.env.VM_GONGHUI === '1';
if (requested && !existsSync(join(resolveGameDir('ra2'), 'expand01.mix'))) {
  throw new Error('共辉验收缺少 expand01.mix；请配置 VM_GAME_DIR');
}
describe.runIf(requested)('共和国之辉快速游戏与模型资源', () => {
  for (const [name, type, selection] of [
    [
      '中国',
      'CMCV',
      [
        [778, 238],
        [778, 403],
        [778, 403],
        [778, 403],
        [710, 379],
      ],
    ],
    ['美国', 'AMCV', []],
    [
      '苏联',
      'SMCV',
      [
        [778, 238],
        [778, 403],
        [778, 403],
        [778, 403],
        [710, 400],
      ],
    ],
  ] as const) {
    it(`${name}保留原始规则，开启快速游戏后仍有基地车且未被判负`, async () => {
      const clicks: VmClick[] = [[1034, 370], [1034, 454], ...selection, [1040, 413]];
      await runVmSmoke({
        gameId: 'ra2',
        memoryBytes: 768 * 1024 * 1024,
        timeoutMs: 180_000,
        targetCalls: 400_000,
        settleMessages: 60_000,
        clickGapMessages: 1_000,
        waitMenuReady: true,
        clicks,
        clickPageTitles: ['mainmenu', 'singleplayer', ...clicks.slice(2).map(() => 'skirmish')],
        assertFinalState(shim, memory) {
          const u32 = (address: number) => {
            const b = memory.read_memory(address, 4);
            return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
          };
          expect(shim.hasMountedFile('ecache01.mix')).toBe(true);
          expect(memory.read_memory(0xa3d2c2, 1)[0], '快速游戏应保持开启').toBe(1);
          const house = u32(0xa35db4);
          expect(house).toBeGreaterThan(0x100000);
          expect(memory.read_memory(house + 0x13d, 1)[0], '玩家不得已被判负').toBe(0);
          const rules = u32(0x839848),
            array = u32(rules + 0x9d4),
            count = u32(rules + 0x9e0);
          const names: string[] = [];
          let owned = 0;
          for (let i = 0; i < count; i++) {
            const unit = u32(array + i * 4);
            const id = new TextDecoder().decode(memory.read_memory(unit + 0x24, 24)).split('\0')[0]!;
            names.push(id);
            if (id === type) {
              const index = u32(unit + 0xb90);
              expect(index).toBeLessThan(u32(house + 0x5438));
              owned = u32(u32(house + 0x5434) + index * 4);
            }
          }
          expect(names, '不得通过交换 MOD 基地车顺序规避判败').toEqual(['AMCV', 'SMCV', 'CMCV']);
          expect(owned, `${name}应拥有自己的基地车`).toBeGreaterThan(0);
        },
      });
    }, 240_000);
  }
});
