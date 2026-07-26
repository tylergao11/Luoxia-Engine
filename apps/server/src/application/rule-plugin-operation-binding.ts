import {
  EngineFault,
  expectString,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  ContentRulePluginOperationBinding,
  ContentRulePluginOperationKind,
  WorldContentBinding,
} from "@luoxia/world-core/composition";

import type {
  RulePluginAbiRegistry,
  RulePluginDependencyIdentity,
} from "./rule-plugin-abi.js";

export interface RuntimeRulePluginInvocationBinding {
  readonly operationId: string;
  readonly pluginLock: JsonObject;
}

/**
 * Resolve one exact content owner to the activation-owned RulePlugin ABI.
 * `sourcePredicate` is required when an operation kind has more than one
 * legitimate owner, such as state_machine.advance.
 */
export function resolveRulePluginInvocationBinding(input: {
  readonly binding: WorldContentBinding;
  readonly operationKind: ContentRulePluginOperationKind;
  readonly abi: RulePluginAbiRegistry;
  readonly sourcePredicate?: (
    candidate: ContentRulePluginOperationBinding,
  ) => boolean;
  readonly faultOwner: string;
}): RuntimeRulePluginInvocationBinding {
  const matches = input.binding.rulePluginOperations.filter(
    (candidate) =>
      candidate.operationKind === input.operationKind &&
      (input.sourcePredicate?.(candidate) ?? true),
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "runtime.rule_plugin.operation_binding_count",
      "Runtime content must select exactly one RulePlugin operation for the requested owner",
      {
        pack_id: input.binding.packId,
        bundle_digest: input.binding.bundleDigest,
        operation_kind: input.operationKind,
        owner: input.faultOwner,
        matches: matches.length,
      },
    );
  }

  const selected = matches[0] as ContentRulePluginOperationBinding;
  const dependency: RulePluginDependencyIdentity = Object.freeze({
    package_id: expectString(
      selected.dependency,
      "package_id",
      "DependencyLock",
    ),
    version: expectString(
      selected.dependency,
      "version",
      "DependencyLock",
    ),
    integrity_sha256: expectString(
      selected.dependency,
      "integrity_sha256",
      "DependencyLock",
    ),
  });
  const operationId = expectString(
    selected.operation,
    "operation_id",
    "PluginOperationRef",
  );
  const registered = input.abi.requireOperationForDependency({
    dependency,
    operationId,
    operationKind: input.operationKind,
  });
  return Object.freeze({
    operationId,
    pluginLock: registered.pluginLock,
  });
}
