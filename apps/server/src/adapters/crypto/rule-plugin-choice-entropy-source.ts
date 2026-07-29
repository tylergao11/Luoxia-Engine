import { randomBytes } from "node:crypto";

import type { RulePluginChoiceEntropySource } from "../../application/rule-plugin-executor.js";

export function createNodeRulePluginChoiceEntropySource(): RulePluginChoiceEntropySource {
  return Object.freeze({
    createEntropyReveal(): string {
      return randomBytes(32).toString("hex");
    },
  });
}
