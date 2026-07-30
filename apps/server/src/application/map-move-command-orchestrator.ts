import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type { DeterministicContextAuthority } from "@luoxia/world-core";

import type {
  CommandJournal,
  StoredReceivedCommand,
} from "./command-journal.js";
import type { CommandFinalizer } from "./command-finalizer.js";
import type { RulePluginAbiRegistry } from "./rule-plugin-abi.js";
import type { VerifiedRulePluginInvocationReceipt } from "./rule-plugin-gateway.js";
import {
  resolveRulePluginInvocationBinding,
  type RuntimeRulePluginInvocationBinding,
} from "./rule-plugin-operation-binding.js";
import type { RulePluginExecutor } from "./rule-plugin-executor.js";
import type {
  RuntimeWorldBinding,
  RuntimeWorldBindingResolver,
} from "./runtime-world-binding.js";
import type { ServerEnvelopeDocument } from "./server-envelope.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

export interface MapMoveCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface MapMoveCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createMapMoveCommandOrchestrator(
  dependencies: MapMoveCommandOrchestratorDependencies,
): MapMoveCommandOrchestrator {
  return new DefaultMapMoveCommandOrchestrator(dependencies);
}

class DefaultMapMoveCommandOrchestrator
  implements MapMoveCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #commands: CommandJournal;
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #finalizer: CommandFinalizer;

  public constructor(
    dependencies: MapMoveCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#commands = dependencies.commands;
    this.#worlds = dependencies.worlds;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#mutations = dependencies.mutations;
    this.#finalizer = dependencies.finalizer;
  }

  public async execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      clientEnvelopeCandidate,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ClientEnvelope"),
      "ClientEnvelope.message",
    );
    const candidateKind = expectString(
      message,
      "type",
      "ClientMessage",
    );
    if (candidateKind !== "map.move") {
      throw new EngineFault(
        "navigation.orchestration.command_kind_invalid",
        "Navigation orchestrator accepts only map.move",
        { command_kind: candidateKind },
      );
    }

    const stored = await this.#commands.receive(envelope.value);
    if (stored.commandKind !== "map.move") {
      throw new EngineFault(
        "navigation.orchestration.command_kind_invalid",
        "Navigation orchestrator recovered a command of another kind",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          command_kind: stored.commandKind,
        },
      );
    }
    if (stored.phase === "completed") {
      const replay = await this.#finalizer.readCompleted(
        stored.session.sessionId,
        stored.commandId,
      );
      if (replay === undefined) {
        throw new EngineFault(
          "navigation.orchestration.completed_output_missing",
          "Completed navigation command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    if (stored.navigationExecution === undefined) {
      throw new EngineFault(
        "navigation.orchestration.execution_identity_missing",
        "Received navigation command has no persisted RulePlugin request identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }
    const navigationExecution = stored.navigationExecution;

    const requestInput = createNavigationInput(stored);
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: navigationExecution.ruleRequestId,
      modelInvocations: [],
      candidateFactory: async () => {
        const binding = await this.#worlds.resolveCurrent(
          stored.session.worldId,
        );
        assertAcceptedWorldBasis(binding, stored);
        const invocation = resolveNavigationBinding(
          binding,
          this.#rulePluginAbi,
        );
        return this.#createRulePluginRequest({
          stored,
          binding,
          invocation,
          requestId: navigationExecution.ruleRequestId,
          requestInput,
        });
      },
    });

    const currentBinding = await this.#worlds.resolveCurrent(
      stored.session.worldId,
    );
    const invocation = resolveNavigationBinding(
      currentBinding,
      this.#rulePluginAbi,
    );
    assertRecoveredNavigationIdentity({
      receipt,
      stored,
      invocation,
      requestInput,
    });

    if (receipt.proposal === undefined) {
      const output = expectJsonObject(
        expectProperty(
          receipt.response.value,
          "output",
          "RulePluginResponse",
        ),
        "RulePluginResponse.output",
      );
      if (
        expectString(
          output,
          "output_kind",
          "RulePluginResponse.output",
        ) !== "reject"
      ) {
        throw new EngineFault(
          "navigation.orchestration.output_unresolved",
          "Navigation RulePlugin returned neither a packet proposal nor Reject",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
            request_id: navigationExecution.ruleRequestId,
          },
        );
      }
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: expectString(output, "code", "RejectOutput"),
      });
    }

    const result = await this.#mutations.commitRulePluginReceipt(receipt);
    const expectedRevision = stored.session.worldRevision + 1;
    const actualRevision = expectInteger(
      result.value,
      "world_revision",
      "ApplyPacketResult",
    );
    const proposalId = expectString(
      receipt.proposal.value,
      "proposal_id",
      "PacketProposal",
    );
    const resultStatus = expectString(
      result.value,
      "status",
      "ApplyPacketResult",
    );
    if (
      !Number.isSafeInteger(expectedRevision) ||
      actualRevision !== expectedRevision ||
      expectString(result.value, "packet_id", "ApplyPacketResult") !==
        proposalId ||
      (resultStatus !== "committed" && resultStatus !== "duplicate")
    ) {
      throw new EngineFault(
        "navigation.orchestration.commit_identity_mismatch",
        "Navigation packet commit returned an unexpected authoritative identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          proposal_id: proposalId,
          expected_world_revision: Number.isSafeInteger(expectedRevision)
            ? expectedRevision
            : null,
          actual_world_revision: actualRevision,
          result_status: resultStatus,
        },
      );
    }

    return this.#finalizer.completeWorldAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision: actualRevision,
    });
  }

  #createRulePluginRequest(input: {
    readonly stored: StoredReceivedCommand;
    readonly binding: RuntimeWorldBinding;
    readonly invocation: RuntimeRulePluginInvocationBinding;
    readonly requestId: string;
    readonly requestInput: JsonObject;
  }): JsonObject {
    const snapshot = input.binding.record.snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshot, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: input.stored.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [],
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: input.requestId,
      plugin_lock: input.invocation.pluginLock,
      operation_id: input.invocation.operationId,
      operation_kind: "navigation.resolve",
      basis_revision: input.stored.session.worldRevision,
      readonly_world: snapshot,
      deterministic_context: deterministicContext.value,
      input: input.requestInput,
    });
  }
}

