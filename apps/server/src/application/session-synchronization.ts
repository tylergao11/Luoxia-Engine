import type { ServerEnvelopeDocument } from "./server-envelope.js";

export interface SessionSynchronizationService {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}
