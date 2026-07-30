import {
  CONTRACT_REF,
  EngineFault,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
  type SaveEnvelopeDocument,
} from "@luoxia/contracts-runtime";
import type { Pool } from "pg";

import type { RuntimeSaveMigrationRepository } from "../../application/runtime-persistence.js";
import { assertSaveEnvelopeRelationships } from "../../application/runtime-save.js";
import {
  requireAtMostOne,
  requireExactlyOne,
  withPostgresTransaction,
} from "./persistence-support.js";
import {
  assembleSaveEnvelope,
  assembleSaveEnvelopeCandidate,
  selectSaveWorldColumns,
  type SaveWorldRow,
} from "./runtime-save-repository.js";

export interface PostgresRuntimeSaveMigrationRepositoryDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

const STABLE_SAVE_FIELDS = Object.freeze([
  "contract_version",
  "record_type",
  "world_id",
  "world_revision",
  "event_cursor",
  "engine_contract_version",
  "world_state",
  "world_content_lock",
  "dependency_bundle_locks",
  "rule_plugin_locks",
  "stage_module_locks",
] as const);

export function createPostgresRuntimeSaveMigrationRepository(
  dependencies: PostgresRuntimeSaveMigrationRepositoryDependencies,
): RuntimeSaveMigrationRepository {
  return Object.freeze({
    async migrateLocked(
      worldId: string,
      migratedAt: string,
      migrate: (sourceCandidate: unknown) => SaveEnvelopeDocument,
    ): Promise<unknown> {
      dependencies.contracts.assert(CONTRACT_REF.uuid, worldId);
      const timestamp = canonicalTimestamp(migratedAt);
      return withPostgresTransaction(
        dependencies.pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const locked = await client.query<SaveWorldRow>(
            `${selectSaveWorldColumns()}
               FROM luoxia_engine.worlds
              WHERE world_id = $1::uuid
              FOR UPDATE`,
            [worldId],
          );
          const row = requireAtMostOne(
            locked.rows,
            "save_schema.persistence.database_corrupt",
            "Stored Save Schema migration lookup returned more than one world row",
            { world_id: worldId },
          );
          if (row === undefined) {
            throw new EngineFault(
              "save_schema.persistence.world_missing",
              "Stored Save Schema migration requires an existing world",
              { world_id: worldId },
            );
          }
          const source = assembleSaveEnvelopeCandidate(row);
          const target = dependencies.contracts.assertObject(
            CONTRACT_REF.saveEnvelope,
            migrate(source).value,
          );
          assertSaveEnvelopeRelationships(dependencies.contracts, target);
          assertStableFacts(source, target.value, worldId);

          const updated = await client.query<SaveWorldRow>(
            `UPDATE luoxia_engine.worlds
                SET save_schema_version = $2::text,
                    migration_history_document = $3::jsonb,
                    updated_at = $4::timestamptz
              WHERE world_id = $1::uuid
                AND revision = $5::bigint
              RETURNING
                world_id::text AS world_id,
                revision::text AS revision_text,
                state_document,
                world_content_lock_document,
                save_schema_version,
                engine_contract_version,
                dependency_bundle_locks_document,
                rule_plugin_locks_document,
                stage_module_locks_document,
                event_log_floor_revision::text
                  AS event_log_floor_revision_text,
                migration_history_document,
                updated_at`,
            [
              worldId,
              expectString(
                target.value,
                "save_schema_version",
                "SaveEnvelope",
              ),
              JSON.stringify(
                expectProperty(
                  target.value,
                  "migration_history",
                  "SaveEnvelope",
                ),
              ),
              timestamp,
              expectProperty(source, "world_revision", "SaveEnvelope"),
            ],
          );
          const stored = assembleSaveEnvelope(
            dependencies.contracts,
            requireExactlyOne(
              updated.rows,
              "save_schema.persistence.database_corrupt",
              "Stored Save Schema migration update did not return exactly one world row",
              { world_id: worldId },
            ),
          );
          if (!jsonEquals(stored.value, target.value)) {
            throw new EngineFault(
              "save_schema.persistence.reassembly_mismatch",
              "PostgreSQL reassembled a SaveEnvelope different from the authorized schema migration result",
              { world_id: worldId },
            );
          }
          return stored.value;
        },
      );
    },
  });
}

function assertStableFacts(
  source: JsonObject,
  target: JsonObject,
  worldId: string,
): void {
  for (const field of STABLE_SAVE_FIELDS) {
    if (
      !jsonEquals(
        expectProperty(source, field, "Stored SaveEnvelope source"),
        expectProperty(target, field, "Stored SaveEnvelope target"),
      )
    ) {
      throw new EngineFault(
        "save_schema.persistence.stable_fact_changed",
        "Stored Save Schema migration attempted to change an immutable world or lock fact",
        { world_id: worldId, field },
      );
    }
  }
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new EngineFault(
      "save_schema.persistence.timestamp_invalid",
      "Stored Save Schema migration timestamp must be a canonical UTC ISO-8601 instant",
      { migrated_at: value },
    );
  }
  return value;
}

