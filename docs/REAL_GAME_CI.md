# CI configuration

All CI lives in `.github/workflows/`, using `ubuntu-latest` runners. Workflow files can be deployed directly without self-hosted runners; maintainers must enable Actions and configure secrets/branch protection. Skipped work is not accepted work.

## Unified pipeline and Basic test

`quality-check.yml` is the only workflow, accepting PRs targeting dev/main, pushes to dev/main, and manual runs. Ordering is `Basic test → Real game RA2 → Real game YR`, with separate runners per job. Basic runs frozen installation, Biome formatting, type/unit/synthetic VM checks, builds, firmware consistency, and real-browser audio lifecycle, graphics, React UI, touch, maps, layered archives, and main-thread/Worker relay regressions.

This runner is ephemeral and isolated, with no game directory, resource secrets, deployment credentials, host-directory mounts, or private caches. The workflow checks that game/ and .tmp-third-party/ are absent from the checkout and downloads no game executable. External PRs do not run asset-enabled jobs. Basic and game jobs share no writable cache.

## Dependency and CPU caches

SHA-pinned `actions/cache` steps retain only the configured pnpm download store
and the two v86 build-cache files, `build.json` and `cpu.wasm`. Installed
`node_modules`, game packages, extracted installations, credentials, screenshots,
reports and test outcomes are not cached. Frozen dependency installation and all
acceptance steps still run on hits. Browser installation retains its normal
system-dependency checks and is not cached.

Keys include runner OS/architecture and package/lockfile inputs. CPU keys also
include the Rust compiler identity, maintained patch and build script. The CPU
builder independently checks its input signature and WASM capability before
installing a cached artifact; missing, corrupt or outdated entries trigger a build.
Only those two files are cached, not the upstream source checkout or Cargo build
tree. CPU artifacts are restored after pnpm installation, then installed by inode
replacement without writing through pnpm's shared-store hardlinks.

Basic and resource jobs use separate cache namespaces. Basic additionally separates
PR, push and manual events, so PR writes cannot populate the trusted push cache.
RA2 and YR may reuse dependency/CPU caches with each other; their private resources
remain freshly downloaded and validated. No prefix fallback crosses these scopes.
A cache service miss uses the normal installation/build path and never skips tests.

## Real-game CI

Real-game jobs run only after dev/main pushes, including merges, or manual dispatch on those branches, and require Basic success. They do not accept PRs, arbitrary refs, or SHA inputs. Maintainers merge reviewed code only; this is post-merge regression.

RA2/YR use independent jobs that download, validate, and test the corresponding game package. YR explicitly depends on Basic and RA2 and starts after RA2 finishes. It still runs if RA2 fails, while the pipeline remains failed. Basic failure or workflow cancellation prevents game jobs.

Internal dev is not pushed to GitHub; external contributions target main. The target branch must contain the workflow to trigger it. Maintainers handle branch publication separately.

| Type   | Name                                     | Content                                                                                       |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Secret | `GAME_RA2_URL` / `GAME_RA2_YR_URL`       | Original resource-package download address for each game, matching the frontend-selected file |
| Secret | `GAME_RA2_SHA256` / `GAME_RA2_YR_SHA256` | Reviewed SHA-256 of the original package                                                      |

Only the TypeScript entry reads URLs. They are never written to the repository, command line, or logs, or passed to test subprocesses. Downloads use a browser User-Agent verified in CI. HTTP failures report only status/service category, excluding raw requests, response headers/bodies, and network exceptions.

Downloads retain a fifteen-minute total deadline across at most three attempts.
Sixty seconds without response headers or new body bytes cancels the current
request. Transient network failures and HTTP 408/429/500/502/503/504 restart from
byte zero with a fresh hash, after bounded backoff. Other HTTP errors, invalid
configuration and hash mismatches fail immediately. Partial files are never
published or reused. Logs report attempt numbers, bounded failure categories,
and received-byte counts every thirty seconds while data flows; timeouts are
identified explicitly without disclosing signed URLs or response contents.

