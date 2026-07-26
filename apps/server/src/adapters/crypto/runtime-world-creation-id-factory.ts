import { randomUUID } from "node:crypto";

import type { RuntimeWorldCreationIdFactory } from "../../application/runtime-world-creation.js";

export function createNodeRuntimeWorldCreationIdFactory(): RuntimeWorldCreationIdFactory {
  return Object.freeze({
    createId(): string {
      return randomUUID();
    },
  });
}
