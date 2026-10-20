/** Reclaim only independent frames already replaced by the page, never guest WASM memory. Bound count and size to avoid backlog when resolution changes. */
export class FrameBufferPool {
  private buffers: ArrayBuffer[] = [];
  release(buffer: ArrayBuffer): void {
    if (!buffer.byteLength || buffer.byteLength > 16 * 1024 * 1024) return;
    if (this.buffers.includes(buffer)) return;
    this.buffers.push(buffer);
    if (this.buffers.length > 2) this.buffers.shift();
  }
  take(size: number): ArrayBuffer {
    const index = this.buffers.findIndex((buffer) => buffer.byteLength === size);
    return index >= 0 ? this.buffers.splice(index, 1)[0]! : new ArrayBuffer(size);
  }
  clear(): void {
    this.buffers = [];
  }
}
