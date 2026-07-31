import {
  assertSaveEnvelopeRelationships,
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type { SessionViewDocument } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

import type {
  CommandFinalizer,
  EventCardCompletionBranch,
} from "../../application/command-finalizer.js";
import {
  dialogueDirectorProposalKind,
  type DialogueDirectorProposalKind,
  type DialogueDirectorRequestKind,
} from "../../application/dialogue-director-run.js";
import { isStageOutcomePreInvocationRejectionCode } from "../../application/stage-outcome-pre-invocation-rejection.js";
import type { EngineSessionRecord } from "../../application/engine-session.js";
import type {
  ServerEnvelopeDocument,
  ServerEnvelopeFactory,
  ServerEnvelopeIdFactory,
} from "../../application/server-envelope.js";
import type { SessionViewAssembler } from "../../application/session-view-assembler.js";
import type { StageOpenMessageProjector } from "../../application/stage-open-message-projector.js";
import {
  readEngineSessionContext,
  type LockedEngineSessionContext,
} from "./engine-session-repository.js";
import {
  assertDialogueAcceptedCompletionIdentity,
  DIALOGUE_PACKET_COUNT,
  readDialogueResponseIdentity,
} from "./dialogue-finalizer-identity.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresCommandFinalizerDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly views: SessionViewAssembler;
  readonly stageOpens: StageOpenMessageProjector;
  readonly envelopes: ServerEnvelopeFactory;
  readonly idFactory: ServerEnvelopeIdFactory;
}

interface FinalizationCommandRow {
  readonly session_id: string;
  readonly command_id: string;
  readonly command_kind: string;
  readonly request_document: unknown;
  readonly accepted_world_id: string;
  readonly accepted_control_binding_id: string;
  readonly accepted_player_entity_id: string;
  readonly accepted_view_revision_text: string;
  readonly accepted_world_revision_text: string;
  readonly accepted_nonce: string;
  readonly dialogue_id: string | null;
  readonly human_turn_id: string | null;
  readonly character_model_request_id: string | null;
  readonly character_turn_id: string | null;
  readonly director_dialogue_events_model_request_id: string | null;
  readonly director_system_model_request_id: string | null;
  readonly director_system_response_turn_id: string | null;
  readonly director_goal_plan_model_request_id: string | null;
  readonly director_definition_draft_model_request_id: string | null;
  readonly player_day_from_day_text: string | null;
  readonly event_card_packet_id: string | null;
  readonly navigation_rule_request_id: string | null;
  readonly stage_outcome_rule_request_id: string | null;
  readonly dialogue_close_rule_request_id: string | null;
  readonly content_upgrade_command_id: string | null;
  readonly content_upgrade_rule_request_id: string | null;
  readonly event_card_committed_event_document: unknown | null;
  readonly command_status: string;
  readonly result_document: unknown | null;
}

interface ValidatedFinalizationCommand {
  readonly sessionId: string;
  readonly commandId: string;
  readonly commandKind:
    | "dialogue.start"
    | "dialogue.continue"
    | "dialogue.close"
    | "player_day.end"
    | "event_card.trigger"
    | "map.move"
    | "stage.outcome_proposal"
    | "content_upgrade.accept";
  readonly requestMessageId: string;
  readonly acceptedSession: EngineSessionRecord;
  readonly dialogueId: string | undefined;
  readonly humanTurnId: string | undefined;
  readonly characterTurnId: string | undefined;
  readonly dialogueResponseKind:
    | "character_mind"
    | "director_system"
    | undefined;
  readonly responseTurnId: string | undefined;
  readonly responseModelRequestId: string | undefined;
  readonly dialogueEventsModelRequestId: string | undefined;
  readonly playerDayFromDay: number | undefined;
  readonly eventCardId: string | undefined;
  readonly eventCardPacketId: string | undefined;
  readonly eventCardBranch: EventCardCompletionBranch | undefined;
  readonly navigationRuleRequestId: string | undefined;
  readonly navigationDestination: JsonObject | undefined;
  readonly stageOutcomeRuleRequestId: string | undefined;
  readonly stageOutcomeId: string | undefined;
  readonly stageOutcomeRevision: number | undefined;
  readonly stageOutcomeType: string | undefined;
  readonly stageOutcome: JsonObject | undefined;
  readonly stageOutcomeEvidenceDigest: string | undefined;
  readonly dialogueCloseRuleRequestId: string | undefined;
  readonly dialogueCloseId: string | undefined;
  readonly contentUpgradeCommandId: string | undefined;
  readonly contentUpgradeRuleRequestId: string | undefined;
  readonly contentUpgradeMigrationId: string | undefined;
  readonly contentUpgradeTargetBundle: JsonObject | undefined;
  readonly contentUpgradeConsentTextDigest: string | undefined;
  readonly status: "received" | "completed";
  readonly result: JsonObject | undefined;
}

interface ServerEnvelopeRow {
  readonly response_ordinal_text: string;
  readonly server_sequence_text: string;
  readonly message_id: string;
  readonly message_type: string;
  readonly envelope_document: unknown;
}

interface CommittedEventHistoryRow {
  readonly revision_after_text: string;
  readonly event_document: unknown;
}

interface TerminalRulePluginInvocationRow {
  readonly terminal_request_id: string;
  readonly operation_kind: string;
  readonly invocation_status: string;
  readonly request_document: unknown;
  readonly response_document: unknown | null;
  readonly proposal_id: string | null;
  readonly revision_after_text: string | null;
  readonly event_document: unknown | null;
}

interface StageOutcomeRejectionBoundaryRow {
  readonly root_invocation_exists: boolean;
  readonly later_committed_event_exists: boolean;
}

interface DialogueCloseCompletionRow {
  readonly operation_kind: string;
  readonly invocation_status: string;
  readonly request_document: unknown;
  readonly proposal_id: string | null;
  readonly revision_after_text: string | null;
  readonly event_document: unknown | null;
}

interface ContentUpgradeCompletionRow {
  readonly upgrade_command_id: string;
  readonly session_id: string;
  readonly client_command_id: string;
  readonly rule_request_id: string;
  readonly world_id: string;
  readonly migration_id: string;
  readonly source_world_revision_text: string;
  readonly source_save_digest: string;
  readonly authorization_digest: string;
  readonly authorization_document: unknown;
  readonly authorization_status: string;
  readonly result_digest: string | null;
  readonly operation_kind: string | null;
  readonly invocation_status: string | null;
  readonly request_document: unknown | null;
  readonly response_document: unknown | null;
  readonly revision_after_text: string | null;
  readonly event_document: unknown | null;
}

interface DialogueProposalHistoryRow {
  readonly request_kind: string;
  readonly model_proposal_id: string;
  readonly proposal_ordinal: number;
  readonly world_record_id: string | null;
  readonly rule_request_id: string;
  readonly operation_kind: string | null;
  readonly invocation_status: string | null;
  readonly packet_proposal_id: string | null;
}

interface DialogueProposalHistoryRecord
  extends DialogueProposalHistoryRow {
  readonly proposal_kind: DialogueDirectorProposalKind;
}

interface DialogueDirectorOutputRow {
  readonly request_kind: string;
  readonly invocation_status: string;
  readonly response_document: unknown | null;
}

interface DayCycleExecutionIdentityRow {
  readonly execution_id: string;
}

export function createPostgresCommandFinalizer(
  dependencies: PostgresCommandFinalizerDependencies,
): CommandFinalizer {
  return new PostgresCommandFinalizer(dependencies);
}

class PostgresCommandFinalizer
  implements CommandFinalizer
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #views: SessionViewAssembler;
  readonly #stageOpens: StageOpenMessageProjector;
  readonly #envelopes: ServerEnvelopeFactory;
  readonly #idFactory: ServerEnvelopeIdFactory;

  public constructor(
    dependencies: PostgresCommandFinalizerDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#views = dependencies.views;
    this.#stageOpens = dependencies.stageOpens;
    this.#envelopes = dependencies.envelopes;
    this.#idFactory = dependencies.idFactory;
  }

  public async readCompleted(
    sessionId: string,
    commandId: string,
  ): Promise<readonly ServerEnvelopeDocument[] | undefined> {
    const verifiedSessionId = assertUuid(this.#contracts, sessionId);
    const verifiedCommandId = assertUuid(this.#contracts, commandId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const row = await readFinalizationCommandRow(
          client,
          verifiedSessionId,
          verifiedCommandId,
          "",
        );
        if (row === undefined) {
          return undefined;
        }
        const command = validateFinalizationCommandRow(
          this.#contracts,
          row,
          verifiedSessionId,
          verifiedCommandId,
        );
        if (command.status !== "completed") {
          return undefined;
        }
        return readCompletedEnvelopes(
          client,
          this.#contracts,
          command,
        );
      });
    } catch (error: unknown) {
      throw normalizeFinalizerError(
        error,
        verifiedSessionId,
        verifiedCommandId,
      );
    }
  }

  public async completeDialogueAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly responseTurnId: string;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    return this.#completeAccepted({
      sessionId: input.sessionId,
      commandId: input.commandId,
      finalWorldRevision: input.finalWorldRevision,
      responseTurnId: assertUuid(
        this.#contracts,
        input.responseTurnId,
      ),
      eventCard: undefined,
      stageInstanceId: undefined,
    });
  }

  public async completeWorldAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    return this.#completeAccepted({
      sessionId: input.sessionId,
      commandId: input.commandId,
      finalWorldRevision: input.finalWorldRevision,
      responseTurnId: undefined,
      eventCard: undefined,
      stageInstanceId: undefined,
    });
  }

  public async completeStageOutcomeAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly stageInstanceId: string;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    return this.#completeAccepted({
      sessionId: input.sessionId,
      commandId: input.commandId,
      finalWorldRevision: input.finalWorldRevision,
      responseTurnId: undefined,
      eventCard: undefined,
      stageInstanceId: assertUuid(
        this.#contracts,
        input.stageInstanceId,
      ),
    });
  }

  public async completeEventCardAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly eventCardId: string;
    readonly branch: EventCardCompletionBranch;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    return this.#completeAccepted({
      sessionId: input.sessionId,
      commandId: input.commandId,
      finalWorldRevision: input.finalWorldRevision,
      responseTurnId: undefined,
      eventCard: Object.freeze({
        eventCardId: assertUuid(this.#contracts, input.eventCardId),
        branch: input.branch,
      }),
      stageInstanceId: undefined,
    });
  }

  async #completeAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly responseTurnId: string | undefined;
    readonly eventCard:
      | {
          readonly eventCardId: string;
          readonly branch: EventCardCompletionBranch;
      }
      | undefined;
    readonly stageInstanceId: string | undefined;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    const sessionId = assertUuid(this.#contracts, input.sessionId);
    const commandId = assertUuid(this.#contracts, input.commandId);
    assertSafeUnsignedInteger(
      input.finalWorldRevision,
      "command.finalizer.world_revision_invalid",
      "finalWorldRevision",
      {
        session_id: sessionId,
        command_id: commandId,
        final_world_revision: input.finalWorldRevision,
      },
    );

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const first = await requireFinalizationCommand(
            client,
            this.#contracts,
            sessionId,
            commandId,
            "",
          );
          assertAcceptedCompletionIdentity(
            first,
            input.finalWorldRevision,
            input.responseTurnId,
            input.eventCard,
            input.stageInstanceId,
          );
          if (first.status === "completed") {
            return readCompletedEnvelopes(
              client,
              this.#contracts,
              first,
              "accepted",
            );
          }

          const sessionContext = await readEngineSessionContext(
            client,
            this.#contracts,
            sessionId,
            "FOR UPDATE OF s FOR SHARE OF w",
          );
          const command = await requireFinalizationCommand(
            client,
            this.#contracts,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          assertAcceptedCompletionIdentity(
            command,
            input.finalWorldRevision,
            input.responseTurnId,
            input.eventCard,
            input.stageInstanceId,
          );
          if (command.status === "completed") {
            return readCompletedEnvelopes(
              client,
              this.#contracts,
              command,
              "accepted",
            );
          }
          assertAcceptedSessionState(
            command,
            sessionContext,
            input.finalWorldRevision,
          );
          if (
            command.commandKind === "dialogue.start" ||
            command.commandKind === "dialogue.continue"
          ) {
            await assertDialogueCompletionHistory({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
              responseTurnId: requireDialogueResponseTurnId(command),
            });
          }
          if (command.commandKind === "player_day.end") {
            assertPlayerDayCompletion(command, sessionContext.worldState);
          }
          if (command.commandKind === "event_card.trigger") {
            assertEventCardCompletion(
              command,
              sessionContext.worldState,
              requireEventCardCompletion(input.eventCard),
            );
          }
          if (command.commandKind === "map.move") {
            await assertNavigationCompletionHistory({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
            });
          }
          if (command.commandKind === "dialogue.close") {
            await assertDialogueCloseCompletionHistory({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
              finalWorldState: sessionContext.worldState,
            });
          }
          if (command.commandKind === "stage.outcome_proposal") {
            await assertStageOutcomeCompletionHistory({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
              finalWorldState: sessionContext.worldState,
              stageInstanceId: requireStageInstanceId(
                input.stageInstanceId,
              ),
            });
          }
          if (command.commandKind === "content_upgrade.accept") {
            await assertContentUpgradeCompletionHistory({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
              finalWorldState: sessionContext.worldState,
              finalWorldContentLock: sessionContext.worldContentLock.value,
            });
          }
          const stageOpenProjectionIds =
            await readCommandStageOpenProjectionIds({
              client,
              contracts: this.#contracts,
              command,
              finalWorldRevision: input.finalWorldRevision,
            });

          if (
            command.acceptedSession.viewRevision ===
            Number.MAX_SAFE_INTEGER
          ) {
            throw new EngineFault(
              "dialogue.finalizer.view_revision_exhausted",
              "Engine Session view revision cannot be incremented safely",
              { session_id: sessionId, command_id: commandId },
            );
          }
          const nextSession: EngineSessionRecord = Object.freeze({
            ...command.acceptedSession,
            viewRevision:
              command.acceptedSession.viewRevision + 1,
            worldRevision: input.finalWorldRevision,
          });
          const view = this.#views.assemble({
            session: nextSession,
            worldState: sessionContext.worldState,
            worldContentLock: sessionContext.worldContentLock,
            noticeCandidates: [],
          });
          const result = this.#contracts.assertObject(
            CONTRACT_REF.commandResult,
            {
              type: "command.result",
              command_id: command.commandId,
              status: "accepted",
              view_revision: nextSession.viewRevision,
            },
          );
          const messages = createAcceptedMessages({
            contracts: this.#contracts,
            idFactory: this.#idFactory,
            stageOpens: this.#stageOpens,
            command,
            eventCard: input.eventCard,
            stageInstanceId: input.stageInstanceId,
            view,
            worldState: sessionContext.worldState,
            worldContentLock: sessionContext.worldContentLock,
            stageModuleLocks: sessionContext.stageModuleLocks.map(
              (lock) => lock.value,
            ),
            stageOpenProjectionIds,
            result: result.value,
          });
          const envelopes = this.#envelopes.createBatch({
            sessionId,
            correlationId: command.requestMessageId,
            firstSequence: sessionContext.nextServerSequence,
            messages,
          });

          await persistFinalization({
            client,
            command,
            envelopes,
            result: result.value,
            nextSession,
            nextServerSequence:
              sessionContext.nextServerSequence + envelopes.length,
          });
          return envelopes;
        },
      );
    } catch (error: unknown) {
      throw normalizeFinalizerError(error, sessionId, commandId);
    }
  }

  public async completeRejected(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly code: string;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    const sessionId = assertUuid(this.#contracts, input.sessionId);
    const commandId = assertUuid(this.#contracts, input.commandId);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const first = await requireFinalizationCommand(
            client,
            this.#contracts,
            sessionId,
            commandId,
            "",
          );
          if (first.status === "completed") {
            assertRejectedCompletionCode(first, input.code);
            return readCompletedEnvelopes(
              client,
              this.#contracts,
              first,
              "rejected",
            );
          }

          const sessionContext = await readEngineSessionContext(
            client,
            this.#contracts,
            sessionId,
            "FOR UPDATE OF s FOR SHARE OF w",
          );
          const command = await requireFinalizationCommand(
            client,
            this.#contracts,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          if (command.status === "completed") {
            assertRejectedCompletionCode(command, input.code);
            return readCompletedEnvelopes(
              client,
              this.#contracts,
              command,
              "rejected",
            );
          }
          assertUnchangedSessionState(command, sessionContext);
          if (command.commandKind === "map.move") {
            await assertNavigationRejectionHistory({
              client,
              contracts: this.#contracts,
              command,
              code: input.code,
            });
          }
          if (command.commandKind === "stage.outcome_proposal") {
            await assertStageOutcomeRejectionBoundary({
              client,
              contracts: this.#contracts,
              command,
              code: input.code,
            });
          }

          const view = this.#views.assemble({
            session: command.acceptedSession,
            worldState: sessionContext.worldState,
            worldContentLock: sessionContext.worldContentLock,
            noticeCandidates: [],
          });
          const result = this.#contracts.assertObject(
            CONTRACT_REF.commandResult,
            {
              type: "command.result",
              command_id: command.commandId,
              status: "rejected",
              view_revision: command.acceptedSession.viewRevision,
              code: input.code,
            },
          );
          const envelopes = this.#envelopes.createBatch({
            sessionId,
            correlationId: command.requestMessageId,
            firstSequence: sessionContext.nextServerSequence,
            messages: [
              Object.freeze({
                type: "session.view",
                view: view.value,
              }),
              result.value,
            ],
          });

          await persistFinalization({
            client,
            command,
            envelopes,
            result: result.value,
            nextSession: command.acceptedSession,
            nextServerSequence:
              sessionContext.nextServerSequence + envelopes.length,
          });
          return envelopes;
        },
      );
    } catch (error: unknown) {
      throw normalizeFinalizerError(error, sessionId, commandId);
    }
  }
}

