# Historical resource trimming evidence

This guide preserves compatibility evidence referenced by manifests in earlier packaging tools. Its baseline is an early trimmed RA2 multiplayer package and an original YR resource directory. It does not establish that current CI has accepted every campaign, MOD, or installation package. Current file contracts are defined in `src/games/manifest.ts`; see [Real-game CI](REAL_GAME_CI.md) for current acceptance entry points.

## YR base package

Earlier tools recorded these base-package files by starting the original executable and testing missing files individually:

- `gamemd.exe`, `ra2.mix`, `ra2md.mix`, `langmd.mix`, `language.mix`
- `thememd.mix`, `MULTIMD.MIX`, `expandmd01.mix`
- `game.fnt`, `00000409.016`, `00000409.256`
- `BINKW32.DLL`, `Blowfish.dll`, and the `Taunts/` directory

The list includes optional fonts and taunt audio retained by that packager; not every entry is a current startup requirement. `Blowfish.dll` is read, and a missing or zero-byte file must not count as complete resources. `MAPSMD03.MIX` contains campaign maps; `movmd03.mix` and `subtitlemd.txt` provide movies and subtitles. The earlier boot baseline reached the main menu without these files, which does not prove the corresponding campaigns are playable. The startup regression is `tests/real-game/yr/boot.test.ts`.

## RA2 campaigns and language packs

The earlier multiplayer package could contain a zero-byte `MAPS01.MIX` placeholder and omit `maps02.mix`. The complete original Allied and Soviet campaigns use those files respectively. `movies01.mix`, `movies02.mix`, and `subtitle.txt` provide cutscenes. Preserve the distinction between placeholders and missing files; reaching the main menu cannot prove campaign completeness.

The earlier NSIS multiplayer-package converter constrained `language.mix` to one sample
paired with the Chinese executable selected at that time. This historical combination is not a universal requirement for language resources. Current CI verifies the input package hash and does not silently replace language resources.

## Uncompressed installer payloads

The YR jb5 NSIS repack stores `Conquer.dat`, `ConquerMD.dat`, `updater.bat` and the movie
stubs uncompressed inside otherwise independently compressed data blocks. Decoding every
block as LZMA dropped those files as corrupt streams, and `gamemd.exe` then exited with
code 1 immediately after reading `langmd.mix`, before `ra2md.mix`. Importing the same files
from an extracted directory with `ConquerMD.dat` removed reproduces that exit, so the absent
file, not the archive route, decided startup. The shared extractor now reads stored blocks
verbatim and collects every name attached to one payload. Startup still depends only on the
files listed in `src/games/manifest.ts`; this observation explains a resource that the
native executable reads, not an additional host requirement.
