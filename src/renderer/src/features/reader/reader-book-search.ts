import type { ChapterContent, ChapterSummary } from "../../../../shared/contracts.js";
import { createTxtLocator } from "../../../../formats/txt/locator.js";
import type { ReaderSearchResult } from "../../renditions/reading-tools.js";

/** Read chapters sequentially, yielding between them; never load the entire book at once. */
export async function searchTxtBook(
  bookId: string,
  chapters: ChapterSummary[],
  getChapter: (bookId: string, chapterId: string) => Promise<ChapterContent>,
  query: string,
  isCurrent = () => true,
): Promise<ReaderSearchResult[]> {
  const needle = query.trim();
  if (!needle) return [];
  const lowerNeedle = needle.toLocaleLowerCase();
  const needleCodePoints = [...needle].length;
  const results: ReaderSearchResult[] = [];
  for (const chapter of chapters) {
    if (!isCurrent()) return [];
    const content = await getChapter(bookId, chapter.id);
    if (!isCurrent()) return [];
    const lowerText = content.text.toLocaleLowerCase();
    let points: string[] | null = null;
    let lastCodeUnit = 0;
    let lastCodePoint = 0;
    let from = 0;
    while (results.length < 200) {
      const found = lowerText.indexOf(lowerNeedle, from);
      if (found < 0) break;
      const chapterPoints = (points ??= [...content.text]);
      const offset = lastCodePoint + [...content.text.slice(lastCodeUnit, found)].length;
      lastCodeUnit = found;
      lastCodePoint = offset;
      const makeLocation = (characterOffset: number) => createTxtLocator({
        sourceRevision: content.sourceRevision,
        chapter,
        chapterText: content.text,
        characterOffset,
        points: chapterPoints,
        totalProgression: (chapter.index + characterOffset / Math.max(1, chapterPoints.length)) / Math.max(1, chapters.length),
      });
      results.push({
        id: `${chapter.id}:${offset}`,
        text: `${chapter.title} · ${content.text.slice(Math.max(0, found - 35), found + needle.length + 65)}`,
        location: makeLocation(offset),
        endLocation: makeLocation(offset + needleCodePoints),
      });
      from = found + Math.max(1, lowerNeedle.length);
    }
    if (results.length >= 200) break;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return results;
}
