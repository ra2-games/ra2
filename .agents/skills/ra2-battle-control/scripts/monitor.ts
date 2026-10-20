import { setTimeout as delay } from 'node:timers/promises';
import type { BattleObservation, BattleResult } from './contracts';
import type { ControlClient } from './client';

export interface PageStatus {
  pageId: string;
  phase: string;
  failure: string | null;
  runtime?: { page: string; battlefield: { ready: boolean; sessionId?: string }; battleResult?: BattleResult | null };
}

/** Deltas describe one viewport, never deaths or an all-map enemy roster. */
export function observationDelta(previous: BattleObservation | undefined, current: BattleObservation) {
  const reset = !previous || previous.sessionId !== current.sessionId;
  const before = new Map((reset ? [] : previous.entities).map((e) => [e.id, e]));
  const now = new Set(current.entities.map((e) => e.id));
  return {
    sessionId: current.sessionId,
    frame: current.frame,
    reset,
    cameraChanged: !reset && JSON.stringify(previous.viewport) !== JSON.stringify(current.viewport),
    cash: current.cash,
    production: current.production,
    ...(current.supportPowers === undefined
      ? {}
      : { supportPowers: current.supportPowers, targetingPower: current.targetingPower }),
    enteredView: current.entities.filter((e) => !before.has(e.id)),
    leftView: [...before.keys()].filter((id) => !now.has(id)),
    moved: current.entities.flatMap((entity) => {
      const old = before.get(entity.id);
      return old && (old.cell.x !== entity.cell.x || old.cell.y !== entity.cell.y)
        ? [{ id: entity.id, from: old.cell, to: entity.cell }]
        : [];
    }),
    damaged: current.entities.flatMap((e) => {
      const old = before.get(e.id);
      return e.owner === current.player && old?.health !== undefined && e.health !== undefined && e.health < old.health
        ? [{ id: e.id, type: e.type, health: e.health, lost: old.health - e.health, cell: e.cell }]
        : [];
    }),
    visibleOwned: current.entities.filter((e) => e.owner === current.player && (e.health ?? 0) > 0).length,
  };
}

export async function monitor(client: ControlClient, params: Record<string, unknown>, emit: (value: unknown) => void) {
  const durationMs = Number(params.durationMs ?? 30000),
    intervalMs = Number(params.intervalMs ?? 1000);
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 600000)
    throw new Error('durationMs must be 1..600000');
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000)
    throw new Error('intervalMs must be 250..10000');
  const stopOn = params.stopOn ?? [];
  if (
    !Array.isArray(stopOn) ||
    stopOn.some((event) => !['production-ready', 'support-ready', 'damage', 'contact'].includes(event))
  )
    throw new Error('stopOn must contain production-ready, support-ready, damage or contact');
  let previous: BattleObservation | undefined;
  let pageId: string | undefined;
  let sessionId: string | undefined;
  const ended = (status: PageStatus, event: string) => {
    const result = status.runtime?.battleResult;
    if (
      (pageId !== undefined && status.pageId !== pageId) ||
      (sessionId !== undefined && result && result.sessionId !== sessionId)
    ) {
      emit({ event: 'session-changed', ...(result ? { sessionId: result.sessionId } : {}), status });
    } else {
      emit({ event, status, outcome: result?.outcome ?? 'unknown', ...(result ? { result } : {}) });
    }
  };
  const deadline = performance.now() + durationMs;
  do {
    const status = await client.request<PageStatus>('ui.status');
    if (pageId !== undefined && status.pageId !== pageId) {
      emit({ event: 'session-changed', status });
      return;
    }
    pageId = status.pageId;
    if (!status.runtime?.battlefield.ready) {
      ended(status, previous || status.runtime?.battleResult ? 'battle-ended' : 'not-in-battle');
      return;
    }
    const readySession = status.runtime.battlefield.sessionId;
    if (sessionId !== undefined && readySession !== undefined && readySession !== sessionId) {
      emit({ event: 'session-changed', sessionId: readySession });
      return;
    }
    sessionId ??= readySession;
    let current: BattleObservation;
    try {
      current = await client.observe();
    } catch (error) {
      // Native defeat/victory can switch pages between status and observation.
      const after = await client.request<PageStatus>('ui.status');
      if (!after.runtime?.battlefield.ready) {
        ended(after, 'battle-ended');
        return;
      }
      throw error;
    }
    if (sessionId !== undefined && current.sessionId !== sessionId) {
      emit({ event: 'session-changed', sessionId: current.sessionId });
      return;
    }
    sessionId = current.sessionId;
    const delta = observationDelta(previous, current);
    const reason =
      stopOn.includes('damage') && delta.damaged.length
        ? 'damage'
        : stopOn.includes('contact') && current.entities.some((e) => e.owner !== current.player)
          ? 'contact'
          : stopOn.includes('production-ready') && current.production.some((p) => p.total > 0 && p.progress === p.total)
            ? 'production-ready'
            : stopOn.includes('support-ready') && current.supportPowers?.some((power) => power.ready && !power.onHold)
              ? 'support-ready'
              : undefined;
    if (reason) {
      // Yield the decision back to the caller; monitoring never chooses or executes orders.
      emit({ event: 'monitor-finished', reason, observation: current });
      return;
    }
    emit({ event: 'observation', ...delta });
    previous = current;
    await delay(Math.max(0, Math.min(intervalMs, deadline - performance.now())));
  } while (performance.now() < deadline);
  // Return the sampled decision state, including the sidebar, without another caller round trip.
  emit({ event: 'monitor-finished', reason: 'duration', sessionId: previous?.sessionId, observation: previous });
}

/** Wait outside a battle without starting it or making any gameplay decisions. */
export async function waitForBattle(client: ControlClient, params: Record<string, unknown>) {
  const timeoutMs = Number(params.timeoutMs ?? 180000);
  const intervalMs = Number(params.intervalMs ?? 250);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('timeoutMs must be 1..300000');
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000)
    throw new Error('intervalMs must be 250..10000');
  const deadline = performance.now() + timeoutMs;
  do {
    const status = await client.request<PageStatus>('ui.status');
    if (status.failure || ['error', 'blocked'].includes(status.phase))
      throw new Error(status.failure || `Game runtime ${status.phase}`);
    if (status.runtime?.battlefield?.ready) {
      try {
        return { event: 'battle-ready', observation: await client.observe() };
      } catch (error) {
        // Retry only an actual page transition, not a broken observation endpoint.
        const after = await client.request<PageStatus>('ui.status');
        if (after.failure || after.runtime?.battlefield?.ready) throw error;
      }
    }
    await delay(Math.max(0, Math.min(intervalMs, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error('Battlefield readiness timeout; no gameplay orders submitted');
}
