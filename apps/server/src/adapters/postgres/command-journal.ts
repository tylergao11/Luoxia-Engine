import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type { Pool, PoolClient } from "pg";

import type {
  ClientEnvelopeDocument,
  CommandExecutionIdFactory,
  CommandJournal,
  CommandResultDocument,
  ContentUpgradeCommandExecutionIdentity,
  DialogueCommandExecutionIdentity,
  DialogueCloseCommandExecutionIdentity,
  EventCardCommandExecutionIdentity,
  NavigationCommandExecutionIdentity,
  StageOutcomeCommandExecutionIdentity,
  StoredCommand,
  StoredCompletedCommand,
} from "../../application/command-journal.js";
import type {
  EngineSessionBasisTokenAuthority,
  EngineSessionRecord,
} from "../../application/engine-session.js";
import {
  assertSessionWorldCurrent,
  readEngineSessionContext,
} from "./engine-session-repository.js";
import {
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresCommandJournalDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly basisTokens: EngineSessionBasisTokenAuthority;
  readonly idFactory: CommandExecutionIdFactory;
}

interface CommandRow {
  readonly session_id: string;
  readonly command_id: string;
  readonly command_kind: string;
  readonly request_digest: string;
  readonly request_document: unknown;
  readonly accepted_world_id: string;
  readonly accepted_control_binding_id: string;
  readonly accepted_player_entity_id: string;
  readonly accepted_view_revision_text: string;
  readonly accepted_world_revision_text: string;
  readonly accepted_nonce: string;
  readonly dialogue_id: string | null;
  readonly human_turn_id: string | null;
  readonly human_rule_request_id: string | null;
  readonly character_model_request_id: string | null;
  readonly character_turn_id: string | null;
  readonly character_rule_request_id: string | null;
  readonly dialogue_close_rule_request_id: string | null;
  readonly event_card_packet_id: string | null;
  readonly navigation_rule_request_id: string | null;
  readonly stage_outcome_rule_request_id: string | null;
  readonly content_upgrade_command_id: string | null;
  readonly content_upgrade_rule_request_id: string | null;
  readonly command_status: string;
  readonly result_document: unknown | null;
}

interface ReceivedCommandCandidate {
  readonly envelope: ClientEnvelopeDocument;
  readonly sessionId: string;
  readonly commandId: string;
  readonly commandKind: string;
  readonly basisToken: string;
  readonly message: JsonObject;
  readonly requestDigest: string;
}

export function createPostgresCommandJournal(
  dependencies: PostgresCommandJournalDependencies,
): CommandJournal {
  return new PostgresCommandJournal(dependencies);
}

class PostgresCommandJournal implements CommandJournal {
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #basisTokens: EngineSessionBasisTokenAuthority;
  readonly #idFactory: CommandExecutionIdFactory;

