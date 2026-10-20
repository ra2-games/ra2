/** Separate browser and server entry points; emit shared protocol code once without including Node dependencies in the page. */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
// This script owns the entire build directory; remove stale entry points and unreferenced chunks.
await rm(resolve(root, 'dist/lib'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    client: 'src/client/index.ts',
    server: 'src/server/gameRelay.ts',
    faults: 'src/server/relayFaults.ts',
    wire: 'src/network/relayWire.ts',
  },
  outdir: 'dist/lib',
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  bundle: true,
  splitting: true,
  packages: 'external',
});
