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
  readonly character_turn_id: string | null;
  readonly player_day_from_day_text: string | null;
  readonly command_status: string;
  readonly result_document: unknown | null;
}

interface ValidatedFinalizationCommand {
  readonly sessionId: string;
  readonly commandId: string;
  readonly commandKind:
    | "dialogue.start"
    | "dialogue.continue"
    | "player_day.end";
  readonly requestMessageId: string;
  readonly acceptedSession: EngineSessionRecord;
  readonly dialogueId: string | undefined;
  readonly characterTurnId: string | undefined;
  readonly playerDayFromDay: number | undefined;
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
    readonly characterTurnId: string;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    return this.#completeAccepted({
      sessionId: input.sessionId,
      commandId: input.commandId,
      finalWorldRevision: input.finalWorldRevision,
      characterTurnId: assertUuid(
        this.#contracts,
        input.characterTurnId,
      ),
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
      characterTurnId: undefined,
    });
  }

  async #completeAccepted(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly finalWorldRevision: number;
    readonly characterTurnId: string | undefined;
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
            input.characterTurnId,
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
            input.characterTurnId,
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
          if (command.commandKind === "player_day.end") {
            assertPlayerDayCompletion(command, sessionContext.worldState);
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
          const commonMessages = [
            Object.freeze({
              type: "session.view",
              view: view.value,
            }),
            result.value,
          ];
          const messages =
            command.commandKind === "player_day.end"
              ? commonMessages
              : [
                  extractDialogueReply(
                    view,
                    requireDialogueId(command),
                    requireCharacterTurnId(command),
                  ),
                  ...commonMessages,
                ];
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

function extractDialogueReply(
  view: SessionViewDocument,
  dialogueId: string,
  characterTurnId: string,
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
      characterTurnId,
  );
  if (turns.length !== 1) {
    throw new EngineFault(
      "dialogue.finalizer.turn_projection_mismatch",
      "Final SessionView must contain exactly one authoritative character turn",
      {
        dialogue_id: dialogueId,
        turn_id: characterTurnId,
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
      const messageId = assertUuid(
        input.contracts,
        input.idFactory.createMessageId(),
      );
      if (messageId !== messageId.toLowerCase()) {
        throw new EngineFault(
          "dialogue.finalizer.message_id_noncanonical",
          "Server-generated message UUIDs must use lowercase canonical text",
          { message_id: messageId },
        );
      }
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
  characterTurnId: string | undefined,
): void {
  if (command.commandKind === "player_day.end") {
    if (
      characterTurnId !== undefined ||
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
  const expectedFinalRevision =
    command.acceptedSession.worldRevision + DIALOGUE_PACKET_COUNT;
  if (
    !Number.isSafeInteger(expectedFinalRevision) ||
    finalWorldRevision !== expectedFinalRevision ||
    characterTurnId === undefined ||
    characterTurnId !== requireCharacterTurnId(command)
  ) {
    throw new EngineFault(
      "dialogue.finalizer.completion_identity_mismatch",
      "Accepted dialogue completion must match its two committed packets and persisted character turn",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
        accepted_world_revision:
          command.acceptedSession.worldRevision,
        expected_final_world_revision: expectedFinalRevision,
        actual_final_world_revision: finalWorldRevision,
        expected_character_turn_id: command.characterTurnId ?? null,
        actual_character_turn_id: characterTurnId ?? null,
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

function requireCharacterTurnId(
  command: ValidatedFinalizationCommand,
): string {
  if (command.characterTurnId === undefined) {
    throw new EngineFault(
      "command.finalizer.database_corrupt",
      "Dialogue command is missing its persisted character turn identity",
      {
        session_id: command.sessionId,
        command_id: command.commandId,
      },
    );
  }
  return command.characterTurnId;
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
            command.character_turn_id::text AS character_turn_id,
            player_day.from_day::text AS player_day_from_day_text,
            command.command_status,
            command.result_document
       FROM luoxia_engine.command_journal AS command
       LEFT JOIN luoxia_engine.player_day_end_runs AS player_day
         ON player_day.session_id = command.session_id
        AND player_day.command_id = command.command_id
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
    row.command_kind !== "player_day.end"
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
  const isDialogue = row.command_kind !== "player_day.end";
  if (
    (isDialogue &&
      (row.dialogue_id === null ||
        row.character_turn_id === null ||
        row.player_day_from_day_text !== null)) ||
    (!isDialogue &&
      (row.dialogue_id !== null || row.character_turn_id !== null))
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
    characterTurnId:
      row.character_turn_id === null
        ? undefined
        : assertUuid(contracts, row.character_turn_id),
    playerDayFromDay:
      row.player_day_from_day_text === null
        ? undefined
        : parseSafeUnsignedInteger(
            row.player_day_from_day_text,
            "command.finalizer.database_corrupt",
            "Player-day source day",
            { session_id: sessionId, command_id: commandId },
          ),
    status: row.command_status,
    result,
  });
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
  const expectedTypes =
    actualStatus === "accepted"
      ? command.commandKind === "player_day.end"
        ? ["session.view", "command.result"]
        : ["dialogue.reply", "session.view", "command.result"]
      : ["session.view", "command.result"];
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