  public constructor(dependencies: PostgresCommandJournalDependencies) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#basisTokens = dependencies.basisTokens;
    this.#idFactory = dependencies.idFactory;
  }

  public async receive(candidate: unknown): Promise<StoredCommand> {
    const received = validateCommandCandidate(
      this.#contracts,
      this.#digest,
      candidate,
    );
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const first = await readCommandRow(
            client,
            received.sessionId,
            received.commandId,
            "",
          );
          if (first !== undefined) {
            return assertSameCommand(
              validateCommandRow(this.#contracts, this.#digest, first),
              received,
            );
          }

          const sessionContext = await readEngineSessionContext(
            client,
            this.#contracts,
            received.sessionId,
            "FOR UPDATE OF s FOR SHARE OF w",
          );
          const raced = await readCommandRow(
            client,
            received.sessionId,
            received.commandId,
            "FOR UPDATE",
          );
          if (raced !== undefined) {
            return assertSameCommand(
              validateCommandRow(this.#contracts, this.#digest, raced),
              received,
            );
          }

          assertSessionWorldCurrent(sessionContext);
          this.#basisTokens.assertAuthentic(
            sessionContext.session,
            received.basisToken,
          );
          const dialogueExecution = createDialogueExecutionIdentity(
            this.#contracts,
            this.#idFactory,
            received,
          );
          const dialogueCloseExecution =
            createDialogueCloseExecutionIdentity(
              this.#contracts,
              this.#idFactory,
              received,
            );
          const eventCardExecution =
            createEventCardExecutionIdentity(
              this.#contracts,
              this.#idFactory,
              received,
            );
          const navigationExecution =
            createNavigationExecutionIdentity(
              this.#contracts,
              this.#idFactory,
              received,
            );
          const stageOutcomeExecution =
            createStageOutcomeExecutionIdentity(
              this.#contracts,
              this.#idFactory,
              received,
            );
          const contentUpgradeExecution =
            createContentUpgradeExecutionIdentity(
              this.#contracts,
              this.#idFactory,
              received,
            );
          const insert = await client.query(
            `INSERT INTO luoxia_engine.command_journal (
               session_id,
               command_id,
               command_kind,
               request_digest,
               request_document,
               accepted_world_id,
               accepted_control_binding_id,
               accepted_player_entity_id,
               accepted_view_revision,
               accepted_world_revision,
               accepted_nonce,
               dialogue_id,
               human_turn_id,
               human_rule_request_id,
               character_model_request_id,
               character_turn_id,
               character_rule_request_id,
               dialogue_close_rule_request_id,
               event_card_packet_id,
               navigation_rule_request_id,
               stage_outcome_rule_request_id,
               content_upgrade_command_id,
               content_upgrade_rule_request_id,
               command_status,
               received_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3,
               $4,
               $5::jsonb,
               $6::uuid,
               $7::uuid,
               $8::uuid,
               $9::bigint,
               $10::bigint,
               $11::uuid,
               $12::uuid,
               $13::uuid,
               $14::uuid,
               $15::uuid,
               $16::uuid,
               $17::uuid,
               $18::uuid,
               $19::uuid,
               $20::uuid,
               $21::uuid,
               $22::uuid,
               $23::uuid,
               'received',
               clock_timestamp()
             )`,
            [
              received.sessionId,
              received.commandId,
              received.commandKind,
              received.requestDigest,
              JSON.stringify(received.envelope.value),
              sessionContext.session.worldId,
              sessionContext.session.controlBindingId,
              sessionContext.session.playerEntityId,
              sessionContext.session.viewRevision.toString(),
              sessionContext.session.worldRevision.toString(),
              sessionContext.session.nonce,
              dialogueExecution?.dialogueId ?? null,
              dialogueExecution?.humanTurnId ?? null,
              dialogueExecution?.humanRuleRequestId ?? null,
              dialogueExecution?.characterModelRequestId ?? null,
              dialogueExecution?.characterTurnId ?? null,
              dialogueExecution?.characterRuleRequestId ?? null,
              dialogueCloseExecution?.ruleRequestId ?? null,
              eventCardExecution?.packetId ?? null,
              navigationExecution?.ruleRequestId ?? null,
              stageOutcomeExecution?.ruleRequestId ?? null,
              contentUpgradeExecution?.upgradeCommandId ?? null,
              contentUpgradeExecution?.ruleRequestId ?? null,
            ],
          );
          if (insert.rowCount !== 1) {
            throw new EngineFault(
              "command.journal.database_corrupt",
              "Command Journal INSERT did not affect exactly one row",
              {
                session_id: received.sessionId,
                command_id: received.commandId,
              },
            );
          }
          return Object.freeze({
            phase: "received",
            session: sessionContext.session,
            commandId: received.commandId,
            commandKind: received.commandKind,
            requestDigest: received.requestDigest,
            envelope: received.envelope,
            message: received.message,
            ...(dialogueExecution === undefined
              ? {}
              : { dialogueExecution }),
            ...(dialogueCloseExecution === undefined
              ? {}
              : { dialogueCloseExecution }),
            ...(eventCardExecution === undefined
              ? {}
              : { eventCardExecution }),
            ...(navigationExecution === undefined
              ? {}
              : { navigationExecution }),
            ...(stageOutcomeExecution === undefined
              ? {}
              : { stageOutcomeExecution }),
            ...(contentUpgradeExecution === undefined
              ? {}
              : { contentUpgradeExecution }),
          });
        },
      );
    } catch (error: unknown) {
      throw normalizeCommandJournalError(
        error,
        received.sessionId,
        received.commandId,
      );
    }
  }

  public async read(
    sessionId: string,
    commandId: string,
  ): Promise<StoredCommand | undefined> {
    const verifiedSessionId = assertUuid(this.#contracts, sessionId);
    const verifiedCommandId = assertUuid(this.#contracts, commandId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const row = await readCommandRow(
          client,
          verifiedSessionId,
          verifiedCommandId,
          "",
        );
        return row === undefined
          ? undefined
          : validateCommandRow(this.#contracts, this.#digest, row);
      });
    } catch (error: unknown) {
      throw normalizeCommandJournalError(
        error,
        verifiedSessionId,
        verifiedCommandId,
      );
    }
  }

  public async complete(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly resultCandidate: unknown;
  }): Promise<StoredCompletedCommand> {
    const sessionId = assertUuid(this.#contracts, input.sessionId);
    const commandId = assertUuid(this.#contracts, input.commandId);
    const result = this.#contracts.assertObject(
      CONTRACT_REF.commandResult,
      input.resultCandidate,
    );
    assertFinalCommandResult(result, commandId);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const first = await readCommandRow(
            client,
            sessionId,
            commandId,
            "",
          );
          if (first === undefined) {
            throw new EngineFault(
              "command.journal.command_missing",
              "Command cannot complete before it is received",
              { session_id: sessionId, command_id: commandId },
            );
          }
          const firstStored = validateCommandRow(
            this.#contracts,
            this.#digest,
            first,
          );
          if (firstStored.phase === "completed") {
            return assertSameResult(firstStored, result);
          }

          const sessionContext = await readEngineSessionContext(
            client,
            this.#contracts,
            sessionId,
            "FOR UPDATE OF s FOR SHARE OF w",
          );
          assertSessionWorldCurrent(sessionContext);
          const locked = await readCommandRow(
            client,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          const lockedRow = requireValue(
            locked,
            "command.journal.command_missing",
            "Command disappeared before completion",
            { session_id: sessionId, command_id: commandId },
          );
          const stored = validateCommandRow(
            this.#contracts,
            this.#digest,
            lockedRow,
          );
          if (stored.phase === "completed") {
            return assertSameResult(stored, result);
          }
          const resultViewRevision = expectInteger(
            result.value,
            "view_revision",
            "CommandResult",
          );
          if (
            resultViewRevision !== sessionContext.session.viewRevision
          ) {
            throw new EngineFault(
              "command.journal.result_view_revision_mismatch",
              "CommandResult.view_revision must equal the current Engine Session view revision",
              {
                session_id: sessionId,
                command_id: commandId,
                result_view_revision: resultViewRevision,
                session_view_revision:
                  sessionContext.session.viewRevision,
              },
            );
          }
          const update = await client.query(
            `UPDATE luoxia_engine.command_journal
                SET command_status = 'completed',
                    result_document = $3::jsonb,
                    completed_at = clock_timestamp()
              WHERE session_id = $1::uuid
                AND command_id = $2::uuid
                AND command_status = 'received'`,
            [sessionId, commandId, JSON.stringify(result.value)],
          );
          if (update.rowCount !== 1) {
            throw new EngineFault(
              "command.journal.stage_conflict",
              "Command Journal phase changed before completion",
              { session_id: sessionId, command_id: commandId },
            );
          }
          return Object.freeze({
            ...stored,
            phase: "completed",
            result,
          });
        },
      );
    } catch (error: unknown) {
      throw normalizeCommandJournalError(error, sessionId, commandId);
    }
  }
}

