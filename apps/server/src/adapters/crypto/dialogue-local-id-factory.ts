import { randomUUID } from "node:crypto";

import type { DialogueLocalIdFactory } from "../../application/dialogue-command-orchestrator.js";

export function createNodeDialogueLocalIdFactory(): DialogueLocalIdFactory {
  return Object.freeze({
    createId(): string {
      return randomUUID();
    },
  });
}
