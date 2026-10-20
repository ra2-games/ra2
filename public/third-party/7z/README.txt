7z-wasm 1.2.0 - source and distribution materials

This directory accompanies the independently compiled 7-Zip WebAssembly archive
utility used through its filesystem and command-line interface. It is not game
code. The application's GPL declaration does not replace this component's licenses.

Source baseline:
- 7-Zip 24.09: original release source archive 7zip-24.09-src.tar.xz.
- use-strict/7z-wasm, npm 1.2.0, source revision
  521d2cf93f5964f4e77b01049e19f1b29305c454.
- Emscripten SDK 4.0.10, selected by that revision's Dockerfile.
- The wrapper source archive retains the original source, build scripts, patch,
  configuration, tests and licenses. Generated 7zz.es6.js, 7zz.umd.js and 7zz.wasm
  are omitted: their preferred source and build instructions are included instead.
- manifest.json records source-archive integrity only. It is not an executable
  admission rule and is unrelated to user-supplied game files.

Licenses are in ../../licenses/7z-wasm/:
- License.txt and unRarLicense.txt: unchanged npm package notices.
- 7zip-License.txt: unchanged 24.09 source license inventory, including BSD notices.
- LGPL-2.1.txt: full GNU Lesser General Public License, version 2.1.
- 7zip-unRarLicense.txt: unchanged source-release unRAR terms.

The unRAR portion must not be used to develop a RAR-compatible compressor.
RAR extraction support does not grant permission to implement RAR compression.
The application does not relicense the 7-Zip/unRAR implementation under the GPL.
Modification and replacement for debugging library modifications are permitted
subject to the component's own terms. No game authorization check is affected.

Rebuild with a locally installed Emscripten SDK 4.0.10 and standard build tools:

  mkdir sevenzip-source wrapper-source
  tar -xJf 7zip-24.09-src.tar.xz -C sevenzip-source
  tar -xzf 7z-wasm-1.2.0-source.tar.gz -C wrapper-source
  cd sevenzip-source
  git apply --ignore-whitespace ../wrapper-source/7z-wasm-1.2.0/7zz-emcc.patch
  . "${EMSDK_ENV:?Set EMSDK_ENV to the SDK emsdk_env.sh}"
  while IFS= read -r setting || [ -n "$setting" ]; do
    export "$setting"
  done < ../wrapper-source/7z-wasm-1.2.0/build-es6.env
  cd CPP/7zip/Bundles/Alone2
  emmake make -j -f makefile.emcc

The ES module and WASM outputs are _o/7zz.js and _o/7zz.wasm. For the UMD build,
clean that build directory and use build-umd.env instead. The original Dockerfile
is included as provenance; its old source-download URL may no longer work. The
local source archive above avoids that dependency.

To replace the library in a source checkout, install a separate local replacement
package with the same 7z-wasm API, types, ES/UMD entries and 7zz.wasm filename, then
build the application using pnpm. Keep source archives, notices and manifest
in sync for a modified library. Do not overwrite pnpm content-store hardlinks.
ArchiveExtractorOptions.locateFile remains the generic WASM-location contract.
The application performs no library-binary hash admission check. A rebuild may
change byte output with host/toolchain differences; bit-identical regeneration
of the npm binary has not been established.

When distributing the application, retain this directory and the license files
alongside the WASM utility. Source downloads must remain available without an
account, a fee or access to private game resources.
