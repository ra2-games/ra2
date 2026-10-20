/** Rebuild the installed emulator CPU from its upstream source plus the maintained single-step patch. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const source = resolve(root, 'node_modules/.cache/ra2vm-v86/source');
const output = resolve(root, 'node_modules/v86/build/v86.wasm');
const marker = resolve(root, 'node_modules/.cache/ra2vm-v86/build.json');
const artifact = resolve(root, 'node_modules/.cache/ra2vm-v86/cpu.wasm');
const patch = resolve(root, 'scripts/vm/patches/v86-single-step.patch');
// This is the upstream emulator dependency revision, not a game identity/admission rule.
const revision = '847e34d5499b17b90d2783d5342ddd243c753497';
const version = JSON.parse(readFileSync(resolve(root, 'node_modules/v86/package.json'), 'utf8')).version as string;
if (!version.endsWith(`+g${revision.slice(0, 7)}`))
  throw new Error('The v86 source revision must be updated and retested with the installed emulator package');
const signature = createHash('sha256')
  .update(version)
  .update(readFileSync(patch))
  .update(readFileSync(import.meta.filename))
  .digest('hex');
function hasSingleStep(path: string): boolean {
  try {
    return WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(path))).some(
      (entry) => entry.name === 'ra2vm_cpu_single_step' && entry.kind === 'function',
    );
  } catch {
    return false;
  }
}
function install(built: string): void {
  // Replace the installation inode instead of writing through a pnpm content-store hardlink.
  const temporary = output + '.ra2vm-new';
  copyFileSync(built, temporary);
  renameSync(temporary, output);
}
function cachedBuildMatches(): boolean {
  try {
    return JSON.parse(readFileSync(marker, 'utf8')).signature === signature && hasSingleStep(artifact);
  } catch {
    return false;
  }
}
if (cachedBuildMatches()) {
  install(artifact);
  console.info('Installed cached v86 single-step CPU');
  process.exit(0);
}
function run(command: string, args: string[], cwd = root): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0)
    throw new Error(
      `v86 CPU build failed: ${command}. Install Rust with the wasm32-unknown-unknown target, clang, make, git and Python 3. ${result.error?.message ?? ''}`,
    );
}
for (const command of ['cargo', 'rustc', 'clang', 'make', 'git', 'python3']) run(command, ['--version']);
mkdirSync(dirname(source), { recursive: true });
if (!existsSync(resolve(source, '.git'))) {
  run('git', [
    'clone',
    '--no-checkout',
    '--no-hardlinks',
    process.env.V86_SOURCE_REPOSITORY ?? 'https://github.com/copy/v86.git',
    source,
  ]);
}
// This checkout is exclusively owned build-cache data, never a user's source installation.
run('git', ['reset', '--hard', revision], source);
run('git', ['apply', '--check', patch], source);
run('git', ['apply', patch], source);
run('make', ['build/v86.wasm', 'STRIP_DEBUG=true'], source);
const built = resolve(source, 'build/v86.wasm');
if (!hasSingleStep(built)) throw new Error('Built CPU lacks the required single-step capability');
copyFileSync(built, artifact + '.new');
renameSync(artifact + '.new', artifact);
install(artifact);
writeFileSync(marker, JSON.stringify({ version, revision, signature }) + '\n');
console.info('Installed source-built v86 CPU with real x86 single-step support');
