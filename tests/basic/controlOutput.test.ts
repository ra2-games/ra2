import { expect, it } from 'vitest';
import { compactOutput } from '@ra2vm/control/output';

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.columns) && Array.isArray(record.rows)) {
    const columns = record.columns as string[];
    const extra = record.extra as Record<string, unknown>[] | undefined;
    return record.rows.map((row: unknown[], index: number) => ({
      ...Object.fromEntries(columns.map((key, column) => [key, expand(row[column])])),
      ...(extra?.[index] ?? {}),
    }));
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item)]));
}

it('round-trips mixed visible rosters and sidebar fields without changing order or missing/null distinctions', () => {
  const entities = Array.from({ length: 20 }, (_, id) => ({
    id: String(id),
    kind: 'vehicle',
    owner: 0,
    health: 300 - id,
    cell: { x: id, y: 20 },
    type: 'MTNK',
    ...(id === 0 ? { mission: null } : id === 1 ? {} : { mission: 'guard' }),
    ...(id === 4 ? { selected: true } : {}),
  }));
  const sidebar = Array.from({ length: 10 }, (_, id) => ({
    type: `BUILDING_${id}`,
    tab: 0,
    progress: 0,
    hasFactory: true,
    pending: false,
    ...(id === 0 ? { foundation: { width: 3, height: 2 } } : {}),
  }));
  const input = { event: 'building-confirmed', observation: { frame: 100, entities, sidebar } };
  const before = structuredClone(input);
  const output = compactOutput(input);
  expect(output).toMatchObject({ observation: { entities: { columns: expect.any(Array), extra: expect.any(Array) } } });
  expect(expand(JSON.parse(JSON.stringify(output)))).toEqual(input);
  expect(input).toEqual(before);
  expect(JSON.stringify(output).length).toBeLessThan(JSON.stringify(input).length);
});

it('keeps small, empty, heterogeneous or unprofitable arrays and non-roster arrays unchanged', () => {
  for (const entities of [[], [{ id: '1' }], [{ a: 1 }, { b: 2 }], [null, { id: '1' }], [1, 2], [{ a: 1 }, { a: 2 }]]) {
    expect(compactOutput({ entities })).toEqual({ entities });
  }
  const damaged = Array.from({ length: 10 }, (_, id) => ({ id: String(id), health: 100, previousHealth: 200 }));
  expect(compactOutput({ damaged })).toEqual({ damaged });
});

it('compacts nested observations while retaining rejection evidence and compact protocol metadata', () => {
  const entities = Array.from({ length: 10 }, (_, id) => ({ id: String(id), kind: 'vehicle', owner: 0, health: 300 }));
  const output = compactOutput({
    sessionId: '12345678-uuid',
    completed: [{ commandId: 'receipt' }],
    rejected: [{ index: 1, error: 'Inspect receipt xyz' }],
    observation: { entities },
  });
  expect(output).toMatchObject({
    session: '12345678',
    completed: 1,
    rejected: [{ index: 1, error: 'Inspect receipt xyz' }],
    observation: { entities: { columns: ['id', 'kind', 'owner', 'health'] } },
  });
  expect(expand(output)).toMatchObject({ observation: { entities } });
});
