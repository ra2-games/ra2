import type { GuestMemory } from '../../vm86/win32';
import type { BattleEntity, BattleObservation } from '@ra2vm/control/contracts';
import type { GameControl } from '../control';
import { readU32, writeU32 } from './guestMemoryIO';
import { le32 } from './bytes';
import { nativeViewport, makeCameraControlCode, type NativeViewportProfile } from './nativeViewport';
import { controlCode, makeSidebarControlCode, type NativeSidebarProfile } from './nativeSidebarControl';
import {
  makePlayerControlCode,
  playerActions,
  playerGroupLimit,
  type NativePlayerControlProfile,
} from './nativePlayerControl';
import { nativeSupportPowers, type NativeSupportPowerProfile } from './nativeSupportPower';
import { makeBattleResultCode, readBattleResult, type NativeBattleResultProfile } from './nativeBattleResult';

export interface NativeControlProfile {
  game: string;
  frame: number;
  localHouse: number;
  houseIndex: number;
  cash: number;
  battleResult?: NativeBattleResultProfile;
  foundation?: {
    typeOffset: number;
    widths: number;
    heights: number;
    count: number;
    widthEvidence: { address: number; bytes: readonly number[] };
    heightEvidence: { address: number; bytes: readonly number[] };
  };
  types: readonly { address: number; kind: BattleEntity['kind']; rtti: number }[];
  sidebar: NativeSidebarProfile;
  playerControl: NativePlayerControlProfile;
  supportPowers?: NativeSupportPowerProfile;
  viewport: NativeViewportProfile;
  factory: { array: number; object: number; owner: number; onHold: number; suspended: number };
  owner: number;
  health: number;
  location: number;
  mission: number;
  uniqueId: number;
  alive: number;
  limbo: number;
  arrays: readonly { address: number; kind: BattleEntity['kind']; typeOffset: number }[];
  /** End-of-frame instruction after the frame-counter evidence window. */
  hook: { address: number; bytes: readonly number[] };
}

/**
 * Host writes a private mailbox only. The native game thread dispatches player UI
 * handlers at the end of a logic iteration. It never
 * edits a live ring header while the CPU may be suspended midway through an append.
 * Mailbox state: 0 idle, 1 published, 2 queue full, 3 submitted, 4 expired, 5 rejected.
 */
export function makeControlMailboxCode(
  address: number,
  mailbox: number,
  profile: NativeControlProfile,
  resultTick?: number,
): Uint8Array {
  const { emit, label, jump, call, finish } = controlCode(address);
  emit(0x9c, 0x60); // pushfd; pushad
  if (resultTick !== undefined) call(resultTick);
  emit(0x83, 0x3d, ...le32(mailbox), 1);
  jump('done', 0x85);
  emit(0xa1, ...le32(profile.localHouse), 0x3b, 0x05, ...le32(mailbox + 8));
  jump('expired', 0x85);
  emit(0xa1, ...le32(profile.frame), 0x2b, 0x05, ...le32(mailbox + 4), 0x3d, ...le32(300));
  jump('expired', 0x87);
  emit(0xfc, 0x83, 0x3d, ...le32(mailbox + 12), 0);
  jump('sidebar', 0x85);
  call(address + 2304);
  jump('store');
  label('sidebar');
  emit(0x83, 0x3d, ...le32(mailbox + 12), 4);
  jump('production', 0x85);
  call(address + 2048);
  jump('store');
  label('production');
  call(address + 512);
  jump('store');
  label('expired');
  emit(0xb8, ...le32(4));
  label('store');
  emit(0xa3, ...le32(mailbox));
  label('done');
  emit(0x61, 0x9d, ...profile.hook.bytes);
  emit(0xe9, ...le32(profile.hook.address + profile.hook.bytes.length - (address + finish().length + 5)));
  return finish();
}

