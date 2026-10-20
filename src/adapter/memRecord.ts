/** Cross-thread result contract for VM memory recording. */
export interface GuestMemRecordResult {
  /** Total bytes changed between the initial baseline and the final sample. */
  totalBytes: number;
  /** Number of changed regions in the final sample. */
  rangeCount: number;
  /** Number of recording samples, including the final one. */
  samples: number;
  /** Truncate once the tracked-address limit is reached; stop recording new addresses. */
  truncated: boolean;
  /** Address statistics sorted by descending modification count, then ascending address; addresses are 4-byte aligned. */
  counts: Array<{ address: number; count: number }>;
}
