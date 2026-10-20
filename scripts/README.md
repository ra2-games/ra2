# Developer tools

Use root `package.json` for everyday commands. The distributable control CLI and server live in [the control skill](../.agents/skills/ra2-battle-control/SKILL.md); `pnpm ra2ctl` and `pnpm ra2agent` remain available. Tests belong in `tests/`; this directory retains development and maintenance tools only.

| Directory      | Purpose                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ci/`          | CI orchestration, process cleanup, trusted resource download/validation                                                       |
| `resources/`   | Local ZIP archival and shared package download modules                                                                        |
| `legal/`      | Verify production notices, corresponding archive-utility sources and preserved shader licenses                                 |
| `assets/`      | Generate project icons and maintain asset utilities                                |
| `benchmarks/`  | Fixed-workload host microbenchmarks, not full-match FPS                                                                       |
| `experiments/` | Offline model conversion/quality comparisons outside production and Basic CI                                                  |
| `deploy.sh`    | Explicitly invoked site deployment with caller-supplied configuration                                                         |

Use Biome directly: `pnpm run format` writes and `pnpm run format:check` verifies. Custom formatting scripts and game-package Blob-upload entries are no longer maintained. The frontend imports original packages directly; CI uses the same extractor. Historical trimming evidence remains in [Resource evidence](../docs/RESOURCE_PACKAGE_EVIDENCE.md).

## Rendering and resource diagnostics

- `experiments/probeReShadeUi.mts` verifies real RA2 effect toggles and same-frame restoration. `experiments/probeReshadeRender.mts` requires supplied FX compilation output; see [ReShade adaptation](../docs/RESHADE_ADAPTATION.md).
- `experiments/captureSrBattle.mts` retains original campaign screenshot sampling. It requires supplied RA2 assets and defaults to `.tmp-sr-battle`; use `RA2_SR_OUTPUT` for a new directory. It depends on native menu layout/story progression and is outside public acceptance. Producing images does not establish battlefield acceptance.
- `ci/prepareGameProcess.mts <ra2|yr> <absolute-resource-directory>` is a standalone resource-preparation subprocess entry. With `ci/memory.ts` it records RSS, container memory, and OOM counts; it has not replaced CI's primary entry. Its module name differs from `ci/prepareGame.ts` so extension resolution cannot accidentally execute a CLI when importing a library.

`pnpm ra2ctl --channel NAME exit-battle` requests native departure from an active match while retaining the VM and channel. Follow with `ui.status` to confirm the menu transition; the submitted receipt only confirms queue acceptance. See [AI control](../docs/AI_CONTROL.md#exit-the-current-battle) for session and retry semantics. `pnpm run test:browser:exit-battle` verifies RA2/YR Worker/main departure using an isolated test router.

`pnpm run gen:icons` generates only the RA2/YR selection PNGs in `public/icons/` from the transparent cartoon PNGs in `public/images/factions/`, using Python 3 and Pillow. It needs no game resources. `pnpm run gen:icons:check` checks those two generated files. Browser favicons (`public/favicon.ico` and `public/favicon-*.png`), `public/apple-touch-icon.png`, and `public/icons/mo.png` are maintained as finished assets; this script never regenerates them. Keep favicon artwork centered and proportionally scaled with a narrow transparent margin. The maskable install icon retains its separate safe-area layout.
