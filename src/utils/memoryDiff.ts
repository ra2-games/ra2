/** Compare memory snapshots at 4-byte granularity without VM or recording-session dependencies. */
export interface MemoryDiff {
  /** Changed regions in ascending address order; to is exclusive and 4-byte aligned. */
  ranges: Array<{ from: number; to: number }>;
  totalBytes: number;
}

/** Compare equal-length memory at 4-byte granularity, merging adjacent changed words into ascending regions. */
export function diffMemory(base: Uint8Array, current: Uint8Array): MemoryDiff {
  const words = Math.min(base.length, current.length) >>> 2;
  const ranges: Array<{ from: number; to: number }> = [];
  let runStart = -1;
  for (let i = 0; i < words; i++) {
    const offset = i << 2;
    const changed =
      base[offset] !== current[offset] ||
      base[offset + 1] !== current[offset + 1] ||
      base[offset + 2] !== current[offset + 2] ||
      base[offset + 3] !== current[offset + 3];
    if (changed) {
      if (runStart < 0) runStart = offset;
    } else if (runStart >= 0) {
      ranges.push({ from: runStart, to: offset });
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push({ from: runStart, to: words << 2 });
  let totalBytes = 0;
  for (const range of ranges) totalBytes += range.to - range.from;
  return { ranges, totalBytes };
}

/**
 * Accumulate changed-word counts from prev to current: keys are addresses, values are observed modification counts.
 * After maxAddresses, add no new addresses and increment only existing ones; return whether truncation occurred.
 */
export function accumulateChangedWords(
  prev: Uint8Array,
  current: Uint8Array,
  counts: Map<number, number>,
  maxAddresses: number,
): boolean {
  const words = Math.min(prev.length, current.length) >>> 2;
  let truncated = false;
  for (let i = 0; i < words; i++) {
    const offset = i << 2;
    if (
      prev[offset] !== current[offset] ||
      prev[offset + 1] !== current[offset + 1] ||
      prev[offset + 2] !== current[offset + 2] ||
      prev[offset + 3] !== current[offset + 3]
    ) {
      const existing = counts.get(offset);
      if (existing !== undefined) counts.set(offset, existing + 1);
      else if (counts.size < maxAddresses) counts.set(offset, 1);
      else truncated = true;
    }
  }
  return truncated;
}
