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
  readonly dialogueExecution?: DialogueCommandExecutionIdentity;
  readonly dialogueCloseExecution?: DialogueCloseCommandExecutionIdentity;
  readonly eventCardExecution?: EventCardCommandExecutionIdentity;
  readonly navigationExecution?: NavigationCommandExecutionIdentity;
  readonly stageOutcomeExecution?: StageOutcomeCommandExecutionIdentity;
}

/**
 * Server-owned random identities for the two authoritative dialogue packets
 * and the model invocation between them. Command Journal is their sole owner;
 * downstream journals and CommittedEvent rows are the stage evidence.
 */
export interface DialogueCommandExecutionIdentity {
  readonly dialogueId: string;
  readonly humanTurnId: string;
  readonly humanRuleRequestId: string;
  readonly characterModelRequestId: string;
  readonly characterTurnId: string;
  readonly characterRuleRequestId: string;
}

/**
 * Server-owned globally unique RulePlugin request identity for dialogue.close.
 * Client command_id remains scoped to a Session and the target dialogue stays
 * in the validated ClientMessage instead of becoming a second stored fact.
 */
export interface DialogueCloseCommandExecutionIdentity {
  readonly ruleRequestId: string;
}

/**
 * Server-owned globally unique packet identity for the single authoritative
 * EventCard click packet. Client command_id is scoped to a Session and cannot
 * satisfy the global ContentPacket packet_id uniqueness contract.
 */
export interface EventCardCommandExecutionIdentity {
  readonly packetId: string;
}

/**
 * Server-owned globally unique RulePlugin request identity for map.move.
 * Client command_id is scoped to a Session and cannot own the global
 * RulePlugin Invocation Journal key.
 */
export interface NavigationCommandExecutionIdentity {
  readonly ruleRequestId: string;
}

/**
 * Server-owned globally unique RulePlugin request identity for one
 * StageOutcomeProposal. The Stage instance and proposal remain in the
 * validated ClientMessage.
 */
export interface StageOutcomeCommandExecutionIdentity {
  readonly ruleRequestId: string;
}

export interface CommandExecutionIdFactory {
  createId(): string;
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