function createNavigationInput(
  stored: StoredReceivedCommand,
): JsonObject {
  return Object.freeze({
    control: Object.freeze({
      binding_id: stored.session.controlBindingId,
    }),
    actor: Object.freeze({
      entity_id: stored.session.playerEntityId,
    }),
    destination: expectJsonObject(
      expectProperty(stored.message, "destination", "MapMove"),
      "MapMove.destination",
    ),
  });
}

function resolveNavigationBinding(
  binding: RuntimeWorldBinding,
  abi: RulePluginAbiRegistry,
): RuntimeRulePluginInvocationBinding {
  return resolveRulePluginInvocationBinding({
    binding: binding.contentBinding,
    operationKind: "navigation.resolve",
    abi,
    faultOwner: "world_definition.navigation_resolver",
  });
}

function assertAcceptedWorldBasis(
  binding: RuntimeWorldBinding,
  stored: StoredReceivedCommand,
): void {
  const snapshot = binding.record.snapshot.value;
  const actualWorldId = expectString(
    snapshot,
    "world_id",
    "WorldSnapshot",
  );
  const actualRevision = expectInteger(
    snapshot,
    "world_revision",
    "WorldSnapshot",
  );
  if (
    actualWorldId !== stored.session.worldId ||
    actualRevision !== stored.session.worldRevision
  ) {
    throw new EngineFault(
      "navigation.orchestration.accepted_basis_changed",
      "Navigation RulePlugin request can only be prepared from the command's accepted world basis",
      {
        session_id: stored.session.sessionId,
        command_id: stored.commandId,
        expected_world_id: stored.session.worldId,
        actual_world_id: actualWorldId,
        expected_world_revision: stored.session.worldRevision,
        actual_world_revision: actualRevision,
      },
    );
  }
}

function assertRecoveredNavigationIdentity(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly stored: StoredReceivedCommand;
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly requestInput: JsonObject;
}): void {
  const execution = input.stored.navigationExecution;
  if (execution === undefined) {
    throw new EngineFault(
      "navigation.orchestration.execution_identity_missing",
      "Recovered navigation command lost its RulePlugin request identity",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
      },
    );
  }
  const request = input.receipt.request.value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  if (
    input.receipt.worldId !== input.stored.session.worldId ||
    input.receipt.basisRevision !==
      input.stored.session.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      execution.ruleRequestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "navigation.resolve" ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.stored.session.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.stored.session.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== input.stored.session.worldRevision ||
    !jsonEquals(
      expectProperty(request, "plugin_lock", "RulePluginRequest"),
      input.invocation.pluginLock,
    ) ||
    !jsonEquals(
      expectProperty(request, "input", "RulePluginRequest"),
      input.requestInput,
    )
  ) {
    throw new EngineFault(
      "navigation.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its navigation command identity",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        request_id: execution.ruleRequestId,
      },
    );
  }
}
