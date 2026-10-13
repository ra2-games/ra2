# Repository collaboration rules

These rules apply throughout the repository. The project runs original RA2/YR programs in v86 without booting Windows. Keep lasting rules here, implementation details in docs, and historical records separate from execution instructions.

## Getting started

- Internal development and contributions use dev; never push dev to GitHub. External contributors open PRs against main.
- Check Git status first and preserve existing changes. Do not overwrite or incidentally commit unrelated files.
- Use pnpm only. Do not pin Node; package.json's packageManager defines pnpm. The workspace uses root pnpm-lock.yaml, while standalone relay builds also maintain packages/relay/pnpm-lock.yaml. Check both lockfiles when shared dependencies change and use pnpm install --frozen-lockfile.
- Read [Architecture requirements](docs/ARCHITECTURE_REQUIREMENTS.md) and docs/ARCHITECTURE.md before architecture changes; read docs/TESTING.md before test changes. docs/README.md links specialized UI, multiplayer, hook, and resource-CI guides; read those relevant to the task.
- Write comments and maintained documentation in English; Chinese commit descriptions are preferred. Code identifiers follow existing module conventions. Explain reasons, boundaries, and evidence for important compatibility behavior instead of restating code.
- The default README is English, with a linked Chinese README. Keep both versions consistent.

## Change boundaries

- Continuously distinguish generic mechanisms from game policies when implementing/changing features, actively extracting capabilities reusable by other games. Place generic capabilities by responsibility in utils, resources, graphics, or platform. Do not hardcode game filenames, rules, or addresses in utilities; inject differences through configuration, contracts, or game modules. utils must not depend back on business layers. Migrate tests, documentation, and resource-loading paths with extractions while preserving behavior and lifecycle ownership.
- Generic vm86 must not depend on specific games or browsers, or provide game-specific file aggregation entries. RA2/YR fixed addresses, ABI, and patches belong in their game modules. Do not widen architecture-test allowlists to bypass layering.
- File contracts and pure providers belong in resources; browser backends in platform/browser/files; session ownership in app/session; presentation scheduling in graphics. Architecture docs/tests define detailed dependencies.
- A single React tree manages ordinary web UI. VM, WebGL, audio, and frequent input stay out of React state. Effects, Workers, timers, ports, and buffers need explicit destruction owners.
- Unimplemented guest calls must not be assumed successful. Patches must validate target versions/instruction signatures and keep RA2/YR isolated. Do not pass tests by skipping defeat checks, fabricating resources, simulating input, or changing clocks.
- Preserve distinctions between unknown, missing, zero-byte, and failed reads, plus override precedence. INI settings modify session overlays only. Never transfer guest WASM memory or shared executable caches.
- Main-thread and Worker paths use the same game policies. Experimental SR loads only through development entries; production must not include ORT or experimental model Workers. Performance conclusions require same-scene comparisons; microbenchmarks are not full-match FPS.

## Verification and delivery

- Code changes require at least pnpm run check and relevant regressions from docs/TESTING.md. Documentation-only changes require checking commands, source paths, and local links. Historical test counts cannot substitute for current results.
- After changing src/vm86/boot.asm, run pnpm run build:boot and synchronize generated boot.bin.
- Public acceptance must not depend on private assets or implicitly download executables. Missing resources, skips, crashes, and timeouts in real-game tests are not passes; successful reruns do not erase prior failures.
- Real-game CI trust boundaries/configuration are in docs/REAL_GAME_CI.md. Do not claim remote CI enabled without configured runners. Two-client short matches do not establish public-network long-match or complete 4/8-player reliability.
- Centralize CI in .github/workflows and use ubuntu-latest. Asset-free acceptance handles dev/main PRs; real-game jobs download RA2/YR resources separately after dev/main pushes. Formatting does not replace heavyweight acceptance.
- Never commit game packages, executables, model weights, screenshots, or local caches. Preserve third-party licensing and attribution.
- Without an explicit request, do not commit, push, deploy, or upload resources. Delivery reports must identify actual verification and unverified scope.

## Documentation maintenance

- CLAUDE.md only imports AGENTS.md (`@AGENTS.md`); maintain only this file.
- Update corresponding docs when changing interfaces, directories, or commands. Repository configuration is the sole source for versions/scripts.
- Current guides must not accumulate per-commit logs, machine-specific temporary paths, or obsolete todos. Retain historical experiments only when useful for maintenance, explicitly identifying their baseline and currency. Fix maintained links after file moves and preserve reverse-engineering evidence.
- Maintained docs and agent instructions avoid external domains/links. Attribute sources by project, version/tag, and source path; connection examples use environment variables or loopback addresses. The user-requested README site link and remotely hosted badges are explicit exceptions. Do not change runtime configuration or original third-party license text to enforce this rule.
