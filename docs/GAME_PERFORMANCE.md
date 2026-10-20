# Native game FPS and end-to-end performance measurement

GameRuntimeHooks.createFrameReader exposes read-only native simulation counters. VmShell.getGamePerformance() returns a Promise in both main-thread and Worker modes. Workers sample on the guest's thread and attach host performance.now(), excluding RPC round-trip time from the sampling interval. Without a sampling request, no timers or per-frame cross-thread messages are created, no jumps are injected, and the game clock is unchanged.

## Metrics

- frame is the cumulative native simulation-frame count; logicFps is the frame delta divided by actual host elapsed time.
- sampledAtMs and intervalMs represent the sampling host's monotonic timestamp and actual interval. Different Workers may have different time origins; compute each player's values independently.
- requestedFps is a native LAN negotiation variable. In single-player or before negotiation it may be only an initial value, not measured FPS or a single-player cap. gameSpeed and sessionSpeed are native speed settings.
- status is baseline for the first reading, sample for normal readings, reset for counter rollback or invalid time, and inactive in menus or when stopped. FPS is null outside sample status; a running simulation with no advancement reports 0.
- Missing or ambiguous structural evidence, conflicting references, signature mismatch, short reads, and unloaded/destroyed VMs return null and cannot count as passes. A different executable hash alone does not disable this reader.

Existing DirectDraw boundary counts, frame-upload FPS, and browser rAF retain their own meanings. They do not replace native simulation FPS. This probe does not record a completion timestamp for every guest simulation frame.

## Browser comparison reports

In a running match, expand the toolbar and choose **Performance diagnostics… → Record for 20 seconds**.
The dialog closes while recording so normal play can continue. Keep the page in the foreground; when the report opens,
choose **Copy report**. If clipboard access fails, select and copy the read-only report text. **Stop recording** preserves
a cancelled report; leaving the session cancels sampling and releases the display observer. Nothing is uploaded automatically.

Compare Safari and Chrome on the same phone with the same game, map, units, game speed, clock multiplier, resolution,
and graphics settings. Each browser retains its own settings and resource caches. Record whether this is the first
import, a reload, or a warmed match. Browser viewport emulation on a desktop is not an iOS performance measurement.

Reports contain actual Worker/main-thread mode, Worker probe duration and fallback reason, browser identity,
rendering backend, logical frame/canvas/viewport dimensions, DPR, clock and graphics settings, native simulation samples,
hypercalls, submitted/presented frames, rAF intervals, page visibility, and main-thread long tasks when supported.
No game files, saves, player names, or page URL are collected. A missing native reader or unavailable browser metric
remains null; an unsupported scheduler has supported=false. Errors and partial reports remain explicit.

During recording, the browser platform temporarily wraps the existing v86 yield/callback and CPU loop methods.
It measures zero-delay scheduling waits, positive-delay overshoot, and CPU slice wall time without changing ticks,
requested waits, guest clocks, or game settings. Superseded callbacks are counted separately. Original methods are
restored on stop/destruction, with a 30-second watchdog for a lost client. Outside captures there are no probe wrappers,
rAF loops, or per-second diagnostic RPCs. Captures add measurement overhead; CPU slice time is not whole-Worker or
whole-device CPU usage, and JIT enabled/cache size alone does not establish compilation throughput.

Timing aggregates are cumulative within a capture. VM samples use the execution thread's monotonic clock;
requestMs includes RPC transport and probe work, so it is not pure message latency. Native FPS is weighted by its
actual sample intervals, independently from display rates. presentedFps includes cursor-triggered redraws.
Visibility changes, native resets, incomplete captures, and changed settings require care when comparing reports.

Asset-free instrumentation/UI checks: `pnpm run test:browser:performance` with `RA2_BROWSER_ORIGIN` pointing at the
development server. A small synthetic BIOS checks the real v86 scheduler and method restoration in main-thread and
Worker modes; synthetic UI reports check cancellation and copying. Real-game startup and diagnostics use
`pnpm run test:browser:battle-start`. These checks do not establish iOS performance; the phone reports provide that evidence.

## Automatic detection and evidence

The factory receives guest memory and the original executable bytes. On the first explicit sample, `src/vm86/peProbe.ts` checks PE32/i386 section bounds and scans initialized, readable, nonwritable executable sections. It rejects overlapping/truncated sections. It uses the same preferred image base as the PE loader; this is not a relocation or unpacking implementation. Discovery results, including unavailable results, are cached for that VM and discarded on destruction.

