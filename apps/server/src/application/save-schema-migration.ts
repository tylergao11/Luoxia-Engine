import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
  type SaveEnvelopeDocument,
  type StoredSaveSchemaMigrationRequestDocument,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import type {
  RegisteredSaveSchemaMigrationPlan,
  SaveSchemaMigrationRegistry,
} from "./save-schema-migration-abi.js";

export interface SaveSchemaMigrationService {
  resolveImport(
    requestCandidate: unknown,
    executedAt: string,
  ): SaveEnvelopeDocument;
  validateStoredRequest(
    requestCandidate: unknown,
  ): StoredSaveSchemaMigrationRequestDocument;
  migrateStoredCandidate(
    request: StoredSaveSchemaMigrationRequestDocument,
    sourceCandidate: unknown,
    executedAt: string,
  ): SaveEnvelopeDocument;
}

export interface SaveSchemaMigrationServiceDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly registry: SaveSchemaMigrationRegistry;
  readonly currentSaveSchemaVersion: string;
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

export function createSaveSchemaMigrationService(
  dependencies: SaveSchemaMigrationServiceDependencies,
): SaveSchemaMigrationService {
  dependencies.contracts.assert(
    CONTRACT_REF.semVer,
    dependencies.currentSaveSchemaVersion,
  );
  return Object.freeze({
    resolveImport(
      requestCandidate: unknown,
      executedAt: string,
    ): SaveEnvelopeDocument {
      assertCanonicalTimestamp(executedAt);
      const request = dependencies.contracts.assertObject(
        CONTRACT_REF.saveSchemaImportRequest,
        requestCandidate,
      );
      const mode = expectString(
        request.value,
        "mode",
        "SaveSchemaImportRequest",
      );
      const saveCandidate = expectJsonObject(
        expectProperty(
          request.value,
          "save_candidate",
          "SaveSchemaImportRequest",
        ),
        "SaveSchemaImportRequest.save_candidate",
      );
      if (mode === "current") {
        const envelope = dependencies.contracts.assertObject(
          CONTRACT_REF.saveEnvelope,
          saveCandidate,
        );
        assertSaveSchemaVersion(
          envelope.value,
          dependencies.currentSaveSchemaVersion,
          "save_schema.import_current_version_mismatch",
          "Current-mode Save import must carry the deployment's exact current save_schema_version",
        );
        return envelope;
      }
      if (mode !== "migrate") {
        throw new EngineFault(
          "save_schema.import_mode_unknown",
          "Save Schema import request has an unsupported mode",
          { mode },
        );
      }
      const sourceVersion = readUntrustedSaveSchemaVersion(saveCandidate);
      const plan = dependencies.registry.requirePlan({
        planId: expectString(
          request.value,
          "plan_id",
          "SaveSchemaImportRequest",
        ),
        sourceSaveSchemaVersion: sourceVersion,
        targetSaveSchemaVersion: dependencies.currentSaveSchemaVersion,
      });
      return executePlan(dependencies, plan, saveCandidate, executedAt);
    },

    validateStoredRequest(
      requestCandidate: unknown,
    ): StoredSaveSchemaMigrationRequestDocument {
      return dependencies.contracts.assertObject(
        CONTRACT_REF.storedSaveSchemaMigrationRequest,
        requestCandidate,
      );
    },

    migrateStoredCandidate(
      request: StoredSaveSchemaMigrationRequestDocument,
      sourceCandidate: unknown,
      executedAt: string,
    ): SaveEnvelopeDocument {
      assertCanonicalTimestamp(executedAt);
      const source = expectJsonObject(
        sourceCandidate as JsonValue,
        "Stored SaveEnvelope candidate",
      );
      const sourceWorldId = expectString(
        source,
        "world_id",
        "Stored SaveEnvelope candidate",
      );
      const requestWorldId = expectString(
        request.value,
        "world_id",
        "StoredSaveSchemaMigrationRequest",
      );
      if (sourceWorldId !== requestWorldId) {
        throw new EngineFault(
          "save_schema.stored_world_mismatch",
          "Stored Save Schema migration request does not identify the locked world",
          {
            request_world_id: requestWorldId,
            source_world_id: sourceWorldId,
          },
        );
      }
      const sourceVersion = readUntrustedSaveSchemaVersion(source);
      const plan = dependencies.registry.requirePlan({
        planId: expectString(
          request.value,
          "plan_id",
          "StoredSaveSchemaMigrationRequest",
        ),
        sourceSaveSchemaVersion: sourceVersion,
        targetSaveSchemaVersion: dependencies.currentSaveSchemaVersion,
      });
      return executePlan(dependencies, plan, source, executedAt);
    },
  });
}

