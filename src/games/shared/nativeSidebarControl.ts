import { le32 } from './bytes';

export interface NativeSidebarProfile {
  instance: number;
  activeTab: number;
  tabIndex: number;
  strips: number;
  stripSize: number;
  count: number;
  items: number;
  itemSize: number;
  topRow: number;
  queueCount: number;
  modifierArgument: boolean;
  constructor: { address: number; bytes: readonly number[] };
  action: { address: number; bytes: readonly number[] };
  setTab: { address: number; bytes: readonly number[] };
}

/** Small label resolver for the two RA2/YR control trampolines. All branches use rel32. */
export function controlCode(address: number) {
  const bytes: number[] = [];
  const labels = new Map<string, number>();
  const fixups: { at: number; label: string }[] = [];
  return {
    emit: (...values: number[]) => {
      bytes.push(...values);
    },
    label: (name: string) => {
      labels.set(name, bytes.length);
    },
    jump: (name: string, condition?: number) => {
      bytes.push(...(condition === undefined ? [0xe9] : [0x0f, condition]));
      fixups.push({ at: bytes.length, label: name });
      bytes.push(0, 0, 0, 0);
    },
    call: (target: number) => {
      bytes.push(0xe8, ...le32(target - address - bytes.length - 5));
    },
    finish: () => {
      for (const { at, label } of fixups) {
        const target = labels.get(label);
        if (target === undefined) throw new Error(`Missing native control label: ${label}`);
        bytes.splice(at, 4, ...le32(target - at - 4));
      }
      return new Uint8Array(bytes);
    },
  };
}

/**
 * Call the original SelectClass::Action on a native-constructed, unregistered
 * selector bound to a real cameo. This is the semantic button handler, not guest
 * mouse/keyboard injection. It preserves native checks, pending flags and clocks.
 * Switch the native sidebar tab before clicking; the private selector preserves
 * the current scroll position while binding the requested existing cameo.
 * Return mailbox states: pending=1, full=2, submitted=3, rejected=5.
 */
export function makeSidebarControlCode(
  address: number,
  box: number,
  selector: number,
  profile: NativeSidebarProfile,
  suspended: number,
): Uint8Array {
  const { emit, label, jump, call, finish } = controlCode(address);
  emit(0x8b, 0x35, ...le32(box + 128)); // esi = real strip
  emit(0x8b, 0x3d, ...le32(box + 132)); // edi = absolute cameo index
  emit(0x3b, 0x7e, profile.count);
  jump('rejected', 0x83); // index >= current count
  emit(0x69, 0xdf, ...le32(profile.itemSize), 0x8d, 0x5c, 0x1e, profile.items);
  emit(0xa1, ...le32(box + 140), 0x39, 0x03);
  jump('rejected', 0x85);
  emit(0xa1, ...le32(box + 136), 0x39, 0x43, 4);
  jump('rejected', 0x85); // cameo may have disappeared/reordered since publication
  emit(0x83, 0x3d, ...le32(profile.queueCount), 0x7f);
  jump('full', 0x8d); // leave room for native handler bookkeeping
  emit(0x83, 0x3d, ...le32(box + 12), 5);
  jump('invoke', 0x84); // completed cameo click enters the native placement UI
  emit(0x83, 0x3d, ...le32(box + 12), 1);
  jump('produce', 0x84);
  emit(0x8b, 0x43, 0x0c, 0x85, 0xc0);
  jump('rejected', 0x84);
  emit(0x80, 0x78, suspended, 0);
  jump('held', 0x85);
  emit(0x83, 0x3d, ...le32(box + 144), 0);
  jump('pending', 0x85); // cancel waits for its first right-click to suspend
  jump('invoke');
  label('held');
  emit(0x83, 0x3d, ...le32(box + 12), 2);
  jump('rejected', 0x84); // suspend must not accidentally cancel a held product
  jump('invoke');
  label('produce');
  emit(0x83, 0x3d, ...le32(box + 136), 7); // BuildingType: only its click can enter placement mode.
  jump('invoke', 0x85);
  emit(0x8b, 0x43, 0x0c, 0x85, 0xc0);
  jump('invoke', 0x84);
  emit(0x83, 0x78, 0x24, 54);
  jump('rejected', 0x83); // A newly completed product must not turn produce into cursor placement.
  label('invoke');
  emit(0x8b, 0x46, profile.tabIndex, 0x83, 0xf8, 3);
  jump('rejected', 0x87); // never pass an invalid tab to the native widget manager
  emit(0x50, 0xb9, ...le32(profile.instance));
  call(profile.setTab.address); // thiscall SetTab(index), including native redraw and button registration
  emit(0xb9, ...le32(selector));
  call(profile.constructor.address);
  emit(0x89, 0x35, ...le32(selector + 0x2c));
  emit(0x8b, 0x46, profile.topRow, 0x01, 0xc0, 0x29, 0xc7, 0x89, 0x3d, ...le32(selector + 0x30));
  emit(0x8b, 0x2d, ...le32(profile.queueCount)); // queue size before native handler
  emit(0xba, ...le32(1), 0x83, 0x3d, ...le32(box + 12), 1);
  jump('flags', 0x84);
  emit(0x83, 0x3d, ...le32(box + 12), 5);
  jump('flags', 0x84);
  emit(0xba, ...le32(16)); // right-press: suspend, or cancel if already held
  label('flags');
  if (profile.modifierArgument) emit(0x6a, 0);
  emit(0x68, ...le32(box + 148), 0x52, 0xb9, ...le32(selector));
  call(profile.action.address);
  emit(0x83, 0x3d, ...le32(box + 12), 5);
  jump('submitted', 0x84); // caller verifies the native placement object and preview
  emit(0x3b, 0x2d, ...le32(profile.queueCount));
  jump('rejected', 0x84); // Action's bool isn't event acceptance
  emit(0x83, 0x3d, ...le32(box + 12), 3);
  jump('submitted', 0x85);
  emit(0x8b, 0x43, 0x0c, 0x85, 0xc0);
  jump('submitted', 0x84);
  emit(0x80, 0x78, suspended, 0);
  jump('submitted', 0x85);
  emit(0xc7, 0x05, ...le32(box + 144), ...le32(1));
  label('pending');
  emit(0xb8, ...le32(1), 0xc3);
  label('submitted');
  emit(0xb8, ...le32(3), 0xc3);
  label('rejected');
  emit(0xb8, ...le32(5), 0xc3);
  label('full');
  emit(0xb8, ...le32(2), 0xc3);
  return finish();
}
