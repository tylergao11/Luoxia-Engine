import {
  CONTRACT_REF,
  ContentBundleLoader,
  createContentBundleSemanticGate,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
  type LoadedContentBundle,
} from "@luoxia/contracts-runtime";
import { createContentRuntimeCatalog } from "@luoxia/world-core/composition";
import type { Pool } from "pg";

import { createNodeDeterministicContextIdFactory } from "../adapters/crypto/context-id-factory.js";
import { createNodeContentRuntimeIdentityMapper } from "../adapters/crypto/content-runtime-identity-mapper.js";
import type { ContentUpgradeHmacKeyring } from "../adapters/crypto/content-upgrade-hmac-token-codec.js";
import {
  createHmacDeterministicContextTokenCodec,
  type DeterministicContextHmacKeyring,
} from "../adapters/crypto/deterministic-context-hmac-token-codec.js";
import type { SessionBasisHmacKeyring } from "../adapters/crypto/session-basis-hmac-authority.js";
import {
  createAssetProviderRegistry,
  type AssetProviderAdapterV1,
  type AssetProviderRegistry,
  type RegisteredAssetProvider,
} from "./asset-provider-registry.js";
import { createExactDecimalStringComparer } from "./exact-decimal.js";
import type { ModelProvider } from "./model-gateway.js";
import {
  assertCharacterDialogueContextPolicy,
  type CharacterDialogueContextPolicy,
} from "./model-view-projection.js";
import type { RulePluginDependencyIdentity } from "./rule-plugin-abi.js";
import type { RulePluginModuleV1 } from "./rule-plugin-abi.js";
import type { SaveSchemaMigrationModuleV1 } from "./save-schema-migration-abi.js";
import { collectRulePluginOperationRequirements } from "./rule-plugin-operation-requirement.js";
import {
  createRuntimeExecutionKernel,
  type RuntimeExecutionKernel,
} from "./runtime-execution-kernel.js";
import {
  createStageModuleRegistry,
  type RegisteredStageModule,
  type StageModuleDependencyIdentity,
  type StageModuleRegistry,
} from "./stage-module-registry.js";

export interface RuntimeContentActivationInput {
  readonly pool: Pool;
  /**
   * Dedicated Pool for RulePlugin Journal writes made while world rows may be
   * locked. Must target the same database and be a distinct Pool object.
   */
  readonly rulePluginJournalPool: Pool;
  /**
   * Dedicated Pool for Materialization Ledger reads performed while a world
   * row is locked. Must target the same database and differ from both pools.
   */
  readonly materializationLedgerPool: Pool;
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly modelProvider: ModelProvider;
  /** Untrusted ContentBundle JSON documents; order is owned by the deployer. */
  readonly contentBundleCandidates: readonly unknown[];
  /** Trusted in-process RulePlugin modules; no scan, download, or defaults. */
  readonly rulePluginModules: readonly RulePluginModuleV1[];
  /**
   * Explicit deployment-owned AssetProvider adapters. Empty is valid only when
   * activated content has no required asset_provider dependency.
   */
  readonly assetProviderAdapters: readonly AssetProviderAdapterV1[];
  /**
   * Untrusted StageModule manifest JSON documents; order is owned by the deployer.
   * Required field — no default empty array, overload, or compatibility entry.
   */
  readonly stageModuleManifestCandidates: readonly unknown[];
  /**
   * Explicit HMAC keyring for DeterministicContext issuer_token.
   * Required — no default keyring, env read, or auto-generated secrets.
   */
  readonly deterministicContextHmacKeyring: DeterministicContextHmacKeyring;
  /**
   * Independent HMAC keyring for Session basis_token. Required; no defaults,
   * TTL, login claims, or reuse of DeterministicContext key material.
   */
  readonly sessionBasisHmacKeyring: SessionBasisHmacKeyring;
  /**
   * Independent HMAC keyring for Content Upgrade authorization proofs.
   * Required and prohibited from reusing either other keyring.
   */
  readonly contentUpgradeHmacKeyring: ContentUpgradeHmacKeyring;
  /** Explicit positive lifetime in seconds for one upgrade authorization. */
  readonly contentUpgradeAuthorizationLifetimeSeconds: number;
  /** Explicit SaveEnvelope schema version supported by this deployment. */
  readonly saveSchemaVersion: string;
  /**
   * Explicit trusted synchronous pure Save Schema migration modules.
   * Required even when empty; no scan, default module or inferred chain.
   */
  readonly saveSchemaMigrationModules: readonly SaveSchemaMigrationModuleV1[];
  /**
   * Untrusted explicit migration plan manifests. Required even when empty.
   */
  readonly saveSchemaMigrationPlanCandidates: readonly unknown[];
  /** Explicit public Engine contract version supported by this deployment. */
  readonly engineContractVersion: string;
  /**
   * Explicit deployment-owned ModelProfile selection for CharacterMind
   * dialogue. It is not content, client input, or a default.
   */
  readonly characterDialogueModelProfileId: string;
  /** Explicit projection limits for CharacterMind dialogue model context. */
  readonly characterDialogueContextPolicy: CharacterDialogueContextPolicy;
  /** Explicit deployment-owned ModelProfile selection for Director daily work. */
  readonly directorDailySettlementModelProfileId: string;
  /** Explicit deployment-owned ModelProfile selection for Director NPC dialogue events. */
  readonly directorDialogueEventsModelProfileId: string;
  /** Explicit deployment-owned ModelProfile selection for Director System dialogue. */
  readonly directorSystemDialogueModelProfileId: string;
  /** Explicit deployment-owned ModelProfile selection for goal-plan drafting. */
  readonly directorGoalPlanModelProfileId: string;
  /** Explicit deployment-owned ModelProfile selection for definition drafting. */
  readonly directorDefinitionDraftModelProfileId: string;
  /** Explicit deployment-owned ModelProfile selection for Character reactions. */
  readonly characterReactModelProfileId: string;
}