Extraction requires successful whole-package SHA-256 validation. Without a hash, the job downloads only to report a digest, then fails; an observed digest never becomes trusted configuration automatically. Missing secrets fail before download and identify the missing variable. Forks/unconfigured repositories do not complete real-game acceptance; a job failing to start cannot masquerade as a pass.

## Resource import shared with the frontend

Supply the original ZIP, RAR, 7z, or NSIS/SFX installer selected by players in the frontend. Repackaging, a pre-extracted directory layout, and a supplied inventory.json are unnecessary. Supported formats are defined by the shared extractor.

Browser Workers and CI both call `src/utils/archive/archiveExtractor.ts`. It detects formats using 7z-wasm, handles nested archives recursively, extracts `ARCHIVE_WANTED_NAMES`, and uses existing NSIS/LZMA fallbacks when needed. Browsers mount File through WORKERFS; CI mounts the validated download through NODEFS. File selection/extraction algorithms stay identical. CI waits for full extraction without browser startup-layer early launch and never executes installers. Zero-byte files and present optional files are retained; extracting nothing is not success.

NSIS two-stream variants decode files independently: one corrupt stream skips only that file and reports it in status, without blocking later required resources. Resource acceptance still rejects missing required files.

Executables come from the same authenticated bundle as the data files and are extracted into the run's temporary game/ra2/. No separate EXE is downloaded or overlaid. A bundle missing its required executable fails preparation. Original packages are capped at 16 GiB, extracted resources at 200,000 entries and 32 GiB. Out-of-root output paths are rejected.

Trust comes from secret whole-package hashes, covering executables as well as resources. The inventory.json recorded after import verifies the complete file set/content before execution. It is a derived artifact, not user-supplied input or a substitute for input hashes. Resource changes require review and corresponding secret updates. Original packages and test screenshots stay outside the repository.

## Runners and execution order

YAML declares triggers, runners, tool installation, and secrets, then invokes pnpm commands. TypeScript owns orchestration without Python, shell workflow logic, or GITHUB_ENV handoffs. Asset-free jobs install NASM; both categories install Node, the pnpm version in packageManager, Chromium system dependencies, and the Rust/clang/lld/make/git/Python 3 tools needed for the source-built v86 CPU. Rust also needs the `wasm32-unknown-unknown` target. Python is an upstream CPU build tool, not a CI orchestration entry. The workflow installs Rust explicitly through the SHA-pinned rust-toolchain action, including on runners without rustup. Each checkout installs or builds its CPU artifact with `pnpm run build:cpu`; see [CPU build instructions](../scripts/vm/README.md).

