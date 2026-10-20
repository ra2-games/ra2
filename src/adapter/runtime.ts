import type { GamePerformanceSample } from '../games/performance';
import { serveRelayPort, relayAddressCandidates, relayRoomFromPath } from 'relay-package/client';
import { createBrowserEmulator } from '../platform/browser/emulator';
import { BrowserEmulatorProbe } from '../platform/browser/emulatorProbe';
import type { VmDiagnosticAction, VmDiagnostics, VmRuntimeInfo } from './vmDiagnostics';
import { AUDIO_DIAGNOSTICS_INTERVAL_MS, DEFAULT_MASTER_VOLUME, WebAudioPcmSink } from './audio';
import { gameVmConfiguration } from '../games/vmConfiguration';
import {
  collectDirectoryOverlays,
  directoryHandleOf,
  directoryScopeOf,
} from '../platform/browser/files/directoryAccess';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { ScopedGameFileProvider } from '../resources/providers/scoped';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { serveFileProvider } from './fileProviderPort';
import { mountCustomMapFiles, prepareDynamicMaps } from './customMapPackage';
import { VmCore, type VmCorePlatform } from './vmCore';
import { WorkerVmClient, type WorkerVmClientOptions } from './vmClient';
import type { GuestMemRecordResult } from './memRecord';
import type { GameFileEntry, VmInitConfig } from './vmProtocol';
import type { VmPointerState, VmShell } from './vmShell';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import { withGameResolutionOverride } from '../games/resolution';
import { randomMultiplayerName, validateMultiplayerName, withMultiplayerNameOverride } from '../games/multiplayerName';
import { parseRa2RelayUrl, type Ra2NetworkConfig } from '../games/ra2/networkTransport';

export type { VmShell } from './vmShell';

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function hashRa2Executable(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持联机所需的 SHA-256');
  const digest = await subtle.digest('SHA-256', bytes.slice() as BufferSource);
  let hash = '';
  for (const byte of new Uint8Array(digest)) hash += byte.toString(16).padStart(2, '0');
  return hash;
}

export async function resolveRa2NetworkConfig(source: GameSource): Promise<Ra2NetworkConfig | undefined> {
  if (!['ra2', 'yr'].includes(source.game.id) || typeof window === 'undefined') return undefined;
  const query = new URLSearchParams(window.location.search);
  if (query.get('network') === '0' || !(query.get('network') === '1' || query.has('relay'))) return undefined;
  // Derive the room only from the URL path to keep page configuration aligned with the server's actual room.
  const relayUrl = parseRa2RelayUrl(query.get('relay'));
  const room = relayUrl ? relayRoomFromPath(new URL(relayAddressCandidates(relayUrl)[0]!).pathname) : 'ra2';
  return { room, exeHash: await hashRa2Executable(source.executableBytes), ...(relayUrl ? { relayUrl } : {}) };
}

/** Identify session sources without enumerating/flattening resource bytes; the port service always preserves the full overlay chain. */
function sessionFilesOf(provider: GameFileProvider): SessionGameFileProvider | null {
  let current: GameFileProvider = provider;
  while (current instanceof ScopedGameFileProvider || current instanceof OverlayGameFileProvider) {
    current = current.parent;
  }
  if (!(current instanceof SessionGameFileProvider)) return null;
  return current;
}

/**
 * Copy each file into an independent buffer and register it for transfer. Session-package files usually view slices of a large decode buffer; direct transfer would detach the entire backing buffer, so copy to an exactly sized buffer first.
 */
function collectTransferEntries(files: ReadonlyMap<string, Uint8Array>, transfer: Transferable[]): GameFileEntry[] {
  return [...files].map(([path, bytes]) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    transfer.push(copy.buffer);
    return { path, bytes: copy };
  });
}

