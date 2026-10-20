# Architecture requirements

Keep generic mechanisms independently reusable, inject game differences explicitly, let sessions own lifecycles, and verify dependency boundaries with tests.

This guide expands the architecture constraints in [Repository collaboration rules](../AGENTS.md) for feature design, refactoring, and integration of other games. See [Architecture](ARCHITECTURE.md) for current implementation and data flow. This document neither tracks experimental progress nor claims support for every game or rendering capability.

## 1. Organize by responsibility and extract reusable capabilities

When adding or changing features, actively identify mechanisms reusable by other games. Module placement must consider responsibility, dependencies, and lifecycle. Code independent of a particular game may still belong to resources, presentation, or the platform.

| Layer                   | Responsibility                                                                 |
| ----------------------- | ------------------------------------------------------------------------------ |
| `src/utils/`            | Generic extraction, hashing, paths, asynchronous queues, and memory comparison |
| `src/resources/`        | File contracts, providers, overlays, and resource discovery                    |
| `src/platform/browser/` | Browser file access, storage, and host facilities                              |
| `src/vm86/`             | Generic CPU, PE, Win32, and DirectX runtime mechanisms                         |
| `src/games/`            | Game detection, resource rules, ABI, fixed addresses, and version patches      |
| `src/adapter/`          | VM orchestration, Worker communication, and capability composition             |
| `src/app/session/`      | Session startup, shutdown, switching, failure handling, and destruction        |
| `src/graphics/`         | Frame presentation, postprocessing, display scheduling, and GPU resources      |
| `src/ui/`               | User interaction and status presentation                                       |
| `packages/relay/`       | Independent generic multiplayer relay and wire protocol                        |

Neither `adapter` nor `utils` is a dumping ground for unclassified code. Group utilities by capability, such as `utils/archive/`. Callers import specific modules directly instead of pulling unrelated implementations through a broad barrel entry point.

## 2. Inject game differences through configuration or interfaces

Generic layers must not hardcode game-specific filenames, resource placement rules, addresses, or behavior. Keep differences in game modules and pass them to generic mechanisms through manifests, configuration, or interfaces.

For example, extractors own format detection, extraction, and progress. The game-loading layer supplies resource allowlists, startup-layer partitioning, and Red Alert taunt-audio placement. Prefer extending game modules and capability composition when adding a game. Changes to shared mechanisms must define a reusable contract instead of adding internal branches by game name.

## 3. Keep dependency direction explicit

- `utils` must not depend back on games, the application, UI, or other business modules.
- The generic VM must not depend on specific games or browser implementations.
- Pure file providers must not depend on browser storage or VM execution implementations.
- Presentation must not read fixed game addresses; game policies must not depend on UI.
- The relay must not interpret game events, resources, or units, or import application/game modules.

Share implementations only when contracts match. Keep RA2/YR fixed addresses, ABI, and version patches separate. Do not hide boundary violations by widening dependency-test allowlists or adding forwarding entry points.

## 4. Preserve complete resource semantics

Distinguish unknown, missing, zero-byte, failed reads, and still-loading files. Make override order, directory scope, write destination, and cache ownership explicit. Main-thread and Worker paths must follow the same contract.

Apply session settings through overlays, keeping original assets and shared executable caches independent. Background extraction failures must reach the session. Never publish incomplete caches or treat unextracted files as empty. Buffer transfer requires exclusive copies with explicit ownership handoff.

## 5. Use the same game policies on the main thread and in Workers

Changing threads must not change game detection, resource precedence, settings, or error handling. Transfer only explicit data, ports, and exclusive buffers across threads. Do not transfer closures, guest WASM memory, or shared caches.

Experiments temporarily limited to the main thread must constrain their entry point explicitly and document unverified scope. Production support cannot depend on one execution path happening to behave correctly.

## 6. Make lifecycle and resource ownership traceable

Every Worker, port, timer, listener, audio object, bitmap, and GPU resource needs an explicit creator, holder, and disposer. Cover cleanup for normal exit, cancellation, failure, and reopening.

The session controller coordinates the VM and surrounding tasks. Utilities may own a Worker for one task but must support cancellation and completion cleanup. Late asynchronous results must not revive an old session or overwrite a new one.

A single React tree owns ordinary UI. Dedicated controllers own VM memory, per-frame data, frequent input, and audio; these must not be written repeatedly into React state.

## 7. Ground native compatibility behavior in evidence

The project executes original programs, so compatibility layers must accurately handle guest behavior. Unknown calls cannot be assumed successful. Patches must verify the target version and instruction signatures; fixed addresses and explanations belong in the corresponding game module.

Do not make tests pass by changing clocks, fabricating resources, simulating input, or skipping defeat checks. Preserve native compatibility evidence and identify applicable versions and limits. A local compatibility fix must not be described as a complete resolution of an upstream defect.

## 8. Decouple rendering enhancements from game simulation

High-resolution assets provide additional source detail, upscaling reconstructs or interpolates existing frames, and postprocessing adjusts final colors. Specify each feature's inputs, outputs, and support boundaries. Display resolution may increase while logical unit sizes, coordinates, and simulation speed stay consistent.

Generic renderers consume explicit drawing data; game layers interpret native drawing information. Enhancements need an off switch. Clearly describe experimental limits when animation, occlusion, team colors, or lighting are incomplete. Load experimental models through development entry points; production bundles must not include ORT or experimental model Workers.

## 9. Enforce architecture through verification

When extracting capabilities, migrate imports, Worker URLs, WASM and third-party resource paths, tests, and documentation together. Preserve licenses and provenance. After directory moves, verify that game policies are separated and that error semantics and destruction paths remain consistent.

`tests/basic/architecture/dependencies.test.ts` checks dependency direction. Code changes require at least `pnpm run check` plus relevant regressions from [Testing](TESTING.md). Run repository-wide `pnpm run format:check` before committing. Formatting does not replace behavioral validation.

Public acceptance must not require private assets or implicitly download executables; run real-game validation separately. Missing resources, skips, crashes, and timeouts do not count as passes. Performance conclusions need comparisons in the same scenario. Microbenchmarks and brief screenshots cannot establish full-match performance or long-match stability. See [Real-game CI](REAL_GAME_CI.md) for trust boundaries.
