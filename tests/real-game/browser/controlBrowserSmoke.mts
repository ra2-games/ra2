/** Real CLI -> loopback server -> browser -> Worker/main -> native event queue acceptance. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_PORT } from '@ra2vm/control/protocol';
import { chromium, expect } from '@playwright/test';
import { startControlServer } from '@ra2vm/control/server';
import type { BattleObservation } from '@ra2vm/control/contracts';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';
import { ControlClient } from '@ra2vm/control/client';
import { placeBuilding } from '@ra2vm/control/placeBuilding';

const supportScenario = process.env.RA2_CONTROL_SCENARIO === 'support';
const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const exec = promisify(execFile);
const port = Number(process.env.RA2_CONTROL_TEST_PORT ?? CONTROL_PORT);
const server =
  process.env.RA2_CONTROL_EXTERNAL_SERVER === '1'
    ? { port, close: async () => {} }
    : await startControlServer({ port, origins: [origin] });
const artifacts = await mkdtemp(join(tmpdir(), 'ra2vm-sidebar-'));
console.log(`Sidebar screenshots: ${artifacts}`);
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  for (const game of process.env.RA2_BROWSER_GAME ? [process.env.RA2_BROWSER_GAME] : ['ra2', 'yr'])
    for (const mode of process.env.VM_BROWSER_MODE ? [process.env.VM_BROWSER_MODE] : ['worker', 'main']) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        permissions: ['local-network-access'],
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const channel = `${game}-${mode}`;
      const cli = async (method: string, params?: unknown) => {
        const args = [
          'exec',
          'tsx',
          '.agents/skills/ra2-battle-control/scripts/ra2ctl.mts',
          '--raw',
          '--port',
          String(port),
          '--channel',
          channel,
          method,
        ];
        if (params) args.push('--params', JSON.stringify(params));
        const { stdout } = await exec('pnpm', args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        return ['screenshot', 'order-group'].includes(method) ? JSON.parse(stdout) : JSON.parse(stdout).result;
      };
      try {
        if (port !== CONTROL_PORT) {
          await page.addInitScript(
            ({ from, to }) => {
              const NativeWebSocket = window.WebSocket;
              window.WebSocket = class extends NativeWebSocket {
                constructor(url: string | URL, protocols?: string | string[]) {
                  super(String(url).replace(`ws://127.0.0.1:${from}/`, `ws://127.0.0.1:${to}/`), protocols);
                }
              };
            },
            { from: CONTROL_PORT, to: port },
          );
        }
        await page.goto(`${origin}/${mode === 'main' ? '?vm-worker=0' : ''}`);
        await page.getByText('连接 AI', { exact: true }).click({ timeout: 300000 });
        await page.getByRole('textbox', { name: 'AI 频道' }).fill(channel);
        await page.getByRole('button', { name: '连接', exact: true }).click();
        await expect(page.locator('.agent-connection [role=status]')).toHaveText('AI 已连接', { timeout: 10000 });
        assert.equal((await cli('ui.status')).hasResources, false);
        await selectDevelopmentGame(page, game);
        await expect.poll(async () => (await cli('ui.status')).runtime?.page, { timeout: 300000 }).toBe('GUI:MainMenu');
        const initial = await cli('ui.status');
        const quickStart = { commandId: 'browser-start', expectedPageId: initial.pageId, replaceSession: true };
        assert.equal((await cli('ui.quickStart', quickStart)).state, 'submitted');
        assert.equal((await cli('ui.quickStart', quickStart)).state, 'submitted');
        await expect(page.locator('.agent-commands summary')).toContainText('快速开始');
        let observation: BattleObservation | undefined;
        await expect
          .poll(
            async () => {
              try {
                observation = await cli('observe');
                return (
                  observation!.frame > 30 &&
                  observation!.entities.some((e) => /MCV/.test(e.type) && e.owner === observation!.player)
                );
              } catch {
                return false;
              }
            },
            { timeout: 300000, intervals: [1000] },
          )
          .toBe(true);
        const ready = await cli('ui.status');
        assert.notEqual(ready.pageId, initial.pageId);
        assert.equal(ready.runtime.battlefield.ready, true);
        assert(ready.actions.includes('ui.screenshot'));
        const capture = await cli('screenshot');
        assert.equal(capture.event, 'screenshot-saved');
        assert.equal(capture.pageId, ready.pageId);
        assert(capture.sourceWidth > 0 && capture.sourceHeight > 0 && capture.presentation > 0);
        assert.equal(capture.dataUrl, undefined);
        const imageBytes = await readFile(capture.path);
        assert(imageBytes.length > 1000);
        const imageSize = await page.evaluate(
          async ({ dataUrl }) => {
            const image = new Image();
            image.src = dataUrl;
            await image.decode();
            return { width: image.width, height: image.height };
          },
          { dataUrl: `data:${capture.mimeType};base64,${imageBytes.toString('base64')}` },
        );
        assert.deepEqual(imageSize, { width: capture.width, height: capture.height });
        await copyFile(
          capture.path,
          join(artifacts, `${channel}-control-capture.${capture.mimeType === 'image/png' ? 'png' : 'jpg'}`),
        );
        await expect(page.locator('.agent-connection [role=status]')).toHaveText('AI 已连接');
        const mcv = observation!.entities.find((e) => /MCV/.test(e.type) && e.owner === observation!.player)!;
        assert.equal(observation!.perspective, 'viewport');
        const tank = observation!.entities.find((e) => e.owner === observation!.player && e.type === 'MTNK')!;
        let sequence = 0;
        const order = async (action: string, extra: Record<string, unknown>) => {
          const before: BattleObservation = await cli('observe');
          const request = {
            sessionId: before.sessionId,
            observedFrame: before.frame,
            commandId: `camera-${++sequence}`,
            action,
            ...extra,
          };
          assert.equal((await cli('command', request)).state, 'pending');
          await expect
            .poll(async () => (await cli('commandStatus', request)).state, { timeout: 15000 })
            .toBe('submitted');
        };
        const homeViewport = observation!.viewport;
        let panned = false;
        for (const distance of [24, -24]) {
          try {
            await order('camera', { cell: { x: mcv.cell.x + distance, y: mcv.cell.y + distance } });
            panned = true;
            break;
          } catch (error) {
            if (!String((error as { stdout?: string }).stdout).includes('Camera cell is outside the map')) throw error;
          }
        }
        assert.equal(panned, true, 'At least one inward camera destination must be valid');
        await expect(page.locator('.agent-commands summary')).toContainText('移动镜头');
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return (
                (state.viewport.x !== homeViewport.x || state.viewport.y !== homeViewport.y) &&
                !state.entities.some((e) => e.id === mcv.id || e.id === tank.id)
              );
            },
            { timeout: 15000 },
          )
          .toBe(true);
        await page.screenshot({ path: join(artifacts, `${channel}-camera-away.png`) });
        const away: BattleObservation = await cli('observe');
        await assert.rejects(
          cli('command', {
            sessionId: away.sessionId,
            observedFrame: away.frame,
            commandId: 'offscreen-focus',
            action: 'camera',
            unit: mcv.id,
          }),
        );
        // Fast HTTP reads must wait for native object visibility after the camera receipt.
        const focused = await new ControlClient(port, channel).look({ cell: mcv.cell }, away.sessionId);
        assert(focused.entities.some((e) => e.id === mcv.id));
        assert(focused.entities.some((e) => e.id === tank.id));
        await order('camera', { unit: tank.id });
        await order('attack-move', { unit: tank.id, cell: { x: tank.cell.x + 3, y: tank.cell.y + 3 } });
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return state.entities.some(
                (e) => e.id === tank.id && (e.cell.x !== tank.cell.x || e.cell.y !== tank.cell.y),
              );
            },
            { timeout: 60000 },
          )
          .toBe(true);
        await order('stop', { unit: tank.id });
        const friendly = await clientForFriendlyAttack();
        async function clientForFriendlyAttack() {
          const client = new ControlClient(port, channel);
          await assert.rejects(
            client.command('attack', { unit: tank.id, target: mcv.id }, observation!.sessionId),
            /rejected/,
          );
          return client.observe();
        }
        assert.equal(friendly.entities.find((e) => e.id === mcv.id)!.health, mcv.health);
        // Restore the tank's spawn cell so the movement/combat check cannot obstruct the MCV foundation.
        await order('move', { unit: tank.id, cell: tank.cell });
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return state.entities.some(
                (e) => e.id === tank.id && e.cell.x === tank.cell.x && e.cell.y === tank.cell.y,
              );
            },
            { timeout: 60000 },
          )
          .toBe(true);
        await order('stop', { unit: tank.id });
        await order('camera', { cell: mcv.cell });
        observation = await cli('observe');
        const defenders = observation!.entities.filter((e) => e.owner === observation!.player && e.type === 'MTNK');
        assert(defenders.length >= 2, 'Group regression requires multiple living visible tanks');
        const groupReceipt = await cli('order-group', { action: 'guard', units: defenders.map((e) => e.id) });
        assert.equal(groupReceipt.event, 'group-submitted');
        assert.equal(groupReceipt.count, defenders.length);
        await expect(page.locator('.agent-commands summary')).toContainText(`${defenders.length} 个单位`);
        await expect(page.locator(`[data-command-id="${groupReceipt.commandId}"]`)).toHaveAttribute(
          'data-state',
          'submitted',
        );
        await expect
          .poll(
            async () => {
              const view: BattleObservation = await cli('observe');
              return defenders.every((unit) => view.entities.some((e) => e.id === unit.id && e.mission === 11));
            },
            { timeout: 15000 },
          )
          .toBe(true);
        // Retain native defenders during the production scenario. This is a fixture
        // action, not a change to opponent rules, defeat handling, resources or time.
        const infantry = observation!.entities.filter((e) => e.owner === observation!.player && e.type === 'E1');
        if (infantry.length) await cli('order-group', { action: 'deploy', units: infantry.map((e) => e.id) });
        observation = await cli('observe');
        const command = {
          sessionId: observation!.sessionId,
          observedFrame: observation!.frame,
          commandId: 'browser-deploy',
          action: 'deploy',
          unit: mcv.id,
        };
        assert.equal((await cli('command', command)).state, 'pending');
        await expect(page.locator('.agent-commands summary')).toContainText('部署');
        await page.locator('.agent-commands summary').click();
        await expect(page.locator('[data-command-id="browser-deploy"]')).toHaveAttribute('data-state', 'submitted', {
          timeout: 15000,
        });
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return (
                !state.entities.some((e) => e.id === mcv.id) &&
                state.entities.some((e) => /CNST/.test(e.type) && e.owner === state.player)
              );
            },
            { timeout: 60000, intervals: [500] },
          )
          .toBe(true);
        assert.equal((await cli('commandStatus', command)).state, 'submitted');
        const current: BattleObservation = await cli('observe');
        const produce = {
          sessionId: current.sessionId,
          observedFrame: current.frame,
          commandId: 'browser-produce',
          action: 'produce',
          type: 'GAPOWR',
        };
        assert.equal((await cli('command', produce)).state, 'pending');
        await expect(page.locator('[data-command-id="browser-produce"]')).toContainText('生产 GAPOWR');
        await expect(page.locator('[data-command-id="browser-produce"]')).toHaveAttribute('data-state', 'submitted', {
          timeout: 15000,
        });
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return state.sidebar.some(
                (item) => item.type === 'GAPOWR' && item.hasFactory && item.progress >= 12 && item.progress < 45,
              );
            },
            { timeout: 60000, intervals: [250] },
          )
          .toBe(true);
        await page.getByText('连接 AI', { exact: true }).click();
        await page.screenshot({ path: join(artifacts, `${channel}.png`) });
        await page.getByText('连接 AI', { exact: true }).click();
        assert.equal((await cli('commandStatus', produce)).state, 'submitted');
        const building: BattleObservation = await cli('observe');
        const cancel = {
          sessionId: building.sessionId,
          observedFrame: building.frame,
          commandId: 'browser-cancel',
          action: 'cancel',
          type: 'GAPOWR',
        };
        assert.equal((await cli('command', cancel)).state, 'pending');
        await expect
          .poll(
            async () => {
              const state: BattleObservation = await cli('observe');
              return (
                state.production.length === 0 &&
                state.sidebar.some((item) => item.type === 'GAPOWR' && !item.hasFactory && !item.pending)
              );
            },
            { timeout: 60000, intervals: [500] },
          )
          .toBe(true);
        assert.equal((await cli('commandStatus', cancel)).state, 'submitted');
        await expect(page.locator('[data-command-id="browser-cancel"]')).toContainText('取消生产');
        await expect(page.locator('[data-command-id="browser-cancel"]')).toHaveAttribute('data-state', 'submitted', {
          timeout: 15000,
        });
        const invalid = (await cli('observe')) as BattleObservation;
        await assert.rejects(
          cli('command', {
            sessionId: invalid.sessionId,
            observedFrame: invalid.frame,
            commandId: 'browser-invalid',
            action: 'produce',
            type: 'GATECH',
          }),
        );
        await expect(page.locator('[data-command-id="browser-invalid"]')).toHaveAttribute('data-state', 'failed');

        // Exercise the visible Q/W/E/R categories, not only hidden factory linkage.
        const client = new ControlClient(port, channel);
        const session = current.sessionId;
        // Original production can require more than 60 wall seconds on a contended
        // main thread. Keep the completion assertions and game speed unchanged.
        const productionTimeout = 180000;
        const home = { x: mcv.cell.x - 1, y: mcv.cell.y - 1 };
        const occupied = new Set<string>();
        async function construct(type: string, alreadyStarted = false, nextType?: string) {
          if (!alreadyStarted) await client.command('produce', { type }, session);
          await expect.poll(async () => (await client.observe()).sidebarTab).toBe(0);
          await expect
            .poll(
              async () => (await client.observe()).production.some((p) => p.type === type && p.progress === p.total),
              { timeout: productionTimeout },
            )
            .toBe(true);
          const view = await client.observe();
          const footprint = view.sidebar.find((item) => item.type === type)?.foundation;
          assert(footprint, 'Original sidebar must provide the requested building footprint');
          const bases = view.entities.filter(
            (e) => e.owner === current.player && e.kind === 'building' && e.foundation,
          );
          const cells = bases
            .slice()
            .reverse()
            .flatMap((base) => {
              const { width, height } = base.foundation!;
              const perimeter = [];
              for (let x = base.cell.x - footprint.width + 1; x < base.cell.x + width; x++)
                perimeter.push({ x, y: base.cell.y + height }, { x, y: base.cell.y - footprint.height });
              for (let y = base.cell.y - footprint.height + 1; y < base.cell.y + height; y++)
                perimeter.push({ x: base.cell.x + width, y }, { x: base.cell.x - footprint.width, y });
              return perimeter;
            })
            .filter(
              (cell) =>
                !occupied.has(`${cell.x},${cell.y}`) &&
                !view.entities.some((entity) => {
                  const width = entity.foundation?.width ?? 1,
                    height = entity.foundation?.height ?? 1;
                  return (
                    cell.x < entity.cell.x + width &&
                    entity.cell.x < cell.x + footprint.width &&
                    cell.y < entity.cell.y + height &&
                    entity.cell.y < cell.y + footprint.height
                  );
                }),
            )
            .slice(0, 12);
          assert(cells.length, 'Native placement requires a visible clear candidate footprint');
          const events: unknown[] = [];
          const building = await placeBuilding(
            client,
            {
              sessionId: session,
              type,
              cells,
              ...(nextType ? { afterOrders: [{ action: 'produce', type: nextType }] } : {}),
            },
            (event) => {
              events.push(event);
              console.log(channel, JSON.stringify(event));
            },
          );
          if (nextType) {
            assert.equal((events.at(-1) as { event: string }).event, 'placement-followup');
            await expect
              .poll(
                async () =>
                  (await client.observe()).production.some(
                    (product) => product.type === nextType && product.progress > 0,
                  ),
                { timeout: productionTimeout },
              )
              .toBe(true);
          }
          occupied.add(`${building.cell.x},${building.cell.y}`);
          await client.look({ cell: home }, session);
        }
        await construct('GAPOWR', false, 'GAPILE');
        await construct('GAPILE', true);
        async function train(type: string, tab: number) {
          const before = new Set((await client.observe()).entities.map((e) => e.id));
          await client.command('produce', { type }, session);
          await expect.poll(async () => (await client.observe()).sidebarTab).toBe(tab);
          await expect
            .poll(
              async () =>
                (await client.observe()).sidebar.some(
                  (item) => item.type === type && item.hasFactory && item.progress > 0,
                ),
              { timeout: 60000, intervals: [100] },
            )
            .toBe(true);
          await page.screenshot({ path: join(artifacts, `${channel}-tab-${tab}.png`) });
          await expect
            .poll(
              async () =>
                (await client.observe()).entities.some(
                  (e) => e.owner === current.player && e.type === type && !before.has(e.id),
                ),
              { timeout: productionTimeout },
            )
            .toBe(true);
        }
        await train('E1', 2);
        await construct('GAREFN');
        if (supportScenario) {
          for (const defender of (await client.observe()).entities.filter(
            (e) => e.owner === current.player && e.type === 'MTNK',
          ))
            await client.command('guard', { unit: defender.id }, session);
          await construct('GAPOWR');
          await construct('AMRADR');
          const charging = await client.observe();
          const power = charging.supportPowers?.find((entry) => /ParaDrop/i.test(entry.type));
          assert(power && !power.ready, 'Native American paradrop must start charging after airfield placement');
          await assert.rejects(client.command('select-power', { type: power.type }, session), { state: 'rejected' });
          await expect
            .poll(
              async () => (await client.observe()).supportPowers?.find((entry) => entry.type === power.type)?.ready,
              {
                timeout: 240000,
              },
            )
            .toBe(true);
          await client.command('select-power', { type: power.type }, session);
          await expect(page.locator('.agent-commands summary')).toContainText('选择支援能力');
          await expect(page.locator('.agent-commands summary')).toContainText('侧栏操作已提交');
          assert.equal((await client.observe()).targetingPower, power.type);
          assert.equal((await client.observe()).sidebarTab, power.tab);
          const beforeDrop = await client.look({ cell: home }, session);
          const oldInfantry = new Set(
            beforeDrop.entities.filter((e) => e.owner === current.player && e.type === 'E1').map((e) => e.id),
          );
          await client.command('target-power', { type: power.type, cell: { x: home.x + 6, y: home.y + 6 } }, session);
          await expect(page.locator('.agent-commands summary')).toContainText('指定支援目标');
          await expect
            .poll(async () => (await client.observe()).supportPowers?.find((entry) => entry.type === power.type)?.ready)
            .toBe(false);
          await expect
            .poll(
              async () =>
                (await client.observe()).entities.filter(
                  (e) => e.owner === current.player && e.type === 'E1' && !oldInfantry.has(e.id),
                ).length,
              { timeout: 120000 },
            )
            .toBeGreaterThanOrEqual(8);
          await page.screenshot({ path: join(artifacts, `${channel}-paradrop.png`) });
          console.log(channel, 'native paradrop delivered eight infantry');
          assert.deepEqual(errors, []);
        } else {
          await construct('GAWEAP');
          await train('MTNK', 3);
          await client.command('produce', { type: 'GAPILL' }, session);
          await expect.poll(async () => (await client.observe()).sidebarTab).toBe(1);
          await expect
            .poll(async () => (await client.observe()).production.some((p) => p.type === 'GAPILL' && p.progress > 0), {
              timeout: 60000,
            })
            .toBe(true);
          await page.screenshot({ path: join(artifacts, `${channel}-tab-1.png`) });
          // Pause/cancel a product on another tab while the infantry queue stays native.
          await client.command('produce', { type: 'E1' }, session);
          assert.equal((await client.observe()).sidebarTab, 2);
          await client.command('suspend', { type: 'GAPILL' }, session);
          assert.equal((await client.observe()).sidebarTab, 1);
          await client.command('produce', { type: 'E1' }, session);
          assert.equal((await client.observe()).sidebarTab, 2);
          await client.command('cancel', { type: 'GAPILL' }, session);
          assert.equal((await client.observe()).sidebarTab, 1);
          await client.command('produce', { type: 'GAPOWR' }, session);
          assert.equal((await client.observe()).sidebarTab, 0);
          assert.deepEqual(errors, []);
          console.log(
            `${channel}: native camera/movement/production and friendly-target refusal passed; Q/W/E/R tabs and cross-tab pause/cancel verified`,
          );
        }
        await page.getByRole('button', { name: '断开连接', exact: true }).click();
        await expect
          .poll(async () => {
            const { channels } = await (await fetch(`http://127.0.0.1:${server.port}/channels`)).json();
            return channels.includes(channel);
          })
          .toBe(false);
      } catch (error) {
        console.error(`${channel}: page errors`, errors);
        console.error(`${channel}: status`, await cli('ui.status').catch(String));
        console.error(`${channel}: observation`, await cli('observe').catch(String));
        console.error(`${channel}: UI`, (await page.locator('body').innerText()).slice(-6000));
        await page.screenshot({ path: join(artifacts, `${channel}-failure.png`) }).catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
  await server.close();
}
