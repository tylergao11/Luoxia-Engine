import {
  EngineFault,
  type ContractValidator,
} from "@luoxia/contracts-runtime";
import type { Pool, PoolClient } from "pg";

import type {
  CommandExecutionIdFactory,
  StoredReceivedCommand,
} from "../../application/command-journal.js";
import type {
  DialogueDefinitionRunRecord,
  DialogueDirectorRequestKind,
  DialogueDirectorProposalRuns,
  DialogueDirectorRunJournal,
  DialogueDirectorRunRecord,
  DialogueEventCardRunRecord,
  DialogueGoalPlanRunRecord,
} from "../../application/dialogue-director-run.js";
import {
  assertUuid,
  requireAtMostOne,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresDialogueDirectorRunJournalDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly idFactory: CommandExecutionIdFactory;
}

interface DialogueDirectorRunRow {
  readonly session_id: string;
  readonly command_id: string;
  readonly world_id: string;
  readonly dialogue_id: string;
  readonly request_kind: string;
  readonly model_request_id: string;
  readonly response_turn_id: string | null;
  readonly response_rule_request_id: string | null;
}

interface CommandBoundaryRow {
  readonly command_kind: string;
  readonly command_status: string;
  readonly accepted_world_id: string;
  readonly dialogue_id: string | null;
}

type ProposalKind = "definition" | "goal_plan" | "event_card";

interface ProposalRunRow {
  readonly proposal_kind: string;
  readonly proposal_id: string;
  readonly proposal_ordinal: number;
  readonly world_record_id: string | null;
  readonly rule_request_id: string;
  readonly prepared_at: string;
}

export function createPostgresDialogueDirectorRunJournal(
  dependencies: PostgresDialogueDirectorRunJournalDependencies,
): DialogueDirectorRunJournal {
  return new PostgresDialogueDirectorRunJournal(dependencies);
}

