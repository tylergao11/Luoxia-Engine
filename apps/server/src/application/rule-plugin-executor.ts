import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
} from "@luoxia/contracts-runtime";
import type { RulePluginChoiceAuthority } from "@luoxia/world-core";

import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";
import type {
  PreparedRulePluginInvocation,
  RulePluginGateway,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";
import type {
  RulePluginInvocationJournal,
  StoredRulePluginInvocation,
} from "./runtime-persistence.js";

export interface RulePluginChoiceEntropySource {
  createEntropyReveal(): string;
}

export interface RulePluginChoiceContinuationIdFactory {
  createContinuationRequestId(parentRequestId: string): string;
}

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
  assertExecutionRoot(
    receipt: VerifiedRulePluginInvocationReceipt,
    expectedRootRequestId: string,
  ): void;
}

export interface RulePluginExecutorDependencies {
  readonly gateway: RulePluginGateway;
  readonly journal: RulePluginInvocationJournal;
  readonly choices: RulePluginChoiceAuthority;
  readonly entropySource: RulePluginChoiceEntropySource;
  readonly continuationIds: RulePluginChoiceContinuationIdFactory;
}

/**
 * Sole production RulePlugin execution path.
 *
 * Every request is durable before deterministic no-I/O dispatch. ChoiceSpec is
 * resolved by World Core, then persisted as a unique parent -> continuation
 * edge before the adapter sees the selected DeterministicContext. Recovery
 * follows the same journaled edge and never draws entropy a second time.
 */
