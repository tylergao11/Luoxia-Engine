import {
  CONTRACT_REF,
  EngineFault,
  assertSaveEnvelopeRelationships as assertIntrinsicSaveEnvelopeRelationships,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type SaveEnvelopeDocument,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  WorldSnapshotDocument,
} from "@luoxia/world-core";

import type {
  RegisteredRulePluginModule,
  RulePluginAbiRegistry,
  RulePluginDependencyIdentity,
} from "./rule-plugin-abi.js";
import type {
  RegisteredStageModule,
  StageModuleDependencyIdentity,
  StageModuleRegistry,
} from "./stage-module-registry.js";
import type { StageContractAuthority } from "./stage-contract-authority.js";
import type {
  RuntimeSaveMigrationRepository,
  RuntimeSaveRepository,
  RuntimeWorldRecord,
} from "./runtime-persistence.js";
import type { SaveSchemaMigrationService } from "./save-schema-migration.js";

export interface RuntimeActivatedBundleDescriptor {
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
  readonly engineContractVersion: string;
  /** Original frozen DependencyLock objects from the validated ContentBundle. */
  readonly dependencies: readonly JsonObject[];
}

export interface RuntimeSaveClock {
  now(): string;
}

export interface RuntimeSaveImportResult {
  readonly saveEnvelope: SaveEnvelopeDocument;
  readonly world: RuntimeWorldRecord;
}

export interface RuntimeSaveService {
  /**
   * Build the complete revision-zero SaveEnvelope and atomically decompose it.
   * This is the only persistence path used by new-world creation.
   */
  createInitial(input: {
    readonly snapshot: WorldSnapshotDocument;
    readonly worldContentLock: WorldContentLockDocument;
    readonly createdAt: string;
  }): Promise<RuntimeWorldRecord>;
  /** Reconstruct one complete SaveEnvelope from PostgreSQL's separate facts. */
  exportSave(worldId: string): Promise<SaveEnvelopeDocument>;
  /**
   * Validate one explicit current-or-migrate ImportRequest, prove deployment
   * compatibility, then create a new PostgreSQL world atomically.
   */
  importSave(requestCandidate: unknown): Promise<RuntimeSaveImportResult>;
  /**
   * Explicitly migrate one existing PostgreSQL world under its row lock.
   * World facts and revision remain unchanged; this never calls apply_packet.
   */
  migrateStored(
    requestCandidate: unknown,
  ): Promise<SaveEnvelopeDocument>;
}

export interface RuntimeSaveCompatibility {
  buildInitialEnvelope(input: {
    readonly snapshot: WorldSnapshotDocument;
    readonly worldContentLock: WorldContentLockDocument;
  }): SaveEnvelopeDocument;
  assertImportCompatible(envelope: SaveEnvelopeDocument): void;
}

export interface RuntimeSaveCompatibilityDependencies {
  readonly contracts: ContractValidator;
  readonly catalog: ContentRuntimeCatalog;
  readonly saveSchemaVersion: string;
  readonly engineContractVersion: string;
  readonly bundles: readonly RuntimeActivatedBundleDescriptor[];
  readonly rulePlugins: RulePluginAbiRegistry;
  readonly stageModules: StageModuleRegistry;
  readonly stageContracts: StageContractAuthority;
}

export interface RuntimeSaveServiceDependencies {
  readonly contracts: ContractValidator;
  readonly compatibility: RuntimeSaveCompatibility;
  readonly repository: RuntimeSaveRepository;
  readonly migrationRepository: RuntimeSaveMigrationRepository;
  readonly migrations: SaveSchemaMigrationService;
  readonly clock: RuntimeSaveClock;
}

interface RuntimeSaveLockProfile {
  readonly dependencyBundleLocks: readonly JsonObject[];
  readonly rulePluginLocks: readonly JsonObject[];
  readonly stageModuleLocks: readonly JsonObject[];
}

/**
 * Derives save locks from the activated ContentBundle dependency graph and the
 * sole RulePlugin/Stage registries. It stores no copied content documents and
 * never accepts caller-supplied lock arrays.
 */
