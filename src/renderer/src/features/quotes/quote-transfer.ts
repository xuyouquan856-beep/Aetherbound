export type ImportedQuote = {
  text: string;
  author: string;
  bookTitle: string;
  note?: string;
  color?: "cyan" | "yellow" | "pink";
  excerpt?: string;
  sourceUrl?: string;
  enabled: boolean;
};

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch { return undefined; }
}

export function parseQuoteImport(raw: string, existingTexts: string[]): { items: ImportedQuote[]; skipped: number } {
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error("每次最多读取 2 MB。 ");
  const parsed: unknown = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { items?: unknown }).items : null;
  if (!Array.isArray(entries)) throw new Error("JSON 需要是摘录数组，或包含 items 数组。");
  if (entries.length > 500) throw new Error("每次最多导入 500 条。");
  const seen = new Set(existingTexts.map((value) => value.trim()).filter(Boolean));
  const items: ImportedQuote[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.text !== "string") { skipped++; continue; }
    const text = entry.text.trim();
    if (!text || text.length > 8000 || seen.has(text)) { skipped++; continue; }
    seen.add(text);
    const author = typeof entry.author === "string" ? entry.author.trim().slice(0, 150) : "";
    const bookTitle = typeof entry.bookTitle === "string" ? entry.bookTitle.trim().slice(0, 200)
      : typeof entry.work === "string" ? entry.work.trim().slice(0, 200) : "";
    const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 2000) : undefined;
    const color = entry.color === "cyan" || entry.color === "yellow" || entry.color === "pink" ? entry.color : undefined;
    const excerpt = typeof entry.excerpt === "string" ? entry.excerpt.trim().slice(0, 220) : undefined;
    const sourceUrl = safeHttpUrl(entry.sourceUrl ?? entry.url);
    items.push({ text, author, bookTitle, ...(note ? { note } : {}), ...(color ? { color } : {}),
      ...(excerpt ? { excerpt } : {}), ...(sourceUrl ? { sourceUrl } : {}),
      enabled: entry.enabled !== false && (excerpt || text).length <= 220 });
  }
  return { items, skipped };
}