function executePlan(
  dependencies: SaveSchemaMigrationServiceDependencies,
  plan: RegisteredSaveSchemaMigrationPlan,
  candidate: JsonObject,
  executedAt: string,
): SaveEnvelopeDocument {
  let current: ValidatedJsonObject<string> =
    dependencies.contracts.assertObject(
      plan.steps[0]?.sourceSchemaRef ??
        failEmptyPlan(plan.planId),
      candidate,
    );

  for (const step of plan.steps) {
    const source = dependencies.contracts.assertObject(
      step.sourceSchemaRef,
      current.value,
    );
    assertSaveSchemaVersion(
      source.value,
      step.sourceSaveSchemaVersion,
      "save_schema.step_source_version_mismatch",
      "Save Schema migration step received a source document with another version",
      { migration_id: step.migrationId },
    );

    const output = step.module.migrate(source);
    if (isPromiseLike(output)) {
      throw new EngineFault(
        "save_schema.step_async_forbidden",
        "Save Schema migration modules must be synchronous and pure",
        { migration_id: step.migrationId },
      );
    }
    const preliminary = dependencies.contracts.assertObject(
      step.targetSchemaRef,
      output,
    );
    assertSaveSchemaVersion(
      preliminary.value,
      step.targetSaveSchemaVersion,
      "save_schema.step_target_version_mismatch",
      "Save Schema migration step returned a document with another target version",
      { migration_id: step.migrationId },
    );
    assertStableSaveFields(source.value, preliminary.value, step.migrationId);

    const sourceHistory = asObjectArray(
      expectProperty(
        source.value,
        "migration_history",
        "Save Schema migration source",
      ),
      "Save Schema migration source.migration_history",
    );
    const preliminaryHistory = asObjectArray(
      expectProperty(
        preliminary.value,
        "migration_history",
        "Save Schema migration target",
      ),
      "Save Schema migration target.migration_history",
    );
    if (
      sourceHistory.length !== preliminaryHistory.length ||
      !sourceHistory.every((entry, index) =>
        jsonEquals(entry, preliminaryHistory[index] as JsonObject),
      )
    ) {
      throw new EngineFault(
        "save_schema.step_history_modified",
        "A Save Schema migration module cannot edit migration_history; the Server appends the sole step entry",
        { migration_id: step.migrationId },
      );
    }

    const entryWithoutResult = Object.freeze({
      migration_kind: "save_schema",
      source: step.sourceSaveSchemaVersion,
      target: step.targetSaveSchemaVersion,
      implementation_digest: step.implementationDigest,
      executed_at: executedAt,
    });
    const digestBody = Object.freeze({
      ...preliminary.value,
      migration_history: Object.freeze([
        ...sourceHistory,
        entryWithoutResult,
      ]),
    });
    const historyEntry = dependencies.contracts.assertObject(
      CONTRACT_REF.migrationHistoryEntry,
      {
        ...entryWithoutResult,
        result_digest: dependencies.digest.sha256(digestBody),
      },
    );
    current = dependencies.contracts.assertObject(step.targetSchemaRef, {
      ...preliminary.value,
      migration_history: [...sourceHistory, historyEntry.value],
    });
  }

  const result = dependencies.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    current.value,
  );
  assertSaveSchemaVersion(
    result.value,
    dependencies.currentSaveSchemaVersion,
    "save_schema.plan_target_version_mismatch",
    "Save Schema migration plan did not produce the deployment's current version",
    { plan_id: plan.planId },
  );
  return result;
}

function assertStableSaveFields(
  source: JsonObject,
  target: JsonObject,
  migrationId: string,
): void {
  for (const field of STABLE_SAVE_FIELDS) {
    if (
      !jsonEquals(
        expectProperty(source, field, "Save Schema migration source"),
        expectProperty(target, field, "Save Schema migration target"),
      )
    ) {
      throw new EngineFault(
        "save_schema.step_stable_fact_changed",
        "Save Schema migration cannot change world, content, implementation, cursor or contract identity facts",
        { migration_id: migrationId, field },
      );
    }
  }
}

function assertSaveSchemaVersion(
  value: JsonObject,
  expected: string,
  code: string,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): void {
  const actual = expectString(
    value,
    "save_schema_version",
    "SaveEnvelope",
  );
  if (actual !== expected) {
    throw new EngineFault(code, message, {
      ...details,
      expected_save_schema_version: expected,
      actual_save_schema_version: actual,
    });
  }
}

function readUntrustedSaveSchemaVersion(candidate: JsonObject): string {
  const value = expectString(
    candidate,
    "save_schema_version",
    "Untrusted SaveEnvelope discriminator",
  );
  if (value.length > 256) {
    throw new EngineFault(
      "save_schema.source_version_invalid",
      "Untrusted SaveEnvelope save_schema_version exceeds the discriminator limit",
    );
  }
  return value;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "save_schema.history_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new EngineFault(
      "save_schema.timestamp_invalid",
      "Save Schema migration executed_at must be a canonical UTC ISO-8601 instant",
      { executed_at: value },
    );
  }
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function failEmptyPlan(planId: string): never {
  throw new EngineFault(
    "save_schema.registry.plan_empty",
    "Save Schema migration plan has no registered steps",
    { plan_id: planId },
  );
}

