# Install Mental Omega for the browser

> Native startup is experimental and requires the installation's own `Syringe.exe`,
> Ares and CnCNet modules. The runtime executes their checks; it does not substitute
> a successful handshake. See the
> [startup boundary](ARCHITECTURE.md#native-launcher-and-installation-boundary).

## Native startup validation

The supplied 3.3.0 base package and 3.3.6 patch include their own Syringe launcher,
Ares extension and CnCNet modules. Extracting them does not establish runtime support.
The native launcher route executes the supplied Syringe executable, including its
own Ares compatibility handshake. The process kernel supports its restricted
`DEBUG_ONLY_THIS_PROCESS | CREATE_SUSPENDED` creation mode, independent debugger
handles, actual debug events, thread contexts, cross-process memory operations and
suspend/resume. The source-built CPU supplies real single-step traps; see
[CPU build instructions](../scripts/vm/README.md). The original injector discovers
extensions and installs its own declared hooks. The runtime does not replay an
old host hook table or replace a rejected handshake.

The supplied Ares 3.0 accepts the tested legacy executable but rejects the tested
TUC executable as an incompatible patch. The latter remains a native rejection.
The first campaign mission and a Standard skirmish have passed native simulation
advancement and input round-trip checks with the supplied 3.3.0/3.3.6 resources.
The browser folder-import and skirmish path has also passed in both Worker and
main-thread execution, observing continued native simulation and an undefeated
local human player. These checks do not establish complete campaign, multiplayer
or save compatibility. Earlier startup probes
failed before the debugger, DLL initialization and interrupt-stack fixes; those
failures are not successful acceptance.

Hardware IRQs and voluntary thread switching use x86 task gates and private
firmware stacks. This preserves transient program data below ESP, including
Syringe's temporary hook return address. Reusing the interrupted program stack
corrupted that data. Guest code, hook return values and protection decisions are
not replaced. Unsupported guest SEH dispatch and failed native DLL initialization
stop execution explicitly rather than being treated as success.

The shared runtime supports Unicode module lookup and synchronizes Unicode file
and DLL opens with the supplied provider. Neither file preparation, handshake
acceptance nor extension injection by itself establishes usable game startup.

## Download and assemble the installation

In Load Game, select Mental Omega. Import original Yuri’s Revenge resources, then use the separate Add package buttons for the MO base package and update patch. Each numbered workflow node contains its own download/import actions and status. The arrows describe resource preparation; the final Launch game node becomes available when required resources are complete. The dashed language-pack node is optional.

Obtain the **Mental Omega 3.3.0 base package** and **3.3.6 manual patch** from
the Mental Omega team's official Downloads page (also available through their
ModDB project). Intermediate patches are not required. The patch alone is incomplete.
Use the matching 3.3.6 language pack if needed; soundtrack packages are optional.
Both Chinese and English browser UI offer official Simplified and Traditional
Chinese downloads and an optional Add language pack action after the base and
patch. Choose one variant; adding another replaces the current language layer.
Both official 3.3.6 archives contain `expandmo98.mix`; it is preserved by imports and
applied last in MO sessions only. The separate layer is cached and can be removed
without removing the required packages. It also works over a complete MO import.
The language pack is optional and does not change native executable compatibility.

1. Create a separate empty directory for Mental Omega. Keep your original Yuri's
   Revenge installation separate, especially if it contains a CnCNet client or another MOD.
2. Copy these seven files from your own Yuri's Revenge 1.001 installation:

   ```text
   gamemd.exe
   BINKW32.dll
   BLOWFISH.dll
   ra2.mix
   ra2md.mix
   language.mix
   langmd.mix
   ```

3. Extract the entire 3.3.0 base package into that directory.
4. Extract the entire 3.3.6 patch into the same directory, replacing older files.
   Keep the Ares and CnCNet DLLs supplied by that release together. Do not replace
   them with newer standalone downloads.
5. Apply any matching language pack last. Preserve the INI, MapsMO and Resources
   directories; do not flatten their contents.

The package's `readmeMO.txt` describes the desktop installation. The browser
provides the mission/map selection UI, then executes `Syringe.exe` and the supplied
`gamemd.exe`. It does not execute the desktop `MentalOmegaClient.exe` UI.

## Import into the browser

Use either route:

- **Existing installation:** open **Load Game**, choose **Select folder…**, and
  select a complete MO directory, or import an archive of it.
- **Separate packages:** open **Load Game**, load your YR files, then choose
  **Add package…** in the same dialog for the base
  archive and the required 3.3.6 update archive. Both may be selected together or in
  separate steps; their filenames and selection order do not control precedence.
  The separate MOD section shows package readiness; the shared Add game resources
  module shares import controls, with explicit YR-first guidance for MO.
  Use the separate **Get Game** button to open the base/patch downloads and
  RA2/YR Steam store link. Load Game contains local import and game-launch controls, plus contextual links beside the game-resource and MO package headings.

The 3.3.6 update patch is required when installing from the 3.3.0 base package.
A complete imported 3.3.6 installation does not need a duplicate patch upload.
Launch requires a complete, compatible resulting installation. Current native
compatibility validation targets 3.3.6; an unpatched 3.3.0 installation is unsupported.

Selecting Mental Omega prepares resources; launch executes the supplied native
injector after mission or map selection. Every import, including one containing
only a single game, waits for explicit launch. All three game
cards remain selectable and display only centered icons and game names. Unavailable
games show expandable missing-resource details and cannot launch. Importing a merged MO directory suppresses
the original YR entry because they share `gamemd.exe`. Installing separate MO
packages over clean YR resources keeps the original YR entry available.

The base archive also contains a different `Syringe.exe` inside `Map Editor`.
Folder and catalogued archive imports choose the shallowest matching resource
path before reading it, so the installation-root launcher takes precedence.
Equally shallow conflicting paths fail explicitly; an empty root file remains
authoritative. Strict flat add-on imports still reject duplicate resource names.
If an older cached import selected the editor launcher, remove and reimport the
installation: a flattened cache cannot recover the original source paths.

The browser combines the layers only for the MO session and preserves the original
YR provider. Removing or replacing an add-on does not modify local files. A failed
multi-package selection keeps the previous packages. A complete selected MO file
set uses the existing per-game cache; incomplete extraction is never persisted.

## Missing resources and limits

- Missing expandmo95.mix or expandmo96.mix: install the 3.3.0 base before the patch.
- Missing gamemd.exe or original MIX files: add the seven YR files above.
- Missing mission/map catalogue: preserve INI/BattleClient.ini,
  INI/MentalOmegaMaps.ini, Resources/GameOptions.ini and MapsMO/Standard.
- Unsupported executable/extension combination: use the matching 3.3.6 release
  files; renaming a file does not fix its version.

Earlier experiments using host-installed extension hooks are not evidence for the
current native-injector route. Save/load, multiplayer and long-match reliability
remain unverified through this route.

Installation sources: Mental Omega 3.3.6 `readmeMO.txt` and the project's official
Getting Started and Downloads pages. Game packages are not included in this repository.
