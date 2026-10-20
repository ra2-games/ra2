import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../.agents/skills/ra2-battle-control/scripts/agent.mts', import.meta.url));
const run = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', script, ...args]);

it.each(['codex', 'claude'])('preflights the channel and propagates %s exit status', async (agent) => {
  const dir = await mkdtemp(join(tmpdir(), 'ra2-agent-test-'));
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body).method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { phase: 'idle' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(dir, agent), `#!/bin/sh\nprintf 'fixture-agent-started\\n'\nexit 7\n`, { mode: 0o755 });
    const port = (server.address() as { port: number }).port;
    await expect(
      exec(process.execPath, ['--import', 'tsx', script, '--agent', agent, '--channel', '1', '--port', String(port)], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      }),
    ).rejects.toMatchObject({ code: 7, stdout: expect.stringContaining('fixture-agent-started') });
    expect(requests).toEqual(['ui.status']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['codex', 'claude'])('previews %s with shared gameplay guidance and literal arguments', async (agent) => {
  const { stdout } = await run(
    '--agent',
    agent,
    '--channel',
    'match_1',
    '--port',
    '15181',
    '--model',
    'local model; $(false)',
    '--dry-run',
  );
  const plan = JSON.parse(stdout);
  expect(plan.executable).toBe(agent);
  expect(plan.args.slice(0, 2)).toEqual(['--model', 'local model; $(false)']);
  expect(plan.args[2]).toContain('ra2ctl --port 15181 --channel match_1');
  expect(plan.args[2]).toContain(`pnpm --dir '${plan.cwd}'`);
  expect(plan.args[2]).toContain('ra2-strategy/SKILL.md');
  expect(plan.args[2]).toContain('ra2-battle-control/SKILL.md');
  expect(plan.args[2]).toContain('do not start or replace a match');
  expect(plan.args).not.toContain('--dangerously-skip-permissions');
});

it('makes quick start explicit and rejects malformed connection arguments', async () => {
  const { stdout } = await run('--channel', '1', '--quick-start', '--dry-run');
  expect(JSON.parse(stdout).args.at(-1)).toContain('request it once');
  for (const args of [
    ['--agent', 'other', '--channel', '1'],
    ['--channel', 'a;b'],
    ['--channel', '1', '--port', '0'],
  ]) {
    await expect(run(...args, '--dry-run')).rejects.toMatchObject({ code: 1 });
  }
});
