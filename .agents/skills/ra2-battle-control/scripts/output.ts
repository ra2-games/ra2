/** Share repeated keys without losing optional fields or conflating missing values with null. */
function compactRecords(value: unknown): unknown {
  if (!Array.isArray(value) || value.length < 2) return value;
  if (!value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) return value;
  const records = value as Record<string, unknown>[];
  const columns = Object.keys(records[0]!).filter((key) => records.every((row) => Object.hasOwn(row, key)));
  if (!columns.length) return value;
  const shared = new Set(columns);
  const extra = records.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !shared.has(key))));
  const table = {
    columns,
    rows: records.map((row) => columns.map((key) => row[key])),
    ...(extra.some((row) => Object.keys(row).length) ? { extra } : {}),
  };
  return JSON.stringify(table).length < JSON.stringify(value).length ? table : value;
}

/** Keep transport identifiers out of routine model context; raw output remains available for diagnosis. */
export function compactOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactOutput);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !['commandId', 'position', 'screen'].includes(key))
      .map(([key, item]) =>
        key === 'sessionId' && typeof item === 'string'
          ? ['session', item.slice(0, 8)]
          : key === 'completed' && Array.isArray(item)
            ? [key, item.length]
            : [key, ['entities', 'sidebar'].includes(key) ? compactRecords(compactOutput(item)) : compactOutput(item)],
      ),
  );
}
