# Testing guide

Tests are divided into asset-free acceptance and real-game regressions. The former runs in a clean checkout; the latter requires hash-validated game files supplied by maintainers/developers. Missing resources, skips, timeouts, and crashes are never passes.

## Basic acceptance

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
```

`check` includes TypeScript, unit tests, synthetic PE/real v86 instruction tests, architecture checks, and the production build. It explicitly selects tests/basic/ and packages/relay/tests/ without reading local executables or implicitly downloading games. `pnpm test` includes all local cases, real-game regressions among them: a missing executable fails the run instead of skipping, so every developer needs the game resources to run the full suite. No test may remove itself from the report. Asset-free download tests also use Node/TypeScript. package.json and lockfiles define dependency/command versions.

Formatting uses the Biome version pinned in package.json. `pnpm run format` writes supported source, test, script, and configuration files; `pnpm run format:check` verifies them without writing. `biome.json` preserves two-space indentation, single JavaScript quotes, a 120-character line width, and LF endings. `.gitattributes` keeps formatted file endings consistent on Windows and CI. Git-ignored files, public resources, vendor code, copied skill originals, licenses, and generated lockfiles are excluded. Markdown, YAML, Python, assembly, and shell scripts are maintained manually because they are outside the configured formatter's supported languages. HTML formatting is explicitly enabled. Lint and import assists are disabled so formatting does not change the existing behavioral checks.

All tests prohibit `.only`. After editing boot.asm, run `pnpm run build:boot` and synchronize boot.bin; CI assembles again and checks for differences. This command requires `nasm` outside pnpm dependencies. CI installs it explicitly, using `apt-get install -y nasm` on Ubuntu. If unavailable locally, firmware rebuilding cannot run; this does not justify changing boot.bin or bypassing the `firmware-diff` check. Reference-baseline patches check target instruction signatures; adaptive runtime patches instead require unique, cross-checked structural/ABI evidence and matching loaded bytes. Public tests use offline fixtures; real-game regressions rerun the same contracts against original executables. Synthetic fixtures do not replace compatibility validation.

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

| Change                               | Additional verification                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and interaction                   | test:browser:react-ui; test:browser:touch-ui for touch                                                                                                                           |
| Localization                         | i18n unit tests and test:browser:react-ui in English/Chinese, including unsupported-language fallback                                                                            |
| Drawing/upscaling                    | test:graphics and relevant upscale, ai, gan entries                                                                                                                              |
| Providers, archives, caches          | test:custom-maps, test:browser:archive-layers; cache-reload for real packages                                                                                                    |
| ABI, file shims, patches, scheduling | Corresponding asset-free VM tests and affected games' original-executable regressions                                                                                            |
| Startup entry points                 | test:browser:startup-page, test:browser:battle-start                                                                                                                             |
| Generic relay                        | Relay package check, test:browser:relay; two-client network tests for game adaptation                                                                                            |
| Performance                          | Before/after comparisons with identical browser, map, resources, speed, player count, and load                                                                                   |
| Performance diagnostics              | test:browser:performance; test:browser:battle-start for both games and execution modes; probe/RPC/cancellation unit tests                                                        |
| Operation monitoring                 | Error-only uploads, bounded local fixed-button context, redaction and lifecycle; tests/basic/operationMonitoring.test.ts, tests/basic/gameInput.test.ts, test:browser:monitoring |
| CI downloads                         | tests/basic/ciResourceDownload.test.ts, tests/basic/ciGameArchive.test.ts, tests/basic/gameCiResources.test.ts, tests/basic/ciConfiguration.test.ts                              |

Fixed-address/instruction evidence lives in game modules and their tests. Never widen architecture allowlists, modify clocks, fabricate acknowledgments, or skip defeat checks to pass tests. Preserve failure reasons; a successful rerun does not erase earlier failures.

`ciResourceDownload.test.ts` uses loopback HTTP fixtures to check stalled headers,
stalled/truncated bodies, transient HTTP errors, retry exhaustion and the total
download deadline. Short test-only timing budgets exercise cancellation and
cleanup without waiting for production deadlines. Hash mismatches and permanent
HTTP errors must fail without retry; recovery must publish only a complete,
hash-verified archive and never print request secrets. These fixtures do not
establish availability of the private resource host.

Adaptive address regressions are documented in [Adaptive executables](ADAPTIVE_EXECUTABLES.md). `tests/basic/adaptiveRuntime.test.ts` covers moved addresses, compiler register variants, ambiguous evidence, live-image changes, session isolation and allocation failure without game assets. `pnpm exec vitest run tests/real-game/adaptiveExecutables.test.ts --maxWorkers=1` validates every local corpus EXE; `adaptiveBattle.test.ts` additionally requires installation resources and executes native skirmishes. Both discover corpus files recursively under `VM_EXE_CORPUS_DIR` (required; for a single installation point it at the game directory, e.g. `VM_EXE_CORPUS_DIR=game/ra2`) and fail on missing resources; neither downloads executables. These manual corpus tests are separate from fixed-baseline CI and browser acceptance.

Read-only counter discovery runs asset-free malformed-PE, moved-address, ambiguity, and cross-reference tests in `tests/basic/peProbe.test.ts` and `tests/basic/gamePerformance.test.ts`. `pnpm exec vitest run tests/real-game/frameCounter.test.ts` checks static discovery against local RA2 1.006/YR 1.001 executables (`VM_GAME_DIR` may select their directory), without downloading resources. Static discovery does not replace live counter advancement in `test:browser:battle-start`.

`pnpm run test:browser:monitoring` owns a temporary Vite server and overrides the browser monitoring token and receiver. It does not require `RA2_BROWSER_ORIGIN` or monitoring environment variables. Analytics requests are intercepted in Playwright, and game-program downloads and unexpected external requests are blocked before navigation.

The monitoring browser test also checks the configured QRHub SVG image URL and intercepts that exact endpoint with a local SVG fixture. The React UI browser test intercepts the same endpoint to check image failure feedback, close-button focus restoration, successful retry after reopening, and Esc dismissal without fetching a live group invitation. These fixtures validate browser behavior, not live QRHub availability or the invitation encoded by the service.

`tests/basic/shimDplayEnumeration.test.ts` covers nested enumeration storage, out-of-order completion, thread exit, and failed allocation/bridge generation. `tests/basic/vm/dplayEnumeration.e2e.test.ts` executes nested and hardware-preempted callbacks in real v86, including another thread exiting inside its callback. It checks descriptor stability, stack balance, and heap reclamation. `threadRecycle.e2e.test.ts` runs more thread lifetimes than the slot limit and executes x87 instructions after reuse; `displayEnumeration.e2e.test.ts` checks repeated stdcall/cdecl callbacks without growing heap or dynamic code, plus descriptor stability across nested display-mode changes. `tests/basic/guestCodeAllocation.test.ts` also checks variable-size callback scratch boundaries. `tests/basic/shimHeapPressure.test.ts` checks failed object/data/back-buffer allocations and rollback. `tests/basic/shimKernelFileTime.test.ts` checks field independence, invalid dates, leap years, signed capacities, quoted literals, and DBCS trail-byte collisions. All run under `check`; they do not replace original-executable or real multiplayer acceptance.

`pnpm run test:browser:audio` runs asset-free Chromium audio lifecycle acceptance against the configured development origin. It observes timestamped, revision-tagged Worklet messages through repeated playback/release cycles across separate AudioContexts, verifies bounded active-processor counts, and checks context closure. Basic CI includes it. The audio unit regressions cover delayed cursor delivery, stale reports after seeking/changing frequency, quantum-end timestamps, short-stream completion/replay, and distinct output/render cursors. `audioFeedback.test.ts` checks exclusive transfers, held cursors without observations, stale command revisions and buffer reuse; `vmClient.test.ts` checks feedback routing and shutdown cleanup. `tests/basic/vm/soundCursor.e2e.test.ts` executes the generated DirectSound cursor stub in real v86: same-tick polling preserves distinct play/write cursors, while a real PIT interrupt expires the cache even when the call-count budget remains. It also checks that locking from the write cursor does not move playback. This finite lifecycle test does not measure browser heap reclamation or establish full-match audio reliability.

`tests/basic/shimBink.test.ts` checks that unavailable native decoding does not fabricate successful playback and required DLL loading fails explicitly. `tests/basic/vm/guestDllLinking.e2e.test.ts` executes a generated DLL in real v86, checking process attach, original success/failure return values, EDX, stdcall stack balance, and absence of thread pins or host calls. Browser campaign probes observe changing video frames, wait for the original intro to finish naturally, and check DirectSound buffer creation, writes, and release because Bink calls stay inside the guest. Aggregate audio counters do not prove completion of a particular sidebar movie. Cursor-call counts are diagnostic Worker-local queries; the probe budgets total host calls rather than treating each cursor query as frontend RPC. These checks do not establish glitch-free audible output or complete campaign coverage.

## Save and cold-load regression

`tests/basic/shimRegistry.test.ts` checks absent keys/values, invalid and closed
handles, access masks, typed and empty values, bounded queries, real enumeration
and metadata, deleted-key handles, GBK names and session/process isolation.
Unsupported security/view options must fail without creating a key. Registry
identity tests explicitly create their synthetic empty keys; opening an absent
installation key is an error. Native RA2/YR launcher and save/load regressions,
plus the separate MO startup regression, validate compatibility with supplied
installations rather than prepopulated installer markers or credentials.

`VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2/repairRate.test.ts --maxWorkers=1`
starts a native skirmish, discovers the live RepairRate field read-only, and
checks that host mouse-message enqueueing preserves its bytes. Native simulation
must continue after input. The test never seeds a rule value or treats the
former default-value workaround as part of the runtime contract. The adaptive
unit regressions separately verify that fault diagnostics do not rewrite zero,
negative, nonfinite or custom positive values. This does not establish the cause
of the historical zero or cover all MOD rules and building-repair scenarios.

`pnpm run check` runs the asset-free OLE callback, storage metadata, asynchronous file-open, time conversion, and window-order regressions: `tests/basic/vm/olePersistence.e2e.test.ts`, `tests/basic/shimOleStorage.test.ts`, `tests/basic/vmCore.test.ts`, `tests/basic/shimFile.test.ts`, `tests/basic/shimWindowZOrder.test.ts`, and `tests/basic/shimScrollbarOcclusion.test.ts`. These do not replace the real RA2/YR save/load regressions:

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2/saveLoad.test.ts --maxWorkers=1
VM_GAME_DIR=/path/to/yr pnpm exec vitest run tests/real-game/yr/saveLoad.test.ts --maxWorkers=1
```

