import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";
import type {
  RulePluginGateway,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";
import type { RulePluginInvocationJournal } from "./runtime-persistence.js";

export interface RulePluginExecutor {
  execute(
    candidate: unknown,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt>;
}

export interface RulePluginExecutorDependencies {
  readonly gateway: RulePluginGateway;
  readonly journal: RulePluginInvocationJournal;
}

/**
 * Sole production RulePlugin execution path.
 *
 * A fully validated request is durably prepared before the deterministic,
 * no-I/O adapter runs. A surviving prepared row is deliberately replayable;
 * a resolved row is reverified through the same Gateway and returned without
 * invoking the adapter again.
 */
export function createRulePluginExecutor(
  dependencies: RulePluginExecutorDependencies,
): RulePluginExecutor {
  return Object.freeze({
    async execute(
      candidate: unknown,
      modelInvocations: readonly VerifiedModelInvocationReceipt[],
    ): Promise<VerifiedRulePluginInvocationReceipt> {
      const prepared = await dependencies.gateway.prepare(
        candidate,
        modelInvocations,
      );
      const stored = await dependencies.journal.persistPrepared(prepared);
      if (stored.phase === "resolved") {
        return dependencies.gateway.verifyRecorded(
          prepared,
          stored.response.value,
        );
      }

      const receipt = await dependencies.gateway.dispatch(prepared);
      await dependencies.journal.recordResolved(receipt);
      return receipt;
    },
  });
}