export type { DeterministicContextHmacKeyring } from "../adapters/crypto/deterministic-context-hmac-token-codec.js";
export type { SessionBasisHmacKeyring } from "../adapters/crypto/session-basis-hmac-authority.js";
export type { ContentUpgradeHmacKeyring } from "../adapters/crypto/content-upgrade-hmac-token-codec.js";

export interface ActivatedBundleIdentity {
  readonly pack_id: string;
  readonly bundle_digest: string;
}

export interface RuntimeContentActivation {
  readonly kernel: RuntimeExecutionKernel;
  /** Verified bundle identities only — no content document copies. */
  readonly bundles: readonly ActivatedBundleIdentity[];
  /**
   * Sole Schema-validated StageModule registry for this activation.
   * Proves dependency and scene contracts only; does not load entrypoints.
   */
  readonly stageModules: StageModuleRegistry;
  /**
   * Required stage_module roots expanded to a full transitive closure,
   * ordered dependency-first for deploy composition. Same RegisteredStageModule
   * objects as the registry — validates and orders only; does not load artifacts.
   */
  readonly requiredStageModules: readonly RegisteredStageModule[];
  /** Sole explicit registry used to satisfy asset_provider DependencyLocks. */
  readonly assetProviders: AssetProviderRegistry;
  /** Exact registered adapters required by the activated ContentBundles. */
  readonly requiredAssetProviders: readonly RegisteredAssetProvider[];
}

interface LoadedBundleRecord {
  readonly loaded: LoadedContentBundle;
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
  readonly engineContractVersion: string;
  readonly dependencies: readonly JsonObject[];
}

/**
 * Explicit deploy-time activation: untrusted ContentBundle JSON → load gate →
 * single ContentRuntimeCatalog → StageModule Registry → RuntimeExecutionKernel.
 * Does not create a RulePlugin ABI (Kernel owns the sole registry).
 * Does not load StageModule entrypoints or import client engines.
 * Does not read directories, env vars, or embed sample content.
 */
