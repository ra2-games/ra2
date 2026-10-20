import { NativeCommandError, type ControlClient } from './client';

const actions = new Set(['move', 'attack-move', 'attack', 'stop', 'guard', 'deploy', 'scatter']);

/** One visible native multi-selection and player intent, with one session-bound receipt. */
export async function orderGroup(
  client: ControlClient,
  params: Record<string, unknown>,
  emit: (value: unknown) => void,
) {
  const { units, action, sessionId, ...extra } = params;
  if (typeof sessionId !== 'string' || typeof action !== 'string' || !actions.has(action))
    throw new Error('Valid sessionId and unit action required');
  if (
    !Array.isArray(units) ||
    !units.length ||
    units.length > 64 ||
    units.some((id) => typeof id !== 'string') ||
    new Set(units).size !== units.length
  )
    throw new Error('Provide 1..64 distinct unit IDs');
  if ('unit' in extra) throw new Error('Use units, not unit, for group orders');
  const initial = await client.observe();
  if (initial.sessionId !== sessionId) throw new Error('Session changed');
  const unavailable = units.filter(
    (id) => !initial.entities.some((e) => e.id === id && e.owner === initial.player && (e.health ?? 0) > 0),
  );
  const targetUnavailable = action === 'attack' && !initial.entities.some((e) => e.id === extra.target);
  if (unavailable.length || targetUnavailable) {
    emit({
      event: 'group-rejected',
      submitted: [],
      remaining: units,
      unavailable,
      ...(targetUnavailable ? { unavailableTarget: extra.target } : {}),
      next: 'reobserve',
      observation: initial,
    });
    throw new Error(
      unavailable.length ? 'Every group member must be alive, owned and visible' : 'Target must be visible',
    );
  }
  try {
    const receipt = await client.command(action, { ...extra, units }, sessionId);
    emit({ event: 'group-submitted', action, count: units.length, ...receipt });
    return receipt;
  } catch (error) {
    const rejected = error instanceof NativeCommandError && error.state === 'rejected';
    emit({
      event: 'group-interrupted',
      units,
      state: rejected ? 'rejected' : 'unknown',
      ...(error instanceof NativeCommandError ? { commandId: error.commandId } : {}),
      next: rejected ? 'reobserve' : 'inspect',
      error: String(error),
    });
    throw error;
  }
}
