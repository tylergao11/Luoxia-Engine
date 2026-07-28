import type {
  ContractSchemaExporter,
  ContractValidator,
  JsonDigest,
} from "@luoxia/contracts-runtime";

import type { RuntimeContentActivationInput } from "../application/runtime-content-activation.js";

export type RuntimeDeploymentActivationInput = Omit<
  RuntimeContentActivationInput,
  "contracts" | "digest"
>;

export interface RuntimeDeploymentFactoryInput {
  readonly contracts: ContractValidator & ContractSchemaExporter;
  readonly digest: JsonDigest;
}

export interface RuntimeDeploymentResources {
  readonly activation: RuntimeDeploymentActivationInput;
  /** Must close every deployment-owned Pool or other external resource. */
  close(): Promise<void>;
}

export type LuoxiaRuntimeDeploymentFactory = (
  input: RuntimeDeploymentFactoryInput,
) => Promise<RuntimeDeploymentResources>;
