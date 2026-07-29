import type { MaterializationClock } from "../../application/materialization-orchestrator.js";

export function createSystemMaterializationClock(): MaterializationClock {
  return Object.freeze({
    now(): string {
      return new Date().toISOString();
    },
  });
}
