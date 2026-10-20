import { setTimeout as delay } from 'node:timers/promises';
import { NativeCommandError, type ControlClient } from './client';
import { placeBuilding } from './placeBuilding';

/** A bounded player-authored construction sequence; no build order or site search policy. */
export async function buildPlan(
  client: ControlClient,
  params: Record<string, unknown>,
  emit: (value: unknown) => void,
) {
  const steps = params.steps as { type: string; cells: { x: number; y: number }[] }[];
  const durationMs = Number(params.durationMs ?? 120000);
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 300000)
    throw new Error('durationMs must be 1000..300000');
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    steps.length > 8 ||
    steps.some(
      (step) =>
        !step ||
        typeof step.type !== 'string' ||
        !step.type ||
        !Array.isArray(step.cells) ||
        !step.cells.length ||
        step.cells.length > 12 ||
        step.cells.some(
          (cell) =>
            !cell ||
            !Number.isInteger(cell.x) ||
            !Number.isInteger(cell.y) ||
            cell.x < 0 ||
            cell.y < 0 ||
            cell.x > 511 ||
            cell.y > 511,
        ),
    )
  )
    throw new Error('Provide 1..8 building steps with type and 1..12 candidate cells each');
  const initial = await client.observe();
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : initial.sessionId;
  if (sessionId !== initial.sessionId) throw new Error('Session changed');
  const deadline = performance.now() + durationMs;
  const completed: { index: number; type: string; building: string }[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      let state = await client.observe();
      if (state.sessionId !== sessionId) throw new Error('Session changed');
      if (performance.now() >= deadline)
        return { state: 'waiting', completed, index, type: step.type, next: 'reobserve' };
      if (!state.production.some((p) => p.type === step.type)) {
        const receipt = await client.command('produce', { type: step.type }, sessionId);
        emit({ event: 'production-submitted', index, type: step.type, ...receipt });
      }
      let lastProgress = -1;
      while (true) {
        state = await client.observe();
        if (state.sessionId !== sessionId) throw new Error('Session changed');
        const product = state.production.find((p) => p.type === step.type);
        if (product?.progress === product?.total && product) break;
        if (performance.now() >= deadline)
          return { state: 'waiting', completed, index, type: step.type, next: 'reobserve' };
        if (product && product.progress !== lastProgress) {
          lastProgress = product.progress;
          emit({
            event: 'production-progress',
            index,
            type: step.type,
            progress: product.progress,
            total: product.total,
          });
        }
        await delay(500);
      }
      const building = await placeBuilding(client, { sessionId, type: step.type, cells: step.cells }, emit);
      completed.push({ index, type: step.type, building: building.id });
    } catch (error) {
      return {
        state: 'interrupted',
        completed,
        index,
        type: step.type,
        next: error instanceof NativeCommandError && error.state === 'rejected' ? 'reobserve' : 'inspect',
        error: String(error),
      };
    }
  }
  return { state: 'completed', completed };
}
