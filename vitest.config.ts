import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the deterministic gate usable on Windows machines with a constrained
    // commit budget. Vitest's CPU-sized fork pool can exhaust the system commit
    // limit even when physical memory is still available.
    maxWorkers: 1,
    /**
     * Nothing is excluded except what cannot run under vitest.
     *
     * The library-scan suite used to be excluded here and in tsconfig.reader-core.json,
     * on the theory that it was optional work in progress. What that actually bought
     * was rot: commit 7cfce8a deleted the scan contracts out of src/shared/contracts.ts
     * while the implementation stayed behind, and because nothing compiled or ran
     * those files, 47 tests sat broken indefinitely. Anything testable belongs in the
     * gate; do not add exclusions here to make a run pass.
     *
     * tests/e2e/** is the one real exception: it is driven by Playwright, not vitest.
     */
    exclude: ["node_modules/**", "out/**", "release/**", "tests/e2e/**"],
  },
});
