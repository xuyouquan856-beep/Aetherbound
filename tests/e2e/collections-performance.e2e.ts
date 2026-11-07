import { expect, test, _electron as electron, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Optional benchmark. It runs only against a profile explicitly supplied by the caller. */
const benchmarkDataRoot = process.env.READER_BENCH_DATA_ROOT;

async function launchReader(dataRoot: string) {
  const application = await electron.launch({
    args: [resolve("out/main/index.js")],
    env: { ...process.env, READER_DATA_ROOT: dataRoot },
  });
  const page = await application.firstWindow();
  await page.waitForURL((url) => url.protocol === "reader-app:");
  await page.waitForLoadState("domcontentloaded");
  return { application, page };
}

test("collections cover loading and scroll cost", async () => {
  test.skip(!benchmarkDataRoot, "Set READER_BENCH_DATA_ROOT to an isolated benchmark profile.");
  test.setTimeout(240_000);
  const step = (label: string) => console.log(`[bench] ${label} @${Date.now() % 100000}`);
  step("start");
  const scratch = await mkdtemp(join(tmpdir(), "reader-collections-bench-"));
  let application: ElectronApplication | undefined;

  try {
    step("launching");
    const launched = await launchReader(benchmarkDataRoot!);
    application = launched.application;
    const { page } = launched;
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`[renderer] ${message.text()}`);
    });

    step("waiting for shelf nav");
    const shelfNav = page.getByRole("button", { name: /全部书籍|书架|书籍/ }).first();
    await shelfNav.waitFor({ timeout: 45_000 });
    const navNames = await page.locator("nav button, aside button").allInnerTexts();
    console.log("[bench] nav buttons:", JSON.stringify(navNames.slice(0, 12)));
    step("shelf nav found");

    // Instrument network + paint before navigating.
    await page.evaluate(() => {
      const state = {
        coverRequests: 0,
        coverBytes: 0,
        byType: {} as Record<string, number>,
      };
      Object.assign(window, { __bench: state });
      const originalFetch = window.fetch;
      void originalFetch;
      // Resource Timing is the reliable channel for <img> loads.
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const resource = entry as PerformanceResourceTiming;
          if (!resource.name.includes("reader-resource:")) continue;
          state.coverRequests += 1;
          state.coverBytes += resource.transferSize || resource.encodedBodySize || 0;
          const kind = resource.name.endsWith("cover-thumb") ? "cover-thumb"
            : resource.name.endsWith("cover") ? "cover" : "other";
          state.byType[kind] = (state.byType[kind] ?? 0) + 1;
        }
      });
      observer.observe({ type: "resource", buffered: true });
    });

    const started = Date.now();
    step("clicking 我的珍藏");
    const collectionsNav = page.getByRole("button", { name: /我的珍藏/ }).first();
    console.log("[bench] matches:", await page.getByRole("button", { name: /我的珍藏/ }).count(),
      "visible:", await collectionsNav.isVisible(), "enabled:", await collectionsNav.isEnabled());
    await collectionsNav.click({ timeout: 20_000, force: true });
    step("clicked");
    // The window must be focused: Chromium throttles rAF and defers image decode in
    // background windows, which makes the probes below hang indefinitely.
    await page.bringToFront();
    step("brought to front");
    // All stack covers painted?
    await page.waitForFunction(
      () => document.querySelectorAll(".collection-stack__cover").length > 0,
      { timeout: 60_000 },
    );
    step("stacks painted");
    const stacks = await page.locator(".collection-stack").count();
    const images = await page.locator(".collection-stack__image").count();
    const firstPaintMs = Date.now() - started;
    step(`counted: ${stacks} stacks / ${images} images`);

    // Let images settle, then read the accumulated transfer volume.
    step("settling");
    await page.waitForTimeout(5_000);
    step("settled");

    // Visual confirmation that covers still render: JPEG has no alpha, so a bad
    // flatten would show as black boxes behind transparent covers.
    await page.screenshot({ path: "test-results/collections-covers.png", fullPage: false });
    step("screenshot written");

    // Resource Timing does not expose reader-resource: loads for a custom scheme, so
    // measure the real cost instead: decoded pixel area and decode time. Decoded
    // pixels are what the compositor must downscale on every paint.
    step("measuring decode state");
    const decode = await page.evaluate(async () => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(
        ".collection-stack__image, .book-cover__image",
      ));
      let px = 0;
      let decoded = 0;
      let pending = 0;
      let failed = 0;
      let natural = "";
      const started = performance.now();
      for (const image of images) {
        if (!image.complete) pending += 1;
        else if (image.naturalWidth > 0) {
          decoded += 1;
          px += image.naturalWidth * image.naturalHeight;
          if (!natural) natural = `${image.naturalWidth}x${image.naturalHeight}`;
        } else failed += 1;
      }
      const listed = performance.now() - started;
      return {
        total: images.length, decoded, pending, failed, pixelArea: px, listed, natural,
      };
    });

    step("measuring rasterise cost");
    // Decode only what has entered the viewport. Awaiting decode() on a lazy image
    // below the fold never settles in Chromium, so bound it to in-view elements.
    const decodeMs = await page.evaluate(async () => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(
        ".collection-stack__image",
      )).filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });
      const started = performance.now();
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
      return { ms: performance.now() - started, count: images.length };
    });
    step(`rasterised ${decodeMs.count} in-view covers`);

    step("measuring scroll");
    const scroll = await runScrollProbe(page);
    step("scroll measured");

    console.log("\n===== COLLECTIONS BENCHMARK =====");
    console.log(`stacks rendered         : ${stacks}`);
    console.log(`cover <img> elements    : ${images}`);
    console.log(`first stack paint       : ${firstPaintMs} ms`);
    console.log(`covers decoded          : ${decode.decoded} / ${decode.total}` +
      `  (pending ${decode.pending}, failed ${decode.failed})`);
    console.log(`decoded pixel area      : ${(decode.pixelArea / 1e6).toFixed(1)} MP  (one cover: ${decode.natural})`);
    console.log(`rasterise in-view covers: ${decodeMs.ms.toFixed(0)} ms (${decodeMs.count} covers)`);
    console.log(`scroll frames           : ${scroll.frames} over ${Math.round(scroll.elapsed)} ms`);
    console.log(`frame median / p95 / max: ${scroll.medianMs.toFixed(1)} / ${scroll.p95Ms.toFixed(1)} / ${scroll.worstMs.toFixed(1)} ms`);
    console.log(`frames > 32ms (jank)    : ${scroll.longFrames}`);
    console.log("=================================\n");

    expect(stacks).toBeGreaterThan(0);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

async function runScrollProbe(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(".app-shell__page")
      ?? document.scrollingElement as HTMLElement;
    const frames: number[] = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const start = performance.now();
    for (let i = 0; i < 60; i++) {
      scroller.scrollTop += 120;
      await new Promise((r) => requestAnimationFrame(r));
    }
    running = false;
    const elapsed = performance.now() - start;
    const sorted = frames.slice().sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return {
      frames: frames.length,
      elapsed,
      medianMs: pct(0.5),
      p95Ms: pct(0.95),
      worstMs: sorted[sorted.length - 1] ?? 0,
      longFrames: frames.filter((f) => f > 32).length,
    };
  });
}
