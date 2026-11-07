import type { BookSummary, CollectionSummary } from "../../../../shared/contracts.js";

export type SeriesSuggestion = {
  key: string;
  name: string;
  bookIds: string[];
  targetCollectionId: string | null;
};

type ParsedTitle = {
  key: string;
  name: string;
  volumeLabel: string | null;
  volumeIndex: number | null;
};

const PROMO_TAG = /電子|电子|特典|限定|書籍化|书籍化|漫画化|コミカライズ|web版|网页版|发售|発売|完結|完结/iu;
const EDITION_TAG = /文庫|文库|ノベル|books|出版社|レーベル|特典|電子|电子|限定版/iu;
const CHINESE_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cleanTitle(value: string): string {
  let title = value.normalize("NFKC").trim();
  for (let index = 0; index < 3; index += 1) {
    const leading = title.match(/^[【\[]([^】\]]+)[】\]]\s*/u);
    if (!leading || !PROMO_TAG.test(leading[1]!)) break;
    title = title.slice(leading[0].length).trim();
  }
  for (let index = 0; index < 2; index += 1) {
    const trailing = title.match(/\s*[（(]([^()（）]+)[)）]\s*$/u);
    if (!trailing || !EDITION_TAG.test(trailing[1]!)) break;
    title = title.slice(0, -trailing[0].length).trim();
  }
  return title;
}

function keyOf(value: string): string {
  return cleanTitle(value).toLocaleLowerCase().replace(/[\s\u3000·・～〜~_:：.,，。!！?？'’"“”「」『』—–-]+/gu, "");
}

function numberOf(value: string): number | null {
  if (/^\d{1,3}$/u.test(value)) return Number(value);
  if (CHINESE_DIGITS[value] !== undefined) return CHINESE_DIGITS[value]!;
  if (value === "十一") return 11;
  if (/^十[一二三四五六七八九]$/u.test(value)) return 10 + CHINESE_DIGITS[value[1]!]!;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]?$/u.test(value)) {
    return CHINESE_DIGITS[value[0]!]! * 10 + (CHINESE_DIGITS[value[2]!] ?? 0);
  }
  return null;
}

export function parseSeriesTitle(title: string): ParsedTitle {
  const cleaned = cleanTitle(title);
  const numbered = [
    /^(.*?)\s*第([零一二三四五六七八九十百千万\d]+)\s*[卷巻册冊部](?:$|[\s:：～〜~（(])/u,
    /^(.*?)\s*(?:vol(?:ume)?\.?\s*)(\d{1,3})(?:$|[\s:：～〜~（(])/iu,
    /^(.*?)[（(](\d{1,3})[)）](?:$|[\s:：～〜~])/u,
    /^(.*?)(?:[\s_:：-]+)(\d{1,3})(?:$|[\s:：～〜~])/u,
    /^(.*?)(\d{1,3})(?:$|[\s～〜~])/u,
  ];
  for (const pattern of numbered) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    const name = match[1]!.trim().replace(/[\s_:：-]+$/u, "");
    const volumeIndex = numberOf(match[2]!);
    if (name.length < 2 || volumeIndex === null || volumeIndex > 200) continue;
    return { key: keyOf(name), name, volumeLabel: match[2]!, volumeIndex };
  }
  const part = cleaned.match(/^(.*?)\s*([上中下])\s*(?:卷|巻|篇)?$/u);
  if (part && part[1]!.trim().length >= 2) {
    const name = part[1]!.trim();
    return { key: keyOf(name), name, volumeLabel: part[2]!, volumeIndex: { 上: 1, 中: 2, 下: 3 }[part[2]!] ?? null };
  }
  return { key: keyOf(cleaned), name: cleaned, volumeLabel: null, volumeIndex: null };
}

function sortVolumes(left: BookSummary, right: BookSummary): number {
  const a = parseSeriesTitle(left.title).volumeIndex;
  const b = parseSeriesTitle(right.title).volumeIndex;
  if (a !== b) return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
  return left.title.localeCompare(right.title);
}

export function findSeriesSuggestions(
  books: readonly BookSummary[],
  collections: readonly CollectionSummary[],
): SeriesSuggestion[] {
  const collectionByKey = new Map<string, string | null>();
  for (const collection of collections) {
    const keys = new Set([keyOf(collection.name)]);
    for (const book of collection.previewBooks) {
      const parsed = parseSeriesTitle(book.title);
      if (parsed.volumeLabel !== null) keys.add(parsed.key);
    }
    for (const key of keys) {
      if (!key) continue;
      const prior = collectionByKey.get(key);
      collectionByKey.set(key, prior === undefined || prior === collection.id ? collection.id : null);
    }
  }
  const groups = new Map<string, Array<{ book: BookSummary; parsed: ParsedTitle }>>();
  for (const book of books) {
    const parsed = parseSeriesTitle(book.title);
    if (parsed.key.length < 2) continue;
    const group = groups.get(parsed.key) ?? [];
    group.push({ book, parsed });
    groups.set(parsed.key, group);
  }
  const suggestions: SeriesSuggestion[] = [];
  for (const [key, entries] of groups) {
    const numbered = entries.find((item) => item.parsed.volumeLabel !== null);
    const targetCollectionId = collectionByKey.get(key) ?? null;
    if (!numbered || (entries.length < 2 && !targetCollectionId)) continue;
    suggestions.push({
      key,
      name: numbered.parsed.name,
      bookIds: entries.map((item) => item.book).sort(sortVolumes).map((book) => book.id),
      targetCollectionId,
    });
  }
  return suggestions.sort((left, right) => {
    if (Boolean(left.targetCollectionId) !== Boolean(right.targetCollectionId)) {
      return left.targetCollectionId ? -1 : 1;
    }
    return right.bookIds.length - left.bookIds.length || left.name.localeCompare(right.name);
  });
}

export function suggestCollectionAdditions(
  collection: Pick<CollectionSummary, "name"> & { books?: BookSummary[]; previewBooks?: BookSummary[] },
  libraryBooks: readonly BookSummary[],
): string[] {
  const members = collection.books ?? collection.previewBooks ?? [];
  const memberIds = new Set(members.map((book) => book.id));
  const keys = new Set([keyOf(collection.name), ...members.map((book) => parseSeriesTitle(book.title).key)]);
  const numberedKeys = new Set(members
    .map((book) => parseSeriesTitle(book.title))
    .filter((title) => title.volumeLabel !== null)
    .map((title) => title.key));
  return libraryBooks.filter((book) => {
    if (memberIds.has(book.id)) return false;
    const parsed = parseSeriesTitle(book.title);
    return keys.has(parsed.key) && (parsed.volumeLabel !== null || numberedKeys.has(parsed.key));
  }).sort(sortVolumes).map((book) => book.id);
}