const COMMAND_SELECT = `SELECT
  session_id::text AS session_id,
  command_id::text AS command_id,
  command_kind,
  request_digest,
  request_document,
  accepted_world_id::text AS accepted_world_id,
  accepted_control_binding_id::text AS accepted_control_binding_id,
  accepted_player_entity_id::text AS accepted_player_entity_id,
  accepted_view_revision::text AS accepted_view_revision_text,
  accepted_world_revision::text AS accepted_world_revision_text,
  accepted_nonce::text AS accepted_nonce,
  dialogue_id::text AS dialogue_id,
  human_turn_id::text AS human_turn_id,
  human_rule_request_id::text AS human_rule_request_id,
  character_model_request_id::text AS character_model_request_id,
  character_turn_id::text AS character_turn_id,
  character_rule_request_id::text AS character_rule_request_id,
  dialogue_close_rule_request_id::text AS dialogue_close_rule_request_id,
  event_card_packet_id::text AS event_card_packet_id,
  navigation_rule_request_id::text AS navigation_rule_request_id,
  stage_outcome_rule_request_id::text AS stage_outcome_rule_request_id,
  content_upgrade_command_id::text AS content_upgrade_command_id,
  content_upgrade_rule_request_id::text
    AS content_upgrade_rule_request_id,
  command_status,
  result_document
FROM luoxia_engine.command_journal`;

