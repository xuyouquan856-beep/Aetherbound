import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEpubFixture } from "./fixtures/epub-fixture.js";

const realPerformanceEpub = process.env.READER_PERFORMANCE_EPUB;
const tempRemovalOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const;

async function launchReader(dataRoot: string, importPath: string) {
  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: {
      ...process.env,
      READER_DATA_ROOT: dataRoot,
      READER_E2E: "1",
      READER_E2E_IMPORT_PATH: importPath,
    },
  });
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await page.waitForLoadState("domcontentloaded");
  return { application, page };
}

test("cold and warm EPUB open remain flash-free within their performance budgets", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "reader-open-fixture-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-open-data-"));
  const epubPath = await createEpubFixture(fixtureRoot);
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchReader(dataRoot, epubPath);
    application = launched.application;
    const { page } = launched;
    const openButton = page.getByRole("button", { name: "打开《EPUB 验收书》" });

    await page.evaluate(() => {
      const state = {
        startedAt: null as number | null,
        readyElapsed: null as number | null,
        elapsed: null as number | null,
      };
      Object.assign(window, { __readerColdProbe: state });
      document.addEventListener("pointerdown", () => {
        state.startedAt ??= performance.now();
      }, { capture: true, once: true });
      const observer = new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>(
          'iframe[title="EPUB 正文"]',
        );
        if (
          frame?.getAttribute("data-ready") === "true"
          && state.startedAt !== null
          && state.readyElapsed === null
        ) {
          state.readyElapsed = performance.now() - state.startedAt;
        }
        const stage = document.querySelector("[data-reader-phase]");
        if (
          stage?.getAttribute("data-reader-phase") !== "active"
          || state.startedAt === null
        ) return;
        state.elapsed = performance.now() - state.startedAt;
        observer.disconnect();
      });
      const stage = document.querySelector("[data-reader-phase]");
      if (!stage) throw new Error("Reader stage unavailable");
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-reader-phase", "data-ready"],
      });
    });
    await openButton.click();
    const frame = page.locator('iframe[title="EPUB 正文"]');
    const runner = page.frameLocator('iframe[title="EPUB 正文"]');
    await expect(runner.locator("html")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("[data-reader-phase]")).toHaveAttribute(
      "data-reader-phase",
      "active",
    );
    const coldElapsed = await page.evaluate(() => (
      window as typeof window & {
        __readerColdProbe: {
          readyElapsed: number | null;
          elapsed: number | null;
        };
      }
    ).__readerColdProbe);
    const coldTrace = await page.evaluate(() => {
      const read = (
        window as typeof window & {
          __AETHERBOUND_READER_TRACES__?: () => Array<{
            startedAt: number;
            marks: Record<string, number>;
          }>;
        }
      ).__AETHERBOUND_READER_TRACES__;
      return read?.().at(-1) ?? null;
    });
    expect(coldElapsed.readyElapsed).not.toBeNull();
    expect(coldElapsed.elapsed).not.toBeNull();
    test.info().annotations.push({
      type: "reader-cold-open-optimized-ms",
      description: coldElapsed.readyElapsed!.toFixed(1),
    });
    if (coldTrace) {
      test.info().annotations.push({
        type: "reader-cold-open-phase-ms",
        description: JSON.stringify(Object.fromEntries(
          Object.entries(coldTrace.marks).map(([phase, value]) => [
            phase,
            Math.round((value - coldTrace.startedAt) * 10) / 10,
          ]),
        )),
      });
    }
    expect(coldElapsed.readyElapsed!).toBeLessThanOrEqual(366);
    expect(coldElapsed.elapsed!).toBeLessThanOrEqual(450);
    await runner.locator("html").evaluate(() => {
      const view = document.querySelector("foliate-view") as HTMLElement & {
        renderer: { getContents(): Array<{ doc: Document }> };
      };
      view.renderer.getContents()[0]?.doc
        .querySelector<HTMLElement>("#to-second")
        ?.click();
    });
    await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "1");
    await frame.evaluate((node) => {
      node.setAttribute("data-retained-probe", "original-rendition");
    });

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-reader-phase]")).toHaveAttribute(
      "data-reader-phase",
      "suspended",
    );

    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await page.evaluate(() => {
        const state = { startedAt: performance.now(), elapsed: null as number | null };
        Object.assign(window, { __readerWarmProbe: state });
        const observer = new MutationObserver(() => {
          const stage = document.querySelector("[data-reader-phase]");
          if (stage?.getAttribute("data-reader-phase") !== "active") return;
          state.elapsed = performance.now() - state.startedAt;
          observer.disconnect();
        });
        const stage = document.querySelector("[data-reader-phase]");
        if (!stage) throw new Error("Reader stage unavailable");
        observer.observe(stage, { attributes: true, attributeFilter: ["data-reader-phase"] });
      });

      await openButton.click();
      await expect(page.locator("[data-reader-phase]")).toHaveAttribute(
        "data-reader-phase",
        "active",
      );
      const elapsed = await page.evaluate(() => (
        window as typeof window & {
          __readerWarmProbe: { elapsed: number | null };
        }
      ).__readerWarmProbe.elapsed);
      expect(elapsed).not.toBeNull();
      samples.push(elapsed!);

      await expect(frame).toHaveAttribute("data-retained-probe", "original-rendition");
      await expect(runner.locator("html")).toHaveAttribute("data-spine-index", "1");
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-reader-phase]")).toHaveAttribute(
        "data-reader-phase",
        "suspended",
      );
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    test.info().annotations.push({
      type: "reader-warm-open-p95-ms",
      description: p95.toFixed(1),
    });
    expect(p95).toBeLessThanOrEqual(150);
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(fixtureRoot, tempRemovalOptions);
    await rm(dataRoot, tempRemovalOptions);
  }
});

test("records a read-only cold-open sample from the optional real EPUB corpus", async () => {
  test.skip(!realPerformanceEpub, "Set READER_PERFORMANCE_EPUB to a read-only EPUB path.");
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-real-open-data-"));
  let application: ElectronApplication | undefined;

  try {
    const launched = await launchReader(dataRoot, realPerformanceEpub!);
    application = launched.application;
    const { page } = launched;
    const openButton = page.locator('button[aria-label^="打开《"]').first();
    await expect(openButton).toBeVisible();
    await page.evaluate(() => {
      const state = { startedAt: null as number | null, readyElapsed: null as number | null };
      Object.assign(window, { __readerRealColdProbe: state });
      document.addEventListener("pointerdown", () => {
        state.startedAt ??= performance.now();
      }, { capture: true, once: true });
      const observer = new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>(
          'iframe[title="EPUB 正文"]',
        );
        if (
          frame?.getAttribute("data-ready") !== "true"
          || state.startedAt === null
        ) return;
        state.readyElapsed = performance.now() - state.startedAt;
        observer.disconnect();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-ready"],
      });
    });

    await openButton.click();
    await expect(
      page.frameLocator('iframe[title="EPUB 正文"]').locator("html"),
    ).toHaveAttribute("data-ready", "true");
    const elapsed = await page.evaluate(() => (
      window as typeof window & {
        __readerRealColdProbe: { readyElapsed: number | null };
      }
    ).__readerRealColdProbe.readyElapsed);
    expect(elapsed).not.toBeNull();
    console.log(`reader-real-corpus-cold-open-ms=${elapsed!.toFixed(1)}`);
    test.info().annotations.push({
      type: "reader-real-corpus-cold-open-ms",
      description: elapsed!.toFixed(1),
    });
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(dataRoot, tempRemovalOptions);
  }
});
