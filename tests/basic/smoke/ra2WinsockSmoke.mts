/**
 * RA2 Winsock 1.1 shim semantics smoke test: drive Win32Shim.dispatch directly without starting a VM.
 * Two shim instances form a virtual LAN through BroadcastChannel. Covers byte order, WSAStartup reference counts and WSADATA, socket/bind validation, gethostname/gethostbyname/inet_ntoa, loopback and cross-instance datagrams, broadcast permission, truncation, MSG_PEEK, WSAAsyncSelect FD_WRITE/FD_READ edge notifications, closesocket/WSACleanup, and ord1111's unimplemented-interface boundary.
 */
import { strict as assert } from 'node:assert';
import type { GuestMemory, Win32Result } from '../../../src/vm86/win32';
import { Win32Shim } from '../../../src/games/win32Shim';
import { createRa2BroadcastChannelTransport } from '../../../src/games/ra2/networkTransport';
import { RA2_SHIM_PROFILE } from '../../../src/games/ra2/profile';

const SOCKET_ERROR = 0xffff_ffff;
const FD_READ = 0x01;
const FD_WRITE = 0x02;
const MSG_PEEK = 0x2;
const PM_REMOVE = 0x1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function makeGuest(): { memory: GuestMemory; bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(16 * 1024 * 1024);
  return {
    bytes,
    view: new DataView(bytes.buffer),
    memory: {
      read_memory(offset, length) {
        return bytes.subarray(offset, offset + length);
      },
      write_memory(data, offset) {
        bytes.set(data, offset);
      },
    },
  };
}

