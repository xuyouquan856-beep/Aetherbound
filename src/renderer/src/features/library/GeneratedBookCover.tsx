import { BookOpenText } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { BookSummary } from "../../../../shared/contracts.js";
import { useBookPreference } from "./book-preferences.js";

export const CoverPalettes = [
  { name: "松石深绿", background: "#315b50", foreground: "#f2f7f4", muted: "#bfd2ca" },
  { name: "远山雾蓝", background: "#526273", foreground: "#f5f7fa", muted: "#c8d0d9" },
  { name: "陶土暖棕", background: "#765a4c", foreground: "#fff7f1", muted: "#dfc9bb" },
  { name: "暮色灰紫", background: "#4f5268", foreground: "#f7f6fb", muted: "#cdcedb" },
  { name: "古籍流金", background: "#665638", foreground: "#fff9eb", muted: "#dbcfb2" },
  { name: "青瓷烟灰", background: "#4d5e64", foreground: "#f3f8f9", muted: "#c6d4d7" },
] as const;

function hashCoverSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (const point of value) {
    hash ^= point.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

type GeneratedBookCoverProps = {
  book: BookSummary;
};

export function GeneratedBookCover({ book }: GeneratedBookCoverProps) {
  const pref = useBookPreference(book.id);
  const defaultTone = hashCoverSeed(`${book.id}:${book.title}`) % CoverPalettes.length;
  const tone = typeof pref.coverTone === "number" && pref.coverTone >= 0 && pref.coverTone < CoverPalettes.length
    ? pref.coverTone
    : defaultTone;
  const palette = CoverPalettes[tone]!;
  const style = {
    "--generated-cover-bg": palette.background,
    "--generated-cover-fg": palette.foreground,
    "--generated-cover-muted": palette.muted,
  } as CSSProperties;

  return (
    <span
      className="generated-book-cover"
      data-cover-tone={String(tone)}
      data-testid="generated-book-cover"
      title={book.title}
      style={style}
      aria-hidden="true"
    >
      <span className="generated-book-cover__eyebrow">{book.format.toUpperCase()}</span>
      <span className="generated-book-cover__title">{book.title}</span>
      <span className="generated-book-cover__footer">
        <span className="generated-book-cover__author">{book.author || "未知作者"}</span>
        <BookOpenText size={21} weight="duotone" />
      </span>
    </span>
  );
}
