# Testing guide

Tests are divided into asset-free acceptance and real-game regressions. The former runs in a clean checkout; the latter requires hash-validated game files supplied by maintainers/developers. Missing resources, skips, timeouts, and crashes are never passes.

## Basic acceptance

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
```

`check` includes TypeScript, unit tests, synthetic PE/real v86 instruction tests, architecture checks, and the production build. It explicitly selects tests/basic/ and packages/relay/tests/ without reading local executables or implicitly downloading games. `pnpm test` includes all local cases, real-game regressions among them: a missing executable fails the run instead of skipping, so every developer needs the game resources to run the full suite. No test may remove itself from the report. Asset-free download tests also use Node/TypeScript. package.json and lockfiles define dependency/command versions.

Formatting uses the Prettier version pinned in package.json. `pnpm run format` maintains source, tests, scripts, configuration, and documentation. `.prettierignore` excludes original third-party text, resources, and generated lockfiles. Unsupported languages such as Python/assembly are not checked by Prettier.

All tests prohibit `.only`. After editing boot.asm, run `pnpm run build:boot` and synchronize boot.bin; CI assembles again and checks for differences. This command requires `nasm` outside pnpm dependencies. CI installs it explicitly, using `apt-get install -y nasm` on Ubuntu. If unavailable locally, firmware rebuilding cannot run; this does not justify changing boot.bin or bypassing the `firmware-diff` check. Reference-baseline patches check executable hashes and instruction signatures; adaptive runtime patches instead require unique, cross-checked structural/ABI evidence and matching loaded bytes. Public tests use offline fixtures; real-game regressions rerun the same contracts against original executables. Synthetic fixtures do not replace compatibility validation.

## Test directories

Classify by required resources, not whether filenames contain “game”:

| Directory                                            | Level and resource requirements                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tests/basic/`                                       | Asset-free unit/integration tests, including synthetic game-policy and resource-contract fixtures |
| `tests/basic/architecture/`                          | Module dependency acceptance                                                                      |
| `tests/basic/vm/`                                    | Synthetic PE and real v86 instruction regressions without original executables                    |
| `tests/basic/browser/`, `tests/basic/smoke/`         | Asset-free browser and standalone protocol smoke tests; browsers use Playwright                   |
| `packages/relay/tests/`                              | Relay-owned asset-free tests included in Basic                                                    |
| `tests/real-game/ra2/`, `tests/real-game/yr/`        | VM regressions requiring each game's original executable/resources                                |
| `tests/real-game/browser/`, `tests/real-game/smoke/` | Real-game browser, download, and startup smoke tests                                              |
| `tests/experimental/browser/`                        | External-model experimental regressions excluded from public Basic                                |
| `tests/helpers/`, `tests/fixture/`                   | Shared helpers/synthetic fixtures, not independent test entries                                   |

`pnpm run test:e2e` executes real-game VM files serially. CI additionally orders jobs so YR follows completed RA2 acceptance. Basic includes formatting, `check`, firmware consistency, and asset-free browser regressions; see [CI configuration](REAL_GAME_CI.md) for standalone entry points.

Current asset-enabled CI requires original-executable startup, the RA2 quick-game and RA2/YR save/cold-load regressions, and Worker/main-thread direct battlefield startup. Same-host two-client network tests remain manual and are excluded from CI until Chromium cleanup and runner memory capacity are confirmed. Select other real-game cases according to changes. Gonghui requires separate MOD resources; cache restoration requires original packages. Neither is implicitly covered by Basic.

## Select regressions by change

| Change                               | Additional verification                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and interaction                   | test:browser:react-ui; test:browser:touch-ui for touch                                                                                              |
| Localization                         | i18n unit tests and test:browser:react-ui in English/Chinese, including unsupported-language fallback                                               |
| Drawing/upscaling                    | test:graphics and relevant upscale, ai, gan entries                                                                                                 |
| Providers, archives, caches          | test:custom-maps, test:browser:archive-layers; cache-reload for real packages                                                                       |
| ABI, file shims, patches, scheduling | Corresponding asset-free VM tests and affected games' original-executable regressions                                                               |
| Startup entry points                 | test:browser:startup-page, test:browser:battle-start                                                                                                |
| Generic relay                        | Relay package check, test:browser:relay; two-client network tests for game adaptation                                                               |
| Performance                          | Before/after comparisons with identical browser, map, resources, speed, player count, and load                                                      |
| Performance diagnostics              | test:browser:performance; test:browser:battle-start for both games and execution modes; probe/RPC/cancellation unit tests                           |
| CI downloads                         | tests/basic/ciResourceDownload.test.ts, tests/basic/ciGameArchive.test.ts, tests/basic/gameCiResources.test.ts, tests/basic/ciConfiguration.test.ts |

