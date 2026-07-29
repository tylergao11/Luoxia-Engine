import {
  CONTRACT_REF,
  EngineFault,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonValue,
  type SaveSchemaMigrationModuleManifestDocument,
  type SaveSchemaMigrationPlanDocument,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

/**
 * Trusted, synchronous and pure Save Schema migration module. The manifest and
 * every input/output document still cross the formal SchemaRegistry boundary.
 */
export interface SaveSchemaMigrationModuleV1 {
  readonly manifest: unknown;
  migrate(
    source: ValidatedJsonObject<string>,
  ): unknown;
}

export interface RegisteredSaveSchemaMigrationModule {
  readonly module: SaveSchemaMigrationModuleV1;
  readonly manifest: SaveSchemaMigrationModuleManifestDocument;
  readonly migrationId: string;
  readonly sourceSaveSchemaVersion: string;
  readonly targetSaveSchemaVersion: string;
  readonly sourceSchemaRef: string;
  readonly targetSchemaRef: string;
  readonly implementationDigest: string;
}

export interface RegisteredSaveSchemaMigrationPlan {
  readonly plan: SaveSchemaMigrationPlanDocument;
  readonly planId: string;
  readonly sourceSaveSchemaVersion: string;
  readonly targetSaveSchemaVersion: string;
  readonly steps: readonly RegisteredSaveSchemaMigrationModule[];
}

export interface SaveSchemaMigrationRegistry {
  requirePlan(input: {
    readonly planId: string;
    readonly sourceSaveSchemaVersion: string;
    readonly targetSaveSchemaVersion: string;
  }): RegisteredSaveSchemaMigrationPlan;
}

export interface SaveSchemaMigrationRegistryDependencies {
  readonly contracts: ContractValidator;
  readonly modules: readonly SaveSchemaMigrationModuleV1[];
  readonly planCandidates: readonly unknown[];
  readonly currentSaveSchemaVersion: string;
}

export function createSaveSchemaMigrationRegistry(
  dependencies: SaveSchemaMigrationRegistryDependencies,
): SaveSchemaMigrationRegistry {
  return new DefaultSaveSchemaMigrationRegistry(dependencies);
}

class DefaultSaveSchemaMigrationRegistry
  implements SaveSchemaMigrationRegistry
{
  readonly #plansById = new Map<
    string,
    RegisteredSaveSchemaMigrationPlan
  >();

  public constructor(dependencies: SaveSchemaMigrationRegistryDependencies) {
    dependencies.contracts.assert(
      CONTRACT_REF.semVer,
      dependencies.currentSaveSchemaVersion,
    );
    const modulesById = registerModules(
      dependencies.contracts,
      dependencies.modules,
    );
    for (const candidate of dependencies.planCandidates) {
      const registered = registerPlan(
        dependencies.contracts,
        candidate,
        modulesById,
        dependencies.currentSaveSchemaVersion,
      );
      if (this.#plansById.has(registered.planId)) {
        throw new EngineFault(
          "save_schema.registry.plan_duplicate",
          "A Save Schema migration plan_id is registered more than once",
          { plan_id: registered.planId },
        );
      }
      this.#plansById.set(registered.planId, registered);
    }
  }

  public requirePlan(input: {
    readonly planId: string;
    readonly sourceSaveSchemaVersion: string;
    readonly targetSaveSchemaVersion: string;
  }): RegisteredSaveSchemaMigrationPlan {
    const plan = this.#plansById.get(input.planId);
    if (plan === undefined) {
      throw new EngineFault(
        "save_schema.registry.plan_missing",
        "The explicitly selected Save Schema migration plan is not registered",
        { plan_id: input.planId },
      );
    }
    if (
      plan.sourceSaveSchemaVersion !== input.sourceSaveSchemaVersion ||
      plan.targetSaveSchemaVersion !== input.targetSaveSchemaVersion
    ) {
      throw new EngineFault(
        "save_schema.registry.plan_version_mismatch",
        "The explicitly selected Save Schema migration plan does not match the requested source and target versions",
        {
          plan_id: input.planId,
          requested_source_save_schema_version:
            input.sourceSaveSchemaVersion,
          requested_target_save_schema_version:
            input.targetSaveSchemaVersion,
          plan_source_save_schema_version: plan.sourceSaveSchemaVersion,
          plan_target_save_schema_version: plan.targetSaveSchemaVersion,
        },
      );
    }
    return plan;
  }
}

function registerModules(
  contracts: ContractValidator,
  modules: readonly SaveSchemaMigrationModuleV1[],
): ReadonlyMap<string, RegisteredSaveSchemaMigrationModule> {
  const modulesById = new Map<
    string,
    RegisteredSaveSchemaMigrationModule
  >();
  for (const module of modules) {
    if (
      typeof module !== "object" ||
      module === null ||
      typeof module.migrate !== "function"
    ) {
      throw new EngineFault(
        "save_schema.registry.module_invalid",
        "A Save Schema migration module must expose one synchronous migrate function",
      );
    }
    const manifest = contracts.assertObject(
      CONTRACT_REF.saveSchemaMigrationModuleManifest,
      module.manifest,
    );
    const value = manifest.value;
    const migrationId = expectString(
      value,
      "migration_id",
      "SaveSchemaMigrationModuleManifest",
    );
    const sourceSaveSchemaVersion = expectString(
      value,
      "source_save_schema_version",
      "SaveSchemaMigrationModuleManifest",
    );
    const targetSaveSchemaVersion = expectString(
      value,
      "target_save_schema_version",
      "SaveSchemaMigrationModuleManifest",
    );
    if (sourceSaveSchemaVersion === targetSaveSchemaVersion) {
      throw new EngineFault(
        "save_schema.registry.module_version_unchanged",
        "A Save Schema migration module must change save_schema_version",
        {
          migration_id: migrationId,
          save_schema_version: sourceSaveSchemaVersion,
        },
      );
    }
    if (modulesById.has(migrationId)) {
      throw new EngineFault(
        "save_schema.registry.module_duplicate",
        "A Save Schema migration_id is registered more than once",
        { migration_id: migrationId },
      );
    }
    modulesById.set(
      migrationId,
      Object.freeze({
        module,
        manifest,
        migrationId,
        sourceSaveSchemaVersion,
        targetSaveSchemaVersion,
        sourceSchemaRef: expectString(
          value,
          "source_schema_ref",
          "SaveSchemaMigrationModuleManifest",
        ),
        targetSchemaRef: expectString(
          value,
          "target_schema_ref",
          "SaveSchemaMigrationModuleManifest",
        ),
        implementationDigest: expectString(
          value,
          "implementation_digest",
          "SaveSchemaMigrationModuleManifest",
        ),
      }),
    );
  }
  return modulesById;
}

function registerPlan(
  contracts: ContractValidator,
  candidate: unknown,
  modulesById: ReadonlyMap<string, RegisteredSaveSchemaMigrationModule>,
  currentSaveSchemaVersion: string,
): RegisteredSaveSchemaMigrationPlan {
  const plan = contracts.assertObject(
    CONTRACT_REF.saveSchemaMigrationPlan,
    candidate,
  );
  const value = plan.value;
  const planId = expectString(value, "plan_id", "SaveSchemaMigrationPlan");
  const sourceSaveSchemaVersion = expectString(
    value,
    "source_save_schema_version",
    "SaveSchemaMigrationPlan",
  );
  const targetSaveSchemaVersion = expectString(
    value,
    "target_save_schema_version",
    "SaveSchemaMigrationPlan",
  );
  if (sourceSaveSchemaVersion === targetSaveSchemaVersion) {
    throw new EngineFault(
      "save_schema.registry.plan_version_unchanged",
      "A Save Schema migration plan must change save_schema_version",
      { plan_id: planId, save_schema_version: sourceSaveSchemaVersion },
    );
  }
  if (targetSaveSchemaVersion !== currentSaveSchemaVersion) {
    throw new EngineFault(
      "save_schema.registry.plan_target_not_current",
      "Every activated Save Schema migration plan must target the deployment's explicit current version",
      {
        plan_id: planId,
        plan_target_save_schema_version: targetSaveSchemaVersion,
        current_save_schema_version: currentSaveSchemaVersion,
      },
    );
  }

  const migrationIds = asStringArray(
    expectProperty(value, "migration_ids", "SaveSchemaMigrationPlan"),
    "SaveSchemaMigrationPlan.migration_ids",
  );
  const steps = migrationIds.map((migrationId) => {
    const step = modulesById.get(migrationId);
    if (step === undefined) {
      throw new EngineFault(
        "save_schema.registry.plan_module_missing",
        "A Save Schema migration plan references an unregistered migration_id",
        { plan_id: planId, migration_id: migrationId },
      );
    }
    return step;
  });

  const firstStep = steps[0];
  if (firstStep === undefined) {
    throw new EngineFault(
      "save_schema.registry.plan_empty",
      "Save Schema migration plan must contain at least one migration_id",
      { plan_id: planId },
    );
  }
  let expectedVersion = sourceSaveSchemaVersion;
  let expectedSchemaRef = firstStep.sourceSchemaRef;
  for (const [index, step] of steps.entries()) {
    if (
      step.sourceSaveSchemaVersion !== expectedVersion ||
      (index > 0 && step.sourceSchemaRef !== expectedSchemaRef)
    ) {
      throw new EngineFault(
        "save_schema.registry.plan_chain_disconnected",
        "Save Schema migration plan steps must form one exact ordered version and schema-ref chain",
        {
          plan_id: planId,
          migration_id: step.migrationId,
          step_index: index,
          expected_source_save_schema_version: expectedVersion,
          actual_source_save_schema_version:
            step.sourceSaveSchemaVersion,
          expected_source_schema_ref:
            index === 0 ? step.sourceSchemaRef : expectedSchemaRef,
          actual_source_schema_ref: step.sourceSchemaRef,
        },
      );
    }
    expectedVersion = step.targetSaveSchemaVersion;
    expectedSchemaRef = step.targetSchemaRef;
  }
  if (
    expectedVersion !== targetSaveSchemaVersion ||
    expectedSchemaRef !== CONTRACT_REF.saveEnvelope
  ) {
    throw new EngineFault(
      "save_schema.registry.plan_target_mismatch",
      "Save Schema migration plan must terminate at the current SaveEnvelope contract and declared target version",
      {
        plan_id: planId,
        actual_target_save_schema_version: expectedVersion,
        declared_target_save_schema_version: targetSaveSchemaVersion,
        actual_target_schema_ref: expectedSchemaRef,
        required_target_schema_ref: CONTRACT_REF.saveEnvelope,
      },
    );
  }

  return Object.freeze({
    plan,
    planId,
    sourceSaveSchemaVersion,
    targetSaveSchemaVersion,
    steps: Object.freeze(steps),
  });
}

function asStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "save_schema.registry.plan_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new EngineFault(
        "save_schema.registry.plan_shape",
        `${path}[${index}] must be a string`,
        { path: `${path}[${index}]` },
      );
    }
    return entry;
  });
}
