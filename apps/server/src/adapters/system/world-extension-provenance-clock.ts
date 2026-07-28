import type { WorldExtensionProvenanceClock } from "../../application/world-extension-orchestrator.js";

export function createSystemWorldExtensionProvenanceClock(): WorldExtensionProvenanceClock {
  return Object.freeze({
    now(): string {
      return new Date().toISOString();
    },
  });
}
