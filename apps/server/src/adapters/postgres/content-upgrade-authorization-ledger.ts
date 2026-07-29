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
  type UpgradeAuthorizationDocument,
} from "@luoxia/contracts-runtime/portable";
import type { ContentUpgradeAuthorizationRecord } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

import type {
  ContentUpgradeAuthorizationLedger,
  StoredContentUpgradeAuthorization,
} from "../../application/runtime-persistence.js";
import {
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  requireExactlyOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresContentUpgradeAuthorizationLedgerDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

interface AuthorizationRow {
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
}

interface CommitReadyRow extends AuthorizationRow {
  readonly request_document: unknown;
  readonly response_document: unknown;
}

export function createPostgresContentUpgradeAuthorizationLedger(
  dependencies: PostgresContentUpgradeAuthorizationLedgerDependencies,
): ContentUpgradeAuthorizationLedger {
  return new PostgresContentUpgradeAuthorizationLedger(dependencies);
}

class PostgresContentUpgradeAuthorizationLedger
  implements ContentUpgradeAuthorizationLedger
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;

  public constructor(
    dependencies: PostgresContentUpgradeAuthorizationLedgerDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
  }

  public async persistAuthorized(input: {
    readonly sessionId: string;
    readonly clientCommandId: string;
    readonly ruleRequestId: string;
    readonly authorization: UpgradeAuthorizationDocument;
  }): Promise<StoredContentUpgradeAuthorization> {
    const sessionId = assertUuid(this.#contracts, input.sessionId);
    const clientCommandId = assertUuid(
      this.#contracts,
      input.clientCommandId,
    );
    const ruleRequestId = assertUuid(this.#contracts, input.ruleRequestId);
    const authorization = this.#contracts.assertObject(
      CONTRACT_REF.upgradeAuthorization,
      input.authorization.value,
    );
    const value = authorization.value;
    const upgradeCommandId = expectString(
      value,
      "upgrade_command_id",
      "UpgradeAuthorization",
    );
    const worldId = expectString(value, "world_id", "UpgradeAuthorization");
    const migrationId = expectString(
      value,
      "migration_id",
      "UpgradeAuthorization",
    );
    const sourceWorldRevision = expectInteger(
      value,
      "source_world_revision",
      "UpgradeAuthorization",
    );
    const sourceSaveDigest = expectString(
      value,
      "source_save_digest",
      "UpgradeAuthorization",
    );
    const authorizationDigest = expectString(
      value,
      "authorization_digest",
      "UpgradeAuthorization",
    );
    this.#contracts.assert(CONTRACT_REF.sha256, sourceSaveDigest);
    this.#contracts.assert(CONTRACT_REF.sha256, authorizationDigest);

    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        await client.query(
          `INSERT INTO luoxia_engine.content_upgrade_authorizations (
             upgrade_command_id,
             session_id,
             client_command_id,
             rule_request_id,
             world_id,
             migration_id,
             source_world_revision,
             source_save_digest,
             authorization_digest,
             authorization_document,
             authorization_status,
             created_at,
             updated_at
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4::uuid,
             $5::uuid,
             $6::text,
             $7::bigint,
             $8::text,
             $9::text,
             $10::jsonb,
             'authorized',
             clock_timestamp(),
             clock_timestamp()
           )
           ON CONFLICT (upgrade_command_id) DO NOTHING`,
          [
            upgradeCommandId,
            sessionId,
            clientCommandId,
            ruleRequestId,
            worldId,
            migrationId,
            sourceWorldRevision.toString(),
            sourceSaveDigest,
            authorizationDigest,
            JSON.stringify(value),
          ],
        );
        const row = requireExactlyOne(
          (
            await client.query<AuthorizationRow>(
              `${AUTHORIZATION_SELECT}
                FROM luoxia_engine.content_upgrade_authorizations
                  AS authorization
                WHERE upgrade_command_id = $1::uuid
                FOR UPDATE`,
              [upgradeCommandId],
            )
          ).rows,
          "content_upgrade.ledger.database_corrupt",
          "Content Upgrade authorization lookup did not return exactly one row",
          { upgrade_command_id: upgradeCommandId },
        );
        const stored = validateAuthorizationRow(this.#contracts, row);
        if (
          stored.sessionId !== sessionId ||
          stored.clientCommandId !== clientCommandId ||
          stored.ruleRequestId !== ruleRequestId ||
          !jsonEquals(stored.authorization.value, value)
        ) {
          throw new EngineFault(
            "content_upgrade.ledger.authorization_conflict",
            "Content Upgrade command identity is already bound to a different authorization",
            { upgrade_command_id: upgradeCommandId },
          );
        }
        return stored;
      },
    );
  }

  public async markCommitReady(input: {
    readonly upgradeCommandId: string;
    readonly resultDigest: string;
  }): Promise<StoredContentUpgradeAuthorization> {
    const upgradeCommandId = assertUuid(
      this.#contracts,
      input.upgradeCommandId,
    );
    const resultDigest = this.#contracts.assert(
      CONTRACT_REF.sha256,
      input.resultDigest,
    ).value as string;
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const existing = await readAuthorizationRow(
          client,
          upgradeCommandId,
          "FOR UPDATE",
        );
        if (existing === undefined) {
          throw new EngineFault(
            "content_upgrade.ledger.authorization_missing",
            "Content Upgrade cannot become commit-ready before authorization is persisted",
            { upgrade_command_id: upgradeCommandId },
          );
        }
        const stored = validateAuthorizationRow(this.#contracts, existing);
        if (stored.phase === "commit_ready") {
          if (stored.resultDigest !== resultDigest) {
            throw new EngineFault(
              "content_upgrade.ledger.result_conflict",
              "Content Upgrade authorization is already bound to another transformer result",
              { upgrade_command_id: upgradeCommandId },
            );
          }
          return stored;
        }

        const invocation = await client.query<{
          readonly invocation_status: string;
          readonly operation_kind: string;
          readonly response_document: unknown | null;
        }>(
          `SELECT invocation_status, operation_kind, response_document
             FROM luoxia_engine.rule_plugin_invocations
            WHERE request_id = $1::uuid`,
          [stored.ruleRequestId],
        );
        const invocationRow = requireExactlyOne(
          invocation.rows,
          "content_upgrade.ledger.invocation_missing",
          "Content Upgrade transformer invocation is not durably resolved",
          {
            upgrade_command_id: upgradeCommandId,
            rule_request_id: stored.ruleRequestId,
          },
        );
        if (
          invocationRow.invocation_status !== "resolved" ||
          invocationRow.operation_kind !== "content_upgrade.transform" ||
          invocationRow.response_document === null
        ) {
          throw new EngineFault(
            "content_upgrade.ledger.invocation_not_ready",
            "Content Upgrade transformer invocation is not a resolved content_upgrade.transform result",
            {
              upgrade_command_id: upgradeCommandId,
              rule_request_id: stored.ruleRequestId,
            },
          );
        }
        const response = this.#contracts.assertObject(
          CONTRACT_REF.rulePluginResponse,
          invocationRow.response_document,
        ).value;
        const output = expectJsonObject(
          expectProperty(response, "output", "RulePluginResponse"),
          "RulePluginResponse.output",
        );
        if (
          expectString(output, "output_kind", "RulePluginResponse.output") !==
            "content_upgrade.candidate" ||
          expectString(output, "result_digest", "ContentUpgradeOutput") !==
            resultDigest
        ) {
          throw new EngineFault(
            "content_upgrade.ledger.result_conflict",
            "Commit-ready digest differs from the resolved transformer output",
            {
              upgrade_command_id: upgradeCommandId,
              rule_request_id: stored.ruleRequestId,
            },
          );
        }

        const update = await client.query(
          `UPDATE luoxia_engine.content_upgrade_authorizations
              SET authorization_status = 'commit_ready',
                  result_digest = $2::text,
                  updated_at = clock_timestamp()
            WHERE upgrade_command_id = $1::uuid
              AND authorization_status = 'authorized'`,
          [upgradeCommandId, resultDigest],
        );
        if (update.rowCount !== 1) {
          throw new EngineFault(
            "content_upgrade.ledger.stage_conflict",
            "Content Upgrade authorization phase changed before commit-ready transition",
            { upgrade_command_id: upgradeCommandId },
          );
        }
        const ready = await readAuthorizationRow(
          client,
          upgradeCommandId,
          "",
        );
        return validateAuthorizationRow(
          this.#contracts,
          requireValue(
            ready,
            "content_upgrade.ledger.database_corrupt",
            "Commit-ready authorization disappeared after update",
            { upgrade_command_id: upgradeCommandId },
          ),
        );
      },
    );
  }

  public async readByUpgradeCommandId(
    upgradeCommandId: string,
  ): Promise<StoredContentUpgradeAuthorization | undefined> {
    const identity = assertUuid(this.#contracts, upgradeCommandId);
    return withPostgresClient(this.#pool, async (client) => {
      const row = await readAuthorizationRow(client, identity, "");
      return row === undefined
        ? undefined
        : validateAuthorizationRow(this.#contracts, row);
    });
  }

  public async findByUpgradeCommandId(
    upgradeCommandId: string,
  ): Promise<ContentUpgradeAuthorizationRecord | undefined> {
    const identity = assertUuid(this.#contracts, upgradeCommandId);
    return withPostgresClient(this.#pool, async (client) => {
      const query = await client.query<CommitReadyRow>(
        `${AUTHORIZATION_SELECT},
                invocation.request_document,
                invocation.response_document
           FROM luoxia_engine.content_upgrade_authorizations AS authorization
           JOIN luoxia_engine.rule_plugin_invocations AS invocation
             ON invocation.request_id = authorization.rule_request_id
          WHERE authorization.upgrade_command_id = $1::uuid
            AND authorization.authorization_status = 'commit_ready'
            AND invocation.invocation_status = 'resolved'
            AND invocation.operation_kind = 'content_upgrade.transform'`,
        [identity],
      );
      const row = requireAtMostOne(
        query.rows,
        "content_upgrade.ledger.database_corrupt",
        "Commit-ready Content Upgrade lookup returned more than one row",
        { upgrade_command_id: identity },
      );
      if (row === undefined) {
        return undefined;
      }
      const stored = validateAuthorizationRow(this.#contracts, row);
      if (stored.phase !== "commit_ready" || stored.resultDigest === undefined) {
        throw new EngineFault(
          "content_upgrade.ledger.database_corrupt",
          "Commit-ready lookup returned a non-ready authorization",
          { upgrade_command_id: identity },
        );
      }
      const request = this.#contracts.assertObject(
        CONTRACT_REF.rulePluginRequest,
        row.request_document,
      );
      const response = this.#contracts.assertObject(
        CONTRACT_REF.rulePluginResponse,
        row.response_document,
      );
      assertCommitReadyJoin(stored, request.value, response.value);
      return Object.freeze({
        authorization: stored.authorization.value,
        request: request.value,
        response: response.value,
      });
    });
  }
}

