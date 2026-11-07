import type { BookDetails } from "../../../../shared/contracts.js";

export type ReaderPhase =
  | "preparing"
  | "ready-hidden"
  | "presenting"
  | "active"
  | "suspended";

export type ReaderSlot = {
  details: BookDetails;
  phase: ReaderPhase;
  traceId: string;
};

export type ReaderLifecycleState = {
  slot: ReaderSlot | null;
};

export type ReaderLifecycleEvent =
  | { type: "prepare"; details: BookDetails; traceId: string }
  | { type: "ready" }
  | { type: "present" }
  | { type: "presented" }
  | { type: "suspend" }
  | { type: "resume"; traceId?: string }
  | { type: "evict" }
  | { type: "fail" };

export const InitialReaderLifecycleState: ReaderLifecycleState = {
  slot: null,
};

function invalid(): never {
  throw new Error("INVALID_READER_LIFECYCLE_TRANSITION");
}

export function transitionReader(
  state: ReaderLifecycleState,
  event: ReaderLifecycleEvent,
): ReaderLifecycleState {
  if (event.type === "prepare") {
    if (state.slot?.details.book.id === event.details.book.id) return state;
    return {
      slot: {
        details: event.details,
        phase: "preparing",
        traceId: event.traceId,
      },
    };
  }

  if (event.type === "evict") return InitialReaderLifecycleState;
  if (event.type === "fail") {
    if (!state.slot || !["preparing", "ready-hidden", "presenting"].includes(state.slot.phase)) {
      return invalid();
    }
    return InitialReaderLifecycleState;
  }
  if (!state.slot) return invalid();

  const nextPhase = (() => {
    if (event.type === "ready" && state.slot.phase === "preparing") return "ready-hidden";
    if (event.type === "present" && state.slot.phase === "ready-hidden") return "presenting";
    if (event.type === "presented" && state.slot.phase === "presenting") return "active";
    if (event.type === "suspend" && state.slot.phase === "active") return "suspended";
    if (event.type === "resume" && state.slot.phase === "suspended") return "presenting";
    return invalid();
  })();

  return {
    slot: {
      ...state.slot,
      phase: nextPhase,
      traceId: event.type === "resume" && event.traceId
        ? event.traceId
        : state.slot.traceId,
    },
  };
}