Game policy in `src/games/shared/frameCounter.ts` resolves instruction operands instead of looking up addresses by whole-file SHA-256. Every required signature must have one unique qualifying match. It checks:

- The frame read/increment/write sequence, repeated counter and stop-frame references, branches, and call targets.
- The session-to-global speed copy against a separate settings initializer. RA2 and YR supply their own initializer signatures in their respective `performance.ts` modules, so selecting one game does not silently enable the other's layout.
- RequestedFPS against both a debug-format call referencing the UTF-16 `Req fps : %d` label and the native pacing branch that divides 60 by this variable. Stack-local displacements may differ, but both branches must reference the same local. Other labels using the same formatter do not count as matches.
- Distinct, aligned counters inside writable, nonexecutable data sections, and all matched instructions/labels against the loaded guest image before publishing a reader.

The following instruction locations document the reference layouts, not required runtime addresses:

Reference instruction evidence covers RA2 and YR independently; the detector does not compare executable hashes.

| Evidence                                   | RA2 1.006                            | YR 1.001                             |
| ------------------------------------------ | ------------------------------------ | ------------------------------------ |
| Frame loop / counter                       | `0x540676` / `0xa40d2c`              | `0x55de73` / `0xa8ed84`              |
| Speed copy / GameSpeed / Session.GameSpeed | `0x598131` / `0xa40b18` / `0xa3d2c8` | `0x5b6ad1` / `0xa8eb60` / `0xa8b268` |
| Settings initializer / source offset       | `0x512db5` / `EAX+0x1108`            | `0x52d177` / `EAX+0x14a0`            |
| RequestedFPS display / pacing / variable   | `0x541c72` / `0x53fd01` / `0xa3d568` | `0x55f472` / `0x55d491` / `0xa8b558` |

This recognizes compatible instruction/layout families even when file metadata or code/data addresses differ. Recompiled, packed, localized, or modified code may lack the evidence and remain unavailable. Detection is structural evidence for these four read-only counters, not proof of arbitrary executable compatibility, native object layouts, or safe command injection. All four fields must validate; there is no fixed-address fallback. Counter discovery alone does not authorize writes. Separate [adaptive runtime capabilities](ADAPTIVE_EXECUTABLES.md) validate startup hooks, speed writes and compatibility patches. Resource selection and download integrity checks remain unchanged. See [Network reliability](RA2_NETWORK_RELIABILITY.md) for LAN timing version binding and limitations.

Asset-free regressions in `tests/basic/gamePerformance.test.ts` and `tests/basic/peProbe.test.ts` cover moved addresses, changed metadata, wrong-game selection, ambiguous matches, conflicting references, section bounds, changed live instructions, and short/failed reads. `tests/real-game/frameCounter.test.ts` checks static discovery against locally supplied RA2 1.006/YR 1.001 layouts without downloading or executing games. Use the browser battle-start regression below to establish live frame advancement separately.

## Multiplayer performance tests

Prepare the services and real game resources, then run:

```bash
RA2_BROWSER_RELAY=ws://127.0.0.1:15176/ra2 RA2_BROWSER_RELAY_DELAY_MS=25 RA2_BROWSER_STABILITY_SECONDS=60 RA2_BROWSER_PERF_WARMUP_SECONDS=30 pnpm run test:browser:network
```

The proxy adds 25 ms in each direction, adding about 50 ms RTT from each player to the relay. This differs from the server's --delay-ms delay per forwarded packet. Select YR with RA2_BROWSER_GAME=yr. The test clicks the development-test entry; the player interface always starts with resource selection. The relay URL path identifies the room.

The test prints [game-perf] and writes performance-timeline.json every second, then outputs performance.json at completion. overall and warmed contain logicFps weighted by actual elapsed time, window-FPS P05/P50/P95, window and anomaly counts, and the maximum observed stall accumulated from complete zero-progress windows. Window percentiles are not per-frame latency percentiles and cannot expose every stall within a second. The final instantaneous status check is excluded from the distribution to avoid millisecond samples distorting percentiles. Warmup defaults to 30 seconds; warmed is null if there is insufficient time.

RA2_BROWSER_MIN_LOGIC_FPS explicitly sets a minimum warmed, time-weighted average. No valid windows, an unknown probe, counter reset, or a result below the threshold fails the test. There is no default hardcoded 60 FPS requirement: speed settings have different targets, and the probe does not change speed.

## Single-player and verification scope

After direct battlefield startup in RA2/YR main-thread and Worker modes, pnpm run test:browser:battle-start samples another 5 seconds and outputs _-native-perf-_.json for each game/mode. RA2_BROWSER_SCREENSHOT_DIR selects the output directory. Assertions require valid advancing counters without a fixed FPS target. RA2_BROWSER_GAME and VM_BROWSER_MODE select one scenario to avoid competing for host resources.