export function createNativeControl(
  memory: GuestMemory,
  reserve: (size: number) => number,
  profile: NativeControlProfile,
): GameControl | null {
  for (const evidence of [
    profile.hook,
    profile.sidebar.constructor,
    profile.sidebar.action,
    profile.sidebar.setTab,
    profile.viewport.position,
    profile.viewport.floor,
    ...(profile.battleResult ? [profile.battleResult.terminal, ...profile.battleResult.evidence] : []),
    ...(profile.foundation ? [profile.foundation.widthEvidence, profile.foundation.heightEvidence] : []),
    ...(profile.supportPowers
      ? [
          profile.supportPowers.canFire,
          profile.supportPowers.selectionEvidence,
          profile.supportPowers.targetingEvidence,
        ]
      : []),
    ...Object.values(profile.playerControl).filter(
      (value): value is { address: number; bytes: readonly number[] } => typeof value !== 'number',
    ),
  ]) {
    const bytes = memory.read_memory(evidence.address, evidence.bytes.length);
    if (bytes.length !== evidence.bytes.length || !evidence.bytes.every((b, i) => bytes[i] === b)) return null;
  }
  const storageSize = profile.battleResult ? 9216 : 8192;
  const storage = reserve(storageSize);
  const groupTable = storage + 7168;
  const mailbox = storage + 256;
  memory.write_memory(new Uint8Array(storageSize), storage);
  const resultRecord = storage + 8192;
  if (profile.battleResult) {
    const context = { ...profile, battleResult: profile.battleResult };
    const tick = makeBattleResultCode(storage + 8256, resultRecord, context, false);
    const terminal = makeBattleResultCode(storage + 8512, resultRecord, context, true);
    if (tick.length > 256 || terminal.length > 704) throw new Error('Native result code exceeds reserved storage');
    memory.write_memory(tick, storage + 8256);
    memory.write_memory(terminal, storage + 8512);
    const site = profile.battleResult.terminal;
    memory.write_memory(
      [0xe9, ...le32(storage + 8512 - site.address - 5), ...Array(site.bytes.length - 5).fill(0x90)],
      site.address,
    );
  }
  memory.write_memory(
    makeSidebarControlCode(storage + 512, mailbox, storage + 1536, profile.sidebar, profile.factory.suspended),
    storage + 512,
  );
  memory.write_memory(makeCameraControlCode(storage + 2048, mailbox, profile.viewport), storage + 2048);
  const playerCode = makePlayerControlCode(storage + 2304, mailbox, storage + 512, profile);
  if (playerCode.length > 7168 - 2304) throw new Error('Native player control exceeds reserved storage');
  memory.write_memory(playerCode, storage + 2304);
  memory.write_memory(
    makeControlMailboxCode(storage, mailbox, profile, profile.battleResult ? storage + 8256 : undefined),
    storage,
  );
  memory.write_memory(
    new Uint8Array([
      0xe9,
      ...le32(storage - profile.hook.address - 5),
      ...Array(profile.hook.bytes.length - 5).fill(0x90),
    ]),
    profile.hook.address,
  );
  let sessionId = crypto.randomUUID();
  let lastFrame = -1;
  let lastHouse = 0;
  let lastGeneration = 0;
  let disposed = false;
  const receipts = new Map<string, { fingerprint: string; state: string }>();
  let pendingId: string | null = null;
  const u32 = (address: number) => readU32(memory, address);
  function syncResultSession() {
    const generation = profile.battleResult ? u32(resultRecord) : 0;
    // A first observation can occur before the first end-of-frame hook. Binding
    // that initial native generation must not invalidate its pending command.
    if (lastGeneration === 0 && generation === 1) {
      lastGeneration = generation;
      return;
    }
    if (generation !== lastGeneration) {
      sessionId = crypto.randomUUID();
      lastGeneration = generation;
      lastFrame = -1;
      lastHouse = 0;
      receipts.clear();
      pendingId = null;
      writeU32(memory, mailbox, 0);
    }
  }
  const foundation = (type: number) => {
    const layout = profile.foundation;
    if (!layout) return undefined;
    const index = u32(type + layout.typeOffset);
    if (index >= layout.count) return undefined;
    const width = u32(layout.widths + index * 4),
      height = u32(layout.heights + index * 4);
    return width > 0 && width <= 32 && height > 0 && height <= 32 ? { width, height } : undefined;
  };
  const u8 = (address: number) => {
    const bytes = memory.read_memory(address, 1);
    if (bytes.length !== 1) throw new Error('Native byte read failed');
    return bytes[0]!;
  };
  const pointer = (address: number) => {
    if (address < 0x10000 || address >= 0x10000000 || address % 4) throw new Error('Invalid native object pointer');
    return address;
  };
  function poll() {
    if (pendingId && u32(mailbox) !== 1) {
      receipts.get(pendingId)!.state =
        u32(mailbox) === 3
          ? 'submitted'
          : u32(mailbox) === 4
            ? 'expired'
            : u32(mailbox) === 5
              ? 'rejected'
              : 'queue-full';
      pendingId = null;
      writeU32(memory, mailbox, 0);
    }
  }
  const visiblePointers = new Map<string, number>();
  const powers = (house: number) =>
    profile.supportPowers
      ? nativeSupportPowers(memory, profile.supportPowers, house, profile.sidebar.instance, sidebarItems(), pointer)
      : null;
  function observe(): BattleObservation {
    syncResultSession();
    visiblePointers.clear();
    const frame = u32(profile.frame);
    const house = u32(profile.localHouse);
    if (!house || frame === 0) throw new Error('Battle not ready');
    pointer(house);
    if (u32(house + profile.houseIndex) > 31) throw new Error('Invalid native player index');
    if (frame < lastFrame || (lastHouse && house !== lastHouse)) {
      sessionId = crypto.randomUUID();
      receipts.clear();
      pendingId = null;
      writeU32(memory, mailbox, 0);
    }
    lastFrame = frame;
    lastHouse = house;
    poll();
    const view = nativeViewport(memory, profile.viewport);
    const entities: BattleEntity[] = [];
    for (const array of profile.arrays) {
      const vector = u32(array.address + 4),
        count = u32(array.address + 16);
      if (count > 8192) throw new Error('Invalid native entity count');
      if (!count) continue;
      pointer(vector);
      for (let i = 0; i < count; i++) {
        const object = pointer(u32(vector + 4 * i));
        if (!u8(object + profile.alive) || u8(object + profile.limbo)) continue;
        // Death animations can remain allocated/visible before native removal.
        const health = u32(object + profile.health) | 0;
        if (health <= 0) continue;
        const owner = u32(object + profile.owner);
        if (!owner) continue;
        pointer(owner);
        const x = u32(object + profile.location) | 0,
          y = u32(object + profile.location + 4) | 0,
          z = u32(object + profile.location + 8) | 0;
        const screen = view.visible(object, { x, y, z }, owner === house, u32(house + profile.houseIndex));
        if (!screen) continue;
        const type = pointer(u32(object + array.typeOffset));
        const name = memory.read_memory(type + 0x24, 24);
        const end = name.indexOf(0);
        visiblePointers.set(String(u32(object + profile.uniqueId)), object);
        entities.push({
          id: String(u32(object + profile.uniqueId)),
          kind: array.kind,
          owner: u32(owner + profile.houseIndex),
          ...(owner === house ? { health, mission: u32(object + profile.mission) | 0 } : {}),
          position: { x, y, z },
          screen,
          cell: { x: Math.floor(x / 256), y: Math.floor(y / 256) },
          type: new TextDecoder().decode(name.subarray(0, end < 0 ? name.length : end)),
          ...(array.kind === 'building' && owner === house ? { foundation: foundation(type) } : {}),
        });
      }
    }
    const types = catalog();
    const production = [];
    for (const item of sidebarItems()) {
      const factory = u32(item.item + 0x0c);
      if (!factory) continue;
      pointer(factory);
      if (u32(factory + profile.factory.owner) !== house || !u32(factory + profile.factory.object)) continue;
      // The cameo supplies the product identity. Probing unrelated object layouts can match stale pointers.
      const type = types.find((entry) => entry.rtti === item.rtti && entry.index === item.typeIndex);
      if (!type) continue;
      production.push({
        type: type.type,
        progress: u32(factory + 0x24),
        total: 54,
        onHold: !!u8(factory + profile.factory.onHold),
        suspended: !!u8(factory + profile.factory.suspended),
      });
    }
    return {
      sessionId,
      frame,
      perspective: 'viewport',
      player: u32(house + profile.houseIndex),
      cash: u32(house + profile.cash) | 0,
      viewport: view.viewport,
      production,
      entities,
      sidebarTab: u32(profile.sidebar.instance + profile.sidebar.activeTab),
      ...(profile.supportPowers
        ? (() => {
            const current = powers(house)!;
            return {
              supportPowers: current.available.map(({ type, ready, onHold, requiresTarget, cameo }) => ({
                type,
                ready,
                onHold,
                requiresTarget,
                tab: cameo.tab,
              })),
              targetingPower: current.selected?.type ?? null,
            };
          })()
        : {}),
      sidebar: sidebarItems().flatMap((item) => {
        const type = types.find((t) => t.rtti === item.rtti && t.index === item.typeIndex);
        return type
          ? [
              {
                type: type.type,
                tab: item.tab,
                progress: u32(item.item + 0x14),
                hasFactory: !!u32(item.item + 0x0c),
                pending: !!u32(item.item + 0x10),
                ...(type.kind === 'building' ? { foundation: foundation(type.pointer) } : {}),
              },
            ]
          : [];
      }),
    };
  }
  function vector(address: number): number[] {
    const data = u32(address + 4),
      count = u32(address + 16);
    if (count > 8192) throw new Error('Invalid native vector count');
    if (!count) return [];
    pointer(data);
    return Array.from({ length: count }, (_, i) => pointer(u32(data + i * 4)));
  }
  function sidebarItems() {
    const items = [];
    const layout = profile.sidebar;
    for (let tab = 0; tab < 4; tab++) {
      const strip = layout.strips + tab * layout.stripSize;
      const count = u32(strip + layout.count);
      if (count > 75) throw new Error('Invalid native sidebar count');
      for (let index = 0; index < count; index++) {
        const item = strip + layout.items + index * layout.itemSize;
        items.push({ strip, tab, index, rtti: u32(item + 4), typeIndex: u32(item), item });
      }
    }
    return items;
  }
  function catalog() {
    return profile.types.flatMap((array) =>
      vector(array.address).map((address, index) => {
        const bytes = memory.read_memory(address + 0x24, 24);
        const end = bytes.indexOf(0);
        return {
          type: new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end)),
          kind: array.kind,
          index,
          rtti: array.rtti,
          pointer: address,
        };
      }),
    );
  }
  const actions = [
    'camera',
    'move',
    'attack',
    'attack-move',
    'stop',
    'guard',
    'deploy',
    'scatter',
    'repair',
    'sell',
    'produce',
    'suspend',
    'cancel',
    'place',
    'exit-battle',
    ...(profile.supportPowers ? ['select-power', 'target-power'] : []),
  ] as const;
  return {
    battleResult() {
      if (disposed) throw new Error('Control session destroyed');
      syncResultSession();
      return profile.battleResult ? readBattleResult(memory, resultRecord, sessionId) : null;
    },
    request(method, value) {
      if (disposed) throw new Error('Control session destroyed');
      if (method === 'capabilities')
        return {
          game: profile.game,
          supported: true,
          perspective: 'viewport',
          actions,
          group: { maxUnits: playerGroupLimit, selection: 'native' },
        };
      if (method === 'observe') return observe();
      if (method === 'catalog') {
        observe();
        const available = sidebarItems();
        return catalog()
          .filter((entry) => available.some((item) => item.rtti === entry.rtti && item.typeIndex === entry.index))
          .map(({ pointer: _pointer, ...entry }) => entry);
      }
      if (!value || typeof value !== 'object') throw new Error('Request parameters required');
      const params = value as Record<string, unknown>;
      // Receipts belong to this controller session and remain readable after native
      // teardown, when the House and entity arrays can already have been released.
      if (method === 'commandStatus') {
        syncResultSession();
        if (params.sessionId !== sessionId) throw new Error('Stale or missing sessionId; observe first');
        if (typeof params.commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.commandId))
          throw new Error('Invalid commandId');
        poll();
        return { commandId: params.commandId, state: receipts.get(params.commandId)?.state ?? 'unknown' };
      }
      const state = observe();
      if (params.sessionId !== sessionId) throw new Error('Stale or missing sessionId; observe first');
      if (typeof params.commandId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.commandId))
        throw new Error('Invalid commandId');
      if (method !== 'command') throw new Error(`Unknown method: ${method}`);
      const fingerprint = JSON.stringify(params);
      const previous = receipts.get(params.commandId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('commandId reused with different parameters');
        return { commandId: params.commandId, state: previous.state };
      }
      if (pendingId) throw new Error('Native command mailbox busy');
      if (receipts.size >= 4096) throw new Error('Session command limit reached');
      if (
        !Number.isInteger(params.observedFrame) ||
        (params.observedFrame as number) > state.frame ||
        state.frame - (params.observedFrame as number) > 300
      )
        throw new Error('Stale or invalid observedFrame');
      const payload = new Uint8Array(112);
      const groupPayload = new Uint8Array(playerGroupLimit * 8);
      const groupView = new DataView(groupPayload.buffer);
      const view = new DataView(payload.buffer);
      const target = (offset: number, entity: BattleEntity) => {
        view.setUint32(offset, visiblePointers.get(entity.id)!, true);
        view.setUint32(offset + 4, Number(entity.id), true);
      };
      const destination = (cell: { x: number; y: number }, z = 0) => {
        view.setInt16(20, cell.x, true);
        view.setInt16(22, cell.y, true);
        view.setInt32(24, cell.x * 256 + 128, true);
        view.setInt32(28, cell.y * 256 + 128, true);
        view.setInt32(32, z, true);
      };
      const cellTarget = () => {
        const cell = params.cell as { x?: unknown; y?: unknown } | undefined;
        if (
          !cell ||
          !Number.isInteger(cell.x) ||
          !Number.isInteger(cell.y) ||
          (cell.x as number) < 0 ||
          (cell.y as number) < 0 ||
          (cell.x as number) > 511 ||
          (cell.y as number) > 511
        )
          throw new Error('Invalid cell');
        return { x: cell.x as number, y: cell.y as number };
      };
      const action = String(params.action);
      if (!(actions as readonly string[]).includes(action)) throw new Error('Unsupported action');
      const group = params.units;
      if (
        group !== undefined &&
        (!['move', 'attack-move', 'attack', 'stop', 'guard', 'deploy', 'scatter'].includes(action) ||
          params.unit !== undefined ||
          !Array.isArray(group) ||
          !group.length ||
          group.length > playerGroupLimit ||
          group.some((id) => typeof id !== 'string') ||
          new Set(group).size !== group.length)
      )
        throw new Error('Group orders require 1..64 distinct units and a unit action; do not combine unit and units');
      const production = new Set(['produce', 'suspend', 'cancel', 'place']);
      let sidebarOrder: { strip: number; index: number; rtti: number; typeIndex: number } | undefined;
      if (action === 'exit-battle') {
        if (['unit', 'target', 'cell', 'type', 'naval'].some((key) => params[key] !== undefined))
          throw new Error('exit-battle does not accept unit, target, cell or production parameters');
        view.setUint32(0, playerActions['exit-battle'], true);
      } else if (action === 'select-power' || action === 'target-power') {
        if (params.unit !== undefined || params.target !== undefined || params.naval !== undefined)
          throw new Error('Support-power actions do not accept unit, target or naval parameters');
        const current = powers(lastHouse)!;
        const power =
          action === 'select-power' ? current.available.find((entry) => entry.type === params.type) : current.selected;
        if (!power || power.type !== params.type)
          throw new Error(
            action === 'select-power'
              ? 'Support power is not in the native sidebar'
              : 'Support power is not currently selected',
          );
        view.setUint32(0, playerActions[action], true);
        view.setUint32(40, power.index, true);
        view.setUint32(44, power.object, true);
        if (action === 'select-power') {
          if (params.cell !== undefined) throw new Error('Select the power before choosing its target');
          sidebarOrder = current.available.find((entry) => entry.index === power.index)!.cameo;
        } else {
          const cell = cellTarget();
          const nativeCell = nativeViewport(memory, profile.viewport).cellAt(cell.x, cell.y);
          if (!nativeCell) throw new Error('Support-power target is outside the map');
          destination(cell);
          view.setUint32(48, nativeCell, true);
        }
      } else if (action === 'camera') {
        if (params.unit !== undefined && params.cell !== undefined)
          throw new Error('Choose a camera cell or visible unit');
        const focus = params.unit === undefined ? null : state.entities.find((e) => e.id === params.unit);
        if (params.unit !== undefined && !focus) throw new Error('Camera focus is not visible in the current viewport');
        const cell = focus ? focus.cell : cellTarget();
        if (!nativeViewport(memory, profile.viewport).cellAt(cell.x, cell.y))
          throw new Error('Camera cell is outside the map');
        view.setInt32(0, cell.x * 256 + 128, true);
        view.setInt32(4, cell.y * 256 + 128, true);
      } else if (production.has(action)) {
        const type = catalog().find((t) => t.type === params.type);
        if (!type) throw new Error('Unknown production type');
        sidebarOrder = sidebarItems().find((item) => item.rtti === type.rtti && item.typeIndex === type.index);
        if (!sidebarOrder) throw new Error('Production type is not available in the native sidebar');
        if (action !== 'place') {
          if (params.naval !== undefined && typeof params.naval !== 'boolean') throw new Error('Invalid naval flag');
          // The native cameo determines naval/build-category policy, not caller-supplied flags.
          const active = state.production.find((p) => p.type === type.type);
          if (action === 'produce' && type.kind === 'building' && active && active.progress === active.total)
            throw new Error('Product is already complete; place it first');
          if (action !== 'produce' && !active) throw new Error('No active production for this type');
          if (action === 'suspend' && active?.suspended) throw new Error('Production is already suspended');
        }
        if (action === 'place') {
          if (type.kind !== 'building') throw new Error('Only buildings can be placed');
          if (!state.production.some((p) => p.type === type.type && p.progress === p.total))
            throw new Error('Building production is not complete');
          const cell = cellTarget();
          if (!nativeViewport(memory, profile.viewport).cellAt(cell.x, cell.y))
            throw new Error('Placement cell is outside the map');
          destination(cell);
          const item = sidebarItems().find((i) => i.strip === sidebarOrder!.strip && i.index === sidebarOrder!.index)!;
          const factory = pointer(u32(item.item + 0x0c));
          view.setUint32(40, pointer(u32(factory + profile.factory.object)), true);
          view.setUint32(0, playerActions.place, true);
        }
      } else {
        const ids = Array.isArray(group) ? group : [params.unit];
        const entities = ids.map((id) => {
          const entity = state.entities.find((e) => e.id === id);
          if (!entity || entity.owner !== state.player || (entity.health ?? 0) <= 0)
            throw new Error('Unit unavailable or not owned by player');
          return entity;
        });
        const entity = entities[0]!;
        if (group !== undefined) {
          view.setUint32(52, entities.length, true);
          view.setUint32(56, groupTable, true);
          for (const [index, member] of entities.entries()) {
            groupView.setUint32(index * 8, visiblePointers.get(member.id)!, true);
            groupView.setUint32(index * 8 + 4, Number(member.id), true);
          }
        }
        target(4, entity);
        view.setUint32(0, playerActions[action as keyof typeof playerActions], true);
        destination(entity.cell, entity.position.z);
        if ((action === 'repair' || action === 'sell') && entity.kind !== 'building')
          throw new Error('This action requires an owned building');
        if (action === 'attack') {
          const enemy = state.entities.find((e) => e.id === params.target);
          if (!enemy) throw new Error('Target is not visible in the current viewport');
          target(12, enemy);
          destination(enemy.cell, enemy.position.z);
        }
        if (action === 'move' || action === 'attack-move') {
          const cell = cellTarget();
          if (!nativeViewport(memory, profile.viewport).cellAt(cell.x, cell.y))
            throw new Error('Destination is outside the map');
          destination(cell);
        }
        if (action === 'move' || action === 'attack-move' || action === 'attack') {
          const nativeCell = nativeViewport(memory, profile.viewport).cellAt(
            view.getInt16(20, true),
            view.getInt16(22, true),
          );
          if (!nativeCell) throw new Error('Destination is outside the map');
          view.setUint32(48, nativeCell, true);
        }
      }
      writeU32(memory, mailbox + 12, action === 'camera' ? 4 : ({ produce: 1, suspend: 2, cancel: 3 }[action] ?? 0));
      if (sidebarOrder) {
        writeU32(memory, mailbox + 128, sidebarOrder.strip);
        writeU32(memory, mailbox + 132, sidebarOrder.index);
        writeU32(memory, mailbox + 136, sidebarOrder.rtti);
        writeU32(memory, mailbox + 140, sidebarOrder.typeIndex);
        writeU32(memory, mailbox + 144, 0);
        writeU32(memory, mailbox + 148, 0);
      }
      memory.write_memory(groupPayload, groupTable);
      memory.write_memory(payload, mailbox + 16);
      writeU32(memory, mailbox + 4, state.frame);
      writeU32(memory, mailbox + 8, lastHouse);
      receipts.set(params.commandId, { fingerprint, state: 'pending' });
      pendingId = params.commandId;
      writeU32(memory, mailbox, 1); // Publish only after all payload bytes are written.
      return { commandId: params.commandId, state: 'pending' };
    },
    dispose() {
      disposed = true;
      writeU32(memory, mailbox, 0);
      receipts.clear();
    },
  };
}
