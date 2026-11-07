export type DuplicateCandidate = {
  inventoryId: string;
  format: "txt" | "epub";
  relativePath: string;
  absolutePath: string;
  fileSize: number;
  modifiedAt: string;
  quickFingerprintVersion: number;
  quickFingerprint: string;
  imported: boolean;
  importedAvailable: boolean;
};

export type ExactDuplicateGroup = {
  fullContentHash: string;
  candidateIds: string[];
  survivorId: string;
};

export type FindDuplicatesInput = {
  candidates: DuplicateCandidate[];
  computeFullHash: (absolutePath: string) => Promise<string>;
};

type CandidateKey = string;

function candidateKey(c: DuplicateCandidate): CandidateKey {
  return `${c.format}:${c.fileSize}:v${c.quickFingerprintVersion}:${c.quickFingerprint}`;
}

function selectSurvivor(candidates: DuplicateCandidate[]): string {
  const imported = candidates.filter((c) => c.imported && c.importedAvailable);
  if (imported.length > 0) {
    const sorted = [...imported].sort(byStableOrder);
    return sorted[0].inventoryId;
  }
  const sorted = [...candidates].sort(byStableOrder);
  return sorted[0].inventoryId;
}

function byStableOrder(a: DuplicateCandidate, b: DuplicateCandidate): number {
  if (a.modifiedAt < b.modifiedAt) return -1;
  if (a.modifiedAt > b.modifiedAt) return 1;
  if (a.relativePath.length < b.relativePath.length) return -1;
  if (a.relativePath.length > b.relativePath.length) return 1;
  if (a.relativePath < b.relativePath) return -1;
  if (a.relativePath > b.relativePath) return 1;
  if (a.inventoryId < b.inventoryId) return -1;
  if (a.inventoryId > b.inventoryId) return 1;
  return 0;
}

export class DuplicateResolver {
  async findExactDuplicates(input: FindDuplicatesInput): Promise<ExactDuplicateGroup[]> {
    const { candidates, computeFullHash } = input;

    const groups = new Map<CandidateKey, DuplicateCandidate[]>();
    for (const c of candidates) {
      const key = candidateKey(c);
      const list = groups.get(key) || [];
      list.push(c);
      groups.set(key, list);
    }

    const results: ExactDuplicateGroup[] = [];

    for (const group of Array.from(groups.values())) {
      if (group.length < 2) continue;

      const hashMap = new Map<string, string[]>();
      for (const c of group) {
        try {
          const hash = await computeFullHash(c.absolutePath);
          const ids = hashMap.get(hash) || [];
          ids.push(c.inventoryId);
          hashMap.set(hash, ids);
        } catch {
          // Skip candidates whose hash cannot be computed
        }
      }

      for (const [hash, ids] of Array.from(hashMap.entries())) {
        if (ids.length < 2) continue;

        const groupCandidates = group.filter((c) => ids.includes(c.inventoryId));
        const survivorId = selectSurvivor(groupCandidates);

        results.push({
          fullContentHash: hash,
          candidateIds: ids.sort(),
          survivorId,
        });
      }
    }

    return results;
  }
}
