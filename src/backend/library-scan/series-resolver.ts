export type SeriesResolution = {
  normalizedTitle: string;
  normalizedSeries: string;
  volumeLabel: string | null;
  volumeIndex: number | null;
  confidence: number;
  ruleCodes: string[];
};

const CHINESE_DIGITS: Record<string, number> = {
  "零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
  "十": 10, "百": 100, "千": 1000, "万": 10000,
};

function parseChineseNumber(text: string): number | null {
  if (!text) return null;
  // Simple cases: single digit, 十X, X十X, 百, etc.
  if (text.length === 1 && CHINESE_DIGITS[text] !== undefined) {
    return CHINESE_DIGITS[text];
  }
  if (text === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(text)) {
    return 10 + CHINESE_DIGITS[text[1]];
  }
  if (/^[一二三四五六七八九]十$/.test(text)) {
    return CHINESE_DIGITS[text[0]] * 10;
  }
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) {
    return CHINESE_DIGITS[text[0]] * 10 + CHINESE_DIGITS[text[2]];
  }
  return null;
}

// Full-width to half-width mapping
function normalizeFullWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  ).replace(/\u3000/g, " ");
}

function stripBracketTags(text: string): string {
  // Remove [xxx] tags and 【xxx】 tags
  return text.replace(/[\[【][^\]】]*[\]】]/g, "").trim();
}

function stripDownloadPrefixes(text: string): string {
  // Remove common prefixes
  return text.replace(/^\[?[^\]]*?(?:轻之国度|轻小说|下载|DMZJ|动漫之家|转载)[^\]]*?\]?\s*/gi, "").trim();
}

const VOLUME_PATTERNS: Array<{
  regex: RegExp;
  extract: (m: RegExpMatchArray) => { label: string; index: number | null; series: string };
}> = [
  // 第N卷 / 第N章 (Chinese numbered)
  {
    regex: /^(.*?)\s*第([一二三四五六七八九十百千万\d]+)\s*[卷](?!\S)/u,
    extract: (m) => {
      const raw = m[2];
      const num = /^\d+$/.test(raw) ? parseInt(raw, 10) : parseChineseNumber(raw);
      return { label: `第${raw}卷`, index: num, series: m[1].trim() };
    },
  },
  // 第一卷 patterns (Chinese digit)
  {
    regex: /^(.*?)\s*第([一二三四五六七八九十百千万]+)\s*卷(?!\S)/u,
    extract: (m) => {
      const num = parseChineseNumber(m[2]);
      return { label: `第${m[2]}卷`, index: num, series: m[1].trim() };
    },
  },
  // Vol.N / Vol N
  {
    regex: /^(.*?)\s*Vol\.?\s*(\d+)/i,
    extract: (m) => {
      const num = parseInt(m[2], 10);
      return { label: `Vol.${m[2]}`, index: num, series: m[1].trim() };
    },
  },
  // Volume N
  {
    regex: /^(.*?)\s*Volume\s+(\d+)/i,
    extract: (m) => {
      const num = parseInt(m[2], 10);
      return { label: `Volume ${m[2]}`, index: num, series: m[1].trim() };
    },
  },
  // 上卷/中卷/下卷
  {
    regex: /^(.*?)\s*([上中下])\s*卷(?!\S)/u,
    extract: (m) => ({ label: `${m[2]}卷`, index: null, series: m[1].trim() }),
  },
  // 上篇/中篇/下篇
  {
    regex: /^(.*?)\s*([上中下])\s*篇(?!\S)/u,
    extract: (m) => ({ label: `${m[2]}篇`, index: null, series: m[1].trim() }),
  },
  // 短篇集
  {
    regex: /^(.*?)\s*(短篇集)(?!\S)/u,
    extract: (m) => ({ label: "短篇集", index: null, series: m[1].trim() }),
  },
  // 外传
  {
    regex: /^(.*?)\s*(外传)(?!\S)/u,
    extract: (m) => ({ label: "外传", index: null, series: m[1].trim() }),
  },
];

function isNumericTitleWord(text: string): boolean {
  // Check if the title is just a number or starts with a number that's part of the title
  // e.g., "86—不存在的战区—" or "Re:从零开始的异世界生活 01"
  return /^\d+/.test(text) && !/\d+[卷章节篇部]/.test(text);
}

export function resolveSeries(input: {
  metadataTitle: string;
  displayFileName: string;
}): SeriesResolution {
  const rawTitle = input.metadataTitle || input.displayFileName;
  let cleaned = normalizeFullWidth(rawTitle);
  cleaned = stripBracketTags(cleaned);
  cleaned = stripDownloadPrefixes(cleaned);

  const ruleCodes: string[] = [];

  for (const pattern of VOLUME_PATTERNS) {
    const match = cleaned.match(pattern.regex);
    if (match) {
      const result = pattern.extract(match);
      // Guard: don't treat numeric title words as volume numbers
      // (e.g., "86—不存在的战区—" should not parse as volume 86)
      const seriesBeforeVolume = result.series;
      if (isNumericTitleWord(seriesBeforeVolume) && result.index !== null && result.index > 0) {
        // The "number" before the volume marker is likely part of the title
        continue;
      }

      ruleCodes.push("volume_pattern_match");

      return {
        normalizedTitle: result.series,
        normalizedSeries: result.series,
        volumeLabel: result.label,
        volumeIndex: result.index,
        confidence: 0.9,
        ruleCodes,
      };
    }
  }

  return {
    normalizedTitle: cleaned,
    normalizedSeries: cleaned,
    volumeLabel: null,
    volumeIndex: null,
    confidence: 0.5,
    ruleCodes: ["no_volume_detected"],
  };
}
