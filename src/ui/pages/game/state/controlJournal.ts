import type { ControlActivity } from '../../../../app/session/controlSession';
import { createStore } from '../../../shared/state/store';

export interface CommandEntry {
  key: string;
  commandId: string;
  time: number;
  action: string;
  type: string;
  unit: string;
  unitCount: number;
  target: string;
  cell: string;
  state: string;
  error: string;
}

/** Only command metadata enters React. Battlefield observations never enter this store. */
export function createControlJournal() {
  const store = createStore<readonly CommandEntry[]>([]);
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 160) : '');
  function activity(event: ControlActivity) {
    if (event.kind === 'reset') {
      store.set([]);
      return;
    }
    if (event.kind === 'disconnect') {
      store.set(
        store
          .getSnapshot()
          .map((entry) => (['receiving', 'pending'].includes(entry.state) ? { ...entry, state: 'unknown' } : entry)),
      );
      return;
    }
    if (event.method !== 'command' && event.method !== 'commandStatus' && event.method !== 'ui.quickStart') return;
    const p = event.params && typeof event.params === 'object' ? (event.params as Record<string, unknown>) : {};
    const commandId = text(p.commandId);
    const key = commandId
      ? JSON.stringify([event.method === 'ui.quickStart' ? 'ui' : text(p.sessionId), commandId])
      : `invalid-${event.requestId}`;
    const entries = store.getSnapshot();
    const previous = entries.find((entry) => entry.key === key);
    if (event.kind === 'request' && !previous) {
      const cell = p.cell && typeof p.cell === 'object' ? (p.cell as Record<string, unknown>) : {};
      store.set(
        [
          {
            key,
            commandId,
            time: Date.now(),
            action: event.method === 'ui.quickStart' ? 'ui.quickStart' : text(p.action),
            type: text(p.type),
            unit: text(p.unit),
            unitCount: Array.isArray(p.units) ? Math.min(p.units.length, 64) : 0,
            target: text(p.target),
            cell: Number.isInteger(cell.x) && Number.isInteger(cell.y) ? `${cell.x}, ${cell.y}` : '',
            state: 'receiving',
            error: '',
          },
          ...entries,
        ].slice(0, 50),
      );
    } else if (event.kind === 'reply' && previous) {
      const r = event.result && typeof event.result === 'object' ? (event.result as Record<string, unknown>) : {};
      const state = event.error ? 'failed' : text(r.state) || 'unknown';
      const error = text(event.error);
      if (previous.state !== state || previous.error !== error)
        store.set(entries.map((entry) => (entry.key === key ? { ...entry, state, error } : entry)));
    }
  }
  return { ...store, activity };
}