function createAcceptedMessages(input: {
  readonly contracts: ContractValidator;
  readonly idFactory: ServerEnvelopeIdFactory;
  readonly stageOpens: StageOpenMessageProjector;
  readonly command: ValidatedFinalizationCommand;
  readonly eventCard:
    | {
        readonly eventCardId: string;
        readonly branch: EventCardCompletionBranch;
      }
    | undefined;
  readonly stageInstanceId: string | undefined;
  readonly view: SessionViewDocument;
  readonly worldState: JsonObject;
  readonly worldContentLock: LockedEngineSessionContext["worldContentLock"];
  readonly stageModuleLocks: readonly JsonObject[];
  readonly stageOpenProjectionIds: readonly string[];
  readonly result: JsonObject;
}): readonly JsonObject[] {
  const viewMessage = Object.freeze({
    type: "session.view",
    view: input.view.value,
  });
  const stageMessages = input.stageOpens.project({
    worldId: input.command.acceptedSession.worldId,
    worldContentLock: input.worldContentLock,
    stageModuleLocks: input.stageModuleLocks,
    worldState: input.worldState,
    playerEntityId: input.command.acceptedSession.playerEntityId,
    stageInstanceIds: input.stageOpenProjectionIds,
  });
  const openedStages = stageMessages.map((message) => message.value);
  if (
    input.command.commandKind === "dialogue.start" ||
    input.command.commandKind === "dialogue.continue"
  ) {
    return Object.freeze([
      extractDialogueReply(
        input.view,
        requireDialogueId(input.command),
        requireDialogueResponseTurnId(input.command),
      ),
      viewMessage,
      ...openedStages,
      input.result,
    ]);
  }
  if (input.command.commandKind === "player_day.end") {
    return Object.freeze([viewMessage, ...openedStages, input.result]);
  }
  if (input.command.commandKind === "map.move") {
    return Object.freeze([viewMessage, ...openedStages, input.result]);
  }
  if (input.command.commandKind === "dialogue.close") {
    return Object.freeze([viewMessage, ...openedStages, input.result]);
  }
  if (input.command.commandKind === "content_upgrade.accept") {
    return Object.freeze([viewMessage, ...openedStages, input.result]);
  }
  if (input.command.commandKind === "stage.outcome_proposal") {
    return Object.freeze([
      viewMessage,
      ...openedStages,
      createStageOutcomeMessage(
        input.worldState,
        requireStageInstanceId(input.stageInstanceId),
      ),
      input.result,
    ]);
  }

  const completion = requireEventCardCompletion(input.eventCard);
  if (completion.branch === "invalidate") {
    return Object.freeze([viewMessage, ...openedStages, input.result]);
  }
  const presentation = createEventCardPresentationFrame({
    contracts: input.contracts,
    idFactory: input.idFactory,
    view: input.view,
    worldState: input.worldState,
    eventCardId: completion.eventCardId,
  });
  return Object.freeze([
    viewMessage,
    ...openedStages,
    presentation,
    input.result,
  ]);
}

function createEventCardPresentationFrame(input: {
  readonly contracts: ContractValidator;
  readonly idFactory: ServerEnvelopeIdFactory;
  readonly view: SessionViewDocument;
  readonly worldState: JsonObject;
  readonly eventCardId: string;
}): JsonObject {
  const card = requireEventCard(input.worldState, input.eventCardId);
  const sealed = expectJsonObject(
    expectProperty(card, "sealed_result", "EventCardState"),
    "EventCardState.sealed_result",
  );
  const presentation = expectJsonObject(
    expectProperty(
      sealed,
      "presentation",
      "SealedEventResult",
    ),
    "SealedEventResult.presentation",
  );
  const segments = asObjectArray(
    expectProperty(
      presentation,
      "segments",
      "EventResultPresentation",
    ),
    "EventResultPresentation.segments",
  ).map((segment) =>
    projectNarrativeSegment(input.view, segment),
  );

  return Object.freeze({
    type: "presentation.frame",
    frame_id: createCanonicalServerOwnedId(
      input.contracts,
      input.idFactory,
      "presentation_frame_id",
    ),
    view_revision: expectInteger(
      input.view.value,
      "view_revision",
      "SessionView",
    ),
    operations: Object.freeze([
      Object.freeze({
        op: "narrative.show",
        event_card_id: input.eventCardId,
        presentation: Object.freeze({
          presentation_id: expectString(
            presentation,
            "presentation_id",
            "EventResultPresentation",
          ),
          segments: Object.freeze(segments),
        }),
      }),
    ]),
  });
}

function projectNarrativeSegment(
  view: SessionViewDocument,
  segment: JsonObject,
): JsonObject {
  const kind = expectString(
    segment,
    "segment_kind",
    "NarrativeSegment",
  );
  if (kind !== "dialogue_quote") {
    if (kind !== "narration" && kind !== "system" && kind !== "notice") {
      throw new EngineFault(
        "event_card.finalizer.presentation_segment_kind_invalid",
        "Sealed EventCard presentation contains an unsupported segment kind",
        { segment_kind: kind },
      );
    }
    return Object.freeze({
      segment_kind: kind,
      text: cloneJson(
        expectProperty(segment, "text", "GeneratedNarrativeSegment"),
      ),
    });
  }

  const dialogueId = expectString(
    segment,
    "dialogue_id",
    "DialogueTurnQuoteSegment",
  );
  const turnId = expectString(
    segment,
    "turn_id",
    "DialogueTurnQuoteSegment",
  );
  const dialogues = asObjectArray(
    expectProperty(view.value, "dialogues", "SessionView"),
    "SessionView.dialogues",
  ).filter(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueView") ===
      dialogueId,
  );
  if (dialogues.length !== 1) {
    throw new EngineFault(
      "event_card.finalizer.dialogue_quote_not_visible",
      "EventCard presentation may quote only a dialogue visible in the final SessionView",
      {
        dialogue_id: dialogueId,
        turn_id: turnId,
        matches: dialogues.length,
      },
    );
  }
  const turns = asObjectArray(
    expectProperty(
      dialogues[0] as JsonObject,
      "turns",
      "DialogueView",
    ),
    "DialogueView.turns",
  ).filter(
    (turn) =>
      expectString(turn, "turn_id", "DialogueTurnView") === turnId,
  );
  if (turns.length !== 1) {
    throw new EngineFault(
      "event_card.finalizer.dialogue_quote_turn_not_visible",
      "EventCard presentation quote must resolve to one visible DialogueTurn",
      {
        dialogue_id: dialogueId,
        turn_id: turnId,
        matches: turns.length,
      },
    );
  }
  const turn = turns[0] as JsonObject;
  const quote: Record<string, JsonValue> = {
    segment_kind: "dialogue_quote",
    dialogue_id: dialogueId,
    turn_id: turnId,
    speaker: cloneJson(
      expectProperty(turn, "speaker", "DialogueTurnView"),
    ),
    locale: expectString(turn, "locale", "DialogueTurnView"),
    text: expectString(turn, "text", "DialogueTurnView"),
  };
  if (turn.emotion_id !== undefined) {
    quote.emotion_id = expectString(
      turn,
      "emotion_id",
      "DialogueTurnView",
    );
  }
  return Object.freeze(quote);
}

function extractDialogueReply(
  view: SessionViewDocument,
  dialogueId: string,
  responseTurnId: string,
): JsonObject {
  const dialogues = asObjectArray(
    expectProperty(view.value, "dialogues", "SessionView"),
    "SessionView.dialogues",
  ).filter(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueView") ===
      dialogueId,
  );
  if (dialogues.length !== 1) {
    throw new EngineFault(
      "dialogue.finalizer.dialogue_projection_mismatch",
      "Final SessionView must contain exactly one completed dialogue projection",
      { dialogue_id: dialogueId, matches: dialogues.length },
    );
  }
  const turns = asObjectArray(
    expectProperty(
      dialogues[0] as JsonObject,
      "turns",
      "DialogueView",
    ),
    "DialogueView.turns",
  ).filter(
    (turn) =>
      expectString(turn, "turn_id", "DialogueTurnView") ===
      responseTurnId,
  );
  if (turns.length !== 1) {
    throw new EngineFault(
      "dialogue.finalizer.turn_projection_mismatch",
      "Final SessionView must contain exactly one authoritative character turn",
      {
        dialogue_id: dialogueId,
        turn_id: responseTurnId,
        matches: turns.length,
      },
    );
  }
  return Object.freeze({
    type: "dialogue.reply",
    dialogue_id: dialogueId,
    turn: turns[0] as JsonObject,
  });
}

function createCanonicalServerOwnedId(
  contracts: ContractValidator,
  idFactory: ServerEnvelopeIdFactory,
  identity: string,
): string {
  const value = assertUuid(contracts, idFactory.createMessageId());
  if (value !== value.toLowerCase()) {
    throw new EngineFault(
      "command.finalizer.generated_identity_noncanonical",
      "Server-generated finalization UUIDs must use lowercase canonical text",
      { identity, uuid: value },
    );
  }
  return value;
}

async function persistFinalization(input: {
  readonly client: PoolClient;
  readonly command: ValidatedFinalizationCommand;
  readonly envelopes: readonly ServerEnvelopeDocument[];
  readonly result: JsonObject;
  readonly nextSession: EngineSessionRecord;
  readonly nextServerSequence: number;
}): Promise<void> {
  for (const [ordinal, envelope] of input.envelopes.entries()) {
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ServerEnvelope"),
      "ServerEnvelope.message",
    );
    const insert = await input.client.query(
      `INSERT INTO luoxia_engine.command_server_envelopes (
         session_id,
         command_id,
         response_ordinal,
         server_sequence,
         message_id,
         message_type,
         envelope_document,
         created_at
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::integer,
         $4::bigint,
         $5::uuid,
         $6,
         $7::jsonb,
         clock_timestamp()
       )`,
      [
        input.command.sessionId,
        input.command.commandId,
        ordinal,
        expectInteger(envelope.value, "sequence", "ServerEnvelope").toString(),
        expectString(envelope.value, "message_id", "ServerEnvelope"),
        expectString(message, "type", "ServerMessage"),
        JSON.stringify(envelope.value),
      ],
    );
    if (insert.rowCount !== 1) {
      throw new EngineFault(
        "dialogue.finalizer.database_corrupt",
        "ServerEnvelope INSERT did not affect exactly one row",
        {
          session_id: input.command.sessionId,
          command_id: input.command.commandId,
          response_ordinal: ordinal,
        },
      );
    }
  }

  const sessionUpdate = await input.client.query(
    `UPDATE luoxia_engine.engine_sessions
        SET view_revision = $2::bigint,
            world_revision = $3::bigint,
            next_server_sequence = $4::bigint,
            updated_at = clock_timestamp()
      WHERE session_id = $1::uuid
        AND view_revision = $5::bigint
        AND world_revision = $6::bigint`,
    [
      input.command.sessionId,
      input.nextSession.viewRevision.toString(),
      input.nextSession.worldRevision.toString(),
      input.nextServerSequence.toString(),
      input.command.acceptedSession.viewRevision.toString(),
      input.command.acceptedSession.worldRevision.toString(),
    ],
  );
  if (sessionUpdate.rowCount !== 1) {
    throw new EngineFault(
      "dialogue.finalizer.session_stage_conflict",
      "Engine Session changed before dialogue finalization",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }

  const commandUpdate = await input.client.query(
    `UPDATE luoxia_engine.command_journal
        SET command_status = 'completed',
            result_document = $3::jsonb,
            completed_at = clock_timestamp()
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
        AND command_status = 'received'`,
    [
      input.command.sessionId,
      input.command.commandId,
      JSON.stringify(input.result),
    ],
  );
  if (commandUpdate.rowCount !== 1) {
    throw new EngineFault(
      "dialogue.finalizer.command_stage_conflict",
      "Command Journal changed before dialogue finalization",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }
}

function assertRejectedCompletionCode(
  command: ValidatedFinalizationCommand,
  code: string,
): void {
  if (
    command.result === undefined ||
    expectString(command.result, "status", "CommandResult") !== "rejected" ||
    expectString(command.result, "code", "CommandResult") !== code
  ) {
    throw new EngineFault(
      "dialogue.finalizer.completion_conflict",
      "Dialogue command was already finalized with a different rejection",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        requested_code: code,
      },
    );
  }
}

function assertAcceptedCompletionIdentity(
  command: ValidatedFinalizationCommand,
  finalWorldRevision: number,
  responseTurnId: string | undefined,
  eventCard:
    | {
        readonly eventCardId: string;
        readonly branch: EventCardCompletionBranch;
      }
    | undefined,
  stageInstanceId: string | undefined,
): void {
  if (command.commandKind === "player_day.end") {
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
      stageInstanceId !== undefined ||
      command.playerDayFromDay === undefined ||
      finalWorldRevision <= command.acceptedSession.worldRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted player-day completion does not match its persisted command boundary",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          final_world_revision: finalWorldRevision,
          from_day: command.playerDayFromDay ?? null,
        },
      );
    }
    return;
  }
  if (command.commandKind === "event_card.trigger") {
    const expectedFinalRevision =
      command.acceptedSession.worldRevision + 1;
    if (
      responseTurnId !== undefined ||
      eventCard === undefined ||
      stageInstanceId !== undefined ||
      command.eventCardId === undefined ||
      eventCard.eventCardId !== command.eventCardId ||
      command.eventCardBranch === undefined ||
      eventCard.branch !== command.eventCardBranch ||
      !Number.isSafeInteger(expectedFinalRevision) ||
      finalWorldRevision !== expectedFinalRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted EventCard completion must match its committed command packet",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          expected_final_world_revision: expectedFinalRevision,
          actual_final_world_revision: finalWorldRevision,
          expected_event_card_id: command.eventCardId ?? null,
          actual_event_card_id: eventCard?.eventCardId ?? null,
          expected_branch: command.eventCardBranch ?? null,
          actual_branch: eventCard?.branch ?? null,
        },
      );
    }
    return;
  }
  if (command.commandKind === "map.move") {
    const expectedFinalRevision =
      command.acceptedSession.worldRevision + 1;
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
      stageInstanceId !== undefined ||
      command.navigationRuleRequestId === undefined ||
      !Number.isSafeInteger(expectedFinalRevision) ||
      finalWorldRevision !== expectedFinalRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted navigation completion must match its single persisted RulePlugin packet",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          expected_final_world_revision: expectedFinalRevision,
          actual_final_world_revision: finalWorldRevision,
          navigation_rule_request_id:
            command.navigationRuleRequestId ?? null,
        },
      );
    }
    return;
  }
  if (command.commandKind === "stage.outcome_proposal") {
    const expectedFinalRevision =
      command.acceptedSession.worldRevision + 1;
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
      command.stageOutcomeRuleRequestId === undefined ||
      command.stageOutcomeId === undefined ||
      stageInstanceId !== command.stageOutcomeId ||
      !Number.isSafeInteger(expectedFinalRevision) ||
      finalWorldRevision !== expectedFinalRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted Stage outcome completion must match its single persisted RulePlugin packet",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          expected_final_world_revision: expectedFinalRevision,
          actual_final_world_revision: finalWorldRevision,
          expected_stage_instance_id:
            command.stageOutcomeId ?? null,
          actual_stage_instance_id: stageInstanceId ?? null,
          stage_outcome_rule_request_id:
            command.stageOutcomeRuleRequestId ?? null,
        },
      );
    }
    return;
  }
  if (command.commandKind === "dialogue.close") {
    const expectedFinalRevision =
      command.acceptedSession.worldRevision + 1;
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
      stageInstanceId !== undefined ||
      command.dialogueCloseRuleRequestId === undefined ||
      command.dialogueCloseId === undefined ||
      !Number.isSafeInteger(expectedFinalRevision) ||
      finalWorldRevision !== expectedFinalRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted dialogue-close completion must match its single persisted RulePlugin packet",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          expected_final_world_revision: expectedFinalRevision,
          actual_final_world_revision: finalWorldRevision,
          dialogue_close_rule_request_id:
            command.dialogueCloseRuleRequestId ?? null,
          dialogue_id: command.dialogueCloseId ?? null,
        },
      );
    }
    return;
  }
  if (command.commandKind === "content_upgrade.accept") {
    const expectedFinalRevision =
      command.acceptedSession.worldRevision + 1;
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
      stageInstanceId !== undefined ||
      command.contentUpgradeCommandId === undefined ||
      command.contentUpgradeRuleRequestId === undefined ||
      command.contentUpgradeMigrationId === undefined ||
      command.contentUpgradeTargetBundle === undefined ||
      command.contentUpgradeConsentTextDigest === undefined ||
      !Number.isSafeInteger(expectedFinalRevision) ||
      finalWorldRevision !== expectedFinalRevision
    ) {
      throw new EngineFault(
        "command.finalizer.completion_identity_mismatch",
        "Accepted Content Upgrade completion must match its single authorized migration packet",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          accepted_world_revision:
            command.acceptedSession.worldRevision,
          expected_final_world_revision: expectedFinalRevision,
          actual_final_world_revision: finalWorldRevision,
          upgrade_command_id:
            command.contentUpgradeCommandId ?? null,
          content_upgrade_rule_request_id:
            command.contentUpgradeRuleRequestId ?? null,
          migration_id: command.contentUpgradeMigrationId ?? null,
        },
      );
    }
    return;
  }
  assertDialogueAcceptedCompletionIdentity({
    sessionId: command.sessionId,
    commandId: command.commandId,
    acceptedWorldRevision: command.acceptedSession.worldRevision,
    finalWorldRevision,
    responseTurnId,
    commandResponseTurnId: command.responseTurnId,
    dialogueEventsModelRequestId: command.dialogueEventsModelRequestId,
    eventCard,
    stageInstanceId,
  });
}

