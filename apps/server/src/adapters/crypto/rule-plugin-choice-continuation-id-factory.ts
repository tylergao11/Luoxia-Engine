import type { RulePluginChoiceContinuationIdFactory } from "../../application/rule-plugin-executor.js";
import { createUuidV5 } from "./uuid-v5.js";

export function createNodeRulePluginChoiceContinuationIdFactory(): RulePluginChoiceContinuationIdFactory {
  return Object.freeze({
    createContinuationRequestId(parentRequestId: string): string {
      return createUuidV5(
        parentRequestId,
        "rule_plugin.choice.continuation\u0000v1",
      );
    },
  });
}