/** Fall back to the main thread only if Worker probing fails; probe before VM initialization to avoid creating two V86 instances. */
export async function createVmShell(
  callbacks: GameVmCallbacks,
  source: GameSource,
  options: WorkerVmClientOptions = {},
): Promise<VmShell> {
  // Carry this explicitly into the Worker; an overlay added only on the page would be lost by the HTTP backend.
  const additionalFiles = source.additionalFiles;
  const mountedSource = additionalFiles ? mountCustomMapFiles(source, additionalFiles) : source;
  const mainThreadSource = source.sessionFiles?.size
    ? {
        ...mountedSource,
        files: new OverlayGameFileProvider(mountedSource.files, source.sessionFiles, ' + session', true),
      }
    : mountedSource;
  const ra2Network = await resolveRa2NetworkConfig(source);
  // Generate the name once at creation and reuse it on Worker-init fallback; future authenticated identities come from options.
  const playerName = validateMultiplayerName(options.playerName ?? randomMultiplayerName());
  // ?vm-worker=0 forces main-thread mode for manual fallback checks and baseline comparisons.
  if (
    typeof Worker === 'undefined' ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('vm-worker') === '0')
  ) {
    return new Win32GameVm(
      callbacks,
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(mainThreadSource, options.resolution),
        playerName,
      ),
      ra2Network,
      options.startupPage,
      {
        mode: 'main-thread',
        reason: typeof Worker === 'undefined' ? 'worker-unavailable' : 'requested',
        workerProbeMs: null,
        fallbackReason: null,
      },
    );
  }
  const handle = directoryHandleOf(source.files);
  const transfer: Transferable[] = [];
  let closeFilePort: (() => void) | undefined;
  let provider: VmInitConfig['provider'];
  if (sessionFilesOf(source.files) || !handle) {
    // Both first imports and restored caches use on-demand reads, preserving unextracted files without copying the entire package at init.
    // Serve the entire selected source, including scopes and overlays, so the Worker uses game-root-relative paths.
    const names = (await source.files.list('')) ?? [];
    const channel = new MessageChannel();
    closeFilePort = serveFileProvider(source.files, channel.port1);
    provider = { kind: 'port', port: channel.port2, names, label: source.files.label };
    transfer.push(channel.port2);
  } else {
    // Directory backend: flatten overlays from innermost to outermost; later layers override earlier ones, matching the Overlay chain.
    const layers = collectDirectoryOverlays(source.files) ?? [];
    const flattened = new Map<string, Uint8Array>();
    for (const layer of layers) for (const [path, bytes] of layer) flattened.set(path, bytes);
    provider = flattened.size
      ? { kind: 'directory', handle, overlays: collectTransferEntries(flattened, transfer) }
      : { kind: 'directory', handle };
  }
  const config: VmInitConfig = {
    provider,
    // The page manifest gate has selected and verified the EXE. Every backend carries the same startup bytes to prevent
    // HTTP overlay loss, parent-first directory lookup, or rediscovery from selecting an old version; disk files stay unchanged.
    selectedExecutable: collectTransferEntries(
      new Map([
        [
          [provider.kind === 'port' ? '' : directoryScopeOf(source.files), source.game.executable]
            .filter(Boolean)
            .join('/'),
          source.executableBytes,
        ],
      ]),
      transfer,
    )[0]!,
    preferredGameId: source.game.id,
    ...(additionalFiles?.size ? { additionalFiles: collectTransferEntries(additionalFiles, transfer) } : {}),
    ...(source.sessionFiles?.size ? { sessionFiles: collectTransferEntries(source.sessionFiles, transfer) } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    playerName,
    startupPage: options.startupPage,
    ...(ra2Network ? { ra2Network } : {}),
    fastFileRead:
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fast-files') !== '0',
    clockRate: 1,
    masterVolume: DEFAULT_MASTER_VOLUME,
    traceCalls: typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1',
  };
  let closeRelayPort: (() => void) | undefined;
  if (ra2Network) {
    const channel = new MessageChannel();
    const stopRelay = serveRelayPort(channel.port1);
    closeRelayPort = () => {
      stopRelay();
      channel.port2.close();
    };
    config.relayPort = channel.port2;
    transfer.push(channel.port2);
  }
  let client: WorkerVmClient;
  const probeStartedAt = performance.now();
  try {
    client = new WorkerVmClient(callbacks, config, {
      ...options,
      initTransfer: transfer.length ? transfer : options.initTransfer,
      onTerminated: () => {
        closeFilePort?.();
        closeRelayPort?.();
        options.onTerminated?.();
      },
    });
  } catch (error) {
    closeFilePort?.();
    closeRelayPort?.();
    throw error;
  }
  try {
    await client.waitProbe();
    return client;
  } catch (error) {
    console.warn('[VM] worker 模式不可用，回退主线程模式：', error);
    const runtimeInfo: VmRuntimeInfo = {
      mode: 'main-thread',
      reason: 'probe-failed',
      workerProbeMs: performance.now() - probeStartedAt,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
    await client.destroy();
    return new Win32GameVm(
      callbacks,
      await withMultiplayerNameOverride(
        await withGameResolutionOverride(mainThreadSource, options.resolution),
        playerName,
      ),
      ra2Network,
      options.startupPage,
      runtimeInfo,
    );
  }
}

/** Main-thread mode: run v86 and the shim directly on the page thread. */
export class Win32GameVm implements VmShell {
  private readonly audio = new WebAudioPcmSink({
    onError: (error) => console.warn('[VM audio]', error),
    diagnosticsIntervalMs: AUDIO_DIAGNOSTICS_INTERVAL_MS,
  });
  private readonly core: VmCore;
  private removeAudioUnlock: (() => void) | null = null;
  private removePagehideFlush: (() => void) | null = null;
  private fileProvider: GameFileProvider;

  constructor(
    callbacks: GameVmCallbacks,
    source: GameSource,
    ra2Network?: Ra2NetworkConfig,
    startupPage?: string,
    readonly runtimeInfo: VmRuntimeInfo = {
      mode: 'main-thread',
      reason: 'default',
      workerProbeMs: null,
      fallbackReason: null,
    },
  ) {
    this.fileProvider = source.files;
    const probe = new BrowserEmulatorProbe();
    const platform: VmCorePlatform = {
      createEmulator: (options) => createBrowserEmulator(options, probe),
      executionProbe: probe,
      ...gameVmConfiguration(source.game, callbacks.onNetworkStatus, ra2Network),
      startupPage,
      fetchBytes,
      scheduleFrame: (emit) => {
        window.requestAnimationFrame(emit);
      },
      packedRgb565Frames: true,
      audio: this.audio,
      // Enable fast guest _lread stubs by default; ?fast-files=0 restores the observable slow path.
      fastFileRead:
        typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fast-files') !== '0',
    };
    this.core = new VmCore(callbacks, source, platform);
  }

  async start(): Promise<void> {
    // A user gesture must unlock the audio context; unload cannot await, so pagehide makes a best-effort save flush.
    this.removeAudioUnlock = this.audio.installUserGestureUnlock(document);
    const flushOnPagehide = () => {
      void this.core.flushFiles();
    };
    window.addEventListener('pagehide', flushOnPagehide);
    this.removePagehideFlush = () => window.removeEventListener('pagehide', flushOnPagehide);
    try {
      await this.core.start();
    } catch (error) {
      this.removePagehideFlush?.();
      this.removePagehideFlush = null;
      this.removeAudioUnlock?.();
      this.removeAudioUnlock = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.core.stop();
  }

  flushFiles(): Promise<void> {
    return this.core.flushFiles();
  }

  async attachMapFiles(files: ReadonlyMap<string, Uint8Array>) {
    const { provider, result } = await prepareDynamicMaps(this.fileProvider, files);
    this.core.setFileProvider(provider);
    this.fileProvider = provider;
    return result;
  }

  postMessage(message: number, wParam = 0, lParam = 0): void {
    this.core.postMessage(message, wParam, lParam);
  }

  setKeyState(virtualKey: number, down: boolean): void {
    this.core.setKeyState(virtualKey, down);
  }

  setCursorPosition(x: number, y: number): void {
    this.core.setCursorPosition(x, y);
  }

  setGameClockRate(rate: number): number {
    return this.core.setGameClockRate(rate);
  }

  /** Master volume: linear gain 0..1 after combining all guest audio. */
  setMasterVolume(linear: number): void {
    this.core.setMasterVolume(linear);
  }

  getGamePerformance(): Promise<GamePerformanceSample | null> {
    return this.core.getGamePerformance();
  }

  gameControl(method: string, params?: unknown): Promise<unknown> {
    return this.core.gameControl(method, params);
  }

  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics> {
    return this.core.getDiagnostics(action);
  }

  async getPointerState(): Promise<VmPointerState | null> {
    return this.core.getPointerState();
  }

  async setGameSpeedFlag(value: number): Promise<number | null> {
    return this.core.setGameSpeedFlag(value);
  }

  async startMemRecord(): Promise<boolean> {
    return this.core.startMemRecord();
  }

  async stopMemRecord(): Promise<GuestMemRecordResult | null> {
    return this.core.stopMemRecord();
  }

  setCallTracing(_enabled: boolean): void {
    // The page already gates main-thread onCall using panelCreated; no cross-thread overhead is involved.
  }

  async destroy(): Promise<void> {
    this.removeAudioUnlock?.();
    this.removeAudioUnlock = null;
    this.removePagehideFlush?.();
    this.removePagehideFlush = null;
    await this.core.destroy();
  }
}