function assertAcceptedSessionState(
  command: ValidatedFinalizationCommand,
  context: LockedEngineSessionContext,
  finalWorldRevision: number,
): void {
  assertSessionIdentity(command, context);
  if (
    context.session.viewRevision !==
      command.acceptedSession.viewRevision ||
    context.session.worldRevision !==
      command.acceptedSession.worldRevision ||
    context.currentWorldRevision !== finalWorldRevision
  ) {
    throw new EngineFault(
      "dialogue.finalizer.session_state_mismatch",
      "Session and world do not represent the recoverable accepted dialogue boundary",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        accepted_view_revision:
          command.acceptedSession.viewRevision,
        session_view_revision: context.session.viewRevision,
        accepted_world_revision:
          command.acceptedSession.worldRevision,
        session_world_revision: context.session.worldRevision,
        expected_final_world_revision: finalWorldRevision,
        current_world_revision: context.currentWorldRevision,
      },
    );
  }
}

async function readDialogueProposalHistoryRows(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
}): Promise<readonly DialogueProposalHistoryRecord[]> {
  const proposalQuery =
    await input.client.query<DialogueProposalHistoryRow>(
      `SELECT proposal.request_kind,
              proposal.proposal_id::text AS model_proposal_id,
              proposal.proposal_ordinal,
              proposal.world_record_id::text AS world_record_id,
              proposal.rule_request_id::text AS rule_request_id,
              invocation.operation_kind,
              invocation.invocation_status,
              invocation.proposal_id::text AS packet_proposal_id
         FROM luoxia_engine.dialogue_director_proposal_runs AS proposal
         LEFT JOIN luoxia_engine.rule_plugin_invocations AS invocation
           ON invocation.request_id = proposal.rule_request_id
        WHERE proposal.session_id = $1::uuid
          AND proposal.command_id = $2::uuid
        ORDER BY CASE proposal.request_kind
                   WHEN 'director.definition_draft' THEN 0
                   WHEN 'director.goal_plan' THEN 1
                   WHEN 'director.dialogue_events' THEN 2
                   ELSE 3
                 END,
                 proposal.proposal_ordinal`,
      [input.command.sessionId, input.command.commandId],
    );
  const validatedRows = validateDialogueProposalHistoryRows(
    input.contracts,
    input.command,
    proposalQuery.rows,
  );
  const directorQuery =
    await input.client.query<DialogueDirectorOutputRow>(
      `SELECT run.request_kind,
              invocation.invocation_status,
              invocation.response_document
         FROM luoxia_engine.dialogue_director_runs AS run
         JOIN luoxia_engine.model_invocations AS invocation
           ON invocation.request_id = run.model_request_id
        WHERE run.session_id = $1::uuid
          AND run.command_id = $2::uuid
        ORDER BY run.request_kind`,
      [input.command.sessionId, input.command.commandId],
    );
  assertDialogueProposalCoverage(
    input.contracts,
    input.command,
    validatedRows,
    directorQuery.rows,
  );
  return validatedRows;
}

function assertDialogueProposalCoverage(
  contracts: ContractValidator,
  command: ValidatedFinalizationCommand,
  proposals: readonly DialogueProposalHistoryRecord[],
  directorRuns: readonly DialogueDirectorOutputRow[],
): void {
  const seen = new Set<string>();
  for (const run of directorRuns) {
    if (
      seen.has(run.request_kind) ||
      run.invocation_status !== "verified" ||
      run.response_document === null
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_director_history_corrupt",
        "Dialogue Director run is duplicated or lacks a verified response",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          request_kind: run.request_kind,
          invocation_status: run.invocation_status,
        },
      );
    }
    seen.add(run.request_kind);
    const response = contracts.assertObject(
      CONTRACT_REF.modelResponse,
      run.response_document,
    ).value;
    const output = expectJsonObject(
      expectProperty(response, "output", "ModelResponse"),
      "ModelResponse.output",
    );
    if (
      expectString(response, "request_kind", "ModelResponse") !==
        run.request_kind ||
      expectString(output, "output_kind", "ModelOutput") !==
        run.request_kind
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_director_history_corrupt",
        "Dialogue Director response does not match its persisted request kind",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          request_kind: run.request_kind,
        },
      );
    }
    let expectedProposalCount: number;
    switch (run.request_kind) {
      case "director.dialogue_events": {
        const eventCards = expectProperty(
          output,
          "event_cards",
          "DirectorDialogueEventsOutput",
        );
        if (!Array.isArray(eventCards)) {
          throw new EngineFault(
            "command.finalizer.dialogue_director_history_corrupt",
            "Verified dialogue-event output has no event_cards array",
            {
              session_id: command.sessionId,
              command_id: command.commandId,
            },
          );
        }
        expectedProposalCount = eventCards.length;
        break;
      }
      case "director.goal_plan":
      case "director.definition_draft":
        expectedProposalCount = 1;
        break;
      case "director.system_dialogue":
        expectedProposalCount = 0;
        break;
      default:
        throw new EngineFault(
          "command.finalizer.dialogue_director_history_corrupt",
          "Dialogue Director run has an unsupported request kind",
          {
            session_id: command.sessionId,
            command_id: command.commandId,
            request_kind: run.request_kind,
          },
        );
    }
    const actualProposalCount = proposals.filter(
      (proposal) => proposal.request_kind === run.request_kind,
    ).length;
    if (actualProposalCount !== expectedProposalCount) {
      throw new EngineFault(
        "command.finalizer.dialogue_director_history_incomplete",
        "Dialogue proposal identities do not exactly cover the verified Director output",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          request_kind: run.request_kind,
          expected_proposal_count: expectedProposalCount,
          actual_proposal_count: actualProposalCount,
        },
      );
    }
  }
}

async function assertDialogueCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
  readonly responseTurnId: string;
}): Promise<void> {
  const acceptedRevision =
    input.command.acceptedSession.worldRevision;
  const proposalRows = await readDialogueProposalHistoryRows(input);
  const acceptedProposals = proposalRows.filter(
    (row) => row.packet_proposal_id !== null,
  );
  const query = await input.client.query<CommittedEventHistoryRow>(
    `SELECT revision_after::text AS revision_after_text,
            event_document
       FROM luoxia_engine.committed_events
      WHERE world_id = $1::uuid
        AND revision_after > $2::bigint
        AND revision_after <= $3::bigint
      ORDER BY revision_after`,
    [
      input.command.acceptedSession.worldId,
      acceptedRevision.toString(),
      input.finalWorldRevision.toString(),
    ],
  );
  const expectedCount = DIALOGUE_PACKET_COUNT + acceptedProposals.length;
  if (
    input.finalWorldRevision - acceptedRevision !== expectedCount ||
    query.rows.length !== expectedCount
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_history_incomplete",
      "Dialogue completion event history is incomplete",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        expected_count: expectedCount,
        actual_count: query.rows.length,
      },
    );
  }

  for (const [index, row] of query.rows.entries()) {
    const expectedRevisionAfter = acceptedRevision + index + 1;
    const revisionAfter = parseSafeUnsignedInteger(
      row.revision_after_text,
      "command.finalizer.database_corrupt",
      "Dialogue committed event revision",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        revision_after: row.revision_after_text,
      },
    );
    const event = input.contracts.assertObject(
      CONTRACT_REF.committedEvent,
      row.event_document,
    ).value;
    const packet = expectJsonObject(
      expectProperty(event, "packet", "CommittedEvent"),
      "CommittedEvent.packet",
    );
    if (
      revisionAfter !== expectedRevisionAfter ||
      expectString(event, "world_id", "CommittedEvent") !==
        input.command.acceptedSession.worldId ||
      expectInteger(event, "revision_before", "CommittedEvent") !==
        expectedRevisionAfter - 1 ||
      expectInteger(event, "revision_after", "CommittedEvent") !==
        expectedRevisionAfter ||
      expectString(packet, "world_id", "ContentPacket") !==
        input.command.acceptedSession.worldId ||
      expectInteger(packet, "basis_revision", "ContentPacket") !==
        expectedRevisionAfter - 1
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_history_identity_mismatch",
        "Dialogue committed event identity is not contiguous with its accepted command",
        {
          session_id: input.command.sessionId,
          command_id: input.command.commandId,
          expected_revision_after: expectedRevisionAfter,
          actual_revision_after: revisionAfter,
        },
      );
    }
    const op = requireSinglePacketOp(packet, input.command);
    if (index === 0) {
      assertHumanDialogueHistoryOp(input.command, op);
      continue;
    }
    if (index === 1) {
      assertDialogueResponseHistoryOp(
        input.command,
        op,
        input.responseTurnId,
      );
      continue;
    }
    const proposal = acceptedProposals[index - DIALOGUE_PACKET_COUNT];
    if (proposal === undefined) {
      throw new EngineFault(
        "command.finalizer.dialogue_history_incomplete",
        "Dialogue committed proposal history has no matching Journal identity",
        {
          session_id: input.command.sessionId,
          command_id: input.command.commandId,
          event_index: index,
        },
      );
    }
    assertDialogueProposalHistoryOp(
      input.command,
      packet,
      op,
      proposal,
    );
  }
}

function createStageOutcomeMessage(
  worldState: JsonObject,
  stageInstanceId: string,
): JsonObject {
  const stage = requireStage(worldState, stageInstanceId);
  const stageRevision = expectInteger(
    stage,
    "revision",
    "StageInstanceState",
  );
  const status = expectString(
    stage,
    "status",
    "StageInstanceState",
  );
  if (status === "open") {
    return Object.freeze({
      type: "stage.update",
      stage_instance_id: stageInstanceId,
      stage_revision: stageRevision,
      visible_state: expectProperty(
        stage,
        "state",
        "StageInstanceState",
      ),
    });
  }
  if (status === "closed") {
    return Object.freeze({
      type: "stage.close",
      stage_instance_id: stageInstanceId,
      stage_revision: stageRevision,
      reason_code: "outcome_committed",
    });
  }
  throw new EngineFault(
    "command.finalizer.stage_status_invalid",
    "Committed Stage outcome produced an unsupported StageInstance status",
    {
      stage_instance_id: stageInstanceId,
      stage_status: status,
    },
  );
}

async function assertDialogueCloseCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
  readonly finalWorldState: JsonObject;
}): Promise<void> {
  const requestId = input.command.dialogueCloseRuleRequestId;
  const dialogueId = input.command.dialogueCloseId;
  if (requestId === undefined || dialogueId === undefined) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_identity_missing",
      "Dialogue-close completion requires its persisted request and dialogue identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }
  const query = await input.client.query<DialogueCloseCompletionRow>(
    `SELECT invocation.operation_kind,
            invocation.invocation_status,
            invocation.request_document,
            invocation.proposal_id::text AS proposal_id,
            committed.revision_after::text AS revision_after_text,
            committed.event_document
       FROM luoxia_engine.rule_plugin_invocations AS invocation
       LEFT JOIN luoxia_engine.committed_events AS committed
         ON committed.packet_id = invocation.proposal_id
      WHERE invocation.request_id = $1::uuid`,
    [requestId],
  );
  const row = requireAtMostOne(
    query.rows,
    "command.finalizer.database_corrupt",
    "Dialogue-close RulePlugin request lookup returned more than one row",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  );
  if (
    row === undefined ||
    row.operation_kind !== "dialogue.close" ||
    row.invocation_status !== "resolved" ||
    row.proposal_id === null ||
    row.revision_after_text === null ||
    row.event_document === null
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_history_incomplete",
      "Accepted dialogue-close command requires one resolved proposal and its committed packet",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }

  const request = input.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    row.request_document,
  ).value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const requestedDialogueId = expectString(
    requestInput,
    "dialogue_id",
    "DialogueCloseInput",
  );
  const expectedDialogueRevision = expectInteger(
    requestInput,
    "expected_revision",
    "DialogueCloseInput",
  );
  const readonlyWorldState = expectJsonObject(
    expectProperty(readonlyWorld, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const beforeDialogue = requireUniqueDialogueRecord(
    readonlyWorldState,
    dialogueId,
    input.command,
    "readonly_world",
  );
  if (
    expectString(request, "request_id", "RulePluginRequest") !==
      requestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "dialogue.close" ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.command.acceptedSession.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.acceptedSession.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== input.command.acceptedSession.worldRevision ||
    requestedDialogueId !== dialogueId ||
    expectString(
      requestInput,
      "reason_code",
      "DialogueCloseInput",
    ) !== "player_requested" ||
    expectString(beforeDialogue, "status", "DialogueRecord") !==
      "active" ||
    expectInteger(beforeDialogue, "revision", "DialogueRecord") !==
      expectedDialogueRevision ||
    !dialogueContainsPlayer(beforeDialogue, input.command.acceptedSession)
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_request_mismatch",
      "Dialogue-close RulePlugin request differs from its accepted Session command",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
        dialogue_id: dialogueId,
      },
    );
  }

  const revisionAfter = parseSafeUnsignedInteger(
    row.revision_after_text,
    "command.finalizer.database_corrupt",
    "Dialogue-close committed event revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  );
  const event = input.contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const op = ops.length === 1 ? ops[0] : undefined;
  if (
    revisionAfter !== input.finalWorldRevision ||
    expectString(event, "world_id", "CommittedEvent") !==
      input.command.acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      input.command.acceptedSession.worldRevision ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      input.finalWorldRevision ||
    expectString(packet, "packet_id", "ContentPacket") !==
      row.proposal_id ||
    expectString(packet, "world_id", "ContentPacket") !==
      input.command.acceptedSession.worldId ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      input.command.acceptedSession.worldRevision ||
    expectString(source, "source_kind", "PacketSource") !==
      "rule_plugin" ||
    expectString(source, "proposal_id", "PacketSource") !==
      row.proposal_id ||
    op === undefined ||
    expectString(op, "op", "EffectOp") !== "dialogue.close" ||
    expectString(op, "dialogue_id", "DialogueCloseOp") !== dialogueId ||
    expectInteger(op, "expected_revision", "DialogueCloseOp") !==
      expectedDialogueRevision ||
    expectString(op, "reason_code", "DialogueCloseOp") !==
      "player_requested"
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_history_mismatch",
      "Dialogue-close committed packet differs from its resolved RulePlugin proposal",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
        proposal_id: row.proposal_id,
      },
    );
  }

  const finalDialogue = requireUniqueDialogueRecord(
    input.finalWorldState,
    dialogueId,
    input.command,
    "final_world",
  );
  const finalDialogueRevision = expectedDialogueRevision + 1;
  if (
    !Number.isSafeInteger(finalDialogueRevision) ||
    expectString(finalDialogue, "status", "DialogueRecord") !==
      "closed" ||
    expectInteger(finalDialogue, "revision", "DialogueRecord") !==
      finalDialogueRevision
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_state_mismatch",
      "Final WorldState does not contain the exact closed dialogue revision",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        dialogue_id: dialogueId,
        expected_dialogue_revision: Number.isSafeInteger(
          finalDialogueRevision,
        )
          ? finalDialogueRevision
          : null,
      },
    );
  }
}

