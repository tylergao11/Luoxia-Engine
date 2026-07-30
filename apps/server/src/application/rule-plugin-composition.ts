import type {
  ContractValidator,
  JsonDigest,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  ContentUpgradeAuthorizationAuthority,
  DeterministicContextAuthority,
  StateMachineContractAuthority,
} from "@luoxia/world-core";

import {
  RulePluginGateway,
  type RulePluginAdapter,
} from "./rule-plugin-gateway.js";
import type { ModelInvocationProvenanceVerifier } from "./model-gateway.js";
import {
  createRulePluginSemanticGate,
  type RulePluginContentUpgradeClock,
} from "./rule-plugin-semantic-gate.js";
import type { StageContractAuthority } from "./stage-contract-authority.js";

export interface RulePluginGatewayDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly catalog: ContentRuntimeCatalog;
  readonly adapter: RulePluginAdapter;
  readonly modelProvenance: ModelInvocationProvenanceVerifier;
  readonly deterministicContextAuthority: DeterministicContextAuthority;
  readonly contentUpgradeAuthorizationAuthority:
    ContentUpgradeAuthorizationAuthority;
  readonly contentUpgradeClock: RulePluginContentUpgradeClock;
  readonly stageContracts: StageContractAuthority;
  readonly stateMachineContracts: StateMachineContractAuthority;
}

/**
 * Composition root helper for RulePlugin resolution.
 * Only the server composition root should call this. Every resolve call must
 * also supply the current request scope's verified model invocation receipts;
 * they are deliberately not stored on the gateway or inferred globally.
 */
export function createRulePluginGateway(
  dependencies: RulePluginGatewayDependencies,
): RulePluginGateway {
  return new RulePluginGateway(
    dependencies.contracts,
    dependencies.digest,
    dependencies.adapter,
    createRulePluginSemanticGate({
      contracts: dependencies.contracts,
      digest: dependencies.digest,
      catalog: dependencies.catalog,
      contentUpgradeAuthorizations:
        dependencies.contentUpgradeAuthorizationAuthority,
      contentUpgradeClock: dependencies.contentUpgradeClock,
      stageContracts: dependencies.stageContracts,
      stateMachineContracts: dependencies.stateMachineContracts,
    }),
    dependencies.modelProvenance,
    dependencies.deterministicContextAuthority,
  );
}
