import type { GuestMemory } from '../../vm86/win32';
import { readU32 } from './guestMemoryIO';
import { controlCode } from './nativeSidebarControl';
import { le32 } from './bytes';

export interface NativeViewportProfile {
  tactical: number;
  bounds: number;
  cells: number;
  map: number;
  zScale: number;
  heightLevel: number;
  visible: number;
  disguised: number;
  cloak: number;
  position: { address: number; bytes: readonly number[] };
  floor: { address: number; bytes: readonly number[] };
}

/** Read the native local viewport; never widen a missing/invalid view into omniscient access. */
export function nativeViewport(memory: GuestMemory, profile: NativeViewportProfile) {
  const u32 = (address: number) => readU32(memory, address);
  const byte = (address: number) => memory.read_memory(address, 1)[0];
  const tactical = u32(profile.tactical);
  if (tactical < 0x10000 || tactical >= 0x10000000 || tactical % 4) throw new Error('Viewport unavailable');
  const viewport = {
    x: u32(tactical + 0xb0) | 0,
    y: u32(tactical + 0xb4) | 0,
    width: u32(profile.bounds + 8),
    height: u32(profile.bounds + 12),
  };
  if (!viewport.width || !viewport.height || viewport.width > 8192 || viewport.height > 8192)
    throw new Error('Invalid viewport bounds');
  const scaleBytes = memory.read_memory(profile.zScale, 8);
  const zScale = new DataView(scaleBytes.buffer, scaleBytes.byteOffset, scaleBytes.byteLength).getFloat64(0, true);
  if (!Number.isFinite(zScale) || zScale <= 0 || zScale > 1) throw new Error('Invalid viewport projection');
  const heightLevel = u32(profile.heightLevel) | 0;
  if (heightLevel <= 0) throw new Error('Invalid viewport height level');
  const cells = u32(profile.cells);
  const cellAt = (x: number, y: number) => {
    if (cells < 0x10000 || cells >= 0x10000000 || cells % 4 || x < 0 || y < 0 || x > 511 || y > 511) return 0;
    const cell = u32(cells + 4 * (x + 512 * y));
    return cell >= 0x10000 && cell < 0x10000000 && cell % 4 === 0 ? cell : 0;
  };
  return {
    viewport,
    cellAt,
    visible(object: number, location: { x: number; y: number; z: number }, owned: boolean, player: number) {
      const x = Math.trunc((30 * location.x - 30 * location.y) / 256) - viewport.x;
      const y =
        Math.trunc((15 * location.x + 15 * location.y) / 256) -
        Math.trunc(location.z * zScale + (location.z >= 728 ? 1 : 0) + 0.5) -
        viewport.y;
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height || byte(object + profile.visible) !== 1)
        return null;
      const cellX = Math.trunc(location.x / 256);
      const cellY = Math.trunc(location.y / 256);
      // Native IsLocationShrouded projects height onto the visibility grid. Odd
      // levels span two diagonal cells; physical cells still own cloak sensors.
      const level = Math.trunc(location.z / heightLevel);
      const half = Math.trunc(level / 2);
      const odd = level % 2 !== 0;
      const offset = half + (odd ? 1 : 0);
      const revealed = (cell: number) =>
        !!cell && !!(u32(cell + 0x12c) & 8) && byte(cell + 0x120) === 255 && byte(cell + 0x121) === 255;
      if (
        !revealed(cellAt(cellX - offset, cellY - offset)) &&
        !(odd && revealed(cellAt(cellX - offset + 1, cellY - offset + 1)))
      )
        return null;
      if (!owned) {
        // Never expose a disguised object's true type/owner. Conservative omission also covers mirage disguises.
        if (byte(object + profile.disguised)) return null;
        if (u32(object + profile.cloak) !== 0) {
          if (player >= 24) return null;
          const cell = cellAt(cellX, cellY);
          if (!cell) return null;
          const sensor = memory.read_memory(cell + 0x7c + player * 2, 2);
          if (sensor.length !== 2 || !(sensor[0]! | (sensor[1]! << 8))) return null;
        }
      }
      return { x, y };
    },
  };
}

/** Camera updates execute on the game thread through the same mailbox, using native floor and position functions. */
export function makeCameraControlCode(address: number, mailbox: number, profile: NativeViewportProfile): Uint8Array {
  const { emit, call, finish } = controlCode(address);
  emit(0x68, ...le32(mailbox + 16), 0xb9, ...le32(profile.map));
  call(profile.floor.address);
  emit(0xa3, ...le32(mailbox + 24));
  emit(0x68, ...le32(mailbox + 16), 0x8b, 0x0d, ...le32(profile.tactical));
  call(profile.position.address);
  emit(0xb8, ...le32(3), 0xc3);
  return finish();
}
