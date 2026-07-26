import type {
  CONTRACT_REF,
  ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type ServerEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.serverEnvelope
>;

export interface ServerEnvelopeIdFactory {
  createMessageId(): string;
}

export interface CommandFinalizer {
  readCompleted(
    sessionId: string,
    commandId: string,
  ): Promise<readonly ServerEnvelopeDocument[] | undefined>;

  /**
   * Atomically advances the Session view, projects the final authoritative
   * snapshot, persists the exact ServerEnvelopes, and completes the command.
   * A dialogue command is accepted only after both of its packets committed.
   */
  completeDialogueAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly characterTurnId: string;
  }): Promise<readonly ServerEnvelopeDocument[]>;

  /**
   * Atomically publishes a final authoritative SessionView for a world command
   * whose packet count is determined by its recoverable orchestration.
   */
  completeWorldAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
  }): Promise<readonly ServerEnvelopeDocument[]>;

  /**
   * Finalizes a rejection only while both Session and world still equal the
   * command's accepted basis. Rejection can therefore never hide a partial
   * dialogue mutation.
   */
  completeRejected(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly code: string;
  }): Promise<readonly ServerEnvelopeDocument[]>;
}
