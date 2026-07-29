import { randomUUID } from "node:crypto";

import type { MaterializationIdentityFactory } from "../../application/materialization-orchestrator.js";

export function createNodeMaterializationIdentityFactory(): MaterializationIdentityFactory {
  return Object.freeze({
    createAcceptanceId(): string {
      return randomUUID();
    },
    createBindingId(): string {
      return randomUUID();
    },
  });
}
