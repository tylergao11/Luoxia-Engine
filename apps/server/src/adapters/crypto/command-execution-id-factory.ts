import { randomUUID } from "node:crypto";

import type { CommandExecutionIdFactory } from "../../application/command-journal.js";

export function createNodeCommandExecutionIdFactory(): CommandExecutionIdFactory {
  return Object.freeze({
    createId(): string {
      return randomUUID();
    },
  });
}
