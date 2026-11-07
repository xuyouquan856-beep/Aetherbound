import type { ChapterSummary, TxtReadingLocationV1 } from "../../shared/contracts.js";

type CreateInput = {
  sourceRevision: string;
  chapter: ChapterSummary;
  chapterText: string;
  characterOffset: number;
  totalProgression?: number;
  points?: readonly string[];
};

export function createTxtLocator(input: CreateInput): TxtReadingLocationV1 {
  const points = input.points ?? [...input.chapterText];
  const offset = Math.max(0, Math.min(points.length, input.characterOffset));
  const exact = points.slice(offset, offset + 16).join("");
  const exactLength = Math.min(16, Math.max(0, points.length - offset));
  return {
    locatorVersion: 1,
    sourceRevision: input.sourceRevision,
    format: "txt",
    primary: { kind: "txt", chapterId: input.chapter.id, characterOffset: offset },
    progression: { resource: points.length ? offset / points.length : 0, total: input.totalProgression },
    text: {
      exact,
      prefix: points.slice(Math.max(0, offset - 32), offset).join(""),
      suffix: points.slice(offset + exactLength, offset + exactLength + 32).join(""),
    },
  };
}

export function restoreTxtLocator(chapterText: string, locator: TxtReadingLocationV1) {
  const points = [...chapterText];
  const offset = Math.min(locator.primary.characterOffset, points.length);
  const exactLength = [...locator.text.exact].length;
  if (locator.text.exact && points.slice(offset, offset + exactLength).join("") === locator.text.exact) {
    return { status: "exact" as const, characterOffset: offset };
  }
  const source = points.join("");
  const matches: number[] = [];
  let fromCodeUnit = 0;
  while (locator.text.exact) {
    const found = source.indexOf(locator.text.exact, fromCodeUnit);
    if (found < 0) break;
    matches.push([...source.slice(0, found)].length);
    fromCodeUnit = found + Math.max(1, locator.text.exact.length);
  }
  if (matches.length) {
    const contextual = matches.filter((candidate) => {
      const prefix = points.slice(Math.max(0, candidate - [...locator.text.prefix].length), candidate).join("");
      const suffix = points.slice(candidate + exactLength, candidate + exactLength + [...locator.text.suffix].length).join("");
      return (!locator.text.prefix || prefix === locator.text.prefix) && (!locator.text.suffix || suffix === locator.text.suffix);
    });
    const usable = contextual.length ? contextual : exactLength >= 4 ? matches : [];
    if (!usable.length) return { status: "progression" as const, characterOffset: Math.round(locator.progression.resource * points.length) };
    const target = locator.progression.resource * points.length;
    const closest = usable.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    return { status: "quote" as const, characterOffset: closest };
  }
  return { status: "progression" as const, characterOffset: Math.round(locator.progression.resource * points.length) };
}

type ChapterText = { chapter: ChapterSummary; text: string };

export function reanchorTxtLocation(chapters: ChapterText[], locator: TxtReadingLocationV1, sourceRevision: string): TxtReadingLocationV1 {
  if (!chapters.length) throw new Error("Cannot reanchor a TXT location without chapters.");
  const totalTarget = locator.progression.total ?? 0;
  const quoteMatches = chapters.flatMap((item) => {
    if (!locator.text.exact || !item.text.includes(locator.text.exact)) return [];
    const restored = restoreTxtLocator(item.text, locator);
    if (restored.status === "progression") return [];
    const length = Math.max(1, [...item.text].length);
    const total = (item.chapter.index + restored.characterOffset / length) / chapters.length;
    return [{ ...item, characterOffset: restored.characterOffset, distance: Math.abs(total - totalTarget) }];
  });
  const match = quoteMatches.sort((left, right) => left.distance - right.distance)[0];
  if (match) {
    const resource = match.characterOffset / Math.max(1, [...match.text].length);
    return createTxtLocator({
      sourceRevision,
      chapter: match.chapter,
      chapterText: match.text,
      characterOffset: match.characterOffset,
      totalProgression: (match.chapter.index + resource) / chapters.length,
    });
  }

  const targetIndex = Math.min(chapters.length - 1, Math.max(0, Math.floor(totalTarget * chapters.length)));
  const fallback = chapters[targetIndex];
  const characterOffset = Math.round(locator.progression.resource * [...fallback.text].length);
  return createTxtLocator({
    sourceRevision,
    chapter: fallback.chapter,
    chapterText: fallback.text,
    characterOffset,
    totalProgression: (fallback.chapter.index + locator.progression.resource) / chapters.length,
  });
}
