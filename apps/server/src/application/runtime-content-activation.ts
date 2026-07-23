import {
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

import type { ModelProvider } from "./model-gateway.js";
import type { RulePluginDependencyIdentity } from "./rule-plugin-abi.js";
import type { RulePluginModuleV1 } from "./rule-plugin-abi.js";
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
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly modelProvider: ModelProvider;
  /** Untrusted ContentBundle JSON documents; order is owned by the deployer. */
  readonly contentBundleCandidates: readonly unknown[];
  /** Trusted in-process RulePlugin modules; no scan, download, or defaults. */
  readonly rulePluginModules: readonly RulePluginModuleV1[];
  /**
   * Untrusted StageModule manifest JSON documents; order is owned by the deployer.
   * Required field — no default empty array, overload, or compatibility entry.
   */
  readonly stageModuleManifestCandidates: readonly unknown[];
}

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
}

interface LoadedBundleRecord {
  readonly loaded: LoadedContentBundle;
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
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
  const loader = new ContentBundleLoader(
    input.contracts,
    input.digest,
    createContentBundleSemanticGate(),
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

  const catalog = createContentRuntimeCatalog({ digest: input.digest });
  for (const record of records) {
    catalog.register(record.loaded);
  }

  const stageModules = createStageModuleRegistry({
    contracts: input.contracts,
    manifestCandidates: input.stageModuleManifestCandidates,
  });

  const packIndex = buildPackIndex(records);
  const requiredRulePluginDependencies: RulePluginDependencyIdentity[] = [];
  const requiredStageModuleRoots: RegisteredStageModule[] = [];
  for (const record of records) {
    collectAndAssertDependencies(
      record,
      packIndex,
      requiredRulePluginDependencies,
      stageModules,
      requiredStageModuleRoots,
    );
  }

  for (const record of records) {
    assertRequiredStageRefs(record, stageModules);
  }

  const requiredStageModules = stageModules.planRequiredModules(
    requiredStageModuleRoots,
  );

  const kernel = createRuntimeExecutionKernel({
    pool: input.pool,
    contracts: input.contracts,
    digest: input.digest,
    modelProvider: input.modelProvider,
    rulePluginModules: input.rulePluginModules,
    requiredRulePluginDependencies: Object.freeze([
      ...requiredRulePluginDependencies,
    ]),
    contentRuntimeCatalog: catalog,
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
  });
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
  const dependencies = asObjectArray(
    expectProperty(bundle, "dependencies", "bundle"),
    "bundle.dependencies",
  );
  return Object.freeze({
    loaded,
    packId,
    packVersion,
    bundleDigest: loaded.bundleDigest,
    dependencies,
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
        throw new EngineFault(
          "runtime.activation.dependency_kind_unsupported",
          "Required dependency kind cannot be satisfied by Runtime Content Activation v1",
          {
            dependent_pack_id: record.packId,
            dependent_bundle_digest: record.bundleDigest,
            dependency_id: dependencyId,
            dependency_kind: kind,
            package_id: packageId,
          },
        );
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
    if (world.default_stage === undefined) {
      continue;
    }
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
    );
  }
}

function assertStageRefAgainstRequiredModules(
  stageRef: JsonObject,
  path: string,
  record: LoadedBundleRecord,
  dependencyById: ReadonlyMap<string, JsonObject>,
  stageModules: StageModuleRegistry,
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
    return;
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
  stageModules.requireScene(module, sceneId);
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
