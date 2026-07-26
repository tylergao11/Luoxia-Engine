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
} from "@luoxia/contracts-runtime/portable";
import type { Pool } from "pg";

import type {
  RuntimeWorldCreationRecord,
  RuntimeWorldCreator,
  RuntimeWorldRecord,
} from "../../application/runtime-persistence.js";
import {
  requireExactlyOne,
  parseSafeUnsignedInteger,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresRuntimeWorldCreatorDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

interface InsertedWorldRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
  readonly world_content_lock_document: unknown;
  readonly updated_at: Date | string;
}

export function createPostgresRuntimeWorldCreator(
  dependencies: PostgresRuntimeWorldCreatorDependencies,
): RuntimeWorldCreator {
  return Object.freeze({
    async create(
      record: RuntimeWorldCreationRecord,
    ): Promise<RuntimeWorldRecord> {
      const snapshot = dependencies.contracts.assertObject(
        CONTRACT_REF.worldSnapshot,
        record.snapshot.value,
      );
      const worldContentLock = dependencies.contracts.assertObject(
        CONTRACT_REF.worldContentLock,
        record.worldContentLock.value,
      );
      const worldId = expectString(
        snapshot.value,
        "world_id",
        "WorldSnapshot",
      );
      const revision = expectInteger(
        snapshot.value,
        "world_revision",
        "WorldSnapshot",
      );
      if (revision !== 0) {
        throw new EngineFault(
          "runtime.world_creation.revision_invalid",
          "A new world must be persisted at revision 0",
          { world_id: worldId, world_revision: revision },
        );
      }
      const worldState = expectJsonObject(
        expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
        "WorldSnapshot.world_state",
      );
      const createdAt = canonicalTimestamp(record.createdAt);

      try {
        return await withPostgresTransaction(
          dependencies.pool,
          "BEGIN ISOLATION LEVEL READ COMMITTED",
          async (client) => {
            const inserted = await client.query<InsertedWorldRow>(
              `INSERT INTO luoxia_engine.worlds (
                 world_id,
                 revision,
                 state_document,
                 world_content_lock_document,
                 updated_at
               ) VALUES (
                 $1::uuid,
                 $2::bigint,
                 $3::jsonb,
                 $4::jsonb,
                 $5::timestamptz
               )
               RETURNING
                 world_id::text AS world_id,
                 revision::text AS revision_text,
                 state_document,
                 world_content_lock_document,
                 updated_at`,
              [
                worldId,
                revision.toString(),
                JSON.stringify(worldState),
                JSON.stringify(worldContentLock.value),
                createdAt,
              ],
            );
            const row = requireExactlyOne(
              inserted.rows,
              "runtime.world_creation.database_corrupt",
              "World creation INSERT did not return exactly one row",
              { world_id: worldId },
            );
            const persistedState = dependencies.contracts.assertObject(
              CONTRACT_REF.worldState,
              row.state_document,
            );
            const persistedRevision = parseSafeUnsignedInteger(
              row.revision_text,
              "runtime.world_creation.database_corrupt",
              "Inserted world revision",
              { world_id: worldId, revision: row.revision_text },
            );
            const persistedSnapshot = dependencies.contracts.assertObject(
              CONTRACT_REF.worldSnapshot,
              {
                world_id: row.world_id,
                world_revision: persistedRevision,
                world_state: persistedState.value,
              },
            );
            const persistedLock = dependencies.contracts.assertObject(
              CONTRACT_REF.worldContentLock,
              row.world_content_lock_document,
            );
            assertInsertedWorld(
              row,
              worldId,
              revision,
              persistedRevision,
              persistedState.value,
              persistedLock.value,
              worldState,
              worldContentLock.value,
              createdAt,
            );
            return Object.freeze({
              snapshot: persistedSnapshot,
              worldContentLock: persistedLock,
            });
          },
        );
      } catch (error: unknown) {
        if (postgresErrorCode(error) === "23505") {
          throw new EngineFault(
            "runtime.world_creation.world_id_conflict",
            "Generated runtime world_id already exists",
            { world_id: worldId },
          );
        }
        throw error;
      }
    },
  });
}

function assertInsertedWorld(
  row: InsertedWorldRow,
  expectedWorldId: string,
  expectedRevision: number,
  returnedRevision: number,
  returnedState: JsonObject,
  returnedLock: JsonObject,
  expectedState: JsonObject,
  expectedLock: JsonObject,
  expectedUpdatedAt: string,
): void {
  const returnedUpdatedAt = formatDatabaseTimestamp(row.updated_at);
  if (
    row.world_id !== expectedWorldId ||
    returnedRevision !== expectedRevision ||
    !jsonEquals(returnedState, expectedState) ||
    !jsonEquals(returnedLock, expectedLock) ||
    returnedUpdatedAt !== expectedUpdatedAt
  ) {
    throw new EngineFault(
      "runtime.world_creation.database_corrupt",
      "Inserted world row does not exactly match the authorized creation record",
      {
        world_id: expectedWorldId,
        returned_world_id: row.world_id,
        world_revision: expectedRevision,
        returned_revision: row.revision_text,
      },
    );
  }
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new EngineFault(
      "runtime.world_creation.created_at_invalid",
      "World creation timestamp must be a canonical UTC ISO-8601 instant",
      { created_at: value },
    );
  }
  return value;
}

function formatDatabaseTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new EngineFault(
      "runtime.world_creation.database_corrupt",
      "PostgreSQL returned an invalid world updated_at timestamp",
      {},
    );
  }
  return date.toISOString();
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
