import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads the installed skill script entry and validates its plan before connecting to a game', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ra2-strategy-entry-'));
  try {
    const plan = join(dir, 'invalid.json');
    await writeFile(plan, JSON.stringify({ waypoints: [] }));
    const script = fileURLToPath(
      new URL('../../.agents/skills/ra2-strategy/scripts/allied-air-assault.mts', import.meta.url),
    );
    await expect(
      promisify(execFile)(process.execPath, ['--import', 'tsx', script, '--plan', plan, '--channel', 'test']),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Provide 1..16 planned scouting waypoints') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