export async function createRuntimeContentActivation(
  input: RuntimeContentActivationInput,
): Promise<RuntimeContentActivation> {
  assertCharacterDialogueContextPolicy(
    input.characterDialogueContextPolicy,
  );
  assertIndependentHmacKeyrings(
    input.deterministicContextHmacKeyring,
    input.sessionBasisHmacKeyring,
    input.contentUpgradeHmacKeyring,
  );
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.characterDialogueModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.characterDialogueModelProfileId,
    requestKind: "character.dialogue",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.directorDailySettlementModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.directorDailySettlementModelProfileId,
    requestKind: "director.daily_settlement",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.directorDialogueEventsModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.directorDialogueEventsModelProfileId,
    requestKind: "director.dialogue_events",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.directorSystemDialogueModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.directorSystemDialogueModelProfileId,
    requestKind: "director.system_dialogue",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.directorGoalPlanModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.directorGoalPlanModelProfileId,
    requestKind: "director.goal_plan",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.directorDefinitionDraftModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.directorDefinitionDraftModelProfileId,
    requestKind: "director.definition_draft",
  });
  input.contracts.assert(
    CONTRACT_REF.identifier,
    input.characterReactModelProfileId,
  );
  input.modelProvider.assertCanInvoke({
    modelProfileId: input.characterReactModelProfileId,
    requestKind: "character.react",
  });
  const loader = new ContentBundleLoader(
    input.contracts,
    input.digest,
    createContentBundleSemanticGate({
      contracts: input.contracts,
      decimalComparer: createExactDecimalStringComparer(),
    }),
  );

  const records: LoadedBundleRecord[] = [];
  const seenKeys = new Set<string>();

  for (const [index, candidate] of input.contentBundleCandidates.entries()) {
    const loaded = await loader.load(candidate);
    const identity = readBundleIdentity(loaded, index);
    const key = bundleKey(identity.packId, identity.bundleDigest);
    if (seenKeys.has(key)) {
      throw new EngineFault(
        "runtime.activation.duplicate_bundle",
        "ContentBundle (pack_id, bundle_digest) appears more than once in activation input",
        {
          pack_id: identity.packId,
          bundle_digest: identity.bundleDigest,
          candidate_index: index,
        },
      );
    }
    seenKeys.add(key);
    records.push(identity);
  }

  const contentRuntimeIdentityMapper =
    createNodeContentRuntimeIdentityMapper();
  const catalog = createContentRuntimeCatalog({
    digest: input.digest,
    identityMapper: contentRuntimeIdentityMapper,
  });
  for (const record of records) {
    catalog.register(record.loaded);
  }

  const rulePluginOperationRequirements =
    collectRulePluginOperationRequirements({
      catalog,
      bundles: records.map((record) =>
        Object.freeze({
          packId: record.packId,
          bundleDigest: record.bundleDigest,
        }),
      ),
    });

  const stageModules = createStageModuleRegistry({
    contracts: input.contracts,
    manifestCandidates: input.stageModuleManifestCandidates,
  });
  const assetProviders = createAssetProviderRegistry({
    contracts: input.contracts,
    adapters: input.assetProviderAdapters,
  });

  const packIndex = buildPackIndex(records);
  const requiredRulePluginDependencies: RulePluginDependencyIdentity[] = [];
  const requiredStageModuleRoots: RegisteredStageModule[] = [];
  const requiredAssetProviderSet = new Set<RegisteredAssetProvider>();
  for (const record of records) {
    collectAndAssertDependencies(
      record,
      packIndex,
      requiredRulePluginDependencies,
      stageModules,
      requiredStageModuleRoots,
      assetProviders,
      requiredAssetProviderSet,
    );
  }

  for (const record of records) {
    assertRequiredStageRefs(record, stageModules);
  }

  const requiredStageModules = stageModules.planRequiredModules(
    requiredStageModuleRoots,
  );
  const requiredAssetProviders = Object.freeze(
    assetProviders.registeredProviders.filter((provider) =>
      requiredAssetProviderSet.has(provider),
    ),
  );

  const deterministicContextTokenCodec =
    createHmacDeterministicContextTokenCodec({
      digest: input.digest,
      keyring: input.deterministicContextHmacKeyring,
    });

  const kernel = createRuntimeExecutionKernel({
    pool: input.pool,
    rulePluginJournalPool: input.rulePluginJournalPool,
    materializationLedgerPool: input.materializationLedgerPool,
    contracts: input.contracts,
    digest: input.digest,
    modelProvider: input.modelProvider,
    rulePluginModules: input.rulePluginModules,
    requiredRulePluginDependencies: Object.freeze([
      ...requiredRulePluginDependencies,
    ]),
    rulePluginOperationRequirements,
    contentRuntimeCatalog: catalog,
    contentRuntimeIdentityMapper,
    assetProviders,
    saveSchemaVersion: input.saveSchemaVersion,
    saveSchemaMigrationModules: input.saveSchemaMigrationModules,
    saveSchemaMigrationPlanCandidates:
      input.saveSchemaMigrationPlanCandidates,
    engineContractVersion: input.engineContractVersion,
    activatedBundles: Object.freeze(
      records.map((record) =>
        Object.freeze({
          packId: record.packId,
          packVersion: record.packVersion,
          bundleDigest: record.bundleDigest,
          engineContractVersion: record.engineContractVersion,
          dependencies: record.dependencies,
        }),
      ),
    ),
    stageModuleRegistry: stageModules,
    deterministicContextTokenCodec,
    deterministicContextIdFactory: createNodeDeterministicContextIdFactory(),
    sessionBasisHmacKeyring: input.sessionBasisHmacKeyring,
    contentUpgradeHmacKeyring: input.contentUpgradeHmacKeyring,
    contentUpgradeAuthorizationLifetimeSeconds:
      input.contentUpgradeAuthorizationLifetimeSeconds,
    characterDialogueModelProfileId:
      input.characterDialogueModelProfileId,
    characterDialogueContextPolicy:
      input.characterDialogueContextPolicy,
    directorDailySettlementModelProfileId:
      input.directorDailySettlementModelProfileId,
    directorDialogueEventsModelProfileId:
      input.directorDialogueEventsModelProfileId,
    directorSystemDialogueModelProfileId:
      input.directorSystemDialogueModelProfileId,
    directorGoalPlanModelProfileId:
      input.directorGoalPlanModelProfileId,
    directorDefinitionDraftModelProfileId:
      input.directorDefinitionDraftModelProfileId,
    characterReactModelProfileId: input.characterReactModelProfileId,
  });

  const bundles = Object.freeze(
    records.map((record) =>
      Object.freeze({
        pack_id: record.packId,
        bundle_digest: record.bundleDigest,
      }),
    ),
  );

  return Object.freeze({
    kernel,
    bundles,
    stageModules,
    requiredStageModules,
    assetProviders,
    requiredAssetProviders,
  });
}

