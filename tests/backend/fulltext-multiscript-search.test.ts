import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextIndexer, type TextUnit } from "../../src/backend/indexing/text-indexer.js";
import { migrate } from "../../src/backend/storage/database.js";

/**
 * Japanese matters for this app's audience: light novels frequently ship with an
 * untranslated Japanese table of contents over a translated body, so chapter titles
 * and prose can be in different scripts (and languages) within one file. The same
 * reasoning applies to Korean, Cyrillic and accented Latin translations.
 */
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});

afterEach(() => db.close());

function seedBook(bookId: string, title: string) {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO books(id,title,format,created_at,updated_at) VALUES (?,?,'txt',?,?)")
    .run(bookId, title, now, now);
  db.prepare(`
    INSERT INTO book_sources(
      id, book_id, source_path, quick_fingerprint_version, quick_fingerprint,
      file_size, modified_at, source_revision, availability_status, verified_at
    ) VALUES (?,?,?,1,?,10,?,?,'available',?)
  `).run(`src-${bookId}`, bookId, `/${bookId}.txt`, "fp", now, `rev-${bookId}`, now);
}

async function indexText(bookId: string, text: string) {
  const indexer = new TextIndexer(db, async function* (): AsyncIterable<TextUnit> {
    yield { unitIndex: 0, content: text, charCount: text.length };
  });
  await indexer.indexBook(bookId);
  return indexer;
}

const LIGHT_NOVEL = [
  "第一章 風立ちぬ",
  "彼は静かに微笑んだ。",
  "第二章 桜の木の下で",
  "プロローグは終わった。",
  "第三章 魔王、転生する",
].join("\n");

describe("Japanese full-text search", () => {
  it("finds kanji substrings", async () => {
    seedBook("b1", "転生したら");
    const indexer = await indexText("b1", LIGHT_NOVEL);

    expect(indexer.search("風立ちぬ")).toHaveLength(1);
    expect(indexer.search("桜の木の下")).toHaveLength(1);
    expect(indexer.search("魔王、転生")).toHaveLength(1);
  });

  it("finds katakana and hiragana substrings", async () => {
    seedBook("b1", "転生したら");
    const indexer = await indexText("b1", LIGHT_NOVEL);

    expect(indexer.search("プロローグ")).toHaveLength(1);
    expect(indexer.search("静かに微笑")).toHaveLength(1);
  });

  it("finds substrings that mix scripts", async () => {
    seedBook("b1", "転生したら");
    const indexer = await indexText("b1", LIGHT_NOVEL);

    // Hiragana joining two kanji, and kanji joining hiragana.
    expect(indexer.search("の木の")).toHaveLength(1);
    expect(indexer.search("生する")).toHaveLength(1);
  });

  it("supports two-character Japanese queries through the fallback", async () => {
    seedBook("b1", "転生したら");
    const indexer = await indexText("b1", LIGHT_NOVEL);

    // Trigram cannot match fewer than three characters, so these exercise LIKE.
    expect(indexer.search("風立")).toHaveLength(1);
    expect(indexer.search("プロ")).toHaveLength(1);
    expect(indexer.search("かに")).toHaveLength(1);
  });

  it("supports a single-character query", async () => {
    seedBook("b1", "転生したら");
    const indexer = await indexText("b1", LIGHT_NOVEL);

    const hits = indexer.search("桜");
    expect(hits).toHaveLength(1);
    expect(hits[0].matchSnippet).toContain("桜");
  });

  it("searches a Japanese title over a Chinese body in the same file", async () => {
    // The realistic light-novel case: untranslated TOC, translated prose.
    seedBook("b2", "風立ちぬ");
    const indexer = await indexText(
      "b2",
      "第一章 風立ちぬ\n他静静地微笑着。\n第二章 桜の木の下で\n序章到此结束。",
    );

    expect(indexer.search("風立ちぬ")).toHaveLength(1);
    expect(indexer.search("静かに" )).toHaveLength(0);
    expect(indexer.search("微笑着")).toHaveLength(1);
    expect(indexer.search("序章")).toHaveLength(1);
  });

  it("finds Japanese text in every indexed book", async () => {
    seedBook("b1", "一冊目");
    seedBook("b2", "二冊目");
    const indexer = new TextIndexer(db, async function* (bookId) {
      const text = bookId === "b1" ? "第一巻 風立ちぬ" : "第二巻 風立ちぬ続編";
      yield { unitIndex: 0, content: text, charCount: text.length };
    });
    await indexer.indexBook("b1");
    await indexer.indexBook("b2");

    expect(indexer.search("風立ちぬ").map((hit) => hit.bookId).sort())
      .toEqual(["b1", "b2"]);
  });

  it("indexes ruby text without losing the base text", async () => {
    // foliate/linkedom extract textContent, so a ruby annotation yields base +
    // reading concatenated. Both must remain findable.
    seedBook("b3", "ルビ");
    const extractorText = "第一章 彼女は走った";
    const indexer = await indexText("b3", extractorText);

    expect(indexer.search("彼女")).toHaveLength(1);
    expect(indexer.search("走った")).toHaveLength(1);
  });
});

describe("other scripts a light-novel library may contain", () => {
  it("handles Korean hangul", async () => {
    seedBook("k1", "한국어");
    const indexer = await indexText("k1", "첫 번째 장 폭풍이 몰아친다");

    expect(indexer.search("폭풍이")).toHaveLength(1);
    expect(indexer.search("몰아친")).toHaveLength(1);
    // Two-character fallback path.
    expect(indexer.search("폭풍")).toHaveLength(1);
  });

  it("handles Cyrillic transliterated light novels", async () => {
    seedBook("r1", "Перевод");
    const indexer = await indexText("r1", "Глава первая буря на море");

    expect(indexer.search("буря")).toHaveLength(1);
    expect(indexer.search("Глава")).toHaveLength(1);
  });

  it("handles accented Latin text", async () => {
    seedBook("a1", "Français");
    const indexer = await indexText("a1", "Le café était déjà ouvert");

    expect(indexer.search("café")).toHaveLength(1);
    expect(indexer.search("déjà")).toHaveLength(1);
  });

  it("matches full-width Latin and digits used in CJK typesetting", async () => {
    seedBook("f1", "全角");
    const indexer = await indexText("f1", "第１章 ＶＯＬＵＭＥ　ＯＮＥ の始まり");

    expect(indexer.search("第１章")).toHaveLength(1);
    expect(indexer.search("ＶＯＬＵＭＥ")).toHaveLength(1);
  });
});
