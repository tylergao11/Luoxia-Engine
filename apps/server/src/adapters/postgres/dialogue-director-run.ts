import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
} from "@luoxia/contracts-runtime";
import type { Pool, PoolClient } from "pg";

import type {
  CommandExecutionIdFactory,
  StoredReceivedCommand,
} from "../../application/command-journal.js";
import {
  dialogueDirectorProposalKind,
  type DialogueDefinitionRunRecord,
  type DialogueDirectorRequestKind,
  type DialogueDirectorProposalRuns,
  type DialogueDirectorRunJournal,
  type DialogueDirectorRunRecord,
  type DialogueEventCardRunRecord,
  type DialogueGoalPlanRunRecord,
  type DialogueDirectorProposalKind,
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

interface ModelInvocationProposalSourceRow {
  readonly invocation_status: string;
  readonly response_document: unknown | null;
}

interface ProposalRunRow {
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
            input.requestKind,
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
            input.requestKind,
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
  }): Promise<DialogueDirectorProposalRuns> {
    const sessionId = assertUuid(this.#contracts, input.run.sessionId);
    const commandId = assertUuid(this.#contracts, input.run.commandId);
    const proposalKind = dialogueDirectorProposalKind(input.run.requestKind);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const runRow = await readRun(
            client,
            sessionId,
            commandId,
            input.run.requestKind,
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
          const verifiedProposalCount =
            await readVerifiedProposalCount(
              client,
              this.#contracts,
              input.run,
            );
          const existing = await readProposalRuns(
            client,
            sessionId,
            commandId,
            input.run.requestKind,
          );
          if (existing.length > 0 || verifiedProposalCount === 0) {
            return validateProposalRows(
              this.#contracts,
              existing,
              proposalKind,
              verifiedProposalCount,
              sessionId,
              commandId,
            );
          }
          if (proposalKind === undefined) {
            throw new EngineFault(
              "dialogue.director_run.proposal_kind_invalid",
              "Proposal-producing Director run kind is missing",
              {
                session_id: sessionId,
                command_id: commandId,
                request_kind: input.run.requestKind,
              },
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
          ]);
          for (
            let ordinal = 0;
            ordinal < verifiedProposalCount;
            ordinal += 1
          ) {
            const proposalId = createGeneratedId(
              this.#contracts,
              this.#idFactory,
              commandId,
              `${input.run.requestKind}.proposal_id[${ordinal}]`,
            );
            const worldRecordId =
              proposalKind === "event_card"
                ? undefined
                : createGeneratedId(
                    this.#contracts,
                    this.#idFactory,
                    commandId,
                    `${input.run.requestKind}.world_record_id[${ordinal}]`,
                  );
            const ruleRequestId = createGeneratedId(
              this.#contracts,
              this.#idFactory,
              commandId,
              `${input.run.requestKind}.rule_request_id[${ordinal}]`,
            );
            for (const [identity, value] of [
              ["proposal_id", proposalId],
              ...(worldRecordId === undefined
                ? []
                : [["world_record_id", worldRecordId] as const]),
              ["rule_request_id", ruleRequestId],
            ] as const) {
              if (reserved.has(value)) {
                throw new EngineFault(
                  "dialogue.director_run.identity_collision",
                  "Director proposal identity collides with its run",
                  {
                    session_id: sessionId,
                    command_id: commandId,
                    request_kind: input.run.requestKind,
                    proposal_kind: proposalKind,
                    identity,
                    uuid: value,
                  },
                );
              }
              reserved.add(value);
            }
            const insert = await client.query(
              `INSERT INTO luoxia_engine.dialogue_director_proposal_runs (
                 session_id,
                 command_id,
                 request_kind,
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
                input.run.requestKind,
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
                  request_kind: input.run.requestKind,
                  proposal_kind: proposalKind,
                  proposal_id: proposalId,
                },
              );
            }
          }
          return validateProposalRows(
            this.#contracts,
            await readProposalRuns(
              client,
              sessionId,
              commandId,
              input.run.requestKind,
            ),
            proposalKind,
            verifiedProposalCount,
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
  requestKind: DialogueDirectorRequestKind,
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
        AND request_kind = $3
      ${lockClause}`,
    [sessionId, commandId, requestKind],
  );
  return requireAtMostOne(
    query.rows,
    "dialogue.director_run.database_corrupt",
    "Dialogue Director run lookup returned more than one row",
    {
      session_id: sessionId,
      command_id: commandId,
      request_kind: requestKind,
    },
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
    (requestKind !== "director.system_dialogue" &&
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

async function readVerifiedProposalCount(
  client: PoolClient,
  contracts: ContractValidator,
  run: DialogueDirectorRunRecord,
): Promise<number> {
  const query =
    await client.query<ModelInvocationProposalSourceRow>(
      `SELECT invocation_status,
              response_document
         FROM luoxia_engine.model_invocations
        WHERE request_id = $1::uuid
          AND world_id = $2::uuid
          AND request_kind = $3
        FOR SHARE`,
      [run.modelRequestId, run.worldId, run.requestKind],
    );
  const row = requireAtMostOne(
    query.rows,
    "dialogue.director_run.database_corrupt",
    "Director model request lookup returned more than one invocation",
    {
      session_id: run.sessionId,
      command_id: run.commandId,
      request_kind: run.requestKind,
      model_request_id: run.modelRequestId,
    },
  );
  if (
    row === undefined ||
    row.invocation_status !== "verified" ||
    row.response_document === null
  ) {
    throw new EngineFault(
      "dialogue.director_run.response_not_verified",
      "Director proposal identities require a verified model response",
      {
        session_id: run.sessionId,
        command_id: run.commandId,
        request_kind: run.requestKind,
        model_request_id: run.modelRequestId,
        invocation_status: row?.invocation_status ?? null,
      },
    );
  }

  const response = contracts.assertObject(
    CONTRACT_REF.modelResponse,
    row.response_document,
  ).value;
  const responseKind = expectString(
    response,
    "request_kind",
    "ModelResponse",
  );
  const output = expectJsonObject(
    expectProperty(response, "output", "ModelResponse"),
    "ModelResponse.output",
  );
  const outputKind = expectString(
    output,
    "output_kind",
    "ModelOutput",
  );
  if (
    responseKind !== run.requestKind ||
    outputKind !== run.requestKind
  ) {
    throw new EngineFault(
      "dialogue.director_run.response_kind_mismatch",
      "Verified Director response does not match its persisted run kind",
      {
        session_id: run.sessionId,
        command_id: run.commandId,
        request_kind: run.requestKind,
        response_kind: responseKind,
        output_kind: outputKind,
      },
    );
  }

  switch (run.requestKind) {
    case "director.dialogue_events": {
      const eventCards = expectProperty(
        output,
        "event_cards",
        "DirectorDialogueEventsOutput",
      );
      if (!Array.isArray(eventCards)) {
        throw new EngineFault(
          "dialogue.director_run.response_corrupt",
          "Verified Dialogue Events output must contain an event_cards array",
          {
            session_id: run.sessionId,
            command_id: run.commandId,
            model_request_id: run.modelRequestId,
          },
        );
      }
      return eventCards.length;
    }
    case "director.goal_plan":
    case "director.definition_draft":
      return 1;
    case "director.system_dialogue":
      return 0;
  }
}

async function readProposalRuns(
  client: PoolClient,
  sessionId: string,
  commandId: string,
  requestKind: DialogueDirectorRequestKind,
): Promise<readonly ProposalRunRow[]> {
  const query = await client.query<ProposalRunRow>(
    `SELECT proposal_id::text AS proposal_id,
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
        AND request_kind = $3
      ORDER BY proposal_ordinal`,
    [sessionId, commandId, requestKind],
  );
  return query.rows;
}

function validateProposalRows(
  contracts: ContractValidator,
  rows: readonly ProposalRunRow[],
  expectedKind: DialogueDirectorProposalKind | undefined,
  expectedCount: number,
  sessionId: string,
  commandId: string,
): DialogueDirectorProposalRuns {
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
  for (const [ordinal, row] of rows.entries()) {
    const proposalId = assertUuid(contracts, row.proposal_id);
    if (
      expectedKind === undefined ||
      row.proposal_ordinal !== ordinal
    ) {
      throw new EngineFault(
        "dialogue.director_run.proposal_set_conflict",
        "Persisted proposal identity order differs from the operation-specific Director response",
        {
          session_id: sessionId,
          command_id: commandId,
          expected_proposal_kind: expectedKind ?? null,
          proposal_ordinal: ordinal,
        },
      );
    }
    const proposalKind = expectedKind;
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
  proposalKind: DialogueDirectorProposalKind,
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
    value !== "director.system_dialogue" &&
    value !== "director.goal_plan" &&
    value !== "director.definition_draft"
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
