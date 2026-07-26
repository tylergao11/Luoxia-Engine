import { randomUUID } from "node:crypto";

import type { ServerEnvelopeIdFactory } from "../../application/command-finalizer.js";

export function createNodeServerEnvelopeIdFactory(): ServerEnvelopeIdFactory {
  return Object.freeze({
    createMessageId(): string {
      return randomUUID();
    },
  });
}