async function assertContentUpgradeCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
  readonly finalWorldState: JsonObject;
  readonly finalWorldContentLock: JsonObject;
}): Promise<void> {
  const upgradeCommandId = input.command.contentUpgradeCommandId;
  const ruleRequestId = input.command.contentUpgradeRuleRequestId;
  const migrationId = input.command.contentUpgradeMigrationId;
  const targetBundle = input.command.contentUpgradeTargetBundle;
  const consentTextDigest =
    input.command.contentUpgradeConsentTextDigest;
  if (
    upgradeCommandId === undefined ||
    ruleRequestId === undefined ||
    migrationId === undefined ||
    targetBundle === undefined ||
    consentTextDigest === undefined
  ) {
    throw new EngineFault(
      "command.finalizer.content_upgrade_identity_missing",
      "Content Upgrade completion requires its persisted authorization and transformer identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }

  const query = await input.client.query<ContentUpgradeCompletionRow>(
    `SELECT authorization.upgrade_command_id::text
              AS upgrade_command_id,
            authorization.session_id::text AS session_id,
            authorization.client_command_id::text AS client_command_id,
            authorization.rule_request_id::text AS rule_request_id,
            authorization.world_id::text AS world_id,
            authorization.migration_id,
            authorization.source_world_revision::text
              AS source_world_revision_text,
            authorization.source_save_digest,
            authorization.authorization_digest,
            authorization.authorization_document,
            authorization.authorization_status,
            authorization.result_digest,
            invocation.operation_kind,
            invocation.invocation_status,
            invocation.request_document,
            invocation.response_document,
            committed.revision_after::text AS revision_after_text,
            committed.event_document
       FROM luoxia_engine.content_upgrade_authorizations
              AS authorization
       LEFT JOIN luoxia_engine.rule_plugin_invocations AS invocation
         ON invocation.request_id = authorization.rule_request_id
       LEFT JOIN luoxia_engine.committed_events AS committed
         ON committed.packet_id = authorization.upgrade_command_id
      WHERE authorization.upgrade_command_id = $1::uuid`,
    [upgradeCommandId],
  );
  const row = requireAtMostOne(
    query.rows,
    "command.finalizer.database_corrupt",
    "Content Upgrade completion lookup returned more than one authorization",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      upgrade_command_id: upgradeCommandId,
    },
  );
  if (
    row === undefined ||
    row.upgrade_command_id !== upgradeCommandId ||
    row.session_id !== input.command.sessionId ||
    row.client_command_id !== input.command.commandId ||
    row.rule_request_id !== ruleRequestId ||
    row.world_id !== input.command.acceptedSession.worldId ||
    row.migration_id !== migrationId ||
    row.authorization_status !== "commit_ready" ||
    row.result_digest === null ||
    row.operation_kind !== "content_upgrade.transform" ||
    row.invocation_status !== "resolved" ||
    row.request_document === null ||
    row.response_document === null ||
    row.revision_after_text === null ||
    row.event_document === null
  ) {
    throw new EngineFault(
      "command.finalizer.content_upgrade_history_incomplete",
      "Accepted Content Upgrade requires one commit-ready authorization, one resolved transformer result, and one committed packet",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        upgrade_command_id: upgradeCommandId,
        rule_request_id: ruleRequestId,
      },
    );
  }

  const sourceWorldRevision = parseSafeUnsignedInteger(
    row.source_world_revision_text,
    "command.finalizer.database_corrupt",
    "Content Upgrade source world revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      upgrade_command_id: upgradeCommandId,
    },
  );
  const revisionAfter = parseSafeUnsignedInteger(
    row.revision_after_text,
    "command.finalizer.database_corrupt",
    "Content Upgrade committed event revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      upgrade_command_id: upgradeCommandId,
    },
  );
  const authorization = input.contracts.assertObject(
    CONTRACT_REF.upgradeAuthorization,
    row.authorization_document,
  ).value;
  const request = input.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    row.request_document,
  ).value;
  const response = input.contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    row.response_document,
  ).value;
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      request,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const requestAuthorization = expectJsonObject(
    expectProperty(
      requestInput,
      "authorization",
      "ContentUpgradeInput",
    ),
    "ContentUpgradeInput.authorization",
  );
  const sourceSave = input.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    expectProperty(requestInput, "source_save", "ContentUpgradeInput"),
  ).value;
  const sourceBundle = expectJsonObject(
    expectProperty(
      requestInput,
      "source_bundle",
      "ContentUpgradeInput",
    ),
    "ContentUpgradeInput.source_bundle",
  );
  const requestTargetBundle = expectJsonObject(
    expectProperty(
      requestInput,
      "target_bundle",
      "ContentUpgradeInput",
    ),
    "ContentUpgradeInput.target_bundle",
  );
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const unresolved = expectProperty(
    output,
    "unresolved",
    "ContentUpgradeOutput",
  );
  const candidateSave = input.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    expectProperty(output, "candidate_save", "ContentUpgradeOutput"),
  ).value;
  const candidateContentLock = expectJsonObject(
    expectProperty(
      candidateSave,
      "world_content_lock",
      "SaveEnvelope",
    ),
    "SaveEnvelope.world_content_lock",
  );
  const candidateRootBundle = expectJsonObject(
    expectProperty(
      candidateContentLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  const sourceHistory = asObjectArray(
    expectProperty(sourceSave, "migration_history", "SaveEnvelope"),
    "SaveEnvelope.migration_history",
  );
  const candidateHistory = asObjectArray(
    expectProperty(candidateSave, "migration_history", "SaveEnvelope"),
    "SaveEnvelope.migration_history",
  );
  const historyEntry = candidateHistory.at(-1);
  const pluginLock = expectJsonObject(
    expectProperty(request, "plugin_lock", "RulePluginRequest"),
    "RulePluginRequest.plugin_lock",
  );
  const event = input.contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const preconditions = asObjectArray(
    expectProperty(packet, "preconditions", "ContentPacket"),
    "ContentPacket.preconditions",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const op = ops.length === 1 ? ops[0] : undefined;

  if (
    sourceWorldRevision !== input.command.acceptedSession.worldRevision ||
    revisionAfter !== input.finalWorldRevision ||
    expectString(
      authorization,
      "upgrade_command_id",
      "UpgradeAuthorization",
    ) !== upgradeCommandId ||
    expectString(authorization, "world_id", "UpgradeAuthorization") !==
      input.command.acceptedSession.worldId ||
    expectString(
      authorization,
      "migration_id",
      "UpgradeAuthorization",
    ) !== migrationId ||
    expectString(
      authorization,
      "requested_by_actor_id",
      "UpgradeAuthorization",
    ) !== input.command.acceptedSession.playerEntityId ||
    expectInteger(
      authorization,
      "source_world_revision",
      "UpgradeAuthorization",
    ) !== sourceWorldRevision ||
    expectString(
      authorization,
      "source_save_digest",
      "UpgradeAuthorization",
    ) !== row.source_save_digest ||
    expectString(
      authorization,
      "authorization_digest",
      "UpgradeAuthorization",
    ) !== row.authorization_digest ||
    expectString(
      authorization,
      "consent_text_digest",
      "UpgradeAuthorization",
    ) !== consentTextDigest ||
    expectString(
      authorization,
      "source_bundle_digest",
      "UpgradeAuthorization",
    ) !== expectString(sourceBundle, "bundle_digest", "PackLock") ||
    expectString(
      authorization,
      "target_bundle_digest",
      "UpgradeAuthorization",
    ) !== expectString(targetBundle, "bundle_digest", "PackLock") ||
    !jsonEquals(requestAuthorization, authorization) ||
    expectString(request, "request_id", "RulePluginRequest") !==
      ruleRequestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "content_upgrade.transform" ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      sourceWorldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.acceptedSession.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== sourceWorldRevision ||
    expectString(
      requestInput,
      "migration_id",
      "ContentUpgradeInput",
    ) !== migrationId ||
    !jsonEquals(requestTargetBundle, targetBundle) ||
    expectString(sourceSave, "world_id", "SaveEnvelope") !==
      input.command.acceptedSession.worldId ||
    expectInteger(sourceSave, "world_revision", "SaveEnvelope") !==
      sourceWorldRevision ||
    expectString(response, "request_id", "RulePluginResponse") !==
      ruleRequestId ||
    expectString(
      response,
      "operation_kind",
      "RulePluginResponse",
    ) !== "content_upgrade.transform" ||
    expectInteger(
      response,
      "basis_revision",
      "RulePluginResponse",
    ) !== sourceWorldRevision ||
    !jsonEquals(
      expectProperty(response, "plugin_lock", "RulePluginResponse"),
      pluginLock,
    ) ||
    expectString(
      response,
      "operation_id",
      "RulePluginResponse",
    ) !== expectString(request, "operation_id", "RulePluginRequest") ||
    expectString(
      response,
      "deterministic_context_id",
      "RulePluginResponse",
    ) !==
      expectString(
        deterministicContext,
        "context_id",
        "DeterministicContext",
      ) ||
    expectString(
      response,
      "deterministic_context_digest",
      "RulePluginResponse",
    ) !==
      expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      ) ||
    expectString(output, "output_kind", "ContentUpgradeOutput") !==
      "content_upgrade.candidate" ||
    expectString(output, "migration_id", "ContentUpgradeOutput") !==
      migrationId ||
    expectString(
      output,
      "upgrade_command_id",
      "ContentUpgradeOutput",
    ) !== upgradeCommandId ||
    expectString(
      output,
      "source_bundle_digest",
      "ContentUpgradeOutput",
    ) !== expectString(sourceBundle, "bundle_digest", "PackLock") ||
    expectString(
      output,
      "target_bundle_digest",
      "ContentUpgradeOutput",
    ) !== expectString(targetBundle, "bundle_digest", "PackLock") ||
    expectString(
      output,
      "authorization_digest",
      "ContentUpgradeOutput",
    ) !== row.authorization_digest ||
    expectString(output, "result_digest", "ContentUpgradeOutput") !==
      row.result_digest ||
    !Array.isArray(unresolved) ||
    unresolved.length !== 0 ||
    expectString(event, "world_id", "CommittedEvent") !==
      input.command.acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      sourceWorldRevision ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      input.finalWorldRevision ||
    expectString(packet, "packet_id", "ContentPacket") !==
      upgradeCommandId ||
    expectString(packet, "cause_id", "ContentPacket") !== migrationId ||
    expectString(packet, "world_id", "ContentPacket") !==
      input.command.acceptedSession.worldId ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      sourceWorldRevision ||
    preconditions.length !== 0 ||
    !jsonEquals(
      expectProperty(
        packet,
        "deterministic_context",
        "ContentPacket",
      ),
      deterministicContext,
    ) ||
    expectString(source, "source_kind", "PacketSource") !==
      "content_upgrade" ||
    expectString(
      source,
      "upgrade_command_id",
      "PacketSource",
    ) !== upgradeCommandId ||
    expectString(source, "migration_id", "PacketSource") !==
      migrationId ||
    expectString(source, "source_save_digest", "PacketSource") !==
      row.source_save_digest ||
    expectString(source, "authorization_digest", "PacketSource") !==
      row.authorization_digest ||
    expectString(source, "result_digest", "PacketSource") !==
      row.result_digest ||
    op === undefined ||
    expectString(op, "op", "ContentUpgradeApplyOp") !==
      "content_upgrade.apply" ||
    !jsonEquals(
      expectProperty(
        op,
        "candidate_save",
        "ContentUpgradeApplyOp",
      ),
      candidateSave,
    ) ||
    expectString(candidateSave, "world_id", "SaveEnvelope") !==
      input.command.acceptedSession.worldId ||
    expectInteger(candidateSave, "world_revision", "SaveEnvelope") !==
      input.finalWorldRevision ||
    !jsonEquals(
      expectProperty(candidateSave, "world_state", "SaveEnvelope"),
      input.finalWorldState,
    ) ||
    !jsonEquals(candidateContentLock, input.finalWorldContentLock) ||
    !jsonEquals(candidateRootBundle, targetBundle) ||
    candidateHistory.length !== sourceHistory.length + 1 ||
    !sourceHistory.every((entry, index) =>
      jsonEquals(entry, candidateHistory[index] as JsonObject),
    ) ||
    historyEntry === undefined ||
    expectString(
      historyEntry,
      "migration_kind",
      "MigrationHistoryEntry",
    ) !== "content_upgrade" ||
    expectString(historyEntry, "source", "MigrationHistoryEntry") !==
      expectString(sourceBundle, "bundle_digest", "PackLock") ||
    expectString(historyEntry, "target", "MigrationHistoryEntry") !==
      expectString(targetBundle, "bundle_digest", "PackLock") ||
    expectString(
      historyEntry,
      "implementation_digest",
      "MigrationHistoryEntry",
    ) !==
      expectString(
        pluginLock,
        "implementation_digest",
        "PluginLock",
      ) ||
    expectString(
      historyEntry,
      "upgrade_command_id",
      "MigrationHistoryEntry",
    ) !== upgradeCommandId ||
    expectString(
      historyEntry,
      "migration_id",
      "MigrationHistoryEntry",
    ) !== migrationId ||
    expectString(
      historyEntry,
      "source_save_digest",
      "MigrationHistoryEntry",
    ) !== row.source_save_digest ||
    expectString(
      historyEntry,
      "authorization_digest",
      "MigrationHistoryEntry",
    ) !== row.authorization_digest ||
    expectString(
      historyEntry,
      "deterministic_context_digest",
      "MigrationHistoryEntry",
    ) !==
      expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      )
  ) {
    throw new EngineFault(
      "command.finalizer.content_upgrade_history_mismatch",
      "Content Upgrade authorization, transformer receipt, committed packet, and final world do not form one closed migration result",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        upgrade_command_id: upgradeCommandId,
        rule_request_id: ruleRequestId,
        migration_id: migrationId,
      },
    );
  }
}

function requireUniqueDialogueRecord(
  worldState: JsonObject,
  dialogueId: string,
  command: ValidatedFinalizationCommand,
  scope: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  ).filter(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueRecord") ===
      dialogueId,
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "command.finalizer.dialogue_close_state_mismatch",
      "Dialogue-close history must contain exactly one target DialogueRecord",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        dialogue_id: dialogueId,
        scope,
        matches: matches.length,
      },
    );
  }
  return matches[0] as JsonObject;
}

function dialogueContainsPlayer(
  dialogue: JsonObject,
  session: EngineSessionRecord,
): boolean {
  return asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).some((participant) => {
    if (
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) !== "entity"
    ) {
      return false;
    }
    const entity = expectJsonObject(
      expectProperty(
        participant,
        "entity",
        "DialogueParticipantRef",
      ),
      "DialogueParticipantRef.entity",
    );
    return (
      expectString(entity, "world_id", "EntityRef") === session.worldId &&
      expectString(entity, "entity_id", "EntityRef") ===
        session.playerEntityId
    );
  });
}

async function readTerminalRulePluginInvocation(input: {
  readonly client: PoolClient;
  readonly rootRequestId: string;
  readonly multipleRowsMessage: string;
  readonly details: JsonObject;
}): Promise<TerminalRulePluginInvocationRow | undefined> {
  const query =
    await input.client.query<TerminalRulePluginInvocationRow>(
      `WITH RECURSIVE invocation_chain AS (
         SELECT invocation.*,
                ARRAY[invocation.request_id] AS request_path
           FROM luoxia_engine.rule_plugin_invocations AS invocation
          WHERE invocation.request_id = $1::uuid
         UNION ALL
         SELECT child.*,
                array_append(parent.request_path, child.request_id)
           FROM luoxia_engine.rule_plugin_invocations AS child
           JOIN invocation_chain AS parent
             ON child.parent_request_id = parent.request_id
          WHERE NOT child.request_id = ANY(parent.request_path)
       )
       SELECT invocation.request_id::text AS terminal_request_id,
              invocation.operation_kind,
              invocation.invocation_status,
              invocation.request_document,
              invocation.response_document,
              invocation.proposal_id::text AS proposal_id,
              committed.revision_after::text AS revision_after_text,
              committed.event_document
         FROM invocation_chain AS invocation
         LEFT JOIN luoxia_engine.committed_events AS committed
           ON committed.packet_id = invocation.proposal_id
        WHERE NOT EXISTS (
          SELECT 1
            FROM luoxia_engine.rule_plugin_invocations AS child
           WHERE child.parent_request_id = invocation.request_id
        )`,
      [input.rootRequestId],
    );
  return requireAtMostOne(
    query.rows,
    "command.finalizer.database_corrupt",
    input.multipleRowsMessage,
    input.details,
  );
}

function assertNavigationTerminalRequestIdentity(input: {
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly rootRequestId: string;
  readonly terminal: TerminalRulePluginInvocationRow;
  readonly destination: JsonObject;
}): void {
  const request = input.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    input.terminal.request_document,
  ).value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const control = expectJsonObject(
    expectProperty(requestInput, "control", "NavigationResolveInput"),
    "NavigationResolveInput.control",
  );
  const actor = expectJsonObject(
    expectProperty(requestInput, "actor", "NavigationResolveInput"),
    "NavigationResolveInput.actor",
  );
  const requestDestination = expectJsonObject(
    expectProperty(
      requestInput,
      "destination",
      "NavigationResolveInput",
    ),
    "NavigationResolveInput.destination",
  );
  if (
    expectString(request, "request_id", "RulePluginRequest") !==
      input.terminal.terminal_request_id ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "navigation.resolve" ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.command.acceptedSession.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.acceptedSession.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== input.command.acceptedSession.worldRevision ||
    expectString(control, "binding_id", "ControlBindingRef") !==
      input.command.acceptedSession.controlBindingId ||
    expectString(actor, "world_id", "EntityRef") !==
      input.command.acceptedSession.worldId ||
    expectString(actor, "entity_id", "EntityRef") !==
      input.command.acceptedSession.playerEntityId ||
    !jsonEquals(requestDestination, input.destination)
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_request_mismatch",
      "Navigation RulePlugin request differs from its accepted Session command",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: input.rootRequestId,
        terminal_request_id:
          input.terminal.terminal_request_id,
      },
    );
  }
}

async function assertNavigationCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
}): Promise<void> {
  const requestId = input.command.navigationRuleRequestId;
  const destination = input.command.navigationDestination;
  if (requestId === undefined || destination === undefined) {
    throw new EngineFault(
      "command.finalizer.navigation_identity_missing",
      "Navigation completion requires its persisted request and destination identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }
  const row = await readTerminalRulePluginInvocation({
    client: input.client,
    rootRequestId: requestId,
    multipleRowsMessage:
      "Navigation RulePlugin request lookup returned more than one terminal row",
    details: {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  });
  if (
    row === undefined ||
    row.operation_kind !== "navigation.resolve" ||
    row.invocation_status !== "resolved" ||
    row.proposal_id === null ||
    row.revision_after_text === null ||
    row.event_document === null
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_history_incomplete",
      "Accepted navigation command requires one resolved proposal and its committed packet",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }

  assertNavigationTerminalRequestIdentity({
    contracts: input.contracts,
    command: input.command,
    rootRequestId: requestId,
    terminal: row,
    destination,
  });

  const revisionAfter = parseSafeUnsignedInteger(
    row.revision_after_text,
    "command.finalizer.database_corrupt",
    "Navigation committed event revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  );
  const event = input.contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const op = ops.length === 1 ? ops[0] : undefined;
  if (
    revisionAfter !== input.finalWorldRevision ||
    expectString(event, "world_id", "CommittedEvent") !==
      input.command.acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      input.command.acceptedSession.worldRevision ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      input.finalWorldRevision ||
    expectString(packet, "packet_id", "ContentPacket") !==
      row.proposal_id ||
    expectString(packet, "world_id", "ContentPacket") !==
      input.command.acceptedSession.worldId ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      input.command.acceptedSession.worldRevision ||
    expectString(source, "source_kind", "PacketSource") !==
      "rule_plugin" ||
    expectString(source, "proposal_id", "PacketSource") !==
      row.proposal_id ||
    op === undefined ||
    expectString(op, "op", "EffectOp") !== "entity.relocate"
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_history_mismatch",
      "Navigation committed packet differs from its resolved RulePlugin proposal",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
        proposal_id: row.proposal_id,
      },
    );
  }
  const relocatedEntity = expectJsonObject(
    expectProperty(op, "entity", "EntityRelocateOp"),
    "EntityRelocateOp.entity",
  );
  const relocatedDestination = expectJsonObject(
    expectProperty(op, "destination", "EntityRelocateOp"),
    "EntityRelocateOp.destination",
  );
  if (
    expectString(relocatedEntity, "entity_id", "EntityRef") !==
      input.command.acceptedSession.playerEntityId ||
    !jsonEquals(relocatedDestination, destination)
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_operation_mismatch",
      "Navigation relocation operation differs from its accepted actor or destination",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }
}

async function assertNavigationRejectionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly code: string;
}): Promise<void> {
  const requestId = input.command.navigationRuleRequestId;
  const destination = input.command.navigationDestination;
  if (requestId === undefined || destination === undefined) {
    throw new EngineFault(
      "command.finalizer.navigation_identity_missing",
      "Navigation rejection requires its persisted request and destination identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }
  const row = await readTerminalRulePluginInvocation({
    client: input.client,
    rootRequestId: requestId,
    multipleRowsMessage:
      "Navigation RulePlugin rejection lookup returned more than one terminal row",
    details: {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  });
  if (
    row === undefined ||
    row.operation_kind !== "navigation.resolve" ||
    row.invocation_status !== "resolved" ||
    row.response_document === null ||
    row.proposal_id !== null
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_rejection_incomplete",
      "Rejected navigation command requires one resolved Reject output and no proposal",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }
  assertNavigationTerminalRequestIdentity({
    contracts: input.contracts,
    command: input.command,
    rootRequestId: requestId,
    terminal: row,
    destination,
  });
  const response = input.contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    row.response_document,
  ).value;
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  if (
    expectString(response, "request_id", "RulePluginResponse") !==
      row.terminal_request_id ||
    expectString(
      response,
      "operation_kind",
      "RulePluginResponse",
    ) !== "navigation.resolve" ||
    expectString(
      output,
      "output_kind",
      "RulePluginResponse.output",
    ) !== "reject" ||
    expectString(output, "code", "RejectOutput") !== input.code
  ) {
    throw new EngineFault(
      "command.finalizer.navigation_rejection_mismatch",
      "Navigation CommandResult rejection differs from its resolved RulePlugin output",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: requestId,
        terminal_request_id: row.terminal_request_id,
        rejection_code: input.code,
      },
    );
  }
}

function requireSinglePacketOp(
  packet: JsonObject,
  command: ValidatedFinalizationCommand,
): JsonObject {
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  if (ops.length !== 1) {
    throw new EngineFault(
      "command.finalizer.dialogue_history_op_count",
      "Each dialogue command packet must contain exactly one closed operation",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        op_count: ops.length,
      },
    );
  }
  return ops[0] as JsonObject;
}

