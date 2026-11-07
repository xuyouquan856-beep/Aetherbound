import { createHash } from "node:crypto";
import type { ChapterSummary } from "../../shared/contracts.js";

export type ParsedTxtDocument = {
  title: string;
  author: string | null;
  text: string;
  chapters: ChapterSummary[];
};

const HEADING = /^[ \t\u3000]*(?:#{1,6}[ \t\u3000]*)?(?:(\u7b2c([0-9\uff10-\uff19\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u96f6\u3007\u4e24]+)([\u8bdd\u7ae0\u8282\u5377\u56de]))([^\r\n]{0,80})|(Chapter[ \t]+\d+)([^\r\n]{0,80})|((?:序章|楔子|引子|序言|终章|尾声|后记|番外)(?:[ \t\u3000：:][^\r\n]{0,40})?))[ \t\u3000]*$/gim;

type Candidate = { title: string; marker: string; startOffset: number };

function stableChapterId(revision: string, title: string, start: number) {
  const hash = createHash("sha256").update(`${revision}\0${title.normalize("NFKC")}\0${start}`).digest("hex").slice(0, 16);
  return `txt-${hash}`;
}

function metadata(text: string, fallbackTitle?: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0]?.replace(/^#+\s*/, "").trim() || "";
  const authorLine = lines.slice(0, 5).find(
    (line) => /^(?:作者|著|Author)\s*[：:]/i.test(line) || /^[^\[]+?\s*\[(?:https?:)?\/\//i.test(line),
  );
  const authorMatch = authorLine?.match(/^(?:作者|著|Author)\s*[：:]\s*([^\r\n\[]+)/i)
    ?? authorLine?.match(/^([^\[]+?)\s*\[(?:https?:)?\/\//i);
  const firstLineLooksLikeHeadingOrBody = !firstLine
    || firstLine.length > 60
    || /^(?:第[0-9\uff10-\uff19一二三四五六七八九十百千零〇两]+[话章节卷回]|Chapter\s+\d+|序章|楔子|引子|内容简介|简介)(?:[\s：:]|$)/i.test(firstLine);
  const cleanFallback = fallbackTitle?.replace(/\.txt$/i, "").replace(/^《|》$/g, "").trim();
  const title = (firstLineLooksLikeHeadingOrBody && cleanFallback)
    ? cleanFallback
    : (firstLine.replace(/^《|》$/g, "").trim() || cleanFallback || "\u672a\u547d\u540d\u4e66\u7c4d");
  return { title, author: authorMatch?.[1]?.trim() || null };
}

function findCandidates(text: string): Candidate[] {
  return [...text.matchAll(HEADING)].map((match) => ({
    title: (match[7] ? match[7] : `${match[1] || match[5]}${match[4] || match[6] || ""}`).replace(/[ \t\u3000]+/g, " ").trim(),
    marker: match[7] ? "special" : (match[3] || "chapter"),
    startOffset: match.index ?? 0,
  }));
}

function keepDominantHeadingKind(candidates: Candidate[]) {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.marker === "special") continue;
    counts.set(candidate.marker, (counts.get(candidate.marker) ?? 0) + 1);
  }
  const maximum = Math.max(0, ...counts.values());
  if (maximum < 2) return candidates;
  return candidates.filter((candidate) => candidate.marker === "special" || counts.get(candidate.marker) === maximum);
}

export function parseTxtDocument(text: string, sourceRevision: string, fallbackTitle?: string): ParsedTxtDocument {
  const info = metadata(text, fallbackTitle);
  const candidates = keepDominantHeadingKind(findCandidates(text));
  if (candidates.length < 2) {
    return {
      ...info,
      text,
      chapters: [{ id: stableChapterId(sourceRevision, "\u6b63\u6587", 0), title: "\u6b63\u6587", index: 0, startOffset: 0, endOffset: text.length }],
    };
  }
  const chapters = candidates.map((candidate, index): ChapterSummary => {
    const endOffset = index + 1 < candidates.length ? candidates[index + 1].startOffset : text.length;
    return {
      id: stableChapterId(sourceRevision, candidate.title, candidate.startOffset),
      title: candidate.title,
      index,
      startOffset: candidate.startOffset,
      endOffset,
    };
  });
  return { ...info, text, chapters };
}
