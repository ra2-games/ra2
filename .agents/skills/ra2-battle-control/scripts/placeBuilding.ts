import { setTimeout as delay } from 'node:timers/promises';
import { NativeCommandError, type ControlClient } from './client';
import type { BattleObservation } from './contracts';
import { batch, validateOrders } from './batch';

/** Visible bounding-box overlaps explain candidates, not native build legality. */
export function visiblePlacementBlockers(state: BattleObservation, type: string, cell: { x: number; y: number }) {
  const bounds = state.sidebar.find((item) => item.type === type)?.foundation;
  if (!bounds) return undefined;
  return state.entities
    .filter((entity) => {
      const size = entity.foundation ?? { width: 1, height: 1 };
      return (
        entity.cell.x < cell.x + bounds.width &&
        entity.cell.x + size.width > cell.x &&
        entity.cell.y < cell.y + bounds.height &&
        entity.cell.y + size.height > cell.y
      );
    })
    .map((entity) => ({ id: entity.id, type: entity.type, cell: entity.cell }));
}

/** Bounded native attempts with observed confirmation; this is not a placement-legality oracle. */
export async function placeBuilding(
  client: ControlClient,
  params: Record<string, unknown>,
  emit: (value: unknown) => void,
) {
  const afterOrders = params.afterOrders === undefined ? undefined : validateOrders(params.afterOrders);
  const type = params.type,
    sessionId = params.sessionId;
  const cells = params.cells as { x: number; y: number }[];
  if (typeof type !== 'string' || typeof sessionId !== 'string') throw new Error('type and sessionId are required');
  if (
    !Array.isArray(cells) ||
    cells.length < 1 ||
    cells.length > 12 ||
    cells.some(
      (c) => !c || !Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x > 511 || c.y > 511,
    )
  )
    throw new Error('Provide 1..12 candidate cells');
  const seen = new Set<string>();
  let latest: BattleObservation | undefined;
  for (const cell of cells) {
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Camera moves are explicit and journaled. They cannot reveal shroud.
    const before = await client.look({ cell }, sessionId);
    latest = before;
    if (before.sessionId !== sessionId) throw new Error('Session changed');
    if (!before.production.some((p) => p.type === type && p.progress === p.total))
      throw new Error('No completed building to place; re-observe');
    const ids = new Set(before.entities.map((e) => e.id));
    let receipt;
    try {
      receipt = await client.command('place', { type, cell }, sessionId);
    } catch (error) {
      if (!(error instanceof NativeCommandError) || error.state !== 'rejected') throw error;
      emit({
        event: 'placement-rejected',
        type,
        cell,
        commandId: error.commandId,
        visibleOverlaps: visiblePlacementBlockers(before, type, cell),
      });
      continue; // A confirmed native rejection is distinct from an ambiguous transport timeout.
    }
    emit({ event: 'placement-submitted', type, cell, ...receipt });
    // A fixed five seconds need not contain 60 simulation frames on the main thread.
    // Allow progressing simulation more time, but keep stalled/consumed outcomes bounded.
    const deadline = performance.now() + 30000;
    let progressDeadline = performance.now() + 5000;
    let visibilityDeadline = Infinity;
    let lastFrame = before.frame;
    let settled = false;
    let consumed = false;
    while (performance.now() < deadline) {
      await delay(150);
      const current = await client.observe();
      latest = current;
      if (current.sessionId !== sessionId) throw new Error('Session changed');
      if (JSON.stringify(current.viewport) !== JSON.stringify(before.viewport))
        throw new Error('Camera changed during placement; result unknown, inspect before retrying');
      const building = current.entities.find(
        (e) =>
          e.owner === current.player &&
          e.kind === 'building' &&
          e.type === type &&
          !ids.has(e.id) &&
          (e.health ?? 0) > 0 &&
          Math.hypot(e.cell.x - cell.x, e.cell.y - cell.y) <= 3,
      );
      const pending = current.production.some((p) => p.type === type && p.progress === p.total);
      if (building && !pending) {
        emit({ event: 'building-confirmed', building, observation: current });
        if (afterOrders) {
          const result = await batch(client, { sessionId, orders: afterOrders });
          emit({ event: 'placement-followup', ...result });
          if (result.state === 'interrupted')
            throw new Error('Building confirmed, but follow-up interrupted; reconcile its completed prefix');
        }
        return building;
      }
      // Product consumption and visibility refresh can arrive in different CPU slices.
      // Once consumed, only observe: neither another site nor another placement is safe.
      if (!pending && !consumed) visibilityDeadline = performance.now() + 5000;
      consumed ||= !pending;
      if (current.frame > lastFrame) {
        lastFrame = current.frame;
        progressDeadline = performance.now() + 5000;
      }
      if (!consumed && current.frame >= before.frame + 60) {
        settled = true;
        break;
      }
      if (performance.now() >= (consumed ? visibilityDeadline : progressDeadline)) break;
    }
    if (consumed) throw new Error('Product consumed but building not confirmed; inspect before retrying');
    if (!settled)
      throw new Error(`Simulation did not settle (${before.frame} → ${lastFrame}); placement outcome unknown`);
    emit({
      event: 'placement-not-confirmed',
      type,
      cell,
      visibleOverlaps: visiblePlacementBlockers(latest!, type, cell),
    });
  }
  emit({ event: 'placement-exhausted', observation: latest });
  throw new Error('No building confirmed at the supplied candidates; choose another area or clear blockers');
}