function assertHumanDialogueHistoryOp(
  command: ValidatedFinalizationCommand,
  op: JsonObject,
): void {
  const expectedKind =
    command.commandKind === "dialogue.start"
      ? "dialogue.open"
      : "dialogue.turn.append";
  const actualKind = expectString(op, "op", "EffectOp");
  const dialogueId = requireDialogueId(command);
  const turn =
    expectedKind === "dialogue.open"
      ? expectJsonObject(
          expectProperty(op, "first_turn", "DialogueOpenOp"),
          "DialogueOpenOp.first_turn",
        )
      : expectJsonObject(
          expectProperty(op, "turn", "DialogueTurnAppendOp"),
          "DialogueTurnAppendOp.turn",
        );
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (
    actualKind !== expectedKind ||
    expectString(op, "dialogue_id", expectedKind) !== dialogueId ||
    expectString(turn, "turn_id", "DialogueTurn") !==
      requireHumanTurnId(command) ||
    expectString(source, "source_kind", "DialogueTurnSource") !==
      "human" ||
    expectString(source, "command_id", "DialogueTurnSource") !==
      command.commandId
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_history_human_mismatch",
      "First dialogue packet does not match the persisted human command turn",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        dialogue_id: dialogueId,
      },
    );
  }
}

function assertDialogueResponseHistoryOp(
  command: ValidatedFinalizationCommand,
  op: JsonObject,
  responseTurnId: string,
): void {
  const turn = expectJsonObject(
    expectProperty(op, "turn", "DialogueTurnAppendOp"),
    "DialogueTurnAppendOp.turn",
  );
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  const expectedSourceKind = command.dialogueResponseKind;
  const expectedModelRequestId = command.responseModelRequestId;
  if (
    expectedSourceKind === undefined ||
    expectedModelRequestId === undefined ||
    expectString(op, "op", "EffectOp") !== "dialogue.turn.append" ||
    expectString(op, "dialogue_id", "DialogueTurnAppendOp") !==
      requireDialogueId(command) ||
    expectString(turn, "turn_id", "DialogueTurn") !==
      responseTurnId ||
    expectString(source, "source_kind", "DialogueTurnSource") !==
      expectedSourceKind ||
    expectString(
      source,
      "model_request_id",
      "DialogueTurnSource",
    ) !== expectedModelRequestId
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_history_response_mismatch",
      "Second dialogue packet does not match the persisted dialogue response identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        dialogue_id: requireDialogueId(command),
        response_turn_id: responseTurnId,
        response_source_kind: expectedSourceKind ?? "",
      },
    );
  }
}

function assertStageOutcomeTerminalRequestIdentity(input: {
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly rootRequestId: string;
  readonly terminal: TerminalRulePluginInvocationRow;
  readonly stageInstanceId: string;
  readonly stageRevision: number;
  readonly outcomeType: string;
  readonly outcome: JsonObject;
  readonly evidenceDigest: string;
}): void {
  const request = input.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    input.terminal.request_document,
  ).value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const control = expectJsonObject(
    expectProperty(
      requestInput,
      "control",
      "StageOutcomeResolveInput",
    ),
    "StageOutcomeResolveInput.control",
  );
  const clientProposal = expectJsonObject(
    expectProperty(
      requestInput,
      "proposal",
      "StageOutcomeResolveInput",
    ),
    "StageOutcomeResolveInput.proposal",
  );
  if (
    expectString(request, "request_id", "RulePluginRequest") !==
      input.terminal.terminal_request_id ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "stage_outcome.resolve" ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.command.acceptedSession.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.acceptedSession.worldId ||
    expectInteger(readonlyWorld, "world_revision", "WorldSnapshot") !==
      input.command.acceptedSession.worldRevision ||
    expectString(control, "binding_id", "ControlBindingRef") !==
      input.command.acceptedSession.controlBindingId ||
    expectString(
      clientProposal,
      "stage_instance_id",
      "StageOutcomeProposal",
    ) !== input.stageInstanceId ||
    expectInteger(
      clientProposal,
      "stage_revision",
      "StageOutcomeProposal",
    ) !== input.stageRevision ||
    expectString(
      clientProposal,
      "outcome_type",
      "StageOutcomeProposal",
    ) !== input.outcomeType ||
    expectString(
      clientProposal,
      "evidence_digest",
      "StageOutcomeProposal",
    ) !== input.evidenceDigest ||
    !jsonEquals(
      expectProperty(
        clientProposal,
        "outcome",
        "StageOutcomeProposal",
      ),
      input.outcome,
    )
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_request_mismatch",
      "Stage outcome RulePlugin request differs from its accepted Session command",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: input.rootRequestId,
        terminal_request_id:
          input.terminal.terminal_request_id,
      },
    );
  }
}

async function assertStageOutcomeCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
  readonly finalWorldState: JsonObject;
  readonly stageInstanceId: string;
}): Promise<void> {
  const requestId = input.command.stageOutcomeRuleRequestId;
  const stageRevision = input.command.stageOutcomeRevision;
  const outcomeType = input.command.stageOutcomeType;
  const outcome = input.command.stageOutcome;
  const evidenceDigest = input.command.stageOutcomeEvidenceDigest;
  if (
    requestId === undefined ||
    input.command.stageOutcomeId !== input.stageInstanceId ||
    stageRevision === undefined ||
    outcomeType === undefined ||
    outcome === undefined ||
    evidenceDigest === undefined
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_identity_missing",
      "Stage outcome completion requires its persisted request and proposal identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        stage_instance_id: input.stageInstanceId,
      },
    );
  }
  const row = await readTerminalRulePluginInvocation({
    client: input.client,
    rootRequestId: requestId,
    multipleRowsMessage:
      "Stage outcome RulePlugin request lookup returned more than one terminal row",
    details: {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  });
  if (
    row === undefined ||
    row.operation_kind !== "stage_outcome.resolve" ||
    row.invocation_status !== "resolved" ||
    row.proposal_id === null ||
    row.revision_after_text === null ||
    row.event_document === null
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_history_incomplete",
      "Accepted Stage outcome requires one resolved proposal and its committed packet",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }

  assertStageOutcomeTerminalRequestIdentity({
    contracts: input.contracts,
    command: input.command,
    rootRequestId: requestId,
    terminal: row,
    stageInstanceId: input.stageInstanceId,
    stageRevision,
    outcomeType,
    outcome,
    evidenceDigest,
  });

  const revisionAfter = parseSafeUnsignedInteger(
    row.revision_after_text,
    "command.finalizer.database_corrupt",
    "Stage outcome committed event revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  );
  const event = input.contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const stageOps = ops.filter((op) => {
    const opKind = expectString(op, "op", "EffectOp");
    return opKind === "stage.update" || opKind === "stage.close";
  });
  const stageOp = stageOps.length === 1 ? stageOps[0] : undefined;
  if (
    revisionAfter !== input.finalWorldRevision ||
    expectString(event, "world_id", "CommittedEvent") !==
      input.command.acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      input.command.acceptedSession.worldRevision ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      input.finalWorldRevision ||
    expectString(packet, "packet_id", "ContentPacket") !==
      row.proposal_id ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      input.command.acceptedSession.worldRevision ||
    expectString(source, "source_kind", "PacketSource") !==
      "rule_plugin" ||
    expectString(source, "proposal_id", "PacketSource") !==
      row.proposal_id ||
    stageOp === undefined ||
    ops[ops.length - 1] !== stageOp ||
    expectString(
      stageOp,
      "stage_instance_id",
      "Stage outcome op",
    ) !== input.stageInstanceId ||
    expectInteger(stageOp, "revision", "Stage outcome op") !==
      stageRevision
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_history_mismatch",
      "Stage outcome committed packet differs from its resolved RulePlugin proposal",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
        proposal_id: row.proposal_id,
      },
    );
  }

  const finalStage = requireStage(
    input.finalWorldState,
    input.stageInstanceId,
  );
  if (
    expectInteger(finalStage, "revision", "StageInstanceState") !==
      stageRevision + 1
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_final_revision_mismatch",
      "Committed StageInstance revision does not match the accepted Stage outcome",
      {
        stage_instance_id: input.stageInstanceId,
        expected_revision: stageRevision + 1,
        actual_revision: expectInteger(
          finalStage,
          "revision",
          "StageInstanceState",
        ),
      },
    );
  }
  const opKind = expectString(stageOp, "op", "EffectOp");
  if (opKind === "stage.update") {
    if (
      expectString(finalStage, "status", "StageInstanceState") !== "open" ||
      expectString(
        stageOp,
        "evidence_digest",
        "StageUpdateOp",
      ) !== evidenceDigest ||
      !jsonEquals(
        expectProperty(finalStage, "state", "StageInstanceState"),
        expectProperty(stageOp, "state", "StageUpdateOp"),
      )
    ) {
      throw new EngineFault(
        "command.finalizer.stage_outcome_update_mismatch",
        "Final StageInstance does not match the committed stage.update",
        { stage_instance_id: input.stageInstanceId },
      );
    }
    return;
  }
  if (
    opKind !== "stage.close" ||
    expectString(finalStage, "status", "StageInstanceState") !== "closed" ||
    expectString(stageOp, "outcome_type", "StageCloseOp") !==
      outcomeType ||
    !jsonEquals(
      expectProperty(stageOp, "outcome", "StageCloseOp"),
      outcome,
    )
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_close_mismatch",
      "Final StageInstance does not match the committed stage.close",
      { stage_instance_id: input.stageInstanceId },
    );
  }
}

async function assertStageOutcomeRejectionBoundary(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly code: string;
}): Promise<void> {
  const requestId = input.command.stageOutcomeRuleRequestId;
  if (requestId === undefined) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_identity_missing",
      "Stage outcome rejection requires its persisted RulePlugin root request identity",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
      },
    );
  }
  const query = await input.client.query<StageOutcomeRejectionBoundaryRow>(
    `SELECT EXISTS (
       SELECT 1
         FROM luoxia_engine.rule_plugin_invocations AS invocation
        WHERE invocation.request_id = $1::uuid
     ) AS root_invocation_exists,
     EXISTS (
       SELECT 1
         FROM luoxia_engine.committed_events AS committed
        WHERE committed.world_id = $2::uuid
          AND committed.revision_after > $3::bigint
     ) AS later_committed_event_exists`,
    [
      requestId,
      input.command.acceptedSession.worldId,
      input.command.acceptedSession.worldRevision.toString(),
    ],
  );
  const boundary = requireAtMostOne(
    query.rows,
    "command.finalizer.database_corrupt",
    "Stage outcome rejection boundary lookup returned more than one row",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  );
  if (boundary === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Stage outcome rejection boundary lookup returned no row",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }
  if (boundary.later_committed_event_exists) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_rejection_after_event",
      "Stage outcome command cannot be rejected after its accepted world basis has a later CommittedEvent",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        world_id: input.command.acceptedSession.worldId,
        accepted_world_revision:
          input.command.acceptedSession.worldRevision,
      },
    );
  }
  if (boundary.root_invocation_exists) {
    await assertStageOutcomeRejectionHistory(input);
    return;
  }
  if (!isStageOutcomePreInvocationRejectionCode(input.code)) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_rejection_history_incomplete",
      "Stage outcome rejection without a RulePlugin root invocation requires an approved pre-invocation rejection code",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
        rejection_code: input.code,
      },
    );
  }
}

async function assertStageOutcomeRejectionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly code: string;
}): Promise<void> {
  const requestId = input.command.stageOutcomeRuleRequestId;
  const stageInstanceId = input.command.stageOutcomeId;
  const stageRevision = input.command.stageOutcomeRevision;
  const outcomeType = input.command.stageOutcomeType;
  const outcome = input.command.stageOutcome;
  const evidenceDigest = input.command.stageOutcomeEvidenceDigest;
  if (
    requestId === undefined ||
    stageInstanceId === undefined ||
    stageRevision === undefined ||
    outcomeType === undefined ||
    outcome === undefined ||
    evidenceDigest === undefined
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_identity_missing",
      "Stage outcome rejection requires its persisted request and proposal identities",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        stage_instance_id: stageInstanceId ?? null,
      },
    );
  }
  const row = await readTerminalRulePluginInvocation({
    client: input.client,
    rootRequestId: requestId,
    multipleRowsMessage:
      "Stage outcome RulePlugin rejection lookup returned more than one terminal row",
    details: {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      request_id: requestId,
    },
  });
  if (
    row === undefined ||
    row.operation_kind !== "stage_outcome.resolve" ||
    row.invocation_status !== "resolved" ||
    row.response_document === null ||
    row.proposal_id !== null
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_rejection_incomplete",
      "Rejected Stage outcome requires one resolved Reject output and no proposal",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        request_id: requestId,
      },
    );
  }
  assertStageOutcomeTerminalRequestIdentity({
    contracts: input.contracts,
    command: input.command,
    rootRequestId: requestId,
    terminal: row,
    stageInstanceId,
    stageRevision,
    outcomeType,
    outcome,
    evidenceDigest,
  });
  const response = input.contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    row.response_document,
  ).value;
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  if (
    expectString(response, "request_id", "RulePluginResponse") !==
      row.terminal_request_id ||
    expectString(
      response,
      "operation_kind",
      "RulePluginResponse",
    ) !== "stage_outcome.resolve" ||
    expectString(
      output,
      "output_kind",
      "RulePluginResponse.output",
    ) !== "reject" ||
    expectString(output, "code", "RejectOutput") !== input.code
  ) {
    throw new EngineFault(
      "command.finalizer.stage_outcome_rejection_mismatch",
      "Stage outcome CommandResult rejection differs from its resolved RulePlugin output",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: requestId,
        terminal_request_id: row.terminal_request_id,
        rejection_code: input.code,
      },
    );
  }
}

function validateDialogueProposalHistoryRows(
  contracts: ContractValidator,
  command: ValidatedFinalizationCommand,
  rows: readonly DialogueProposalHistoryRow[],
): readonly DialogueProposalHistoryRecord[] {
  const nextOrdinal: Record<DialogueDirectorProposalKind, number> = {
    definition: 0,
    goal_plan: 0,
    event_card: 0,
  };
  const expectedOperation: Readonly<
    Record<DialogueDirectorProposalKind, string>
  > =
    Object.freeze({
      definition: "definition.validate",
      goal_plan: "goal_plan.validate",
      event_card: "event_card.publish",
    });
  const validated: DialogueProposalHistoryRecord[] = [];
  for (const row of rows) {
    const requestKind = readDialogueDirectorRequestKind(row.request_kind);
    const proposalKind = dialogueDirectorProposalKind(requestKind);
    const operationKind =
      proposalKind === undefined
        ? undefined
        : expectedOperation[proposalKind];
    const ordinal =
      proposalKind === undefined
        ? undefined
        : nextOrdinal[proposalKind];
    const modelProposalId = assertUuid(
      contracts,
      row.model_proposal_id,
    );
    const ruleRequestId = assertUuid(contracts, row.rule_request_id);
    if (
      proposalKind === undefined ||
      operationKind === undefined ||
      ordinal === undefined ||
      row.proposal_ordinal !== ordinal ||
      row.invocation_status !== "resolved" ||
      row.operation_kind !== operationKind
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_proposal_history_corrupt",
        "Dialogue proposal Journal is incomplete or disagrees with its resolved RulePlugin invocation",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          proposal_kind: proposalKind ?? "",
          request_kind: row.request_kind,
          proposal_id: modelProposalId,
          proposal_ordinal: row.proposal_ordinal,
          rule_request_id: ruleRequestId,
          invocation_status: row.invocation_status ?? "",
          operation_kind: row.operation_kind ?? "",
        },
      );
    }
    nextOrdinal[proposalKind] = ordinal + 1;
    if (
      (proposalKind === "event_card" &&
        row.world_record_id !== null) ||
      (proposalKind !== "event_card" &&
        row.world_record_id === null)
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_proposal_history_corrupt",
        "Dialogue proposal Journal WorldState identity shape disagrees with its proposal kind",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          proposal_kind: proposalKind,
          proposal_id: modelProposalId,
        },
      );
    }
    if (row.world_record_id !== null) {
      assertUuid(contracts, row.world_record_id);
    }
    if (row.packet_proposal_id !== null) {
      assertUuid(contracts, row.packet_proposal_id);
    }
    validated.push(
      Object.freeze({
        ...row,
        proposal_kind: proposalKind,
      }),
    );
  }
  return Object.freeze(validated);
}

function readDialogueDirectorRequestKind(
  value: string,
): DialogueDirectorRequestKind {
  switch (value) {
    case "director.dialogue_events":
    case "director.system_dialogue":
    case "director.goal_plan":
    case "director.definition_draft":
      return value;
    default:
      throw new EngineFault(
        "command.finalizer.dialogue_proposal_history_corrupt",
        "Dialogue proposal Journal has an unsupported Director request kind",
        { request_kind: value },
      );
  }
}

