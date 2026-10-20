import { resolve } from 'node:path';
import { localizeText, type UiLocale } from '../../src/ui/shared/i18n/translate';
import { expect, type Page } from '@playwright/test';
import { SUPPORTED_GAMES } from '../../src/games/catalog';

/** Locate games by accessible name, avoiding dependence on icons, skins, or button order. */
export function detectedGameOption(page: Page, game: string, locale: UiLocale = 'zh-CN') {
  const entry = SUPPORTED_GAMES.find((entry) => entry.id === game);
  if (!entry) throw new Error('Unknown game');
  return page
    .locator('.resource-upload-dialog')
    .getByRole('radio', { name: localizeText(entry.id === 'mo' ? '心灵终结' : entry.title, locale), exact: true });
}

/** Dismiss admission notices through their normal controls, without saving a skip preference. */
export async function dismissGameGuide(page: Page): Promise<void> {
  await page.locator('.game-source-picker .ra2-menu-nav').waitFor();
  const guide = page.locator('.game-guide-dialog');
  const edge = page.locator('.edge-mouse-notice');
  await page.waitForFunction(() => {
    if (document.querySelector<HTMLDialogElement>('.edge-mouse-notice')?.open) return true;
    if (document.querySelector<HTMLDialogElement>('.game-guide-dialog')?.open) return true;
    try {
      return localStorage.getItem('ra2-vm-game-guide-skipped') === '1';
    } catch {
      return false;
    }
  });
  if (await edge.isVisible()) await edge.locator('.edge-mouse-actions button').first().click();
  await page.waitForFunction(() => {
    if (document.querySelector<HTMLDialogElement>('.game-guide-dialog')?.open) return true;
    try {
      return localStorage.getItem('ra2-vm-game-guide-skipped') === '1';
    } catch {
      return false;
    }
  });
  if (await guide.isVisible()) {
    const locale = (await page.locator('html').getAttribute('lang')) === 'zh-CN' ? 'zh-CN' : 'en';
    await guide.getByRole('button', { name: localizeText('知道了', locale), exact: true }).click();
    await expect(guide).toBeHidden();
  }
}

/** Select and launch a prepared game through the resource dialog's normal controls. */
export async function selectImportedGame(page: Page, game: string, locale: UiLocale = 'zh-CN'): Promise<void> {
  const dialog = page.locator('.resource-upload-dialog');
  if (!(await dialog.isVisible()))
    await page.getByRole('button', { name: localizeText('加载游戏', locale), exact: true }).click();
  await detectedGameOption(page, game, locale).check({ timeout: 120000 });
  await dialog.getByRole('button', { name: localizeText('启动游戏', locale), exact: true }).click();
}

/** Import the local installation through the same folder picker used by players. No asset HTTP service is used. */
export async function selectDevelopmentGame(page: Page, game: string): Promise<void> {
  if (!SUPPORTED_GAMES.some((entry) => entry.id === game)) throw new Error('Unknown game');
  await dismissGameGuide(page);
  await page.getByRole('button', { name: '加载游戏', exact: true }).click();
  const directory = process.env.VM_GAME_DIR ?? resolve(process.env.RA2_GAME_ROOT ?? 'game', 'ra2');
  await page.locator('input[webkitdirectory]').setInputFiles(directory, { timeout: 120000 });
  const dialog = page.locator('.resource-upload-dialog');
  await detectedGameOption(page, game).check({ timeout: 120000 });
  await expect(dialog.getByRole('button', { name: '启动游戏', exact: true })).toBeEnabled({ timeout: 120000 });
  const errors = await dialog.locator('[role="alert"]:visible').allTextContents();
  expect(errors, errors.join('\n')).toEqual([]);
  await selectImportedGame(page, game);
}