const room = `ra2-winsock-smoke-${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
const exeHash = 'a'.repeat(64);
const guestA = makeGuest();
const guestB = makeGuest();
const shimA = new Win32Shim(guestA.memory, {
  firstDynamicId: 1,
  gameProfile: RA2_SHIM_PROFILE,
  ra2NetworkEnabled: true,
  ra2NetworkTransportFactory: createRa2BroadcastChannelTransport,
  ra2NetworkRoom: room,
  ra2ExeHash: exeHash,
});
const shimB = new Win32Shim(guestB.memory, {
  firstDynamicId: 1,
  gameProfile: RA2_SHIM_PROFILE,
  ra2NetworkEnabled: true,
  ra2NetworkTransportFactory: createRa2BroadcastChannelTransport,
  ra2NetworkRoom: room,
  ra2ExeHash: exeHash,
});

function dispatch(shim: Win32Shim, key: string, args: number[]): Win32Result | null {
  const name = key.split('!')[1]!;
  return shim.dispatch({
    imported: { id: 0, dll: 'WSOCK32.DLL', name, key, slot: 0, stub: 0, argBytes: 0 },
    stack: 0x2000,
    args,
  });
}

/** Numeric convention: address = network-order u32, port = host order. Write a guest sockaddr_in (16 bytes). */
function writeSockaddr(guest: ReturnType<typeof makeGuest>, ptr: number, addr: number, port: number): void {
  guest.view.setUint16(ptr, 2, true);
  guest.view.setUint16(ptr + 2, port, false);
  guest.view.setUint32(ptr + 4, addr, false);
  guest.bytes.fill(0, ptr + 8, ptr + 16);
}

function readCString(guest: ReturnType<typeof makeGuest>, ptr: number): string {
  let end = ptr;
  while (guest.bytes[end] !== 0) end++;
  return Buffer.from(guest.bytes.subarray(ptr, end)).toString('ascii');
}

function lastError(shim: Win32Shim): number {
  return dispatch(shim, 'WSOCK32.DLL!ord111', [])!.eax >>> 0;
}

/** PeekMessageA(PM_REMOVE) retrieves one message filtered by message ID; return null if none matches. */
function peekMessage(
  shim: Win32Shim,
  guest: ReturnType<typeof makeGuest>,
  msgPtr: number,
  filter = 0,
): { hwnd: number; message: number; wParam: number; lParam: number } | null {
  const result = shim.dispatch({
    imported: {
      id: 0,
      dll: 'USER32.DLL',
      name: 'PeekMessageA',
      key: 'USER32.DLL!PeekMessageA',
      slot: 0,
      stub: 0,
      argBytes: 20,
    },
    stack: 0x2000,
    args: [msgPtr, 0, filter, filter, PM_REMOVE],
  });
  if (!result || result.eax === 0) return null;
  return {
    hwnd: guest.view.getUint32(msgPtr, true),
    message: guest.view.getUint32(msgPtr + 4, true),
    wParam: guest.view.getUint32(msgPtr + 8, true),
    lParam: guest.view.getUint32(msgPtr + 12, true),
  };
}

async function main(): Promise<void> {
  // ---- Byte order (no WSAStartup required) ----
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord8', [0x0102_0304])!.eax, 0x0403_0201, 'htonl');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord14', [0x0403_0201])!.eax, 0x0102_0304, 'ntohl');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord9', [0x0102])!.eax, 0x0201, 'htons');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord15', [0x0201])!.eax, 0x0102, 'ntohs');

  // ---- WSAStartup discipline ----
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax, SOCKET_ERROR, 'startup 前 socket 必须失败');
  assert.equal(lastError(shimA), 10093, 'WSANOTINITIALISED');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord115', [0, 0x4000])!.eax, SOCKET_ERROR, '主版本 0 不支持');
  assert.equal(lastError(shimA), 10092, 'WSAVERNOTSUPPORTED');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord115', [0x0101, 0x4000])!.eax, 0, 'WSAStartup 1.1');
  assert.equal(guestA.view.getUint16(0x4000, true), 0x0101, 'WSADATA wVersion = 1.1');
  assert.equal(guestA.view.getUint16(0x4002, true), 0x0101, 'WSADATA wHighVersion = 1.1');
  assert.ok(readCString(guestA, 0x4004).length > 0, 'WSADATA 描述串');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord115', [0x0101, 0])!.eax, 0, 'WSAStartup 引用计数 2');

  // ---- Socket validation ----
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord23', [99, 2, 0])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10047, 'WSAEAFNOSUPPORT');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 99, 0])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10044, 'WSAESOCKTNOSUPPORT');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 6])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10043, 'WSAEPROTONOSUPPORT');
  const tcpSock = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 1, 0])!.eax >>> 0;
  assert.ok(tcpSock >= 0xa000, 'TCP socket 句柄');
  const sockA = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  assert.ok(sockA >= 0xa000 && sockA !== tcpSock, 'UDP socket 句柄');

  // ---- Hostname and name resolution ----
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord57', [0x5000, 256])!.eax, 0, 'gethostname');
  const hostname = readCString(guestA, 0x5000);
  assert.ok(hostname.startsWith('RA2VM-'), `虚拟主机名 ${hostname}`);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord57', [0x5000, 4])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10014, 'WSAEFAULT');

  guestA.bytes.set(Buffer.from('localhost\0', 'ascii'), 0x5100);
  const localhostEnt = dispatch(shimA, 'WSOCK32.DLL!ord52', [0x5100])!.eax >>> 0;
  assert.ok(localhostEnt !== 0, 'gethostbyname(localhost)');
  {
    const addrList = guestA.view.getUint32(localhostEnt + 12, true);
    const addrPtr = guestA.view.getUint32(addrList, true);
    assert.equal(guestA.view.getUint32(addrList + 4, true), 0, 'h_addr_list 以 NULL 结尾');
    assert.deepEqual([...guestA.bytes.subarray(addrPtr, addrPtr + 4)], [0x7f, 0, 0, 1], 'localhost → 127.0.0.1');
    assert.equal(guestA.view.getUint16(localhostEnt + 8, true), 2, 'h_addrtype = AF_INET');
    assert.equal(guestA.view.getUint16(localhostEnt + 10, true), 4, 'h_length = 4');
  }
  // Wait for BroadcastChannel onReady/peer-join convergence before querying the local hostname.
  await sleep(30);
  guestA.bytes.set(Buffer.from(`${hostname}\0`, 'ascii'), 0x5100);
  const selfEnt = dispatch(shimA, 'WSOCK32.DLL!ord52', [0x5100])!.eax >>> 0;
  assert.ok(selfEnt !== 0, 'gethostbyname(本机名)');
  {
    const addrPtr = guestA.view.getUint32(guestA.view.getUint32(selfEnt + 12, true), true);
    const addr = guestA.view.getUint32(addrPtr, false); // Network-order value
    assert.equal(addr >>> 16, 0x0af7, '本机名解析到虚拟 LAN 网段');
  }
  guestA.bytes.set(Buffer.from('no.such.host\0', 'ascii'), 0x5100);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord52', [0x5100])!.eax, 0, '未知主机返回 NULL');
  assert.equal(lastError(shimA), 11001, 'WSAHOST_NOT_FOUND');

  assert.ok(dispatch(shimA, 'WSOCK32.DLL!ord11', [0x0100_007f])!.eax !== 0, 'inet_ntoa 返回静态串');
  const dotted = readCString(guestA, dispatch(shimA, 'WSOCK32.DLL!ord11', [0x0100_007f])!.eax >>> 0);
  assert.equal(dotted, '127.0.0.1', 'inet_ntoa 点分十进制');

  // ---- bind ------------------------------------------------------------------
  writeSockaddr(guestA, 0x5200, 0, 5000);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [sockA, 0x5200, 16])!.eax, 0, 'bind ANY:5000');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [sockA, 0x5200, 16])!.eax, SOCKET_ERROR, '重复 bind');
  assert.equal(lastError(shimA), 10022, 'WSAEINVAL');
  const sockA2 = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [sockA2, 0x5200, 16])!.eax, SOCKET_ERROR, '端口冲突');
  assert.equal(lastError(shimA), 10048, 'WSAEADDRINUSE');
  // Allow the same port when both sockets use SO_REUSEADDR (common for RA2 discovery sockets).
  guestA.view.setUint32(0x5300, 1, true);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord21', [sockA, 0xffff, 0x0004, 0x5300, 4])!.eax, 0, 'SO_REUSEADDR sockA');
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord21', [sockA2, 0xffff, 0x0004, 0x5300, 4])!.eax,
    0,
    'SO_REUSEADDR sockA2',
  );
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [sockA2, 0x5200, 16])!.eax, 0, 'REUSEADDR 双绑定');
  writeSockaddr(guestA, 0x5200, 0x0808_0808, 5000);
  const sockA3 = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [sockA3, 0x5200, 16])!.eax, SOCKET_ERROR, '绑定外网地址');
  assert.equal(lastError(shimA), 10049, 'WSAEADDRNOTAVAIL');
  // Read back with getsockopt
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord7', [sockA, 0xffff, 0x0004, 0x5400, 0x5404])!.eax, 0, 'getsockopt');
  assert.equal(guestA.view.getUint32(0x5400, true), 1, 'SO_REUSEADDR 回读');
  assert.equal(guestA.view.getUint32(0x5404, true), 4, 'getsockopt optlen');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord7', [sockA, 0xffff, 0x1008, 0x5400, 0x5404])!.eax, 0);
  assert.equal(guestA.view.getUint32(0x5400, true), 2, 'SO_TYPE = SOCK_DGRAM');

  // ---- Loopback send/receive ----
  const rxSock = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  writeSockaddr(guestA, 0x5200, 0, 6000);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord2', [rxSock, 0x5200, 16])!.eax, 0, 'bind ANY:6000');
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6000, 512, 0, 0, 0])!.eax,
    SOCKET_ERROR,
    '空队列 recvfrom',
  );
  assert.equal(lastError(shimA), 10035, 'WSAEWOULDBLOCK');

  const txSock = dispatch(shimA, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  guestA.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0x6100);
  writeSockaddr(guestA, 0x5200, 0x7f00_0001, 6000);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 8, 0, 0x5200, 16])!.eax, 8, '环回 sendto');
  assert.ok(
    shimA.inspectRa2Network().sockets.some((s) => s.handle === txSock && s.port >= 49152),
    'sendto 隐式临时端口',
  );
  // MSG_PEEK does not consume
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6200, 512, MSG_PEEK, 0, 0])!.eax, 8, 'MSG_PEEK');
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6200, 4, 0, 0x6300, 0x6310])!.eax,
    SOCKET_ERROR,
    '截断报错',
  );
  assert.equal(lastError(shimA), 10040, 'WSAEMSGSIZE');
  assert.deepEqual([...guestA.bytes.subarray(0x6200, 0x6204)], [1, 2, 3, 4], '截断仍拷贝前 4 字节');
  assert.equal(guestA.view.getUint16(0x6300, true), 2, 'from family');
  assert.ok(guestA.view.getUint16(0x6302, false) >= 49152, 'from 端口=发送方临时端口');
  assert.equal(guestA.view.getUint32(0x6310, true), 16, 'fromlen');
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6200, 512, 0, 0, 0])!.eax,
    SOCKET_ERROR,
    '截断的包已被消费',
  );

  // ---- Broadcast permission ----
  writeSockaddr(guestA, 0x5200, 0xffff_ffff, 6000);
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 8, 0, 0x5200, 16])!.eax,
    SOCKET_ERROR,
    '未授权广播',
  );
  assert.equal(lastError(shimA), 10013, 'WSAEACCES');
  guestA.view.setUint32(0x5300, 1, true);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord21', [txSock, 0xffff, 0x0020, 0x5300, 4])!.eax, 0, 'SO_BROADCAST');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 8, 0, 0x5200, 16])!.eax, 8, '授权广播');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6200, 512, 0, 0, 0])!.eax, 8, '广播回本机');

  // ---- Reject sendto on TCP sockets ----
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [tcpSock, 0x6100, 8, 0, 0x5200, 16])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10057, 'WSAENOTCONN');

  // ---- Cross-instance datagrams (A -> B, BroadcastChannel virtual LAN) ----
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord115', [0x0101, 0])!.eax, 0, 'shimB WSAStartup');
  const sockB = dispatch(shimB, 'WSOCK32.DLL!ord23', [2, 2, 0])!.eax >>> 0;
  assert.ok(sockB >= 0xa000, 'B UDP socket 句柄');
  writeSockaddr(guestB, 0x5200, 0, 7000);
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord2', [sockB, 0x5200, 16])!.eax, 0, 'B bind ANY:7000');
  await sleep(30); // Wait for both transports to become ready and exchange peer-join
  const addrB = shimB.inspectRa2Network().selfAddr;
  const addrA = shimA.inspectRa2Network().selfAddr;
  assert.ok(addrB.startsWith('10.247.'), `B 虚拟地址 ${addrB}`);
  assert.ok(addrA.startsWith('10.247.') && addrA !== addrB, `A 虚拟地址 ${addrA}`);
  const addrBNum = addrB.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
  guestA.bytes.set([0xde, 0xad, 0xbe, 0xef], 0x6100);
  writeSockaddr(guestA, 0x5200, addrBNum, 7000);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 4, 0, 0x5200, 16])!.eax, 4, 'A→B sendto');
  await sleep(30);
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord17', [sockB, 0x6000, 512, 0, 0x6300, 0])!.eax, 4, 'B recvfrom');
  assert.deepEqual([...guestB.bytes.subarray(0x6000, 0x6004)], [0xde, 0xad, 0xbe, 0xef], 'payload 原样透传');
  const fromAddr = guestB.view.getUint32(0x6304, false);
  assert.equal(fromAddr >>> 16, 0x0af7, 'from 是虚拟 LAN 地址');
  assert.equal(
    fromAddr,
    addrA.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0),
    'from = A 地址',
  );

  // ---- WSAAsyncSelect: immediate FD_WRITE and edge-triggered FD_READ ----
  const MSG_SOCK = 0x500;
  const HWND_B = 0x1234;
  assert.equal(
    dispatch(shimB, 'WSOCK32.DLL!ord101', [sockB, HWND_B, MSG_SOCK, FD_READ | FD_WRITE])!.eax,
    0,
    'WSAAsyncSelect',
  );
  const writable = peekMessage(shimB, guestB, 0x7000, MSG_SOCK);
  assert.ok(writable && writable.hwnd === HWND_B && writable.message === MSG_SOCK, 'FD_WRITE 消息');
  assert.equal(writable!.wParam, sockB, 'wParam = socket');
  assert.equal(writable!.lParam, FD_WRITE, 'lParam = FD_WRITE');
  assert.equal(peekMessage(shimB, guestB, 0x7000, MSG_SOCK), null, 'FD_WRITE 只投一次');

  guestA.bytes.set([0x11], 0x6100);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 1, 0, 0x5200, 16])!.eax, 1, 'A→B 第 1 包');
  await sleep(30);
  guestA.bytes.set([0x22], 0x6100);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 1, 0, 0x5200, 16])!.eax, 1, 'A→B 第 2 包');
  await sleep(30);
  const readable = peekMessage(shimB, guestB, 0x7000, MSG_SOCK);
  assert.ok(readable && readable.message === MSG_SOCK && readable.lParam === FD_READ, 'FD_READ 消息');
  assert.equal(readable!.wParam, sockB);
  assert.equal(peekMessage(shimB, guestB, 0x7000, MSG_SOCK), null, 'FD_READ 边沿触发不重复投递');
  // Read one packet before draining: the queue remains nonempty, so post another FD_READ per Winsock semantics.
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord17', [sockB, 0x6000, 512, 0, 0, 0])!.eax, 1, '读第 1 包');
  const rearm = peekMessage(shimB, guestB, 0x7000, MSG_SOCK);
  assert.ok(rearm && rearm.lParam === FD_READ, '未排空重投 FD_READ');
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord17', [sockB, 0x6000, 512, 0, 0, 0])!.eax, 1, '读第 2 包');
  assert.equal(peekMessage(shimB, guestB, 0x7000, MSG_SOCK), null, '排空后不再投递');
  // Packets arriving after deregistration no longer generate messages.
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord101', [sockB, 0, 0, 0])!.eax, 0, '取消 WSAAsyncSelect');
  guestA.bytes.set([0x33], 0x6100);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord20', [txSock, 0x6100, 1, 0, 0x5200, 16])!.eax, 1);
  await sleep(30);
  assert.equal(peekMessage(shimB, guestB, 0x7000, MSG_SOCK), null, '取消后无 FD_READ');
  assert.equal(dispatch(shimB, 'WSOCK32.DLL!ord17', [sockB, 0x6000, 512, 0, 0, 0])!.eax, 1, '包仍在队列');

  // ---- closesocket / WSACleanup ------------------------------------------------------
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord3', [tcpSock])!.eax, 0, 'closesocket');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord3', [tcpSock])!.eax, SOCKET_ERROR, '重复 close');
  assert.equal(lastError(shimA), 10038, 'WSAENOTSOCK');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord116', [])!.eax, 0, 'WSACleanup 1');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord116', [])!.eax, 0, 'WSACleanup 2（引用计数归零）');
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord116', [])!.eax, SOCKET_ERROR, '超额 cleanup');
  assert.equal(lastError(shimA), 10093, 'WSANOTINITIALISED');
  assert.equal(
    dispatch(shimA, 'WSOCK32.DLL!ord17', [rxSock, 0x6000, 512, 0, 0, 0])!.eax,
    SOCKET_ERROR,
    'cleanup 后句柄失效',
  );

  // ---- ord1111 = EnumProtocolsA (RA2 startup diagnostic call, confirmed by traces) ----
  // RA2's actual call shape: lpiProtocols=[IPPROTO_UDP,1000,0], with a 4 KB buffer.
  guestA.view.setUint32(0x5500, 17, true);
  guestA.view.setUint32(0x5504, 1000, true);
  guestA.view.setUint32(0x5508, 0, true);
  guestA.view.setUint32(0x5510, 4096, true);
  const enumCount = dispatch(shimA, 'WSOCK32.DLL!ord1111', [0x5500, 0x5600, 0x5510])!.eax;
  assert.equal(enumCount, 1, '只枚举到 UDP（1000 无提供者）');
  assert.equal(guestA.view.getUint32(0x5604, true), 2, 'iAddressFamily = AF_INET');
  assert.equal(guestA.view.getUint32(0x5610, true), 2, 'iSocketType = SOCK_DGRAM');
  assert.equal(guestA.view.getUint32(0x5614, true), 17, 'iProtocol = UDP');
  assert.equal(guestA.view.getUint32(0x5618, true), 65507, 'dwMessageSize');
  const protoName = guestA.view.getUint32(0x561c, true);
  assert.equal(readCString(guestA, protoName), 'UDP', 'lpProtocolName 指向缓冲内名字串');
  assert.equal(guestA.view.getUint32(0x5510, true), 32 + 4, '实际用量 = 结构 32B + 名字 4B');
  // Insufficient buffer -> WSAENOBUFS with the required size.
  guestA.view.setUint32(0x5510, 8, true);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord1111', [0x5500, 0x5600, 0x5510])!.eax, SOCKET_ERROR);
  assert.equal(lastError(shimA), 10055, 'WSAENOBUFS');
  assert.equal(guestA.view.getUint32(0x5510, true), 36, '回报所需字节数');
  // lpiProtocols = NULL -> enumerate all (UDP + TCP).
  guestA.view.setUint32(0x5510, 4096, true);
  assert.equal(dispatch(shimA, 'WSOCK32.DLL!ord1111', [0, 0x5600, 0x5510])!.eax, 2, 'NULL 枚举 UDP+TCP');

  console.log('RA2 Winsock shim smoke passed: 19 序数全语义，环回/广播/跨实例/FD_READ/EnumProtocols 符合预期');
}

try {
  await main();
} finally {
  shimA.dispose();
  shimB.dispose();
}
