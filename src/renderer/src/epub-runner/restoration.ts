import type { EpubReadingLocationV1 } from "../../../shared/contracts.js";

export function initialLastLocation(
  location: EpubReadingLocationV1 | null,
  sourceRevision: string,
): string | null {
  if (!location || location.sourceRevision !== sourceRevision) return null;
  return location.primary.engineLocator.value;
}
