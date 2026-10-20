import type { GamePerformanceSample } from '../games/performance';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';
import type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';
import type { VmFrame, Win32Call, VmNetworkStatus } from '../vm86/win32';
import type { SupportedGameId } from '../games/catalog';
import type { GuestMemRecordResult } from './memRecord';
import type { VmAttachResult, VmPointerState } from './vmShell';
import type { VmCallBatch, VmPhase } from '../app/session/runtimeEvents';
import type { GameResolution } from '../games/resolution';
import type { Ra2NetworkConfig } from '../games/ra2/networkTransport';

/** Main-thread/Worker message protocol. Array fields (PCM/frames/EXE) transfer ownership; a single FIFO channel preserves order. */

/**
 * Game files sent to the Worker with init (session packages/overlays). Buffers transfer with the message; the main thread already made independent copies, so transfer cannot affect the page's provider.
 */
export interface GameFileEntry {
  path: string;
  bytes: Uint8Array;
}

export interface VmInitConfig {
  startupPage?: string;
  /**
   * File backend: directory handles (transferred/cloned), session-package memory files (online ZIP extraction results transferred with the message), or an on-demand file port.
   * Provider instances cannot be structured-cloned; rebuild and rediscover in the Worker, also rebuilding the game's sourceTransform. Directory overlays contain online-package layers above the directory, innermost first with later layers overriding earlier ones, matching the page's Overlay-chain precedence.
   */
  provider:
    | { kind: 'directory'; handle: FileSystemDirectoryHandle; overlays?: GameFileEntry[] }
    | { kind: 'memory'; files: GameFileEntry[]; label: string }
    /** Two-stage loading: send the complete directory first, then read bytes through the port on demand; unextracted files wait for their producer. */
    | { kind: 'port'; port: MessagePort; names: string[]; label: string };
  /** Selected game in a multi-game directory; the Worker uses this after rediscovery. */
  preferredGameId: SupportedGameId;
  /**
   * The EXE actually selected by the page, relative to the underlying provider root. Overlay before Worker discovery so it cannot reread an old same-named executable from the development/authorized directory. The buffer is an independent transfer copy.
   */
  selectedExecutable?: GameFileEntry;
  /** Custom map/text packages take precedence over the base game, regardless of directory, memory, or port backends. */
  additionalFiles?: GameFileEntry[];
  /** Explicit game launch choices; buffers are independent transfer copies. */
  sessionFiles?: GameFileEntry[];
  /** Startup resolution applied only in the memory-provider overlay after reading the original INI; never write to the user's directory. */
  resolution?: GameResolution;
  /** Overlay the INI after rebuilding the Worker provider; development HTTP mode must retain the player name too. */
  playerName?: string;
  /** Room and EXE SHA-256 for explicitly enabled RA2 networking; omitted means single-player. */
  ra2Network?: Ra2NetworkConfig;
  /** The page owns the WS connection; the Worker sends and receives through a port transferred with init. */
  relayPort?: MessagePort;
  fastFileRead: boolean;
  clockRate: number;
  masterVolume: number;
  /** F2/?debug call hotspots; when disabled, the Worker only increments an integer per HC. */
  traceCalls: boolean;
}

export type MainToWorkerMessage =
  | { type: 'game-control'; method: string; params?: unknown; requestId: number }
  | { type: 'diagnostics'; action: VmDiagnosticAction; requestId: number }
  | { type: 'game-performance'; requestId: number }
  | { type: 'attach-maps'; files: GameFileEntry[]; requestId: number }
  | { type: 'init'; config: VmInitConfig; requestId: number }
  | { type: 'wm'; m: number; w: number; l: number }
  | { type: 'key'; vk: number; down: boolean }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'audio-state'; states: AudioStateReport[] }
  | { type: 'clock'; rate: number }
  | { type: 'volume'; linear: number }
  | { type: 'call-tracing'; enabled: boolean }
  | { type: 'state'; kind: 'pointer'; requestId: number }
  | { type: 'guest-speed-flag'; value: number; requestId: number }
  | { type: 'mem-record-start'; requestId: number }
  | { type: 'mem-record-stop'; requestId: number }
  /** The main thread consumed this frame at a display-refresh boundary; the Worker may release the next frame. */
  | { type: 'frame-ack'; frameId: number }
  /** Previous frame no longer referenced by the page; separate from ACK because the current frame is still needed for cursor redraws. */
  | { type: 'recycle-frame'; buffer: ArrayBuffer }
  | { type: 'flush'; requestId: number }
  | { type: 'control'; action: 'start'; requestId: number }
  | { type: 'control'; action: 'stop'; requestId: number };

export type WorkerToMainMessage =
  | { type: 'game-control-reply'; value: unknown; requestId: number }
  | { type: 'diagnostics-reply'; requestId: number; value: VmDiagnostics }
  | { type: 'game-performance-reply'; requestId: number; value: GamePerformanceSample | null }
  | { type: 'network-status'; status: VmNetworkStatus }
  | { type: 'attach-maps-done'; result: VmAttachResult; requestId: number }
  | { type: 'probe'; ready: true }
  | { type: 'status'; phase: VmPhase; detail: string }
  | { type: 'shell-page'; title: string }
  | { type: 'call-batch'; batch: VmCallBatch }
  | { type: 'blocked'; call: Win32Call }
  | { type: 'frame'; frameId: number; frame: VmFrame }
  | {
      type: 'state-reply';
      requestId: number;
      kind: 'pointer';
      value: VmPointerState | null;
    }
  | { type: 'guest-speed-flag-reply'; requestId: number; value: number | null }
  | { type: 'mem-record-start-reply'; requestId: number; ok: boolean }
  | { type: 'mem-record-stop-reply'; requestId: number; result: GuestMemRecordResult | null }
  | { type: 'audio'; op: AudioOp; revision?: number }
  | { type: 'audio-control'; action: 'master-volume'; linear: number }
  | { type: 'audio-control'; action: 'stop-all' }
  | { type: 'audio-control'; action: 'destroy' }
  | { type: 'init-done'; requestId: number }
  | { type: 'flush-done'; requestId: number }
  | { type: 'control-done'; action: 'start' | 'stop'; requestId: number }
  | { type: 'error'; message: string; requestId?: number };

/** Output-clock observations tagged with the command revision that produced them. */
export interface AudioStateReport {
  id: number;
  revision: number;
  positionBytes: number;
  writePositionBytes: number;
  playing: boolean;
}

/** Commands preserve FIFO order; cursor feedback never requires synchronous Worker RPC. */
export type AudioOp =
  | { op: 'createBuffer'; id: number; byteLength: number; format: PcmWaveFormat }
  | { op: 'duplicateBuffer'; sourceId: number; destinationId: number }
  | { op: 'setFormat'; id: number; format: PcmWaveFormat }
  | { op: 'writeBuffer'; id: number; offset: number; bytes: Uint8Array }
  | { op: 'play'; id: number; options?: PcmPlayOptions }
  | { op: 'stop'; id: number }
  | { op: 'setCurrentPosition'; id: number; byteOffset: number }
  | { op: 'setVolume'; id: number; volume: number }
  | { op: 'setPan'; id: number; pan: number }
  | { op: 'setFrequency'; id: number; frequency: number }
  | { op: 'releaseBuffer'; id: number };

let nextRequestId = 1;
/** Monotonically increasing requestId, unique within a session; independent counters on each thread do not affect correlation. */
export function createRequestId(): number {
  return nextRequestId++;
}