export function createRulePluginExecutor(
  dependencies: RulePluginExecutorDependencies,
): RulePluginExecutor {
  const executionRoots = new WeakMap<object, string>();

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

  const recoverRoot = async (
    requestId: string,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt | undefined> => {
    const stored = await dependencies.journal.readByRequestId(requestId);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.continuation !== undefined) {
      throw new EngineFault(
        "rule_plugin.executor.root_identity_conflict",
        "Recoverable root request_id is already owned by a choice continuation",
        { request_id: requestId },
      );
    }
    const prepared = await dependencies.gateway.prepare(
      stored.request.value,
      modelInvocations,
    );
    return continueStored(prepared, stored);
  };

  const continueChoice = async (
    parent: VerifiedRulePluginInvocationReceipt,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt> => {
    const parentRequestId = expectString(
      parent.request.value,
      "request_id",
      "RulePluginRequest",
    );
    const parentContext = expectProperty(
      parent.request.value,
      "deterministic_context",
      "RulePluginRequest",
    );
    const choiceSpec = expectJsonObject(
      expectProperty(
        parent.response.value,
        "output",
        "RulePluginResponse",
      ),
      "RulePluginResponse.output",
    );

    let stored =
      await dependencies.journal.readChoiceContinuation(parentRequestId);
    if (stored === undefined) {
      const continuationRequestId =
        dependencies.continuationIds.createContinuationRequestId(
          parentRequestId,
        );
      const resolution = dependencies.choices.resolve({
        worldId: parent.worldId,
        parentRequestId,
        continuationRequestId,
        parentContext,
        choiceSpec,
        entropyReveal: dependencies.entropySource.createEntropyReveal(),
      });
      const continuationCandidate = Object.freeze({
        ...parent.request.value,
        request_id: continuationRequestId,
        deterministic_context: expectProperty(
          resolution.value,
          "deterministic_context",
          "ChoiceResolutionEvidence",
        ),
      });
      const prepared = await dependencies.gateway.prepare(
        continuationCandidate,
        modelInvocations,
      );
      stored = await dependencies.journal.persistChoiceContinuation({
        parent,
        invocation: prepared,
        resolution,
      });
    }

    const continuation = stored.continuation;
    if (
      continuation === undefined ||
      continuation.parentRequestId !== parentRequestId
    ) {
      throw new EngineFault(
        "rule_plugin.executor.choice_lineage_missing",
        "Journaled RulePlugin continuation does not belong to its ChoiceSpec parent",
        { parent_request_id: parentRequestId },
      );
    }
    const continuationRequestId = expectString(
      stored.request.value,
      "request_id",
      "RulePluginRequest",
    );
    dependencies.choices.assertAuthentic({
      worldId: parent.worldId,
      parentRequestId,
      continuationRequestId,
      parentContext,
      choiceSpec,
      candidate: continuation.resolution.value,
    });
    const expectedRequest = Object.freeze({
      ...parent.request.value,
      request_id: continuationRequestId,
      deterministic_context: expectProperty(
        continuation.resolution.value,
        "deterministic_context",
        "ChoiceResolutionEvidence",
      ),
    });
    if (!jsonEquals(stored.request.value, expectedRequest)) {
      throw new EngineFault(
        "rule_plugin.executor.choice_request_mismatch",
        "Journaled RulePlugin continuation must preserve every parent request field except request_id and DeterministicContext",
        {
          parent_request_id: parentRequestId,
          continuation_request_id: continuationRequestId,
        },
      );
    }
    const prepared = await dependencies.gateway.prepare(
      stored.request.value,
      modelInvocations,
    );
    return continueStored(prepared, stored);
  };

  const resolveTerminal = async (
    rootRequestId: string,
    initial: VerifiedRulePluginInvocationReceipt,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt> => {
    let receipt = initial;
    const seen = new Set<string>();
    for (;;) {
      const requestId = expectString(
        receipt.request.value,
        "request_id",
        "RulePluginRequest",
      );
      if (seen.has(requestId)) {
        throw new EngineFault(
          "rule_plugin.executor.choice_cycle",
          "RulePlugin choice continuation chain contains a request cycle",
          { root_request_id: rootRequestId, request_id: requestId },
        );
      }
      seen.add(requestId);
      const output = expectJsonObject(
        expectProperty(
          receipt.response.value,
          "output",
          "RulePluginResponse",
        ),
        "RulePluginResponse.output",
      );
      const outputKind = expectString(
        output,
        "output_kind",
        "RulePluginResponse.output",
      );
      if (outputKind !== "choice.required") {
        executionRoots.set(receipt, rootRequestId);
        return receipt;
      }
      receipt = await continueChoice(receipt, modelInvocations);
    }
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
      const rootRequestId = expectString(
        prepared.request.value,
        "request_id",
        "RulePluginRequest",
      );
      const stored = await dependencies.journal.persistPrepared(prepared);
      const initial = await continueStored(prepared, stored);
      return resolveTerminal(rootRequestId, initial, modelInvocations);
    },
    async executeRecoverable(input: {
      readonly requestId: string;
      readonly candidateFactory: () => unknown | Promise<unknown>;
      readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
    }): Promise<VerifiedRulePluginInvocationReceipt> {
      const recovered = await recoverRoot(
        input.requestId,
        input.modelInvocations,
      );
      if (recovered !== undefined) {
        return resolveTerminal(
          input.requestId,
          recovered,
          input.modelInvocations,
        );
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
        const initial = await continueStored(prepared, stored);
        return resolveTerminal(
          input.requestId,
          initial,
          input.modelInvocations,
        );
      } catch (error: unknown) {
        if (
          !(error instanceof EngineFault) ||
          error.code !== "rule_plugin.journal.request_id_conflict"
        ) {
          throw error;
        }
        const raced = await recoverRoot(
          input.requestId,
          input.modelInvocations,
        );
        if (raced === undefined) {
          throw error;
        }
        return resolveTerminal(
          input.requestId,
          raced,
          input.modelInvocations,
        );
      }
    },
    assertExecutionRoot(
      receipt: VerifiedRulePluginInvocationReceipt,
      expectedRootRequestId: string,
    ): void {
      const actualRootRequestId = executionRoots.get(receipt);
      if (actualRootRequestId === undefined) {
        throw new EngineFault(
          "rule_plugin.executor.receipt_not_terminal",
          "RulePlugin receipt was not returned as a terminal result by this Executor",
          { expected_root_request_id: expectedRootRequestId },
        );
      }
      if (actualRootRequestId !== expectedRootRequestId) {
        throw new EngineFault(
          "rule_plugin.executor.root_identity_mismatch",
          "RulePlugin terminal receipt belongs to a different root request",
          {
            expected_root_request_id: expectedRootRequestId,
            actual_root_request_id: actualRootRequestId,
          },
        );
      }
    },
  });
}