Comparisons must keep the map, unit count, operation sequence, resolution, game speed, VM mode, and host load constant, retain RTT distributions and failure records, and repeat multiple times. Single-player startup, two-player short matches, and synthetic-memory tests cannot establish multiplayer/public-network long-match stability or absence of low-RTT regressions.

Set RA2_BROWSER_START_PAGE=lan to test complete room creation and match startup after entering the native LAN lobby directly. RA2_BROWSER_TIMING_BASELINE_REF selects a code baseline for same-scenario A/B comparisons: only that revision's two networkTiming.ts files are compiled and loaded as browser modules; executables and resources are unchanged. Without it, tests use the current implementation. test-config.json records the actual baseline, entry point, delay, and observation duration. Baseline code must also pass native patch-signature checks.

timing-transitions.json records changes in native RequestedFPS/MaxAhead from the first observed playable battlefield, with native frame numbers and each Worker's own timestamp. This is a first-observation boundary, not an instruction-exact event time. It prevents analysis from overlooking the initial low-FPS phase by considering only windows after MCV deployment.

### Native command-queue observation

`RA2_BROWSER_TRACE_COMMANDS=1` enables a read-only queue probe during the deployment-command phase of real multiplayer tests and writes `command-latency.json`. It is off by default; normal operation neither imports the probe nor polls game queues. RA2/YR modules independently validate the loaded enqueue/dequeue instructions. The generic reader only interprets queue layout. Evidence comes from YRpp's `EventClass.h` and `QueueClass.h`, checked against both original executables.

The probe records the local outgoing DEPLOY event and both scheduled execution markers, correlating by House, target ID, and target type, and asserting identical scheduled execution frames on both clients. It independently still requires both MCVs to disappear and players to remain alive. outgoing.frame initially holds the enqueue frame; native send scheduling rewrites it in place to the scheduled execution frame. scheduled.frame is the planned execution frame, so the first outgoing snapshot must not be forced equal to it. executed means native event handling completed, not that deployment animation finished.

`observedMs` starts when the test dispatches the keyboard event. It includes polling, Worker RPC, and waiting on both clients, and is only an upper bound on first observation. `observedFrame` / `sampledAtMs` are that client's simulation frame and host sampling time; do not subtract timestamps across Workers. The probe reads the latest 128 ring slots, including dequeued history not yet overwritten. Backlog or overwrite may cause missed observations; missing data means insufficient evidence for that run, not proof the event was never sent. This mode adds diagnostic overhead and must not share a performance comparison group with probe-disabled runs.

### Slow match startup and cold starts

Original multiplayer RequestedFPS starts at 30. Current LAN startup initializes it from the room's Session.GameSpeed: 0 means 60 Hz, 1 means 45 Hz, and 2–6 use integer 60 / setting. Invalid settings conservatively fall back to 30 Hz. Settings are reread for each match; subsequent actual reports, slowdown, and windows remain native. See [LAN startup target](RA2_NETWORK_RELIABILITY.md#lan-startup-target) for version/instruction evidence and limits. Single-player does not enable this multiplayer patch, so the same conclusion does not apply.

Resource opening, directory enumeration, or sparse-file paging can make the guest wait for providers. First execution of battlefield code also triggers v86 JIT compilation. Initial ZIP/7z imports continue extracting and writing caches; this differs from HTTP development loading and lazy restoration after refresh. Comparisons must identify resource sources and separately measure first import, refresh restoration, and battlefield reentry in the same VM. The third warms both resources and JIT; acceleration alone cannot distinguish them. Existing HC/s and instruction counters measure throughput without file-wait duration and cannot establish an IO or JIT bottleneck.

Queue `flags` preserve the entire byte at event +1; `executed` interprets only bit 0. Do not require the byte to equal 0 or 1: RA2's send path `0x626330` and YR's `0x649E30` read +1 and clear only the execution bit with `AND 0xFE`; YR's execution path `0x64CAC7` sets it with `OR 1`. YR's target-event constructor `0x4C65E0` does not initialize +1, so the upper seven bits may retain stack contents. RA2 `0x62631B` and YR `0x649E1B` copy the House byte unchanged from local House+0x30. There is no evidence of a local 0x80 flag, so House is not masked.

These conclusions come from independent instruction analysis of the two supported executables. YRpp's EventClass.h declares the execution field as bool, which does not establish how the original executables handle the whole byte.
