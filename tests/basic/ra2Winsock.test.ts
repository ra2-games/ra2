import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStackArgs } from '../../src/vm86/win32';
import type { Ra2NetworkTransport, Ra2NetworkTransportFactory } from '../../src/games/ra2/networkTransport';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  type FakeGuestMemory,
  writeAsciiZ,
  writeU32,
} from '../helpers/guestMemory';

const SOCKET_ERROR = 0xffff_ffff;
const AF_INET = 2;
const SOCK_DGRAM = 2;
const FD_READ = 0x01;
const FD_WRITE = 0x02;
const MSG_PEEK = 0x02;
const SOL_SOCKET = 0xffff;
const SO_BROADCAST = 0x0020;
const WSAEWOULDBLOCK = 10035;
const WSAEMSGSIZE = 10040;
const WSAENOBUFS = 10055;
const WSAEFAULT = 10014;
const WSAHOST_NOT_FOUND = 11001;
const WSANOTINITIALISED = 10093;
const TEST_EXE_HASH = 'a'.repeat(64);

function readU16(memory: FakeGuestMemory, address: number): number {
  const bytes = memory.read_memory(address, 2);
  return (bytes[0]! | (bytes[1]! << 8)) >>> 0;
}

function readAsciiZ(memory: FakeGuestMemory, address: number, max = 256): string {
  const bytes = memory.read_memory(address, max);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end >= 0 ? end : bytes.length));
}

