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
  type JsonValue,
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

const PLAYER_REQUESTED_REASON = "player_requested";

export interface DialogueCloseCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface DialogueCloseCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createDialogueCloseCommandOrchestrator(
  dependencies: DialogueCloseCommandOrchestratorDependencies,
): DialogueCloseCommandOrchestrator {
  return new DefaultDialogueCloseCommandOrchestrator(dependencies);
}

class DefaultDialogueCloseCommandOrchestrator
  implements DialogueCloseCommandOrchestrator
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
    dependencies: DialogueCloseCommandOrchestratorDependencies,
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
    const candidateKind = expectString(message, "type", "ClientMessage");
    if (candidateKind !== "dialogue.close") {
      throw new EngineFault(
        "dialogue_close.orchestration.command_kind_invalid",
        "Dialogue-close orchestrator accepts only dialogue.close",
        { command_kind: candidateKind },
      );
    }

    const stored = await this.#commands.receive(envelope.value);
    if (stored.commandKind !== "dialogue.close") {
      throw new EngineFault(
        "dialogue_close.orchestration.command_kind_invalid",
        "Dialogue-close orchestrator recovered a command of another kind",
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
          "dialogue_close.orchestration.completed_output_missing",
          "Completed dialogue-close command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    if (stored.dialogueCloseExecution === undefined) {
      throw new EngineFault(
        "dialogue_close.orchestration.execution_identity_missing",
        "Received dialogue-close command has no persisted RulePlugin request identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }
    const execution = stored.dialogueCloseExecution;

    let receipt: VerifiedRulePluginInvocationReceipt;
    try {
      receipt = await this.#rulePlugins.executeRecoverable({
        requestId: execution.ruleRequestId,
        modelInvocations: [],
        candidateFactory: async () => {
          const binding = await this.#worlds.resolveCurrent(
            stored.session.worldId,
          );
          assertAcceptedWorldBasis(binding, stored);
          const invocation = resolveDialogueCloseBinding(
            binding,
            this.#rulePluginAbi,
          );
          return this.#createRulePluginRequest({
            stored,
            binding,
            invocation,
            requestId: execution.ruleRequestId,
          });
        },
      });
    } catch (error: unknown) {
      if (!isPlayerDialogueRejection(error)) {
        throw error;
      }
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: error.code,
      });
    }

    const currentBinding = await this.#worlds.resolveCurrent(
      stored.session.worldId,
    );
    const invocation = resolveDialogueCloseBinding(
      currentBinding,
      this.#rulePluginAbi,
    );
    assertRecoveredDialogueCloseIdentity({
      receipt,
      stored,
      invocation,
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
          "dialogue_close.orchestration.output_unresolved",
          "Dialogue-close RulePlugin returned neither a packet proposal nor Reject",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
            request_id: execution.ruleRequestId,
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
        "dialogue_close.orchestration.commit_identity_mismatch",
        "Dialogue-close packet commit returned an unexpected authoritative identity",
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
  }): JsonObject {
    const snapshot = input.binding.record.snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshot, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dialogueRevision = requirePlayerOwnedActiveDialogue({
      snapshot,
      stored: input.stored,
    });
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
      operation_kind: "dialogue.close",
      basis_revision: input.stored.session.worldRevision,
      readonly_world: snapshot,
      deterministic_context: deterministicContext.value,
      input: Object.freeze({
        dialogue_id: expectString(
          input.stored.message,
          "dialogue_id",
          "DialogueClose",
        ),
        expected_revision: dialogueRevision,
        reason_code: PLAYER_REQUESTED_REASON,
      }),
    });
  }
}