export function createRuntimeSaveCompatibility(
  dependencies: RuntimeSaveCompatibilityDependencies,
): RuntimeSaveCompatibility {
  return new DefaultRuntimeSaveCompatibility(dependencies);
}

class DefaultRuntimeSaveCompatibility implements RuntimeSaveCompatibility {
  readonly #contracts: ContractValidator;
  readonly #catalog: ContentRuntimeCatalog;
  readonly #saveSchemaVersion: string;
  readonly #engineContractVersion: string;
  readonly #bundlesByKey: ReadonlyMap<string, RuntimeActivatedBundleDescriptor>;
  readonly #rulePlugins: RulePluginAbiRegistry;
  readonly #stageModules: StageModuleRegistry;
  readonly #stageContracts: StageContractAuthority;

  public constructor(dependencies: RuntimeSaveCompatibilityDependencies) {
    dependencies.contracts.assert(
      CONTRACT_REF.semVer,
      dependencies.saveSchemaVersion,
    );
    dependencies.contracts.assert(
      CONTRACT_REF.semVer,
      dependencies.engineContractVersion,
    );

    const bundlesByKey = new Map<string, RuntimeActivatedBundleDescriptor>();
    for (const bundle of dependencies.bundles) {
      dependencies.contracts.assertObject(CONTRACT_REF.packLock, {
        pack_id: bundle.packId,
        pack_version: bundle.packVersion,
        bundle_digest: bundle.bundleDigest,
      });
      dependencies.contracts.assert(
        CONTRACT_REF.semVer,
        bundle.engineContractVersion,
      );
      if (bundle.engineContractVersion !== dependencies.engineContractVersion) {
        throw new EngineFault(
          "runtime.save.engine_contract_incompatible",
          "Activated ContentBundle engine_contract_version differs from the deployment contract version",
          {
            pack_id: bundle.packId,
            bundle_digest: bundle.bundleDigest,
            bundle_engine_contract_version: bundle.engineContractVersion,
            deployment_engine_contract_version:
              dependencies.engineContractVersion,
          },
        );
      }
      const key = bundleKey(bundle.packId, bundle.bundleDigest);
      if (bundlesByKey.has(key)) {
        throw new EngineFault(
          "runtime.save.bundle_duplicate",
          "Activated bundle descriptor appears more than once",
          {
            pack_id: bundle.packId,
            bundle_digest: bundle.bundleDigest,
          },
        );
      }
      bundlesByKey.set(key, bundle);
    }

    this.#contracts = dependencies.contracts;
    this.#catalog = dependencies.catalog;
    this.#saveSchemaVersion = dependencies.saveSchemaVersion;
    this.#engineContractVersion = dependencies.engineContractVersion;
    this.#bundlesByKey = bundlesByKey;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#stageModules = dependencies.stageModules;
    this.#stageContracts = dependencies.stageContracts;
  }