async function readCommandRow(
  client: PoolClient,
  sessionId: string,
  commandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<CommandRow | undefined> {
  const query = await client.query<CommandRow>(
    `${COMMAND_SELECT}
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      ${lockClause}`,
    [sessionId, commandId],
  );
  return requireAtMostOne(
    query.rows,
    "command.journal.database_corrupt",
    "Command identity lookup returned more than one row",
    { session_id: sessionId, command_id: commandId },
  );
}

function validateCommandCandidate(
  contracts: ContractValidator,
  digest: JsonDigest,
  candidate: unknown,
): ReceivedCommandCandidate {
  const envelope = contracts.assertObject(
    CONTRACT_REF.clientEnvelope,
    candidate,
  );
  const message = expectJsonObject(
    expectProperty(envelope.value, "message", "ClientEnvelope"),
    "ClientEnvelope.message",
  );
  if (
    !Object.prototype.hasOwnProperty.call(message, "command_id") ||
    !Object.prototype.hasOwnProperty.call(message, "basis_token")
  ) {
    throw new EngineFault(
      "command.journal.message_not_command",
      "ClientEnvelope message is not an authoritative command",
      {
        message_type: expectString(message, "type", "ClientMessage"),
      },
    );
  }
  const sessionId = expectString(
    envelope.value,
    "session_id",
    "ClientEnvelope",
  );
  const commandId = expectString(message, "command_id", "ClientMessage");
  contracts.assert(CONTRACT_REF.uuid, sessionId);
  contracts.assert(CONTRACT_REF.uuid, commandId);
  return Object.freeze({
    envelope,
    sessionId,
    commandId,
    commandKind: expectString(message, "type", "ClientMessage"),
    basisToken: expectString(message, "basis_token", "ClientMessage"),
    message,
    requestDigest: digest.sha256(envelope.value),
  });
}

function createDialogueExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): DialogueCommandExecutionIdentity | undefined {
  if (
    command.commandKind !== "dialogue.start" &&
    command.commandKind !== "dialogue.continue"
  ) {
    return undefined;
  }

  const createGeneratedId = (label: string): string => {
    const id = assertUuid(contracts, idFactory.createId());
    if (id !== id.toLowerCase()) {
      throw new EngineFault(
        "command.journal.generated_identity_noncanonical",
        "Server-generated command execution UUIDs must use lowercase canonical text",
        { command_id: command.commandId, identity: label, uuid: id },
      );
    }
    return id;
  };
  const dialogueId =
    command.commandKind === "dialogue.continue"
      ? assertUuid(
          contracts,
          expectString(
            command.message,
            "dialogue_id",
            "DialogueContinue",
          ),
        )
      : createGeneratedId("dialogue_id");
  const identity: DialogueCommandExecutionIdentity = Object.freeze({
    dialogueId,
    humanTurnId: createGeneratedId("human_turn_id"),
    humanRuleRequestId: createGeneratedId("human_rule_request_id"),
    characterModelRequestId: createGeneratedId(
      "character_model_request_id",
    ),
    characterTurnId: createGeneratedId("character_turn_id"),
    characterRuleRequestId: createGeneratedId(
      "character_rule_request_id",
    ),
  });
  assertDialogueExecutionIdsDistinct(identity, command.commandId);
  return identity;
}

function createEventCardExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): EventCardCommandExecutionIdentity | undefined {
  if (command.commandKind !== "event_card.trigger") {
    return undefined;
  }
  const packetId = assertUuid(contracts, idFactory.createId());
  if (packetId !== packetId.toLowerCase()) {
    throw new EngineFault(
      "command.journal.generated_identity_noncanonical",
      "Server-generated EventCard packet UUID must use lowercase canonical text",
      {
        command_id: command.commandId,
        identity: "event_card_packet_id",
        uuid: packetId,
      },
    );
  }
  if (packetId === command.commandId) {
    throw new EngineFault(
      "command.journal.event_card_identity_collision",
      "EventCard packet identity must differ from its Session-scoped command identity",
      {
        command_id: command.commandId,
        event_card_packet_id: packetId,
      },
    );
  }
  return Object.freeze({ packetId });
}

function createDialogueCloseExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): DialogueCloseCommandExecutionIdentity | undefined {
  if (command.commandKind !== "dialogue.close") {
    return undefined;
  }
  const ruleRequestId = assertUuid(contracts, idFactory.createId());
  if (ruleRequestId !== ruleRequestId.toLowerCase()) {
    throw new EngineFault(
      "command.journal.generated_identity_noncanonical",
      "Server-generated dialogue-close RulePlugin request UUID must use lowercase canonical text",
      {
        command_id: command.commandId,
        identity: "dialogue_close_rule_request_id",
        uuid: ruleRequestId,
      },
    );
  }
  if (ruleRequestId === command.commandId) {
    throw new EngineFault(
      "command.journal.dialogue_close_identity_collision",
      "Dialogue-close RulePlugin request identity must differ from its Session-scoped command identity",
      {
        command_id: command.commandId,
        dialogue_close_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function createNavigationExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): NavigationCommandExecutionIdentity | undefined {
  if (command.commandKind !== "map.move") {
    return undefined;
  }
  const ruleRequestId = assertUuid(contracts, idFactory.createId());
  if (ruleRequestId !== ruleRequestId.toLowerCase()) {
    throw new EngineFault(
      "command.journal.generated_identity_noncanonical",
      "Server-generated navigation RulePlugin request UUID must use lowercase canonical text",
      {
        command_id: command.commandId,
        identity: "navigation_rule_request_id",
        uuid: ruleRequestId,
      },
    );
  }
  if (ruleRequestId === command.commandId) {
    throw new EngineFault(
      "command.journal.navigation_identity_collision",
      "Navigation RulePlugin request identity must differ from its Session-scoped command identity",
      {
        command_id: command.commandId,
        navigation_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function createStageOutcomeExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): StageOutcomeCommandExecutionIdentity | undefined {
  if (command.commandKind !== "stage.outcome_proposal") {
    return undefined;
  }
  const ruleRequestId = assertUuid(contracts, idFactory.createId());
  if (ruleRequestId !== ruleRequestId.toLowerCase()) {
    throw new EngineFault(
      "command.journal.generated_identity_noncanonical",
      "Server-generated Stage outcome RulePlugin request UUID must use lowercase canonical text",
      {
        command_id: command.commandId,
        identity: "stage_outcome_rule_request_id",
        uuid: ruleRequestId,
      },
    );
  }
  if (ruleRequestId === command.commandId) {
    throw new EngineFault(
      "command.journal.stage_outcome_identity_collision",
      "Stage outcome RulePlugin request identity must differ from its Session-scoped command identity",
      {
        command_id: command.commandId,
        stage_outcome_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function createContentUpgradeExecutionIdentity(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  command: ReceivedCommandCandidate,
): ContentUpgradeCommandExecutionIdentity | undefined {
  if (command.commandKind !== "content_upgrade.accept") {
    return undefined;
  }
  const upgradeCommandId = assertUuid(contracts, idFactory.createId());
  const ruleRequestId = assertUuid(contracts, idFactory.createId());
  for (const [identity, value] of [
    ["content_upgrade_command_id", upgradeCommandId],
    ["content_upgrade_rule_request_id", ruleRequestId],
  ] as const) {
    if (value !== value.toLowerCase()) {
      throw new EngineFault(
        "command.journal.generated_identity_noncanonical",
        "Server-generated Content Upgrade identities must use lowercase canonical UUID text",
        {
          command_id: command.commandId,
          identity,
          uuid: value,
        },
      );
    }
  }
  if (
    upgradeCommandId === command.commandId ||
    ruleRequestId === command.commandId ||
    upgradeCommandId === ruleRequestId
  ) {
    throw new EngineFault(
      "command.journal.content_upgrade_identity_collision",
      "Content Upgrade execution identities must be pairwise distinct from the Session-scoped command identity",
      {
        command_id: command.commandId,
        content_upgrade_command_id: upgradeCommandId,
        content_upgrade_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ upgradeCommandId, ruleRequestId });
}

function validateCommandRow(
  contracts: ContractValidator,
  digest: JsonDigest,
  row: CommandRow,
): StoredCommand {
  const envelope = contracts.assertObject(
    CONTRACT_REF.clientEnvelope,
    row.request_document,
  );
  const message = expectJsonObject(
    expectProperty(envelope.value, "message", "ClientEnvelope"),
    "ClientEnvelope.message",
  );
  const sessionId = expectString(
    envelope.value,
    "session_id",
    "ClientEnvelope",
  );
  const commandId = expectString(message, "command_id", "ClientMessage");
  const commandKind = expectString(message, "type", "ClientMessage");
  const session: EngineSessionRecord = Object.freeze({
    sessionId: assertUuid(contracts, row.session_id),
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
      "command.journal.database_corrupt",
      "Accepted Session view revision",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        revision: row.accepted_view_revision_text,
      },
    ),
    worldRevision: parseSafeUnsignedInteger(
      row.accepted_world_revision_text,
      "command.journal.database_corrupt",
      "Accepted Session world revision",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        revision: row.accepted_world_revision_text,
      },
    ),
    nonce: assertUuid(contracts, row.accepted_nonce),
  });
  if (
    sessionId !== row.session_id ||
    commandId !== row.command_id ||
    commandKind !== row.command_kind ||
    row.request_digest !== digest.sha256(envelope.value)
  ) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Command Journal columns do not match the stored ClientEnvelope",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const dialogueExecution = readDialogueExecutionIdentity(
    contracts,
    row,
    message,
    commandKind,
  );
  const dialogueCloseExecution = readDialogueCloseExecutionIdentity(
    contracts,
    row,
    commandKind,
    commandId,
  );
  const eventCardExecution = readEventCardExecutionIdentity(
    contracts,
    row,
    commandKind,
    commandId,
  );
  const navigationExecution = readNavigationExecutionIdentity(
    contracts,
    row,
    commandKind,
    commandId,
  );
  const stageOutcomeExecution = readStageOutcomeExecutionIdentity(
    contracts,
    row,
    commandKind,
    commandId,
  );
  const contentUpgradeExecution = readContentUpgradeExecutionIdentity(
    contracts,
    row,
    commandKind,
    commandId,
  );
  const base = Object.freeze({
    session,
    commandId,
    commandKind,
    requestDigest: row.request_digest,
    envelope,
    message,
    ...(dialogueExecution === undefined ? {} : { dialogueExecution }),
    ...(dialogueCloseExecution === undefined
      ? {}
      : { dialogueCloseExecution }),
    ...(eventCardExecution === undefined
      ? {}
      : { eventCardExecution }),
    ...(navigationExecution === undefined
      ? {}
      : { navigationExecution }),
    ...(stageOutcomeExecution === undefined
      ? {}
      : { stageOutcomeExecution }),
    ...(contentUpgradeExecution === undefined
      ? {}
      : { contentUpgradeExecution }),
  });
  if (row.command_status === "received") {
    if (row.result_document !== null) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Received command already contains a result document",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return Object.freeze({ ...base, phase: "received" });
  }
  if (row.command_status !== "completed" || row.result_document === null) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Command Journal row has an unknown or incomplete status",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        command_status: row.command_status,
      },
    );
  }
  const result = contracts.assertObject(
    CONTRACT_REF.commandResult,
    row.result_document,
  );
  assertFinalCommandResult(result, commandId);
  return Object.freeze({ ...base, phase: "completed", result });
}

function readDialogueCloseExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  commandKind: string,
  commandId: string,
): DialogueCloseCommandExecutionIdentity | undefined {
  if (commandKind !== "dialogue.close") {
    if (row.dialogue_close_rule_request_id !== null) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-dialogue-close command contains a dialogue-close RulePlugin request identity",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (row.dialogue_close_rule_request_id === null) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Dialogue-close command is missing its persisted RulePlugin request identity",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const ruleRequestId = assertUuid(
    contracts,
    row.dialogue_close_rule_request_id,
  );
  if (ruleRequestId === commandId) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Dialogue-close RulePlugin request identity collides with its Session-scoped command identity",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        dialogue_close_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function readNavigationExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  commandKind: string,
  commandId: string,
): NavigationCommandExecutionIdentity | undefined {
  if (commandKind !== "map.move") {
    if (row.navigation_rule_request_id !== null) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-navigation command contains a navigation RulePlugin request identity",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (row.navigation_rule_request_id === null) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Navigation command is missing its persisted RulePlugin request identity",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const ruleRequestId = assertUuid(
    contracts,
    row.navigation_rule_request_id,
  );
  if (ruleRequestId === commandId) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Navigation RulePlugin request identity collides with its Session-scoped command identity",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        navigation_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function readStageOutcomeExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  commandKind: string,
  commandId: string,
): StageOutcomeCommandExecutionIdentity | undefined {
  if (commandKind !== "stage.outcome_proposal") {
    if (row.stage_outcome_rule_request_id !== null) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-Stage-outcome command contains a Stage-outcome RulePlugin request identity",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (row.stage_outcome_rule_request_id === null) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Stage outcome command is missing its persisted RulePlugin request identity",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const ruleRequestId = assertUuid(
    contracts,
    row.stage_outcome_rule_request_id,
  );
  if (ruleRequestId === commandId) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Stage outcome RulePlugin request identity collides with its Session-scoped command identity",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        stage_outcome_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ ruleRequestId });
}

function readContentUpgradeExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  commandKind: string,
  commandId: string,
): ContentUpgradeCommandExecutionIdentity | undefined {
  if (commandKind !== "content_upgrade.accept") {
    if (
      row.content_upgrade_command_id !== null ||
      row.content_upgrade_rule_request_id !== null
    ) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-Content-Upgrade command contains Content Upgrade execution identities",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (
    row.content_upgrade_command_id === null ||
    row.content_upgrade_rule_request_id === null
  ) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Content Upgrade command is missing its persisted execution identities",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const upgradeCommandId = assertUuid(
    contracts,
    row.content_upgrade_command_id,
  );
  const ruleRequestId = assertUuid(
    contracts,
    row.content_upgrade_rule_request_id,
  );
  if (
    upgradeCommandId === commandId ||
    ruleRequestId === commandId ||
    upgradeCommandId === ruleRequestId
  ) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Content Upgrade execution identities are not pairwise distinct",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        content_upgrade_command_id: upgradeCommandId,
        content_upgrade_rule_request_id: ruleRequestId,
      },
    );
  }
  return Object.freeze({ upgradeCommandId, ruleRequestId });
}

function readEventCardExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  commandKind: string,
  commandId: string,
): EventCardCommandExecutionIdentity | undefined {
  if (commandKind !== "event_card.trigger") {
    if (row.event_card_packet_id !== null) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-EventCard command contains an EventCard packet identity",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (row.event_card_packet_id === null) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "EventCard command is missing its persisted packet identity",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  const packetId = assertUuid(contracts, row.event_card_packet_id);
  if (packetId === commandId) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "EventCard packet identity collides with its Session-scoped command identity",
      {
        session_id: row.session_id,
        command_id: row.command_id,
        event_card_packet_id: packetId,
      },
    );
  }
  return Object.freeze({ packetId });
}