function writeSockaddr(memory: FakeGuestMemory, ptr: number, addr: number, port: number): void {
  memory.write_memory([AF_INET, 0, (port >>> 8) & 0xff, port & 0xff], ptr);
  memory.write_memory([(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff], ptr + 4);
  memory.write_memory(new Uint8Array(8), ptr + 8);
}

function createTransportFixture() {
  const selfAddr = 0x0af7_0101;
  const sent: Array<{ destAddr: number; destPort: number; srcPort: number; payload: Uint8Array }> = [];
  let handlers: Parameters<Ra2NetworkTransportFactory>[0] | null = null;
  const transport: Ra2NetworkTransport = {
    clientId: 'test-client',
    ready: true,
    selfAddr,
    sendDatagram(destAddr, destPort, srcPort, payload) {
      sent.push({ destAddr, destPort, srcPort, payload: payload.slice() });
      return true;
    },
    close: vi.fn(),
  };
  const factory: Ra2NetworkTransportFactory = (nextHandlers) => {
    handlers = nextHandlers;
    nextHandlers.onReady({ id: 'self', addr: selfAddr, name: new Uint8Array() }, []);
    return transport;
  };
  return { factory, sent, transport, getHandlers: () => handlers };
}

function startupShim(memory: FakeGuestMemory, factory: Ra2NetworkTransportFactory) {
  const shim = createTestShim(memory, {
    gameId: 'ra2',
    ra2NetworkEnabled: true,
    ra2NetworkRoom: 'winsock-test',
    ra2ExeHash: TEST_EXE_HASH,
    ra2NetworkTransportFactory: factory,
  });
  const wsaData = 0x1000;
  expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x101, wsaData]).eax).toBe(0);
  return shim;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RA2 Winsock dispatch', () => {
  it('YR profile 也能以独立房间建立 IPX 传输', () => {
    const memory = createGuestMemory(),
      fixture = createTransportFixture();
    const factory = vi.fn(fixture.factory);
    const shim = createTestShim(memory, {
      gameId: 'yr',
      ra2NetworkEnabled: true,
      ra2NetworkRoom: 'public-yr',
      ra2ExeHash: TEST_EXE_HASH,
      ra2NetworkTransportFactory: factory,
    });
    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x101, 0x1000]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord23', [6, SOCK_DGRAM, 1000]).eax).not.toBe(SOCKET_ERROR);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![1]).toMatchObject({ room: 'public-yr', exeHash: TEST_EXE_HASH });
  });
  it('does not create a network transport without explicit room configuration', () => {
    const memory = createGuestMemory();
    const factory = vi.fn<Ra2NetworkTransportFactory>();
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      ra2NetworkTransportFactory: factory,
    });
    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x101, 0x1000]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord23', [AF_INET, SOCK_DGRAM, 17]).eax).not.toBe(SOCKET_ERROR);
    expect(factory).not.toHaveBeenCalled();
  });

  it('covers startup errors, byte-order/address helpers, host lookup and EnumProtocolsA', () => {
    const memory = createGuestMemory();
    const fixture = createTransportFixture();
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      ra2NetworkEnabled: true,
      ra2NetworkRoom: 'winsock-test',
      ra2ExeHash: TEST_EXE_HASH,
      ra2NetworkTransportFactory: fixture.factory,
    });

    expect(callShim(shim, 'WSOCK32.DLL!ord23', [AF_INET, SOCK_DGRAM, 0]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSANOTINITIALISED);
    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0, 0]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10092);

    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x101, 0x1000]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord8', [0x0102_0304]).eax >>> 0).toBe(0x0403_0201);
    expect(callShim(shim, 'WSOCK32.DLL!ord14', [0x0102_0304]).eax >>> 0).toBe(0x0403_0201);
    expect(callShim(shim, 'WSOCK32.DLL!ord9', [0x1234]).eax >>> 0).toBe(0x3412);
    expect(callShim(shim, 'WSOCK32.DLL!ord15', [0x1234]).eax >>> 0).toBe(0x3412);

    const hostname = 0x2000;
    expect(callShim(shim, 'WSOCK32.DLL!ord57', [hostname, 64]).eax).toBe(0);
    const host = readAsciiZ(memory, hostname);
    expect(host).toMatch(/^RA2VM-/);
    writeAsciiZ(memory, 0x2100, host);
    const hostent = callShim(shim, 'WSOCK32.DLL!ord52', [0x2100]).eax;
    expect(hostent).not.toBe(0);
    expect(readU32(memory, hostent + 8) & 0xffff).toBe(AF_INET);
    expect(readU32(memory, hostent + 12)).not.toBe(0);
    const inetText = callShim(shim, 'WSOCK32.DLL!ord11', [0x0100_007f]).eax;
    expect(readAsciiZ(memory, inetText)).toBe('127.0.0.1');

    const lengthPtr = 0x2200;
    const protocolBuffer = 0x2300;
    writeU32(memory, lengthPtr, 0);
    expect(callShim(shim, 'WSOCK32.DLL!ord1111', [0, protocolBuffer, lengthPtr]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSAENOBUFS);
    const required = readU32(memory, lengthPtr);
    expect(required).toBeGreaterThan(64);

    writeU32(memory, lengthPtr, required);
    expect(callShim(shim, 'WSOCK32.DLL!ord1111', [0, protocolBuffer, lengthPtr]).eax).toBe(3);
    expect(readU32(memory, protocolBuffer + 0x14)).toBe(17);
    expect(readU32(memory, protocolBuffer + 0x10)).toBe(2);
    expect(readAsciiZ(memory, readU32(memory, protocolBuffer + 0x1c))).toBe('UDP');
    expect(readU32(memory, protocolBuffer + 32 + 0x14)).toBe(6);
    // The third entry is IPX (protocol 1000, AF_IPX, datagram), the actual LAN wire protocol.
    expect(readU32(memory, protocolBuffer + 64 + 0x14)).toBe(1000);
    expect(readU32(memory, protocolBuffer + 64 + 0x04)).toBe(6);
    expect(readU32(memory, protocolBuffer + 64 + 0x10)).toBe(2);
    expect(readAsciiZ(memory, readU32(memory, protocolBuffer + 64 + 0x1c))).toBe('IPX');

    const filter = 0x2500;
    writeU32(memory, filter, 17);
    writeU32(memory, filter + 4, 0);
    writeU32(memory, lengthPtr, 36);
    expect(callShim(shim, 'WSOCK32.DLL!ord1111', [filter, protocolBuffer, lengthPtr]).eax).toBe(1);
    expect(readAsciiZ(memory, readU32(memory, protocolBuffer + 0x1c))).toBe('UDP');
    expect(callShim(shim, 'WSOCK32.DLL!ord1111', [0, 0, lengthPtr]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSAEFAULT);

    writeAsciiZ(memory, 0x2100, 'missing-host');
    expect(callShim(shim, 'WSOCK32.DLL!ord52', [0x2100]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSAHOST_NOT_FOUND);
  });

  it('implements UDP bind/send/receive, broadcast permission and async select edge notifications', () => {
    const memory = createGuestMemory();
    const fixture = createTransportFixture();
    const shim = startupShim(memory, fixture.factory);
    const socket = callShim(shim, 'WSOCK32.DLL!ord23', [AF_INET, SOCK_DGRAM, 17]).eax >>> 0;
    const address = 0x3000;
    const payload = 0x3100;
    const receive = 0x3200;
    const from = 0x3300;
    const fromLength = 0x3400;
    const message = 0x3500;
    writeSockaddr(memory, address, 0, 4000);
    memory.write_memory([0xab, 0xcd, 0xef], payload);
    expect(callShim(shim, 'WSOCK32.DLL!ord2', [socket, address, 16]).eax).toBe(0);

    const option = 0x3600;
    writeU32(memory, option, 0);
    writeU32(memory, fromLength, 4);
    expect(callShim(shim, 'WSOCK32.DLL!ord7', [socket, SOL_SOCKET, SO_BROADCAST, option, fromLength]).eax).toBe(0);
    expect(readU32(memory, option)).toBe(0);
    writeU32(memory, option, 1);
    expect(callShim(shim, 'WSOCK32.DLL!ord21', [socket, SOL_SOCKET, SO_BROADCAST, option, 4]).eax).toBe(0);

    const asyncMessage = 0x9000;
    expect(callShim(shim, 'WSOCK32.DLL!ord101', [socket, 0x2222, asyncMessage, FD_READ | FD_WRITE]).eax).toBe(0);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [message, 0, asyncMessage, asyncMessage, 1]).eax).toBe(1);
    expect(readU32(memory, message + 4)).toBe(asyncMessage);
    expect(readU32(memory, message + 8)).toBe(socket);
    expect(readU32(memory, message + 12)).toBe(FD_WRITE);

    writeSockaddr(memory, address, fixture.transport.selfAddr, 4000);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 3, 0, address, 16]).eax).toBe(3);
    expect(fixture.sent).toHaveLength(0);
    expect(callShim(shim, 'USER32.DLL!PeekMessageA', [message, 0, asyncMessage, asyncMessage, 1]).eax).toBe(1);
    expect(readU32(memory, message + 12)).toBe(FD_READ);

    expect(callShim(shim, 'WSOCK32.DLL!ord17', [socket, receive, 3, 0, from, fromLength]).eax).toBe(3);
    expect([...memory.read_memory(receive, 3)]).toEqual([0xab, 0xcd, 0xef]);
    const encodedPort = readU16(memory, from + 2);
    expect(((encodedPort & 0xff) << 8) | (encodedPort >>> 8)).toBe(4000);
    expect(readU32(memory, fromLength)).toBe(16);
    expect(callShim(shim, 'WSOCK32.DLL!ord17', [socket, receive, 3, 0, from, fromLength]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSAEWOULDBLOCK);

    writeSockaddr(memory, address, fixture.transport.selfAddr, 4000);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 3, 0, address, 16]).eax).toBe(3);
    expect(callShim(shim, 'WSOCK32.DLL!ord17', [socket, receive, 1, MSG_PEEK, from, fromLength]).eax).toBe(
      SOCKET_ERROR,
    );
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(WSAEMSGSIZE);
    expect(callShim(shim, 'WSOCK32.DLL!ord17', [socket, receive, 3, 0, from, fromLength]).eax).toBe(3);

    writeSockaddr(memory, address, 0xffff_ffff, 4000);
    writeU32(memory, option, 0);
    expect(callShim(shim, 'WSOCK32.DLL!ord21', [socket, SOL_SOCKET, SO_BROADCAST, option, 4]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 3, 0, address, 16]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10013);
    writeU32(memory, option, 1);
    expect(callShim(shim, 'WSOCK32.DLL!ord21', [socket, SOL_SOCKET, SO_BROADCAST, option, 4]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 3, 0, address, 16]).eax).toBe(3);
    expect(fixture.sent.at(-1)).toMatchObject({ destAddr: 0xffff_ffff, destPort: 4000, srcPort: 4000 });

    expect(callShim(shim, 'WSOCK32.DLL!ord101', [socket, 0x2222, asyncMessage, 0]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord3', [socket]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord3', [socket]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10038);
  });

  it('implements IPX sockets over the virtual LAN (RA2 LAN wire protocol)', () => {
    const memory = createGuestMemory();
    const fixture = createTransportFixture();
    const shim = startupShim(memory, fixture.factory);
    const AF_IPX = 6;
    const NSPROTO_IPX = 1000;
    const selfNode = [0x0a, 0xf7, 0x01, 0x01, 0x0a, 0xf7]; // Repeated-prefix layout for 10.247.1.1
    const writeSockaddrIpx = (ptr: number, node: number[], socketNum: number) => {
      memory.write_memory([AF_IPX, 0], ptr);
      memory.write_memory(new Uint8Array(4), ptr + 2); // netnum = 0
      memory.write_memory(new Uint8Array(node), ptr + 6);
      memory.write_memory([(socketNum >>> 8) & 0xff, socketNum & 0xff], ptr + 12);
    };

    // Protocol/type validation: IPX accepts only datagrams with NSPROTO_IPX.
    expect(callShim(shim, 'WSOCK32.DLL!ord23', [AF_IPX, 1, NSPROTO_IPX]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10044);
    expect(callShim(shim, 'WSOCK32.DLL!ord23', [AF_IPX, SOCK_DGRAM, 999]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10043);
    const socket = callShim(shim, 'WSOCK32.DLL!ord23', [AF_IPX, SOCK_DGRAM, NSPROTO_IPX]).eax >>> 0;
    expect(socket).not.toBe(SOCKET_ERROR);

    // Bind sockaddr_ipx (socket 5000); binding the same socket number again conflicts.
    const address = 0x3000;
    writeSockaddrIpx(address, selfNode, 5000);
    expect(callShim(shim, 'WSOCK32.DLL!ord2', [socket, address, 14]).eax).toBe(0);
    const other = callShim(shim, 'WSOCK32.DLL!ord23', [AF_IPX, SOCK_DGRAM, NSPROTO_IPX]).eax >>> 0;
    writeSockaddrIpx(address, selfNode, 5000);
    expect(callShim(shim, 'WSOCK32.DLL!ord2', [other, address, 14]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10048);
    expect(callShim(shim, 'WSOCK32.DLL!ord3', [other]).eax).toBe(0);

    // getsockopt: IPX_MAX_ADAPTER_NUM and IPX_ADDRESS (netnum@0, nodenum@8, socket@14).
    const option = 0x3600;
    const optionLength = 0x3400;
    writeU32(memory, optionLength, 4);
    expect(callShim(shim, 'WSOCK32.DLL!ord7', [socket, NSPROTO_IPX, 0x400d, option, optionLength]).eax).toBe(0);
    expect(readU32(memory, option)).toBe(1);
    writeU32(memory, optionLength, 24);
    expect(callShim(shim, 'WSOCK32.DLL!ord7', [socket, NSPROTO_IPX, 0x4007, option, optionLength]).eax).toBe(0);
    expect(readU32(memory, option)).toBe(0); // netnum = local network segment
    expect([...memory.read_memory(option + 8, 6)]).toEqual(selfNode);
    expect(readU16(memory, option + 14)).toBe(0x8813); // Network-order bytes for 5000
    expect(readU32(memory, optionLength)).toBe(16);
    // Registering IPX header options (IPX_PTYPE, etc.) succeeds.
    writeU32(memory, option, 4);
    expect(callShim(shim, 'WSOCK32.DLL!ord21', [socket, NSPROTO_IPX, 0x4000, option, 4]).eax).toBe(0);

    // Broadcast requires SO_BROADCAST; once enabled, fan out to the subnet-directed broadcast and loop back locally.
    const payload = 0x3100;
    memory.write_memory([0xde, 0xad, 0xbe, 0xef], payload);
    writeSockaddrIpx(address, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 5000);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 4, 0, address, 14]).eax).toBe(SOCKET_ERROR);
    expect(callShim(shim, 'WSOCK32.DLL!ord111').eax).toBe(10013);
    writeU32(memory, option, 1);
    expect(callShim(shim, 'WSOCK32.DLL!ord21', [socket, SOL_SOCKET, SO_BROADCAST, option, 4]).eax).toBe(0);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 4, 0, address, 14]).eax).toBe(4);
    expect(fixture.sent.at(-1)).toMatchObject({ destAddr: 0x0af7_ffff, destPort: 5000, srcPort: 5000 });

    // Looped-back broadcasts can be read directly with recvfrom; the source uses sockaddr_ipx layout.
    const receive = 0x3200;
    const from = 0x3300;
    expect(callShim(shim, 'WSOCK32.DLL!ord17', [socket, receive, 4, 0, from, optionLength]).eax).toBe(4);
    expect([...memory.read_memory(receive, 4)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(readU16(memory, from)).toBe(AF_IPX);
    expect([...memory.read_memory(from + 6, 6)]).toEqual(selfNode);
    expect(readU16(memory, from + 12)).toBe(0x8813);
    expect(readU32(memory, optionLength)).toBe(14);

    // Unicast decodes the virtual address from nodenum's first four bytes and bypasses local loopback.
    const peerNode = [0x0a, 0xf7, 0x02, 0x02, 0x0a, 0xf7];
    writeSockaddrIpx(address, peerNode, 5000);
    expect(callShim(shim, 'WSOCK32.DLL!ord20', [socket, payload, 4, 0, address, 14]).eax).toBe(4);
    expect(fixture.sent.at(-1)).toMatchObject({ destAddr: 0x0af7_0202, destPort: 5000, srcPort: 5000 });

    expect(callShim(shim, 'WSOCK32.DLL!ord3', [socket]).eax).toBe(0);
  });

  it('decodes the guest stack through the shared ABI boundary', () => {
    const memory = createGuestMemory(0x1000);
    writeU32(memory, 0x200, 0xdead_beef);
    writeU32(memory, 0x204, 0x1111_2222);
    writeU32(memory, 0x208, 0x3333_4444);
    writeU32(memory, 0x20c, 0xffff_ffff);
    expect(readStackArgs(memory, 0x200, 12)).toEqual([0x1111_2222, 0x3333_4444, 0xffff_ffff]);
    expect(readStackArgs(memory, 0x200, 0)).toEqual([]);
  });
});