  public buildInitialEnvelope(input: {
    readonly snapshot: WorldSnapshotDocument;
    readonly worldContentLock: WorldContentLockDocument;
  }): SaveEnvelopeDocument {
    const snapshot = this.#contracts.assertObject(
      CONTRACT_REF.worldSnapshot,
      input.snapshot.value,
    );
    const worldContentLock = this.#contracts.assertObject(
      CONTRACT_REF.worldContentLock,
      input.worldContentLock.value,
    );
    const worldId = expectString(
      snapshot.value,
      "world_id",
      "WorldSnapshot",
    );
    const worldRevision = expectInteger(
      snapshot.value,
      "world_revision",
      "WorldSnapshot",
    );
    if (worldRevision !== 0) {
      throw new EngineFault(
        "runtime.save.initial_revision_invalid",
        "A new world's initial SaveEnvelope must use revision 0",
        { world_id: worldId, world_revision: worldRevision },
      );
    }

    const profile = this.#resolveLockProfile(worldContentLock);
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.saveEnvelope,
      {
        contract_version: "world-runtime.v1",
        record_type: "save.envelope",
        save_schema_version: this.#saveSchemaVersion,
        world_id: worldId,
        world_revision: worldRevision,
        engine_contract_version: this.#engineContractVersion,
        world_content_lock: worldContentLock.value,
        dependency_bundle_locks: profile.dependencyBundleLocks,
        rule_plugin_locks: profile.rulePluginLocks,
        stage_module_locks: profile.stageModuleLocks,
        world_state: expectProperty(
          snapshot.value,
          "world_state",
          "WorldSnapshot",
        ),
        event_cursor: worldRevision,
        asset_hashes: [],
        migration_history: [],
      },
    );
    assertSaveEnvelopeRelationships(this.#contracts, envelope);
    return envelope;
  }

  public assertImportCompatible(envelope: SaveEnvelopeDocument): void {
    assertSaveEnvelopeRelationships(this.#contracts, envelope);
    const value = envelope.value;
    const saveSchemaVersion = expectString(
      value,
      "save_schema_version",
      "SaveEnvelope",
    );
    const engineContractVersion = expectString(
      value,
      "engine_contract_version",
      "SaveEnvelope",
    );
    if (saveSchemaVersion !== this.#saveSchemaVersion) {
      throw new EngineFault(
        "runtime.save.schema_version_incompatible",
        "SaveEnvelope save_schema_version is not supported by this deployment",
        {
          save_schema_version: saveSchemaVersion,
          supported_save_schema_version: this.#saveSchemaVersion,
        },
      );
    }
    if (engineContractVersion !== this.#engineContractVersion) {
      throw new EngineFault(
        "runtime.save.engine_contract_incompatible",
        "SaveEnvelope engine_contract_version is not supported by this deployment",
        {
          engine_contract_version: engineContractVersion,
          supported_engine_contract_version: this.#engineContractVersion,
        },
      );
    }

    const worldContentLock = this.#contracts.assertObject(
      CONTRACT_REF.worldContentLock,
      expectProperty(value, "world_content_lock", "SaveEnvelope"),
    );
    const expected = this.#resolveLockProfile(worldContentLock);
    assertLockSetMatches(
      asObjectArray(
        expectProperty(value, "dependency_bundle_locks", "SaveEnvelope"),
        "SaveEnvelope.dependency_bundle_locks",
      ),
      expected.dependencyBundleLocks,
      "pack_id",
      "PackLock",
      "runtime.save.dependency_bundle_locks_incompatible",
    );
    assertLockSetMatches(
      asObjectArray(
        expectProperty(value, "rule_plugin_locks", "SaveEnvelope"),
        "SaveEnvelope.rule_plugin_locks",
      ),
      expected.rulePluginLocks,
      "plugin_id",
      "PluginLock",
      "runtime.save.rule_plugin_locks_incompatible",
    );
    assertLockSetMatches(
      asObjectArray(
        expectProperty(value, "stage_module_locks", "SaveEnvelope"),
        "SaveEnvelope.stage_module_locks",
      ),
      expected.stageModuleLocks,
      "module_id",
      "StageModuleLock",
      "runtime.save.stage_module_locks_incompatible",
    );
    this.#stageContracts.assertSaveOpenStagesAllowed(envelope);
  }

  #resolveLockProfile(
    worldContentLock: WorldContentLockDocument,
  ): RuntimeSaveLockProfile {
    this.#catalog.resolveWorldContentBinding(worldContentLock);
    const rootLock = expectJsonObject(
      expectProperty(
        worldContentLock.value,
        "root_bundle_lock",
        "WorldContentLock",
      ),
      "WorldContentLock.root_bundle_lock",
    );
    const rootPackId = expectString(rootLock, "pack_id", "PackLock");
    const rootPackVersion = expectString(rootLock, "pack_version", "PackLock");
    const rootBundleDigest = expectString(
      rootLock,
      "bundle_digest",
      "PackLock",
    );
    const root = this.#bundlesByKey.get(
      bundleKey(rootPackId, rootBundleDigest),
    );
    if (root === undefined || root.packVersion !== rootPackVersion) {
      throw new EngineFault(
        "runtime.save.root_bundle_unavailable",
        "WorldContentLock root bundle is not available in this activation",
        {
          pack_id: rootPackId,
          pack_version: rootPackVersion,
          bundle_digest: rootBundleDigest,
        },
      );
    }

    const dependencyBundleLocks = new Map<string, JsonObject>();
    const pluginModules = new Map<string, RegisteredRulePluginModule>();
    const stageRoots: RegisteredStageModule[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (
      bundle: RuntimeActivatedBundleDescriptor,
      includeAsDependency: boolean,
    ): void => {
      const key = bundleKey(bundle.packId, bundle.bundleDigest);
      if (visiting.has(key)) {
        throw new EngineFault(
          "runtime.save.content_dependency_cycle",
          "Required content_pack dependencies contain a cycle",
          {
            pack_id: bundle.packId,
            bundle_digest: bundle.bundleDigest,
          },
        );
      }
      if (visited.has(key)) {
        return;
      }
      visiting.add(key);
      if (includeAsDependency) {
        insertUniqueLock(
          dependencyBundleLocks,
          bundle.packId,
          Object.freeze({
            pack_id: bundle.packId,
            pack_version: bundle.packVersion,
            bundle_digest: bundle.bundleDigest,
          }),
          "PackLock",
          "runtime.save.content_dependency_conflict",
        );
      }

      for (const dependency of bundle.dependencies) {
        if (dependency["required"] !== true) {
          continue;
        }
        const dependencyKind = expectString(
          dependency,
          "dependency_kind",
          "DependencyLock",
        );
        const identity = dependencyIdentity(dependency);
        switch (dependencyKind) {
          case "content_pack": {
            const target = this.#bundlesByKey.get(
              bundleKey(identity.package_id, identity.integrity_sha256),
            );
            if (
              target === undefined ||
              target.packVersion !== identity.version
            ) {
              throw new EngineFault(
                "runtime.save.content_dependency_unavailable",
                "Required content_pack dependency is not available with its exact lock",
                {
                  dependent_pack_id: bundle.packId,
                  package_id: identity.package_id,
                  version: identity.version,
                  integrity_sha256: identity.integrity_sha256,
                },
              );
            }
            visit(target, true);
            break;
          }
          case "rule_plugin": {
            const registered =
              this.#rulePlugins.requireModuleForDependency(identity);
            const pluginId = expectString(
              registered.pluginLock,
              "plugin_id",
              "PluginLock",
            );
            insertUniqueRegisteredPlugin(
              pluginModules,
              pluginId,
              registered,
            );
            break;
          }
          case "stage_module": {
            stageRoots.push(
              this.#stageModules.requireModuleForDependency(identity),
            );
            break;
          }
          case "asset_provider":
            break;
          default:
            throw new EngineFault(
              "runtime.save.dependency_kind_unknown",
              "Required ContentBundle dependency has an unknown kind",
              {
                dependent_pack_id: bundle.packId,
                dependency_kind: dependencyKind,
              },
            );
        }
      }
      visiting.delete(key);
      visited.add(key);
    };

    visit(root, false);

    const rulePluginLocks = [...pluginModules.values()]
      .sort((left, right) =>
        compareIdentifiers(
          expectString(left.pluginLock, "plugin_id", "PluginLock"),
          expectString(right.pluginLock, "plugin_id", "PluginLock"),
        ),
      )
      .map((registered) => registered.pluginLock);

    const stageModuleLocks = this.#stageModules
      .planRequiredModules(stageRoots)
      .map((registered) => registered.stageModuleLock.value);

    return Object.freeze({
      dependencyBundleLocks: Object.freeze(
        [...dependencyBundleLocks.values()].sort((left, right) =>
          compareIdentifiers(
            expectString(left, "pack_id", "PackLock"),
            expectString(right, "pack_id", "PackLock"),
          ),
        ),
      ),
      rulePluginLocks: Object.freeze(rulePluginLocks),
      stageModuleLocks: Object.freeze(stageModuleLocks),
    });
  }
}

