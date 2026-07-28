import type {
  WorldExtensionExecutionIdentityFactory,
  WorldExtensionExecutionIdentityInput,
} from "../../application/world-extension-orchestrator.js";
import { createUuidV5 } from "./uuid-v5.js";

export function createNodeWorldExtensionExecutionIdentityFactory(): WorldExtensionExecutionIdentityFactory {
  return Object.freeze({
    createRuleRequestId(
      input: WorldExtensionExecutionIdentityInput,
    ): string {
      return createUuidV5(
        input.worldId,
        [
          "world-extension.resolve",
          input.goalPlanId,
          input.goalNodeId,
          input.extensionRequestId,
        ].join("\0"),
      );
    },
  });
}
