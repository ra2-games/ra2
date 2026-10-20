/** Verify the materials shipped beside the production JavaScript and WASM, not just source comments. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '../..');
const notices = [
  ['LICENSE', 'licenses/GPL-3.0.txt'],
  ['public/licenses/index.html', 'licenses/index.html'],
  ['public/licenses/v86.LICENSE.txt', 'licenses/v86.LICENSE.txt'],
  ['public/licenses/AMD-FSR.LICENSE.txt', 'licenses/AMD-FSR.LICENSE.txt'],
  ['public/licenses/ScaleFX.LICENSE.txt', 'licenses/ScaleFX.LICENSE.txt'],
  ['node_modules/7z-wasm/License.txt', 'licenses/7z-wasm/License.txt'],
  ['node_modules/7z-wasm/unRarLicense.txt', 'licenses/7z-wasm/unRarLicense.txt'],
  ['public/licenses/7z-wasm/7zip-License.txt', 'licenses/7z-wasm/7zip-License.txt'],
  ['public/licenses/7z-wasm/LGPL-2.1.txt', 'licenses/7z-wasm/LGPL-2.1.txt'],
  ['public/licenses/7z-wasm/7zip-unRarLicense.txt', 'licenses/7z-wasm/7zip-unRarLicense.txt'],
  ['public/third-party/7z/README.txt', 'third-party/7z/README.txt'],
  ['public/third-party/7z/manifest.json', 'third-party/7z/manifest.json'],
] as const;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Distribution compliance check failed: ${message}`);
}
function javascript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? javascript(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}

export function verifyDistribution(output = resolve(projectRoot, 'dist')): void {
  for (const [source, target] of notices) {
    check(
      readFileSync(resolve(projectRoot, source)).equals(readFileSync(resolve(output, target))),
      `${target} is missing or differs from its original notice`,
    );
  }
  const metadata = JSON.parse(readFileSync(resolve(output, 'third-party/7z/manifest.json'), 'utf8')) as {
    version: string;
    files: Record<string, string>;
  };
  const installed = JSON.parse(readFileSync(resolve(projectRoot, 'node_modules/7z-wasm/package.json'), 'utf8'));
  check(installed.version === metadata.version, 'Update the 7z source materials with the dependency');
  check(Object.keys(metadata.files).length === 2, 'Both upstream and wrapper source archives are required');
  for (const [file, expected] of Object.entries(metadata.files)) {
    check(/^[a-z0-9.-]+$/i.test(file) && /^[a-f0-9]{64}$/.test(expected), 'Invalid source manifest');
    const bytes = readFileSync(resolve(output, 'third-party/7z', file));
    check(createHash('sha256').update(bytes).digest('hex') === expected, `Source archive mismatch: ${file}`);
  }
  const comments = javascript(output).flatMap((file) => readFileSync(file, 'utf8').match(/\/\*![\s\S]*?\*\//g) ?? []);
  for (const author of ['Copyright (c) 2021 Advanced Micro Devices, Inc.', 'Copyright (c) 2016 Sp00kyFox']) {
    check(
      comments.some(
        (comment) =>
          comment.includes(author) &&
          comment.includes('Permission is hereby granted') &&
          comment.includes('THE SOFTWARE IS PROVIDED'),
      ),
      `Production JavaScript lost the full MIT notice for ${author}`,
    );
  }
  const index = resolve(output, 'licenses/index.html');
  for (const [, href] of readFileSync(index, 'utf8').matchAll(/href="([^"]+)"/g)) {
    const target = resolve(dirname(index), href!);
    check(target.startsWith(resolve(output) + '/'), 'License index links must stay inside the distribution');
    readFileSync(target);
  }
  console.info('Distribution licenses, 7z source materials and preserved shader notices verified');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyDistribution();
