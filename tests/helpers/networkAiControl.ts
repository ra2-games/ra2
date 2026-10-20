import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { startControlServer } from '@ra2vm/control/server';
import { CONTROL_PORT } from '@ra2vm/control/protocol';
import type { BattleObservation } from '@ra2vm/control/contracts';

const exec = promisify(execFile);

/** Own the test transport; game commands still cross the public CLI/channel interface. */
export async function networkAiControl(origin: string) {
  const server = await startControlServer({ port: 0, origins: [origin] });
  let sequence = 0;
  const channel = (index: number) => `network-${index}`;
  async function request(index: number, method: string, params?: unknown) {
    const args = [
      'exec',
      'tsx',
      '.agents/skills/ra2-battle-control/scripts/ra2ctl.mts',
      '--raw',
      '--port',
      String(server.port),
      '--channel',
      channel(index),
      method,
    ];
    if (params !== undefined) args.push('--params', JSON.stringify(params));
    const { stdout } = await exec('pnpm', args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout).result;
  }
  async function observe(index: number): Promise<BattleObservation> {
    // Poll the same public route directly; commands still exercise the CLI process.
    const response = await fetch(`http://127.0.0.1:${server.port}/channels/${channel(index)}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), method: 'observe' }),
    });
    const reply = await response.json();
    if (!response.ok || reply.error) throw new Error(reply.error ?? `Control HTTP ${response.status}`);
    return reply.result;
  }
  async function command(index: number, action: string, extra: Record<string, unknown>) {
    const before = await observe(index);
    const params = {
      sessionId: before.sessionId,
      observedFrame: before.frame,
      commandId: `network-${++sequence}`,
      action,
      ...extra,
    };
    expect(await request(index, 'command', params)).toMatchObject({ state: 'pending' });
    await expect
      .poll(async () => (await request(index, 'commandStatus', params)).state, { timeout: 30000 })
      .toBe('submitted');
  }
  return {
    observe,
    command,
    close: server.close,
    async prepare(context: BrowserContext) {
      await context.addInitScript(
        ({ from, to }) => {
          const NativeWebSocket = window.WebSocket;
          window.WebSocket = class extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(String(url).replace(`ws://127.0.0.1:${from}/`, `ws://127.0.0.1:${to}/`), protocols);
            }
          };
        },
        { from: CONTROL_PORT, to: server.port },
      );
    },
    async connect(pages: Page[]) {
      for (const [index, page] of pages.entries()) {
        await page.evaluate(() => document.exitPointerLock());
        await page.getByText('连接 AI', { exact: true }).click();
        await page.getByRole('textbox', { name: 'AI 频道' }).fill(channel(index));
        await page.getByRole('button', { name: '连接', exact: true }).click();
        await expect(page.locator('.agent-connection [role=status]')).toHaveText('AI 已连接');
        await page.getByText('连接 AI', { exact: true }).click();
      }
    },
    async checkViews() {
      const [home, opponent] = await Promise.all([observe(0), observe(1)]);
      const mcv = home!.entities.find((e) => /MCV/.test(e.type) && e.owner === home!.player)!;
      const enemy = opponent!.entities.find((e) => /MCV/.test(e.type) && e.owner === opponent!.player)!;
      expect(mcv).toBeDefined();
      expect(enemy).toBeDefined();
      expect(home!.player).not.toBe(opponent!.player);
      expect(home!.entities.some((e) => e.id === enemy.id)).toBe(false);
      await expect(
        request(0, 'command', {
          sessionId: home!.sessionId,
          observedFrame: (await observe(0)).frame,
          commandId: 'hidden-enemy',
          action: 'attack',
          unit: mcv.id,
          target: enemy.id,
        }),
      ).rejects.toMatchObject({ stdout: expect.stringContaining('Target is not visible') });
      await command(0, 'camera', { cell: enemy.cell });
      const away = await observe(0);
      expect(away.viewport).not.toEqual(home!.viewport);
      expect(away.entities.some((e) => e.id === enemy.id || e.id === mcv.id)).toBe(false);
      expect((await observe(1)).viewport).toEqual(opponent!.viewport);
      await command(0, 'camera', { cell: mcv.cell });
      expect((await observe(0)).entities.some((e) => e.id === mcv.id)).toBe(true);
      return { home, opponent, away };
    },
    async deploy(index: number) {
      const state = await observe(index);
      const mcv = state.entities.find((e) => e.owner === state.player && /MCV/.test(e.type));
      expect(mcv).toBeDefined();
      await command(index, 'deploy', { unit: mcv!.id });
      await expect
        .poll(
          async () => (await observe(index)).entities.some((e) => e.owner === state.player && /CNST/.test(e.type)),
          { timeout: 30000 },
        )
        .toBe(true);
    },
  };
}