export function createRuntimeSaveService(
  dependencies: RuntimeSaveServiceDependencies,
): RuntimeSaveService {
  return Object.freeze({
    async createInitial(input: {
      readonly snapshot: WorldSnapshotDocument;
      readonly worldContentLock: WorldContentLockDocument;
      readonly createdAt: string;
    }): Promise<RuntimeWorldRecord> {
      const envelope = dependencies.compatibility.buildInitialEnvelope(input);
      const stored = await persistAndVerify(
        dependencies,
        envelope,
        input.createdAt,
      );
      return worldRecordFromInsertedEnvelope(dependencies.contracts, stored);
    },

    async exportSave(worldId: string): Promise<SaveEnvelopeDocument> {
      dependencies.contracts.assert(CONTRACT_REF.uuid, worldId);
      const envelope = dependencies.contracts.assertObject(
        CONTRACT_REF.saveEnvelope,
        await dependencies.repository.exportCandidate(worldId),
      );
      assertSaveEnvelopeRelationships(dependencies.contracts, envelope);
      return envelope;
    },

    async importSave(
      requestCandidate: unknown,
    ): Promise<RuntimeSaveImportResult> {
      const persistedAt = dependencies.clock.now();
      const envelope = dependencies.migrations.resolveImport(
        requestCandidate,
        persistedAt,
      );
      assertSaveEnvelopeRelationships(dependencies.contracts, envelope);
      dependencies.compatibility.assertImportCompatible(envelope);
      const stored = await persistAndVerify(
        dependencies,
        envelope,
        persistedAt,
      );
      return Object.freeze({
        saveEnvelope: stored,
        world: worldRecordFromInsertedEnvelope(
          dependencies.contracts,
          stored,
        ),
      });
    },

    async migrateStored(
      requestCandidate: unknown,
    ): Promise<SaveEnvelopeDocument> {
      const request =
        dependencies.migrations.validateStoredRequest(requestCandidate);
      const worldId = expectString(
        request.value,
        "world_id",
        "StoredSaveSchemaMigrationRequest",
      );
      const migratedAt = dependencies.clock.now();
      const storedCandidate =
        await dependencies.migrationRepository.migrateLocked(
          worldId,
          migratedAt,
          (sourceCandidate) => {
            const migrated =
              dependencies.migrations.migrateStoredCandidate(
                request,
                sourceCandidate,
                migratedAt,
              );
            assertSaveEnvelopeRelationships(
              dependencies.contracts,
              migrated,
            );
            dependencies.compatibility.assertImportCompatible(migrated);
            return migrated;
          },
        );
      const stored = dependencies.contracts.assertObject(
        CONTRACT_REF.saveEnvelope,
        storedCandidate,
      );
      assertSaveEnvelopeRelationships(dependencies.contracts, stored);
      dependencies.compatibility.assertImportCompatible(stored);
      return stored;
    },
  });
}

