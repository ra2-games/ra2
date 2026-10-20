/** Message connection contract shared by browser transports and the Worker port bridge. */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(frame: Uint8Array): void;
  /**
   * Optional fast path: the caller relinquishes exclusive frame ownership and must stop accessing it; the port bridge may defer buffer detachment until microtask dispatch.
   * Never pass guest memory or shared caches, or submit the same buffer twice.
   */
  sendOwned?(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
