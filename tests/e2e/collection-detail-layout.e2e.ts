import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("a long Japanese collection name keeps a readable title area beside the action buttons", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`
    <main class="app-shell__page" style="width: 100%">
      <section class="collection-detail">
        <header class="collection-detail__header">
          <button class="button" type="button">← 返回</button>
          <div class="collection-detail__identity">
            <h1 id="collection-detail-title">全程度で胸の穴は埋まらない</h1>
            <p>3 本书，按你设定的顺序排列</p>
          </div>
          <div class="collection-detail__header-actions">
            <button class="button button--primary">追加书籍文件</button>
            <button class="button button--primary">追加导入文件夹</button>
            <button class="button">重命名</button>
            <button class="button">添加书籍</button>
            <button class="button button--danger-outline">删除珍藏</button>
          </div>
        </header>
      </section>
    </main>
  `);
  await page.addStyleTag({ path: resolve("src/renderer/src/styles/app.css") });

  const title = await page.locator(".collection-detail__identity").boundingBox();
  const actions = await page.locator(".collection-detail__header-actions").boundingBox();
  const heading = await page.locator("#collection-detail-title").boundingBox();
  expect(title).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(title!.width).toBeGreaterThan(500);
  expect(heading!.height).toBeLessThan(90);
  expect(actions!.y).toBeGreaterThan(title!.y + title!.height);

  await page.setViewportSize({ width: 600, height: 900 });
  const narrowTitle = await page.locator(".collection-detail__identity").boundingBox();
  const narrowActions = await page.locator(".collection-detail__header-actions").boundingBox();
  expect(narrowTitle!.width).toBeGreaterThan(450);
  expect(narrowActions!.y).toBeGreaterThan(narrowTitle!.y + narrowTitle!.height);
  expect(await page.locator(".collection-detail__header").evaluate((header) =>
    header.scrollWidth <= header.clientWidth + 1)).toBe(true);
});
