import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEpubFixture } from './fixtures/epub-fixture.js';

for (const format of ['epub', 'txt'] as const) test(`${format}: rapid settings changes keep the reader usable`, async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'reader-layout-'));
  const book = format === 'epub' ? await createEpubFixture(root) : join(root, 'layout.txt');
  if (format === 'txt') await writeFile(book, '第一章\n\n' + '这是一段用于阅读布局验证的文字。\n\n'.repeat(150));
  const application = await electron.launch({ ...(process.env.READER_E2E_EXECUTABLE ? { executablePath: resolve(process.env.READER_E2E_EXECUTABLE), args: [] } : { args: [resolve('out/main/index.js')] }), env: { ...process.env, READER_DATA_ROOT: join(root, 'profile'), READER_E2E: '1', READER_E2E_IMPORT_PATH: book } });
  try {
    const page = await application.firstWindow();
    await page.waitForURL(url => url.protocol === 'reader-app:');
    if (process.env.READER_E2E_EXECUTABLE) {
      await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, book);
      await page.evaluate(() => window.readerApi.library.importFiles());
      await page.reload();
    }
    await page.getByRole('region', { name: '最近加入' }).getByRole('button', { name: /打开《/ }).first().click();
    const runner = page.frameLocator('iframe[title="EPUB 正文"]').locator('html');
    if (format === 'epub') await expect(runner).toHaveAttribute('data-ready', 'true');
    else await expect(page.getByTestId('reading-scroller')).toBeVisible();
    await expect(page.locator('.reader-transition-stage')).toHaveAttribute('data-reader-phase', 'active');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1048, 624));
    await page.getByRole('button', { name: '阅读工具' }).click();
    await page.getByRole('button', { name: '阅读外观设置' }).click();
    await page.getByRole('button', { name: /夜间/ }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-theme', 'night');
    await page.getByRole('button', { name: /纸张/ }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-theme', 'paper');
    await page.getByRole('button', { name: '仅应用于本书' }).click();
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: /夜间/ }).click();
      await page.getByRole('button', { name: '滚动阅读', exact: true }).click();
      await page.getByRole('button', { name: /纸张/ }).click();
      await page.getByRole('button', { name: '分页阅读', exact: true }).click();
    }
    await page.getByRole('button', { name: /夜间/ }).click();
    await page.getByRole('button', { name: '滚动阅读', exact: true }).click();
    await expect(page.locator('.reader-shell')).toHaveAttribute('data-theme', 'night');
    await expect(page.locator('.app')).toHaveAttribute('data-theme', 'paper');
    expect(await page.locator('.reader-shell').evaluate(el => getComputedStyle(el).colorScheme)).toBe('dark');
    expect(await page.locator('.reader-panel--appearance .panel-header strong').evaluate(el => getComputedStyle(el).color)).toBe('rgb(231, 235, 232)');
    if (format === 'epub') {
      await expect(runner).toHaveAttribute('data-flow', 'scrolled');
      await expect(runner).toHaveAttribute('data-layout-state', 'stable');
      expect(await runner.evaluate(el => getComputedStyle(el).colorScheme)).toBe('dark');
      expect(await runner.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(28, 32, 30)');
    }
    for (const size of [[1048, 680], [960, 640], [1400, 900]]) {
      await application.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), size);
      await expect.poll(() => page.evaluate(() => {
        const shell = document.querySelector('.reader-shell')!.getBoundingClientRect();
        const panel = document.querySelector('.reader-panel--appearance')!.getBoundingClientRect();
        return document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth && shell.bottom <= innerHeight + 1 && panel.bottom <= innerHeight + 1 && shell.top >= 34;
      })).toBe(true);
      await page.getByRole('button', { name: '收起阅读外观', exact: true }).click();
      await page.getByRole('button', { name: '阅读外观设置' }).click();
    }
    await page.screenshot({ path: `test-results/reader-layout-${format}.png` });
    await page.getByRole('button', { name: '收起阅读外观', exact: true }).click();
    await page.getByRole('button', { name: '书库', exact: true }).click();
    await expect(page.getByRole('region', { name: '最近加入' })).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