function assertIndependentHmacKeyrings(
  contextKeyring: DeterministicContextHmacKeyring,
  sessionKeyring: SessionBasisHmacKeyring,
  upgradeKeyring: ContentUpgradeHmacKeyring,
): void {
  assertKeyMaterialNotReused(
    "deterministic_context",
    contextKeyring.keys,
    "session_basis",
    sessionKeyring.keys,
  );
  assertKeyMaterialNotReused(
    "deterministic_context",
    contextKeyring.keys,
    "content_upgrade",
    upgradeKeyring.keys,
  );
  assertKeyMaterialNotReused(
    "session_basis",
    sessionKeyring.keys,
    "content_upgrade",
    upgradeKeyring.keys,
  );
}

function assertKeyMaterialNotReused(
  leftOwner: string,
  leftKeys: readonly {
    readonly keyId: string;
    readonly secret: Uint8Array;
  }[],
  rightOwner: string,
  rightKeys: readonly {
    readonly keyId: string;
    readonly secret: Uint8Array;
  }[],
): void {
  for (const leftKey of leftKeys) {
    for (const rightKey of rightKeys) {
      if (
        leftKey.secret instanceof Uint8Array &&
        rightKey.secret instanceof Uint8Array &&
        leftKey.secret.byteLength === rightKey.secret.byteLength &&
        Buffer.from(leftKey.secret).equals(Buffer.from(rightKey.secret))
      ) {
        throw new EngineFault(
          "runtime.activation.hmac_key_reuse",
          "Independent runtime HMAC authorities must not reuse key material",
          {
            left_owner: leftOwner,
            left_key_id: leftKey.keyId,
            right_owner: rightOwner,
            right_key_id: rightKey.keyId,
          },
        );
      }
    }
  }
}

function readBundleIdentity(
  loaded: LoadedContentBundle,
  candidateIndex: number,
): LoadedBundleRecord {
  void candidateIndex;
  const root = loaded.document.value;
  const bundle = expectJsonObject(
    expectProperty(root, "bundle", "ContentBundle"),
    "ContentBundle.bundle",
  );
  const manifest = expectJsonObject(
    expectProperty(bundle, "manifest", "bundle"),
    "bundle.manifest",
  );
  const packId = expectString(manifest, "pack_id", "manifest");
  const packVersion = expectString(manifest, "pack_version", "manifest");
  const engineContractVersion = expectString(
    manifest,
    "engine_contract_version",
    "manifest",
  );
  const dependencies = asObjectArray(
    expectProperty(bundle, "dependencies", "bundle"),
    "bundle.dependencies",
  );
  return Object.freeze({
    loaded,
    packId,
    packVersion,
    bundleDigest: loaded.bundleDigest,
    engineContractVersion,
    dependencies: Object.freeze([...dependencies]),
  });
}

interface PackIndexEntry {
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
}