function readDialogueExecutionIdentity(
  contracts: ContractValidator,
  row: CommandRow,
  message: JsonObject,
  commandKind: string,
): DialogueCommandExecutionIdentity | undefined {
  const values = [
    row.dialogue_id,
    row.human_turn_id,
    row.human_rule_request_id,
    row.character_model_request_id,
    row.character_turn_id,
    row.character_rule_request_id,
  ] as const;
  const isDialogue =
    commandKind === "dialogue.start" ||
    commandKind === "dialogue.continue";
  if (!isDialogue) {
    if (values.some((value) => value !== null)) {
      throw new EngineFault(
        "command.journal.database_corrupt",
        "Non-dialogue command contains dialogue execution identities",
        { session_id: row.session_id, command_id: row.command_id },
      );
    }
    return undefined;
  }
  if (values.some((value) => value === null)) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "Dialogue command is missing a persisted execution identity",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }

  const identity: DialogueCommandExecutionIdentity = Object.freeze({
    dialogueId: assertUuid(contracts, row.dialogue_id as string),
    humanTurnId: assertUuid(contracts, row.human_turn_id as string),
    humanRuleRequestId: assertUuid(
      contracts,
      row.human_rule_request_id as string,
    ),
    characterModelRequestId: assertUuid(
      contracts,
      row.character_model_request_id as string,
    ),
    characterTurnId: assertUuid(
      contracts,
      row.character_turn_id as string,
    ),
    characterRuleRequestId: assertUuid(
      contracts,
      row.character_rule_request_id as string,
    ),
  });
  assertDialogueExecutionIdsDistinct(identity, row.command_id);
  if (
    commandKind === "dialogue.continue" &&
    identity.dialogueId !==
      expectString(message, "dialogue_id", "DialogueContinue")
  ) {
    throw new EngineFault(
      "command.journal.database_corrupt",
      "DialogueContinue execution identity differs from its message dialogue_id",
      { session_id: row.session_id, command_id: row.command_id },
    );
  }
  return identity;
}

