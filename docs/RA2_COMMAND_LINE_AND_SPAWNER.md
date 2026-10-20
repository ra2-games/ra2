# Original command line and startup entry points

## Start directly in the LAN lobby

`?network=1&start-page=lan` supports RA2/YR and enters the native LAN lobby after resource selection. For a self-hosted service, append `relay=127.0.0.1:15176`. `network=1` enables the host relay; `start-page=lan` controls only initial guest navigation. Without navigation parameters, startup still enters the main menu. This entry point does not create rooms, select maps, start matches, or bypass connection failures.

The implementation reuses the structurally resolved menu entry and one-shot trampoline described for skirmish below, changing only the first target to 3 and restoring 18 after consumption. Independent instruction analysis of both executables establishes:

- RA2's main-menu LAN button ID `0x578` returns state 3 at `0x5172C1`. Dispatch table `0x5146F4` indexes by state plus one to `0x5139C2`, sets Session=3 and network protocol=1, then transitions to state 16 so native session initialization creates the lobby.
- YR's corresponding return point is `0x532051`, dispatch table `0x52EB58`, and state branch `0x52DD75`. It uses its own Session address and ESI state register. Setting the initial target directly to 16 would skip network-mode initialization.

No menu clicks are simulated, Session is not written directly, and the VM clock is unchanged. `tests/basic/ra2StartupPage.test.ts` executes the real x86 trampolines for both games, checking first state 3, subsequent state 18, stack/flag preservation, and every rejection path. `test:browser:startup-page` supports `lan-worker` and `lan-main`, checking that the first native page is `GUI:Lobby`, a real relay is connected, and frames keep arriving. Run one scenario with:

```bash
RA2_BROWSER_GAME=ra2 RA2_BROWSER_STARTUP_MODE=lan-worker RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:startup-page
```

This single-client check does not replace two-client discovery, actual match startup, and command synchronization acceptance. The skirmish `battle` entry retains native settings initialization and launch validation without adding a complete Spawner or complex injection dependencies.

## Single-player battlefield test entry

`?start-page=battle` supports RA2/YR: after selecting resources or restoring cached resources, it automatically enters a native skirmish battlefield. Main-thread and Worker modes use the same hook; default startup and `start-page=skirmish` remain unchanged. The sidebar's quick-start action opens skirmish settings; automatic match startup uses `start-page=battle`.

This is not a complete CnCNet Spawner. It uses native INI/default skirmish settings without URL configuration for maps, players, seeds, or networking, and does not guarantee identical matches across resource/cache environments. It skips manual menu navigation but cannot replace deterministic replay or multiplayer synchronization tests. Without valid maps/settings, the native handler still validates and may remain on the settings page; tests must fail on timeout rather than force success.

`src/games/shared/battleStartup.ts` generates the trampoline. `src/games/shared/nativeLayout.ts` resolves the setup entry and handler from the loaded executable. The original RA2/YR baseline helpers retain the following instruction evidence for instruction regressions:

- Reuse first-state-11 navigation without skipping skirmish-settings creation or configuration initialization.
- RA2 `0x683C79` and YR `0x6AE34E` follow settings-window initialization. Original instructions are `mov eax,[esp+4]; cmp eax,0x617`. The settings page may appear briefly during initialization.
- A one-shot x86 trampoline calls each native start handler, RA2 `0x6829F0` / YR `0x6ACEE0`, with `ECX=ESI` (window), `EDX=0x617`, and two zero stack arguments. The handler uses `RET 8`. This is neither a click script nor a posted WM_COMMAND; native code still parses options, loads the scenario, and cleans up windows.
- Preserve/restore registers and flags, replay both overwritten instructions, and retain the subsequent native conditional branch. Consume the flag before calling so later skirmish entry does not auto-start again.
- Validate the unique setup signature, linked callback/handler, loaded instructions, exclusive stub space, and allocation overlap. Modify guest memory only, leaving disk executables and the VM clock unchanged.

```bash
# Requires local game resources and a running development server; defaults to RA2/YR × Worker/main-thread.
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:battle-start
# One scenario:
RA2_BROWSER_GAME=yr VM_BROWSER_MODE=worker RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:battle-start
```

After resource selection, browser regressions send no guest mouse/keyboard events. They check battlefield pixels, continued frame output, and a living native local House owning units, without assuming the MCV type index for a randomly selected country. House probes are injected only into test responses, are read-only, and do not replace executables. Screenshots use `RA2_BROWSER_SCREENSHOT_DIR` and stay in temporary directories outside version control.

The asset-free `tests/basic/battleStartup.test.ts` executes real x86, verifying one-shot calls, arguments, stack balance, register restoration, replayed comparisons, and rejection paths.

## Start RA2/YR directly in skirmish settings

During a game, the sidebar's quick-start action asks for confirmation, safely closes the current VM, and reloads into skirmish settings. Canceling neither restarts nor changes the URL. Confirmation sets `start-page=skirmish` while preserving other parameters. Unsaved progress is lost and multiplayer disconnects; uncached resources such as development directories must be selected again, as the dialog explains. Automatic cache restoration still honors the URL settings. This skips preceding menus only: country, map, and start controls remain native, without claiming Spawner configuration directly into a battlefield.

