# Adaptive executable capabilities

RA2 and YR retain separate game policies, but runtime addresses are resolved from instruction operands and native call relationships. There is no per-distribution address table or whole-image address delta. Executable hashes still identify downloaded content and multiplayer peers; matching a runtime capability does not establish cross-version multiplayer compatibility.

## Resolution and ownership

`GameRuntimeHooks.resolve(memory, executableBytes)` runs once in `VmCore` after loading the PE and before installing patches. The resulting hooks belong to that VM and are released on destruction. The main-thread and Worker paths use this same composition. The shim receives only the resolved networking installer and supplies its owned guest-code allocator.

`src/vm86/peProbe.ts` provides generic section bounds and unique signature searches. Game semantics remain in `src/games/`: RA2/YR supply settings initializer shapes, menu registers, compatibility policies and startup patches. Shared Westwood discovery is in `src/games/shared/nativeLayout.ts`.

Resolution verifies:

- Frame, speed and timing operands against independent references, section permissions and native pacing logic.
- Settings singleton and field layout through the initializer that copies settings into the native Session structure.
- Initial menu selection, including coherent ECX/EDX compiler variants, against the independently resolved Session address.
- Battlefield entry through setup template `0x102`, its dialog callback, command dispatch and the native handler ABI.
- LAN initialization sites against the resolved counters; reporting and negotiation sites against native frame references and branch targets.
- Read-only repair-rate fault identification against the settings singleton, frame counter, floating-point multiplier and division path.

Every participating instruction must still match the loaded image before publishing a capability or writing its patch. A duplicate qualifying signature is ambiguous, not a reason to select the first match. Memory writes do not use old addresses when detection fails. Speed writes recheck their initializer evidence. Repair-rate discovery supplies fault diagnostics only; it never writes rules values or intercepts host mouse messages.

Optional movie/calibration/Short Game patches require their own complete instruction evidence. The Short Game correction applies only to the recognized two-entry BaseUnit implementation; an absent match does not establish MOD compatibility. Explicit navigation fails if its required evidence is absent. Unavailable counters/speed writes return `null`; unavailable LAN tuning preserves native timing.

Instruction-validated helpers in the original startup/network modules remain reference baselines for instruction regressions and version-bound diagnostics. Production `VmCore` uses the resolved hooks. DLL compatibility, resource availability and API semantics remain separate requirements; recognizing an EXE is not sufficient to declare a full installation supported.

## Local corpus validation

The corpus tests recursively discover `game.exe`, `gamemd.exe`, and their `.sha256`-suffixed equivalents. New distribution directories, including Steam installations, are included automatically. A digest suffix must match the actual file. No executables are downloaded, committed or rewritten.

```bash
# PE loading, static import ABI and capability installation; no game execution.
pnpm exec vitest run tests/real-game/adaptiveExecutables.test.ts --maxWorkers=1

# Native direct skirmish startup, advancing simulation and live speed writes.
# Requires matching installation resources in the normal game directory.
pnpm exec vitest run tests/real-game/adaptiveBattle.test.ts --maxWorkers=1

# Repeat without advertising a CD-ROM in the drive map.
VM_CORPUS_CD=absent pnpm exec vitest run tests/real-game/adaptiveBattle.test.ts --maxWorkers=1
```

`VM_EXE_CORPUS_DIR` selects the corpus directory (required); `VM_GAME_DIR` selects the installation resources. Each executable is overlaid in memory over those resources. A shared resource directory must actually be suitable for each executable; these tests do not convert resources between versions. Missing files, unsupported capabilities, API failures and timeouts fail acceptance.

Asset-free `tests/basic/adaptiveRuntime.test.ts` uses synthetic PEs with moved addresses, both temporary-register forms, conflicting references, duplicate matches, changed live bytes and allocator failure. Existing real-x86 startup/LAN tests continue to verify generated trampoline semantics.

`VM_CORPUS_CD=absent` removes D: from drive enumeration and drive-type queries. It does not change volume-information/free-space shim behavior, exercise a physical disc, or establish that campaign/movie paths work without CD compatibility. The production drive map temporarily advertises only C:; the D: entries are commented out in the game catalog, while generic CD compatibility remains available. Campaign/movie behavior remains unverified. With no override, the corpus test uses the production map; `VM_CORPUS_CD=mounted` explicitly restores D: for comparison.

Corpus startup tests establish only the exercised native skirmish behavior. Campaigns, cold save/load, MODs, two-client synchronization and long matches need their own regressions. Browser Worker/main-thread integration is checked separately by the startup-page and battlefield browser entries in [Testing](TESTING.md).

## Resource distribution boundary

Players supply `game.exe` or `gamemd.exe` with the installation bundle. The manifest includes these files in required resources and the archive startup layer. Directory import, archive import, development resources and cache restoration all retain the selected package executable; none downloads or overlays a fixed distribution. Executables, resources and optional RA2.INI/RA2MD.INI settings are persisted together after complete extraction. Runtime settings changes remain session overlays; importing does not rewrite the supplied files. Legacy caches without an executable are incomplete and reopen the picker for reimport.

CI extracts the executable from the authenticated package and inventories it with all other resources. Package and inventory hashes still validate integrity, without imposing a built-in executable hash. Multiplayer executable identity checks remain separate from adaptive capability detection.

Startup admission uses installed launcher/configuration presence rather than EXE
sample hashes. A complete pair selects the native launcher, both absent selects
direct execution, and a partial pair fails. Neither route is retried on native
failure. Structural admission alone does not guarantee that a version runs.
The experimental MO extension injector remains unavailable until a layout-based
compatibility contract replaces its former sample-specific gate.
