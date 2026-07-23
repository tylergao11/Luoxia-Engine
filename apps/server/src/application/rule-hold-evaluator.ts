import { randomUUID } from "node:crypto";

import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  RuleHoldEvaluator,
} from "@luoxia/world-core/composition";

import type { RulePluginAbiRegistry } from "./rule-plugin-abi.js";
import type { RulePluginGateway } from "./rule-plugin-gateway.js";

const RULE_EVALUATE_KIND = "rule.evaluate";

export interface RuleHoldEvaluatorDependencies {
  readonly catalog: ContentRuntimeCatalog;
  readonly abi: RulePluginAbiRegistry;
  readonly rulePluginGateway: RulePluginGateway;
}

/**
 * Production RuleHoldEvaluator: rule.holds → rule.evaluate via RulePluginGateway.
 * Read-only; never builds PacketProposal or calls applyPacket.
 */
export function createRuleHoldEvaluator(
  dependencies: RuleHoldEvaluatorDependencies,
): RuleHoldEvaluator {
  return new ProductionRuleHoldEvaluator(dependencies);
}

class ProductionRuleHoldEvaluator implements RuleHoldEvaluator {
  readonly #catalog: ContentRuntimeCatalog;
  readonly #abi: RulePluginAbiRegistry;
  readonly #rulePluginGateway: RulePluginGateway;

  public constructor(dependencies: RuleHoldEvaluatorDependencies) {
    this.#catalog = dependencies.catalog;
    this.#abi = dependencies.abi;
    this.#rulePluginGateway = dependencies.rulePluginGateway;
  }

  public async holds(input: {
    readonly rule: JsonObject;
    readonly worldId: string;
    readonly worldRevision: number;
    readonly worldState: JsonObject;
    readonly deterministicContext: JsonObject;
  }): Promise<boolean> {
    const bundleId = expectString(input.rule, "bundle_id", "RuleRef");
    const bundleDigest = expectString(input.rule, "bundle_digest", "RuleRef");
    const ruleId = expectString(input.rule, "rule_id", "RuleRef");

    const binding = this.#catalog.resolveRuleEvaluationBinding({
      bundle_id: bundleId,
      bundle_digest: bundleDigest,
      rule_id: ruleId,
    });
    if (binding === undefined) {
      throw new EngineFault(
        "runtime.rule_hold.binding_unresolved",
        "RuleRef does not resolve to a registered ContentBundle world_law binding",
        {
          bundle_id: bundleId,
          bundle_digest: bundleDigest,
          rule_id: ruleId,
        },
      );
    }

    const packageId = expectString(
      binding.dependency,
      "package_id",
      "DependencyLock",
    );
    const version = expectString(binding.dependency, "version", "DependencyLock");
    const integritySha256 = expectString(
      binding.dependency,
      "integrity_sha256",
      "DependencyLock",
    );

    const registered = this.#abi.requireModuleForDependency({
      package_id: packageId,
      version,
      integrity_sha256: integritySha256,
    });

    this.#abi.requireOperation({
      module: registered,
      operationId: binding.evaluator.operation_id,
      operationKind: RULE_EVALUATE_KIND,
    });

    const argumentsValue = readRuleArguments(input.rule);

    const candidate: JsonObject = Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: randomUUID(),
      plugin_lock: registered.pluginLock,
      operation_id: binding.evaluator.operation_id,
      operation_kind: RULE_EVALUATE_KIND,
      basis_revision: input.worldRevision,
      readonly_world: Object.freeze({
        world_id: input.worldId,
        world_revision: input.worldRevision,
        world_state: input.worldState,
      }),
      deterministic_context: input.deterministicContext,
      input: Object.freeze({
        rule: input.rule,
        arguments: argumentsValue,
      }),
    });

    const receipt = await this.#rulePluginGateway.resolve(candidate, []);
    if (receipt.proposal !== undefined) {
      throw new EngineFault(
        "runtime.rule_hold.unexpected_proposal",
        "rule.evaluate for rule.holds must not produce a PacketProposal",
        {
          rule_id: ruleId,
          request_id: expectString(
            receipt.request.value,
            "request_id",
            "RulePluginRequest",
          ),
        },
      );
    }

    const output = expectJsonObject(
      expectProperty(receipt.response.value, "output", "RulePluginResponse"),
      "RulePluginResponse.output",
    );
    const outputKind = expectString(
      output,
      "output_kind",
      "RulePluginResponse.output",
    );

    if (outputKind !== "validation") {
      throw new EngineFault(
        "runtime.rule_hold.non_boolean_result",
        "rule.holds requires rule.evaluate ValidationOutput; reject and choice.required are not boolean holds",
        {
          rule_id: ruleId,
          output_kind: outputKind,
        },
      );
    }

    const valid = output.valid;
    if (typeof valid !== "boolean") {
      throw new EngineFault(
        "runtime.rule_hold.validation_shape",
        "ValidationOutput.valid must be a boolean",
        { rule_id: ruleId },
      );
    }
    return valid;
  }
}

function readRuleArguments(rule: JsonObject): JsonObject {
  if (!Object.prototype.hasOwnProperty.call(rule, "arguments")) {
    return Object.freeze({});
  }
  const value = expectProperty(rule, "arguments", "RuleRef") as JsonValue;
  return expectJsonObject(value, "RuleRef.arguments");
}
