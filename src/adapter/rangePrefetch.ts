import type { GameFileProvider } from '../resources/contracts';

/** Prefetch only one subsequent page, at most 2 MiB; never copy a whole movie container or mount late pages. */
export class RangePrefetch {
  private generation = 0;
  private speculating = false;
  private next: {
    provider: GameFileProvider;
    path: string;
    offset: number;
    length: number;
    bytes: Promise<Uint8Array | null>;
  } | null = null;
  clear(): void {
    this.generation++;
    this.next = null;
  }
  async read(
    provider: GameFileProvider,
    path: string,
    offset: number,
    length: number,
    totalSize: number,
  ): Promise<Uint8Array | null> {
    const generation = this.generation;
    const pending = this.next;
    this.next = null;
    const hit =
      pending?.provider === provider && pending.path === path && pending.offset === offset && pending.length === length;
    const bytes = (hit ? await pending.bytes : null) ?? (await provider.readRange!(path, offset, length));
    // A prefetch failure must not fail the game early; use normal error reporting if an actual read later fails.
    const nextOffset = offset + length;
    if (!this.speculating && generation === this.generation && bytes?.length === length && nextOffset < totalSize) {
      const nextLength = Math.min(2 * 1024 * 1024, totalSize - nextOffset);
      // Seeking discards the old page, but underlying I/O may not be cancellable; start no more speculative reads until it completes.
      this.speculating = true;
      this.next = {
        provider,
        path,
        offset: nextOffset,
        length: nextLength,
        bytes: Promise.resolve()
          .then(() => provider.readRange!(path, nextOffset, nextLength))
          .catch(() => null)
          .finally(() => {
            this.speculating = false;
          }),
      };
    }
    return bytes;
  }
}
