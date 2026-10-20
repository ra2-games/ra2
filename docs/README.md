# Documentation index

These maintained guides describe the current code, scripts, and test boundaries. Commands and versions are defined by `package.json`, the root `pnpm-lock.yaml`, `packages/relay/pnpm-lock.yaml`, `.agents/skills/ra2-battle-control/pnpm-lock.yaml`, and the actual workflows.

## Maintained guides

| Topic                                                                 | Guide                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Contributing and licensing                                            | [Contributing](../CONTRIBUTING.md), [Third-party content](THIRD_PARTY.md)                              |
| Repository collaboration rules                                        | [AGENTS.md](../AGENTS.md)                                                                              |
| Development and player features                                       | [Project README](../README.md)                                                                         |
| Mental Omega resource preparation (startup disabled)                                                  | [Installation](MENTAL_OMEGA_INSTALL.md)                                                                |
| Architecture constraints, module boundaries, and dependency checks    | [Requirements](ARCHITECTURE_REQUIREMENTS.md), [Implementation](ARCHITECTURE.md)                        |
| Adaptive executable addresses and local corpus validation             | [Adaptive executables](ADAPTIVE_EXECUTABLES.md)                                                        |
| Native simulation FPS and performance testing                         | [Game performance](GAME_PERFORMANCE.md), [Architecture](ARCHITECTURE.md)                               |
| Issue reporting and local button context                              | [Operation monitoring](OPERATION_MONITORING.md)                                                        |
| Developer tools                                                       | [Scripts](../scripts/README.md)                                                                        |
| Local AI observation, commands and channel routing                    | [AI control](AI_CONTROL.md)                                                                            |
| Historical resource trimming evidence                                 | [Resource evidence](RESOURCE_PACKAGE_EVIDENCE.md)                                                      |
| Test selection and merge requirements                                 | [Testing](TESTING.md)                                                                                  |
| Private assets, trusted runners, and real matches                     | [Real-game CI](REAL_GAME_CI.md)                                                                        |
| React, localization, and page layout                                  | [React boundaries](REACT_UI.md), [UI directory](../src/ui/README.md)                                   |
| VM Worker and main-thread fallback                                    | [Worker implementation](WORKER.md)                                                                     |
| Self-hosted relay, standalone distribution, and generic wire protocol | [Relay deployment](../packages/relay/README.md), [Relay protocol](../packages/relay/RELAY_PROTOCOL.md) |
| WebSocket multiplayer, poor networks, and public-match limitations    | [Network reliability](RA2_NETWORK_RELIABILITY.md)                                                      |
| Launch arguments and page/battlefield hooks                           | [Launch behavior](RA2_COMMAND_LINE_AND_SPAWNER.md)                                                     |
| Upscaling modes, experimental models, and measurement limits          | [Upscaling](AI_UPSCALING.md)                                                                           |
| ReShade effects and adaptation boundaries                             | [ReShade adaptation](RESHADE_ADAPTATION.md)                                                            |

Fixed addresses and instruction signatures are defined by profiles, hooks, and tests in `src/games/`. Maintained documentation records purpose, boundaries, and verification entry points, without one-off terminal logs, machine-specific paths, or obsolete handoff notes.
