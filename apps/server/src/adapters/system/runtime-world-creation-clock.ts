import type { RuntimeWorldCreationClock } from "../../application/runtime-world-creation.js";

export function createSystemRuntimeWorldCreationClock(): RuntimeWorldCreationClock {
  return Object.freeze({
    now(): string {
      return new Date().toISOString();
    },
  });
}
