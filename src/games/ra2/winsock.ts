import type { Win32Result, VmNetworkStatus } from '../../vm86/win32';
import type { Constructor } from '../../vm86/shim/state';
import type { withDplayx } from '../../vm86/shim/dplayx';
import {
  RA2NET_MAX_DATAGRAM_BYTES,
  RA2NET_SUBNET_BROADCAST,
  RA2NET_SUBNET_PREFIX,
  isRa2BroadcastAddress,
  isRa2ExeHash,
  isRa2NetworkRoomId,
} from './networkWire';
import {
  createDefaultRa2NetworkTransport,
  type Ra2NetworkPeer,
  type Ra2NetworkTransport,
  type Ra2NetworkTransportFactory,
} from './networkTransport';

type DplayChain = InstanceType<ReturnType<typeof withDplayx>>;

declare module '../../vm86/win32' {
  interface Win32ShimOptions {
    /** RA2 virtual LAN transport factory; browsers default to WebSocket, while Node regressions may inject BroadcastChannel. */
    ra2NetworkTransportFactory?: Ra2NetworkTransportFactory;
    ra2NetworkEnabled?: boolean;
    ra2NetworkRoom?: string;
    ra2ExeHash?: string;
    onNetworkStatus?: (status: VmNetworkStatus) => void;
  }
}

// ---- Winsock 1.1 constants -------------------------------------------------
const AF_INET = 2;
const AF_IPX = 6;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const IPPROTO_UDP = 17;
const IPPROTO_TCP = 6;
const NSPROTO_IPX = 1000;
// IPX socket options (level = NSPROTO_IPX): guest peers interpret header options such as IPX_PTYPE(0x4000)/IPX_FILTERPTYPE(0x4001)
// through the payload; accepting setsockopt suffices without storing each option separately.
const IPX_ADDRESS = 0x4007;
const IPX_MAX_ADAPTER_NUM = 0x400d;
const SOL_SOCKET = 0xffff;
const SO_BROADCAST = 0x0020;
const SO_REUSEADDR = 0x0004;
const SO_SNDBUF = 0x1001;
const SO_RCVBUF = 0x1002;
const SO_ERROR = 0x1007;
const SO_TYPE = 0x1008;
const FD_READ = 0x01;
const FD_WRITE = 0x02;
const MSG_PEEK = 0x2;

const SOCKET_ERROR = 0xffff_ffff;
const WSAEWOULDBLOCK = 10035;
const WSAEINVAL = 10022;
const WSAENOTSOCK = 10038;
const WSAEDESTADDRREQ = 10039;
const WSAEMSGSIZE = 10040;
const WSAENOPROTOOPT = 10042;
const WSAEPROTONOSUPPORT = 10043;
const WSAESOCKTNOSUPPORT = 10044;
const WSAEAFNOSUPPORT = 10047;
const WSAEADDRINUSE = 10048;
const WSAEADDRNOTAVAIL = 10049;
const WSAENOTCONN = 10057;
const WSAEACCES = 10013;
const WSAEFAULT = 10014;
const WSAEMFILE = 10024;
const WSAENOBUFS = 10055;
const WSANOTINITIALISED = 10093;
const WSAVERNOTSUPPORTED = 10092;
const WSAHOST_NOT_FOUND = 11001;

const SOCKET_HANDLE_BASE = 0xa000;
const MAX_SOCKETS = 64;
const EPHEMERAL_PORT_BASE = 49_152;
const EPHEMERAL_PORT_SPAN = 16_384;
/** Per-socket receive-queue limit: UDP allows loss, so drop new packets on overflow instead of exhausting memory. */
const RECV_QUEUE_MAX_PACKETS = 64;
const RECV_QUEUE_MAX_BYTES = 256 * 1024;
/** sockaddr_in is always 16 bytes. */
const SOCKADDR_IN_BYTES = 16;
/** sockaddr_ipx：family(2) + netnum(4) + nodenum(6) + socket(2)。 */
const SOCKADDR_IPX_BYTES = 14;
/** Loopback destinations: 127.0.0.0/8 and the local virtual address. */
const LOOPBACK_PREFIX = 0x7f00_0000;

interface Ra2SocketState {
  handle: number;
  family: number;
  type: number;
  protocol: number;
  /** Bound local address, a network-order u32; 0 = INADDR_ANY. */
  localAddr: number;
  /** Bound port in host order; 0 = unbound. */
  localPort: number;
  broadcast: boolean;
  reuseAddr: boolean;
  rcvbuf: number;
  sndbuf: number;
  asyncHwnd: number;
  asyncMsg: number;
  asyncEvents: number;
  /** FD_READ notification is edge-triggered: do not repeat it while the notified queue remains nonempty. */
  readNotified: boolean;
  recvQueue: Array<{ srcAddr: number; srcPort: number; bytes: Uint8Array }>;
  recvBytes: number;
}

function bswap16(value: number): number {
  return (((value & 0xff) << 8) | ((value >>> 8) & 0xff)) >>> 0;
}

function bswap32(value: number): number {
  return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | ((value >>> 24) & 0xff)) >>> 0;
}

/** Network-order u32 to dotted-decimal text. */
export function formatRa2Address(addr: number): string {
  return `${(addr >>> 24) & 0xff}.${(addr >>> 16) & 0xff}.${(addr >>> 8) & 0xff}.${addr & 0xff}`;
}

