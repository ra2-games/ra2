/** Native exit through the public CLI in both execution modes, retaining VM/page/channel ownership. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { startControlServer } from '@ra2vm/control/server';
import { CONTROL_PORT } from '@ra2vm/control/protocol';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const exec = promisify(execFile);
// Own only an ephemeral test router and new browser contexts, never the player's channel or server.
const server = await startControlServer({ port: 0, origins: [origin] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  for (const game of ['ra2', 'yr']) {
    for (const mode of ['worker', 'main']) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        permissions: ['local-network-access'],
      });
      const page = await context.newPage();
      const channel = `exit-${game}-${mode}`;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const cli = async (method: string, params?: unknown) => {
        const args = [
          'exec',
          'tsx',
          '.agents/skills/ra2-battle-control/scripts/ra2ctl.mts',
          '--raw',
          '--port',
          String(server.port),
          '--channel',
          channel,
          method,
        ];
        if (params) args.push('--params', JSON.stringify(params));
        const { stdout } = await exec('pnpm', args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        const reply = JSON.parse(stdout);
        return reply.result ?? reply;
      };
      try {
        await page.addInitScript(
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
        await page.goto(`${origin}/${mode === 'main' ? '?vm-worker=0' : ''}`);
        await page.getByText('连接 AI', { exact: true }).click({ timeout: 300000 });
        await page.getByRole('textbox', { name: 'AI 频道' }).fill(channel);
        await page.getByRole('button', { name: '连接', exact: true }).click();
        await expect(page.locator('.agent-connection [role=status]')).toHaveText('AI 已连接', { timeout: 10000 });
        await selectDevelopmentGame(page, game);
        await expect.poll(async () => (await cli('ui.status')).runtime?.page, { timeout: 300000 }).toBe('GUI:MainMenu');
        assert.equal((await cli('start')).state, 'submitted');
        await expect
          .poll(async () => (await cli('ui.status')).runtime?.battlefield.ready, { timeout: 300000 })
          .toBe(true);
        const before = await cli('ui.status');
        const observation = await cli('observe');
        assert.ok(observation.entities.some((entity: { owner: number }) => entity.owner === observation.player));
        const receipt = await cli('exit-battle');
        assert.equal(receipt.state, 'submitted');
        await expect
          .poll(async () => (await cli('ui.status')).runtime?.page, { timeout: 30000 })
          .toBe('GUI:SkirmishGame');
        const after = await cli('ui.status');
        assert.equal(after.pageId, before.pageId);
        assert.equal(after.runtime.phase, 'running');
        assert.equal(after.runtime.battlefield.ready, false);
        assert.equal(
          (await cli('commandStatus', { sessionId: observation.sessionId, commandId: receipt.commandId })).state,
          'submitted',
        );
        await expect(page.locator('.agent-connection [role=status]')).toHaveText('AI 已连接');
        await expect(page.locator('.agent-commands summary')).toContainText('退出战斗');
        await expect(page.locator(`.agent-commands li[data-command-id="${receipt.commandId}"]`)).toHaveAttribute(
          'data-state',
          'submitted',
        );
        assert.deepEqual(errors, []);
        console.log(`${channel}: native exit returned to setup; page, connection and receipt retained`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
