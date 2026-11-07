import { describe, expect, it } from "vitest";
// import { resolveSeries } from "../../src/backend/library-scan/series-resolver.js";

describe("resolveSeries", () => {
  const run = async (metadataTitle: string, displayFileName: string) => {
    const { resolveSeries } = await import(
      "../../src/backend/library-scan/series-resolver.js"
    );
    return resolveSeries({ metadataTitle, displayFileName });
  };

  it("extracts 第N卷 pattern", async () => {
    const r = await run("刀剑神域 第1卷", "刀剑神域 第1卷.txt");
    expect(r.normalizedSeries).toBe("刀剑神域");
    expect(r.volumeLabel).toBe("第1卷");
    expect(r.volumeIndex).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("extracts 第一卷 pattern", async () => {
    const r = await run("某小说 第一卷", "某小说 第一卷.txt");
    expect(r.normalizedSeries).toBe("某小说");
    expect(r.volumeIndex).toBe(1);
  });

  it("extracts Vol.01 pattern", async () => {
    const r = await run("Series Name Vol.01", "Series Name Vol.01.txt");
    expect(r.normalizedSeries).toBe("Series Name");
    expect(r.volumeLabel).toBe("Vol.01");
    expect(r.volumeIndex).toBe(1);
  });

  it("extracts Volume 2 pattern", async () => {
    const r = await run("Title Volume 2", "Title Volume 2.txt");
    expect(r.normalizedSeries).toBe("Title");
    expect(r.volumeIndex).toBe(2);
  });

  it("handles 上卷 as label with null index", async () => {
    const r = await run("小说 上卷", "小说 上卷.txt");
    expect(r.volumeLabel).toBe("上卷");
    expect(r.volumeIndex).toBeNull();
  });

  it("handles 中卷", async () => {
    const r = await run("小说 中卷", "小说 中卷.txt");
    expect(r.volumeLabel).toBe("中卷");
    expect(r.volumeIndex).toBeNull();
  });

  it("handles 下卷", async () => {
    const r = await run("小说 下卷", "小说 下卷.txt");
    expect(r.volumeLabel).toBe("下卷");
    expect(r.volumeIndex).toBeNull();
  });

  it("handles 短篇集 as label with null index", async () => {
    const r = await run("小说 短篇集", "小说 短篇集.txt");
    expect(r.volumeLabel).toBe("短篇集");
    expect(r.volumeIndex).toBeNull();
  });

  it("handles 外传 as label with null index", async () => {
    const r = await run("小说 外传", "小说 外传.txt");
    expect(r.volumeLabel).toBe("外传");
    expect(r.volumeIndex).toBeNull();
  });

  it("does not parse 86—不存在的战区— as volume 86", async () => {
    const r = await run("86—不存在的战区—", "86—不存在的战区—.txt");
    expect(r.volumeIndex).toBeNull();
    // 86 is part of the title, not a volume number
  });

  it("strips common download-site prefixes and bracket tags", async () => {
    const r = await run("[轻之国度]刀剑神域 第3卷", "[轻之国度]刀剑神域 第3卷.txt");
    expect(r.normalizedSeries).toBe("刀剑神域");
    expect(r.volumeIndex).toBe(3);
  });

  it("handles title with no volume info", async () => {
    const r = await run("三体", "三体.txt");
    expect(r.normalizedSeries).toBe("三体");
    expect(r.volumeLabel).toBeNull();
    expect(r.volumeIndex).toBeNull();
  });

  it("normalizes full-width characters", async () => {
    const r = await run("Ｓｗｏｒｄ　Ａｒｔ 第２卷", "file.txt");
    expect(r.normalizedSeries).toContain("Sword");
    expect(r.volumeIndex).toBe(2);
  });

  it("is deterministic (same input, same output)", async () => {
    const r1 = await run("测试系列 第5卷", "测试系列 第5卷.txt");
    const r2 = await run("测试系列 第5卷", "测试系列 第5卷.txt");
    expect(r1).toEqual(r2);
  });

  it("same series different volumes share normalized series name", async () => {
    const r1 = await run("某小说 第1卷", "某小说 第1卷.txt");
    const r2 = await run("某小说 第2卷", "某小说 第2卷.txt");
    expect(r1.normalizedSeries).toBe(r2.normalizedSeries);
    expect(r1.volumeIndex).toBe(1);
    expect(r2.volumeIndex).toBe(2);
  });
});