async function persistAndVerify(
  dependencies: RuntimeSaveServiceDependencies,
  envelope: SaveEnvelopeDocument,
  persistedAt: string,
): Promise<SaveEnvelopeDocument> {
  const stored = dependencies.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    await dependencies.repository.insert(envelope, persistedAt),
  );
  assertSaveEnvelopeRelationships(dependencies.contracts, stored);
  if (!jsonEquals(stored.value, envelope.value)) {
    throw new EngineFault(
      "runtime.save.persistence_mismatch",
      "PostgreSQL reassembled a SaveEnvelope different from the authorized input",
      {
        world_id: expectString(
          envelope.value,
          "world_id",
          "SaveEnvelope",
        ),
      },
    );
  }
  return stored;
}

/**
 * Intrinsic relationships are checked on creation, import, export and
 * PostgreSQL reassembly. Deployment compatibility is intentionally separate:
 * an operator must still be able to export an older locked save verbatim.
 */
export function assertSaveEnvelopeRelationships(
  contracts: ContractValidator,
  envelope: SaveEnvelopeDocument,
): void {
  assertIntrinsicSaveEnvelopeRelationships(contracts, envelope);
}

function worldRecordFromInsertedEnvelope(
  contracts: ContractValidator,
  envelope: SaveEnvelopeDocument,
): RuntimeWorldRecord {
  const value = envelope.value;
  return Object.freeze({
    snapshot: contracts.assertObject(CONTRACT_REF.worldSnapshot, {
      world_id: expectString(value, "world_id", "SaveEnvelope"),
      world_revision: expectInteger(
        value,
        "world_revision",
        "SaveEnvelope",
      ),
      world_state: expectProperty(value, "world_state", "SaveEnvelope"),
    }),
    worldContentLock: contracts.assertObject(
      CONTRACT_REF.worldContentLock,
      expectProperty(value, "world_content_lock", "SaveEnvelope"),
    ),
    dependencyBundleLocks: Object.freeze(
      asObjectArray(
        expectProperty(
          value,
          "dependency_bundle_locks",
          "SaveEnvelope",
        ),
        "SaveEnvelope.dependency_bundle_locks",
      ).map((entry) =>
        contracts.assertObject(CONTRACT_REF.packLock, entry),
      ),
    ),
    stageModuleLocks: Object.freeze(
      asObjectArray(
        expectProperty(
          value,
          "stage_module_locks",
          "SaveEnvelope",
        ),
        "SaveEnvelope.stage_module_locks",
      ).map((entry) =>
        contracts.assertObject(CONTRACT_REF.stageModuleLock, entry),
      ),
    ),
    eventHistoryFloorRevision: expectInteger(
      value,
      "event_cursor",
      "SaveEnvelope",
    ),
  });
}

