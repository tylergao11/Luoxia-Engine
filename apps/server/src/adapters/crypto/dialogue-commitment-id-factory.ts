import { randomUUID } from "node:crypto";

import type { DialogueCommitmentIdFactory } from "../../application/dialogue-command-orchestrator.js";

export function createNodeDialogueCommitmentIdFactory(): DialogueCommitmentIdFactory {
  return Object.freeze({
    createCommitmentId(): string {
      return randomUUID();
    },
  });
}
