# Licenses and third-party content

Original project code is licensed under GPL-3.0-or-later. The root LICENSE and relay package LICENSE contain the full GPL version 3 text; the SPDX identifier in package.json specifies version 3 or later. This declaration does not replace third-party copyrights or licenses.

Native AI-control compatibility references include Phobos-developers YRpp and Ares-Developers YRpp, with revisions and source paths recorded in [AI control](AI_CONTROL.md#native-compatibility-evidence). No upstream headers or original game executables are bundled with that implementation.

| Content                                                                    | Source and maintenance entry point                                           | Scope                                                                  |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Dependencies including v86, React, 7z-wasm, fflate, and onnxruntime-web    | package.json, pnpm-lock.yaml, each dependency's LICENSE                      | Preserve each dependency's original license                            |
| Relay dependency ws                                                        | packages/relay/package.json; server build output licenses/ws/                | Retain copyright and license when distributing                         |
| LZMA-JS (lzma npm v2.3.2)                                                  | src/utils/archive/vendor/lzma-worker.js and adjacent lzma-worker.LICENSE.txt | Nathan Rugg's MIT license; retain local patch notes                    |
| Anime4K shaders                                                            | src/ui/pages/game/vendor/README.md and shader headers                        | Keep the original MIT notices intact                                   |
| Game files such as game.exe, gamemd.exe, MIX files, maps, audio, and video | Game manifests and player-provided resources                                 | Outside this project's GPL code; not supplied in the source repository |

The source-built v86 CPU includes a maintained single-step patch. Its upstream
revision, modified source paths and retained BSD license are recorded in
[CPU build instructions](../scripts/vm/README.md). Preserve that notice when
distributing the generated WASM.

## Distribution notices and corresponding sources

Production output includes a [license index](../public/licenses/index.html), original
7z-wasm package notices, the full LGPL 2.1 text, the 7-Zip 24.09 license inventory,
both upstream unRAR notices, the project GPL text, the v86 BSD notice, and separate
FSR/ScaleFX MIT notices. The original license texts are copied unchanged. The FSR
and ScaleFX source headers use preserved license comments so production minification
also retains the complete notices in JavaScript.

The [7z source materials](../public/third-party/7z/README.txt) accompany each build:
the original 7-Zip 24.09 release sources, and the source/build patch for 7z-wasm
1.2.0 at revision `521d2cf93f5964f4e77b01049e19f1b29305c454`. Generated wrapper JS
and WASM are excluded from the wrapper source archive; their preferred sources,
Emscripten configuration and original build scripts remain. Source-archive checksums
record dependency provenance, not game-program identity or admission rules.

7-Zip remains an independently compiled WASM utility called through its filesystem
and command-line interface. Its LGPL, BSD, public-domain and unRAR terms remain
separate from the application's GPL declaration. In particular, the unRAR portion
must not be used to implement a RAR-compatible compressor. The source materials
describe rebuilding and replacing the library; no library-binary hash admission
check prevents local replacement. Update source materials and notices when
changing that component. A GPL label alone does not relicense restricted portions.

`pnpm run build` and `pnpm run check` run `check:distribution` after producing
`dist`. It rejects missing/changed notices, missing or damaged source archives,
dependency-version drift, broken local license links and stripped FSR/ScaleFX
license comments. `scripts/deploy.sh --no-build` performs the same check before
publishing an existing output directory. These engineering checks establish the
presence and consistency of distribution materials, not a legal opinion on every
possible downstream combination or use. Bit-identical regeneration of the npm
WASM binary has not been established.

The active console uses inline SVG in `src/ui/pages/game/components/ra2menu/Ra2ConsoleArtwork.tsx`, with authored paths, gradients, and static procedural noise filters. `wordmarkPaths.ts` supplies the title glyphs; `radarMapPaths.ts` supplies the fictional radar geometry. CSS in `consoleArtwork.css` controls placement and decorative animation, while `ra2menu.css` styles the live commands and responsive layout. No legacy menu bitmaps, generated backdrop images, external textures, or AI-generation prompts are distributed with this theme.

Source attribution cannot replace complete authorization records; distributors need to verify the distribution scope for these assets separately. Adding GPL does not mean their licensing has been verified. Executable download configuration likewise does not alter ownership or licensing of the programs. Preserve sources, versions, original copyrights, and license text when updating dependencies or assets.

### Fictional radar artwork

`src/ui/pages/game/components/ra2menu/radarMapPaths.ts` contains independently authored fictional map fragments and survey traces. It uses independently drawn artistic shape templates with seeded random placement, scale, and rotation, deterministic subdivided coastlines, and interior contours, with no geographic dataset, country boundaries, place names, or map-service dependency. Fine relief lines are generated by static banded SVG noise clipped to these regions. The temporary Natural Earth-derived geometry was removed at the user's request. The SVG material and lighting work remains independent of these shapes.

### Display artwork

The README screenshots and poster, cartoon faction illustrations in `public/images/factions/`, and their derived application icons are display assets, not redistributed game installations. The project code license does not grant rights to underlying game characters, emblems, trademarks, or other third-party content. Redrawing an emblem or generating an illustration does not itself establish permission to use those elements.

The source inventory contains no tracked game EXE/DLL/MIX archives or game audio/video files with the standard extensions checked. Display JPGs and derived icons remain. This observation is limited to the current source tree; it is not a rights audit of historical objects, external repositories, hosted resources or user-supplied files.