function dependencyIdentity(
  dependency: JsonObject,
): RulePluginDependencyIdentity & StageModuleDependencyIdentity {
  return Object.freeze({
    package_id: expectString(
      dependency,
      "package_id",
      "DependencyLock",
    ),
    version: expectString(dependency, "version", "DependencyLock"),
    integrity_sha256: expectString(
      dependency,
      "integrity_sha256",
      "DependencyLock",
    ),
  });
}

function insertUniqueRegisteredPlugin(
  into: Map<string, RegisteredRulePluginModule>,
  pluginId: string,
  registered: RegisteredRulePluginModule,
): void {
  const existing = into.get(pluginId);
  if (
    existing !== undefined &&
    !jsonEquals(existing.pluginLock, registered.pluginLock)
  ) {
    throw new EngineFault(
      "runtime.save.rule_plugin_dependency_conflict",
      "One world dependency graph requires conflicting locks for the same RulePlugin",
      { plugin_id: pluginId },
    );
  }
  into.set(pluginId, registered);
}

function insertUniqueLock(
  into: Map<string, JsonObject>,
  identity: string,
  lock: JsonObject,
  label: string,
  faultCode: string,
): void {
  const existing = into.get(identity);
  if (existing !== undefined && !jsonEquals(existing, lock)) {
    throw new EngineFault(
      faultCode,
      `One world dependency graph requires conflicting ${label} values`,
      { identity },
    );
  }
  into.set(identity, lock);
}

function assertLockSetMatches(
  actual: readonly JsonObject[],
  expected: readonly JsonObject[],
  identityField: string,
  label: string,
  faultCode: string,
): void {
  const actualById = indexUniqueLocks(
    actual,
    identityField,
    label,
    faultCode,
  );
  const expectedById = indexUniqueLocks(
    expected,
    identityField,
    label,
    faultCode,
  );
  if (
    actualById.size !== expectedById.size ||
    [...expectedById].some(([identity, expectedLock]) => {
      const actualLock = actualById.get(identity);
      return actualLock === undefined || !jsonEquals(actualLock, expectedLock);
    })
  ) {
    throw new EngineFault(
      faultCode,
      `SaveEnvelope ${label} set differs from the activated dependency graph`,
      {
        actual_identities: [...actualById.keys()].sort(),
        expected_identities: [...expectedById.keys()].sort(),
      },
    );
  }
}

function indexUniqueLocks(
  locks: readonly JsonObject[],
  identityField: string,
  label: string,
  faultCode: string,
): ReadonlyMap<string, JsonObject> {
  const indexed = new Map<string, JsonObject>();
  for (const lock of locks) {
    const identity = expectString(lock, identityField, label);
    if (indexed.has(identity)) {
      throw new EngineFault(
        faultCode,
        `SaveEnvelope contains more than one ${label} for the same identity`,
        { identity_field: identityField, identity },
      );
    }
    indexed.set(identity, lock);
  }
  return indexed;
}

function bundleKey(packId: string, bundleDigest: string): string {
  return `${packId}\u0000${bundleDigest}`;
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.save.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry, `${path}[${index}]`),
  );
}
