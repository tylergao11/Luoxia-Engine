import {
  CONTRACT_REF,
  EngineFault,
  type ContractValidator,
  type JsonObject,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type ServerEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.serverEnvelope
>;

export interface ServerEnvelopeIdFactory {
  createMessageId(): string;
}

export interface ServerEnvelopeBatchInput {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly firstSequence: number;
  readonly messages: readonly JsonObject[];
}

export interface ServerEnvelopeFactory {
  createBatch(
    input: ServerEnvelopeBatchInput,
  ): readonly ServerEnvelopeDocument[];
}

export interface ServerEnvelopeFactoryDependencies {
  readonly contracts: ContractValidator;
  readonly idFactory: ServerEnvelopeIdFactory;
}

export function createServerEnvelopeFactory(
  dependencies: ServerEnvelopeFactoryDependencies,
): ServerEnvelopeFactory {
  return Object.freeze({
    createBatch(
      input: ServerEnvelopeBatchInput,
    ): readonly ServerEnvelopeDocument[] {
      if (input.messages.length === 0) {
        throw new EngineFault(
          "server_envelope.messages_empty",
          "A ServerEnvelope batch must contain at least one message",
          { session_id: input.sessionId },
        );
      }
      if (
        !Number.isSafeInteger(input.firstSequence) ||
        input.firstSequence < 0
      ) {
        throw new EngineFault(
          "server_envelope.sequence_invalid",
          "The first ServerEnvelope sequence must be a safe unsigned integer",
          {
            session_id: input.sessionId,
            first_sequence: input.firstSequence,
          },
        );
      }
      const lastSequence =
        input.firstSequence + input.messages.length - 1;
      const nextSequence = lastSequence + 1;
      if (
        !Number.isSafeInteger(lastSequence) ||
        lastSequence > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(nextSequence) ||
        nextSequence > Number.MAX_SAFE_INTEGER
      ) {
        throw new EngineFault(
          "server_envelope.sequence_exhausted",
          "ServerEnvelope sequence cannot be allocated safely",
          {
            session_id: input.sessionId,
            first_sequence: input.firstSequence,
            message_count: input.messages.length,
          },
        );
      }

      return Object.freeze(
        input.messages.map((message, ordinal) => {
          const messageId = dependencies.idFactory.createMessageId();
          dependencies.contracts.assert(CONTRACT_REF.uuid, messageId);
          if (messageId !== messageId.toLowerCase()) {
            throw new EngineFault(
              "server_envelope.generated_identity_noncanonical",
              "Server-generated message UUIDs must use lowercase canonical text",
              { message_id: messageId },
            );
          }
          return dependencies.contracts.assertObject(
            CONTRACT_REF.serverEnvelope,
            {
              protocol_version: "client-bridge.v1",
              envelope_type: "server",
              message_id: messageId,
              session_id: input.sessionId,
              sequence: input.firstSequence + ordinal,
              correlation_id: input.correlationId,
              message,
            },
          );
        }),
      );
    },
  });
}
