import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyDistribution } from '../../scripts/legal/verifyDistribution';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});
function distribution(): string {
  const output = mkdtempSync(join(tmpdir(), 'ra2vm-distribution-'));
  temporary.push(output);
  cpSync('public/licenses', join(output, 'licenses'), { recursive: true });
  cpSync('public/third-party', join(output, 'third-party'), { recursive: true });
  mkdirSync(join(output, 'assets'));
  const headers = ['src/ui/pages/game/fsrUpscale.ts', 'src/ui/pages/game/scalefxUpscale.ts']
    .map((file) => readFileSync(file, 'utf8').match(/\/\*![\s\S]*?\*\//)![0])
    .join('\n');
  writeFileSync(join(output, 'assets/runtime.js'), headers);
  return output;
}
it('retains original notices, local corresponding sources and working download links', () => {
  expect(() => verifyDistribution(distribution())).not.toThrow();
});
it('rejects a release missing the full LGPL text', () => {
  const output = distribution();
  rmSync(join(output, 'licenses/7z-wasm/LGPL-2.1.txt'));
  expect(() => verifyDistribution(output)).toThrow();
});
it('rejects a damaged source archive instead of publishing an unusable source offer', () => {
  const output = distribution();
  writeFileSync(join(output, 'third-party/7z/7zip-24.09-src.tar.xz'), 'invalid source archive');
  expect(() => verifyDistribution(output)).toThrow('Source archive mismatch');
});
it('rejects production JavaScript that stripped notices even when source-side license files exist', () => {
  const output = distribution();
  writeFileSync(join(output, 'assets/runtime.js'), 'const renderer = {};');
  expect(() => verifyDistribution(output)).toThrow('Production JavaScript lost');
});