function dialogueProposalHistoryFault(
  command: ValidatedFinalizationCommand,
  proposal: DialogueProposalHistoryRecord,
): EngineFault {
  return new EngineFault(
    "command.finalizer.dialogue_proposal_history_mismatch",
    "Committed post-dialogue operation differs from its persisted Director proposal identity",
    {
      session_id: command.sessionId,
      command_id: command.commandId,
      request_kind: proposal.request_kind,
      proposal_kind: proposal.proposal_kind,
      model_proposal_id: proposal.model_proposal_id,
      world_record_id: proposal.world_record_id ?? "",
    },
  );
}

function assertDialogueProposalHistoryOp(
  command: ValidatedFinalizationCommand,
  packet: JsonObject,
  op: JsonObject,
  proposal: DialogueProposalHistoryRecord,
): void {
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  if (
    proposal.packet_proposal_id === null ||
    expectString(source, "source_kind", "PacketSource") !==
      "rule_plugin" ||
    expectString(source, "proposal_id", "PacketSource") !==
      proposal.packet_proposal_id
  ) {
    throw new EngineFault(
      "command.finalizer.dialogue_history_proposal_source_mismatch",
      "Post-dialogue packet does not match its persisted RulePlugin proposal identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        proposal_kind: proposal.proposal_kind,
        model_proposal_id: proposal.model_proposal_id,
      },
    );
  }
  if (proposal.proposal_kind === "definition") {
    const provenance = expectJsonObject(
      expectProperty(op, "provenance", "DefinitionRegisterOp"),
      "DefinitionRegisterOp.provenance",
    );
    if (
      proposal.world_record_id === null ||
      expectString(op, "op", "EffectOp") !== "definition.register" ||
      expectString(
        op,
        "definition_id",
        "DefinitionRegisterOp",
      ) !== proposal.world_record_id ||
      expectString(provenance, "origin_kind", "Provenance") !==
        "model_proposal" ||
      expectString(provenance, "origin_id", "Provenance") !==
        proposal.model_proposal_id
    ) {
      throw dialogueProposalHistoryFault(command, proposal);
    }
    return;
  }
  if (proposal.proposal_kind === "goal_plan") {
    const goalPlan = expectJsonObject(
      expectProperty(op, "goal_plan", "GoalPlanUpsertOp"),
      "GoalPlanUpsertOp.goal_plan",
    );
    if (
      proposal.world_record_id === null ||
      expectString(op, "op", "EffectOp") !== "goal_plan.upsert" ||
      expectString(goalPlan, "plan_id", "GoalPlan") !==
        proposal.world_record_id ||
      expectString(
        goalPlan,
        "source_proposal_id",
        "GoalPlan",
      ) !== proposal.model_proposal_id
    ) {
      throw dialogueProposalHistoryFault(command, proposal);
    }
    return;
  }
  const control = expectJsonObject(
    expectProperty(op, "control", "EventCardPublishOp"),
    "EventCardPublishOp.control",
  );
  if (
    expectString(op, "op", "EffectOp") !== "event_card.publish" ||
    expectString(
      op,
      "source_proposal_id",
      "EventCardPublishOp",
    ) !== proposal.model_proposal_id ||
    expectString(
      op,
      "source_dialogue_id",
      "EventCardPublishOp",
    ) !== requireDialogueId(command) ||
    expectString(control, "binding_id", "ControlBindingRef") !==
      command.acceptedSession.controlBindingId
  ) {
    throw dialogueProposalHistoryFault(command, proposal);
  }
}

function assertPlayerDayCompletion(
  command: ValidatedFinalizationCommand,
  worldState: JsonObject,
): void {
  const fromDay = command.playerDayFromDay;
  if (fromDay === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "player_day.end command is missing its persisted source day",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const currentDay = expectInteger(dayCycle, "day", "DayCycleState");
  const currentPhase = expectString(dayCycle, "phase", "DayCycleState");
  const control = Object.freeze({
    binding_id: command.acceptedSession.controlBindingId,
  });
  const budgets = asObjectArray(
    expectProperty(worldState, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  ).filter(
    (budget) =>
      expectInteger(budget, "day", "EventBudgetState") === currentDay &&
      jsonEquals(
        expectProperty(budget, "control", "EventBudgetState"),
        control,
      ),
  );
  if (
    currentDay !== fromDay + 1 ||
    currentPhase !== "player" ||
    budgets.length !== 1
  ) {
    throw new EngineFault(
      "command.finalizer.player_day_boundary_mismatch",
      "player_day.end can complete only at the next player phase with one authoritative EventBudget",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        from_day: fromDay,
        current_day: currentDay,
        current_phase: currentPhase,
        event_budget_matches: budgets.length,
      },
    );
  }
}

function assertEventCardCompletion(
  command: ValidatedFinalizationCommand,
  worldState: JsonObject,
  completion: {
    readonly eventCardId: string;
    readonly branch: EventCardCompletionBranch;
  },
): void {
  const card = requireEventCard(worldState, completion.eventCardId);
  const control = expectJsonObject(
    expectProperty(card, "control", "EventCardState"),
    "EventCardState.control",
  );
  const actualControlBindingId = expectString(
    control,
    "binding_id",
    "ControlBindingRef",
  );
  const expectedStatus =
    completion.branch === "trigger" ? "triggered" : "invalidated";
  const actualStatus = expectString(
    card,
    "status",
    "EventCardState",
  );
  if (
    command.eventCardId !== completion.eventCardId ||
    command.eventCardBranch !== completion.branch ||
    actualControlBindingId !==
      command.acceptedSession.controlBindingId ||
    actualStatus !== expectedStatus
  ) {
    throw new EngineFault(
      "command.finalizer.event_card_boundary_mismatch",
      "EventCard command can complete only at its exact committed card branch",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        expected_event_card_id: command.eventCardId ?? null,
        actual_event_card_id: completion.eventCardId,
        expected_branch: command.eventCardBranch ?? null,
        actual_branch: completion.branch,
        expected_control_binding_id:
          command.acceptedSession.controlBindingId,
        actual_control_binding_id: actualControlBindingId,
        expected_status: expectedStatus,
        actual_status: actualStatus,
      },
    );
  }
}

function requireEventCard(
  worldState: JsonObject,
  eventCardId: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(worldState, "event_cards", "WorldState"),
    "WorldState.event_cards",
  ).filter(
    (card) =>
      expectString(card, "event_card_id", "EventCardState") ===
      eventCardId,
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "command.finalizer.event_card_match",
      "EventCard command must resolve to exactly one final WorldState card",
      { event_card_id: eventCardId, matches: matches.length },
    );
  }
  return matches[0] as JsonObject;
}

function requireStage(
  worldState: JsonObject,
  stageInstanceId: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(worldState, "stage_instances", "WorldState"),
    "WorldState.stage_instances",
  ).filter(
    (stage) =>
      expectString(
        stage,
        "stage_instance_id",
        "StageInstanceState",
      ) === stageInstanceId,
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "command.finalizer.stage_match",
      "Stage outcome command must resolve to exactly one final StageInstance",
      {
        stage_instance_id: stageInstanceId,
        matches: matches.length,
      },
    );
  }
  return matches[0] as JsonObject;
}

function requireStageInstanceId(
  stageInstanceId: string | undefined,
): string {
  if (stageInstanceId === undefined) {
    throw new EngineFault(
      "command.finalizer.stage_identity_missing",
      "Stage outcome finalization requires its StageInstance identity",
    );
  }
  return stageInstanceId;
}

function requireEventCardCompletion(
  completion:
    | {
        readonly eventCardId: string;
        readonly branch: EventCardCompletionBranch;
      }
    | undefined,
): {
  readonly eventCardId: string;
  readonly branch: EventCardCompletionBranch;
} {
  if (completion === undefined) {
    throw new EngineFault(
      "command.finalizer.event_card_completion_missing",
      "EventCard finalization requires its committed card identity and branch",
    );
  }
  return completion;
}

function requireDialogueId(
  command: ValidatedFinalizationCommand,
): string {
  if (command.dialogueId === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Dialogue command is missing its persisted dialogue identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  return command.dialogueId;
}

function requireHumanTurnId(
  command: ValidatedFinalizationCommand,
): string {
  if (command.humanTurnId === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Dialogue command is missing its persisted human turn identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  return command.humanTurnId;
}

function requireDialogueResponseTurnId(
  command: ValidatedFinalizationCommand,
): string {
  if (command.responseTurnId === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Dialogue command is missing its persisted response turn identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  return command.responseTurnId;
}

function assertUnchangedSessionState(
  command: ValidatedFinalizationCommand,
  context: LockedEngineSessionContext,
): void {
  assertSessionIdentity(command, context);
  if (
    context.session.viewRevision !==
      command.acceptedSession.viewRevision ||
    context.session.worldRevision !==
      command.acceptedSession.worldRevision ||
    context.currentWorldRevision !==
      command.acceptedSession.worldRevision
  ) {
    throw new EngineFault(
      "command.finalizer.rejection_after_mutation",
      "A command can be rejected only before any Session or world mutation",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        accepted_view_revision:
          command.acceptedSession.viewRevision,
        session_view_revision: context.session.viewRevision,
        accepted_world_revision:
          command.acceptedSession.worldRevision,
        session_world_revision: context.session.worldRevision,
        current_world_revision: context.currentWorldRevision,
      },
    );
  }
}

function assertSessionIdentity(
  command: ValidatedFinalizationCommand,
  context: LockedEngineSessionContext,
): void {
  const accepted = command.acceptedSession;
  const current = context.session;
  if (
    current.sessionId !== accepted.sessionId ||
    current.worldId !== accepted.worldId ||
    current.controlBindingId !== accepted.controlBindingId ||
    current.playerEntityId !== accepted.playerEntityId ||
    current.nonce !== accepted.nonce
  ) {
    throw new EngineFault(
      "dialogue.finalizer.session_identity_changed",
      "Engine Session identity or ControlBinding changed during dialogue execution",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
}

async function requireFinalizationCommand(
  client: PoolClient,
  contracts: ContractValidator,
  sessionId: string,
  commandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<ValidatedFinalizationCommand> {
  const row = await readFinalizationCommandRow(
    client,
    sessionId,
    commandId,
    lockClause,
  );
  if (row === undefined) {
    throw new EngineFault(
      "dialogue.finalizer.command_missing",
      "Dialogue command cannot finalize before it is received",
      { session_id: sessionId, command_id: commandId },
    );
  }
  return validateFinalizationCommandRow(
    contracts,
    row,
    sessionId,
    commandId,
  );
}

async function readFinalizationCommandRow(
  client: PoolClient,
  sessionId: string,
  commandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<FinalizationCommandRow | undefined> {
  const sqlLockClause =
    lockClause === "FOR UPDATE" ? "FOR UPDATE OF command" : "";
  const query = await client.query<FinalizationCommandRow>(
    `SELECT command.session_id::text AS session_id,
            command.command_id::text AS command_id,
            command.command_kind,
            command.request_document,
            command.accepted_world_id::text AS accepted_world_id,
            command.accepted_control_binding_id::text
              AS accepted_control_binding_id,
            command.accepted_player_entity_id::text
              AS accepted_player_entity_id,
            command.accepted_view_revision::text
              AS accepted_view_revision_text,
            command.accepted_world_revision::text
              AS accepted_world_revision_text,
            command.accepted_nonce::text AS accepted_nonce,
            command.dialogue_id::text AS dialogue_id,
            command.human_turn_id::text AS human_turn_id,
            command.character_model_request_id::text
              AS character_model_request_id,
            command.character_turn_id::text AS character_turn_id,
            director_events.model_request_id::text
              AS director_dialogue_events_model_request_id,
            director_system.model_request_id::text
              AS director_system_model_request_id,
            director_system.response_turn_id::text
              AS director_system_response_turn_id,
            director_goal_plan.model_request_id::text
              AS director_goal_plan_model_request_id,
            director_definition_draft.model_request_id::text
              AS director_definition_draft_model_request_id,
            player_day.from_day::text AS player_day_from_day_text,
            command.event_card_packet_id::text
              AS event_card_packet_id,
            command.navigation_rule_request_id::text
              AS navigation_rule_request_id,
            command.stage_outcome_rule_request_id::text
              AS stage_outcome_rule_request_id,
            command.dialogue_close_rule_request_id::text
              AS dialogue_close_rule_request_id,
            command.content_upgrade_command_id::text
              AS content_upgrade_command_id,
            command.content_upgrade_rule_request_id::text
              AS content_upgrade_rule_request_id,
            event_card_commit.event_document
              AS event_card_committed_event_document,
            command.command_status,
            command.result_document
       FROM luoxia_engine.command_journal AS command
       LEFT JOIN luoxia_engine.player_day_end_runs AS player_day
         ON player_day.session_id = command.session_id
        AND player_day.command_id = command.command_id
       LEFT JOIN luoxia_engine.dialogue_director_runs
         AS director_events
         ON director_events.session_id = command.session_id
        AND director_events.command_id = command.command_id
        AND director_events.request_kind =
              'director.dialogue_events'
       LEFT JOIN luoxia_engine.dialogue_director_runs
         AS director_system
         ON director_system.session_id = command.session_id
        AND director_system.command_id = command.command_id
        AND director_system.request_kind =
              'director.system_dialogue'
       LEFT JOIN luoxia_engine.dialogue_director_runs
         AS director_goal_plan
         ON director_goal_plan.session_id = command.session_id
        AND director_goal_plan.command_id = command.command_id
        AND director_goal_plan.request_kind =
              'director.goal_plan'
       LEFT JOIN luoxia_engine.dialogue_director_runs
         AS director_definition_draft
         ON director_definition_draft.session_id =
              command.session_id
        AND director_definition_draft.command_id =
              command.command_id
        AND director_definition_draft.request_kind =
              'director.definition_draft'
       LEFT JOIN luoxia_engine.committed_events AS event_card_commit
         ON event_card_commit.packet_id = command.event_card_packet_id
        AND command.command_kind = 'event_card.trigger'
      WHERE command.session_id = $1::uuid
        AND command.command_id = $2::uuid
      ${sqlLockClause}`,
    [sessionId, commandId],
  );
  return requireAtMostOne(
    query.rows,
    "dialogue.finalizer.database_corrupt",
    "Dialogue command lookup returned more than one row",
    { session_id: sessionId, command_id: commandId },
  );
}

function validateFinalizationCommandRow(
  contracts: ContractValidator,
  row: FinalizationCommandRow,
  expectedSessionId: string,
  expectedCommandId: string,
): ValidatedFinalizationCommand {
  const sessionId = assertUuid(contracts, row.session_id);
  const commandId = assertUuid(contracts, row.command_id);
  if (
    sessionId !== expectedSessionId ||
    commandId !== expectedCommandId
  ) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Dialogue command row identity differs from its lookup key",
      {
        session_id: expectedSessionId,
        command_id: expectedCommandId,
        row_session_id: sessionId,
        row_command_id: commandId,
      },
    );
  }
  if (
    row.command_kind !== "dialogue.start" &&
    row.command_kind !== "dialogue.continue" &&
    row.command_kind !== "dialogue.close" &&
    row.command_kind !== "player_day.end" &&
    row.command_kind !== "event_card.trigger" &&
    row.command_kind !== "map.move" &&
    row.command_kind !== "stage.outcome_proposal" &&
    row.command_kind !== "content_upgrade.accept"
  ) {
    throw new EngineFault(
      "command.finalizer.command_kind_invalid",
      "Command finalizer accepts only its registered world command kinds",
      {
        session_id: sessionId,
        command_id: commandId,
        command_kind: row.command_kind,
      },
    );
  }
  const envelope = contracts.assertObject(
    CONTRACT_REF.clientEnvelope,
    row.request_document,
  );
  const message = expectJsonObject(
    expectProperty(envelope.value, "message", "ClientEnvelope"),
    "ClientEnvelope.message",
  );
  if (
    expectString(envelope.value, "session_id", "ClientEnvelope") !==
      sessionId ||
    expectString(message, "command_id", "ClientMessage") !==
      commandId ||
    expectString(message, "type", "ClientMessage") !== row.command_kind
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Command request document identity differs from its row",
      { session_id: sessionId, command_id: commandId },
    );
  }
  const isDialogue =
    row.command_kind === "dialogue.start" ||
    row.command_kind === "dialogue.continue";
  const isPlayerDay = row.command_kind === "player_day.end";
  const isEventCard = row.command_kind === "event_card.trigger";
  const isNavigation = row.command_kind === "map.move";
  const isStageOutcome =
    row.command_kind === "stage.outcome_proposal";
  const isDialogueClose = row.command_kind === "dialogue.close";
  const isContentUpgrade =
    row.command_kind === "content_upgrade.accept";
  if (
    (isDialogue &&
      (row.dialogue_id === null ||
        row.human_turn_id === null ||
        row.character_model_request_id === null ||
        row.character_turn_id === null ||
        row.player_day_from_day_text !== null)) ||
    (!isDialogue &&
      (row.dialogue_id !== null ||
        row.human_turn_id !== null ||
        row.character_model_request_id !== null ||
        row.character_turn_id !== null)) ||
    (isPlayerDay && row.player_day_from_day_text === null) ||
    (!isPlayerDay && row.player_day_from_day_text !== null) ||
    (isEventCard && row.event_card_packet_id === null) ||
    (!isEventCard && row.event_card_packet_id !== null) ||
    (isNavigation && row.navigation_rule_request_id === null) ||
    (!isNavigation && row.navigation_rule_request_id !== null) ||
    (isStageOutcome &&
      (row.stage_outcome_rule_request_id === null ||
        row.stage_outcome_rule_request_id === commandId)) ||
    (!isStageOutcome &&
      row.stage_outcome_rule_request_id !== null) ||
    (isDialogueClose &&
      (row.dialogue_close_rule_request_id === null ||
        row.dialogue_close_rule_request_id === commandId)) ||
    (!isDialogueClose &&
      row.dialogue_close_rule_request_id !== null) ||
    (isContentUpgrade &&
      (row.content_upgrade_command_id === null ||
        row.content_upgrade_rule_request_id === null ||
        row.content_upgrade_command_id === commandId ||
        row.content_upgrade_rule_request_id === commandId ||
        row.content_upgrade_command_id ===
          row.content_upgrade_rule_request_id)) ||
    (!isContentUpgrade &&
      (row.content_upgrade_command_id !== null ||
        row.content_upgrade_rule_request_id !== null))
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Command-specific execution identities disagree with its kind",
      {
        session_id: sessionId,
        command_id: commandId,
        command_kind: row.command_kind,
      },
    );
  }
  const acceptedSession: EngineSessionRecord = Object.freeze({
    sessionId,
    worldId: assertUuid(contracts, row.accepted_world_id),
    controlBindingId: assertUuid(
      contracts,
      row.accepted_control_binding_id,
    ),
    playerEntityId: assertUuid(
      contracts,
      row.accepted_player_entity_id,
    ),
    viewRevision: parseSafeUnsignedInteger(
      row.accepted_view_revision_text,
      "dialogue.finalizer.database_corrupt",
      "Accepted Session view revision",
      { session_id: sessionId, command_id: commandId },
    ),
    worldRevision: parseSafeUnsignedInteger(
      row.accepted_world_revision_text,
      "dialogue.finalizer.database_corrupt",
      "Accepted Session world revision",
      { session_id: sessionId, command_id: commandId },
    ),
    nonce: assertUuid(contracts, row.accepted_nonce),
  });
  const eventCard = readEventCardCommitIdentity(
    contracts,
    row,
    message,
    row.command_kind,
    commandId,
    acceptedSession,
  );
  const dialogueResponse = readDialogueResponseIdentity(
    contracts,
    row,
    message,
    isDialogue,
    sessionId,
    commandId,
  );
  if (
    row.command_status !== "received" &&
    row.command_status !== "completed"
  ) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Dialogue command row has an unsupported status",
      {
        session_id: sessionId,
        command_id: commandId,
        command_status: row.command_status,
      },
    );
  }
  const result =
    row.result_document === null
      ? undefined
      : contracts.assertObject(
          CONTRACT_REF.commandResult,
          row.result_document,
        ).value;
  if (
    (row.command_status === "received" && result !== undefined) ||
    (row.command_status === "completed" && result === undefined)
  ) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Dialogue command status and result document disagree",
      { session_id: sessionId, command_id: commandId },
    );
  }
  if (
    result !== undefined &&
    expectString(result, "command_id", "CommandResult") !== commandId
  ) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Stored CommandResult belongs to a different command",
      { session_id: sessionId, command_id: commandId },
    );
  }
  if (
    row.command_kind === "event_card.trigger" &&
    result !== undefined
  ) {
    const resultStatus = expectString(
      result,
      "status",
      "CommandResult",
    );
    if (
      (resultStatus === "accepted" &&
        eventCard.branch === undefined) ||
      (resultStatus === "rejected" &&
        eventCard.branch !== undefined)
    ) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "Completed EventCard result disagrees with its committed packet",
        {
          session_id: sessionId,
          command_id: commandId,
          result_status: resultStatus,
          committed_branch: eventCard.branch ?? null,
        },
      );
    }
  }
  return Object.freeze({
    sessionId,
    commandId,
    commandKind: row.command_kind,
    requestMessageId: expectString(
      envelope.value,
      "message_id",
      "ClientEnvelope",
    ),
    acceptedSession,
    dialogueId:
      row.dialogue_id === null
        ? undefined
        : assertUuid(contracts, row.dialogue_id),
    humanTurnId:
      row.human_turn_id === null
        ? undefined
        : assertUuid(contracts, row.human_turn_id),
    characterTurnId:
      row.character_turn_id === null
        ? undefined
        : assertUuid(contracts, row.character_turn_id),
    dialogueResponseKind: dialogueResponse.kind,
    responseTurnId: dialogueResponse.turnId,
    responseModelRequestId: dialogueResponse.modelRequestId,
    dialogueEventsModelRequestId:
      dialogueResponse.dialogueEventsModelRequestId,
    playerDayFromDay:
      row.player_day_from_day_text === null
        ? undefined
        : parseSafeUnsignedInteger(
            row.player_day_from_day_text,
            "command.finalizer.database_corrupt",
            "Player-day source day",
            { session_id: sessionId, command_id: commandId },
          ),
    eventCardId: eventCard.eventCardId,
    eventCardPacketId: eventCard.packetId,
    eventCardBranch: eventCard.branch,
    navigationRuleRequestId:
      row.navigation_rule_request_id === null
        ? undefined
        : assertUuid(
            contracts,
            row.navigation_rule_request_id,
          ),
    navigationDestination: isNavigation
      ? expectJsonObject(
          expectProperty(message, "destination", "MapMove"),
          "MapMove.destination",
        )
      : undefined,
    stageOutcomeRuleRequestId:
      row.stage_outcome_rule_request_id === null
        ? undefined
        : assertUuid(
            contracts,
            row.stage_outcome_rule_request_id,
          ),
    stageOutcomeId: isStageOutcome
      ? assertUuid(
          contracts,
          expectString(
            message,
            "stage_instance_id",
            "StageOutcomeProposal",
          ),
        )
      : undefined,
    stageOutcomeRevision: isStageOutcome
      ? expectInteger(
          message,
          "stage_revision",
          "StageOutcomeProposal",
        )
      : undefined,
    stageOutcomeType: isStageOutcome
      ? expectString(
          message,
          "outcome_type",
          "StageOutcomeProposal",
        )
      : undefined,
    stageOutcome: isStageOutcome
      ? expectJsonObject(
          expectProperty(
            message,
            "outcome",
            "StageOutcomeProposal",
          ),
          "StageOutcomeProposal.outcome",
        )
      : undefined,
    stageOutcomeEvidenceDigest: isStageOutcome
      ? expectString(
          message,
          "evidence_digest",
          "StageOutcomeProposal",
        )
      : undefined,
    dialogueCloseRuleRequestId:
      row.dialogue_close_rule_request_id === null
        ? undefined
        : assertUuid(
            contracts,
            row.dialogue_close_rule_request_id,
          ),
    dialogueCloseId: isDialogueClose
      ? assertUuid(
          contracts,
          expectString(message, "dialogue_id", "DialogueClose"),
        )
      : undefined,
    contentUpgradeCommandId:
      row.content_upgrade_command_id === null
        ? undefined
        : assertUuid(contracts, row.content_upgrade_command_id),
    contentUpgradeRuleRequestId:
      row.content_upgrade_rule_request_id === null
        ? undefined
        : assertUuid(
            contracts,
            row.content_upgrade_rule_request_id,
          ),
    contentUpgradeMigrationId: isContentUpgrade
      ? expectString(
          message,
          "migration_id",
          "ContentUpgradeAccept",
        )
      : undefined,
    contentUpgradeTargetBundle: isContentUpgrade
      ? expectJsonObject(
          expectProperty(
            message,
            "target_bundle",
            "ContentUpgradeAccept",
          ),
          "ContentUpgradeAccept.target_bundle",
        )
      : undefined,
    contentUpgradeConsentTextDigest: isContentUpgrade
      ? expectString(
          message,
          "consent_text_digest",
          "ContentUpgradeAccept",
        )
      : undefined,
    status: row.command_status,
    result,
  });
}


