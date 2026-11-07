/**
 * Model-call shapes used by the scan subsystem.
 *
 * These mirror what the (now deleted) librarian chat model produced, but are declared
 * here on purpose. Previously the scan tree reached into src/backend/librarian/** for
 * these types, which type-coupled a live subsystem to a dead one: including scan in
 * the compiler dragged the librarian in with it and failed the build. Because these
 * are structural types used only for compile-time checking, declaring them locally
 * costs nothing at runtime and lets the two subsystems evolve independently.
 *
 * Anything implementing the old librarian chat model remains assignable, so a future
 * agent can still be injected here.
 */

export type ScanModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id: string };

export type ScanModelToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ScanChatModel = {
  complete(
    messages: ScanModelMessage[],
    apiKey: string,
  ): Promise<{ content: string | null; toolCalls: ScanModelToolCall[] }>;
};

/**
 * The audit sink the scan subsystem reads and writes recycle/replace operations on.
 *
 * Structurally identical to `LibrarianOperationRepository`, but declared here so scan
 * does not import the librarian module.
 */
export type ScanOperationRecord = {
  reviewId: string;
  actionId: string;
  kind: "import" | "replace" | "recycle_duplicate" | "ignore";
  bookId: string | null;
  candidatePath: string;
  priorSourcePath: string | null;
  contentHash: string;
  reason: string;
  outcome: "completed" | "failed";
};

export type ScanOperationSink = {
  record(value: ScanOperationRecord): void;
  /** Most recent operations, used to keep recycling idempotent across runs. */
  listRecent(limit: number): ScanOperationRecord[];
};
