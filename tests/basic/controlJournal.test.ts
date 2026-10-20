import { expect, it } from 'vitest';
import { createControlJournal } from '../../src/ui/pages/game/state/controlJournal';

it('keeps bounded command history, updates receipts, ignores observations, and resets across games', () => {
  const journal = createControlJournal();
  for (let i = 0; i < 55; i++) {
    const params = { sessionId: 'one', commandId: String(i), action: 'produce', type: 'MTNK' };
    journal.activity({ kind: 'request', method: 'command', params });
    journal.activity({ kind: 'reply', method: 'command', params, result: { state: 'pending' } });
  }
  expect(journal.getSnapshot()).toHaveLength(50);
  expect(journal.getSnapshot()[0]).toMatchObject({ commandId: '54', type: 'MTNK', state: 'pending' });
  journal.activity({
    kind: 'reply',
    method: 'commandStatus',
    params: { sessionId: 'one', commandId: '54' },
    result: { state: 'submitted' },
  });
  const snapshot = journal.getSnapshot();
  journal.activity({ kind: 'reply', method: 'observe', params: {}, result: { entities: [] } });
  expect(journal.getSnapshot()).toBe(snapshot);
  journal.activity({ kind: 'disconnect' });
  expect(journal.getSnapshot()[0]!.state).toBe('submitted');
  expect(journal.getSnapshot()[1]!.state).toBe('unknown');
  journal.activity({ kind: 'reset' });
  expect(journal.getSnapshot()).toEqual([]);
});

it('shows malformed command failures and keeps native session IDs separate', () => {
  const journal = createControlJournal();
  journal.activity({ kind: 'request', method: 'command', params: null, requestId: 1 });
  journal.activity({ kind: 'reply', method: 'command', params: null, requestId: 1, error: 'Invalid command' });
  expect(journal.getSnapshot()[0]).toMatchObject({ state: 'failed', error: 'Invalid command' });
  for (const sessionId of ['old', 'new'])
    journal.activity({ kind: 'request', method: 'command', params: { sessionId, commandId: 'same', action: 'stop' } });
  journal.activity({
    kind: 'reply',
    method: 'commandStatus',
    params: { sessionId: 'old', commandId: 'same' },
    result: { state: 'submitted' },
  });
  expect(journal.getSnapshot()[0]!.state).toBe('receiving');
  expect(journal.getSnapshot()[1]!.state).toBe('submitted');
});

it('records a native group as one visible order with its member count', () => {
  const journal = createControlJournal();
  const params = {
    sessionId: 'one',
    commandId: 'group',
    action: 'attack-move',
    units: ['1', '2'],
    cell: { x: 40, y: 30 },
  };
  journal.activity({ kind: 'request', method: 'command', params });
  journal.activity({ kind: 'reply', method: 'commandStatus', params, result: { state: 'submitted' } });
  expect(journal.getSnapshot()).toHaveLength(1);
  expect(journal.getSnapshot()[0]).toMatchObject({
    action: 'attack-move',
    unitCount: 2,
    unit: '',
    cell: '40, 30',
    state: 'submitted',
  });
});