With `?start-page=skirmish`, the first native page after selecting RA2/YR resources is skirmish settings. Append `&start-page=skirmish` when a query already exists. Omitting it preserves default behavior. This settings entry neither starts matches automatically nor bypasses resource loading. Use `battle` above for automatic startup; unknown targets produce an explicit error.

- Runtime resolution lives in `src/games/shared/nativeLayout.ts` and `adaptiveRuntimeHooks.ts`, sharing `src/games/shared/startupTrampoline.ts` without copying third-party patch code. The RA2/YR startup modules retain fixed-baseline regression entry points. The original executable instructions show the skirmish button at `0x513363` returning state 11; dispatch table `0x5146F4` jumps to `0x513D93`, where native code sets the Skirmish session and creates settings.
- `0x513762` originally selects initial-menu EBP=18. Only this location receives a five-byte JMP. The final 48 bytes of exclusive static stub space use MOV to read one-shot target 11, restore it to 18, and jump to the native continuation. No persistent polling flag, simulated button, or VM-clock modification is used; native settings creation/destruction still runs.
- The YR reference baseline validates its 20-byte instruction signature. Its skirmish button at `0x52D713` returns 11; `0x52EB58` indexes by state+1 to `0x52E10F` and sets Session=5. Patch entry `0x52DB12` was MOV ESI,18; only the first execution uses 11, then restores 18. The generator is shared, but RA2 addresses and EBP are not reused.
- Runtime navigation requires unique menu-selection evidence, coherent register use and an independent Session reference, then verifies loaded bytes before installation. A hash difference alone does not reject navigation. Worker transfer still uses an independent executable copy; local game files are never overwritten. See [Adaptive executables](ADAPTIVE_EXECUTABLES.md) for capability and resource-selection boundaries.
- startupPage flows from creation options through Worker init or main-thread fallback to shared VmCore; concrete addresses remain in game directories. Install before first execution, keeping static stubs below the 0xC0000 dynamic-stub boundary.
- Unit tests execute real x86, verifying first state 11, second state 18, stack/flag preservation, and rejection of wrong versions, signatures, duplicates, and conflicts. Three real-executable regressions cover direct entry, selecting the last country, and selecting a map then returning to the single-player and main menus. First-click gating respects an explicitly expected page instead of always waiting for MainMenu.
- Browser scripts separately verify Worker, `vm-worker=0`, and default startup without navigation parameters, recording the first page. They use normal development entry and executable caching without intercepting/replacing executable requests, verifying that the entire page-selected executable reaches the Worker. Screenshots remain in test-configured temporary directories; game assets are not committed.

```bash
pnpm exec vitest run tests/real-game/ra2/startupPage.test.ts
pnpm exec vitest run tests/real-game/yr/startupPage.test.ts
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:startup-page
```

## Current startup configuration

Both RA2/YR catalogs pass `-SPEEDCONTROL` and default in-memory INI `[Options]` and `[Skirmish] GameSpeed` to **0 (fastest)** before VM creation. Imported resources, `[LAN]` / `[WonlinePref]` room speeds, and the VM clock are unchanged. Native options still adjust speed during play; restarting the VM reapplies startup defaults.

The same in-memory `[Options]` overlay defaults a missing `ToolTips` setting to `yes` for both games, preserving an explicit value such as `no`. Hover text, its delay, and its rendering remain owned by the original game.

RA2 1.006 also requires a synchronous `WM_CREATE` callback for its registered `Red Alert 2` top-level window. The native WndProc at `0x7375a0` handles that message at `0x737760`, constructs `CCToolTip`, and stores its pointer at `0x8399b0`. Without the callback, the pointer remains zero during battle even when `[Options] ToolTips=yes` is parsed and unit hover still shows selection brackets and health. The window class is registered by the RA2 profile; the shared User32 shim supplies the normal creation callback.

YR 1.001 creates its top-level window with the distinct registered class `Yuri's Revenge`. Its profile supplies that class to the same `WM_CREATE` mechanism; inheriting RA2's class name leaves the YR creation callback disabled.

The tooltip manager schedules 1-second and 10-second Win32 timers. `PeekMessageA` must keep returning promptly while those deadlines are distant; suspending the VM for every empty poll cuts native simulation throughput. The shared message shim only yields for UI timers within 34 host milliseconds of expiry, while `GetMessageA` and `WaitMessage` retain their blocking behavior.

The generic shim assembles the command line without game-specific decisions. Module paths remain the original executable path; arguments do not enter `GetModuleFileNameA`. Tests cover argument boundaries, RA2/YR propagation, and INI overlays.

RA2's Options speed is at `0xa40b18`, Session speed at `0xa3d2c8`, simulation-frame counter at `0xa40d2c`, and SpeedControl flag at `0xa40d84`. The main loop checks the flag at `0x53ffd7`; without it, `0x53ffe4` forces speed 2. Command-line parsing branches at `0x515429`. Verify Options speed at the stated address, not a Rules offset.

Campaign communication movies also save speed to `0x7f3230` near `0x672e03` and temporarily write 2. Movie exit at `0x672e8f` restores the saved value. This differs from the main-loop override; writing 0 every frame would damage movie timing. In the main menu and campaign selection, observed values are speed 0, Session 0, flag 1, and clock 1×; during movies the saved value is 0 and active value 2. Post-movie restoration needs separate observation; main-menu values alone cannot establish campaign acceleration.

These addresses apply only to RA2, never YR. No executable sample identity is required.
