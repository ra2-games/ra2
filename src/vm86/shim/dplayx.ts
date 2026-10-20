import type { Win32Call, Win32Result } from '../win32';
import { HYPERCALL_CALLBACK_RESULT } from '../pe';
import type { Constructor, GuestCallbackFrame } from './state';
import type { withDirectx } from './directx';
import { createDefaultDplayTransport } from './dplayTransport';
import type { DplayTransport } from './dplayTransport';
import type { DplayWire } from './dplayWire';

type DirectxChain = InstanceType<ReturnType<typeof withDirectx>>;

/**
 * Format guest-memory GUIDs as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.
 * Data1/Data2/Data3 are little-endian u32/u16/u16; emit Data4 in original byte order.
 */
export function formatGuid(bytes: Uint8Array): string {
  const hex = (start: number, end: number) =>
    [...bytes.subarray(start, end)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const d1 = ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0)
    .toString(16)
    .padStart(8, '0');
  const d2 = (bytes[4]! | (bytes[5]! << 8)).toString(16).padStart(4, '0');
  const d3 = (bytes[6]! | (bytes[7]! << 8)).toString(16).padStart(4, '0');
  return `{${d1}-${d2}-${d3}-${hex(8, 10)}-${hex(10, 16)}}`;
}

/** CLSID_DirectPlay from Wine dplay.h line 38, matching the game's probe. */
export const CLSID_DIRECTPLAY = '{d1eb6d20-8923-11d0-9d97-00a0c90a43cb}';

/** DPSPGUID_TCPIP from Wine dplay.h line 71. */
const DPSPGUID_TCPIP = '{36e95ee0-8577-11cf-960c-0080c7534e82}';

/** DPSPGUID_TCPIP in guest-memory byte order; Data1/2/3 are little-endian. */
const DPSPGUID_TCPIP_BYTES = new Uint8Array([
  0xe0, 0x5e, 0xe9, 0x36, 0x77, 0x85, 0xcf, 0x11, 0x96, 0x0c, 0x00, 0x80, 0xc7, 0x53, 0x4e, 0x82,
]);

/** Common SP GUIDs to debug names; see dplay.h for the full DPSPGUID_* table. */
const SP_NAMES: Record<string, string> = {
  '{36e95ee0-8577-11cf-960c-0080c7534e82}': 'tcpip',
  '{685bc400-9d2c-11cf-a9cd-00aa006886e3}': 'ipx',
  '{0f1d6860-88d9-11cf-9c4e-00a0c905425e}': 'serial',
  '{44eaa760-cb68-11cf-9c4e-00a0c905425e}': 'modem',
};

/**
 * DirectPlay interfaces served by one vtable: 3/3A share layout, and 2/2A are prefixes of 3.
 * Exclude IID_IDirectPlay4/4A, which add methods.
 */
const DIRECTPLAY_IIDS = new Set([
  '{00000000-0000-0000-c000-000000000046}', // IID_IUnknown
  '{2b74f7c0-9154-11cf-a9cd-00aa006886e3}', // IID_IDirectPlay2
  '{9d460580-a822-11cf-960c-0080c7534e82}', // IID_IDirectPlay2A
  '{133efe40-32dc-11d0-9cfb-00a0c90a43cb}', // IID_IDirectPlay3
  '{133efe41-32dc-11d0-9cfb-00a0c90a43cb}', // IID_IDirectPlay3A
]);

/** A DP IID was requested, but this compatibility layer does not implement that interface. */
export function isDirectPlayIid(iid: string): boolean {
  return DIRECTPLAY_IIDS.has(iid);
}

/** IDirectPlayLobby IIDs from Wine dplobby.h lines 34-49. */
const LOBBY_IIDS = new Set([
  '{00000000-0000-0000-c000-000000000046}', // IID_IUnknown
  '{af465c71-9588-11cf-a020-00aa006157ac}', // IID_IDirectPlayLobby
  '{26c66a70-b367-11cf-a024-00aa006157ac}', // IID_IDirectPlayLobbyA
  '{0194c220-a303-11d0-9c4f-00a0c905425e}', // IID_IDirectPlayLobby2
  '{1bb4af80-a303-11d0-9c4f-00a0c905425e}', // IID_IDirectPlayLobby2A
  '{2db72490-652c-11d1-a7a8-0000f803abfc}', // IID_IDirectPlayLobby3
  '{2db72491-652c-11d1-a7a8-0000f803abfc}', // IID_IDirectPlayLobby3A
]);

/**
 * IDirectPlayLobby3 vtable: 11 Lobby slots + Lobby2 CreateCompoundAddress + Lobby3 ConnectEx/RegisterApplication/UnregisterApplication/WaitForConnectionSettings = 19 slots. Lobby 1/2 layouts are prefixes, so one table serves all three generations; see Wine dplobby.c dpl3A_vt.
 */
const LOBBY3_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Connect', 16],
  ['CreateAddress', 28],
  ['EnumAddress', 20],
  ['EnumAddressTypes', 20],
  ['EnumLocalApplications', 16],
  ['GetConnectionSettings', 16],
  ['ReceiveLobbyMessage', 24],
  ['RunApplication', 20],
  ['SendLobbyMessage', 20],
  ['SetConnectionSettings', 16],
  ['SetLobbyMessageEvent', 16],
  ['CreateCompoundAddress', 20],
  ['ConnectEx', 20],
  ['RegisterApplication', 12],
  ['UnregisterApplication', 12],
  ['WaitForConnectionSettings', 8],
];

/** DPAID_* data-type GUIDs from Wine dplobby.h lines 205-246. */
const DPAID_TOTAL_SIZE = '{1318f560-912c-11d0-9daa-00a0c90a43cb}';
const DPAID_SERVICE_PROVIDER = '{07d916c0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_LOBBY_PROVIDER = '{59b95640-9667-11d0-a77d-0000f803abfc}';
const DPAID_PHONE = '{78ec89a0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_MODEM = '{f6dcc200-a2fe-11d0-9c4f-00a0c905425e}';
const DPAID_INET = '{c4a54da0-e0af-11cf-9c4e-00a0c905425e}';
const DPAID_INET_PORT = '{e4524541-8ea5-11d1-8a96-006097b01411}';
const DPAID_COM_PORT = '{f2f0ce00-e0af-11cf-9c4e-00a0c905425e}';
/** ANSI interfaces receiving W data types return DPERR_INVALIDFLAGS; see Wine dplobby.c. */
const DPAID_W_GUIDS = new Set([
  '{ba5a7a70-9dbf-11d0-9cc1-00a0c905425e}', // DPAID_PhoneW
  '{01fd92e0-a2ff-11d0-9c4f-00a0c905425e}', // DPAID_ModemW
  '{e63232a0-9dbf-11d0-9cc1-00a0c905425e}', // DPAID_INetW
]);

/** dplayTransport carries DirectPlay wire messages while message semantics and the COM layer remain unchanged. */
/**
 * Per-message/per-pump transport logging; enable only for diagnostics. Normal use floods two-tab consoles: 2-4 lines per message, two per pump drain, four per enumeration. Every line incurs DevTools rendering cost, so logging itself can slow high-frequency networking and is a prime suspect in poor multiplayer performance.
 */