/**
 * RA2 Winsock 1.1 guest semantics for 19 ordinal imports from WSOCK32.DLL.
 *
 * Each VM has an independent socket table and per-call error state. Datagrams reach peers through RA2 virtual LAN (BroadcastChannel / WebSocket relay) with unchanged payloads. Create the transport lazily on the first socket or gethostbyname; single-player never touches network facilities.
 *
 * RA2 LAN uses IPX: the main-menu Network button opens socket(AF_IPX, SOCK_DGRAM, NSPROTO_IPX); 1.006's UDP path serves only Internet mode. Map IPX sockets to virtual LAN datagrams: IPX socket number to transport port, nodenum to virtual address with repeated-prefix layout [a0,a1,a2,a3,a0,a1]. The game's IPX_ADDRESS copies overlap the last two bytes; this layout restores the same node. Map FFx6 broadcasts to subnet-directed broadcasts. Without a transport, as in Node regressions/single-player, socket and bind still succeed, sends drop packets, and the lobby can open normally.
 *
 * Ordinal 1111 is EnumProtocolsA, forwarded from mswsock, using 32-byte Win9x PROTOCOL_INFOA structures. Traces confirm RA2 calls it at startup with lpiProtocols=[IPPROTO_UDP,1000,0] and a 4KB buffer, using results only for the diagnostic log "Found protocol %s, max frame size is %d"; UDP/TCP catalog entries suffice for that usage.
 */
