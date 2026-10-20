import type { GuestMemory } from '../../vm86/win32';
import type { BattleResult } from '@ra2vm/control/contracts';
import { le32 } from './bytes';
import { readU32 } from './guestMemoryIO';
import { controlCode } from './nativeSidebarControl';

type Evidence = { address: number; bytes: readonly number[] };
export interface NativeBattleResultProfile {
  /** Native local outcome globals, not House flags announcing a future outcome. */
  win: number;
  lose: number;
  terminal: Evidence;
  evidence: readonly Evidence[];
}

interface ResultContext {
  frame: number;
  localHouse: number;
  houseIndex: number;
  battleResult: NativeBattleResultProfile;
}

/**
 * Observe the original logic loop's terminal branch before native teardown.
 * Only private storage is written. The displaced instruction and all registers/flags
 * are preserved; quit without a native outcome remains unknown. Normal iterations
 * reset the record for a new battle even when no host observation occurs between games.
 * Record: generation, phase (1 running / 2 ended), outcome bits, frame, player, House.
 */
export function makeBattleResultCode(address: number, record: number, profile: ResultContext, terminal: boolean) {
  const { emit, label, jump, finish } = controlCode(address);
  emit(0x9c, 0x60); // pushfd; pushad
  emit(0x8b, 0x15, ...le32(profile.localHouse)); // edx = local House
  emit(0x81, 0xfa, ...le32(0x10000));
  jump('done', 0x82);
  emit(0x81, 0xfa, ...le32(0x10000000));
  jump('done', 0x83);
  emit(0xf6, 0xc2, 3);
  jump('done', 0x85);
  emit(0x8b, 0x8a, ...le32(profile.houseIndex));
  emit(0x83, 0xf9, 31);
  jump('done', 0x87);
  emit(0xa1, ...le32(profile.frame), 0x85, 0xc0);
  jump('done', 0x84);
  emit(0x83, 0x3d, ...le32(record + 4), 0);
  jump('reset', 0x84);
  if (!terminal) {
    emit(0x83, 0x3d, ...le32(record + 4), 2);
    jump('reset', 0x84);
  }
  emit(0x3b, 0x15, ...le32(record + 20));
  jump('reset', 0x85);
  emit(0x3b, 0x05, ...le32(record + 12));
  jump('update', 0x83);
  label('reset');
  emit(0xc7, 0x05, ...le32(record + 4), ...le32(0));
  emit(0xff, 0x05, ...le32(record)); // generation++
  emit(0xc7, 0x05, ...le32(record + 8), ...le32(0));
  label('update');
  // Publish the phase last: a host read between guest slices must never see
  // "ended" with an outcome or identity that has not been copied yet.
  emit(0xc7, 0x05, ...le32(record + 4), ...le32(0));
  emit(0xa3, ...le32(record + 12));
  emit(0x89, 0x0d, ...le32(record + 16));
  emit(0x89, 0x15, ...le32(record + 20));
  if (terminal) {
    emit(0x0f, 0xb6, 0x05, ...le32(profile.battleResult.win));
    emit(0x0f, 0xb6, 0x0d, ...le32(profile.battleResult.lose));
    // Accept only canonical booleans; contradictory flags remain unknown too.
    emit(0x83, 0xf8, 1);
    jump('unknown', 0x87);
    emit(0x83, 0xf9, 1);
    jump('unknown', 0x87);
    emit(0x8d, 0x04, 0x48); // eax = win + 2 * lose
    jump('store');
    label('unknown');
    emit(0x31, 0xc0);
    label('store');
    emit(0xa3, ...le32(record + 8));
  }
  emit(0xc7, 0x05, ...le32(record + 4), ...le32(terminal ? 2 : 1));
  label('done');
  emit(0x61, 0x9d);
  if (terminal) {
    const site = profile.battleResult.terminal;
    emit(...site.bytes);
    emit(0xe9, ...le32(site.address + site.bytes.length - address - finish().length - 5));
  } else emit(0xc3);
  return finish();
}

export function readBattleResult(memory: GuestMemory, record: number, sessionId: string): BattleResult | null {
  if (readU32(memory, record + 4) !== 2) return null;
  const outcome = readU32(memory, record + 8);
  return {
    sessionId,
    frame: readU32(memory, record + 12),
    player: readU32(memory, record + 16),
    outcome: outcome === 1 ? 'victory' : outcome === 2 ? 'defeat' : 'unknown',
    source: 'native-game-loop',
  };
}
