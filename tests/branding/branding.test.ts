import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Aetherbound branding", () => {
  it("uses the approved name and icon across runtime and packaging surfaces", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; productName: string };
    const [builder, html, main, ipc, library] = await Promise.all([
      readFile("electron-builder.yml", "utf8"),
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/main/index.ts", "utf8"),
      readFile("src/main/ipc/register-ipc.ts", "utf8"),
      readFile("src/renderer/src/features/shell/Sidebar.tsx", "utf8"),
    ]);

    expect(packageJson).toMatchObject({ name: "aetherbound", productName: "Aetherbound" });
    expect(builder).toContain("appId: io.github.xuyouquan856-beep.aetherbound");
    expect(builder).toContain("productName: Aetherbound");
    expect(builder).toContain("icon: build/reader-icon-v2.ico");
    expect(html).toContain("<title>Aetherbound</title>");
    expect(main).toContain('app.setAppUserModelId("io.github.xuyouquan856-beep.aetherbound")');
    expect(main).toContain('"build", "reader-icon-v2.ico"');
    expect(ipc).toContain('name: "Aetherbound"');
    expect(library).toContain('aria-label="Aetherbound 书库"');
    expect(library).toContain("Aetherbound");
  });
});