function assertDialogueExecutionIdsDistinct(
  identity: DialogueCommandExecutionIdentity,
  commandId: string,
): void {
  const ids = [
    identity.dialogueId,
    identity.humanTurnId,
    identity.humanRuleRequestId,
    identity.characterModelRequestId,
    identity.characterTurnId,
    identity.characterRuleRequestId,
  ];
  if (new Set(ids).size !== ids.length) {
    throw new EngineFault(
      "command.journal.dialogue_identity_collision",
      "Dialogue command execution identities must be pairwise distinct",
      { command_id: commandId },
    );
  }
}

function assertSameCommand(
  stored: StoredCommand,
  received: ReceivedCommandCandidate,
): StoredCommand {
  if (
    stored.requestDigest !== received.requestDigest ||
    stored.commandKind !== received.commandKind ||
    !jsonEquals(stored.envelope.value, received.envelope.value)
  ) {
    throw new EngineFault(
      "command.journal.command_id_conflict",
      "Command identity is already bound to a different request",
      {
        session_id: received.sessionId,
        command_id: received.commandId,
      },
    );
  }
  return stored;
}

function assertFinalCommandResult(
  result: CommandResultDocument,
  commandId: string,
): void {
  if (
    expectString(result.value, "command_id", "CommandResult") !== commandId
  ) {
    throw new EngineFault(
      "command.journal.result_identity_mismatch",
      "CommandResult.command_id differs from the Command Journal identity",
      { command_id: commandId },
    );
  }
}