class PostgresDialogueDirectorRunJournal
  implements DialogueDirectorRunJournal
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #idFactory: CommandExecutionIdFactory;

  public constructor(
    dependencies: PostgresDialogueDirectorRunJournalDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#idFactory = dependencies.idFactory;
  }

  public async prepare(input: {
    readonly command: StoredReceivedCommand;
    readonly dialogueId: string;
    readonly requestKind: DialogueDirectorRequestKind;
  }): Promise<DialogueDirectorRunRecord> {
    assertDialogueCommand(input.command, input.dialogueId);
    const sessionId = assertUuid(
      this.#contracts,
      input.command.session.sessionId,
    );
    const commandId = assertUuid(
      this.#contracts,
      input.command.commandId,
    );
    const worldId = assertUuid(
      this.#contracts,
      input.command.session.worldId,
    );
    const dialogueId = assertUuid(
      this.#contracts,
      input.dialogueId,
    );

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const first = await readRun(
            client,
            sessionId,
            commandId,
            "",
          );
          if (first !== undefined) {
            return validateRunRow(
              this.#contracts,
              first,
              {
                sessionId,
                commandId,
                worldId,
                dialogueId,
                requestKind: input.requestKind,
              },
            );
          }

          const boundary = await lockCommandBoundary(
            client,
            sessionId,
            commandId,
          );
          assertCommandBoundary(boundary, {
            sessionId,
            commandId,
            worldId,
            dialogueId,
          });
          const raced = await readRun(
            client,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          if (raced !== undefined) {
            return validateRunRow(
              this.#contracts,
              raced,
              {
                sessionId,
                commandId,
                worldId,
                dialogueId,
                requestKind: input.requestKind,
              },
            );
          }

          const modelRequestId = createGeneratedId(
            this.#contracts,
            this.#idFactory,
            commandId,
            "director_model_request_id",
          );
          const responseTurnId =
            input.requestKind === "director.system_dialogue"
              ? createGeneratedId(
                  this.#contracts,
                  this.#idFactory,
                  commandId,
                  "director_response_turn_id",
                )
              : undefined;
          const responseRuleRequestId =
            input.requestKind === "director.system_dialogue"
              ? createGeneratedId(
                  this.#contracts,
                  this.#idFactory,
                  commandId,
                  "director_response_rule_request_id",
                )
              : undefined;
          const ids = [
            modelRequestId,
            ...(responseTurnId === undefined ? [] : [responseTurnId]),
            ...(responseRuleRequestId === undefined
              ? []
              : [responseRuleRequestId]),
          ];
          if (new Set(ids).size !== ids.length) {
            throw new EngineFault(
              "dialogue.director_run.identity_collision",
              "Dialogue Director run identities must be pairwise distinct",
              { session_id: sessionId, command_id: commandId },
            );
          }

          const inserted = await client.query(
            `INSERT INTO luoxia_engine.dialogue_director_runs (
               session_id,
               command_id,
               world_id,
               dialogue_id,
               request_kind,
               model_request_id,
               response_turn_id,
               response_rule_request_id,
               prepared_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4::uuid,
               $5,
               $6::uuid,
               $7::uuid,
               $8::uuid,
               clock_timestamp()
             )`,
            [
              sessionId,
              commandId,
              worldId,
              dialogueId,
              input.requestKind,
              modelRequestId,
              responseTurnId ?? null,
              responseRuleRequestId ?? null,
            ],
          );
          if (inserted.rowCount !== 1) {
            throw new EngineFault(
              "dialogue.director_run.database_corrupt",
              "Dialogue Director run INSERT did not affect exactly one row",
              { session_id: sessionId, command_id: commandId },
            );
          }
          return Object.freeze({
            sessionId,
            commandId,
            worldId,
            dialogueId,
            requestKind: input.requestKind,
            modelRequestId,
            responseTurnId,
            responseRuleRequestId,
          });
        },
      );
    } catch (error: unknown) {
      throw normalizeRunError(error, sessionId, commandId);
    }
  }

  public async prepareProposals(input: {
    readonly run: DialogueDirectorRunRecord;
    readonly definitionProposalIds: readonly string[];
    readonly goalPlanProposalIds: readonly string[];
    readonly eventCardProposalIds: readonly string[];
  }): Promise<DialogueDirectorProposalRuns> {
    const sessionId = assertUuid(this.#contracts, input.run.sessionId);
    const commandId = assertUuid(this.#contracts, input.run.commandId);
    const expected = Object.freeze({
      definitions: input.definitionProposalIds.map((proposalId) =>
        assertUuid(this.#contracts, proposalId),
      ),
      goalPlans: input.goalPlanProposalIds.map((proposalId) =>
        assertUuid(this.#contracts, proposalId),
      ),
      eventCards: input.eventCardProposalIds.map((proposalId) =>
        assertUuid(this.#contracts, proposalId),
      ),
    });
    const allProposalIds = [
      ...expected.definitions,
      ...expected.goalPlans,
      ...expected.eventCards,
    ];
    if (new Set(allProposalIds).size !== allProposalIds.length) {
      throw new EngineFault(
        "dialogue.director_run.proposal_id_duplicate",
        "Director proposal IDs must be unique across one complete response",
        { session_id: sessionId, command_id: commandId },
      );
    }
    if (
      input.run.requestKind === "director.dialogue_events" &&
      (expected.definitions.length !== 0 ||
        expected.goalPlans.length !== 0)
    ) {
      throw new EngineFault(
        "dialogue.director_run.proposal_kind_invalid",
        "Director dialogue-events runs can own only EventCard proposals",
        { session_id: sessionId, command_id: commandId },
      );
    }

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const runRow = await readRun(
            client,
            sessionId,
            commandId,
            "FOR UPDATE",
          );
          if (runRow === undefined) {
            throw new EngineFault(
              "dialogue.director_run.missing",
              "Director proposal identities cannot be prepared before their run",
              { session_id: sessionId, command_id: commandId },
            );
          }
          validateRunRow(this.#contracts, runRow, input.run);
          const existing = await readProposalRuns(
            client,
            sessionId,
            commandId,
          );
          if (
            existing.length > 0 ||
            allProposalIds.length === 0
          ) {
            return validateProposalRows(
              this.#contracts,
              existing,
              expected,
              sessionId,
              commandId,
            );
          }

          const reserved = new Set([
            input.run.sessionId,
            input.run.commandId,
            input.run.worldId,
            input.run.dialogueId,
            input.run.modelRequestId,
            ...(input.run.responseTurnId === undefined
              ? []
              : [input.run.responseTurnId]),
            ...(input.run.responseRuleRequestId === undefined
              ? []
              : [input.run.responseRuleRequestId]),
            ...allProposalIds,
          ]);
          const insertSet = async (
            proposalKind: ProposalKind,
            proposalIds: readonly string[],
          ): Promise<void> => {
            for (const [ordinal, proposalId] of proposalIds.entries()) {
              const worldRecordId =
                proposalKind === "event_card"
                  ? undefined
                  : createGeneratedId(
                      this.#contracts,
                      this.#idFactory,
                      commandId,
                      `${proposalKind}_world_record_id[${ordinal}]`,
                    );
              if (
                worldRecordId !== undefined &&
                reserved.has(worldRecordId)
              ) {
                throw new EngineFault(
                  "dialogue.director_run.identity_collision",
                  "Director proposal WorldState identity collides with its run",
                  {
                    session_id: sessionId,
                    command_id: commandId,
                    proposal_kind: proposalKind,
                    proposal_id: proposalId,
                    world_record_id: worldRecordId,
                  },
                );
              }
              if (worldRecordId !== undefined) {
                reserved.add(worldRecordId);
              }
            const ruleRequestId = createGeneratedId(
              this.#contracts,
              this.#idFactory,
              commandId,
                `${proposalKind}_rule_request_id[${ordinal}]`,
            );
            if (reserved.has(ruleRequestId)) {
              throw new EngineFault(
                "dialogue.director_run.identity_collision",
                  "Director proposal RulePlugin identity collides with its run",
                {
                  session_id: sessionId,
                  command_id: commandId,
                    proposal_kind: proposalKind,
                  proposal_id: proposalId,
                  rule_request_id: ruleRequestId,
                },
              );
            }
            reserved.add(ruleRequestId);
            const insert = await client.query(
                `INSERT INTO luoxia_engine.dialogue_director_proposal_runs (
                 session_id,
                 command_id,
                   proposal_kind,
                 proposal_id,
                 proposal_ordinal,
                   world_record_id,
                 rule_request_id,
                 prepared_at
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                   $3,
                   $4::uuid,
                   $5::integer,
                   $6::uuid,
                   $7::uuid,
                 clock_timestamp()
               )`,
              [
                sessionId,
                commandId,
                  proposalKind,
                proposalId,
                ordinal,
                  worldRecordId ?? null,
                ruleRequestId,
              ],
            );
            if (insert.rowCount !== 1) {
              throw new EngineFault(
                "dialogue.director_run.database_corrupt",
                  "Director proposal run INSERT did not affect exactly one row",
                {
                  session_id: sessionId,
                  command_id: commandId,
                    proposal_kind: proposalKind,
                  proposal_id: proposalId,
                },
              );
            }
          }
          };
          await insertSet("definition", expected.definitions);
          await insertSet("goal_plan", expected.goalPlans);
          await insertSet("event_card", expected.eventCards);
          return validateProposalRows(
            this.#contracts,
            await readProposalRuns(client, sessionId, commandId),
            expected,
            sessionId,
            commandId,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeRunError(error, sessionId, commandId);
    }
  }
}

async function readRun(
  client: PoolClient,
  sessionId: string,
  commandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<DialogueDirectorRunRow | undefined> {
  const query = await client.query<DialogueDirectorRunRow>(
    `SELECT session_id::text AS session_id,
            command_id::text AS command_id,
            world_id::text AS world_id,
            dialogue_id::text AS dialogue_id,
            request_kind,
            model_request_id::text AS model_request_id,
            response_turn_id::text AS response_turn_id,
            response_rule_request_id::text AS response_rule_request_id
       FROM luoxia_engine.dialogue_director_runs
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      ${lockClause}`,
    [sessionId, commandId],
  );
  return requireAtMostOne(
    query.rows,
    "dialogue.director_run.database_corrupt",
    "Dialogue Director run lookup returned more than one row",
    { session_id: sessionId, command_id: commandId },
  );
}

async function lockCommandBoundary(
  client: PoolClient,
  sessionId: string,
  commandId: string,
): Promise<CommandBoundaryRow> {
  const query = await client.query<CommandBoundaryRow>(
    `SELECT command_kind,
            command_status,
            accepted_world_id::text AS accepted_world_id,
            dialogue_id::text AS dialogue_id
       FROM luoxia_engine.command_journal
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      FOR UPDATE`,
    [sessionId, commandId],
  );
  const row = requireAtMostOne(
    query.rows,
    "dialogue.director_run.database_corrupt",
    "Dialogue command lookup returned more than one row",
    { session_id: sessionId, command_id: commandId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "dialogue.director_run.command_missing",
      "Dialogue Director run cannot exist before its Command Journal row",
      { session_id: sessionId, command_id: commandId },
    );
  }
  return row;
}

function assertCommandBoundary(
  row: CommandBoundaryRow,
  expected: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly worldId: string;
    readonly dialogueId: string;
  },
): void {
  if (
    (row.command_kind !== "dialogue.start" &&
      row.command_kind !== "dialogue.continue") ||
    row.command_status !== "received" ||
    row.accepted_world_id !== expected.worldId ||
    row.dialogue_id !== expected.dialogueId
  ) {
    throw new EngineFault(
      "dialogue.director_run.command_boundary_mismatch",
      "Dialogue Director run does not match one active dialogue command",
      {
        session_id: expected.sessionId,
        command_id: expected.commandId,
        world_id: expected.worldId,
        dialogue_id: expected.dialogueId,
        command_kind: row.command_kind,
        command_status: row.command_status,
      },
    );
  }
}

function validateRunRow(
  contracts: ContractValidator,
  row: DialogueDirectorRunRow,
  expected: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly worldId: string;
    readonly dialogueId: string;
    readonly requestKind: DialogueDirectorRequestKind;
    readonly modelRequestId?: string | undefined;
    readonly responseTurnId?: string | undefined;
    readonly responseRuleRequestId?: string | undefined;
  },
): DialogueDirectorRunRecord {
  const requestKind = readRequestKind(row.request_kind);
  const modelRequestId = assertUuid(contracts, row.model_request_id);
  const responseTurnId =
    row.response_turn_id === null
      ? undefined
      : assertUuid(contracts, row.response_turn_id);
  const responseRuleRequestId =
    row.response_rule_request_id === null
      ? undefined
      : assertUuid(contracts, row.response_rule_request_id);
  if (
    assertUuid(contracts, row.session_id) !== expected.sessionId ||
    assertUuid(contracts, row.command_id) !== expected.commandId ||
    assertUuid(contracts, row.world_id) !== expected.worldId ||
    assertUuid(contracts, row.dialogue_id) !== expected.dialogueId ||
    requestKind !== expected.requestKind ||
    (requestKind === "director.dialogue_events" &&
      (responseTurnId !== undefined ||
        responseRuleRequestId !== undefined)) ||
    (requestKind === "director.system_dialogue" &&
      (responseTurnId === undefined ||
        responseRuleRequestId === undefined)) ||
    (expected.modelRequestId !== undefined &&
      modelRequestId !== expected.modelRequestId) ||
    (expected.responseTurnId !== undefined &&
      responseTurnId !== expected.responseTurnId) ||
    (expected.responseRuleRequestId !== undefined &&
      responseRuleRequestId !== expected.responseRuleRequestId)
  ) {
    throw new EngineFault(
      "dialogue.director_run.identity_conflict",
      "Persisted Dialogue Director run differs from its command identity",
      {
        session_id: expected.sessionId,
        command_id: expected.commandId,
        request_kind: expected.requestKind,
      },
    );
  }
  return Object.freeze({
    sessionId: expected.sessionId,
    commandId: expected.commandId,
    worldId: expected.worldId,
    dialogueId: expected.dialogueId,
    requestKind,
    modelRequestId,
    responseTurnId,
    responseRuleRequestId,
  });
}

async function readProposalRuns(
  client: PoolClient,
  sessionId: string,
  commandId: string,
): Promise<readonly ProposalRunRow[]> {
  const query = await client.query<ProposalRunRow>(
    `SELECT proposal_kind,
            proposal_id::text AS proposal_id,
            proposal_ordinal,
            world_record_id::text AS world_record_id,
            rule_request_id::text AS rule_request_id,
            to_char(
              prepared_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS prepared_at
       FROM luoxia_engine.dialogue_director_proposal_runs
      WHERE session_id = $1::uuid
        AND command_id = $2::uuid
      ORDER BY CASE proposal_kind
                 WHEN 'definition' THEN 0
                 WHEN 'goal_plan' THEN 1
                 WHEN 'event_card' THEN 2
                 ELSE 3
               END,
               proposal_ordinal`,
    [sessionId, commandId],
  );
  return query.rows;
}

function validateProposalRows(
  contracts: ContractValidator,
  rows: readonly ProposalRunRow[],
  expected: {
    readonly definitions: readonly string[];
    readonly goalPlans: readonly string[];
    readonly eventCards: readonly string[];
  },
  sessionId: string,
  commandId: string,
): DialogueDirectorProposalRuns {
  const expectedCount =
    expected.definitions.length +
    expected.goalPlans.length +
    expected.eventCards.length;
  if (rows.length !== expectedCount) {
    throw new EngineFault(
      "dialogue.director_run.proposal_set_conflict",
      "Persisted proposal identity count differs from the verified Director response",
      {
        session_id: sessionId,
        command_id: commandId,
        stored_count: rows.length,
        proposal_count: expectedCount,
      },
    );
  }
  const definitions: DialogueDefinitionRunRecord[] = [];
  const goalPlans: DialogueGoalPlanRunRecord[] = [];
  const eventCards: DialogueEventCardRunRecord[] = [];
  const expectedByKind: Readonly<
    Record<ProposalKind, readonly string[]>
  > = Object.freeze({
    definition: expected.definitions,
    goal_plan: expected.goalPlans,
    event_card: expected.eventCards,
  });
  const nextOrdinal: Record<ProposalKind, number> = {
    definition: 0,
    goal_plan: 0,
    event_card: 0,
  };
  for (const row of rows) {
    const proposalKind = readProposalKind(row.proposal_kind);
    const ordinal = nextOrdinal[proposalKind];
    nextOrdinal[proposalKind] = ordinal + 1;
    const expectedIds = expectedByKind[proposalKind];
      const proposalId = assertUuid(contracts, row.proposal_id);
      if (
        row.proposal_ordinal !== ordinal ||
      proposalId !== expectedIds[ordinal]
      ) {
        throw new EngineFault(
          "dialogue.director_run.proposal_set_conflict",
          "Persisted proposal identity order differs from the verified Director response",
          {
            session_id: sessionId,
            command_id: commandId,
            proposal_kind: proposalKind,
            proposal_ordinal: ordinal,
          },
        );
      }
    const ruleRequestId = assertUuid(
      contracts,
      row.rule_request_id,
    );
    const preparedAt = readPreparedAt(row.prepared_at, {
      session_id: sessionId,
      command_id: commandId,
      proposal_kind: proposalKind,
      proposal_id: proposalId,
    });
    if (proposalKind === "event_card") {
      if (row.world_record_id !== null) {
        throw proposalRowCorrupt(
          "EventCard proposal run must not own a preselected WorldState identity",
          sessionId,
          commandId,
          proposalKind,
          proposalId,
        );
      }
      eventCards.push(
        Object.freeze({
          proposalKind,
        proposalId,
        ordinal,
          ruleRequestId,
          preparedAt,
        }),
      );
      continue;
    }
    if (row.world_record_id === null) {
      throw proposalRowCorrupt(
        "Definition and GoalPlan proposal runs require a WorldState identity",
        sessionId,
        commandId,
        proposalKind,
        proposalId,
      );
    }
    const worldRecordId = assertUuid(
      contracts,
      row.world_record_id,
    );
    if (proposalKind === "definition") {
      definitions.push(
        Object.freeze({
          proposalKind,
          proposalId,
          ordinal,
          ruleRequestId,
          preparedAt,
          definitionId: worldRecordId,
        }),
      );
    } else {
      goalPlans.push(
        Object.freeze({
          proposalKind,
          proposalId,
          ordinal,
          ruleRequestId,
          preparedAt,
          planId: worldRecordId,
        }),
      );
    }
  }
  return Object.freeze({
    definitions: Object.freeze(definitions),
    goalPlans: Object.freeze(goalPlans),
    eventCards: Object.freeze(eventCards),
  });
}

function readProposalKind(value: string): ProposalKind {
  if (
    value !== "definition" &&
    value !== "goal_plan" &&
    value !== "event_card"
  ) {
    throw new EngineFault(
      "dialogue.director_run.database_corrupt",
      "Dialogue Director proposal run has an unsupported proposal kind",
      { proposal_kind: value },
    );
  }
  return value;
}

function readPreparedAt(
  value: string,
  details: Readonly<Record<string, string>>,
): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new EngineFault(
      "dialogue.director_run.database_corrupt",
      "Dialogue Director proposal prepared_at is not an RFC 3339 UTC timestamp",
      { ...details, prepared_at: value },
    );
  }
  return value;
}

function proposalRowCorrupt(
  message: string,
  sessionId: string,
  commandId: string,
  proposalKind: ProposalKind,
  proposalId: string,
): EngineFault {
  return new EngineFault(
    "dialogue.director_run.database_corrupt",
    message,
    {
      session_id: sessionId,
      command_id: commandId,
      proposal_kind: proposalKind,
      proposal_id: proposalId,
    },
  );
}

function assertDialogueCommand(
  command: StoredReceivedCommand,
  dialogueId: string,
): void {
  if (
    (command.commandKind !== "dialogue.start" &&
      command.commandKind !== "dialogue.continue") ||
    command.dialogueExecution === undefined ||
    command.dialogueExecution.dialogueId !== dialogueId
  ) {
    throw new EngineFault(
      "dialogue.director_run.command_identity_invalid",
      "Dialogue Director run requires one received dialogue command identity",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
        dialogue_id: dialogueId,
        command_kind: command.commandKind,
      },
    );
  }
}

function createGeneratedId(
  contracts: ContractValidator,
  idFactory: CommandExecutionIdFactory,
  commandId: string,
  identity: string,
): string {
  const value = assertUuid(contracts, idFactory.createId());
  if (value !== value.toLowerCase()) {
    throw new EngineFault(
      "dialogue.director_run.identity_noncanonical",
      "Server-generated Dialogue Director UUID must use lowercase canonical text",
      { command_id: commandId, identity, uuid: value },
    );
  }
  return value;
}

function readRequestKind(value: string): DialogueDirectorRequestKind {
  if (
    value !== "director.dialogue_events" &&
    value !== "director.system_dialogue"
  ) {
    throw new EngineFault(
      "dialogue.director_run.database_corrupt",
      "Dialogue Director run has an unsupported request kind",
      { request_kind: value },
    );
  }
  return value;
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeRunError(
  error: unknown,
  sessionId: string,
  commandId: string,
): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as PostgresErrorLike).code !== "string"
  ) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const postgres = error as PostgresErrorLike & { readonly code: string };
  return new EngineFault(
    "dialogue.director_run.database_error",
    "PostgreSQL rejected Dialogue Director run persistence",
    {
      session_id: sessionId,
      command_id: commandId,
      postgres_code: postgres.code,
      constraint:
        typeof postgres.constraint === "string"
          ? postgres.constraint
          : "",
      postgres_message:
        typeof postgres.message === "string" ? postgres.message : "",
    },
  );
}
