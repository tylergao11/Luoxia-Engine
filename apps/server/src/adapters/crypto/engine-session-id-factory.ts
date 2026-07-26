import { randomUUID } from "node:crypto";

import type { EngineSessionIdFactory } from "../../application/engine-session.js";

export function createNodeEngineSessionIdFactory(): EngineSessionIdFactory {
  return Object.freeze({
    createSessionId(): string {
      return randomUUID();
    },
    createNonce(): string {
      return randomUUID();
    },
  });
}