function buildPackIndex(
  records: readonly LoadedBundleRecord[],
): ReadonlyMap<string, PackIndexEntry> {
  const index = new Map<string, PackIndexEntry>();
  for (const record of records) {
    index.set(
      bundleKey(record.packId, record.bundleDigest),
      Object.freeze({
        packId: record.packId,
        packVersion: record.packVersion,
        bundleDigest: record.bundleDigest,
      }),
    );
  }
  return index;
}

function collectAndAssertDependencies(
  record: LoadedBundleRecord,
  packIndex: ReadonlyMap<string, PackIndexEntry>,
  requiredRulePlugins: RulePluginDependencyIdentity[],
  stageModules: StageModuleRegistry,
  requiredStageModuleRoots: RegisteredStageModule[],
  assetProviders: AssetProviderRegistry,
  requiredAssetProviders: Set<RegisteredAssetProvider>,
): void {
  for (const [depIndex, dependency] of record.dependencies.entries()) {
    const required = dependency.required;
    if (required !== true) {
      continue;
    }

    const dependencyId = expectString(
      dependency,
      "dependency_id",
      "DependencyLock",
    );
    const kind = expectString(dependency, "dependency_kind", "DependencyLock");
    const packageId = expectString(dependency, "package_id", "DependencyLock");
    const version = expectString(dependency, "version", "DependencyLock");
    const integrity = expectString(
      dependency,
      "integrity_sha256",
      "DependencyLock",
    );

    switch (kind) {
      case "rule_plugin": {
        requiredRulePlugins.push(
          Object.freeze({
            package_id: packageId,
            version,
            integrity_sha256: integrity,
          }),
        );
        break;
      }
      case "content_pack": {
        const target = packIndex.get(bundleKey(packageId, integrity));
        if (target === undefined) {
          throw new EngineFault(
            "runtime.activation.content_pack_missing",
            "Required content_pack dependency is not among activated ContentBundles",
            {
              dependent_pack_id: record.packId,
              dependent_bundle_digest: record.bundleDigest,
              dependency_id: dependencyId,
              package_id: packageId,
              integrity_sha256: integrity,
              dependency_index: depIndex,
            },
          );
        }
        if (target.packVersion !== version) {
          throw new EngineFault(
            "runtime.activation.content_pack_version_mismatch",
            "Required content_pack dependency version does not match activated pack_version",
            {
              dependent_pack_id: record.packId,
              dependency_id: dependencyId,
              package_id: packageId,
              dependency_version: version,
              activated_pack_version: target.packVersion,
              bundle_digest: integrity,
            },
          );
        }
        break;
      }
      case "stage_module": {
        const identity: StageModuleDependencyIdentity = Object.freeze({
          package_id: packageId,
          version,
          integrity_sha256: integrity,
        });
        requiredStageModuleRoots.push(
          stageModules.requireModuleForDependency(identity),
        );
        break;
      }
      case "asset_provider": {
        requiredAssetProviders.add(
          assetProviders.requireAdapterForDependency({
            package_id: packageId,
            version,
            integrity_sha256: integrity,
          }),
        );
        break;
      }
      default: {
        throw new EngineFault(
          "runtime.activation.dependency_kind_unknown",
          "Unknown DependencyLock.dependency_kind on a required dependency",
          {
            dependent_pack_id: record.packId,
            dependency_id: dependencyId,
            dependency_kind: kind,
          },
        );
      }
    }
  }
}

