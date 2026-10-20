import type { RelaySocket } from './relaySocket';

/** One standard binary WebSocket; control and data share a connection without extra negotiation. */
export class WsRelaySocket implements RelaySocket {
  private readonly socket: WebSocket;
  constructor(url: string) {
    this.socket = new globalThis.WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
  }
  get readyState() {
    return this.socket.readyState;
  }
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  get binaryType() {
    return this.socket.binaryType;
  }
  set binaryType(value: string) {
    this.socket.binaryType = value as BinaryType;
  }
  get onopen() {
    return this.socket.onopen;
  }
  set onopen(value: RelaySocket['onopen']) {
    this.socket.onopen = value;
  }
  get onmessage() {
    return this.socket.onmessage;
  }
  set onmessage(value: RelaySocket['onmessage']) {
    this.socket.onmessage = value;
  }
  get onerror() {
    return this.socket.onerror;
  }
  set onerror(value: RelaySocket['onerror']) {
    this.socket.onerror = value;
  }
  get onclose() {
    return this.socket.onclose;
  }
  set onclose(value: RelaySocket['onclose']) {
    this.socket.onclose = value;
  }
  send(frame: Uint8Array) {
    this.socket.send(frame);
  }
  close(code = 1000, reason = ''): void {
    // Browsers prohibit applications from sending reserved status codes; map local port-proxy errors consistently.
    this.socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000, reason);
  }
}
