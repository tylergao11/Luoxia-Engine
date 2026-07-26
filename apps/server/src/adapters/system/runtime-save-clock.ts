import type { RuntimeSaveClock } from "../../application/runtime-save.js";

/** Server-owned wall clock for the operational timestamp of a save import. */
export function createSystemRuntimeSaveClock(): RuntimeSaveClock {
  return Object.freeze({
    now(): string {
      return new Date().toISOString();
    },
  });
}
