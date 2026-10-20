import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('runs a copied control skill server, client and agent launcher without the repository or strategy skill', async () => {
  const directory = await mkdtemp(join(tmpdir(), "ra2-control skill's-"));
  const skill = resolve('.agents/skills/ra2-battle-control');
  let server: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  try {
    await cp(skill, directory, { recursive: true, filter: (path) => basename(path) !== 'node_modules' });
    // Reuse only declared third-party runtime packages; the copy has no link to project source.
    // This keeps public acceptance offline. Fresh frozen installation is verified separately.
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    await mkdir(join(directory, 'node_modules'));
    for (const dependency of Object.keys(manifest.dependencies)) {
      await symlink(
        await realpath(join(skill, 'node_modules', dependency)),
        join(directory, 'node_modules', dependency),
      );
    }
    const run = (script: string, ...args: string[]) =>
      exec(process.execPath, ['--import', 'tsx', `scripts/${script}.mts`, ...args], { cwd: directory });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const origin = 'https://127.0.0.1:15274';
    server = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/ra2ctl.mts', 'serve', '--port', String(port), '--origin', origin],
      {
        cwd: directory,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    server.stdout!.on('data', (data) => {
      output += data;
    });
    server.stderr!.on('data', (data) => {
      output += data;
    });
    await expect
      .poll(() => {
        if (server!.exitCode !== null) throw new Error(output);
        return output;
      })
      .toContain(`127.0.0.1:${port}`);
    expect(JSON.parse((await run('ra2ctl', '--port', String(port), 'channels')).stdout)).toEqual({ channels: [] });
    socket = new WebSocket(`ws://127.0.0.1:${port}/connect?channel=isolated`, { origin });
    await once(socket, 'message');
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      expect(request.method).toBe('observe');
      socket!.send(JSON.stringify({ id: request.id, result: { sessionId: 'fixture', frame: 42, entities: [] } }));
    });
    expect(
      JSON.parse((await run('ra2ctl', '--port', String(port), '--channel', 'isolated', '--raw', 'observe')).stdout)
        .result,
    ).toEqual({ sessionId: 'fixture', frame: 42, entities: [] });
    const plan = JSON.parse((await run('agent', '--channel', 'isolated', '--dry-run')).stdout);
    expect(await realpath(plan.cwd)).toBe(await realpath(directory));
    expect(plan.args.at(-1)).toContain('ra2-battle-control/SKILL.md');
    expect(plan.args.at(-1)).not.toContain('--- ra2-strategy/SKILL.md');
    expect(plan.args.at(-1)).toContain(directory.replaceAll("'", "'\\''"));
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  } finally {
    socket?.terminate();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
