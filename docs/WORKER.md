# VM Worker maintenance

## Current implementation

- `src/adapter/runtime.ts` provides the VM creation entry point and main-thread implementation.
- `src/adapter/vmClient.ts` manages the main-thread Worker client; `vmWorker.ts` is the Worker entry point, and `vmWorkerController.ts` owns its lifecycle and message handling.
- `src/adapter/vmCore.ts` runs the guest; `vmProtocol.ts` defines the cross-thread protocol.
- The main thread retains the web UI, presentation, and browser audio while the Worker executes the VM. Startup code determines capability detection and main-thread fallback; browser names must not become hardcoded support guarantees.
- `VmShell.runtimeInfo` records the selected execution mode and probe/fallback evidence. The on-demand `diagnostics` RPC carries start/sample/stop actions through the existing request lifecycle; the shared core reads native counters and the injected platform execution probe. See [Performance reports](GAME_PERFORMANCE.md#browser-comparison-reports).
- File providers are not cloned directly into the Worker. Session resources are accessed on demand through file ports. The executable must be an independent copy of the exact version selected by the page, with no fallback to a different local version.
- `src/app/session/` owns sessions; `src/graphics/` owns presentation scheduling. Do not duplicate the session controller in the Worker layer.

## Audio feedback

`audioProxy.ts` owns Worker command state; `audioFeedback.ts` samples the main-thread sink every 10 ms and batches changed playback observations. The proxy holds the latest observed play/write cursors instead of advancing them from wall time. Command revisions reject feedback predating a seek, stop, or reused buffer ID. PCM transfers use exclusive copies and retain their accepted byte count before detachment.

The client owns the feedback timer and clears it on sink destruction, fatal failure, or session shutdown. Audio commands arriving during shutdown cannot restart observation. Polling and message delivery can be delayed by browser scheduling; this is asynchronous feedback, not a synchronous hardware cursor or a zero-latency guarantee. Headless sinks without observations retain the explicit monotonic fallback.

## Maintenance and verification

Protocol changes must update both endpoints, cancellation/destruction, and rejection of pending requests. Fallback must not leave an old Worker behind or run two VMs simultaneously. Transfer frames only through independent buffers; never transfer guest WASM memory.

Run `pnpm run check` and add browser and real-game checks according to [Testing](TESTING.md). `pnpm run test:browser:battle-start` covers direct battlefield startup for RA2/YR in Worker and main-thread modes. File changes also require map import, layered-resource, and real ZIP cache-reload checks. Passing startup regressions does not establish complete browser capability coverage, save restoration, or full-match correctness.

[ARCHITECTURE.md](ARCHITECTURE.md) is the architecture entry point. This guide records Worker implementation, fallback boundaries, and verification entry points.
