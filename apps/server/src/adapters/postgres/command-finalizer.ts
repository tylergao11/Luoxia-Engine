import {
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
import type {
  SessionViewDocument,
  SessionViewProjector,
} from "@luoxia/world-core/composition";
import type { Pool, PoolClient } from "pg";

import type {
  CommandFinalizer,
  EventCardCompletionBranch,
  ServerEnvelopeDocument,
  ServerEnvelopeIdFactory,
} from "../../application/command-finalizer.js";
import type {
  EngineSessionBasisTokenAuthority,
  EngineSessionRecord,
} from "../../application/engine-session.js";
import {
  readEngineSessionContext,
  type LockedEngineSessionContext,
} from "./engine-session-repository.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

const DIALOGUE_PACKET_COUNT = 2;

export interface PostgresCommandFinalizerDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly basisTokens: EngineSessionBasisTokenAuthority;
  readonly projector: SessionViewProjector;
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
  readonly director_request_kind: string | null;
  readonly director_model_request_id: string | null;
  readonly director_response_turn_id: string | null;
  readonly player_day_from_day_text: string | null;
  readonly event_card_packet_id: string | null;
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
    | "player_day.end"
    | "event_card.trigger";
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
  readonly playerDayFromDay: number | undefined;
  readonly eventCardId: string | undefined;
  readonly eventCardPacketId: string | undefined;
  readonly eventCardBranch: EventCardCompletionBranch | undefined;
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

interface DialogueProposalHistoryRow {
  readonly proposal_kind: string;
  readonly model_proposal_id: string;
  readonly proposal_ordinal: number;
  readonly world_record_id: string | null;
  readonly rule_request_id: string;
  readonly operation_kind: string | null;
  readonly invocation_status: string | null;
  readonly packet_proposal_id: string | null;
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
  readonly #basisTokens: EngineSessionBasisTokenAuthority;
  readonly #projector: SessionViewProjector;
  readonly #idFactory: ServerEnvelopeIdFactory;

  public constructor(
    dependencies: PostgresCommandFinalizerDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#basisTokens = dependencies.basisTokens;
    this.#projector = dependencies.projector;
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
          const view = projectSessionView({
            contracts: this.#contracts,
            basisTokens: this.#basisTokens,
            projector: this.#projector,
            session: nextSession,
            worldState: sessionContext.worldState,
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
            command,
            eventCard: input.eventCard,
            view,
            worldState: sessionContext.worldState,
            result: result.value,
          });
          const envelopes = createServerEnvelopes({
            contracts: this.#contracts,
            idFactory: this.#idFactory,
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

          const view = projectSessionView({
            contracts: this.#contracts,
            basisTokens: this.#basisTokens,
            projector: this.#projector,
            session: command.acceptedSession,
            worldState: sessionContext.worldState,
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
          const envelopes = createServerEnvelopes({
            contracts: this.#contracts,
            idFactory: this.#idFactory,
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

function projectSessionView(input: {
  readonly contracts: ContractValidator;
  readonly basisTokens: EngineSessionBasisTokenAuthority;
  readonly projector: SessionViewProjector;
  readonly session: EngineSessionRecord;
  readonly worldState: JsonObject;
}): SessionViewDocument {
  const snapshot = input.contracts.assertObject(
    CONTRACT_REF.worldSnapshot,
    {
      world_id: input.session.worldId,
      world_revision: input.session.worldRevision,
      world_state: input.worldState,
    },
  );
  return input.projector.project({
    snapshot,
    sessionId: input.session.sessionId,
    viewRevision: input.session.viewRevision,
    basisToken: input.basisTokens.issue(input.session),
    controlBindingId: input.session.controlBindingId,
    renderNodeCandidates: [],
    noticeCandidates: [],
  });
}

function createAcceptedMessages(input: {
  readonly contracts: ContractValidator;
  readonly idFactory: ServerEnvelopeIdFactory;
  readonly command: ValidatedFinalizationCommand;
  readonly eventCard:
    | {
        readonly eventCardId: string;
        readonly branch: EventCardCompletionBranch;
      }
    | undefined;
  readonly view: SessionViewDocument;
  readonly worldState: JsonObject;
  readonly result: JsonObject;
}): readonly JsonObject[] {
  const viewMessage = Object.freeze({
    type: "session.view",
    view: input.view.value,
  });
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
      input.result,
    ]);
  }
  if (input.command.commandKind === "player_day.end") {
    return Object.freeze([viewMessage, input.result]);
  }

  const completion = requireEventCardCompletion(input.eventCard);
  if (completion.branch === "invalidate") {
    return Object.freeze([viewMessage, input.result]);
  }
  const presentation = createEventCardPresentationFrame({
    contracts: input.contracts,
    idFactory: input.idFactory,
    view: input.view,
    worldState: input.worldState,
    eventCardId: completion.eventCardId,
  });
  return Object.freeze([viewMessage, presentation, input.result]);
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

function createServerEnvelopes(input: {
  readonly contracts: ContractValidator;
  readonly idFactory: ServerEnvelopeIdFactory;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly firstSequence: number;
  readonly messages: readonly JsonObject[];
}): readonly ServerEnvelopeDocument[] {
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
      "dialogue.finalizer.server_sequence_exhausted",
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
      const messageId = createCanonicalServerOwnedId(
        input.contracts,
        input.idFactory,
        "message_id",
      );
      return input.contracts.assertObject(
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
): void {
  if (command.commandKind === "player_day.end") {
    if (
      responseTurnId !== undefined ||
      eventCard !== undefined ||
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
  const minimumFinalRevision =
    command.acceptedSession.worldRevision + DIALOGUE_PACKET_COUNT;
  if (
    eventCard !== undefined ||
    !Number.isSafeInteger(minimumFinalRevision) ||
    finalWorldRevision < minimumFinalRevision ||
    responseTurnId === undefined ||
    responseTurnId !== requireDialogueResponseTurnId(command)
  ) {
    throw new EngineFault(
      "dialogue.finalizer.completion_identity_mismatch",
      "Accepted dialogue completion must include its two dialogue packets and only its recoverable post-dialogue publications",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        accepted_world_revision:
          command.acceptedSession.worldRevision,
        minimum_final_world_revision: minimumFinalRevision,
        actual_final_world_revision: finalWorldRevision,
        expected_response_turn_id: command.responseTurnId ?? null,
        actual_response_turn_id: responseTurnId ?? null,
      },
    );
  }
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

async function assertDialogueCompletionHistory(input: {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly command: ValidatedFinalizationCommand;
  readonly finalWorldRevision: number;
  readonly responseTurnId: string;
}): Promise<void> {
  const acceptedRevision =
    input.command.acceptedSession.worldRevision;
  const proposalQuery =
    await input.client.query<DialogueProposalHistoryRow>(
      `SELECT proposal.proposal_kind,
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
        ORDER BY CASE proposal.proposal_kind
                   WHEN 'definition' THEN 0
                   WHEN 'goal_plan' THEN 1
                   WHEN 'event_card' THEN 2
                   ELSE 3
                 END,
                 proposal.proposal_ordinal`,
      [input.command.sessionId, input.command.commandId],
    );
  const proposalRows = validateDialogueProposalHistoryRows(
    input.contracts,
    input.command,
    proposalQuery.rows,
  );
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

function validateDialogueProposalHistoryRows(
  contracts: ContractValidator,
  command: ValidatedFinalizationCommand,
  rows: readonly DialogueProposalHistoryRow[],
): readonly DialogueProposalHistoryRow[] {
  const nextOrdinal: Record<string, number> = {
    definition: 0,
    goal_plan: 0,
    event_card: 0,
  };
  const expectedOperation: Readonly<Record<string, string>> =
    Object.freeze({
      definition: "definition.validate",
      goal_plan: "goal_plan.validate",
      event_card: "event_card.publish",
    });
  for (const row of rows) {
    const operationKind = expectedOperation[row.proposal_kind];
    const ordinal = nextOrdinal[row.proposal_kind];
    const modelProposalId = assertUuid(
      contracts,
      row.model_proposal_id,
    );
    const ruleRequestId = assertUuid(contracts, row.rule_request_id);
    if (
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
          proposal_kind: row.proposal_kind,
          proposal_id: modelProposalId,
          proposal_ordinal: row.proposal_ordinal,
          rule_request_id: ruleRequestId,
          invocation_status: row.invocation_status ?? "",
          operation_kind: row.operation_kind ?? "",
        },
      );
    }
    nextOrdinal[row.proposal_kind] = ordinal + 1;
    if (
      (row.proposal_kind === "event_card" &&
        row.world_record_id !== null) ||
      (row.proposal_kind !== "event_card" &&
        row.world_record_id === null)
    ) {
      throw new EngineFault(
        "command.finalizer.dialogue_proposal_history_corrupt",
        "Dialogue proposal Journal WorldState identity shape disagrees with its proposal kind",
        {
          session_id: command.sessionId,
          command_id: command.commandId,
          proposal_kind: row.proposal_kind,
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
  }
  return rows;
}

function dialogueProposalHistoryFault(
  command: ValidatedFinalizationCommand,
  proposal: DialogueProposalHistoryRow,
): EngineFault {
  return new EngineFault(
    "command.finalizer.dialogue_proposal_history_mismatch",
    "Committed post-dialogue operation differs from its persisted Director proposal identity",
    {
      session_id: command.sessionId,
      command_id: command.commandId,
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
  proposal: DialogueProposalHistoryRow,
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
            director.request_kind AS director_request_kind,
            director.model_request_id::text
              AS director_model_request_id,
            director.response_turn_id::text
              AS director_response_turn_id,
            player_day.from_day::text AS player_day_from_day_text,
            command.event_card_packet_id::text
              AS event_card_packet_id,
            event_card_commit.event_document
              AS event_card_committed_event_document,
            command.command_status,
            command.result_document
       FROM luoxia_engine.command_journal AS command
       LEFT JOIN luoxia_engine.player_day_end_runs AS player_day
         ON player_day.session_id = command.session_id
        AND player_day.command_id = command.command_id
       LEFT JOIN luoxia_engine.dialogue_director_runs AS director
         ON director.session_id = command.session_id
        AND director.command_id = command.command_id
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
    row.command_kind !== "player_day.end" &&
    row.command_kind !== "event_card.trigger"
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
    (!isEventCard && row.event_card_packet_id !== null)
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
    status: row.command_status,
    result,
  });
}

function readDialogueResponseIdentity(
  contracts: ContractValidator,
  row: FinalizationCommandRow,
  isDialogue: boolean,
  sessionId: string,
  commandId: string,
): {
  readonly kind: "character_mind" | "director_system" | undefined;
  readonly turnId: string | undefined;
  readonly modelRequestId: string | undefined;
} {
  const directorFields = [
    row.director_request_kind,
    row.director_model_request_id,
    row.director_response_turn_id,
  ];
  const hasDirectorRun = directorFields.some((value) => value !== null);
  if (!isDialogue) {
    if (hasDirectorRun) {
      throw new EngineFault(
        "command.finalizer.database_corrupt",
        "Non-dialogue command unexpectedly owns a Dialogue Director run",
        { session_id: sessionId, command_id: commandId },
      );
    }
    return Object.freeze({
      kind: undefined,
      turnId: undefined,
      modelRequestId: undefined,
    });
  }
  if (!hasDirectorRun) {
    return Object.freeze({
      kind: undefined,
      turnId: undefined,
      modelRequestId: undefined,
    });
  }
  if (
    row.director_request_kind === "director.dialogue_events" &&
    row.director_model_request_id !== null &&
    row.director_response_turn_id === null &&
    row.character_model_request_id !== null &&
    row.character_turn_id !== null
  ) {
    return Object.freeze({
      kind: "character_mind",
      turnId: assertUuid(contracts, row.character_turn_id),
      modelRequestId: assertUuid(
        contracts,
        row.character_model_request_id,
      ),
    });
  }
  if (
    row.director_request_kind === "director.system_dialogue" &&
    row.director_model_request_id !== null &&
    row.director_response_turn_id !== null
  ) {
    return Object.freeze({
      kind: "director_system",
      turnId: assertUuid(contracts, row.director_response_turn_id),
      modelRequestId: assertUuid(
        contracts,
        row.director_model_request_id,
      ),
    });
  }
  throw new EngineFault(
    "command.finalizer.database_corrupt",
    "Dialogue Director run does not define one closed response identity",
    {
      session_id: sessionId,
      command_id: commandId,
      director_request_kind: row.director_request_kind ?? "",
    },
  );
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
  return Object.freeze({ eventCardId, packetId, branch });
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
      "Completed dialogue command cannot have pending status",
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
      messageType !== expectedTypes[index]
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
): readonly string[] {
  if (status === "rejected") {
    return ["session.view", "command.result"];
  }
  if (
    command.commandKind === "dialogue.start" ||
    command.commandKind === "dialogue.continue"
  ) {
    return ["dialogue.reply", "session.view", "command.result"];
  }
  if (command.commandKind === "player_day.end") {
    return ["session.view", "command.result"];
  }
  if (command.eventCardBranch === "trigger") {
    return [
      "session.view",
      "presentation.frame",
      "command.result",
    ];
  }
  if (command.eventCardBranch === "invalidate") {
    return ["session.view", "command.result"];
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
