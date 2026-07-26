import {
  EngineFault,
  expectString,
} from "@luoxia/contracts-runtime";

import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";
import type {
  RulePluginGateway,
  PreparedRulePluginInvocation,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";
import type {
  RulePluginInvocationJournal,
  StoredRulePluginInvocation,
} from "./runtime-persistence.js";

export interface RulePluginExecutor {
  execute(
    candidate: unknown,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt>;
  executeRecoverable(input: {
    readonly requestId: string;
    readonly candidateFactory: () => unknown | Promise<unknown>;
    readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
  }): Promise<VerifiedRulePluginInvocationReceipt>;
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
  const continueStored = async (
    prepared: PreparedRulePluginInvocation,
    stored: StoredRulePluginInvocation,
  ): Promise<VerifiedRulePluginInvocationReceipt> => {
    if (stored.phase === "resolved") {
      return dependencies.gateway.verifyRecorded(
        prepared,
        stored.response.value,
      );
    }

    const receipt = await dependencies.gateway.dispatch(prepared);
    await dependencies.journal.recordResolved(receipt);
    return receipt;
  };

  const recover = async (
    requestId: string,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt | undefined> => {
    const stored = await dependencies.journal.readByRequestId(requestId);
    if (stored === undefined) {
      return undefined;
    }
    const prepared = await dependencies.gateway.prepare(
      stored.request.value,
      modelInvocations,
    );
    return continueStored(prepared, stored);
  };

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
      return continueStored(prepared, stored);
    },
    async executeRecoverable(input: {
      readonly requestId: string;
      readonly candidateFactory: () => unknown | Promise<unknown>;
      readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
    }): Promise<VerifiedRulePluginInvocationReceipt> {
      const recovered = await recover(
        input.requestId,
        input.modelInvocations,
      );
      if (recovered !== undefined) {
        return recovered;
      }

      const candidate = await input.candidateFactory();
      const prepared = await dependencies.gateway.prepare(
        candidate,
        input.modelInvocations,
      );
      const preparedRequestId = expectString(
        prepared.request.value,
        "request_id",
        "RulePluginRequest",
      );
      if (preparedRequestId !== input.requestId) {
        throw new EngineFault(
          "rule_plugin.executor.request_identity_mismatch",
          "Recoverable RulePlugin candidate does not use its Command Journal request identity",
          {
            expected_request_id: input.requestId,
            actual_request_id: preparedRequestId,
          },
        );
      }
      try {
        const stored =
          await dependencies.journal.persistPrepared(prepared);
        return continueStored(prepared, stored);
      } catch (error: unknown) {
        if (
          !(error instanceof EngineFault) ||
          error.code !== "rule_plugin.journal.request_id_conflict"
        ) {
          throw error;
        }
        const raced = await recover(
          input.requestId,
          input.modelInvocations,
        );
        if (raced === undefined) {
          throw error;
        }
        return raced;
      }
    },
  });
}
