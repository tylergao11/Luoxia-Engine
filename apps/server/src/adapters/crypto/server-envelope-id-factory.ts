import { randomUUID } from "node:crypto";

import type { ServerEnvelopeIdFactory } from "../../application/server-envelope.js";

export function createNodeServerEnvelopeIdFactory(): ServerEnvelopeIdFactory {
  return Object.freeze({
    createMessageId(): string {
      return randomUUID();
    },
  });
}
