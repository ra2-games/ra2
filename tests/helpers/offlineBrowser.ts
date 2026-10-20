import type { Page } from '@playwright/test';

/**
 * Public UI/graphics acceptance requires no EXEs. Block obsolete download routes as a regression guard against reintroducing implicit executable dependencies.
 * Real-game regressions do not call this function; it neither fakes successful game files nor changes manifest hashes.
 */
export async function preventThirdPartyDownloads(page: Page): Promise<void> {
  await page.route('**/__third-party/**', (route) => route.abort('blockedbyclient'));
  await page.route('https://oldgame.store/**', (route) => route.abort('blockedbyclient'));
}
