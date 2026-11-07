import { expect, test, _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("opening the same library twice keeps one app window", async () => {
  const executablePath = resolve(process.env.READER_E2E_EXECUTABLE ?? "release/distribution/win-unpacked/Aetherbound.exe");
  test.skip(!existsSync(executablePath), "Build the current packaged app first.");
  const dataRoot = await mkdtemp(join(tmpdir(), "reader-single-instance-"));
  const env = { ...process.env, READER_DATA_ROOT: dataRoot };
  const application = await electron.launch({ executablePath, env });
  try {
    const page = await application.firstWindow();
    await page.waitForURL((url) => url.protocol === "reader-app:");
    await execFileAsync(executablePath, [], { env, timeout: 8_000 });
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.locator("body")).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
});