const DPLAY_VERBOSE_LOG = false;
const DPLAY_DISCOVERY_TTL_MS = 30_000;

/** Canonical GUID string to 16 guest-memory bytes: reverse Data1/2/3 for little-endian order and preserve Data4. */
export function guidBytes(guid: string): Uint8Array {
  const hex = guid.replace(/[{}-]/g, '');
  const out = new Uint8Array(16);
  const d1 = parseInt(hex.slice(0, 8), 16);
  const d2 = parseInt(hex.slice(8, 12), 16);
  const d3 = parseInt(hex.slice(12, 16), 16);
  out[0] = d1 & 0xff;
  out[1] = (d1 >>> 8) & 0xff;
  out[2] = (d1 >>> 16) & 0xff;
  out[3] = d1 >>> 24;
  out[4] = d2 & 0xff;
  out[5] = d2 >>> 8;
  out[6] = d3 & 0xff;
  out[7] = d3 >>> 8;
  for (let i = 0; i < 8; i++) out[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return out;
}

/** HRESULT：DPERR_UNINITIALIZED（MAKE_HRESULT(1, 0x877, 320)）。 */
const DPERR_UNINITIALIZED = 0x8877_0140;
/** HRESULT：DPERR_BUFFERTOOSMALL（30）/ INVALIDPLAYER（150）/ NOMESSAGES（190）。 */
const DPERR_BUFFERTOOSMALL = 0x8877_001e;
const DPERR_INVALIDPLAYER = 0x8877_0096;
const DPERR_NOMESSAGES = 0x8877_00be;

/**
 * IDirectPlay3 vtable: 3 IUnknown slots + 29 IDirectPlay2 slots + 15 IDirectPlay3 slots = 47. Order matches Wine dplay.h / DirectX SDK; the game requests layout-compatible ANSI IID_IDirectPlay3A. Values are stdcall argument bytes including this.
 */
export const DP3_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['AddPlayerToGroup', 12],
  ['Close', 4],
  ['CreateGroup', 24],
  ['CreatePlayer', 28],
  ['DeletePlayerFromGroup', 12],
  ['DestroyGroup', 8],
  ['DestroyPlayer', 8],
  ['EnumGroupPlayers', 24],
  ['EnumGroups', 20],
  ['EnumPlayers', 20],
  ['EnumSessions', 24],
  ['GetCaps', 12],
  ['GetGroupData', 20],
  ['GetGroupName', 16],
  ['GetMessageCount', 12],
  ['GetPlayerAddress', 16],
  ['GetPlayerCaps', 12],
  ['GetPlayerData', 20],
  ['GetPlayerName', 16],
  ['GetSessionDesc', 12],
  ['Initialize', 8],
  ['Open', 12],
  ['Receive', 24],
  ['Send', 24],
  ['SetGroupData', 20],
  ['SetGroupName', 16],
  ['SetPlayerData', 20],
  ['SetPlayerName', 16],
  ['SetSessionDesc', 12],
  ['AddGroupToGroup', 12],
  ['CreateGroupInGroup', 28],
  ['DeleteGroupFromGroup', 12],
  ['EnumConnections', 20],
  ['EnumGroupsInGroup', 24],
  ['GetGroupConnectionSettings', 20],
  ['InitializeConnection', 12],
  ['SecureOpen', 20],
  ['SendChatMessage', 20],
  ['SetGroupConnectionSettings', 16],
  ['StartSession', 12],
  ['GetGroupFlags', 12],
  ['GetGroupParent', 12],
  ['GetPlayerAccount', 20],
  ['GetPlayerFlags', 12],
];

/**
 * DirectPlay compatibility layer. Initially supports COM object creation with standard IUnknown semantics and answers valid without networking: zero GetCaps, no EnumConnections, and uninitialized/disconnected EnumSessions. Other methods stop at their boundaries pending observed game usage. DirectPlay methods enter here; the transport abstraction carries networking.
 */