On PowerShell, set `$env:VM_GAME_DIR='C:\path\to\ra2'` before running the same `pnpm exec vitest` command. Resources must include an executable supported by the adaptive RA2/YR resolver. The test compares executable contents internally and requires the cold-load VM to use the same executable as the saving VM; simulation state is read through the resolved game hooks. Nothing is downloaded implicitly, and a missing executable fails collection instead of skipping the suite.

The test allows the original startup movie to finish before entering the menu, starts a skirmish through normal menus, waits for simulation to advance, saves and closes the confirmation, flushes writes, and destroys the VM. Startup has a separate movie-length timeout; individual save/load UI operations retain their shorter timeout. Only serialized save bytes are carried into a new file provider and VM, via a temporary file and the production file-provider message port. Loading must restore the saved simulation frame and recreate the persisted native object counts, then advance simulation and accept the pause command. A new empty match, a successful no-op save, or a stalled loading screen is not a pass; observations and counters only assert, and must never seed the new VM or force a successful load. The installation is never modified. Disk-backed range reads load only the requested bytes, avoiding a full MIX read per decoder request; the asset-free `installationFiles.test.ts` covers ranges, EOF, missing files, and empty override precedence. Temporary saves are removed even on failure. The test does not cover browser IndexedDB, campaign transitions, all maps, or long-match state.