function resolveDialogueCloseBinding(
  binding: RuntimeWorldBinding,
  abi: RulePluginAbiRegistry,
): RuntimeRulePluginInvocationBinding {
  return resolveRulePluginInvocationBinding({
    binding: binding.contentBinding,
    operationKind: "dialogue.close",
    abi,
    faultOwner: "world_definition.dialogue_close_resolver",
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
      "dialogue_close.orchestration.accepted_basis_changed",
      "Dialogue-close RulePlugin request can only be prepared from the command's accepted world basis",
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

function requirePlayerOwnedActiveDialogue(input: {
  readonly snapshot: JsonObject;
  readonly stored: StoredReceivedCommand;
}): number {
  const dialogueId = expectString(
    input.stored.message,
    "dialogue_id",
    "DialogueClose",
  );
  const worldState = expectJsonObject(
    expectProperty(input.snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const dialogues = asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  ).filter(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueRecord") ===
      dialogueId,
  );
  if (dialogues.length === 0) {
    throw new EngineFault(
      "dialogue_close.dialogue_missing",
      "Client can close only an existing dialogue",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        dialogue_id: dialogueId,
      },
    );
  }
  if (dialogues.length !== 1) {
    throw new EngineFault(
      "dialogue_close.orchestration.world_shape_invalid",
      "WorldState contains duplicate dialogue identities",
      {
        world_id: input.stored.session.worldId,
        dialogue_id: dialogueId,
        matches: dialogues.length,
      },
    );
  }
  const dialogue = dialogues[0] as JsonObject;
  if (expectString(dialogue, "status", "DialogueRecord") !== "active") {
    throw new EngineFault(
      "dialogue_close.dialogue_not_active",
      "Client can close only an active dialogue",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        dialogue_id: dialogueId,
      },
    );
  }
  const participantMatches = asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).filter((participant) => {
    if (
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) !== "entity"
    ) {
      return false;
    }
    const entity = expectJsonObject(
      expectProperty(
        participant,
        "entity",
        "DialogueParticipantRef",
      ),
      "DialogueParticipantRef.entity",
    );
    return (
      expectString(entity, "world_id", "EntityRef") ===
        input.stored.session.worldId &&
      expectString(entity, "entity_id", "EntityRef") ===
        input.stored.session.playerEntityId
    );
  });
  if (participantMatches.length === 0) {
    throw new EngineFault(
      "dialogue_close.player_not_participant",
      "Client can close only a dialogue containing its controlled player entity",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        dialogue_id: dialogueId,
        player_entity_id: input.stored.session.playerEntityId,
      },
    );
  }
  if (participantMatches.length !== 1) {
    throw new EngineFault(
      "dialogue_close.orchestration.world_shape_invalid",
      "Dialogue contains duplicate references to the controlled player entity",
      {
        world_id: input.stored.session.worldId,
        dialogue_id: dialogueId,
        player_entity_id: input.stored.session.playerEntityId,
      },
    );
  }
  return expectInteger(dialogue, "revision", "DialogueRecord");
}

function assertRecoveredDialogueCloseIdentity(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly stored: StoredReceivedCommand;
  readonly invocation: RuntimeRulePluginInvocationBinding;
}): void {
  const execution = input.stored.dialogueCloseExecution;
  if (execution === undefined) {
    throw new EngineFault(
      "dialogue_close.orchestration.execution_identity_missing",
      "Recovered dialogue-close command lost its RulePlugin request identity",
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
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const expectedDialogueRevision = requirePlayerOwnedActiveDialogue({
    snapshot: readonlyWorld,
    stored: input.stored,
  });
  const expectedRequestInput = Object.freeze({
    dialogue_id: expectString(
      input.stored.message,
      "dialogue_id",
      "DialogueClose",
    ),
    expected_revision: expectedDialogueRevision,
    reason_code: PLAYER_REQUESTED_REASON,
  });
  if (
    input.receipt.worldId !== input.stored.session.worldId ||
    input.receipt.basisRevision !==
      input.stored.session.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      execution.ruleRequestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "dialogue.close" ||
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
    !jsonEquals(requestInput, expectedRequestInput)
  ) {
    throw new EngineFault(
      "dialogue_close.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its dialogue-close command identity",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        request_id: execution.ruleRequestId,
      },
    );
  }
}

function isPlayerDialogueRejection(
  error: unknown,
): error is EngineFault {
  return (
    error instanceof EngineFault &&
    (error.code === "dialogue_close.dialogue_missing" ||
      error.code === "dialogue_close.dialogue_not_active" ||
      error.code === "dialogue_close.player_not_participant")
  );
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "dialogue_close.orchestration.world_shape_invalid",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