function assertRequiredStageRefs(
  record: LoadedBundleRecord,
  stageModules: StageModuleRegistry,
): void {
  const root = record.loaded.document.value;
  const bundle = expectJsonObject(
    expectProperty(root, "bundle", "ContentBundle"),
    "ContentBundle.bundle",
  );
  const dependencyById = indexDependenciesById(record.dependencies);

  const worlds = asObjectArray(
    expectProperty(bundle, "worlds", "bundle"),
    "bundle.worlds",
  );
  for (const [worldIndex, world] of worlds.entries()) {
    if (world.default_stage !== undefined) {
      const stageRef = expectJsonObject(
        world.default_stage as JsonValue,
        `bundle.worlds[${worldIndex}].default_stage`,
      );
      assertStageRefAgainstRequiredModules(
        stageRef,
        `bundle.worlds[${worldIndex}].default_stage`,
        record,
        dependencyById,
        stageModules,
        undefined,
      );
    }
  }

  const gameplay = expectJsonObject(
    expectProperty(bundle, "gameplay", "bundle"),
    "bundle.gameplay",
  );
  const stages = asObjectArray(
    expectProperty(gameplay, "stages", "gameplay"),
    "gameplay.stages",
  );
  for (const [stageIndex, stage] of stages.entries()) {
    const stageRef = expectJsonObject(
      expectProperty(stage, "stage_ref", `gameplay.stages[${stageIndex}]`),
      `gameplay.stages[${stageIndex}].stage_ref`,
    );
    assertStageRefAgainstRequiredModules(
      stageRef,
      `gameplay.stages[${stageIndex}].stage_ref`,
      record,
      dependencyById,
      stageModules,
      undefined,
    );
  }

  const presentation = expectJsonObject(
    expectProperty(bundle, "presentation", "bundle"),
    "bundle.presentation",
  );
  const bindings = asObjectArray(
    expectProperty(presentation, "bindings", "presentation"),
    "presentation.bindings",
  );
  for (const [bindingIndex, binding] of bindings.entries()) {
    if (binding.stage === undefined) {
      continue;
    }
    const stageRef = expectJsonObject(
      binding.stage as JsonValue,
      `presentation.bindings[${bindingIndex}].stage`,
    );
    assertStageRefAgainstRequiredModules(
      stageRef,
      `presentation.bindings[${bindingIndex}].stage`,
      record,
      dependencyById,
      stageModules,
      Object.freeze({
        bindingId: expectString(binding, "binding_id", "PackBinding"),
        slotId: expectString(binding, "slot_id", "PackBinding"),
      }),
    );
  }
}

function assertStageRefAgainstRequiredModules(
  stageRef: JsonObject,
  path: string,
  record: LoadedBundleRecord,
  dependencyById: ReadonlyMap<string, JsonObject>,
  stageModules: StageModuleRegistry,
  binding:
    | {
        readonly bindingId: string;
        readonly slotId: string;
      }
    | undefined,
): void {
  const dependencyId = expectString(
    stageRef,
    "stage_module_dependency_id",
    path,
  );
  const sceneId = expectString(stageRef, "scene_id", path);
  const dependency = dependencyById.get(dependencyId);
  if (dependency === undefined) {
    throw new EngineFault(
      "runtime.activation.stage_ref_dependency_missing",
      "StageRef.stage_module_dependency_id does not match a DependencyLock in this ContentBundle",
      {
        pack_id: record.packId,
        bundle_digest: record.bundleDigest,
        path,
        stage_module_dependency_id: dependencyId,
      },
    );
  }

  const kind = expectString(dependency, "dependency_kind", "DependencyLock");
  if (kind !== "stage_module") {
    throw new EngineFault(
      "runtime.activation.stage_ref_dependency_kind_mismatch",
      "StageRef stage_module_dependency_id does not point at a stage_module DependencyLock",
      {
        pack_id: record.packId,
        path,
        stage_module_dependency_id: dependencyId,
        dependency_kind: kind,
      },
    );
  }

  if (dependency.required !== true) {
    throw new EngineFault(
      "runtime.activation.stage_ref_dependency_not_required",
      "StageRef stage_module dependency must be required by the ContentBundle",
      {
        pack_id: record.packId,
        path,
        stage_module_dependency_id: dependencyId,
      },
    );
  }

  const identity: StageModuleDependencyIdentity = Object.freeze({
    package_id: expectString(dependency, "package_id", "DependencyLock"),
    version: expectString(dependency, "version", "DependencyLock"),
    integrity_sha256: expectString(
      dependency,
      "integrity_sha256",
      "DependencyLock",
    ),
  });
  const module = stageModules.requireModuleForDependency(identity);
  const scene = stageModules.requireScene(module, sceneId);
  if (
    binding !== undefined &&
    !scene.slotIds.includes(binding.slotId)
  ) {
    throw new EngineFault(
      "runtime.activation.stage_binding_slot_not_declared",
      "Stage PackBinding slot_id is not declared by the exact StageModule scene",
      {
        pack_id: record.packId,
        path,
        binding_id: binding.bindingId,
        slot_id: binding.slotId,
        module_id: module.indexed.moduleId,
        scene_id: sceneId,
      },
    );
  }
}

function indexDependenciesById(
  dependencies: readonly JsonObject[],
): ReadonlyMap<string, JsonObject> {
  const index = new Map<string, JsonObject>();
  for (const dependency of dependencies) {
    const dependencyId = expectString(
      dependency,
      "dependency_id",
      "DependencyLock",
    );
    index.set(dependencyId, dependency);
  }
  return index;
}

function bundleKey(packId: string, bundleDigest: string): string {
  return `${packId}\u0000${bundleDigest}`;
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.activation.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
