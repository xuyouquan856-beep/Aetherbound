import {
  ClassificationRecordSchema,
  type AliasRecord,
  type ClassificationRecord,
  type EvidenceCode,
  type ManifestEntry,
} from "./contracts.js";
import type { MetadataResult } from "./epub-metadata.js";
import {
  normalizePublicationTitle,
  parseTitleFacts,
  type TitleFacts,
} from "./normalization.js";

export type FolderAudit = {
  folderName: string;
  bookCount: number;
  dominantCanonicalSeries: string | null;
  confirmedInPlace: string[];
  confirmedMissingMembers: string[];
  misplaced: string[];
  probable: string[];
  ambiguous: string[];
  extractionErrors: string[];
};

export type CandidateSeries = {
  canonicalSeriesName: string;
  memberCount: number;
  memberPaths: string[];
};

export type ClassificationOutput = {
  records: ClassificationRecord[];
  folderAudits: FolderAudit[];
  candidateSeries: CandidateSeries[];
};

type WorkingBook = {
  manifest: ManifestEntry;
  metadata: Extract<MetadataResult, { ok: true }>["metadata"] | null;
  facts: TitleFacts;
};

function normalizedKey(value: string): string {
  return normalizePublicationTitle(value)
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

function aliasIndex(aliases: readonly AliasRecord[]) {
  const index = new Map<string, { canonical: string; reviewedAlias: boolean }>();
  for (const record of aliases) {
    const allNames = new Set([record.canonicalSeriesName, ...record.aliases]);
    for (const name of allNames) {
      index.set(normalizedKey(name), {
        canonical: record.canonicalSeriesName,
        reviewedAlias: normalizedKey(name) !== normalizedKey(record.canonicalSeriesName),
      });
    }
  }
  return index;
}

function groupSupportsExactTitle(books: readonly WorkingBook[]): boolean {
  if (books.length < 3) return false;
  const labels = new Set<string>();
  for (const book of books) {
    if (book.facts.volumeIndex !== null) labels.add(`volume:${book.facts.volumeIndex}`);
    for (const edition of book.facts.editionLabels) labels.add(`edition:${edition}`);
  }
  return labels.size >= 3;
}

export function classifyLibrary(input: {
  manifest: readonly ManifestEntry[];
  metadata: readonly MetadataResult[];
  aliases: readonly AliasRecord[];
}): ClassificationOutput {
  const metadataByPath = new Map(input.metadata.map((result) => [result.relativePath, result]));
  const aliases = aliasIndex(input.aliases);
  const canonicalFor = (name: string) => aliases.get(normalizedKey(name))?.canonical
    ?? normalizePublicationTitle(name);
  const isReviewedAlias = (name: string) => aliases.get(normalizedKey(name))?.reviewedAlias ?? false;

  const books: WorkingBook[] = input.manifest.map((manifest) => {
    const result = metadataByPath.get(manifest.relativePath);
    const metadata = result?.ok ? result.metadata : null;
    return {
      manifest,
      metadata,
      facts: parseTitleFacts({
        metadataTitle: metadata?.title ?? null,
        fileName: manifest.relativePath.split("/").at(-1) ?? manifest.relativePath,
      }),
    };
  });

  const titleGroups = new Map<string, WorkingBook[]>();
  for (const book of books) {
    const key = normalizedKey(book.facts.normalizedBaseTitle);
    const group = titleGroups.get(key) ?? [];
    group.push(book);
    titleGroups.set(key, group);
  }
  const confirmedTitleKeys = new Set(
    [...titleGroups.entries()]
      .filter(([, group]) => groupSupportsExactTitle(group))
      .map(([key]) => key),
  );
  const authorCounts = new Map<string, number>();
  books.forEach((book) => {
    if (book.metadata?.creator) {
      const key = normalizedKey(book.metadata.creator);
      authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
    }
  });

  const records = books.map((book) => {
    const candidates = new Map<string, EvidenceCode[]>();
    const add = (canonical: string, evidence: EvidenceCode) => {
      const list = candidates.get(canonical) ?? [];
      if (!list.includes(evidence)) list.push(evidence);
      candidates.set(canonical, list);
    };
    if (book.metadata?.series) {
      add(canonicalFor(book.metadata.series), "OPF_SERIES_EXACT");
      if (book.metadata.groupPosition !== null) {
        add(canonicalFor(book.metadata.series), "OPF_GROUP_POSITION");
      }
      if (isReviewedAlias(book.metadata.series)) {
        add(canonicalFor(book.metadata.series), "REVIEWED_ALIAS");
      }
    }
    const titleKey = normalizedKey(book.facts.normalizedBaseTitle);
    if (confirmedTitleKeys.has(titleKey)) {
      add(canonicalFor(book.facts.normalizedBaseTitle), "TITLE_BASE_EXACT");
      if (isReviewedAlias(book.facts.normalizedBaseTitle)) {
        add(canonicalFor(book.facts.normalizedBaseTitle), "REVIEWED_ALIAS");
      }
      if (book.facts.editionLabels.length > 0) {
        add(canonicalFor(book.facts.normalizedBaseTitle), "EDITION_LABEL");
      }
    }

    if (candidates.size > 1) {
      const conflictingSeries = [...candidates.keys()].sort();
      return ClassificationRecordSchema.parse({
        relativePath: book.manifest.relativePath,
        status: "ambiguous",
        canonicalSeriesName: null,
        evidenceCodes: [...new Set([...candidates.values()].flat())],
        evidenceSummary: `Conflicting strong series evidence: ${conflictingSeries.join(", ")}.`,
        conflictingSeries,
      });
    }
    if (candidates.size === 1) {
      const [canonicalSeriesName, evidenceCodes] = [...candidates.entries()][0];
      const currentFolder = book.manifest.parentFolder;
      const status = currentFolder && canonicalFor(currentFolder) !== canonicalSeriesName
        ? "misplaced"
        : "confirmed";
      return ClassificationRecordSchema.parse({
        relativePath: book.manifest.relativePath,
        status,
        canonicalSeriesName,
        evidenceCodes,
        evidenceSummary: `${evidenceCodes.join(", ")} identifies ${canonicalSeriesName}.`,
        conflictingSeries: [],
      });
    }

    const evidenceCodes: EvidenceCode[] = [];
    let status: "probable" | "unclassified" = "unclassified";
    if (book.metadata?.creator && (authorCounts.get(normalizedKey(book.metadata.creator)) ?? 0) > 1) {
      evidenceCodes.push("AUTHOR_MATCH");
      status = "probable";
    }
    if (book.manifest.parentFolder) {
      evidenceCodes.push("EXISTING_FOLDER_ONLY");
      status = "probable";
    }
    return ClassificationRecordSchema.parse({
      relativePath: book.manifest.relativePath,
      status,
      canonicalSeriesName: null,
      evidenceCodes,
      evidenceSummary: status === "probable"
        ? "Only auxiliary evidence is available."
        : "No reliable series evidence is available.",
      conflictingSeries: [],
    });
  });

  const recordByPath = new Map(records.map((record) => [record.relativePath, record]));
  const folders = [...new Set(input.manifest.map((entry) => entry.parentFolder).filter(Boolean))].sort();
  const folderAudits = folders.map((folderName): FolderAudit => {
    const inFolder = input.manifest.filter((entry) => entry.parentFolder === folderName);
    const inFolderRecords = inFolder.map((entry) => recordByPath.get(entry.relativePath)!);
    const canonicalCounts = new Map<string, number>();
    inFolderRecords.filter((record) => record.status === "confirmed" && record.canonicalSeriesName)
      .forEach((record) => canonicalCounts.set(
        record.canonicalSeriesName!,
        (canonicalCounts.get(record.canonicalSeriesName!) ?? 0) + 1,
      ));
    const dominantCanonicalSeries = [...canonicalCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
    return {
      folderName,
      bookCount: inFolder.length,
      dominantCanonicalSeries,
      confirmedInPlace: inFolderRecords.filter((record) => record.status === "confirmed").map((record) => record.relativePath),
      confirmedMissingMembers: dominantCanonicalSeries
        ? records.filter((record) =>
          record.status === "confirmed"
          && record.canonicalSeriesName === dominantCanonicalSeries
          && !record.relativePath.includes("/"))
          .map((record) => record.relativePath)
        : [],
      misplaced: inFolderRecords.filter((record) => record.status === "misplaced").map((record) => record.relativePath),
      probable: inFolderRecords.filter((record) => record.status === "probable").map((record) => record.relativePath),
      ambiguous: inFolderRecords.filter((record) => record.status === "ambiguous").map((record) => record.relativePath),
      extractionErrors: inFolder.filter((entry) => metadataByPath.get(entry.relativePath)?.ok === false)
        .map((entry) => entry.relativePath),
    };
  });

  const existingFolderKeys = new Set(folders.map((folder) => normalizedKey(canonicalFor(folder))));
  const confirmedBySeries = new Map<string, string[]>();
  records.filter((record) =>
    (record.status === "confirmed" || record.status === "misplaced")
    && record.canonicalSeriesName)
    .forEach((record) => {
      const members = confirmedBySeries.get(record.canonicalSeriesName!) ?? [];
      members.push(record.relativePath);
      confirmedBySeries.set(record.canonicalSeriesName!, members);
    });
  const candidateSeries = [...confirmedBySeries.entries()]
    .filter(([canonical, members]) =>
      members.length >= 3 && !existingFolderKeys.has(normalizedKey(canonical)))
    .map(([canonicalSeriesName, memberPaths]) => ({
      canonicalSeriesName,
      memberCount: memberPaths.length,
      memberPaths: [...memberPaths].sort(),
    }))
    .sort((left, right) => left.canonicalSeriesName.localeCompare(right.canonicalSeriesName));

  return { records, folderAudits, candidateSeries };
}