export function withRa2Winsock<TBase extends Constructor<DplayChain>>(Base: TBase) {
  return class extends Base {
    private wsaStartupCount = 0;
    private wsaError = 0;
    private readonly ra2Sockets = new Map<number, Ra2SocketState>();
    private nextRa2Socket = SOCKET_HANDLE_BASE;
    private ra2Transport: Ra2NetworkTransport | null = null;
    private ra2NetworkPhase: VmNetworkStatus['phase'] = 'connecting';
    private ra2RelayRttMs: number | undefined;

    private reportNetworkStatus(detail: string): void {
      this.options.onNetworkStatus?.({
        phase: this.ra2NetworkPhase,
        room: this.options.ra2NetworkRoom ?? '',
        peers: this.ra2Peers.size,
        detail,
        relayRttMs: this.ra2RelayRttMs,
      });
    }
    private ra2JoinFailed = false;
    private ra2SelfAddr = 0;
    private readonly ra2Peers = new Map<number, Ra2NetworkPeer>();
    private ra2Hostname = '';
    private ra2HostentBlock = 0;
    private ra2InetNtoaBlock = 0;
    private ra2LastNetLogAt = 0;
    /** Subnet address assigned to the local IPX node without a transport; stable for the session. */
    private ra2IpxFallbackAddr = 0;

    // ---- Basic helpers --------------------------------------------------------

    private wsaFail(code: number): Win32Result {
      this.wsaError = code;
      return { eax: SOCKET_ERROR };
    }

    /** Stable, approximately room-unique virtual hostname: RA2VM- plus a random instance suffix. */
    private ensureRa2Hostname(): string {
      if (!this.ra2Hostname) {
        const suffix = Math.floor(Math.random() * 0xff_ffff)
          .toString(16)
          .padStart(6, '0')
          .toUpperCase();
        this.ra2Hostname = `RA2VM-${suffix}`;
      }
      return this.ra2Hostname;
    }

    /** Guest sockaddr_in to { family, port, addr }, converting port/address to internal numeric conventions. */
    private readSockaddrIn(ptr: number): { family: number; port: number; addr: number } | null {
      if (!ptr) return null;
      return {
        family: this.readU16(ptr),
        port: bswap16(this.readU16(ptr + 2)),
        addr: bswap32(this.readU32(ptr + 4)),
      };
    }

    private writeSockaddrIn(ptr: number, addr: number, port: number): void {
      this.zero(ptr, SOCKADDR_IN_BYTES);
      this.memory.write_memory([AF_INET & 0xff, 0], ptr);
      const bePort = bswap16(port);
      this.memory.write_memory([bePort & 0xff, (bePort >>> 8) & 0xff], ptr + 2);
      const beAddr = bswap32(addr);
      this.writeU32(ptr + 4, beAddr);
    }

    // ---- IPX address mapping --------------------------------------------------

    /** Local IPX node address: prefer the transport-assigned address; otherwise use a session-random subnet address. */
    private ensureRa2IpxSelfAddr(): number {
      if (this.ra2SelfAddr) return this.ra2SelfAddr;
      if (!this.ra2IpxFallbackAddr) {
        this.ra2IpxFallbackAddr = (RA2NET_SUBNET_PREFIX | (0x100 + Math.floor(Math.random() * 0xfe00))) >>> 0;
      }
      return this.ra2IpxFallbackAddr;
    }

    /** Virtual address to IPX nodenum: [a0,a1,a2,a3,a0,a1], repeating the prefix as explained in the header comment. */
    private ipxNodeOf(addr: number): number[] {
      const b = [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff];
      return [b[0]!, b[1]!, b[2]!, b[3]!, b[0]!, b[1]!];
    }

    /** Whether IPX nodenum is all FF, the IPX broadcast node. */
    private isIpxBroadcastNode(node: number[]): boolean {
      return node.every((byte) => byte === 0xff);
    }

    /** Guest sockaddr_ipx to { family, node, socket }, converting the socket number to internal numeric conventions. */
    private readSockaddrIpx(ptr: number): { family: number; node: number[]; socket: number } | null {
      if (!ptr) return null;
      return {
        family: this.readU16(ptr),
        node: [...this.memory.read_memory(ptr + 6, 6)],
        socket: bswap16(this.readU16(ptr + 12)),
      };
    }

    private writeSockaddrIpx(ptr: number, addr: number, socket: number): void {
      this.zero(ptr, SOCKADDR_IPX_BYTES);
      this.memory.write_memory([AF_IPX & 0xff, 0], ptr);
      // Keep netnum at 0: all nodes belong to the local subnet.
      this.memory.write_memory(this.ipxNodeOf(addr), ptr + 6);
      const beSocket = bswap16(socket);
      this.memory.write_memory([beSocket & 0xff, (beSocket >>> 8) & 0xff], ptr + 12);
    }

    // ---- Virtual LAN session --------------------------------------------------

    /** Join the virtual LAN lazily; record any failure in joinFailed and retain isolated single-player semantics. */
    private ensureRa2Network(): void {
      if (this.ra2Transport || this.ra2JoinFailed) return;
      if (this.options.ra2NetworkEnabled !== true) {
        this.ra2JoinFailed = true;
        return;
      }
      const room = this.options.ra2NetworkRoom;
      const exeHash = this.options.ra2ExeHash;
      if (!isRa2NetworkRoomId(room) || !isRa2ExeHash(exeHash)) {
        this.ra2JoinFailed = true;
        this.ra2Log('虚拟 LAN 配置缺少有效房间或 EXE 哈希');
        return;
      }
      try {
        this.ra2NetworkPhase = 'connecting';
        this.ra2RelayRttMs = undefined;
        this.reportNetworkStatus('正在连接中继');
        const factory = this.options.ra2NetworkTransportFactory ?? createDefaultRa2NetworkTransport;
        const name = new Uint8Array(64);
        const host = this.ensureRa2Hostname();
        for (let i = 0; i < host.length; i++) name[i] = host.charCodeAt(i) & 0x7f;
        this.ra2Transport = factory(
          {
            onReady: (self, peers) => {
              this.ra2NetworkPhase = 'connected';
              this.ra2SelfAddr = self.addr;
              for (const peer of peers) this.ra2Peers.set(peer.addr, peer);
              this.reportNetworkStatus('虚拟 LAN 已连接');
              console.log(`[ra2net] 已加入虚拟 LAN：本机 ${formatRa2Address(self.addr)}，成员 ${this.ra2Peers.size}`);
            },
            onPeerJoin: (peer) => {
              this.ra2Peers.set(peer.addr, peer);
              this.reportNetworkStatus('虚拟 LAN 已连接');
            },
            onPeerLeave: (_id, addr) => {
              this.ra2Peers.delete(addr);
              this.reportNetworkStatus('有玩家离开虚拟 LAN');
            },
            onDatagram: (srcAddr, srcPort, destPort, payload) => {
              this.deliverDatagram(srcAddr, srcPort, destPort, payload, false);
            },
            onClose: (reason) => {
              this.ra2Peers.clear();
              this.ra2NetworkPhase = 'disconnected';
              this.ra2RelayRttMs = undefined;
              this.reportNetworkStatus(reason);
              if (reason && reason !== 'closed') this.ra2Log(`连接关闭：${reason}`);
            },
            onError: (error) => {
              this.ra2Log(`传输错误：${error instanceof Error ? error.message : String(error)}`);
            },
            onLatency: (rttMs) => {
              this.ra2RelayRttMs = rttMs;
              this.reportNetworkStatus('虚拟 LAN 已连接');
            },
          },
          {
            room,
            name,
            exeHash,
          },
        );
      } catch (error) {
        this.ra2JoinFailed = true;
        this.ra2NetworkPhase = 'error';
        this.reportNetworkStatus(error instanceof Error ? error.message : String(error));
        this.ra2Log(`虚拟 LAN 不可用：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    private ra2Log(message: string): void {
      const now = Date.now();
      if (now - this.ra2LastNetLogAt < 1000) return;
      this.ra2LastNetLogAt = now;
      console.warn(`[ra2net] ${message}`);
    }

    /** Incoming datagrams: dispatch by port to bound sockets and trigger FD_READ edge notifications. */
    private deliverDatagram(
      srcAddr: number,
      srcPort: number,
      destPort: number,
      payload: Uint8Array,
      loopback: boolean,
    ): void {
      for (const socket of this.ra2Sockets.values()) {
        if (socket.type !== SOCK_DGRAM || socket.localPort === 0 || socket.localPort !== destPort) continue;
        // Sockets bound to a specific address receive only packets addressed to it; INADDR_ANY and broadcasts are unrestricted.
        if (
          !loopback &&
          socket.localAddr !== 0 &&
          socket.localAddr !== this.ra2SelfAddr &&
          !isRa2BroadcastAddress(socket.localAddr)
        ) {
          continue;
        }
        if (
          socket.recvQueue.length >= RECV_QUEUE_MAX_PACKETS ||
          socket.recvBytes + payload.byteLength > RECV_QUEUE_MAX_BYTES
        ) {
          continue; // UDP semantics: drop new packets when the queue is full.
        }
        socket.recvQueue.push({ srcAddr, srcPort, bytes: payload.slice() });
        socket.recvBytes += payload.byteLength;
        if ((socket.asyncEvents & FD_READ) !== 0 && socket.asyncHwnd && !socket.readNotified) {
          socket.readNotified = true;
          this.queueMessage(socket.asyncMsg, socket.handle, FD_READ, socket.asyncHwnd);
        }
      }
    }

    /** Implicit bind: Windows assigns an ephemeral port when sendto uses an unbound socket. */
    private bindEphemeral(socket: Ra2SocketState): boolean {
      for (let attempt = 0; attempt < EPHEMERAL_PORT_SPAN; attempt++) {
        const port = EPHEMERAL_PORT_BASE + ((socket.handle + attempt * 7) % EPHEMERAL_PORT_SPAN);
        if (![...this.ra2Sockets.values()].some((other) => other.localPort === port)) {
          socket.localAddr = 0;
          socket.localPort = port;
          return true;
        }
      }
      return false;
    }

    protected disposeGameNetwork(): void {
      const transport = this.ra2Transport;
      this.ra2Transport = null;
      transport?.close();
      this.ra2Peers.clear();
      this.ra2Sockets.clear();
    }

    /** Smoke/debug inspection: snapshot the virtual LAN and socket table. */
    public inspectRa2Network(): {
      started: number;
      selfAddr: string;
      peers: string[];
      sockets: Array<{ handle: number; port: number; queued: number }>;
      lastError: number;
    } {
      return {
        started: this.wsaStartupCount,
        selfAddr: this.ra2SelfAddr ? formatRa2Address(this.ra2SelfAddr) : '',
        peers: [...this.ra2Peers.keys()].map(formatRa2Address),
        sockets: [...this.ra2Sockets.values()].map((socket) => ({
          handle: socket.handle,
          port: socket.localPort,
          queued: socket.recvQueue.length,
        })),
        lastError: this.wsaError,
      };
    }

    // ---- Winsock API ---------------------------------------------------------

    private wsaStartup(a: number[]): Win32Result {
      const requested = a[0] ?? 0;
      const data = a[1] ?? 0;
      if ((requested & 0xff) < 1) return this.wsaFail(WSAVERNOTSUPPORTED);
      this.wsaStartupCount++;
      if (data) {
        // WSADATA 1.1: wVersion/wHighVersion, 257B description, 129B status, and limit fields.
        this.zero(data, 400);
        this.memory.write_memory([1, 1, 1, 1], data);
        const description = 'RA2 Virtual Winsock 1.1';
        for (let i = 0; i < description.length; i++) {
          this.memory.write_memory([description.charCodeAt(i) & 0x7f], data + 4 + i);
        }
        const status = 'Running';
        for (let i = 0; i < status.length; i++) {
          this.memory.write_memory([status.charCodeAt(i) & 0x7f], data + 4 + 257 + i);
        }
        this.memory.write_memory([MAX_SOCKETS & 0xff, 0], data + 4 + 257 + 129); // iMaxSockets
        this.memory.write_memory(
          [RA2NET_MAX_DATAGRAM_BYTES & 0xff, (RA2NET_MAX_DATAGRAM_BYTES >>> 8) & 0xff],
          data + 4 + 257 + 131,
        );
      }
      return { eax: 0 };
    }

    private wsaCleanup(): Win32Result {
      if (this.wsaStartupCount === 0) return this.wsaFail(WSANOTINITIALISED);
      this.wsaStartupCount--;
      if (this.wsaStartupCount === 0) {
        this.ra2Sockets.clear();
        const transport = this.ra2Transport;
        this.ra2Transport = null;
        transport?.close();
        this.ra2Peers.clear();
        this.ra2SelfAddr = 0;
      }
      return { eax: 0 };
    }

    private wsaSocket(a: number[]): Win32Result {
      const family = a[0] ?? 0;
      const type = a[1] ?? 0;
      const protocol = a[2] ?? 0;
      if (this.wsaStartupCount === 0) return this.wsaFail(WSANOTINITIALISED);
      if (family !== AF_INET && family !== AF_IPX) return this.wsaFail(WSAEAFNOSUPPORT);
      if (type !== SOCK_DGRAM && type !== SOCK_STREAM) return this.wsaFail(WSAESOCKTNOSUPPORT);
      if (family === AF_IPX) {
        // IPX supports only datagrams; the protocol is always NSPROTO_IPX.
        if (type !== SOCK_DGRAM) return this.wsaFail(WSAESOCKTNOSUPPORT);
        if (protocol !== 0 && protocol !== NSPROTO_IPX) return this.wsaFail(WSAEPROTONOSUPPORT);
      } else if (
        protocol !== 0 &&
        ((type === SOCK_DGRAM && protocol !== IPPROTO_UDP) || (type === SOCK_STREAM && protocol !== IPPROTO_TCP))
      ) {
        return this.wsaFail(WSAEPROTONOSUPPORT);
      }
      if (this.ra2Sockets.size >= MAX_SOCKETS) return this.wsaFail(WSAEMFILE);
      const handle = this.nextRa2Socket++;
      this.ra2Sockets.set(handle, {
        handle,
        family,
        type,
        protocol: protocol || (family === AF_IPX ? NSPROTO_IPX : type === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP),
        localAddr: 0,
        localPort: 0,
        broadcast: false,
        reuseAddr: false,
        rcvbuf: 8192,
        sndbuf: 8192,
        asyncHwnd: 0,
        asyncMsg: 0,
        asyncEvents: 0,
        readNotified: false,
        recvQueue: [],
        recvBytes: 0,
      });
      // Join the virtual LAN on first socket creation; discovery traffic may arrive before sendto.
      this.ensureRa2Network();
      return { eax: handle };
    }

    private wsaBind(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      if (socket.localPort !== 0) return this.wsaFail(WSAEINVAL);
      if (socket.family === AF_IPX) {
        const addr = this.readSockaddrIpx(a[1] ?? 0);
        if (!addr || (a[2] ?? 0) < SOCKADDR_IPX_BYTES) return this.wsaFail(WSAEFAULT);
        if (addr.family !== AF_IPX) return this.wsaFail(WSAEINVAL);
        if (addr.socket === 0) {
          if (!this.bindEphemeral(socket)) return this.wsaFail(WSAEADDRINUSE);
          return { eax: 0 };
        }
        const conflict = [...this.ra2Sockets.values()].find(
          (other) => other !== socket && other.localPort === addr.socket,
        );
        if (conflict) return this.wsaFail(WSAEADDRINUSE);
        // IPX bind does not restrict delivery addresses: netnum 0 means the local subnet and the node is local.
        socket.localAddr = 0;
        socket.localPort = addr.socket;
        return { eax: 0 };
      }
      const addr = this.readSockaddrIn(a[1] ?? 0);
      if (!addr || (a[2] ?? 0) < SOCKADDR_IN_BYTES) return this.wsaFail(WSAEFAULT);
      if (addr.family !== AF_INET) return this.wsaFail(WSAEINVAL);
      const isLoopback = (addr.addr & 0xff00_0000) === LOOPBACK_PREFIX;
      const inSubnet = (addr.addr & 0xffff_0000) === RA2NET_SUBNET_PREFIX;
      if (addr.addr !== 0 && !isLoopback && !inSubnet && (!this.ra2SelfAddr || addr.addr !== this.ra2SelfAddr)) {
        return this.wsaFail(WSAEADDRNOTAVAIL);
      }
      if (addr.port === 0) {
        if (!this.bindEphemeral(socket)) return this.wsaFail(WSAEADDRINUSE);
        socket.localAddr = addr.addr;
        return { eax: 0 };
      }
      const conflict = [...this.ra2Sockets.values()].find(
        (other) =>
          other !== socket &&
          other.localPort === addr.port &&
          (other.localAddr === 0 || addr.addr === 0 || other.localAddr === addr.addr) &&
          !(other.reuseAddr && socket.reuseAddr),
      );
      if (conflict) return this.wsaFail(WSAEADDRINUSE);
      socket.localAddr = addr.addr;
      socket.localPort = addr.port;
      return { eax: 0 };
    }

    private wsaCloseSocket(a: number[]): Win32Result {
      const handle = a[0] ?? 0;
      if (!this.ra2Sockets.delete(handle)) return this.wsaFail(WSAENOTSOCK);
      return { eax: 0 };
    }

    private wsaSendTo(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      if (socket.type !== SOCK_DGRAM) return this.wsaFail(WSAENOTCONN);
      const length = a[2] ?? 0;
      const buffer = a[1] ?? 0;
      if (length > 0 && !buffer) return this.wsaFail(WSAEFAULT);
      if (length > RA2NET_MAX_DATAGRAM_BYTES) return this.wsaFail(WSAEMSGSIZE);
      if (socket.family === AF_IPX) {
        const target = this.readSockaddrIpx(a[4] ?? 0);
        if (!target) return this.wsaFail(WSAEDESTADDRREQ);
        if (target.family !== AF_IPX) return this.wsaFail(WSAEAFNOSUPPORT);
        if (target.socket === 0) return this.wsaFail(WSAEDESTADDRREQ);
        if (socket.localPort === 0 && !this.bindEphemeral(socket)) return this.wsaFail(WSAEADDRINUSE);
        if (length === 0) return { eax: 0 };
        const payload = this.memory.read_memory(buffer, length).slice();
        const broadcast = this.isIpxBroadcastNode(target.node);
        if (broadcast && !socket.broadcast) return this.wsaFail(WSAEACCES);
        const self = this.ensureRa2IpxSelfAddr();
        const destAddr = broadcast
          ? RA2NET_SUBNET_BROADCAST
          : ((target.node[0]! << 24) | (target.node[1]! << 16) | (target.node[2]! << 8) | target.node[3]!) >>> 0;
        const loopback =
          !broadcast && (destAddr === self || (this.ra2IpxFallbackAddr !== 0 && destAddr === this.ra2IpxFallbackAddr));
        if (broadcast || loopback) {
          // Deliver broadcasts back to the local host, matching real stacks, and locally addressed packets through local delivery.
          this.deliverDatagram(self, socket.localPort, target.socket, payload, true);
        }
        // If transport is not ready, drop as packet loss while reporting send success to the guest; local unicast never goes online.
        if (!loopback) {
          this.ra2Transport?.sendDatagram(destAddr, target.socket, socket.localPort, payload);
        }
        return { eax: length };
      }
      const target = this.readSockaddrIn(a[4] ?? 0);
      if (!target) return this.wsaFail(WSAEDESTADDRREQ);
      if (target.family !== AF_INET) return this.wsaFail(WSAEAFNOSUPPORT);
      if (target.port === 0) return this.wsaFail(WSAEDESTADDRREQ);
      if (socket.localPort === 0 && !this.bindEphemeral(socket)) return this.wsaFail(WSAEADDRINUSE);
      if (length === 0) return { eax: 0 }; // Drop empty datagrams locally; the wire protocol does not carry them.
      const payload = this.memory.read_memory(buffer, length).slice();
      const broadcast = isRa2BroadcastAddress(target.addr);
      if (broadcast && !socket.broadcast) return this.wsaFail(WSAEACCES);
      const loopback =
        (target.addr & 0xff00_0000) === LOOPBACK_PREFIX || (this.ra2SelfAddr !== 0 && target.addr === this.ra2SelfAddr);
      if (loopback) {
        this.deliverDatagram(this.ra2SelfAddr || 0x7f00_0001, socket.localPort, target.port, payload, true);
        return { eax: length };
      }
      if (broadcast) {
        // Loop broadcasts back locally, matching real stacks, then fan out to other room members.
        this.deliverDatagram(this.ra2SelfAddr || 0x7f00_0001, socket.localPort, target.port, payload, true);
      }
      // If transport is not ready, apply UDP packet-loss semantics while reporting send success to the guest.
      this.ra2Transport?.sendDatagram(target.addr, target.port, socket.localPort, payload);
      return { eax: length };
    }

    private wsaRecvFrom(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      if (socket.localPort === 0) return this.wsaFail(WSAEINVAL);
      const buffer = a[1] ?? 0;
      const capacity = a[2] ?? 0;
      const flags = a[3] ?? 0;
      const fromPtr = a[4] ?? 0;
      const fromLenPtr = a[5] ?? 0;
      if (capacity > 0 && !buffer) return this.wsaFail(WSAEFAULT);
      const head = socket.recvQueue[0];
      if (!head) return this.wsaFail(WSAEWOULDBLOCK);
      const peek = (flags & MSG_PEEK) !== 0;
      const truncated = capacity < head.bytes.byteLength;
      const copied = Math.min(capacity, head.bytes.byteLength);
      if (copied > 0) this.memory.write_memory(head.bytes.subarray(0, copied), buffer);
      if (fromPtr) {
        if (socket.family === AF_IPX) this.writeSockaddrIpx(fromPtr, head.srcAddr, head.srcPort);
        else this.writeSockaddrIn(fromPtr, head.srcAddr, head.srcPort);
      }
      if (fromLenPtr) {
        this.writeU32(fromLenPtr, socket.family === AF_IPX ? SOCKADDR_IPX_BYTES : SOCKADDR_IN_BYTES);
      }
      if (!peek) {
        socket.recvQueue.shift();
        socket.recvBytes -= head.bytes.byteLength;
        // Rearm FD_READ after draining for the next edge; if still nonempty, post another notification following Winsock semantics.
        if (socket.recvQueue.length === 0) {
          socket.readNotified = false;
        } else if ((socket.asyncEvents & FD_READ) !== 0 && socket.asyncHwnd) {
          this.queueMessage(socket.asyncMsg, socket.handle, FD_READ, socket.asyncHwnd);
        }
      }
      if (truncated) return this.wsaFail(WSAEMSGSIZE);
      return { eax: head.bytes.byteLength };
    }

    private wsaSetSockOpt(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      const level = a[1] ?? 0;
      const option = a[2] ?? 0;
      const valuePtr = a[3] ?? 0;
      const valueLength = a[4] ?? 0;
      if (!valuePtr || valueLength < 4) return this.wsaFail(WSAEFAULT);
      // IPX_PTYPE / IPX_FILTERPTYPE and other header options: virtual LAN forwards payloads unchanged,
      // and guest peers interpret headers, so registration succeeds directly.
      if (level === NSPROTO_IPX) return { eax: 0 };
      if (level !== SOL_SOCKET) return this.wsaFail(WSAENOPROTOOPT);
      const value = this.readU32(valuePtr);
      switch (option) {
        case SO_BROADCAST:
          socket.broadcast = value !== 0;
          return { eax: 0 };
        case SO_REUSEADDR:
          socket.reuseAddr = value !== 0;
          return { eax: 0 };
        case SO_RCVBUF:
          socket.rcvbuf = value;
          return { eax: 0 };
        case SO_SNDBUF:
          socket.sndbuf = value;
          return { eax: 0 };
        default:
          return this.wsaFail(WSAENOPROTOOPT);
      }
    }

    private wsaGetSockOpt(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      const level = a[1] ?? 0;
      const option = a[2] ?? 0;
      const valuePtr = a[3] ?? 0;
      const lengthPtr = a[4] ?? 0;
      if (!valuePtr || !lengthPtr) return this.wsaFail(WSAEFAULT);
      if (level === NSPROTO_IPX) {
        if (option === IPX_MAX_ADAPTER_NUM) {
          // One network adapter: the game requires requested adapter indexes to be less than this value.
          this.writeU32(valuePtr, 1);
          this.writeU32(lengthPtr, 4);
          return { eax: 0 };
        }
        if (option === IPX_ADDRESS) {
          // Layout follows game reads: netnum@0(4), reserved@4(4), nodenum@8(6), socket@14(2).
          if (this.readU32(lengthPtr) < 16) return this.wsaFail(WSAEFAULT);
          this.zero(valuePtr, 16);
          this.memory.write_memory(this.ipxNodeOf(this.ensureRa2IpxSelfAddr()), valuePtr + 8);
          const beSocket = bswap16(socket.localPort);
          this.memory.write_memory([beSocket & 0xff, (beSocket >>> 8) & 0xff], valuePtr + 14);
          this.writeU32(lengthPtr, 16);
          return { eax: 0 };
        }
        return this.wsaFail(WSAENOPROTOOPT);
      }
      if (level !== SOL_SOCKET) return this.wsaFail(WSAENOPROTOOPT);
      const write = (value: number): Win32Result => {
        this.writeU32(valuePtr, value);
        this.writeU32(lengthPtr, 4);
        return { eax: 0 };
      };
      switch (option) {
        case SO_BROADCAST:
          return write(socket.broadcast ? 1 : 0);
        case SO_REUSEADDR:
          return write(socket.reuseAddr ? 1 : 0);
        case SO_RCVBUF:
          return write(socket.rcvbuf);
        case SO_SNDBUF:
          return write(socket.sndbuf);
        case SO_TYPE:
          return write(socket.type);
        case SO_ERROR:
          return write(0);
        default:
          return this.wsaFail(WSAENOPROTOOPT);
      }
    }

    private wsaAsyncSelect(a: number[]): Win32Result {
      const socket = this.ra2Sockets.get(a[0] ?? 0);
      if (!socket) return this.wsaFail(WSAENOTSOCK);
      const hwnd = a[1] ?? 0;
      const message = a[2] ?? 0;
      const events = a[3] ?? 0;
      if (events === 0 || !hwnd) {
        socket.asyncHwnd = 0;
        socket.asyncMsg = 0;
        socket.asyncEvents = 0;
        socket.readNotified = false;
        return { eax: 0 };
      }
      socket.asyncHwnd = hwnd;
      socket.asyncMsg = message;
      socket.asyncEvents = events;
      // Datagram sockets are always writable; native stacks post FD_WRITE immediately after registration.
      if ((events & FD_WRITE) !== 0) {
        this.queueMessage(message, socket.handle, FD_WRITE, hwnd);
      }
      // If the queue already contains data at registration, post FD_READ immediately.
      if ((events & FD_READ) !== 0 && socket.recvQueue.length > 0 && !socket.readNotified) {
        socket.readNotified = true;
        this.queueMessage(message, socket.handle, FD_READ, hwnd);
      }
      return { eax: 0 };
    }

    private wsaGetHostName(a: number[]): Win32Result {
      const buffer = a[0] ?? 0;
      const length = a[1] ?? 0;
      if (!buffer) return this.wsaFail(WSAEFAULT);
      const name = this.ensureRa2Hostname();
      if (length <= name.length) return this.wsaFail(WSAEFAULT);
      for (let i = 0; i < name.length; i++) {
        this.memory.write_memory([name.charCodeAt(i) & 0x7f], buffer + i);
      }
      this.memory.write_memory([0], buffer + name.length);
      return { eax: 0 };
    }

    private wsaGetHostByName(a: number[]): Win32Result {
      const namePtr = a[0] ?? 0;
      if (!namePtr) {
        this.wsaError = WSAHOST_NOT_FOUND;
        return { eax: 0 };
      }
      const requested = this.readCString(namePtr, 256).toLowerCase();
      const hostname = this.ensureRa2Hostname().toLowerCase();
      // Resolving the local hostname is how the game obtains its own IP; joining the virtual LAN now is still early enough for discovery.
      this.ensureRa2Network();
      let addr: number;
      if (requested === hostname) {
        addr = this.ra2SelfAddr || 0x7f00_0001;
      } else if (requested === 'localhost') {
        addr = 0x7f00_0001;
      } else {
        this.wsaError = WSAHOST_NOT_FOUND;
        return { eax: 0 };
      }
      // Static hostent buffer; real Winsock keeps one per thread, overwritten by repeated calls.
      if (!this.ra2HostentBlock) this.ra2HostentBlock = this.alloc(96, true);
      const block = this.ra2HostentBlock;
      this.zero(block, 96);
      const nameOut = block + 16;
      const host = this.ensureRa2Hostname();
      for (let i = 0; i < host.length; i++) {
        this.memory.write_memory([host.charCodeAt(i) & 0x7f], nameOut + i);
      }
      const addrList = block + 16 + 64; // h_addr_list array: [addrPtr, 0].
      const addrOut = addrList + 8;
      this.writeU32(addrOut, bswap32(addr));
      this.writeU32(addrList, addrOut);
      this.writeU32(block, nameOut); // h_name
      this.writeU32(block + 4, block + 16 + 64 + 8 + 4); // h_aliases points to an empty array.
      this.memory.write_memory([AF_INET & 0xff, 0, 4, 0], block + 8); // h_addrtype + h_length
      this.writeU32(block + 12, addrList);
      return { eax: block };
    }

    /** EnumProtocolsA: Win9x PROTOCOL_INFOA, 8 fields and 32 bytes; name strings immediately follow the structure array. */
    private wsaEnumProtocols(a: number[]): Win32Result {
      const protocolsPtr = a[0] ?? 0;
      const buffer = a[1] ?? 0;
      const lengthPtr = a[2] ?? 0;
      if (!lengthPtr) return this.wsaFail(WSAEFAULT);
      const capacity = this.readU32(lengthPtr);
      // Match real Win9x with IPX/SPX installed by providing UDP/TCP/IPX catalog entries.
      // The game probes [IPPROTO_UDP, NSPROTO_IPX, 0] and enables LAN entry when found.
      const catalog = [
        {
          id: IPPROTO_UDP,
          family: AF_INET,
          socketType: SOCK_DGRAM,
          messageSize: RA2NET_MAX_DATAGRAM_BYTES,
          name: 'UDP',
        },
        { id: IPPROTO_TCP, family: AF_INET, socketType: SOCK_STREAM, messageSize: 0, name: 'TCP' },
        { id: NSPROTO_IPX, family: AF_IPX, socketType: SOCK_DGRAM, messageSize: 576, name: 'IPX' },
      ];
      // lpiProtocols is a zero-terminated protocol-number array; NULL enumerates all protocols.
      let requested: number[] | null = null;
      if (protocolsPtr) {
        requested = [];
        for (let i = 0; i < 64; i++) {
          const id = this.readU32(protocolsPtr + i * 4);
          if (id === 0) break;
          requested.push(id);
        }
      }
      const entries = catalog.filter((entry) => requested === null || requested.includes(entry.id));
      const structBytes = entries.length * 32;
      let total = structBytes;
      for (const entry of entries) total += entry.name.length + 1;
      if (entries.length > 0 && !buffer) return this.wsaFail(WSAEFAULT);
      if (capacity < total) {
        this.writeU32(lengthPtr, total);
        return this.wsaFail(WSAENOBUFS);
      }
      let namePtr = buffer + structBytes;
      entries.forEach((entry, index) => {
        const base = buffer + index * 32;
        this.writeU32(base + 0x00, 0); // dwServiceFlags
        this.writeU32(base + 0x04, entry.family);
        this.writeU32(base + 0x08, SOCKADDR_IN_BYTES); // iMaxSockAddr
        this.writeU32(base + 0x0c, SOCKADDR_IN_BYTES); // iMinSockAddr
        this.writeU32(base + 0x10, entry.socketType);
        this.writeU32(base + 0x14, entry.id);
        this.writeU32(base + 0x18, entry.messageSize); // dwMessageSize
        this.writeU32(base + 0x1c, namePtr); // lpProtocolName
        for (let i = 0; i < entry.name.length; i++) {
          this.memory.write_memory([entry.name.charCodeAt(i)], namePtr + i);
        }
        this.memory.write_memory([0], namePtr + entry.name.length);
        namePtr += entry.name.length + 1;
      });
      this.writeU32(lengthPtr, total);
      return { eax: entries.length };
    }

    private wsaInetNtoa(a: number[]): Win32Result {
      // The guest passes in_addr by value as a little-endian u32; output dotted text starting from the low byte.
      if (!this.ra2InetNtoaBlock) this.ra2InetNtoaBlock = this.alloc(16, true);
      const value = a[0] ?? 0;
      const text = `${value & 0xff}.${(value >>> 8) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 24) & 0xff}`;
      this.zero(this.ra2InetNtoaBlock, 16);
      for (let i = 0; i < text.length; i++) {
        this.memory.write_memory([text.charCodeAt(i)], this.ra2InetNtoaBlock + i);
      }
      return { eax: this.ra2InetNtoaBlock };
    }

    /** WSOCK32.DLL ordinal-import dispatch; all 19 ordinals have implemented semantics. */
    protected dispatchGameWinsock(key: string, a: number[]): Win32Result | null {
      // These Winsock semantics include RA2's protocol catalog, hostname, and virtual LAN address space; never apply them automatically
      // just because an unknown game also imports WSOCK32.
      if (!this.gameProfile.virtualWinsockLan) return null;
      switch (key) {
        case 'WSOCK32.DLL!ord115':
          return this.wsaStartup(a);
        case 'WSOCK32.DLL!ord116':
          return this.wsaCleanup();
        case 'WSOCK32.DLL!ord111':
          return { eax: this.wsaError };
        case 'WSOCK32.DLL!ord8': // htonl
        case 'WSOCK32.DLL!ord14':
          return { eax: bswap32(a[0] ?? 0) }; // ntohl
        case 'WSOCK32.DLL!ord9': // htons
        case 'WSOCK32.DLL!ord15':
          return { eax: bswap16(a[0] ?? 0) }; // ntohs
        case 'WSOCK32.DLL!ord23':
          return this.wsaSocket(a);
        case 'WSOCK32.DLL!ord2':
          return this.wsaBind(a);
        case 'WSOCK32.DLL!ord3':
          return this.wsaCloseSocket(a);
        case 'WSOCK32.DLL!ord20':
          return this.wsaSendTo(a);
        case 'WSOCK32.DLL!ord17':
          return this.wsaRecvFrom(a);
        case 'WSOCK32.DLL!ord21':
          return this.wsaSetSockOpt(a);
        case 'WSOCK32.DLL!ord7':
          return this.wsaGetSockOpt(a);
        case 'WSOCK32.DLL!ord101':
          return this.wsaAsyncSelect(a);
        case 'WSOCK32.DLL!ord57':
          return this.wsaGetHostName(a);
        case 'WSOCK32.DLL!ord52':
          return this.wsaGetHostByName(a);
        case 'WSOCK32.DLL!ord11':
          return this.wsaInetNtoa(a);
        case 'WSOCK32.DLL!ord1111':
          return this.wsaEnumProtocols(a); // EnumProtocolsA
        default:
          return null;
      }
    }
  };
}
