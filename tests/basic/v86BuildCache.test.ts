import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ra2vm-cpu-cache-'));
  temporary.push(root);
  const script = readFileSync('scripts/vm/buildV86.mts');
  const patch = readFileSync('scripts/vm/patches/v86-single-step.patch');
  const version = '0.5.441+g847e34d';
  const signature = createHash('sha256').update(version).update(patch).update(script).digest('hex');
  const write = (file: string, contents: string | Uint8Array) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  };
  const entry = write('scripts/vm/buildV86.mts', script);
  const patchPath = write('scripts/vm/patches/v86-single-step.patch', patch);
  write('node_modules/v86/package.json', JSON.stringify({ version }));
  const original = Buffer.from('original package CPU');
  const store = write('pnpm-store/v86.wasm', original);
  const installed = join(root, 'node_modules/v86/build/v86.wasm');
  mkdirSync(dirname(installed), { recursive: true });
  linkSync(store, installed);
  const name = [...Buffer.from('ra2vm_cpu_single_step')];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  // A synthetic export marker exercises cache installation without downloading or compiling upstream code.
  const wasm = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 0, 1, 0x7f]),
    ...section(3, [1, 0]),
    ...section(7, [1, name.length, ...name, 0, 0]),
    ...section(10, [1, 4, 0, 0x41, 1, 0x0b]),
  ]);
  const artifact = write('node_modules/.cache/ra2vm-v86/cpu.wasm', wasm);
  const marker = write('node_modules/.cache/ra2vm-v86/build.json', JSON.stringify({ signature }));
  const cargo = write('bin/cargo', '#!/bin/sh\necho "uncached CPU build requested"\nexit 71\n');
  chmodSync(cargo, 0o755);
  const run = () =>
    spawnSync(process.execPath, ['--import', 'tsx', entry], {
      cwd: resolve('.'),
      env: { ...process.env, PATH: join(root, 'bin') },
      encoding: 'utf8',
      timeout: 10000,
    });
  return { run, original, store, installed, wasm, artifact, marker, patchPath };
}

it('restores a cached CPU into a fresh pnpm installation without changing the shared store inode', () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Installed cached');
  expect(readFileSync(f.installed)).toEqual(Buffer.from(f.wasm));
  expect(readFileSync(f.store)).toEqual(f.original);
});

it('rebuilds when the maintained CPU patch changes instead of using the previous artifact', () => {
  const f = fixture();
  writeFileSync(f.patchPath, 'changed patch');
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('uncached CPU build requested');
  expect(readFileSync(f.installed)).toEqual(f.original);
});

it.each(['artifact', 'marker'] as const)('treats a corrupt cached %s as a build miss', (part) => {
  const f = fixture();
  writeFileSync(f[part], 'invalid cache data');
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('uncached CPU build requested');
  expect(readFileSync(f.installed)).toEqual(f.original);
});
