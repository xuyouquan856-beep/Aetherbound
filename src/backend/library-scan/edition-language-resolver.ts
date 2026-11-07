export type EditionResult = "web" | "bunko" | "unknown";
export type LanguageResult = "translated_zh" | "original_ja" | "bilingual_ja_zh" | "unknown";

export interface EditionAndLanguageInput {
  title: string;
  author?: string;
  dcLanguage?: string;
  metadataSource: "txt-head" | "epub-opf";
}

export interface EditionAndLanguageOutput {
  edition: EditionResult;
  language: LanguageResult;
  confidence: number;
  evidence: string[];
}

// Unicode ranges for CJK and kana
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/g;
const CJK_OR_KANA_RE = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g;

function computeKanaRatio(text: string): { ratio: number; totalCjkKana: number } {
  const kanaCount = (text.match(KANA_RE) ?? []).length;
  const cjkKanaCount = (text.match(CJK_OR_KANA_RE) ?? []).length;
  if (cjkKanaCount === 0) return { ratio: 0, totalCjkKana: 0 };
  return { ratio: kanaCount / cjkKanaCount, totalCjkKana: cjkKanaCount };
}

function detectEdition(title: string, author?: string): { edition: EditionResult; evidence: string[] } {
  const combined = [title, author].filter(Boolean).join(" ");
  const lower = combined.toLowerCase();

  const webPatterns = ["web", "連載", "なろう", "小説家になろう"];
  const bunkoPatterns = ["文庫", "単行本", "文庫本", "bunko"];

  for (const pattern of webPatterns) {
    if (combined.includes(pattern) || lower.includes(pattern)) {
      return { edition: "web", evidence: ["web_label_in_title"] };
    }
  }
  for (const pattern of bunkoPatterns) {
    if (combined.includes(pattern) || lower.includes(pattern)) {
      return { edition: "bunko", evidence: ["bunko_label_in_title"] };
    }
  }
  return { edition: "unknown", evidence: [] };
}

function detectLanguage(
  title: string,
  author: string | undefined,
  dcLanguage: string | undefined,
): { language: LanguageResult; evidence: string[] } {
  // EPUB dc:language takes priority
  if (dcLanguage === "ja") {
    return { language: "original_ja", evidence: ["dc_language_ja"] };
  }
  if (dcLanguage === "zh") {
    return { language: "translated_zh", evidence: ["dc_language_zh"] };
  }

  const combined = [title, author].filter(Boolean).join(" ");
  const { ratio, totalCjkKana } = computeKanaRatio(combined);

  if (totalCjkKana === 0) return { language: "unknown", evidence: [] };

  if (ratio > 0.6) {
    return { language: "original_ja", evidence: ["kana_ratio_high"] };
  }
  if (ratio > 0.15) {
    return { language: "bilingual_ja_zh", evidence: ["kana_ratio_moderate"] };
  }
  return { language: "translated_zh", evidence: ["kana_ratio_below_threshold"] };
}

function computeConfidence(edition: EditionResult, language: LanguageResult): number {
  if (edition === "unknown" && language === "unknown") return 0;
  let score = 0;
  if (language !== "unknown") score += 0.5;
  if (edition !== "unknown") score += 0.3;
  if (language === "original_ja" || language === "translated_zh") score += 0.2;
  return Math.min(score, 1);
}

export function resolveEditionAndLanguage(input: EditionAndLanguageInput): EditionAndLanguageOutput {
  const { title, author, dcLanguage } = input;
  const editionResult = detectEdition(title, author);
  const languageResult = detectLanguage(title, author, dcLanguage);

  const evidence = [...editionResult.evidence, ...languageResult.evidence];
  const confidence = computeConfidence(editionResult.edition, languageResult.language);

  return {
    edition: editionResult.edition,
    language: languageResult.language,
    confidence,
    evidence,
  };
}
