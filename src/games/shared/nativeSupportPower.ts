import type { GuestMemory } from '../../vm86/win32';
import { readU32 } from './guestMemoryIO';

export interface NativeSupportPowerProfile {
  houseVector: number;
  typeOffset: number;
  selectedIndex: number;
  onHold: number;
  charged: number;
  chargeDrainTypeFlag: number;
  chargeDrainState: number;
  targetAction: number;
  canFire: { address: number; bytes: readonly number[] };
  selectionEvidence: { address: number; bytes: readonly number[] };
  targetingEvidence: { address: number; bytes: readonly number[] };
}

interface Cameo {
  strip: number;
  index: number;
  rtti: number;
  typeIndex: number;
  tab: number;
}

/** Only local-house sidebar powers and the player's active targeting mode are public. */
export function nativeSupportPowers(
  memory: GuestMemory,
  layout: NativeSupportPowerProfile,
  house: number,
  sidebar: number,
  cameos: readonly Cameo[],
  pointer: (address: number) => number,
) {
  const u32 = (address: number) => readU32(memory, address);
  const u8 = (address: number) => {
    const bytes = memory.read_memory(address, 1);
    if (bytes.length !== 1) throw new Error('Native support-power byte read failed');
    return bytes[0]!;
  };
  const count = u32(house + layout.houseVector + 16);
  if (count > 8192) throw new Error('Invalid native support-power count');
  const resolve = (index: number) => {
    if (index >= count) return null;
    const data = pointer(u32(house + layout.houseVector + 4));
    const object = pointer(u32(data + index * 4));
    const typePointer = pointer(u32(object + layout.typeOffset));
    const id = memory.read_memory(typePointer + 0x24, 24);
    const end = id.indexOf(0);
    const type = new TextDecoder().decode(id.subarray(0, end < 0 ? id.length : end));
    const onHold = !!u8(object + layout.onHold);
    // Same predicate as original CanFire; selection still calls the native handler.
    const ready =
      !onHold &&
      (u8(typePointer + layout.chargeDrainTypeFlag)
        ? u32(object + layout.chargeDrainState) !== 0
        : !!u8(object + layout.charged));
    return { type, index, object, ready, onHold, requiresTarget: u32(typePointer + layout.targetAction) !== 0 };
  };
  const available = cameos.flatMap((cameo) => {
    // Special cameos use RTTI 31, not the SuperWeaponType catalog RTTI 32.
    if (cameo.rtti !== 31) return [];
    const power = resolve(cameo.typeIndex);
    if (!power) throw new Error('Native support-power cameo has an invalid index');
    return [{ ...power, cameo }];
  });
  return { available, selected: resolve(u32(sidebar + layout.selectedIndex)) };
}