export function withDplayx<TBase extends Constructor<DirectxChain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    /** Whether InitializeConnection succeeded; success means the network stack is ready and session enumeration returns an empty list. */
    private dplayConnectionInitialized = false;
    /** Current session established by Open(CREATE/JOIN); JOIN is local until room-service support exists. */
    private dplaySession: {
      nameBytes: Uint8Array;
      maxPlayers: number;
      sessionFlags: number;
      appGuid: string;
      hosting: boolean;
    } | null = null;
    private dplayPlayers = new Map<
      number,
      { name: number; event: number; data: number; dataSize: number; local: boolean; announced: boolean }
    >();
    private nextDpid = 1;
    /** Copied session description from SetSessionDesc, used by InitializeConnection(NULL) and enumeration. */
    private sessionDesc = 0;
    /** Lazily opened DirectPlay transport; browser default is WebSocket. */
    private dplayTransport: DplayTransport | null = null;
    /** Current session instance GUID, generated by hosts or copied from the description when joining. */
    private dplayInstance = '';
    /** Local player DPID recorded by CreatePlayer for incoming-message routing. */
    private dplayLocal = 0;
    /** Timestamp throttling diagnostics for rejected pump injection. */
    protected lastInjectRejectAt = 0;
    /** Received-message queue consumed by Receive; data lives in the shim heap. */
    protected dplayQueue: Array<{ from: number; to: number; data: number; size: number }> = [];
    /** Guest staging by callback owner address; an active bridge must retain all its callback arguments. */
    private readonly enumSessionsScratch = new Map<number, number[]>();
    /** Cached remote sessions for EnumSessions, refreshed by announce heartbeats. */
    private dplayRemoteSessions = new Map<
      string,
      {
        nameBytes: Uint8Array;
        maxPlayers: number;
        currentPlayers: number;
        appGuid: string;
        sessionFlags: number;
        lastSeen: number;
      }
    >();
    /** Host's last announce time; heartbeats piggyback on dplayx calls. */
    private dplayLastAnnounce = 0;
    /** Host heartbeat timer: waiting-room games may go entirely silent without the pump thread, so hypercall cadence alone is insufficient. */
    private dplayHeartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
    /** Last observed enumeration callback EAX from shared HYPERCALL_CALLBACK_RESULT; log changes. */
    private dplayLastCallbackResult = 0;
    /** Synthesized TCP/IP connection, 40-byte DPLCONNECTION plus DPNAME; create on first enumeration and reuse. */
    private tcpipConnection = 0;
    private tcpipConnectionName = 0;

    private ensureTcpipConnection(): void {
      if (this.tcpipConnection) return;
      // TCP/IP with a trailing NUL is pure ASCII and byte-compatible with GBK.
      const shortName = this.alloc(8, true);
      this.memory.write_memory(new Uint8Array([0x54, 0x43, 0x50, 0x2f, 0x49, 0x50, 0]), shortName);
      const name = this.alloc(16, true); // DPNAME: dwSize, dwFlags, lpszShortNameA, lpszLongNameA
      this.writeU32(name, 16);
      this.writeU32(name + 4, 0);
      this.writeU32(name + 8, shortName);
      this.writeU32(name + 12, 0);
      const conn = this.alloc(40, true); // DPLCONNECTION
      this.writeU32(conn, 40); // dwSize
      this.writeU32(conn + 4, 0); // dwFlags
      this.writeU32(conn + 8, 0); // lpSessionDesc
      this.writeU32(conn + 12, 0); // lpPlayerName
      this.memory.write_memory(DPSPGUID_TCPIP_BYTES, conn + 16); // guidSP
      this.writeU32(conn + 32, 0); // lpAddress
      this.writeU32(conn + 36, 0); // dwAddressSize
      this.tcpipConnection = conn;
      this.tcpipConnectionName = name;
    }

    /**
     * Guest callback bridge using the same trampoline style as WndProc: push each argument group right-to-left, call the guest function, and repeat for multiple players/sessions. Before return, set EAX=returnEax and jump to the original return address. Enumeration APIs return DP_OK independently of callback BOOL results.
     */
    protected invokeGuestCallbacks(
      call: Win32Call,
      callback: number,
      argSets: number[][],
      returnEax = 0,
    ): GuestCallbackFrame | undefined {
      if (argSets.length === 0) return;
      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { trampoline } = frame;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp
      for (const args of argSets) {
        for (let i = args.length - 1; i >= 0; i--) push(args[i]!);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp, ebp accommodates stdcall/cdecl cleanup differences.
        code.push(0xa3);
        emit32(HYPERCALL_CALLBACK_RESULT); // mov [result], eax
      }
      code.push(0x5d); // pop ebp
      code.push(0xb8);
      emit32(returnEax); // mov eax, returnEax
      try {
        this.appendGuestCallbackReturn(code, frame, originalReturn);
        this.memory.write_memory(code, trampoline);
        this.writeU32(call.stack, trampoline);
        return frame;
      } catch (error) {
        this.cancelGuestCallback(frame);
        throw error;
      }
    }

    /** Convenience wrapper for one callback. */
    protected invokeGuestCallback(call: Win32Call, callback: number, argsInOrder: number[], returnEax = 0): void {
      this.invokeGuestCallbacks(call, callback, [argsInOrder], returnEax);
    }

    /** Copy NUL-terminated narrow strings into the shim heap unchanged, preserving GBK bytes without encoding/decoding. */
    private copyNarrowString(ptr: number, max = 256): number {
      if (!ptr) return 0;
      const bytes = this.memory.read_memory(ptr, max);
      let end = bytes.indexOf(0);
      if (end < 0) end = bytes.length;
      const copy = this.alloc(end + 1, true);
      this.memory.write_memory(bytes.subarray(0, end), copy);
      this.memory.write_memory(new Uint8Array([0]), copy + end);
      return copy;
    }

    /** Copy 16-byte DPNAME plus two strings into the shim heap; enumeration callbacks need copies because game buffers may be reused. */
    private copyDpName(namePtr: number): number {
      if (!namePtr) return 0;
      if (this.readU32(namePtr) < 16) return 0;
      const name = this.alloc(16, true);
      this.writeU32(name, 16); // dwSize
      this.writeU32(name + 4, this.readU32(namePtr + 4)); // dwFlags
      this.writeU32(name + 8, this.copyNarrowString(this.readU32(namePtr + 8)));
      this.writeU32(name + 12, this.copyNarrowString(this.readU32(namePtr + 12)));
      return name;
    }

    /** Copy arbitrary bytes into the shim heap. */
    private copyGuestBytes(ptr: number, size: number): number {
      const copy = this.alloc(size, true);
      this.memory.write_memory(this.memory.read_memory(ptr, size), copy);
      return copy;
    }

    /** Two-call fixed-output semantics: insufficient capacity writes required size and returns DPERR_BUFFERTOOSMALL; otherwise copy and write back size. */
    private writeSized(srcPtr: number, size: number, outPtr: number, sizePtr: number): Win32Result {
      if (!sizePtr) return { eax: 0x8000_4003 }; // E_POINTER
      if (!outPtr || this.readU32(sizePtr) < size) {
        this.writeU32(sizePtr, size);
        return { eax: DPERR_BUFFERTOOSMALL };
      }
      if (srcPtr && size) this.memory.write_memory(this.memory.read_memory(srcPtr, size), outPtr);
      this.writeU32(sizePtr, size);
      return { eax: 0 }; // DP_OK
    }

    /** Raw bytes before NUL, without GBK encoding/decoding. */
    private rawBytesUpToNul(ptr: number, max: number): Uint8Array {
      if (!ptr) return new Uint8Array(0);
      const bytes = this.memory.read_memory(ptr, max);
      let end = bytes.indexOf(0);
      if (end < 0) end = bytes.length;
      return bytes.slice(0, end);
    }

    /** Wire bytes to a shim-heap string with an appended NUL. */
    protected bytesToGuest(bytes: Uint8Array): number {
      const copy = this.alloc(bytes.length + 1, true);
      this.memory.write_memory(bytes, copy);
      this.memory.write_memory(new Uint8Array([0]), copy + bytes.length);
      return copy;
    }

    /**
     * Enqueue synthesized DPMSG_CREATEPLAYERORGROUP, 48 bytes following DirectPlay3A ANSI layout in Wine dplay.h. When the pump drains, game dispatcher 0x4483D0 checks [eax]-3==0 and calls 0x448050(dpId, shortName) to add the player to the UI. Without it, the game waits forever for opponents, the old joining-side hang. from must be 0 (DPID_SYSMSG): pump 0x448480 routes nonzero sources to application handler 0x445B10, preventing system dispatch and hanging in game-message processing.
     */
    protected pushCreatePlayerMessage(dpid: number, nameBytes: Uint8Array, currentPlayers: number): void {
      const namePtr = this.bytesToGuest(nameBytes);
      const msg = this.alloc(48, true);
      const w = (off: number, value: number): void => this.writeU32(msg + off, value);
      w(0x00, 3); // dwType = DPMSG_CREATEPLAYERORGROUP
      w(0x04, 1); // dwPlayerType = DPPLAYERTYPE_PLAYER
      w(0x08, dpid);
      w(0x0c, currentPlayers);
      w(0x10, 0); // lpData
      w(0x14, 0); // dwDataSize
      w(0x18, 16); // dpnName.dwSize
      w(0x1c, 0); // dpnName.dwFlags
      w(0x20, namePtr); // dpnName.lpszShortNameA
      w(0x24, 0); // dpnName.lpszLongNameA
      w(0x28, 0); // dpIdParent
      w(0x2c, 0); // dwFlags
      this.dplayQueue.push({ from: 0, to: 0, data: msg, size: 48 }); // from=0 means a DPID_SYSMSG system message.
      console.log(`[dplayx] 合成 DPMSG_CREATEPLAYERORGROUP dpid=${dpid}（队列 ${this.dplayQueue.length}）`);
    }

    /** Raw short-name bytes from the DPNAME copy for pinfo broadcasts. */
    private nameBytesAt(namePtr: number): Uint8Array {
      if (!namePtr) return new Uint8Array(0);
      return this.rawBytesUpToNul(this.readU32(namePtr + 8), 256);
    }

    /** Attach transport handlers; cache announce even without a session, and filter other messages by instance. */
    private handleDplayMessage(m: DplayWire): void {
      if (!m) return;
      if (DPLAY_VERBOSE_LOG && m.t !== 'announce' && m.t !== 'sclose') {
        console.log(
          `[dplayx] 收消息 ${m.t} i=${m.i.slice(0, 8)}… d=${(m as { d?: number }).d ?? '-'}` +
            ` 会话=${this.dplaySession ? (this.dplaySession.hosting ? '房主' : '加入') : '无'}` +
            ` 实例匹配=${!!this.dplaySession && m.i === this.dplayInstance}`,
        );
      }
      if (m.t === 'announce') {
        this.dplayRemoteSessions.set(m.i, {
          nameBytes: m.n,
          maxPlayers: m.m,
          currentPlayers: m.c,
          appGuid: m.g,
          sessionFlags: m.f,
          lastSeen: this.clock.now(),
        });
        if (DPLAY_VERBOSE_LOG) {
          console.log(`[dplayx] 收到建房 announce ${m.i.slice(0, 8)}…（缓存 ${this.dplayRemoteSessions.size} 个会话）`);
        }
        return;
      }
      if (m.t === 'sclose') {
        // Invalidate old instances immediately when hosts reopen rooms, without waiting 10s for expiry.
        if (this.dplayRemoteSessions.delete(m.i)) {
          if (DPLAY_VERBOSE_LOG) {
            console.log(`[dplayx] 会话关闭通知：移除 ${m.i.slice(0, 8)}…（剩 ${this.dplayRemoteSessions.size}）`);
          }
        }
        if (this.dplaySession && !this.dplaySession.hosting && m.i === this.dplayInstance) {
          this.dplaySession = null;
          this.dplayPlayers.clear();
          this.dplayQueue.length = 0;
          this.nextDpid = 1;
          this.dplayLocal = 0;
        }
        return;
      }
      if (!this.dplaySession || m.i !== this.dplayInstance) return;
      switch (m.t) {
        case 'join': {
          // Current dplayx state replay targets two-VM/two-tab flows: the first joiner gets DPID 2.
          // Although relay capacity is larger, existing non-host players do not fully replay state for a third participant;
          // multiplayer DPID allocation and state replay still require further negotiation.
          if (!this.dplaySession.hosting) return;
          if (!this.dplayPlayers.has(2)) {
            this.dplayPlayers.set(2, { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false });
          }
          if (this.nextDpid < 3) this.nextDpid = 3;
          // Replay local CREATE_PLAYER so the joiner can see the host.
          for (const [dpid, p] of this.dplayPlayers) {
            if (p.local) {
              this.dplayPost({
                t: 'newplayer',
                i: this.dplayInstance,
                d: dpid,
                n: this.nameBytesAt(p.name),
                c: this.dplayPlayers.size,
              });
              console.log(`[dplayx] 房主重播 newplayer dpid=${dpid} → 加入方`);
            }
          }
          return;
        }
        case 'pinfo': {
          // Synchronize names only. Synthesize CREATE_PLAYER exclusively from newplayer, including creator echoes;
          // doing it here too would duplicate notifications when hosts receive both joiner pinfo and newplayer.
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.local) {
            return;
          }
          p.name = this.bytesToGuest(m.n);
          return;
        }
        case 'newplayer': {
          // Broadcast DPMSG_CREATEPLAYERORGROUP for both CreatePlayer and host join replay.
          // Real DirectPlay sends it to everyone, including the creator, who also
          // waits for it before adding itself to the UI, causing the original joiner hang. Transport echoes and
          // replays may duplicate arrivals; announced ensures one synthesized message per player.
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.announced) {
            return;
          }
          p.name = this.bytesToGuest(m.n);
          p.announced = true;
          return;
        }
        case 'pdata': {
          let p = this.dplayPlayers.get(m.d);
          if (!p) {
            p = { name: 0, event: 0, data: 0, dataSize: 0, local: false, announced: false };
            this.dplayPlayers.set(m.d, p);
          } else if (p.local) {
            return;
          }
          if (p.data) this.freeAllocation(p.data);
          p.data = this.bytesToGuest(m.a);
          p.dataSize = m.a.length;
          return;
        }
        case 'msg': {
          // DPID_ALLPLAYERS(0) broadcasts to local players; directed messages verify the recipient.
          const to = m.o === 0 ? this.dplayLocal : m.o;
          if (to !== this.dplayLocal) return;
          if (DPLAY_VERBOSE_LOG) {
            const hex = [...m.a.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[dplayx] 队列收应用消息 from=${m.f} to=${to} 长度=${m.a.length} 头=${hex}`);
          }
          this.dplayQueue.push({ from: m.f, to, data: this.bytesToGuest(m.a), size: m.a.length });
          return;
        }
        case 'leave': {
          const p = this.dplayPlayers.get(m.d);
          if (!p || p.local) return;
          if (p.data) this.freeAllocation(p.data);
          this.dplayPlayers.delete(m.d);
          return;
        }
      }
    }

    private ensureDplayTransport(): DplayTransport {
      if (!this.dplayTransport) {
        const transportFactory = this.options.dplayTransportFactory ?? createDefaultDplayTransport;
        this.dplayTransport = transportFactory({
          onMessage: (message) => this.handleDplayMessage(message),
          onOpen: () => this.replayDplayState(),
          onError: (error) => {
            if (DPLAY_VERBOSE_LOG) console.warn('[dplayx] transport error', error);
          },
        });
      }
      return this.dplayTransport;
    }

    private dplayPost(m: DplayWire): boolean {
      return this.ensureDplayTransport().send(m);
    }

    public disposeDplayTransport(): void {
      if (this.dplayHeartbeatTimer !== null) {
        globalThis.clearInterval(this.dplayHeartbeatTimer);
        this.dplayHeartbeatTimer = null;
      }
      const transport = this.dplayTransport;
      this.dplayTransport = null;
      transport?.close();
    }

    /** Host heartbeat: reannounce every 2s, piggybacking on any dplayx call. */
    private sendDplayAnnounce(): boolean {
      if (!this.dplaySession?.hosting) return false;
      const sent = this.dplayPost({
        t: 'announce',
        i: this.dplayInstance,
        n: this.dplaySession.nameBytes,
        m: this.dplaySession.maxPlayers,
        c: this.dplayPlayers.size,
        g: this.dplaySession.appGuid,
        f: this.dplaySession.sessionFlags,
      });
      if (sent) this.dplayLastAnnounce = this.clock.now();
      return sent;
    }

    private replayLocalPlayers(includePinfo: boolean): void {
      if (!this.dplaySession) return;
      for (const [dpid, player] of this.dplayPlayers) {
        if (!player.local) continue;
        const name = this.nameBytesAt(player.name);
        if (includePinfo) this.dplayPost({ t: 'pinfo', i: this.dplayInstance, d: dpid, n: name });
        this.dplayPost({ t: 'newplayer', i: this.dplayInstance, d: dpid, n: name, c: this.dplayPlayers.size });
        if (player.data) {
          this.dplayPost({
            t: 'pdata',
            i: this.dplayInstance,
            d: dpid,
            a: this.memory.read_memory(player.data, player.dataSize),
          });
        }
      }
    }

    private replayDplayState(): void {
      if (!this.dplaySession) return;
      if (this.dplaySession.hosting) this.sendDplayAnnounce();
      else this.dplayPost({ t: 'join', i: this.dplayInstance });
      this.replayLocalPlayers(true);
    }

    private dplayPump(): void {
      if (!this.dplaySession?.hosting) return;
      const now = this.clock.now();
      if (now - this.dplayLastAnnounce >= 2000) {
        this.sendDplayAnnounce();
      }
    }

    /** Object factory shared by CoCreateInstance and DirectPlayCreate. */
    protected createDirectPlay(): number {
      // Open the channel at object creation for passive listening; joiners only receive while browsing sessions,
      // so lazy opening misses all host announcements. The transport does not cache control state for the VM.
      this.ensureDplayTransport();
      this.dplayObjectsCreated++;
      return this.createComObject('IDirectPlay3', DP3_METHODS, 'DPLAYX.COM');
    }

    /** Smoke/menu-discovery probe: a DP object was created, indicating entry into multiplayer UI. */
    public dplayObjectsCreated = 0;

    /** Smoke/debug snapshot of DPlay sessions and players for host-side connectivity assertions. */
    public inspectDplayState(): {
      created: number;
      initialized: boolean;
      session: { hosting: boolean; instance: string; name: string } | null;
      players: Array<{ dpid: number; local: boolean; name: string }>;
      queue: number;
    } {
      const decode = (bytes: Uint8Array) => new TextDecoder('big5').decode(bytes);
      return {
        created: this.dplayObjectsCreated,
        initialized: this.dplayConnectionInitialized,
        session: this.dplaySession
          ? {
              hosting: this.dplaySession.hosting,
              instance: this.dplayInstance,
              name: decode(this.dplaySession.nameBytes),
            }
          : null,
        players: [...this.dplayPlayers.entries()].map(([dpid, p]) => ({
          dpid,
          local: p.local,
          name: decode(this.nameBytesAt(p.name)),
        })),
        queue: this.dplayQueue.length,
      };
    }

    /** Lobby factory for DirectPlayLobbyCreateA; Lobby3 layout supports generations 1/2. */
    protected createDirectPlayLobby(): number {
      return this.createComObject('IDirectPlayLobby3A', LOBBY3_METHODS, 'DPLAYX.COM');
    }

    /** Serialized compound-address element size: 40-byte DPADDRESS header plus payload; skip unknown types. */
    private compoundAddressElementSize(guid: string, dataSize: number): number | null {
      switch (guid) {
        case DPAID_SERVICE_PROVIDER:
        case DPAID_LOBBY_PROVIDER:
          return 40 + 16; // Payload is always a 16-byte GUID.
        case DPAID_PHONE:
        case DPAID_MODEM:
        case DPAID_INET:
          return 40 + dataSize;
        case DPAID_INET_PORT:
          return 40 + 2;
        case DPAID_COM_PORT:
          return 40 + 20;
        default:
          return null;
      }
    }

    /**
     * IDirectPlayLobby3A.CreateCompoundAddress serializes element arrays into dplayx compound addresses. Follow Wine dplobby.c: first DPAID_TotalSize block records total length; each later block contains GUID(16), u32 size, 20 unused union bytes, then payload. Two-call semantics return DPERR_BUFFERTOOSMALL and required size on insufficient capacity.
     */
    protected createCompoundAddress(a: number[]): Win32Result {
      const elementsPtr = a[1] ?? 0;
      const count = a[2] ?? 0;
      const addressPtr = a[3] ?? 0;
      const sizePtr = a[4] ?? 0;
      if (!elementsPtr || !count) return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM
      if (!sizePtr) return { eax: 0x8000_4003 }; // E_POINTER
      // DPCOMPOUNDADDRESSELEMENT = GUID(16) + dwDataSize + lpData = 24 bytes.
      const elements: Array<{ guid: string; dataSize: number; data: number }> = [];
      for (let i = 0; i < count; i++) {
        const elem = elementsPtr + i * 24;
        elements.push({
          guid: formatGuid(this.readBytes(elem, 16)),
          dataSize: this.readU32(elem + 16),
          data: this.readU32(elem + 20),
        });
      }
      let required = 44; // First TotalSize block: 40-byte header plus 4-byte total length.
      for (const e of elements) {
        if (DPAID_W_GUIDS.has(e.guid)) return { eax: 0x8877_0078 }; // DPERR_INVALIDFLAGS
        const size = this.compoundAddressElementSize(e.guid, e.dataSize);
        if (size !== null) required += size;
      }
      const capacity = this.readU32(sizePtr);
      if (!addressPtr || capacity < required) {
        this.writeU32(sizePtr, required);
        return { eax: 0x8877_001e }; // DPERR_BUFFERTOOSMALL
      }
      const out = new Uint8Array(required);
      let pos = 0;
      const writeChunk = (guid: string, data: Uint8Array) => {
        out.set(guidBytes(guid), pos);
        pos += 16;
        const size = data.length;
        out[pos] = size & 0xff;
        out[pos + 1] = (size >>> 8) & 0xff;
        out[pos + 2] = (size >>> 16) & 0xff;
        out[pos + 3] = size >>> 24;
        pos += 4;
        pos += 20; // Unused union space: Wine leaves these 20 bytes unwritten; zero them while preserving layout.
        out.set(data, pos);
        pos += size;
      };
      const total = new Uint8Array(4);
      total[0] = required & 0xff;
      total[1] = (required >>> 8) & 0xff;
      total[2] = (required >>> 16) & 0xff;
      total[3] = required >>> 24;
      writeChunk(DPAID_TOTAL_SIZE, total);
      for (const e of elements) {
        const size = this.compoundAddressElementSize(e.guid, e.dataSize);
        if (size === null) continue;
        const data =
          e.guid === DPAID_SERVICE_PROVIDER || e.guid === DPAID_LOBBY_PROVIDER
            ? guidBytes(formatGuid(this.readBytes(e.data, 16)))
            : this.readBytes(e.data, size - 40);
        writeChunk(e.guid, data);
      }
      this.memory.write_memory(out, addressPtr);
      this.writeU32(sizePtr, required);
      return { eax: 0 }; // DP_OK
    }

    /** Vtable dispatch for DPLAYX.COM!IDirectPlay3.* methods. */
    protected dispatchDPlay(call: Win32Call): Win32Result | null {
      this.dplayPump(); // Host heartbeats piggyback on dplayx call cadence.
      const callbackResult = this.readU32(HYPERCALL_CALLBACK_RESULT);
      if (callbackResult !== this.dplayLastCallbackResult) {
        this.dplayLastCallbackResult = callbackResult;
        if (DPLAY_VERBOSE_LOG) {
          // Enumeration callback just ran: TRUE(1) accepts the entry and continues; FALSE(0) rejects/stops.
          console.log(
            `[dplayx] 枚举回调返回 EAX=0x${callbackResult.toString(16)}（${callbackResult ? 'TRUE 接受' : 'FALSE 拒绝'}）`,
          );
        }
      }
      const key = call.imported.key;
      const a = call.args;
      const method = key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        const riid = a[1] ?? 0;
        const iid = riid ? formatGuid(this.readBytes(riid, 16)) : '(null)';
        // Lobby and DP objects support their respective IID families.
        const interfaceName = key.slice(key.indexOf('!') + 1, key.lastIndexOf('.'));
        const supported = interfaceName.includes('Lobby') ? LOBBY_IIDS : DIRECTPLAY_IIDS;
        if (!supported.has(iid)) {
          if (a[2]) this.writeU32(a[2], 0);
          return { eax: 0x8000_4002 }; // E_NOINTERFACE
        }
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') return { eax: this.releaseComObject(thisPtr) };

      if (key.startsWith('DPLAYX.COM!IDirectPlayLobby')) {
        switch (method) {
          case 'CreateCompoundAddress':
            return this.createCompoundAddress(a);
          default:
            return null;
        }
      }
      if (key.startsWith('DPLAYX.COM!IDirectPlay3.')) {
        switch (method) {
          case 'Initialize':
            // Do not store the SP GUID yet; later methods may record it as needed.
            return { eax: 0 }; // DP_OK
          case 'GetCaps': {
            // DPCAPS is 40 bytes; without networking, all-zero fields except dwSize represent actual state.
            const capsPtr = a[1] ?? 0;
            if (!capsPtr) return { eax: 0x8000_4003 }; // E_POINTER
            const requested = this.readU32(capsPtr);
            const size = Math.min(requested || 40, 40);
            this.memory.write_memory(new Uint8Array(40), capsPtr);
            this.writeU32(capsPtr, size);
            return { eax: 0 }; // DP_OK
          }
          case 'GetSessionDesc':
            // Return the copied 80-byte SetSessionDesc description, whose name pointers reference shim copies.
            return this.writeSized(this.sessionDesc, this.sessionDesc ? 80 : 0, a[1] ?? 0, a[2] ?? 0);
          case 'SetSessionDesc': {
            // Set the session description before hosting; InitializeConnection(NULL)'s default connection also
            // uses it. Copy 80 bytes plus name/password strings to the shim heap because game buffers are reused.
            const sdesc = a[1] ?? 0;
            if (!sdesc) return { eax: 0x8000_4003 };
            if (this.readU32(sdesc) < 80) return { eax: 0x8007_0057 };
            const copy = this.alloc(80, true);
            this.memory.write_memory(this.memory.read_memory(sdesc, 80), copy);
            const namePtr = this.readU32(copy + 48);
            const passwordPtr = this.readU32(copy + 52);
            if (namePtr) this.writeU32(copy + 48, this.copyNarrowString(namePtr, 128));
            if (passwordPtr) this.writeU32(copy + 52, this.copyNarrowString(passwordPtr, 64));
            this.sessionDesc = copy;
            return { eax: 0 }; // DP_OK
          }
          case 'Open': {
            // CREATE generates a session-instance GUID and broadcasts announce;
            // JOIN takes the target instance from the description populated by EnumSessions
            // and broadcasts join; the transport determines delivery.
            const sdesc = a[1] ?? 0;
            const flags = a[2] ?? 0;
            if (!sdesc) return { eax: 0x8000_4003 }; // E_POINTER
            if (this.readU32(sdesc) < 80) return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM
            if (flags !== 1 && flags !== 2) {
              // DPOPEN_JOIN=1 / DPOPEN_CREATE=2
              this.unimplementedDetail = `Open(dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            const namePtr = this.readU32(sdesc + 48);
            if (flags === 2) {
              // Invalidate the old instance on joiners immediately when reopening a room.
              if (this.dplayInstance && this.dplaySession?.hosting) {
                this.dplayPost({ t: 'sclose', i: this.dplayInstance });
              }
              // The game passes GUID_NULL for CREATE; the compatibility layer generates session identity.
              const instanceBytes = new Uint8Array(16);
              for (let i = 0; i < 16; i++) instanceBytes[i] = Math.floor(Math.random() * 256);
              this.dplayInstance = formatGuid(instanceBytes);
              this.dplaySession = {
                nameBytes: this.rawBytesUpToNul(namePtr, 128),
                maxPlayers: this.readU32(sdesc + 40),
                sessionFlags: this.readU32(sdesc + 4),
                appGuid: formatGuid(this.readBytes(sdesc + 24, 16)),
                hosting: true,
              };
              this.dplayLastAnnounce = 0;
              console.log(`[dplayx] Open(CREATE) 建房实例 ${this.dplayInstance.slice(0, 8)}…`);
              if (this.dplayHeartbeatTimer === null) {
                this.dplayHeartbeatTimer = globalThis.setInterval(() => this.dplayPump(), 1500);
              }
            } else {
              this.dplayInstance = formatGuid(this.readBytes(sdesc + 8, 16));
              console.log(
                `[dplayx] Open(JOIN) 目标实例 ${this.dplayInstance.slice(0, 8)}…（缓存中${this.dplayRemoteSessions.has(this.dplayInstance) ? '在' : '不在'}）`,
              );
              this.dplaySession = {
                nameBytes: this.rawBytesUpToNul(namePtr, 128),
                maxPlayers: this.readU32(sdesc + 40),
                sessionFlags: this.readU32(sdesc + 4),
                appGuid: formatGuid(this.readBytes(sdesc + 24, 16)),
                hosting: false,
              };
              // Deterministic allocation for two-tab tests: host DPID 1, joiners from 2 onward.
              this.nextDpid = 2;
            }
            this.dplayPlayers.clear();
            this.dplayQueue.length = 0;
            this.dplayLocal = 0;
            if (this.dplaySession.hosting) this.dplayPump();
            else this.dplayPost({ t: 'join', i: this.dplayInstance });
            return { eax: 0 }; // DP_OK
          }
          case 'CreatePlayer': {
            // (LPDPID, LPDPNAME, HANDLE, LPVOID, DWORD, DWORD): local DPIDs start at 1.
            const idPtr = a[1] ?? 0;
            if (!idPtr) return { eax: 0x8000_4003 };
            if (!this.dplaySession) return { eax: DPERR_UNINITIALIZED };
            const dpid = this.nextDpid++;
            this.writeU32(idPtr, dpid);
            const name = this.copyDpName(a[2] ?? 0);
            this.dplayPlayers.set(dpid, {
              name,
              event: a[3] ?? 0,
              data: 0,
              dataSize: 0,
              local: true,
              announced: false,
            });
            this.dplayLocal = dpid;
            // Broadcast player information; peers not yet joined discard it, and join replies replay the host afterward.
            this.dplayPost({ t: 'pinfo', i: this.dplayInstance, d: dpid, n: this.nameBytesAt(name) });
            // Send CREATE_PLAYER system messages to everyone including the creator; the creator also relies on
            // its transport echo to add itself to the UI, and both UIs await this message.
            this.dplayPost({
              t: 'newplayer',
              i: this.dplayInstance,
              d: dpid,
              n: this.nameBytesAt(name),
              c: this.dplayPlayers.size,
            });
            return { eax: 0 };
          }
          case 'DestroyPlayer': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            if (player.data) this.freeAllocation(player.data);
            this.dplayPlayers.delete(a[1] ?? 0);
            return { eax: 0 };
          }
          case 'SetPlayerData': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            if (player.data) this.freeAllocation(player.data);
            const size = a[3] ?? 0;
            player.data = size && a[2] ? this.copyGuestBytes(a[2], size) : 0;
            player.dataSize = player.data ? size : 0;
            if (player.local && player.data) {
              this.dplayPost({
                t: 'pdata',
                i: this.dplayInstance,
                d: a[1] ?? 0,
                a: this.memory.read_memory(player.data, player.dataSize),
              });
            }
            return { eax: 0 };
          }
          case 'GetPlayerData': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(player.data, player.dataSize, a[2] ?? 0, a[3] ?? 0);
          }
          case 'SetPlayerName': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            player.name = this.copyDpName(a[2] ?? 0);
            if (player.local) {
              this.dplayPost({
                t: 'pinfo',
                i: this.dplayInstance,
                d: a[1] ?? 0,
                n: this.nameBytesAt(player.name),
              });
            }
            return { eax: 0 };
          }
          case 'GetPlayerName': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(player.name, player.name ? 16 : 0, a[2] ?? 0, a[3] ?? 0);
          }
          case 'GetPlayerCaps': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            const capsPtr = a[2] ?? 0;
            if (!capsPtr) return { eax: 0x8000_4003 };
            const requested = this.readU32(capsPtr);
            const size = Math.min(requested || 40, 40);
            this.memory.write_memory(new Uint8Array(40), capsPtr);
            this.writeU32(capsPtr, size);
            return { eax: 0 };
          }
          case 'GetPlayerAddress': {
            const player = this.dplayPlayers.get(a[1] ?? 0);
            if (!player) return { eax: DPERR_INVALIDPLAYER };
            return this.writeSized(0, 0, a[2] ?? 0, a[3] ?? 0);
          }
          case 'GetMessageCount': {
            const countPtr = a[2] ?? 0;
            if (!countPtr) return { eax: 0x8000_4003 };
            this.writeU32(countPtr, this.dplayQueue.length);
            return { eax: 0 };
          }
          case 'Send': {
            // Send(this, DPID from, DPID to, DWORD flags, LPVOID data, DWORD size)：
            // Size is a[5], data is a[4]. Former a[4]/a[3] indexing treated lpData as length
            // and read 7MB of zero pages from the flags address, delivering no actual packets and making both sides wait forever.
            const to = a[2] ?? 0;
            if (to !== 0 && !this.dplayPlayers.has(to)) return { eax: DPERR_INVALIDPLAYER };
            const size = a[5] ?? 0;
            const data = size && a[4] ? this.memory.read_memory(a[4], size) : new Uint8Array(0);
            this.dplayPost({ t: 'msg', i: this.dplayInstance, f: a[1] ?? 0, o: to, a: data });
            return { eax: 0 }; // DP_OK
          }
          case 'Receive': {
            // Pop the transport queue; empty means DPERR_NOMESSAGES, normal for the network pump.
            this.dplayPump();
            const msg = this.dplayQueue[0];
            if (!msg) {
              if (a[1]) this.writeU32(a[1], 0); // lpidFrom
              if (a[2]) this.writeU32(a[2], 0); // lpidTo
              if (a[5]) this.writeU32(a[5], 0); // lpdwDataSize
              return { eax: DPERR_NOMESSAGES };
            }
            if (!a[5]) return { eax: 0x8000_4003 }; // E_POINTER
            const capacity = this.readU32(a[5]);
            if (capacity < msg.size) {
              this.writeU32(a[5], msg.size);
              return { eax: DPERR_BUFFERTOOSMALL };
            }
            if (a[4] && msg.size) {
              this.memory.write_memory(this.memory.read_memory(msg.data, msg.size), a[4]);
            }
            this.writeU32(a[5], msg.size);
            if (a[1]) this.writeU32(a[1], msg.from);
            if (a[2]) this.writeU32(a[2], msg.to);
            if (!((a[3] ?? 0) & 0x8)) {
              // Do not pop with DPRECEIVE_PEEK=0x8.
              this.dplayQueue.shift();
              this.freeAllocation(msg.data);
            }
            return { eax: 0 };
          }
          case 'Close': {
            if (this.dplaySession) {
              if (this.dplaySession.hosting) {
                // When the host closes DirectPlay, destroy the relay room rather than leaving only its last player.
                this.dplayPost({ t: 'sclose', i: this.dplayInstance });
              } else {
                // Joiners may create multiple local players; leave each one instead of sending only the last dplayLocal.
                for (const [dpid, player] of this.dplayPlayers) {
                  if (player.local) this.dplayPost({ t: 'leave', i: this.dplayInstance, d: dpid });
                }
              }
            }
            if (this.dplayHeartbeatTimer !== null) {
              globalThis.clearInterval(this.dplayHeartbeatTimer);
              this.dplayHeartbeatTimer = null;
            }
            this.dplaySession = null;
            this.dplayPlayers.clear();
            this.dplayQueue.length = 0;
            this.nextDpid = 1;
            this.dplayLocal = 0;
            return { eax: 0 };
          }
          case 'EnumPlayers': {
            // Call back for each local and remote player, sharing one trampoline across argument groups.
            // EnumPlayers(this, LPDPENUMPLAYERSCALLBACK2, LPVOID, DWORD)——
            // callback=a[1], context=a[2], flags=a[3]. Former a[2]/a[3] indexing made
            // player enumeration always return E_POINTER, preventing player-list construction.
            const callback = a[1] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            if (this.dplayPlayers.size === 0) return { eax: 0 };
            const argSets: number[][] = [];
            for (const [dpid, player] of this.dplayPlayers) {
              // LPDPENUMPLAYERSCALLBACK2(DPID, type, DPNAME*, flags, context).
              argSets.push([
                dpid,
                0, // Player, not group.
                player.name,
                player.local ? 0x0000_0008 : 0x0000_0010, // DPENUMPLAYERS_LOCAL/REMOTE
                a[2] ?? 0,
              ]);
            }
            this.invokeGuestCallbacks(call, callback, argSets);
            return { eax: 0 };
          }
          case 'EnumGroups':
            // No groups: no callbacks.
            return { eax: 0 };
          case 'EnumConnections': {
            // Synthesize one TCP/IP SP connection and invoke the guest enumeration callback through a trampoline.
            const callback = a[2] ?? 0;
            const context = a[3] ?? 0;
            if (!callback) return { eax: 0x8000_4003 }; // E_POINTER
            this.ensureTcpipConnection();
            // LPDPENUMCONNECTIONSCALLBACK(GUID*, connection, size, DPNAME*, flags, context).
            this.invokeGuestCallback(call, callback, [
              this.tcpipConnection + 16, // LPCGUID points to guidSP embedded in the connection.
              this.tcpipConnection,
              40,
              this.tcpipConnectionName,
              0x0000_0001, // DPCONNECTION_DIRECTPLAY
              context,
            ]);
            return { eax: 0 };
          }
          case 'EnumSessions': {
            // Build session lists from cached host announcements; discard after 30s.
            // Guest return tails and ExitThread clear the owner. Enumeration count says nothing about completion:
            // another thread or nested callback can enumerate repeatedly while an outer callback is suspended.
            // Reusing the slot for an unrelated active bridge can delay collection, but cannot free data early.
            for (const [owner, pointers] of this.enumSessionsScratch) {
              if (this.readU32(owner) !== 0) continue;
              for (const pointer of pointers) this.freeAllocation(pointer);
              this.enumSessionsScratch.delete(owner);
            }
            const callback = a[3] ?? 0;
            const context = a[4] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            if (!this.dplayConnectionInitialized) return { eax: DPERR_UNINITIALIZED };
            // Runtime diagnostics: caller-supplied filtering template and callback address, for inspecting the callback checks.
            const templatePtr = a[1] ?? 0;
            const templateApp =
              templatePtr && this.readU32(templatePtr) >= 80
                ? formatGuid(this.readBytes(templatePtr + 24, 16))
                : '(null)';
            if (DPLAY_VERBOSE_LOG) {
              console.log(
                `[dplayx] EnumSessions: 回调=0x${callback.toString(16)} ` +
                  `模板app=${templateApp} dwFlags=0x${(a[5] ?? 0).toString(16)} dwTimeout=${a[2] ?? 0}`,
              );
              // Game modules register early-rejection checks in guest callbacks; the generic layer never guesses game-global layouts.
              const probe = this.gameProfile.directPlay?.enumSessionsProbeAddresses;
              if (probe) {
                console.log(
                  `[dplayx] 游戏枚举状态: 列表全局=0x${this.readU32(probe[0]).toString(16)} ` +
                    `计数=${this.readU8(probe[1])}`,
                );
              }
            }
            const now = this.clock.now();
            const callbackFlags = this.gameProfile.directPlay?.enumSessionsCallbackFlags ?? 0;
            const argSets: number[][] = [];
            let scratch: number[] = [];
            try {
              for (const [instance, s] of this.dplayRemoteSessions) {
                if (now - s.lastSeen > DPLAY_DISCOVERY_TTL_MS) {
                  this.dplayRemoteSessions.delete(instance);
                  continue;
                }
                const name = this.alloc(s.nameBytes.length + 1, true);
                const desc = this.alloc(80, true);
                const timeout = this.alloc(4, true);
                scratch.push(name, desc, timeout);
                if (!name || !desc || !timeout) return { eax: 0x8007_000e }; // DPERR_OUTOFMEMORY
                this.memory.write_memory(s.nameBytes, name);
                this.memory.write_memory(new Uint8Array(80), desc);
                this.writeU32(desc, 80); // dwSize
                this.writeU32(desc + 4, s.sessionFlags); // dwFlags: host session flags.
                this.memory.write_memory(guidBytes(instance), desc + 8); // guidInstance
                this.memory.write_memory(guidBytes(s.appGuid), desc + 24); // guidApplication: the game filters by this value.
                this.writeU32(desc + 40, s.maxPlayers); // dwMaxPlayers
                this.writeU32(desc + 44, s.currentPlayers); // dwCurrentPlayers
                this.writeU32(desc + 48, name); // lpszSessionNameA
                this.writeU32(timeout, a[2] ?? 0); // Return the enumeration timeout supplied by the game.
                // LPDPENUMSESSIONSCALLBACK2(DPSESSIONDESC2*, DWORD*, flags, context);
                // see game-registered enumSessionsCallbackFlags for values and rationale.
                argSets.push([desc, timeout, callbackFlags, context]);
              }
              if (argSets.length === 0) {
                if (DPLAY_VERBOSE_LOG)
                  console.log(`[dplayx] EnumSessions 返回 0 个会话（缓存 ${this.dplayRemoteSessions.size}）`);
                return { eax: 0 };
              }
              if (DPLAY_VERBOSE_LOG) {
                const first = [...this.dplayRemoteSessions.values()][0];
                console.log(
                  `[dplayx] EnumSessions 返回 ${argSets.length} 个会话` +
                    `（app=${first?.appGuid}, flags=0x${first?.sessionFlags.toString(16)}, ` +
                    `cur=${first?.currentPlayers}/max=${first?.maxPlayers}）`,
                );
              }
              const frame = this.invokeGuestCallbacks(call, callback, argSets);
              if (frame) {
                this.enumSessionsScratch.set(frame.ownerAddress, scratch);
                scratch = [];
              }
              return { eax: 0 };
            } finally {
              // Allocation or bridge-generation failures never hand these buffers to the guest.
              for (const pointer of scratch) this.freeAllocation(pointer);
            }
          }
          case 'InitializeConnection': {
            // conn=null initializes the default connection; this succeeds in the reference 2001 PC environment with TCP/IP.
            // The compatibility layer's default connection is the prospective browser transport; record state after success.
            const connPtr = a[1] ?? 0;
            if (!connPtr) {
              this.dplayConnectionInitialized = true;
              return { eax: 0 }; // DP_OK
            }
            // With connection parameters, a default TCP/IP connection without an address is ready; recognized
            // non-TCP/IP service providers stop at the boundary. Objects not parseable as standard DPLCONNECTION
            // are accepted as game-owned wrappers, as described below.
            const flags = a[2] ?? 0;
            const size = this.readU32(connPtr);
            if (size < 40) {
              this.unimplementedDetail = `InitializeConnection(conn=0x${connPtr.toString(16)} 截断 dwSize=${size}, dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            const connFlags = this.readU32(connPtr + 4);
            const guidSp = formatGuid(this.readBytes(connPtr + 16, 16));
            const address = this.readU32(connPtr + 32);
            const addressSize = this.readU32(connPtr + 36);
            if (guidSp === DPSPGUID_TCPIP && !address) {
              this.dplayConnectionInitialized = true;
              return { eax: 0 }; // DP_OK
            }
            if (SP_NAMES[guidSp] !== undefined) {
              // IPX/serial/modem or addressed TCP/IP connections use unsupported transports; stop at the boundary with details.
              const addrText = !address
                ? '(null)'
                : guidSp === DPSPGUID_TCPIP
                  ? this.readCString(address, Math.min(addressSize || 256, 256))
                  : `0x${address.toString(16)}/${addressSize}`;
              const connFlagText =
                connFlags === 1 ? 'JOIN' : connFlags === 2 ? 'CREATE' : `0x${connFlags.toString(16)}`;
              this.unimplementedDetail = `InitializeConnection(SP=${SP_NAMES[guidSp]}, connFlags=${connFlagText}, addr=${addrText}, dwFlags=0x${flags.toString(16)})`;
              return null;
            }
            // Nonstandard DPLCONNECTION: the game manages connections through its own wrappers, copying and wrapping
            // enumerated connections; even this refers to its object rather than ours. This call succeeds
            // in the reference environment; actual transport selection becomes observable at Open/Connect.
            this.dplayConnectionInitialized = true;
            return { eax: 0 }; // DP_OK
          }
          default:
            return null;
        }
      }
      return null;
    }

    /** DPLAYX.DLL ordinal imports; ord4 = DirectPlayLobbyCreateA per Wine dplayx.spec. */
    protected dispatchDplayx(key: string, _name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'DPLAYX.DLL!ord4': {
          // DirectPlayLobbyCreateA(GUID*, IDirectPlayLobbyA**, IUnknown*, LPVOID, DWORD)
          // Official requirements: lpGUIDDSP/lpData must be NULL and dwDataSize zero; see Wine dplobby.c.
          if (a[0] || a[3] || a[4]) {
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0x8007_0057 }; // DPERR_INVALIDPARAM = E_INVALIDARG
          }
          if (a[2]) {
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0x8004_0110 }; // CLASS_E_NOAGGREGATION
          }
          if (!a[1]) return { eax: 0x8000_4003 }; // E_POINTER
          this.writeU32(a[1], this.createDirectPlayLobby());
          return { eax: 0 }; // DP_OK
        }
        default:
          return null;
      }
    }
  };
}
