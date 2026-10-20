export interface GameFileProvider {
  readonly label: string;
  /** Invalidate dynamic directories/persistence indexes without affecting this provider's pending-write snapshots. */
  invalidateCache?(): void;
  /**
   * Return true/false when an existing directory index can decide synchronously, or null before indexing.
   * The VM skips known-missing static resources on false, avoiding an await for each CreateFile.
   */
  hasKnownFile?(path: string): boolean | null;
  /**
   * Memory sources such as extracted ZIPs have variable layouts, requiring recursive subdirectory discovery.
   * Directory-backend enumeration is expensive, so recurse only for explicitly enabled sources.
   */
  deepDiscovery?: boolean;
  read(path: string): Promise<Uint8Array | null>;
  /** Read a file prefix and report its full logical length, keeping huge containers out of the JS heap. */
  readPrefix?(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null>;
  /** Read a specified range of a large file, fetching sparse MIX pages on demand during movie playback. */
  readRange?(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  /** List immediate child names with original case; an empty string denotes the root. Return null if unsupported. */
  list(directory: string): Promise<string[] | null>;
}

/** The executor consumes policies without owning game rules; the composition layer specifies source types. */
export interface ResourcePolicy<Source> {
  prepareSource(source: Source): Promise<Source>;
  isSessionStatic(normalizedPath: string): boolean;
}
