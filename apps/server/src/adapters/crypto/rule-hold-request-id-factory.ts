import { EngineFault } from "@luoxia/contracts-runtime";

import type { RuleHoldRequestIdFactory } from "../../application/rule-hold-evaluator.js";
import { createUuidV5 } from "./uuid-v5.js";

export function createNodeRuleHoldRequestIdFactory(): RuleHoldRequestIdFactory {
  return Object.freeze({
    createRequestId(input: {
      readonly packetId: string;
      readonly preconditionPath: string;
    }): string {
      if (input.preconditionPath.length === 0) {
        throw new EngineFault(
          "runtime.rule_hold.precondition_path_invalid",
          "rule.holds precondition path must be non-empty",
        );
      }
      return createUuidV5(
        input.packetId,
        `rule.holds\u0000${input.preconditionPath}`,
      );
    },
  });
}