Fixed-address/instruction evidence lives in game modules and their tests. Never widen architecture allowlists, modify clocks, fabricate acknowledgments, or skip defeat checks to pass tests. Preserve failure reasons; a successful rerun does not erase earlier failures.

Adaptive address regressions are documented in [Adaptive executables](ADAPTIVE_EXECUTABLES.md). `tests/basic/adaptiveRuntime.test.ts` covers moved addresses, compiler register variants, ambiguous evidence, live-image changes, session isolation and allocation failure without game assets. `pnpm exec vitest run tests/real-game/adaptiveExecutables.test.ts --maxWorkers=1` validates every local corpus EXE; `adaptiveBattle.test.ts` additionally requires installation resources and executes native skirmishes. Both discover corpus files recursively under `VM_EXE_CORPUS_DIR` (default `ra2-exe`; for a single installation point it at the game directory, e.g. `VM_EXE_CORPUS_DIR=game/ra2`) and fail on missing resources; neither downloads executables. These manual corpus tests are separate from fixed-baseline CI and browser acceptance.

Read-only counter discovery runs asset-free malformed-PE, moved-address, ambiguity, and cross-reference tests in `tests/basic/peProbe.test.ts` and `tests/basic/gamePerformance.test.ts`. `pnpm exec vitest run tests/real-game/frameCounter.test.ts` checks static discovery against local RA2 1.006/YR 1.001 executables (`VM_GAME_DIR` may select their directory), without downloading resources. Static discovery does not replace live counter advancement in `test:browser:battle-start`.

`tests/basic/shimDplayEnumeration.test.ts` covers nested enumeration storage, out-of-order completion, thread exit, and failed allocation/bridge generation. `tests/basic/vm/dplayEnumeration.e2e.test.ts` executes nested and hardware-preempted callbacks in real v86, including another thread exiting inside its callback. It checks descriptor stability, stack balance, and heap reclamation. `threadRecycle.e2e.test.ts` runs more thread lifetimes than the slot limit and executes x87 instructions after reuse; `displayEnumeration.e2e.test.ts` checks repeated stdcall/cdecl callbacks without growing heap or dynamic code, plus descriptor stability across nested display-mode changes. `tests/basic/guestCodeAllocation.test.ts` also checks variable-size callback scratch boundaries. `tests/basic/shimHeapPressure.test.ts` checks failed object/data/back-buffer allocations and rollback. `tests/basic/shimKernelFileTime.test.ts` checks field independence, invalid dates, leap years, signed capacities, quoted literals, and DBCS trail-byte collisions. All run under `check`; they do not replace original-executable or real multiplayer acceptance.

`pnpm run test:browser:audio` runs asset-free Chromium audio lifecycle acceptance against the configured development origin. It observes timestamped, revision-tagged Worklet messages through repeated playback/release cycles across separate AudioContexts, verifies bounded active-processor counts, and checks context closure. Basic CI includes it. The audio unit regressions cover delayed cursor delivery, stale reports after seeking/changing frequency, quantum-end timestamps, short-stream completion/replay, and distinct output/render cursors. `audioFeedback.test.ts` checks exclusive transfers, held cursors without observations, stale command revisions and buffer reuse; `vmClient.test.ts` checks feedback routing and shutdown cleanup. `tests/basic/vm/soundCursor.e2e.test.ts` executes the generated DirectSound cursor stub in real v86: same-tick polling preserves distinct play/write cursors, while a real PIT interrupt expires the cache even when the call-count budget remains. It also checks that locking from the write cursor does not move playback. This finite lifecycle test does not measure browser heap reclamation or establish full-match audio reliability.

`tests/basic/shimBink.test.ts` checks that unavailable native decoding does not fabricate successful playback and required DLL loading fails explicitly. `tests/basic/vm/guestDllLinking.e2e.test.ts` executes a generated DLL in real v86, checking process attach, original success/failure return values, EDX, stdcall stack balance, and absence of thread pins or host calls. Browser campaign probes observe changing video frames, wait for the original intro to finish naturally, and check DirectSound buffer creation, writes, and release because Bink calls stay inside the guest. Aggregate audio counters do not prove completion of a particular sidebar movie. Cursor-call counts are diagnostic Worker-local queries; the probe budgets total host calls rather than treating each cursor query as frontend RPC. These checks do not establish glitch-free audible output or complete campaign coverage.

## Save and cold-load regression

