import { basename, extname } from "node:path";

export type EditionLabel =
  | "web"
  | "print"
  | "side-story"
  | "short-story"
  | "upper"
  | "middle"
  | "lower";

export type TitleFacts = {
  normalizedTitle: string;
  normalizedBaseTitle: string;
  volumeLabel: string | null;
  volumeIndex: number | null;
  editionLabels: EditionLabel[];
  tentativeTrailingNumber: boolean;
};

const DOWNLOAD_PREFIX = /^(?:(?:zh(?:-jp)?\.ysgyb?|zh(?:-jp)?_ysgyb?)\.?\s*)/i;
const LEADING_AUTHOR = /^\[[^\]\r\n]{1,100}\]\s*/;

export function normalizePublicationTitle(value: string): string {
  let result = value.normalize("NFKC").trim();
  const extension = extname(result);
  if (/^\.(?:epub|txt)$/i.test(extension)) result = basename(result, extension);
  result = result.replace(DOWNLOAD_PREFIX, "");
  result = result.replace(LEADING_AUTHOR, "");
  result = result.replace(/[ \t\u3000]+/g, " ").trim();
  return result;
}

const CHINESE_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tens = value.match(/^([一二两兩三四五六七八九])?十([一二三四五六七八九])?$/);
  if (tens) {
    return (tens[1] ? CHINESE_DIGIT[tens[1]] : 1) * 10
      + (tens[2] ? CHINESE_DIGIT[tens[2]] : 0);
  }
  if (value.length === 1 && value in CHINESE_DIGIT) return CHINESE_DIGIT[value];
  return null;
}

function stripEditionLabels(title: string, labels: EditionLabel[]): string {
  let result = title;
  const patterns: Array<[RegExp, EditionLabel]> = [
    [/\s*(?:WEB|Web|web)\s*版?\s*$/u, "web"],
    [/\s*(?:文库版|文庫版|书籍版|書籍版|单行本版|單行本版)\s*$/u, "print"],
    [/\s*(?:外传|外傳|外伝)\s*$/u, "side-story"],
    [/\s*短篇集\s*$/u, "short-story"],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pattern, label] of patterns) {
      if (pattern.test(result)) {
        result = result.replace(pattern, "").trim();
        if (!labels.includes(label)) labels.push(label);
        changed = true;
      }
    }
  }
  return result;
}

export function parseTitleFacts(input: {
  metadataTitle: string | null;
  fileName: string;
}): TitleFacts {
  const normalizedTitle = normalizePublicationTitle(
    input.metadataTitle?.trim() || input.fileName,
  );
  const editionLabels: EditionLabel[] = [];
  let base = stripEditionLabels(normalizedTitle, editionLabels);
  let volumeLabel: string | null = null;
  let volumeIndex: number | null = null;
  let tentativeTrailingNumber = false;

  const positioned = base.match(/^(.*?)\s*(上|中|下)(?:卷|篇)\s*$/u);
  if (positioned) {
    base = positioned[1].trim();
    volumeLabel = positioned[2];
    const label = positioned[2] === "上" ? "upper" : positioned[2] === "中" ? "middle" : "lower";
    editionLabels.push(label);
  } else {
    const explicit = base.match(/^(.*?)\s*(?:第\s*([零〇一二两兩三四五六七八九十\d]+)\s*卷|Vol(?:ume)?\.?\s*(\d+))\s*$/iu);
    if (explicit) {
      const raw = explicit[2] ?? explicit[3];
      base = explicit[1].trim();
      volumeLabel = raw;
      volumeIndex = parseChineseNumber(raw);
    } else {
      const trailing = base.match(/^(.*?)\s+(\d{1,3})\s*$/u);
      if (trailing) {
        const candidate = trailing[1].trim();
        const significantLength = candidate.replace(/[\p{P}\p{S}\s]/gu, "").length;
        if (significantLength >= 4) {
          base = candidate;
          volumeLabel = trailing[2];
          volumeIndex = Number(trailing[2]);
          tentativeTrailingNumber = true;
        }
      }
    }
  }

  return {
    normalizedTitle,
    normalizedBaseTitle: base,
    volumeLabel,
    volumeIndex,
    editionLabels,
    tentativeTrailingNumber,
  };
}
