import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/** Version parameters for single-player test entry: jump target, start handler, and the matching direct-page installer. */
export interface BattleStartupSpec {
  readonly label: string;
  readonly site: number;
  /** Native start handler; receives the setup window and action code via fastcall. */
  readonly handler: number;
  /** Enter the validated skirmish page before the battlefield, allocating its own exclusive stub tail. */
  readonly navigate: (memory: GuestMemory, reserve: (size: number) => number) => number;
}

/** Both versions have identical original instructions at the overwrite point: read the setup command, then compare against 0x617. */
const SIGNATURE = [0x8b, 0x44, 0x24, 0x04, 0x3d, 0x17, 0x06, 0, 0, 0x74, 0x22] as const;

/**
 * Single-player test entry: after native setup initialization returns, invoke the start handler with current settings. Do not send WM_COMMAND/mouse events or bypass option validation, scenario loading, or setup-page cleanup. ECX=setup window; EDX=native start action 0x617. Both stack arguments are zero and the callee uses RET 8. Consume this once; returning to skirmish from the menu still requires manual start.
 */
export function installBattleStartup(
  memory: GuestMemory,
  reserve: (size: number) => number,
  spec: BattleStartupSpec,
): number {
  const { label, site, handler, navigate } = spec;
  const current = memory.read_memory(site, SIGNATURE.length);
  if (current.length !== SIGNATURE.length || !current.every((byte, index) => byte === SIGNATURE[index])) {
    throw new Error(`${label}：指令签名不匹配或重复安装`);
  }
  const base = reserve(96);
  if (!Number.isInteger(base) || base % 16 || base < 0x80000 || base + 96 > 0xc0000) {
    throw new Error(`${label}：启动桩分配越界`);
  }
  const storage = memory.read_memory(base, 96);
  if (storage.length !== 96 || storage.some((byte) => byte !== 0)) throw new Error(`${label}：启动桩已占用`);
  const state = base + 80;
  const code = [
    0x9c,
    0x60, // Preserve original flags/registers; the start handler must report results only through native state.
    0x83,
    0x3d,
    ...le32(state),
    0,
    0x74,
    26,
    0xc7,
    0x05,
    ...le32(state),
    ...le32(0), // Consume before calling so reentry cannot start another game.
    0x6a,
    0,
    0x6a,
    0,
    0x8b,
    0xce,
    0xba,
    ...le32(0x617),
  ];
  code.push(0xe8, ...le32(handler - (base + code.length + 5)));
  code.push(0x61, 0x9d, ...SIGNATURE.slice(0, 9));
  code.push(0xe9, ...le32(site + 9 - (base + code.length + 5)));
  const bytes = new Uint8Array(96);
  bytes.set(code);
  bytes.set(le32(1), 80);
  navigate(memory, (size) => {
    const address = reserve(size);
    if (address < base + 96 && address + size > base) throw new Error(`${label}：启动桩分配重叠`);
    return address;
  });
  memory.write_memory(bytes, base);
  memory.write_memory([0xe9, ...le32(base - site - 5), 0x90, 0x90, 0x90, 0x90], site);
  return state;
}
