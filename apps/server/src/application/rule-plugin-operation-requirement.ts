import {
  CONTRACT_REF,
  EngineFault,
  expectString,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
} from "@luoxia/world-core/composition";

import type { RulePluginDependencyIdentity } from "./rule-plugin-abi.js";

/**
 * Only operation_kinds with explicit content-ownership in this gate.
 * Other PluginOperationRef fields remain unmapped.
 */
export type KnownRulePluginOperationKind =
  | "rule.evaluate"
  | "navigation.resolve";

/**
 * Internal activation plan entry: ContentBundle reference → ABI operation.
 * Not a JSON contract; dependency identity is derived from Catalog-resolved locks.
 */
export interface RulePluginOperationRequirement {
  readonly dependency: RulePluginDependencyIdentity;
  readonly operationId: string;
  readonly operationKind: KnownRulePluginOperationKind;
  /** Content source for error localization only. */
  readonly source: JsonObject;
}

export interface CollectRulePluginOperationRequirementsInput {
  readonly contracts: ContractValidator;
  readonly catalog: ContentRuntimeCatalog;
  readonly bundles: readonly {
    readonly packId: string;
    readonly packVersion: string;
    readonly bundleDigest: string;
  }[];
}

/**
 * Build frozen, deduped operation requirements from Catalog-resolved objects only.
 * Does not re-scan raw ContentBundle structure beyond Catalog list/resolve APIs.
 */
export function collectRulePluginOperationRequirements(
  input: CollectRulePluginOperationRequirementsInput,
): readonly RulePluginOperationRequirement[] {
  const byKey = new Map<string, RulePluginOperationRequirement>();

  for (const bundle of input.bundles) {
    const lockRef = Object.freeze({
      bundle_id: bundle.packId,
      bundle_digest: bundle.bundleDigest,
    });

    const laws = input.catalog.listWorldLaws(lockRef);
    if (laws === undefined) {
      throw new EngineFault(
        "runtime.activation.catalog_bundle_missing",
        "Activated ContentBundle is not present in ContentRuntimeCatalog for WorldLaw enumeration",
        {
          pack_id: bundle.packId,
          bundle_digest: bundle.bundleDigest,
        },
      );
    }
    for (const law of laws) {
      const lawId = expectString(law, "law_id", "WorldLaw");
      const binding = input.catalog.resolveRuleEvaluationBinding({
        bundle_id: bundle.packId,
        bundle_digest: bundle.bundleDigest,
        rule_id: lawId,
      });
      if (binding === undefined) {
        throw new EngineFault(
          "runtime.activation.world_law_unresolved",
          "Registered WorldLaw could not be resolved to a rule_plugin evaluator binding",
          {
            pack_id: bundle.packId,
            bundle_digest: bundle.bundleDigest,
            law_id: lawId,
          },
        );
      }
      const requirement = Object.freeze({
        dependency: dependencyIdentityFromLock(binding.dependency),
        operationId: binding.evaluator.operation_id,
        operationKind: "rule.evaluate" as const,
        source: Object.freeze({
          pack_id: bundle.packId,
          bundle_digest: bundle.bundleDigest,
          law_id: lawId,
        }),
      });
      byKey.set(requirementKey(requirement), requirement);
    }

    const worlds = input.catalog.listWorldDefinitions(lockRef);
    if (worlds === undefined) {
      throw new EngineFault(
        "runtime.activation.catalog_bundle_missing",
        "Activated ContentBundle is not present in ContentRuntimeCatalog for WorldDefinition enumeration",
        {
          pack_id: bundle.packId,
          bundle_digest: bundle.bundleDigest,
        },
      );
    }
    for (const world of worlds) {
      const worldId = expectString(world, "world_id", "WorldDefinition");
      const lockCandidate = Object.freeze({
        root_bundle_lock: Object.freeze({
          pack_id: bundle.packId,
          pack_version: bundle.packVersion,
          bundle_digest: bundle.bundleDigest,
        }),
        world_definition_id: worldId,
      });
      const worldContentLock = input.contracts.assertObject(
        CONTRACT_REF.worldContentLock,
        lockCandidate,
      );
      const contentBinding =
        input.catalog.resolveWorldContentBinding(worldContentLock);
      const operationId = expectString(
        contentBinding.navigationResolver.operation,
        "operation_id",
        "PluginOperationRef",
      );
      const requirement = Object.freeze({
        dependency: dependencyIdentityFromLock(
          contentBinding.navigationResolver.dependency,
        ),
        operationId,
        operationKind: "navigation.resolve" as const,
        source: Object.freeze({
          pack_id: bundle.packId,
          bundle_digest: bundle.bundleDigest,
          world_id: worldId,
          resolver: "navigation_resolver",
        }),
      });
      byKey.set(requirementKey(requirement), requirement);
    }
  }

  return Object.freeze([...byKey.values()]);
}

function dependencyIdentityFromLock(
  dependency: JsonObject,
): RulePluginDependencyIdentity {
  return Object.freeze({
    package_id: expectString(dependency, "package_id", "DependencyLock"),
    version: expectString(dependency, "version", "DependencyLock"),
    integrity_sha256: expectString(
      dependency,
      "integrity_sha256",
      "DependencyLock",
    ),
  });
}

function requirementKey(requirement: RulePluginOperationRequirement): string {
  return [
    requirement.dependency.package_id,
    requirement.dependency.version,
    requirement.dependency.integrity_sha256,
    requirement.operationId,
    requirement.operationKind,
  ].join("\u0000");
}