`pnpm run check` runs the asset-free OLE callback, storage metadata, asynchronous file-open, time conversion, and window-order regressions: `tests/basic/vm/olePersistence.e2e.test.ts`, `tests/basic/shimOleStorage.test.ts`, `tests/basic/vmCore.test.ts`, `tests/basic/shimFile.test.ts`, `tests/basic/shimWindowZOrder.test.ts`, and `tests/basic/shimScrollbarOcclusion.test.ts`. These do not replace the real RA2/YR save/load regressions:

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2/saveLoad.test.ts --maxWorkers=1
VM_GAME_DIR=/path/to/yr pnpm exec vitest run tests/real-game/yr/saveLoad.test.ts --maxWorkers=1
```

On PowerShell, set `$env:VM_GAME_DIR='C:\path\to\ra2'` before running the same `pnpm exec vitest` command. Resources must include an executable supported by the adaptive RA2/YR resolver. The test records its SHA-256 and requires the cold-load VM to use the same executable as the saving VM; simulation state is read through the resolved game hooks. Nothing is downloaded implicitly, and a missing executable fails collection instead of skipping the suite.

The test allows the original startup movie to finish before entering the menu, starts a skirmish through normal menus, waits for simulation to advance, saves and closes the confirmation, flushes writes, and destroys the VM. Startup has a separate movie-length timeout; individual save/load UI operations retain their shorter timeout. Only serialized save bytes are carried into a new file provider and VM, via a temporary file and the production file-provider message port. Loading must restore the saved simulation frame and recreate the persisted native object counts, then advance simulation and accept the pause command. A new empty match, a successful no-op save, or a stalled loading screen is not a pass; observations and counters only assert, and must never seed the new VM or force a successful load. The installation is never modified. Disk-backed range reads load only the requested bytes, avoiding a full MIX read per decoder request; the asset-free `installationFiles.test.ts` covers ranges, EOF, missing files, and empty override precedence. Temporary saves are removed even on failure. The test does not cover browser IndexedDB, campaign transitions, all maps, or long-match state.

The resource-enabled RA2 and YR CI entries run this as a required step after boot tests. `check` verifies that the CI entry still references the regression. PR Basic remains asset-free; the trusted dev/main resource job retains its existing secret boundary. Wiring a test into that job is not evidence that the remote job has run successfully.

The RA2 reference-fixup assertion at `0x69fcbd` reports missing or inconsistent object mappings; it is not by itself evidence of missing installation MIX files.

## Asset-free browser tests

```bash
pnpm run test:browser:install
pnpm run dev
# In another terminal, use the origin printed by dev:
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:react-ui
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:archive-layers
```

Retain Playwright's extraction fix from 1.60.0 onward: older extract-zip can hang after downloading on Node 24.16.0 (Playwright issues 41000/40998; Node.js issue 63487). The lockfile determines browser versions; verify cold installation after upgrades.

Vite dependency prebundling registers JSX, archive Workers, and experimental model entries. New lazy dependencies require cold-cache startup verification; warm caches or reloads must not conceal split React instances. Prebundling does not mean experimental modules load in the browser.

These entries require no game/ resources and guard against obsolete executable download routes. Graphics regressions require working Chromium/WebGL2; missing browser/rendering capability fails instead of degrading into a pass. Synthetic map/archive tests do not establish completeness of real packages. Map-package tests also verify session-save restoration and zero-byte enumeration, deliberately aborting a real IndexedDB transaction after a successful write request to confirm rejection and no residual records.

Existing browser scenarios explicitly use Chinese when checking Chinese UI text. The React smoke test covers both languages at three viewport sizes and English fallback for an unsupported language. Locale-specific unit fixtures preserve existing Chinese assertions; `tests/basic/i18n.test.ts` independently checks selection and translation contracts.

Relay protocol vectors, real sockets, backpressure, rate limits, lifecycle, and standalone builds are part of root acceptance:

```bash
pnpm --filter relay-package run check
pnpm run server:relay --host 127.0.0.1 --port 15176
RELAY_PROBE_GRANT=1 RELAY_PROBE_URL=127.0.0.1:15176 pnpm run test:browser:relay
```

Chromium network regressions explicitly grant local-network-access, covering LAN and loopback. Browser checks cover main-thread/real Worker operation, bidirectional forwarding, and departure cleanup; they do not establish behavior when LNA permission is denied. Container changes additionally require a real Docker build, health check, and browser forwarding; parsing configuration cannot replace image acceptance.

## Real-game regressions

Ordinary local resources, including their original executables, live in game/ra2/. Shared RA2/YR directories should be complete; zero-byte placeholders still count as existing files. Real-game CI imports the same original bundles as the frontend outside the workspace and verifies whole-package hashes; see [CI configuration](REAL_GAME_CI.md).

Regressions must not depend on the developer's own settings. Node smoke routes declare the INI values they rely on through `VmSmokeOptions.ini` (`tests/real-game/helpers/sessionIni.ts`): menu click routes recorded in 1440x900 native coordinates set that resolution, and routes whose deadlines exclude the four-minute first-run YR intro set `[Intro] Play=no`. The overlay applies only to the bytes the guest opens in that session; installations are never modified, and save/load or boot tests that deliberately allow the intro keep the installed settings. Browser real-game entries still read RA2.INI/RA2MD.INI from the development resource service: with an installation that keeps `[Intro] Play=yes` (for example a Steam copy), `test:browser:yr` and the YR `test:browser:startup-page` modes spend their deadlines in the intro. Experimental version-bound probes accept either their reference executable hash or a unique full instruction signature at the expected site, so byte-identical code in other distributions is covered without trusting the address alone.

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2 --exclude '**/gonghui.test.ts'
VM_GAME_DIR=/path/to/yr pnpm run test:vm:yr
pnpm run test:browser:battle-start
pnpm run test:browser:network
pnpm run test:browser:network:yr
```

