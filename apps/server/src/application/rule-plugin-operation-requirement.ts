import {
  EngineFault,
  expectString,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  ContentRulePluginOperationKind,
  ContentRuntimeCatalog,
} from "@luoxia/world-core";

import type { RulePluginDependencyIdentity } from "./rule-plugin-abi.js";

export type KnownRulePluginOperationKind = ContentRulePluginOperationKind;

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
  readonly catalog: ContentRuntimeCatalog;
  readonly bundles: readonly {
    readonly packId: string;
    readonly bundleDigest: string;
  }[];
}

/**
 * Build frozen, deduped operation requirements from the Catalog's single
 * content-owner enumeration. The Server never infers operation_kind from IDs.
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

    const bindings = input.catalog.listRulePluginOperationBindings(lockRef);
    if (bindings === undefined) {
      throw new EngineFault(
        "runtime.activation.catalog_bundle_missing",
        "Activated ContentBundle is not present in ContentRuntimeCatalog for RulePlugin operation enumeration",
        {
          pack_id: bundle.packId,
          bundle_digest: bundle.bundleDigest,
        },
      );
    }
    for (const binding of bindings) {
      const requirement = Object.freeze({
        dependency: dependencyIdentityFromLock(binding.dependency),
        operationId: expectString(
          binding.operation,
          "operation_id",
          "PluginOperationRef",
        ),
        operationKind: binding.operationKind,
        source: binding.source,
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
