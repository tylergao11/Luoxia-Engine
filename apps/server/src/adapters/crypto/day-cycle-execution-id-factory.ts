import { randomUUID } from "node:crypto";

import type { DayCycleExecutionIdentityFactory } from "../../application/day-cycle-execution-identity.js";

export function createNodeDayCycleExecutionIdFactory(): DayCycleExecutionIdentityFactory {
  return Object.freeze({
    createId(): string {
      return randomUUID();
    },
  });
}