`VM_GAME_DIR` selects resources for Node real-executable tests; browsers receive files from the development resource service. Real-game suites fail when the required executable is absent instead of skipping, with no opt-out switch: `test:e2e`, `test:vm`, `test:vm:ra2`, `test:vm:yr`, and the full `pnpm test` all behave the same, so every developer needs the game resources locally. Assertions must still verify completeness and behavior. Gonghui is an opt-in third-party MOD: it runs only with VM_GONGHUI=1 and fails if expand01.mix is missing; original-game startup cannot replace it. Never mix addresses/resources from different executables.

Two-client tests use native UI for discovery, room creation/joining, map validation, match startup, and deployment commands, reading player/unit state on both clients to confirm synchronization. WS handshakes or lobby screenshots cannot replace actual game operations. Before Linux multi-VM startup, check memory and record OOM state. Logs include host total/available memory and process names/RSS on preflight failure. Renderer crashes fail immediately; diagnostic sampling has timeouts so unavailable screenshots cannot hang the test. Other processes can still contend for a shared host; preflight does not guarantee resource isolation throughout the run.

## Resource import and restoration

```bash
RA2_BROWSER_ZIP=/path/to/game.zip pnpm run test:browser:cache-reload
```

Verify initial selection, actual cache-transaction commit, and the restored game version after refresh. RA2_BROWSER_GAME=yr selects YR; RA2_BROWSER_MAIN_THREAD=1 checks fallback. Cover missing, zero-byte, failed reads, and unknown separately; filtering zero-byte files before declaring restoration successful is invalid.

Incognito storage quota may be smaller than the package. Explicitly set RA2_BROWSER_STORAGE_QUOTA_BYTES=2147483648 to test restoration with sufficient quota, recording that the override took effect. Passing with an override is not a default-environment pass. RA2_BROWSER_FULL_ARCHIVE=1 compares full extraction, but an old-path pass does not establish layered-loading acceptance.

## Multiplayer performance and faults

```bash
RA2_BROWSER_RELAY=ws://127.0.0.1:15176/ra2 RA2_BROWSER_RELAY_DELAY_MS=25 RA2_BROWSER_STABILITY_SECONDS=60 pnpm run test:browser:network
```

The proxy adds 25 ms each direction, or 50 ms RTT per client. This is additional, not final RTT, and differs from relay --delay-ms. Each second the script outputs actual simulation frames, RequestedFPS, windows, and connection state, then sends new commands after observation. RA2_BROWSER_STABILITY_SECONDS supports 10–600 seconds; RA2_BROWSER_PLAYERS supports 2–8. Multiplayer requires sufficient host resources; 8 connections do not establish a complete 8-player match.

tests/basic/vm/lanStartupTiming.e2e.test.ts checks LAN startup-stub settings, registers, flags, stack, and repeated calls. Real two-client checks read initial targets from timing-transitions.json and actual advancement from performance-timeline.json; these are different evidence. See [Game performance](GAME_PERFORMANCE.md) for native command tracing, baseline replacement, and measurement definitions, and [Network reliability](RA2_NETWORK_RELIABILITY.md) for faults/disconnection boundaries.

## CI and delivery evidence

CI is centralized in .github/workflows/quality-check.yml. Basic test combines formatting and all asset-free acceptance; dev/main then run RA2/YR real-game jobs serially. PRs run Basic only. Configure runners, secrets, packages, and isolation according to [CI configuration](REAL_GAME_CI.md); YAML existence does not establish activation.

PRs should report actual commands, versions, results, and unverified scope. Preserve same-scene performance comparisons and identify maps, speeds, and player counts for game tests. Two-player short matches cannot establish reliability for public networks, long matches, mixed-unit combat, or full campaigns.

Bundle import and restoration regressions require the executable in the same cached file set. `test:browser:cache-reload` uses a temporary disk-backed browser profile (removed on exit) and checks that neither import nor refresh downloads an EXE; optional `RA2_BROWSER_EXE_SHA256` asserts the supplied executable remains unchanged. Old resource-only caches must reopen the picker.