function readEventCardCommitIdentity(
  contracts: ContractValidator,
  row: FinalizationCommandRow,
  message: JsonObject,
  commandKind: ValidatedFinalizationCommand["commandKind"],
  commandId: string,
  acceptedSession: EngineSessionRecord,
): {
  readonly eventCardId: string | undefined;
  readonly packetId: string | undefined;
  readonly branch: EventCardCompletionBranch | undefined;
} {
  if (commandKind !== "event_card.trigger") {
    if (row.event_card_committed_event_document !== null) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "Non-EventCard command unexpectedly joined an EventCard committed packet",
        {
          session_id: acceptedSession.sessionId,
          command_id: commandId,
          command_kind: commandKind,
        },
      );
    }
    return Object.freeze({
      eventCardId: undefined,
      packetId: undefined,
      branch: undefined,
    });
  }

  const eventCardId = assertUuid(
    contracts,
    expectString(message, "event_card_id", "EventCardTrigger"),
  );
  const packetId = assertUuid(
    contracts,
    requireTextColumn(
      row.event_card_packet_id,
      "event_card_packet_id",
      acceptedSession.sessionId,
      commandId,
    ),
  );
  if (row.event_card_committed_event_document === null) {
    return Object.freeze({
      eventCardId,
      packetId,
      branch: undefined,
    });
  }

  const event = contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_card_committed_event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const expectedRevisionAfter =
    acceptedSession.worldRevision + 1;
  if (
    !Number.isSafeInteger(expectedRevisionAfter) ||
    expectString(event, "world_id", "CommittedEvent") !==
      acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      acceptedSession.worldRevision ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      expectedRevisionAfter ||
    expectString(packet, "packet_id", "ContentPacket") !== packetId ||
    expectString(packet, "world_id", "ContentPacket") !==
      acceptedSession.worldId ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      acceptedSession.worldRevision ||
    expectString(packet, "cause_id", "ContentPacket") !== eventCardId ||
    expectString(source, "source_kind", "PacketSource") !==
      "sealed_event_result" ||
    expectString(source, "event_card_id", "PacketSource") !== eventCardId
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "EventCard committed packet identity differs from its accepted command",
      {
        session_id: acceptedSession.sessionId,
        command_id: commandId,
        packet_id: packetId,
        event_card_id: eventCardId,
      },
    );
  }

  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const terminal = ops.at(-1);
  if (terminal === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "EventCard committed packet has no terminal operation",
      {
        session_id: acceptedSession.sessionId,
        command_id: commandId,
      },
    );
  }
  const terminalKind = expectString(
    terminal,
    "op",
    "EffectOp",
  );
  const branch: EventCardCompletionBranch =
    terminalKind === "event_card.trigger"
      ? "trigger"
      : terminalKind === "event_card.invalidate" && ops.length === 1
        ? "invalidate"
        : invalidEventCardCommittedBranch(
            acceptedSession.sessionId,
            commandId,
            terminalKind,
            ops.length,
          );
  const operationScope =
    branch === "trigger"
      ? "EventCardTriggerOp"
      : "EventCardInvalidateOp";
  const control = expectJsonObject(
    expectProperty(terminal, "control", operationScope),
    `${operationScope}.control`,
  );
  if (
    expectString(terminal, "event_card_id", operationScope) !==
      eventCardId ||
    expectString(control, "binding_id", "ControlBindingRef") !==
      acceptedSession.controlBindingId
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "EventCard terminal operation differs from its accepted Session identity",
      {
        session_id: acceptedSession.sessionId,
        command_id: commandId,
        event_card_id: eventCardId,
        branch,
      },
    );
  }
  return Object.freeze({
    eventCardId,
    packetId,
    branch,
  });
}

function stageOpenIncludesPlayer(
  op: JsonObject,
  worldId: string,
  playerEntityId: string,
): boolean {
  return participantsIncludePlayer(
    op,
    "StageOpenOp",
    worldId,
    playerEntityId,
  );
}

function participantsIncludePlayer(
  record: JsonObject,
  scope: string,
  worldId: string,
  playerEntityId: string,
): boolean {
  return asObjectArray(
    expectProperty(record, "participants", scope),
    `${scope}.participants`,
  ).some(
    (participant) =>
      expectString(participant, "world_id", "EntityRef") === worldId &&
      expectString(participant, "entity_id", "EntityRef") ===
        playerEntityId,
  );
}

async function readCommandStageOpenProjectionIds(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
}): Promise<readonly string[]> {
  const acceptedRevision = input.command.acceptedSession.worldRevision;
  if (input.finalWorldRevision < acceptedRevision) {
    throw new EngineFault(
      "command.finalizer.committed_event_range_invalid",
      "Command final world revision cannot precede its accepted revision",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        accepted_world_revision: acceptedRevision,
        final_world_revision: input.finalWorldRevision,
      },
    );
  }
  const expectedCount = input.finalWorldRevision - acceptedRevision;
  const query = await input.client.query<CommittedEventHistoryRow>(
    `SELECT revision_after::text AS revision_after_text,
            event_document
       FROM luoxia_engine.committed_events
      WHERE world_id = $1::uuid
        AND revision_after > $2::bigint
        AND revision_after <= $3::bigint
      ORDER BY revision_after`,
    [
      input.command.acceptedSession.worldId,
      acceptedRevision.toString(),
      input.finalWorldRevision.toString(),
    ],
  );
  if (query.rows.length !== expectedCount) {
    throw new EngineFault(
      "command.finalizer.committed_event_range_incomplete",
      "Command completion requires one contiguous CommittedEvent per world revision",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        accepted_world_revision: acceptedRevision,
        final_world_revision: input.finalWorldRevision,
        expected_count: expectedCount,
        actual_count: query.rows.length,
      },
    );
  }

  const openedStageIds = new Set<string>();
  let contentUpgradeProjectionIds:
    | readonly string[]
    | undefined;
  for (const [index, row] of query.rows.entries()) {
    const expectedRevisionAfter = acceptedRevision + index + 1;
    const revisionAfter = parseSafeUnsignedInteger(
      row.revision_after_text,
      "command.finalizer.database_corrupt",
      "CommittedEvent revision",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        revision_after: row.revision_after_text,
      },
    );
    const event = input.contracts.assertObject(
      CONTRACT_REF.committedEvent,
      row.event_document,
    ).value;
    const packet = expectJsonObject(
      expectProperty(event, "packet", "CommittedEvent"),
      "CommittedEvent.packet",
    );
    if (
      revisionAfter !== expectedRevisionAfter ||
      expectString(event, "world_id", "CommittedEvent") !==
        input.command.acceptedSession.worldId ||
      expectInteger(event, "revision_before", "CommittedEvent") !==
        expectedRevisionAfter - 1 ||
      expectInteger(event, "revision_after", "CommittedEvent") !==
        expectedRevisionAfter ||
      expectString(packet, "world_id", "ContentPacket") !==
        input.command.acceptedSession.worldId ||
      expectInteger(packet, "basis_revision", "ContentPacket") !==
        expectedRevisionAfter - 1
    ) {
      throw new EngineFault(
        "command.finalizer.committed_event_range_mismatch",
        "CommittedEvent history is not contiguous with the accepted command boundary",
        {
          session_id: input.command.sessionId,
          command_id: input.command.commandId,
          expected_revision_after: expectedRevisionAfter,
          actual_revision_after: revisionAfter,
        },
      );
    }
    const ops = asObjectArray(
      expectProperty(packet, "ops", "ContentPacket"),
      "ContentPacket.ops",
    );
    if (input.command.commandKind === "content_upgrade.accept") {
      if (
        expectedCount !== 1 ||
        contentUpgradeProjectionIds !== undefined
      ) {
        throw new EngineFault(
          "command.finalizer.content_upgrade_event_range_invalid",
          "Content Upgrade completion must own exactly one committed event",
          {
            session_id: input.command.sessionId,
            command_id: input.command.commandId,
            expected_event_count: 1,
            actual_event_count: expectedCount,
          },
        );
      }
      contentUpgradeProjectionIds =
        readContentUpgradeStageOpenProjectionIds({
          contracts: input.contracts,
          command: input.command,
          packet,
          ops,
          eventRevision: expectedRevisionAfter,
        });
      continue;
    }
    for (const op of ops) {
      const opKind = expectString(op, "op", "EffectOp");
      if (
        opKind === "stage.open" &&
        stageOpenIncludesPlayer(
          op,
          input.command.acceptedSession.worldId,
          input.command.acceptedSession.playerEntityId,
        )
      ) {
        openedStageIds.add(
          expectString(op, "stage_instance_id", "StageOpenOp"),
        );
        continue;
      }
      if (opKind === "stage.close") {
        openedStageIds.delete(
          expectString(op, "stage_instance_id", "StageCloseOp"),
        );
      }
    }
  }
  if (input.command.commandKind === "content_upgrade.accept") {
    if (contentUpgradeProjectionIds === undefined) {
      throw new EngineFault(
        "command.finalizer.content_upgrade_event_missing",
        "Content Upgrade completion has no authoritative candidate SaveEnvelope event",
        {
          session_id: input.command.sessionId,
          command_id: input.command.commandId,
        },
      );
    }
    return contentUpgradeProjectionIds;
  }
  return sortedStageInstanceIds(openedStageIds);
}

