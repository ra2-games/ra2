import { le32 } from './bytes';
import { controlCode } from './nativeSidebarControl';
import type { NativeControlProfile } from './nativeControl';

type Entry = { address: number; bytes: readonly number[] };
export interface NativePlayerControlProfile {
  isShrouded: Entry;
  selectionCount: number;
  selectionVector: number;
  selectSlot: number;
  cellClickSlot: number;
  objectClickSlot: number;
  placementObject: number;
  placementOffset: number;
  placementValid: number;
  unselect: Entry;
  select: Entry;
  deploy: Entry;
  stop: Entry;
  guard: Entry;
  scatter: Entry;
  attackMoveMode: Entry;
  clearAttackMoveMode: Entry;
  repairMode: Entry;
  sellMode: Entry;
  leftUp: Entry;
  decideAction: Entry;
  placementPreview: Entry;
  exitBattle: Entry;
}

export const playerGroupLimit = 64;

export const playerActions = {
  move: 1,
  attack: 2,
  'attack-move': 3,
  stop: 4,
  guard: 5,
  deploy: 6,
  scatter: 7,
  repair: 8,
  sell: 9,
  place: 10,
  'exit-battle': 11,
  'select-power': 12,
  'target-power': 13,
} as const;

/** Player selection, command hotkey handlers and tactical click handlers; no synthetic EventClass. */
export function makePlayerControlCode(
  address: number,
  box: number,
  sidebarCode: number,
  profile: NativeControlProfile,
) {
  const { emit, label, jump, call, finish } = controlCode(address);
  const p = profile.playerControl,
    instance = profile.sidebar.instance,
    data = box + 16;
  const receiver = () => emit(0xb9, ...le32(instance));
  const mode = (entry: Entry, enabled: number) => {
    emit(0x6a, enabled);
    receiver();
    call(entry.address);
  };
  const checkLoadedObject = (owned: boolean) => {
    // ESI is the object, EAX its observed identity. Never select a recycled object.
    emit(0x85, 0xf6);
    jump('rejected', 0x84);
    emit(0x39, 0x86, ...le32(profile.uniqueId));
    jump('rejected', 0x85);
    emit(0x83, 0xbe, ...le32(profile.health), 0);
    jump('rejected', 0x8e);
    emit(0x80, 0xbe, ...le32(profile.alive), 0);
    jump('rejected', 0x84);
    emit(0x80, 0xbe, ...le32(profile.limbo), 0);
    jump('rejected', 0x85);
    if (owned) {
      emit(0xa1, ...le32(profile.localHouse), 0x39, 0x86, ...le32(profile.owner));
      jump('rejected', 0x85);
    }
  };
  const checkObject = (offset: number, owned: boolean) => {
    emit(0x8b, 0x35, ...le32(data + offset), 0xa1, ...le32(data + offset + 4));
    checkLoadedObject(owned);
  };
  const groupObject = () => {
    emit(0x8b, 0x15, ...le32(data + 56), 0x8b, 0x34, 0xda, 0x8b, 0x44, 0xda, 4);
  };
  const selectObject = () => {
    emit(0x8b, 0xce, 0x8b, 0x06, 0xff, 0x90, ...le32(p.selectSlot), 0x84, 0xc0);
    jump('selection-rejected', 0x84);
  };
  emit(0x83, 0x3d, ...le32(profile.sidebar.queueCount), 0x7f);
  jump('full', 0x8d);
  emit(0x83, 0x3d, ...le32(data), playerActions['exit-battle']);
  jump('exit-battle', 0x84);
  emit(0x83, 0x3d, ...le32(data), playerActions.place);
  jump('place', 0x84);
  if (profile.supportPowers) {
    for (const action of ['select-power', 'target-power'] as const) {
      emit(0x83, 0x3d, ...le32(data), playerActions[action]);
      jump(action, 0x84);
    }
  }
  emit(0x83, 0x3d, ...le32(data + 52), 0);
  jump('validate-single', 0x84);
  emit(0x83, 0x3d, ...le32(data + 52), playerGroupLimit);
  jump('rejected', 0x87);
  emit(0x31, 0xdb);
  label('validate-group');
  groupObject();
  checkLoadedObject(true);
  emit(0x43, 0x3b, 0x1d, ...le32(data + 52));
  jump('validate-group', 0x82);
  jump('selection-modes');
  label('validate-single');
  checkObject(4, true);
  label('selection-modes');
  call(p.clearAttackMoveMode.address);
  mode(p.repairMode, 0);
  mode(p.sellMode, 0);
  call(p.unselect.address);
  emit(0x83, 0x3d, ...le32(data + 52), 0);
  jump('select-single', 0x84);
  emit(0x31, 0xdb);
  label('select-group');
  groupObject();
  selectObject();
  emit(0x43, 0x3b, 0x1d, ...le32(data + 52));
  jump('select-group', 0x82);
  // Select can return true after failing to grow its vector, or clear incompatible
  // selections. Verify exact membership before issuing the single native intent.
  emit(0xa1, ...le32(p.selectionCount), 0x3b, 0x05, ...le32(data + 52));
  jump('selection-rejected', 0x85);
  emit(0x31, 0xdb);
  label('verify-group');
  groupObject();
  emit(0x8b, 0xc6, 0x8b, 0x0d, ...le32(p.selectionCount));
  emit(0x8b, 0x3d, ...le32(p.selectionVector), 0xfc, 0xf2, 0xaf);
  jump('selection-rejected', 0x85);
  emit(0x43, 0x3b, 0x1d, ...le32(data + 52));
  jump('verify-group', 0x82);
  jump('selection-done');
  label('select-single');
  selectObject();
  label('selection-done');
  emit(0x8b, 0x2d, ...le32(profile.sidebar.queueCount));
  for (const action of ['stop', 'guard', 'deploy', 'scatter'] as const) {
    emit(0x83, 0x3d, ...le32(data), playerActions[action]);
    jump(action, 0x84);
  }
  emit(0x83, 0x3d, ...le32(data), playerActions.attack);
  jump('attack', 0x84);
  emit(0x83, 0x3d, ...le32(data), playerActions.repair);
  jump('repair', 0x84);
  emit(0x83, 0x3d, ...le32(data), playerActions.sell);
  jump('sell', 0x84);
  // A tactical click must run native cursor decisions and selected-list dispatch,
  // including each object's MouseOver action, before any mission is queued.
  emit(0x31, 0xff, 0x83, 0x3d, ...le32(data), playerActions.move);
  jump('tactical-click', 0x84);
  call(p.attackMoveMode.address);
  jump('tactical-click');
  label('attack');
  checkObject(12, false);
  emit(0x8b, 0xfe);
  label('tactical-click');
  emit(0x68, ...le32(data + 24), 0xb9, ...le32(profile.viewport.map));
  call(profile.viewport.floor.address);
  emit(0xa3, ...le32(data + 32));
  emit(0x8b, 0x0d, ...le32(data + 48));
  call(p.isShrouded.address);
  emit(0x0f, 0xb6, 0xf0);
  emit(0x56, 0x57, 0x68, ...le32(data + 20));
  receiver();
  call(p.decideAction.address);
  emit(0x56, 0x50, 0x57, 0x68, ...le32(data + 20), 0x68, ...le32(data + 24));
  receiver();
  call(p.leftUp.address);
  call(p.clearAttackMoveMode.address);
  jump('outcome');
  for (const action of ['stop', 'guard', 'deploy', 'scatter'] as const) {
    label(action);
    call(p[action].address);
    jump('outcome');
  }
  label('repair');
  mode(p.repairMode, 1);
  jump('building-click');
  label('sell');
  mode(p.sellMode, 1);
  label('building-click');
  // Cursor legality comes from the original UI, including damage and ownership checks.
  call(p.unselect.address);
  emit(0x6a, 0, 0xff, 0x35, ...le32(data + 4), 0x68, ...le32(data + 20));
  receiver();
  call(p.decideAction.address);
  emit(0x6a, 0, 0x50, 0xff, 0x35, ...le32(data + 4));
  emit(0x68, ...le32(data + 20), 0x68, ...le32(data + 24));
  receiver();
  call(p.leftUp.address);
  jump('outcome');

  if (profile.supportPowers) {
    const power = profile.supportPowers;
    label('select-power');
    emit(0xc7, 0x05, ...le32(box + 12), ...le32(5));
    call(sidebarCode);
    emit(0xc7, 0x05, ...le32(box + 12), ...le32(0), 0x83, 0xf8, 3);
    jump('rejected', 0x85);
    // Non-targeted powers may queue their effect directly from the native cameo.
    emit(0x3b, 0x2d, ...le32(profile.sidebar.queueCount));
    jump('outcome', 0x85);
    emit(0xa1, ...le32(instance + power.selectedIndex), 0x3b, 0x05, ...le32(data + 40));
    jump('rejected', 0x85);
    // A stale targeting mode must not turn the original impatient click into acceptance.
    emit(0x8b, 0x0d, ...le32(profile.localHouse));
    emit(0x3b, 0x81, ...le32(power.houseVector + 16));
    jump('rejected', 0x83);
    emit(0x8b, 0x91, ...le32(power.houseVector + 4), 0x8b, 0x0c, 0x82);
    emit(0x3b, 0x0d, ...le32(data + 44));
    jump('rejected', 0x85);
    call(power.canFire.address);
    emit(0x84, 0xc0);
    jump('rejected', 0x84);
    emit(0xb8, ...le32(3), 0xc3);

    label('target-power');
    emit(0xa1, ...le32(instance + power.selectedIndex), 0x3b, 0x05, ...le32(data + 40));
    jump('rejected', 0x85);
    // Query native terrain and shroud on the game thread; never claim a hidden cell is revealed.
    emit(0x68, ...le32(data + 24), 0xb9, ...le32(profile.viewport.map));
    call(profile.viewport.floor.address);
    emit(0xa3, ...le32(data + 32));
    emit(0x8b, 0x0d, ...le32(data + 48));
    call(p.isShrouded.address);
    emit(0x0f, 0xb6, 0xf0);
    // Both cursor legality and the effect event belong to the original map UI.
    emit(0x56, 0x6a, 0, 0x68, ...le32(data + 20));
    receiver();
    call(p.decideAction.address);
    emit(0x8b, 0x2d, ...le32(profile.sidebar.queueCount));
    emit(0x56, 0x50, 0x6a, 0, 0x68, ...le32(data + 20), 0x68, ...le32(data + 24));
    receiver();
    call(p.leftUp.address);
    jump('outcome');
  }

  label('place');
  emit(0x83, 0x3d, ...le32(box + 144), 0);
  jump('preview', 0x85);
  mode(p.repairMode, 0);
  mode(p.sellMode, 0);
  emit(0xc7, 0x05, ...le32(box + 12), ...le32(5)); // completed cameo's native left click
  call(sidebarCode);
  emit(0xc7, 0x05, ...le32(box + 12), ...le32(0), 0x83, 0xf8, 3);
  jump('rejected', 0x85);
  label('preview');
  emit(0xa1, ...le32(instance + p.placementObject), 0x3b, 0x05, ...le32(data + 40));
  jump('rejected', 0x85);
  // Convert requested foundation origin to the native cursor cell, without writing its live state.
  emit(0x66, 0xa1, ...le32(data + 20), 0x66, 0x2b, 0x05, ...le32(instance + p.placementOffset));
  emit(0x66, 0xa3, ...le32(data + 44));
  emit(0x66, 0xa1, ...le32(data + 22), 0x66, 0x2b, 0x05, ...le32(instance + p.placementOffset + 2));
  emit(0x66, 0xa3, ...le32(data + 46));
  emit(0x68, ...le32(data + 44), 0x68, ...le32(data + 48));
  receiver();
  call(p.placementPreview.address);
  emit(0x83, 0x3d, ...le32(box + 144), 0);
  jump('place-click', 0x85);
  emit(0xc7, 0x05, ...le32(box + 144), ...le32(1), 0xb8, ...le32(1), 0xc3);
  label('place-click');
  emit(0x80, 0x3d, ...le32(instance + p.placementValid), 0);
  jump('rejected', 0x84);
  emit(0x80, 0x3d, ...le32(instance + p.placementValid + 1), 0);
  jump('rejected', 0x84);
  emit(0xa1, ...le32(instance + p.placementOffset - 4), 0xa3, ...le32(data + 44));
  emit(0x8b, 0x2d, ...le32(profile.sidebar.queueCount));
  emit(0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...le32(data + 44), 0x68, ...le32(data + 24));
  receiver();
  call(p.leftUp.address);
  label('outcome');
  emit(0x3b, 0x2d, ...le32(profile.sidebar.queueCount));
  jump('rejected', 0x84);
  emit(0xb8, ...le32(3), 0xc3);
  label('exit-battle');
  // The original quit handler owns event selection (including network departure),
  // queue insertion and its boolean acceptance result. No selected object is required.
  call(p.exitBattle.address);
  emit(0x84, 0xc0);
  jump('rejected', 0x84);
  emit(0xb8, ...le32(3), 0xc3);
  label('selection-rejected');
  call(p.unselect.address);
  label('rejected');
  emit(0xb8, ...le32(5), 0xc3);
  label('full');
  emit(0xb8, ...le32(2), 0xc3);
  return finish();
}
