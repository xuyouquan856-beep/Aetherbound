import {
  LibraryScanCounters,
  LibraryScanPhase,
  LibraryScanSnapshot,
  LibraryScanState,
} from "../../shared/contracts.js";

export type LibraryRootRecord = {
  id: string;
  displayName: string;
  rootPath: string;
  enabled: boolean;
};

export type InventoryEntryInput = {
  relativePath: string;
  format: "txt" | "epub";
  fileSize: number;
  modifiedAt: string;
};

export type InventoryDisposition = "cached" | "discovered";

export type InternalScanJob = {
  id: string;
  rootId: string;
  state: LibraryScanState;
  phase: LibraryScanPhase;
  cursorJson: string;
  counters: LibraryScanCounters;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  errorCode: string | null;
};

export type ScanJobPatch = {
  state?: LibraryScanState;
  phase?: LibraryScanPhase;
  cursorJson?: string;
  counters?: LibraryScanCounters;
  lastHeartbeatAt?: string;
  endedAt?: string | null;
  errorCode?: string | null;
};
