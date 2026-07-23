import { randomUUID } from "node:crypto";

import type { DeterministicContextIdFactory } from "@luoxia/world-core/composition";

/**
 * Server-side context_id factory. Uses Node crypto only in Server adapters.
 */
export function createNodeDeterministicContextIdFactory(): DeterministicContextIdFactory {
  return Object.freeze({
    createContextId(): string {
      return randomUUID();
    },
  });
}
