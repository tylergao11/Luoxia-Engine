import type {
  CONTRACT_REF,
  JsonObject,
  ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import type { EngineSessionRecord } from "./engine-session.js";

export type ClientEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.clientEnvelope
>;

export type CommandResultDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.commandResult
>;

interface StoredCommandBase {
  readonly session: EngineSessionRecord;
  readonly commandId: string;
  readonly commandKind: string;
  readonly requestDigest: string;
  readonly envelope: ClientEnvelopeDocument;
  readonly message: JsonObject;
}

export interface StoredReceivedCommand extends StoredCommandBase {
  readonly phase: "received";
}

export interface StoredCompletedCommand extends StoredCommandBase {
  readonly phase: "completed";
  readonly result: CommandResultDocument;
}

export type StoredCommand =
  | StoredReceivedCommand
  | StoredCompletedCommand;

export interface CommandJournal {
  receive(candidate: unknown): Promise<StoredCommand>;
  read(
    sessionId: string,
    commandId: string,
  ): Promise<StoredCommand | undefined>;
  complete(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly resultCandidate: unknown;
  }): Promise<StoredCompletedCommand>;
}