| Entry                              | Responsibility                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run ci:basic`                | Check asset-free environment, check, firmware consistency, browser installation, and browser regressions                                 |
| `pnpm run ci:browser`              | Use installed browsers, exclusively start Vite/relay, and run browser regressions                                                        |
| `pnpm run ci:real-game ra2` / `yr` | Download/validate corresponding secret resources, install browser, run original-executable and battlefield startup regressions, clean up |
| `pnpm run ci:resources --record`   | Explicit maintainer inventory creation; not called by CI                                                                                 |

`ci:quality` remains a compatibility alias for `ci:basic`.

`scripts/ci/run.mts` is the sole orchestration entry. downloadResources.ts handles only download/hash verification; prepareGame.ts invokes the frontend's shared extractor in a separate process including the package executables; gameResources.ts owns resource contracts; processes.ts centralizes logs, timeouts, and process-group cleanup.

NODEFS stages extraction output on disk, avoiding retention of whole packages in MEMFS. Success and failure both clean staging. Only after extraction exits does the parent read imported results and verify inventory, releasing WASM memory before starting the VM. Validated/extracted original packages are then removed. Subprocess failure, timeout, or absent inventory fails the job. Browser and real-game entries build relay exports independently of other jobs' dist output.

Resource paths pass directly within the entry; environment variables are used only at existing game-test boundaries. The entry first removes inherited local-debug `VM_*` variables such as skipped frame checks, click sequences, hover-only behavior, and disabled JIT, then writes its own explicit settings. Runner/caller leftovers cannot weaken assertions.

Each game job owns its runner, resources, and ports. Job dependencies serialize the games without flock or external lockfiles. Same-host two-client networking is currently excluded from CI because available runner memory did not satisfy the two-VM requirement. Manual `test:browser:network` / `test:browser:network:yr` and existing memory checks remain. Restore CI coverage only after confirming Chromium cleanup/capacity; CI success does not establish multiplayer acceptance.

Real-game sequence:

1. Download and validate the original package, then import with the shared extractor outside the checkout.
2. Check required package executables and resources, and record/validate the imported inventory.
3. Run the game's original-executable startup in strict mode; RA2 also runs its quick-game regression. Both games run `tests/real-game/<gameId>/saveLoad.test.ts` as a separate required `save-load` step. Its 14-minute process deadline covers the suite's 12-minute bound, including two clean boots with the original YR startup movie; no movie is marked complete by the shim. The latter saves through native menus, destroys the VM, then loads disk-backed saved bytes in a fresh VM without starting a match first. It checks restored simulation state and native object counts, continued simulation, and menu interaction. Missing resources, an integrity mismatch, timeouts, or assertions fail the step; no skip or continue-on-error is accepted in this resource-enabled job.
4. Own a dedicated development port and verify Worker/main-thread direct battlefield startup. Battlefield startup waits are per game (RA2 150 s, YR 300 s): CI observed YR startup near the 2.5-minute mark against the RA2-derived limit, so the shared timeout was widened instead of treating a slow healthy start as a failure.
5. Clean download directories on normal/failure paths; ephemeral runner destruction handles forced termination.

Job timeouts bound the workflow. Browser entries have a three-minute process deadline, except React UI acceptance, which has six minutes for its language/viewport matrix, import persistence and failure states. Individual browser assertion deadlines remain unchanged. Entry-level timers terminate whole test process groups; failures/timeouts return nonzero. Normal exit, assertions, SIGINT, and SIGTERM all clean up; ephemeral runner destruction handles SIGKILL. Screenshots/detailed diagnostics remain on that runner; text results enter job logs, without public artifact uploads.

## Local verification and limitations

With installed browsers and existing resources, explicitly use --local. It neither downloads resources, installs browsers, nor deletes supplied directories:

```bash
export RA2_GAME_ROOT=/path/to/resources/game
export RA2_CI_RESOURCE_MANIFEST=/path/to/resources/inventory.json
export RA2_CI_RESOURCE_MANIFEST_SHA256="${APPROVED_MANIFEST_SHA256:?Set the reviewed hash}"
pnpm run ci:real-game ra2 --local # Use yr for YR.
```

Do not calculate an expected hash from the inventory being validated and treat it as the CI trust baseline. Public tests use synthetic nested ZIPs and loopback HTTP to verify shared extraction, zero-byte files, filtering, download failure, hashes, and cleanup without real download endpoints. They cannot establish remote secret/service availability.

Claim remote CI activation only after actual jobs succeed. Two-player short matches do not cover public-network impairment, complete long matches, larger multiplayer matches, or all MODs.

The browser runner imports `VM_GAME_DIR` through the player folder picker.
Vite does not expose the installation over HTTP; resource roots are used only
by the local test process. Missing-DLL download fallbacks are disabled.

RA2 boot acceptance runs both the migrated boot smoke and native-launcher regression and therefore exercises
the supplied launcher and its configuration. Runtime admission does not pin an EXE hash. `Conquer.dat` and YR's `ConquerMD.dat` are retained
when supplied but is not required by host-side admission. The original launcher
handles its absence; native failures remain failures, with no fallback to direct entry.