The resource-enabled RA2 and YR CI entries run this as a required step after boot tests. `check` verifies that the CI entry still references the regression. PR Basic remains asset-free; the trusted dev/main resource job retains its existing secret boundary. Wiring a test into that job is not evidence that the remote job has run successfully.

The RA2 reference-fixup assertion at `0x69fcbd` reports missing or inconsistent object mappings; it is not by itself evidence of missing installation MIX files.

### Mental Omega saves

MO native startup uses the supplied injector. Save/load remains a separate
acceptance requirement; startup alone does not establish save compatibility. The isolated `yr/aresInitialization.test.ts` initializes Ares without installing
extension hooks; it does not establish handshake acceptance and has failed before
a usable game state on the tested legacy and TUC installations.
See [native startup validation](MENTAL_OMEGA_INSTALL.md#native-startup-validation) for
the native Syringe execution boundary and compatibility limitations.

With `VM_GAME_DIR` set to a full MO 3.3.6 installation, run
`pnpm exec vitest run tests/real-game/yr/mentalOmegaSaveLoad.test.ts --maxWorkers=1`.
It saves a Standard skirmish through the native menu and starts a fresh VM using
the production `LoadSaveGame` configuration. It checks the saved frame, restored
object count, continued simulation and pause input. No warm-up match is started
in the loading VM. Source: CnCNet yr-patches `src/spawner/load_spawn.c` and
`src/mods/saved_games_in_subdir.asm`; the bundled DLL is version-checked at boot.

For browser persistence and the actual menu, run
`pnpm exec tsx tests/real-game/browser/mentalOmegaBrowserSmoke.mts` with
`RA2_BROWSER_ORIGIN` pointing to Vite, `MO_UPLOAD_DIR` to the installation,
`MO_GAME_MODE=skirmish`, and `MO_SAVE_LOAD=1`. This saves through native controls,
refreshes, selects the persisted slot in **Load game**, and waits for simulation
to advance beyond the saved frame. Neither test establishes desktop-save
container compatibility or campaign-save coverage.

Batch regressions cover explicit independent-order continuation only on confirmed rejection, preserved rejection indices, immediate stop on uncertainty/session change, and nonzero CLI exit even when subsequent independent orders were submitted. Default batches and placement follow-ups still stop at the first failure.

The control-tools regressions also verify that normal monitor duration expiry returns the last sampled viewport observation, including the sidebar, without submitting gameplay orders. Session replacement must terminate monitoring without returning a duration result from the replaced battle.

The control-tools regressions cover caller-authored placement follow-ups: confirmation before execution, malformed-envelope rejection before mutation, session replacement, and interrupted prefixes without replay. The real-game control browser smoke starts barracks production through a confirmed power-plant placement follow-up and requires native production progress before continuing.

The control-tools regressions verify that group preflight failures expose only the current public observation and requested unavailable IDs without submitting orders, and that native rejection versus uncertainty retains distinct recovery guidance without replay. A valid group produces one command and one receipt.

The current-view image regressions in `presentedFrameCapture.test.ts`, `applicationControl.test.ts` and `controlScreenshot.test.ts` cover pixel ownership/formats, capture cancellation, page replacement and local file safety. With the development server running, `pnpm exec tsx tests/basic/browser/frameCaptureBrowserSmoke.mts` verifies browser encoding, decoded pixels and the transport size bound without game assets. The real-game control browser smoke also decodes CLI captures in each selected RA2/YR Worker/main mode. These checks establish image delivery, not successful visual inference of disguised enemies.

## Asset-free browser tests

The control skill is also validated outside the repository by `tests/basic/controlDistribution.test.ts`:
it copies only the skill folder into a temporary directory, links its declared third-party runtime
dependencies for offline acceptance, and runs the actual CLI server, WebSocket routing, client and
agent-launcher preview without project source or a strategy skill. Architecture checks reject
imports escaping the skill and require the browser protocol to remain dependency-free.
For standalone installation verification, copy the complete skill folder without `node_modules/`
to a directory outside the workspace, then run `pnpm install --frozen-lockfile`,
`pnpm run typecheck`, `pnpm ra2ctl`, and `pnpm ra2agent --channel test --dry-run` there.
The root and skill lockfiles both need updating when control dependencies change;
`packages/relay/pnpm-lock.yaml` remains separate and must also be checked for shared changes.

Local AI control has asset-free routing, session cleanup and x86 mailbox tests in `check`. Run `pnpm exec vitest run tests/real-game/control.test.ts tests/real-game/controlVisibility.test.ts --maxWorkers=1` for original-executable observation and command effects, and `pnpm run test:browser:control` against a running development server for CLI/channel/Worker/main-thread integration. See [AI control](AI_CONTROL.md). Run `pnpm run test:browser:support` separately for native support-power selection, cooldown rejection, paradrop delivery, and their visible journal entries in RA2/YR Worker/main modes. These use fresh sessions independently of the ordinary production scenario. The browser regression owns the default loopback control port, so set `RA2_CONTROL_TEST_PORT=15181` to use a separate port or set `RA2_CONTROL_EXTERNAL_SERVER=1` to reuse it. It checks native sidebar production progress, cancellation, and visible command receipts/errors in addition to deployment, and writes temporary screenshots for visual inspection. The native control regression also trains infantry and successive tanks and verifies their movement after leaving the factory. It additionally constructs the American airfield, checks rejection before natural paradrop recharge, selects the native support cameo, targets the map, and requires eight newly delivered GIs and a restarted cooldown. The recharge deadline is wall time only; the test does not change game clocks or seed units/resources. A failure before reaching the support assertions leaves that capability unverified. The RA2 height scenario uses original elevated terrain to require a visible tank whose physical cell is fogged to remain observable and accept a stop command. Both games verify the native height divisor and odd-level neighbor offset; asset-free tests cover projected fog and physical cloak sensors in both profiles. YR elevated-terrain traversal needs its own map fixture and is not established by the RA2 route. Visibility regressions cover native viewport filtering, hidden-ID rejection, camera movement without revealing shroud, and actual attack-move displacement and attack damage. Original group regression checks selected membership and every member's attack-move mission before normal scouting/contact; camera recovery uses the already-issued destination, and damage checks select the nearest publicly visible engagement. Both RA2 and YR profiles have asset-free cloak/disguise coverage, including transition states, ownership changes, nonzero local-house indices, 16-bit sensor counts, isolation from other houses and the adjacent disguise-sensor array, and visibility gates that sensors cannot override; real cloaked/disguised combat requires the additional scenarios below; the two-player AI regression checks deployment synchronization, while full-state and long-match synchronization remain unverified.

```bash
pnpm run test:browser:install
pnpm run dev
# In another terminal, use the origin printed by dev:
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:react-ui
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:archive-layers
```

Retain Playwright's extraction fix from 1.60.0 onward: older extract-zip can hang after downloading on Node 24.16.0 (Playwright issues 41000/40998; Node.js issue 63487). The lockfile determines browser versions; verify cold installation after upgrades.

Development-resource browser entry points use `tests/helpers/selectDevelopmentGame.ts` to dismiss the game guide through its normal controls, open Load resources, and import `VM_GAME_DIR` through the normal folder picker. The development server does not serve installation assets. They do not write the guide's skip preference. The model dialog rejects an empty local file and keeps inference disabled without loading ORT/model payloads; this admission check requires neither a GPU nor a model identity allowlist. The React UI smoke test also checks viewport-bounded scrolling of a long resource checklist, upload-dialog version selection and direct launch validation, contextual store/base/patch link destinations and new-tab behavior, absence of home-menu game buttons after import, selectable incomplete versions with disabled launch, shared import controls and original-resource reuse for MO, MO package removal, inline import-progress containment and determinate/indeterminate semantics (including reduced motion), and a visible launch footer at desktop and landscape-phone sizes. Startup-page screenshots use `RA2_BROWSER_SCREENSHOT_DIR` when configured, otherwise the system temporary directory.

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

Regressions must not depend on the developer's own settings. Node smoke routes declare the INI values they rely on through `VmSmokeOptions.ini` (`tests/real-game/helpers/sessionIni.ts`): menu click routes recorded in 1440x900 native coordinates set that resolution, and routes whose deadlines exclude the four-minute first-run YR intro set `[Intro] Play=no`. The overlay applies only to the bytes the guest opens in that session; installations are never modified, and save/load or boot tests that deliberately allow the intro keep the installed settings. Browser real-game entries still read RA2.INI/RA2MD.INI from the imported installation: with an installation that keeps `[Intro] Play=yes` (for example a Steam copy), `test:browser:yr` and the YR `test:browser:startup-page` modes spend their deadlines in the intro. Experimental version-bound probes require a unique full instruction signature in the PE image at the expected site, so byte-identical code in other distributions is covered without trusting the address alone.

```bash
VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2 --exclude '**/gonghui.test.ts'
VM_GAME_DIR=/path/to/yr pnpm run test:vm:yr
pnpm run test:browser:battle-start
pnpm run test:browser:network
pnpm run test:browser:network:yr
```

`VM_GAME_DIR` selects resources for Node real-executable tests; browser regressions import the same directory through the player folder picker. Real-game suites fail when the required executable is absent instead of skipping, with no opt-out switch: `test:e2e`, `test:vm`, `test:vm:ra2`, `test:vm:yr`, and the full `pnpm test` all behave the same, so every developer needs the game resources locally. Assertions must still verify completeness and behavior. Gonghui is an opt-in third-party MOD: it runs only with VM_GONGHUI=1 and fails if expand01.mix is missing; original-game startup cannot replace it. Never mix addresses/resources from different executables.

Two-client tests use native UI for discovery, room creation/joining, map validation, match startup, and deployment commands, reading player/unit state on both clients to confirm synchronization. WS handshakes or lobby screenshots cannot replace actual game operations. Before Linux multi-VM startup, check memory and record OOM state. Logs include host total/available memory and process names/RSS on preflight failure. Renderer crashes fail immediately; diagnostic sampling has timeouts so unavailable screenshots cannot hang the test. Other processes can still contend for a shared host; preflight does not guarantee resource isolation throughout the run.

## Resource import and restoration

`gameSourcePicker.test.ts` covers explicit single/multi-game selection, canceled
replacement, separate MO package layers, deterministic patch precedence, original
YR isolation, atomic failed imports and extraction disposal. The React browser
smoke checks unified local imports, the required patch label, original/MOD
availability, and the separate Get resources dialog with store/download anchors
in both UI languages. It also imports a synthetic archive, refreshes before launch,
checks empty/nested/range reads, clears resources, refreshes again and verifies
that independent custom maps and save writeback survive. Synthetic package checks establish
import behavior only, not compatibility with any additional executable version.


```bash
RA2_BROWSER_ZIP=/path/to/game.zip pnpm run test:browser:cache-reload
```

Verify upload-transaction commit before the first launch, refresh into preparation state, explicit selection, and the restored game version. RA2_BROWSER_GAME=yr selects YR; RA2_BROWSER_MAIN_THREAD=1 checks fallback.
RA2_BROWSER_FOLDER can select a complete local directory instead of RA2_BROWSER_ZIP. Cover missing, zero-byte, failed reads, and unknown separately; filtering zero-byte files before declaring restoration successful is invalid.

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

Application control regressions in `tests/basic/applicationControl.test.ts` cover missing resources, stale page IDs, explicit replacement, duplicate/concurrent starts, failure reporting, disposal and channel retention. `test:browser:control` connects before resource selection, queries the native main menu, enters battle using `ui.quickStart` twice with one command ID, verifies the channel survives and the battlefield becomes ready, then exercises native battle commands in RA2/YR Worker/main modes. `RA2_CONTROL_TEST_PORT` isolates its loopback server; the test redirects only the browser transport port, without changing guest behavior. The normal page continues to use port 15180.

`tests/basic/shimMessage.test.ts` verifies that page-content snapshots exclude hidden controls and hidden ancestors and return copied list strings. `tests/basic/vmCore.test.ts` covers score-page content through `ui.status` without an active battlefield. The registered UTF-16 control-message tests cover copied display labels, null clears, bounded reads, hidden controls and profile isolation. `tests/real-game/scorePage.test.ts` separately requires original RA2/YR matches to reach populated score pages through native defeat and reads the names/statistics through `ui.status`. The same regression requires a retained native `defeat` with the original session ID after House teardown. `tests/basic/vm/battleResult.e2e.test.ts` verifies both games' native-result observer trampolines, including victory/defeat/unknown branches, register/flag preservation and subsequent-battle reset without host polling. CLI and VM-core tests cover result forwarding and teardown races. Original-game victories and other custom-drawn graphics remain outside this coverage.

`test:graphics` also recreates the renderer on the retained canvas and compares real WebGL pixel output. `RA2_BROWSER_GAME` and `VM_BROWSER_MODE` can select one `test:browser:control` scenario for diagnosis; filtered runs do not count as the complete four-scenario matrix.

### AI control in native multiplayer

`tests/basic/controlTools.test.ts` checks readiness/damage monitor interruption, visible footprint overlap diagnostics, client monitor/session boundaries, partial group receipts, confirmed placement rejection versus transport uncertainty, camera visibility settling and placement outcome confirmation, including consumed-but-unobserved products. The browser control matrix also uses a direct client `look` after panning away and requires owned units in its returned view, covering the visibility-refresh delay without relying on CLI process startup time. The four-scenario browser matrix allows up to 180 seconds for actual building production and unit emergence on slow main-thread execution; expiry remains a failure, with the final observation logged. It also builds native prerequisites, trains infantry and vehicles, and verifies Q/W/E/R category changes and cross-tab pause/cancel. `tests/basic/vm/playerControl.e2e.test.ts` executes both player-handler ABIs with selection ordering, exact group membership (including lying selection success and wrong pointers), a single handler invocation, native cursor-result forwarding, target/shroud arguments, balanced stacks and invalid-object rejection; real-game control tests verify resulting movement, area guard, deployment, production, placement, original building dimensions and combat. Foundation observation tests also cover signature validation, unavailable cameos, hidden/opponent buildings and unknown dimensions. These helpers use only the public loopback API; they do not supply an omniscient test oracle. Winning against a native AI requires a separate complete match with recorded native settings and victory/score evidence. A score-screen page name alone does not establish the winner.

`tests/basic/controlBuildPlan.test.ts` covers production reuse, confirmation before dependent construction, bounded waiting and stop-on-uncertainty. `tests/basic/controlServer.test.ts` also sends a delivered game rejection through the actual HTTP/WebSocket route and verifies that the client queries the same-session receipt without replay. Full-match evaluation must retain every attempt against its declared budget, including controller failures and tactical losses. Store videos and command logs in an ignored local artifact directory, and distinguish scripted strategy execution from individual model decisions.

`RA2_BROWSER_AI_CONTROL=1 pnpm run test:browser:network` runs the two-player browser scenario with an isolated loopback control server and a separate channel per page. Battlefield deployment uses the public CLI; read-only native House observations on both peers must agree on its effects. Camera movement must remain local, and an enemy's hidden ID must be absent from observation and rejected as an attack target. `RA2_BROWSER_GAME=yr` selects YR. `RA2_BROWSER_START_PAGE=lan` uses the validated native LAN entry, and `RA2_BROWSER_RELAY=ws://127.0.0.1:15182/ai-validation` can select a dedicated local relay. This is a short two-player Worker regression, not full-state CRC, main-thread multiplayer, or 4/8-player acceptance.

With AI control enabled, `RA2_BROWSER_AI_STEALTH=mirage`, `cloak`, or `both` additionally builds the original Allied production chain and trains a Mirage tank or dolphin. An opposing scout must reveal the target cell through normal movement. A read-only test oracle checks a living native unit's concealment, viewport and cell visibility; the public observation must omit it and the command API must reject its ID. `both` reuses one production chain, returns the scout home between cases, and validates the dolphin followed by the Mirage tank. Failed production, placement, pathfinding or concealment setup fails the scenario. The tests never seed units, money, shroud or clocks, and the oracle is not part of the public API. These scenarios use original local assets and write temporary evidence and screenshots.

Naval scenarios require a native map and starting location that permit a shipyard within building reach of explored water. The default RA2/YR maps and randomized starting positions do not guarantee this. A missing shipyard cameo or exhausted placement search is a failed setup, not evidence about cloak visibility. Likewise, a scout at the edge of its sight radius does not establish that the target cell is fully visible; the native cell checks must pass before concealment assertions count.

### Native battle departure

`pnpm exec vitest run tests/real-game/exitBattle.test.ts --maxWorkers=1` starts original RA2/YR skirmishes, submits `exit-battle` through the normal command mailbox, and requires `GUI:SkirmishGame` without VM recreation. It verifies retained receipts and rejection of new commands after departure. `pnpm run test:browser:exit-battle` exercises the public CLI in both games and Worker/main execution, requiring an unchanged application page generation, retained connection and submitted journal entry. It owns an ephemeral control server and new browser contexts; it does not use the player's channel. Both tests require original local assets and fail on unavailable resources or timeouts. This covers local skirmish departure, not campaign or synchronized multiplayer departure.

## YR direct startup without launcher substitution

Use a complete, user-supplied installation of the Steam/TUC build identified by
`src/games/yr/installation.ts`. The supported legacy executable uses the native
launcher regression below, not this direct-entry test. Unsupported installations
must fail rather than skip. Never seed launcher synchronization objects, supply a
verification string, or patch a protection return value to make a test pass.

```bash
VM_GAME_DIR=/path/to/yr pnpm exec vitest run tests/real-game/yr/nativeStartup.test.ts tests/real-game/yr/startupPage.test.ts --maxWorkers=1
VM_GAME_DIR=/path/to/yr VM_EXE_CORPUS_DIR=/path/to/yr pnpm exec vitest run tests/real-game/adaptiveBattle.test.ts --maxWorkers=1
```

The first case uses normal entry and observes the actual main-menu title. The
adaptive battle case exercises the production resource policy and requires native
simulation to advance. Keep a single YR executable in that corpus for this check;
a mixed corpus deliberately tests every supplied build, including rejections.
The former reduced resource bundle is not sufficient for native startup. Retain
failures from incomplete-resource runs separately from full-installation successes.
Browser startup regressions use `RA2_BROWSER_GAME=yr` and the `default`/`main`
startup modes to exercise Worker main-menu and main-thread skirmish entry. These
do not establish MO, campaign completion or multiplayer acceptance.


## YR native launcher regression

For a launcher-based installation, provide `gamemd.exe` and its accompanying
`ra2md.exe`, `ra2md.lcf` and full game resources. `ConquerMD.dat` is optional
at the host boundary; the native launcher handles its absence. The launcher test
uses production `VmCore`, verifies the native main menu and mapping/message calls
with supplied data, and separately tests admission without optional data and
rejection of missing required launcher files. Admission is not startup acceptance:
the tested legacy YR sample did not reach its menu within 60 seconds without
`ConquerMD.dat`; no handshake or successful validation result is substituted. It does not
replace validation data or modify the supplied installation.

```bash
VM_GAME_DIR=/path/to/legacy-install pnpm exec vitest run tests/real-game/yr/nativeLauncher.test.ts --maxWorkers=1
VM_GAME_DIR=/path/to/legacy-install VM_EXE_CORPUS_DIR=/path/to/legacy-install pnpm exec vitest run tests/real-game/adaptiveBattle.test.ts --maxWorkers=1
pnpm exec vitest run tests/basic/processKernel.test.ts tests/basic/vmCore.test.ts --maxWorkers=1
```

The direct-start `nativeStartup.test.ts` above remains a Steam/TUC regression;
it does not run the legacy launcher. Do not use it to claim legacy acceptance.
Browser startup-page regressions require the real Worker for `default` and no
Worker for `main`, using the same complete legacy installation. A launcher or
game exit, timeout, missing resource or unsupported call is a failure.

## Browser installation imports

Browser regressions import the directory identified by `VM_GAME_DIR`, or
`RA2_GAME_ROOT/ra2` (default `game/ra2`), through the ordinary folder picker.
Vite has no game-file service or enable switch. Missing DLLs remain missing.
The RA2 launcher route requires `ra2.exe` and `ra2.lcf`; with both absent, direct execution is attempted.
`Conquer.dat` is optional at the host boundary; native launcher checks remain active. Run `pnpm exec vitest run tests/real-game/ra2/nativeLauncher.test.ts --maxWorkers=1` for production startup with and without `Conquer.dat`, and required-file checks.

The shared `runVmSmoke` entry now starts `VmCore`, so boot, menu-navigation,
scrollbar and rendering regressions use the same installation policy and real
launcher process as the application. Input sequences, native message round trips,
thread counts, PE identity and final control/pixel assertions remain active.
`startupPage` uses production navigation; explicit experimental probes use its
bounded stub allocator. `runRawVmSmoke` is retained only for explicitly invoked
single-image diagnostics, never as a fallback or startup acceptance path.
Use the production `adaptiveBattle.test.ts`
with `VM_EXE_CORPUS_DIR` for simulation advancement. Record failures without
restoring launcher substitutions or skipped XWIS imports.

## Native debugger regressions

Run `pnpm run build:cpu` before direct Vitest execution; `check` and `test:unit`
invoke it automatically. The [CPU build guide](../scripts/vm/README.md) lists
first-build tools and source provenance. `tests/basic/processDebugger.test.ts`
covers independent event handles, actual memory transfer, suspension, context
ownership, declined exceptions and cancellation. `tests/basic/vm/debugger.e2e.test.ts`
executes actual TF instructions and firmware continuation, including branch targets
and instruction faults. Hardware IRQ regressions verify that private task stacks
preserve native temporary data below ESP; DLL regressions reject FALSE initializers
and verify relocation within actual guest RAM. Import regressions cover root-path
precedence, equal-depth conflicts and authoritative empty resources. The archive-layer
browser regression also checks returned root-file bytes and rejects equal-depth
conflicts; flat add-ons retain the localized duplicate-file error and atomic failure. `tests/basic/shimDirectory.test.ts` covers session directory
creation and enumeration without creating placeholder files.

`tests/real-game/yr/mentalOmegaStartup.test.ts` requires a user-supplied installation
through `VM_GAME_DIR` and checks the first campaign mission and a Standard
skirmish. Each requires native simulation advancement, an input round trip and
an undefeated local human player. Extension loading or hook installation alone
is not a pass. Validation results and limitations are recorded in [Mental Omega installation](MENTAL_OMEGA_INSTALL.md#native-startup-validation).

`pnpm run test:browser:mo-startup` imports `VM_GAME_DIR` through the actual folder
picker and selects a Standard skirmish through the React menu. It observes native
simulation advancement and the local human House's defeat state without sending
guest input or replacing game data. It tests Worker and main-thread execution;
`VM_BROWSER_MODE` may select one mode for diagnostics. Set `RA2_BROWSER_ORIGIN` to
the running development server and `RA2_BROWSER_SCREENSHOT_DIR` to a temporary
artifact directory. Resource import and CPU emulation remain local; the server
exposes no installation assets. This manual entry is not a configured MO CI job.


## CI CPU cache regression

`tests/basic/v86BuildCache.test.ts` runs the production build entry against an
isolated synthetic WASM artifact. It checks restoration after a fresh dependency
installation, preservation of a pnpm-store hardlink, and build fallback after
patch changes or corrupt cache files. It downloads nothing and does not compile
upstream code. `ciConfiguration.test.ts` checks explicit Rust setup and separation
of public/resource cache scopes. Actual compiler compatibility remains covered by
`build:cpu` and the real-v86 synthetic instruction regressions in `check`.


## Distribution compliance regression

`pnpm run check:distribution` verifies an existing production build; `build` and
`check` invoke it after Vite output. `tests/basic/distributionLicenses.test.ts`
uses local synthetic distributions to reject missing LGPL text, damaged source
archives and stripped JavaScript notices. The production check verifies actual
minified output, original license bytes, local source downloads and their links.
No source download or private resource is needed during these checks.

`processDebugger.test.ts` verifies debugger presence independently for the owner,
debuggee and unrelated processes, including closure of creation handles and
termination/disposal. The standalone shim regression remains undebugged. Native
MO startup still runs the supplied injector and receives the actual debug state;
a native rejection cannot be replaced with a false debugger result.