const AUTHORIZATION_SELECT = `SELECT
  authorization.upgrade_command_id::text AS upgrade_command_id,
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
  authorization.result_digest`;

async function readAuthorizationRow(
  client: PoolClient,
  upgradeCommandId: string,
  lockClause: "" | "FOR UPDATE",
): Promise<AuthorizationRow | undefined> {
  const query = await client.query<AuthorizationRow>(
    `${AUTHORIZATION_SELECT}
       FROM luoxia_engine.content_upgrade_authorizations AS authorization
      WHERE authorization.upgrade_command_id = $1::uuid
      ${lockClause}`,
    [upgradeCommandId],
  );
  return requireAtMostOne(
    query.rows,
    "content_upgrade.ledger.database_corrupt",
    "Content Upgrade authorization identity lookup returned more than one row",
    { upgrade_command_id: upgradeCommandId },
  );
}

function validateAuthorizationRow(
  contracts: ContractValidator,
  row: AuthorizationRow,
): StoredContentUpgradeAuthorization {
  const authorization = contracts.assertObject(
    CONTRACT_REF.upgradeAuthorization,
    row.authorization_document,
  );
  const value = authorization.value;
  const sourceWorldRevision = parseSafeUnsignedInteger(
    row.source_world_revision_text,
    "content_upgrade.ledger.database_corrupt",
    "Content Upgrade source world revision",
    {
      upgrade_command_id: row.upgrade_command_id,
      source_world_revision: row.source_world_revision_text,
    },
  );
  if (
    expectString(value, "upgrade_command_id", "UpgradeAuthorization") !==
      row.upgrade_command_id ||
    expectString(value, "world_id", "UpgradeAuthorization") !==
      row.world_id ||
    expectString(value, "migration_id", "UpgradeAuthorization") !==
      row.migration_id ||
    expectInteger(
      value,
      "source_world_revision",
      "UpgradeAuthorization",
    ) !== sourceWorldRevision ||
    expectString(
      value,
      "source_save_digest",
      "UpgradeAuthorization",
    ) !== row.source_save_digest ||
    expectString(
      value,
      "authorization_digest",
      "UpgradeAuthorization",
    ) !== row.authorization_digest
  ) {
    throw new EngineFault(
      "content_upgrade.ledger.database_corrupt",
      "Content Upgrade authorization columns differ from their validated document",
      { upgrade_command_id: row.upgrade_command_id },
    );
  }
  const phase =
    row.authorization_status === "authorized"
      ? "authorized"
      : row.authorization_status === "commit_ready"
        ? "commit_ready"
        : undefined;
  if (
    phase === undefined ||
    (phase === "authorized" && row.result_digest !== null) ||
    (phase === "commit_ready" && row.result_digest === null)
  ) {
    throw new EngineFault(
      "content_upgrade.ledger.database_corrupt",
      "Content Upgrade authorization has an invalid persisted phase",
      {
        upgrade_command_id: row.upgrade_command_id,
        authorization_status: row.authorization_status,
      },
    );
  }
  if (row.result_digest !== null) {
    contracts.assert(CONTRACT_REF.sha256, row.result_digest);
  }
  return Object.freeze({
    phase,
    sessionId: assertUuid(contracts, row.session_id),
    clientCommandId: assertUuid(contracts, row.client_command_id),
    ruleRequestId: assertUuid(contracts, row.rule_request_id),
    authorization,
    ...(row.result_digest === null
      ? {}
      : { resultDigest: row.result_digest }),
  });
}

function assertCommitReadyJoin(
  stored: StoredContentUpgradeAuthorization,
  request: JsonObject,
  response: JsonObject,
): void {
  const input = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  if (
    expectString(request, "request_id", "RulePluginRequest") !==
      stored.ruleRequestId ||
    expectString(response, "request_id", "RulePluginResponse") !==
      stored.ruleRequestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "content_upgrade.transform" ||
    expectString(response, "operation_kind", "RulePluginResponse") !==
      "content_upgrade.transform" ||
    expectString(output, "output_kind", "ContentUpgradeOutput") !==
      "content_upgrade.candidate" ||
    expectString(output, "result_digest", "ContentUpgradeOutput") !==
      stored.resultDigest ||
    !jsonEquals(
      expectProperty(input, "authorization", "ContentUpgradeInput"),
      stored.authorization.value,
    )
  ) {
    throw new EngineFault(
      "content_upgrade.ledger.database_corrupt",
      "Commit-ready authorization does not match its resolved RulePlugin invocation",
      {
        upgrade_command_id: expectString(
          stored.authorization.value,
          "upgrade_command_id",
          "UpgradeAuthorization",
        ),
      },
    );
  }
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