function assertSameResult(
  stored: StoredCompletedCommand,
  result: CommandResultDocument,
): StoredCompletedCommand {
  if (!jsonEquals(stored.result.value, result.value)) {
    throw new EngineFault(
      "command.journal.result_conflict",
      "Completed command is already bound to a different CommandResult",
      {
        session_id: stored.session.sessionId,
        command_id: stored.commandId,
      },
    );
  }
  return stored;
}

function requireValue<TValue>(
  value: TValue | undefined,
  code: string,
  message: string,
  details: JsonObject,
): TValue {
  if (value === undefined) {
    throw new EngineFault(code, message, details);
  }
  return value;
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeCommandJournalError(
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
  if (constraint === "command_journal_pkey") {
    return new EngineFault(
      "command.journal.command_id_conflict",
      "PostgreSQL rejected a conflicting Command identity",
      { session_id: sessionId, command_id: commandId },
    );
  }
  if (constraint === "command_journal_active_world_unique") {
    return new EngineFault(
      "command.journal.world_busy",
      "Another unfinished command already owns this world execution slot",
      { session_id: sessionId, command_id: commandId },
    );
  }
  if (constraint === "command_journal_session_id_fkey") {
    return new EngineFault(
      "command.journal.session_missing",
      "Command Journal references a missing Engine Session",
      { session_id: sessionId, command_id: commandId },
    );
  }
  return new EngineFault(
    "command.journal.database_error",
    "PostgreSQL rejected the Command Journal operation",
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