function readContentUpgradeStageOpenProjectionIds(input: {
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly packet: JsonObject;
  readonly ops: readonly JsonObject[];
  readonly eventRevision: number;
}): readonly string[] {
  const upgradeCommandId = input.command.contentUpgradeCommandId;
  const migrationId = input.command.contentUpgradeMigrationId;
  const op = input.ops.length === 1 ? input.ops[0] : undefined;
  if (
    upgradeCommandId === undefined ||
    migrationId === undefined ||
    op === undefined ||
    expectString(op, "op", "ContentUpgradeApplyOp") !==
      "content_upgrade.apply"
  ) {
    throw new EngineFault(
      "command.finalizer.content_upgrade_projection_identity_invalid",
      "Content Upgrade StageOpen projection requires one exact content_upgrade.apply operation",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        upgrade_command_id: upgradeCommandId ?? null,
        migration_id: migrationId ?? null,
        operation_count: input.ops.length,
      },
    );
  }
  const source = expectJsonObject(
    expectProperty(input.packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const candidateSaveDocument = input.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    expectProperty(op, "candidate_save", "ContentUpgradeApplyOp"),
  );
  assertSaveEnvelopeRelationships(
    input.contracts,
    candidateSaveDocument,
  );
  const candidateSave = candidateSaveDocument.value;
  const candidateWorldState = expectJsonObject(
    expectProperty(candidateSave, "world_state", "SaveEnvelope"),
    "SaveEnvelope.world_state",
  );
  if (
    expectString(input.packet, "packet_id", "ContentPacket") !==
      upgradeCommandId ||
    expectString(input.packet, "cause_id", "ContentPacket") !==
      migrationId ||
    expectString(source, "source_kind", "PacketSource") !==
      "content_upgrade" ||
    expectString(
      source,
      "upgrade_command_id",
      "PacketSource",
    ) !== upgradeCommandId ||
    expectString(source, "migration_id", "PacketSource") !==
      migrationId ||
    expectString(candidateSave, "world_id", "SaveEnvelope") !==
      input.command.acceptedSession.worldId ||
    expectInteger(
      candidateSave,
      "world_revision",
      "SaveEnvelope",
    ) !== input.eventRevision
  ) {
    throw new EngineFault(
      "command.finalizer.content_upgrade_projection_identity_mismatch",
      "Content Upgrade candidate SaveEnvelope differs from its committed event identity",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        upgrade_command_id: upgradeCommandId,
        migration_id: migrationId,
        event_revision: input.eventRevision,
      },
    );
  }

  const openPlayerStageIds = new Set<string>();
  for (const stage of asObjectArray(
    expectProperty(
      candidateWorldState,
      "stage_instances",
      "WorldState",
    ),
    "WorldState.stage_instances",
  )) {
    if (
      expectString(stage, "status", "StageInstanceState") ===
        "open" &&
      participantsIncludePlayer(
        stage,
        "StageInstanceState",
        input.command.acceptedSession.worldId,
        input.command.acceptedSession.playerEntityId,
      )
    ) {
      openPlayerStageIds.add(
        expectString(
          stage,
          "stage_instance_id",
          "StageInstanceState",
        ),
      );
    }
  }
  return sortedStageInstanceIds(openPlayerStageIds);
}

function sortedStageInstanceIds(
  stageInstanceIds: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(
    [...stageInstanceIds].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function requireTextColumn(
  value: string | null,
  column: string,
  sessionId: string,
  commandId: string,
): string {
  if (value === null) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      `EventCard command is missing ${column}`,
      { session_id: sessionId, command_id: commandId, column },
    );
  }
  return value;
}

function invalidEventCardCommittedBranch(
  sessionId: string,
  commandId: string,
  terminalKind: string,
  opCount: number,
): never {
  throw new EngineFault(
    "command.finalizer.database_corrupt",
    "EventCard committed packet has an unsupported terminal branch",
    {
      session_id: sessionId,
      command_id: commandId,
      terminal_op: terminalKind,
      op_count: opCount,
    },
  );
}

async function readCompletedFinalWorldRevision(
  client: PoolClient,
  contracts: ContractValidator,
  command: ValidatedFinalizationCommand,
): Promise<number> {
  const acceptedRevision = command.acceptedSession.worldRevision;
  if (
    command.commandKind === "dialogue.start" ||
    command.commandKind === "dialogue.continue"
  ) {
    const proposalRows = await readDialogueProposalHistoryRows({
      client,
      contracts,
      command,
    });
    return checkedFinalWorldRevision(
      command,
      acceptedRevision +
        DIALOGUE_PACKET_COUNT +
        proposalRows.filter(
          (row) => row.packet_proposal_id !== null,
        ).length,
    );
  }
  if (command.commandKind === "player_day.end") {
    return readCompletedPlayerDayFinalWorldRevision({
      client,
      contracts,
      command,
    });
  }
  return checkedFinalWorldRevision(command, acceptedRevision + 1);
}

function checkedFinalWorldRevision(
  command: ValidatedFinalizationCommand,
  revision: number,
): number {
  if (
    !Number.isSafeInteger(revision) ||
    revision < command.acceptedSession.worldRevision
  ) {
    throw new EngineFault(
      "command.finalizer.completed_world_revision_invalid",
      "Completed command world revision cannot be reconstructed safely",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        accepted_world_revision:
          command.acceptedSession.worldRevision,
        reconstructed_world_revision: revision,
      },
    );
  }
  return revision;
}

async function readCompletedPlayerDayFinalWorldRevision(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
}): Promise<number> {
  const fromDay = input.command.playerDayFromDay;
  if (
    fromDay === undefined ||
    fromDay >= Number.MAX_SAFE_INTEGER
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Completed player-day command is missing a valid source day",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        from_day: fromDay ?? null,
      },
    );
  }
  const settledDay = fromDay + 1;
  const identityQuery =
    await input.client.query<DayCycleExecutionIdentityRow>(
      `SELECT execution_id::text AS execution_id
         FROM luoxia_engine.day_cycle_execution_identities
        WHERE world_id = $1::uuid
          AND day = $2::bigint
          AND execution_kind = 'transition.director_to_player'
          AND subject_id IS NULL`,
      [
        input.command.acceptedSession.worldId,
        settledDay.toString(),
      ],
    );
  const identity = requireAtMostOne(
    identityQuery.rows,
    "command.finalizer.database_corrupt",
    "Player-day terminal transition identity is not unique",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      world_id: input.command.acceptedSession.worldId,
      day: settledDay,
    },
  );
  if (identity === undefined) {
    throw new EngineFault(
      "command.finalizer.player_day_history_incomplete",
      "Completed player-day command has no terminal transition identity",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        world_id: input.command.acceptedSession.worldId,
        day: settledDay,
      },
    );
  }
  const rootRequestId = assertUuid(
    input.contracts,
    identity.execution_id,
  );
  const terminal = await readTerminalRulePluginInvocation({
    client: input.client,
    rootRequestId,
    multipleRowsMessage:
      "Player-day terminal transition returned more than one terminal RulePlugin invocation",
    details: {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      root_request_id: rootRequestId,
    },
  });
  if (
    terminal === undefined ||
    terminal.operation_kind !== "day_cycle.advance" ||
    terminal.invocation_status !== "resolved" ||
    terminal.proposal_id === null ||
    terminal.revision_after_text === null ||
    terminal.event_document === null
  ) {
    throw new EngineFault(
      "command.finalizer.player_day_history_incomplete",
      "Completed player-day command has no committed terminal transition",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: rootRequestId,
      },
    );
  }

  const request = input.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    terminal.request_document,
  ).value;
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const control = expectJsonObject(
    expectProperty(
      requestInput,
      "control",
      "DayCycleAdvanceInput",
    ),
    "DayCycleAdvanceInput.control",
  );
  const readonlyWorld = expectJsonObject(
    expectProperty(
      request,
      "readonly_world",
      "RulePluginRequest",
    ),
    "RulePluginRequest.readonly_world",
  );
  const event = input.contracts.assertObject(
    CONTRACT_REF.committedEvent,
    terminal.event_document,
  ).value;
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const transitions = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  ).filter(
    (op) =>
      expectString(op, "op", "EffectOp") ===
      "day_cycle.transition",
  );
  const transition =
    transitions.length === 1 ? transitions[0] : undefined;
  const revisionAfter = parseSafeUnsignedInteger(
    terminal.revision_after_text,
    "command.finalizer.database_corrupt",
    "Player-day terminal committed event revision",
    {
      session_id: input.command.sessionId,
      command_id: input.command.commandId,
      revision_after: terminal.revision_after_text,
    },
  );
  const revisionBefore = revisionAfter - 1;
  if (
    revisionAfter <= input.command.acceptedSession.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      terminal.terminal_request_id ||
    expectString(
      request,
      "operation_kind",
      "RulePluginRequest",
    ) !== "day_cycle.advance" ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      revisionBefore ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.acceptedSession.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== revisionBefore ||
    expectInteger(
      requestInput,
      "from_day",
      "DayCycleAdvanceInput",
    ) !== settledDay ||
    expectString(
      requestInput,
      "from_phase",
      "DayCycleAdvanceInput",
    ) !== "director_settlement" ||
    expectInteger(
      requestInput,
      "to_day",
      "DayCycleAdvanceInput",
    ) !== settledDay ||
    expectString(
      requestInput,
      "to_phase",
      "DayCycleAdvanceInput",
    ) !== "player" ||
    expectString(control, "binding_id", "ControlBindingRef") !==
      input.command.acceptedSession.controlBindingId ||
    expectString(event, "world_id", "CommittedEvent") !==
      input.command.acceptedSession.worldId ||
    expectInteger(event, "revision_before", "CommittedEvent") !==
      revisionBefore ||
    expectInteger(event, "revision_after", "CommittedEvent") !==
      revisionAfter ||
    expectString(packet, "packet_id", "ContentPacket") !==
      terminal.proposal_id ||
    expectString(packet, "world_id", "ContentPacket") !==
      input.command.acceptedSession.worldId ||
    expectInteger(packet, "basis_revision", "ContentPacket") !==
      revisionBefore ||
    expectString(source, "source_kind", "PacketSource") !==
      "rule_plugin" ||
    expectString(source, "proposal_id", "PacketSource") !==
      terminal.proposal_id ||
    transition === undefined ||
    expectInteger(
      transition,
      "from_day",
      "DayCycleTransitionOp",
    ) !== settledDay ||
    expectString(
      transition,
      "from_phase",
      "DayCycleTransitionOp",
    ) !== "director_settlement" ||
    expectInteger(
      transition,
      "to_day",
      "DayCycleTransitionOp",
    ) !== settledDay ||
    expectString(
      transition,
      "to_phase",
      "DayCycleTransitionOp",
    ) !== "player"
  ) {
    throw new EngineFault(
      "command.finalizer.player_day_history_mismatch",
      "Player-day terminal transition differs from its persisted command boundary",
      {
        session_id: input.command.sessionId,
        command_id: input.command.commandId,
        root_request_id: rootRequestId,
        terminal_request_id: terminal.terminal_request_id,
        revision_after: revisionAfter,
      },
    );
  }
  return checkedFinalWorldRevision(input.command, revisionAfter);
}

async function readCompletedEnvelopes(
  client: PoolClient,
  contracts: ContractValidator,
  command: ValidatedFinalizationCommand,
  expectedStatus?: "accepted" | "rejected",
): Promise<readonly ServerEnvelopeDocument[]> {
  if (command.status !== "completed" || command.result === undefined) {
    throw new EngineFault(
      "dialogue.finalizer.command_not_completed",
      "ServerEnvelope replay requires a completed dialogue command",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  const actualStatus = expectString(
    command.result,
    "status",
    "CommandResult",
  );
  if (
    actualStatus !== "accepted" &&
    actualStatus !== "rejected"
  ) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Completed dialogue command has an unsupported result status",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        status: actualStatus,
      },
    );
  }
  if (expectedStatus !== undefined && actualStatus !== expectedStatus) {
    throw new EngineFault(
      "dialogue.finalizer.completion_conflict",
      "Dialogue command was already finalized with a different outcome",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        expected_status: expectedStatus,
        actual_status: actualStatus,
      },
    );
  }
  const stageOpenProjectionIds =
    actualStatus === "accepted"
      ? await readCommandStageOpenProjectionIds({
          client,
          contracts,
          command,
          finalWorldRevision:
            await readCompletedFinalWorldRevision(
              client,
              contracts,
              command,
            ),
        })
      : Object.freeze([]);
  const query = await client.query<ServerEnvelopeRow>(
    `SELECT response_ordinal::text AS response_ordinal_text,
            server_sequence::text AS server_sequence_text,
            message_id::text AS message_id,
            message_type,
            envelope_document
       FROM luoxia_engine.command_server_envelopes
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      ORDER BY response_ordinal`,
    [command.sessionId, command.commandId],
  );
  const expectedTypes = expectedCompletedMessageTypes(
    command,
    actualStatus,
    stageOpenProjectionIds,
  );
  if (query.rows.length !== expectedTypes.length) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "Completed dialogue command has an incomplete ServerEnvelope outbox",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        expected_count: expectedTypes.length,
        actual_count: query.rows.length,
      },
    );
  }
  let previousSequence: number | undefined;
  const envelopes = query.rows.map((row, index) => {
    const ordinal = parseSafeUnsignedInteger(
      row.response_ordinal_text,
      "dialogue.finalizer.database_corrupt",
      "ServerEnvelope response ordinal",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        response_ordinal: row.response_ordinal_text,
      },
    );
    const sequence = parseSafeUnsignedInteger(
      row.server_sequence_text,
      "dialogue.finalizer.database_corrupt",
      "ServerEnvelope sequence",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        sequence: row.server_sequence_text,
      },
    );
    const envelope = contracts.assertObject(
      CONTRACT_REF.serverEnvelope,
      row.envelope_document,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ServerEnvelope"),
      "ServerEnvelope.message",
    );
    const messageType = expectString(
      message,
      "type",
      "ServerMessage",
    );
    if (
      ordinal !== index ||
      (previousSequence !== undefined &&
        sequence !== previousSequence + 1) ||
      expectInteger(envelope.value, "sequence", "ServerEnvelope") !==
        sequence ||
      expectString(envelope.value, "message_id", "ServerEnvelope") !==
        assertUuid(contracts, row.message_id) ||
      expectString(envelope.value, "session_id", "ServerEnvelope") !==
        command.sessionId ||
      expectString(
        envelope.value,
        "correlation_id",
        "ServerEnvelope",
      ) !== command.requestMessageId ||
      row.message_type !== messageType ||
      !matchesExpectedCompletedMessageType(
        messageType,
        expectedTypes[index] as string,
      )
    ) {
      throw new EngineFault(
        "dialogue.finalizer.database_corrupt",
        "Persisted ServerEnvelope identity or ordering is inconsistent",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          response_ordinal: index,
        },
      );
    }
    previousSequence = sequence;
    return envelope;
  });
  const persistedStageOpenProjectionIds = envelopes.flatMap(
    (envelope) => {
      const message = expectJsonObject(
        expectProperty(
          envelope.value,
          "message",
          "ServerEnvelope",
        ),
        "ServerEnvelope.message",
      );
      return expectString(message, "type", "ServerMessage") ===
        "stage.open"
        ? [
            expectString(
              message,
              "stage_instance_id",
              "StageOpen",
            ),
          ]
        : [];
    },
  );
  if (
    persistedStageOpenProjectionIds.length !==
      stageOpenProjectionIds.length ||
    persistedStageOpenProjectionIds.some(
      (stageInstanceId, index) =>
        stageInstanceId !== stageOpenProjectionIds[index],
    )
  ) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Persisted StageOpen outbox differs from committed command history",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        expected_stage_instance_ids:
          stageOpenProjectionIds,
        actual_stage_instance_ids:
          persistedStageOpenProjectionIds,
      },
    );
  }
  const resultMessage = expectJsonObject(
    expectProperty(
      (envelopes[envelopes.length - 1] as ServerEnvelopeDocument).value,
      "message",
      "ServerEnvelope",
    ),
    "ServerEnvelope.message",
  );
  if (!jsonEquals(resultMessage, command.result)) {
    throw new EngineFault(
      "dialogue.finalizer.database_corrupt",
      "ServerEnvelope CommandResult differs from Command Journal result",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  return Object.freeze(envelopes);
}

function expectedCompletedMessageTypes(
  command: ValidatedFinalizationCommand,
  status: "accepted" | "rejected",
  stageOpenProjectionIds: readonly string[],
): readonly string[] {
  if (status === "rejected") {
    return ["session.view", "command.result"];
  }
  const stageOpenTypes = stageOpenProjectionIds.map(
    () => "stage.open",
  );
  if (
    command.commandKind === "dialogue.start" ||
    command.commandKind === "dialogue.continue"
  ) {
    return [
      "dialogue.reply",
      "session.view",
      ...stageOpenTypes,
      "command.result",
    ];
  }
  if (command.commandKind === "player_day.end") {
    return ["session.view", ...stageOpenTypes, "command.result"];
  }
  if (command.commandKind === "map.move") {
    return ["session.view", ...stageOpenTypes, "command.result"];
  }
  if (command.commandKind === "dialogue.close") {
    return ["session.view", ...stageOpenTypes, "command.result"];
  }
  if (command.commandKind === "content_upgrade.accept") {
    return ["session.view", ...stageOpenTypes, "command.result"];
  }
  if (command.commandKind === "stage.outcome_proposal") {
    if (command.stageOutcomeId === undefined) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "Accepted Stage outcome command is missing its Stage identity",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
        },
      );
    }
    return [
      "session.view",
      ...stageOpenTypes,
      "stage.outcome",
      "command.result",
    ];
  }
  if (command.eventCardBranch === "trigger") {
    return [
      "session.view",
      ...stageOpenTypes,
      "presentation.frame",
      "command.result",
    ];
  }
  if (command.eventCardBranch === "invalidate") {
    return ["session.view", ...stageOpenTypes, "command.result"];
  }
  throw new EngineFault(
    "command.finalizer.database_corrupt",
    "Accepted EventCard command is missing its committed branch",
    {
      session_id: command.sessionId,
      command_id: command.commandId,
    },
  );
}

function matchesExpectedCompletedMessageType(
  actual: string,
  expected: string,
): boolean {
  return expected === "stage.outcome"
    ? actual === "stage.update" || actual === "stage.close"
    : actual === expected;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "dialogue.finalizer.projection_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry as JsonValue));
  }
  const clone: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneJson(entry);
  }
  return clone;
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeFinalizerError(
  error: unknown,
  sessionId: string,
  commandId: string,
): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const constraint =
    typeof error.constraint === "string" ? error.constraint : "";
  if (
    constraint ===
      "command_server_envelopes_session_sequence_unique" ||
    constraint === "command_server_envelopes_message_id_unique" ||
    constraint === "command_server_envelopes_pkey"
  ) {
    return new EngineFault(
      "dialogue.finalizer.envelope_identity_conflict",
      "PostgreSQL rejected a duplicate ServerEnvelope identity",
      { session_id: sessionId, command_id: commandId, constraint },
    );
  }
  return new EngineFault(
    "dialogue.finalizer.database_error",
    "PostgreSQL rejected dialogue command finalization",
    {
      session_id: sessionId,
      command_id: commandId,
      postgres_code: error.code,
      constraint,
      postgres_message:
        typeof error.message === "string" ? error.message : "",
    },
  );
}

function isPostgresError(
  error: unknown,
): error is PostgresErrorLike & { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as PostgresErrorLike).code === "string"
  );
}
