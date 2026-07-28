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
import type { DeterministicContextAuthority } from "@luoxia/world-core/composition";

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
import type { ServerEnvelopeDocument } from "./server-envelope.js";
import type { StageModuleRegistry } from "./stage-module-registry.js";
import type {
  RuntimeWorldBinding,
  RuntimeWorldBindingResolver,
} from "./runtime-world-binding.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

export interface StageOutcomeCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface StageOutcomeCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly stageModules: StageModuleRegistry;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createStageOutcomeCommandOrchestrator(
  dependencies: StageOutcomeCommandOrchestratorDependencies,
): StageOutcomeCommandOrchestrator {
  return new DefaultStageOutcomeCommandOrchestrator(dependencies);
}

class DefaultStageOutcomeCommandOrchestrator
  implements StageOutcomeCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #commands: CommandJournal;
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #stageModules: StageModuleRegistry;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #finalizer: CommandFinalizer;

  public constructor(
    dependencies: StageOutcomeCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#commands = dependencies.commands;
    this.#worlds = dependencies.worlds;
    this.#stageModules = dependencies.stageModules;
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
    if (candidateKind !== "stage.outcome_proposal") {
      throw new EngineFault(
        "stage_outcome.orchestration.command_kind_invalid",
        "Stage outcome orchestrator accepts only stage.outcome_proposal",
        { command_kind: candidateKind },
      );
    }

    const stored = await this.#commands.receive(envelope.value);
    if (stored.commandKind !== "stage.outcome_proposal") {
      throw new EngineFault(
        "stage_outcome.orchestration.command_kind_invalid",
        "Stage outcome orchestrator recovered a command of another kind",
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
          "stage_outcome.orchestration.completed_output_missing",
          "Completed Stage outcome command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    if (stored.stageOutcomeExecution === undefined) {
      throw new EngineFault(
        "stage_outcome.orchestration.execution_identity_missing",
        "Received Stage outcome command has no persisted RulePlugin request identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }

    const requestInput = createStageOutcomeInput(stored);
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: stored.stageOutcomeExecution.ruleRequestId,
      modelInvocations: [],
      candidateFactory: async () => {
        const binding = await this.#worlds.resolveCurrent(
          stored.session.worldId,
        );
        assertAcceptedWorldAndStageBasis(
          binding,
          stored,
          this.#stageModules,
        );
        const invocation = resolveStageOutcomeBinding(
          binding,
          this.#rulePluginAbi,
        );
        return this.#createRulePluginRequest({
          stored,
          binding,
          invocation,
          requestInput,
        });
      },
    });

    const currentBinding = await this.#worlds.resolveCurrent(
      stored.session.worldId,
    );
    const invocation = resolveStageOutcomeBinding(
      currentBinding,
      this.#rulePluginAbi,
    );
    assertRecoveredStageOutcomeIdentity({
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
      const outputKind = expectString(
        output,
        "output_kind",
        "RulePluginResponse.output",
      );
      if (outputKind === "reject") {
        return this.#finalizer.completeRejected({
          sessionId: stored.session.sessionId,
          commandId: stored.commandId,
          code: expectString(output, "code", "RejectOutput"),
        });
      }
      throw new EngineFault(
        "stage_outcome.orchestration.choice_unresolved",
        "Stage outcome ChoiceSpec requires an explicit client choice protocol before the command can continue",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          request_id: stored.stageOutcomeExecution.ruleRequestId,
          output_kind: outputKind,
        },
      );
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
        "stage_outcome.orchestration.commit_identity_mismatch",
        "Stage outcome packet commit returned an unexpected authoritative identity",
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

    return this.#finalizer.completeStageOutcomeAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision: actualRevision,
      stageInstanceId: expectString(
        stored.message,
        "stage_instance_id",
        "StageOutcomeProposal",
      ),
    });
  }

  #createRulePluginRequest(input: {
    readonly stored: StoredReceivedCommand;
    readonly binding: RuntimeWorldBinding;
    readonly invocation: RuntimeRulePluginInvocationBinding;
    readonly requestInput: JsonObject;
  }): JsonObject {
    const execution = input.stored.stageOutcomeExecution;
    if (execution === undefined) {
      throw new EngineFault(
        "stage_outcome.orchestration.execution_identity_missing",
        "Stage outcome RulePlugin request requires its persisted execution identity",
        {
          session_id: input.stored.session.sessionId,
          command_id: input.stored.commandId,
        },
      );
    }
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
      request_id: execution.ruleRequestId,
      plugin_lock: input.invocation.pluginLock,
      operation_id: input.invocation.operationId,
      operation_kind: "stage_outcome.resolve",
      basis_revision: input.stored.session.worldRevision,
      readonly_world: snapshot,
      deterministic_context: deterministicContext.value,
      input: input.requestInput,
    });
  }
}

function createStageOutcomeInput(
  stored: StoredReceivedCommand,
): JsonObject {
  return Object.freeze({
    control: Object.freeze({
      binding_id: stored.session.controlBindingId,
    }),
    proposal: stored.message,
  });
}

function resolveStageOutcomeBinding(
  binding: RuntimeWorldBinding,
  abi: RulePluginAbiRegistry,
): RuntimeRulePluginInvocationBinding {
  return resolveRulePluginInvocationBinding({
    binding: binding.contentBinding,
    operationKind: "stage_outcome.resolve",
    abi,
    faultOwner: "world_definition.stage_outcome_resolver",
  });
}

function assertAcceptedWorldAndStageBasis(
  binding: RuntimeWorldBinding,
  stored: StoredReceivedCommand,
  stageModules: StageModuleRegistry,
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
      "stage_outcome.orchestration.accepted_basis_changed",
      "Stage outcome request can only be prepared from the command's accepted world basis",
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

  const worldState = expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const stageId = expectString(
    stored.message,
    "stage_instance_id",
    "StageOutcomeProposal",
  );
  const stages = asObjectArray(
    expectProperty(worldState, "stage_instances", "WorldState"),
    "WorldState.stage_instances",
  ).filter(
    (stage) =>
      expectString(stage, "stage_instance_id", "StageInstanceState") ===
      stageId,
  );
  if (stages.length !== 1) {
    throw new EngineFault(
      "stage_outcome.orchestration.stage_match",
      "Stage outcome must identify exactly one StageInstance in the accepted world",
      {
        stage_instance_id: stageId,
        matches: stages.length,
      },
    );
  }
  const stage = stages[0] as JsonObject;
  const expectedStageRevision = expectInteger(
    stored.message,
    "stage_revision",
    "StageOutcomeProposal",
  );
  if (
    expectString(stage, "status", "StageInstanceState") !== "open" ||
    expectInteger(stage, "revision", "StageInstanceState") !==
      expectedStageRevision
  ) {
    throw new EngineFault(
      "stage_outcome.orchestration.stage_basis_mismatch",
      "Stage outcome requires the exact open StageInstance revision",
      {
        stage_instance_id: stageId,
        expected_stage_revision: expectedStageRevision,
        actual_stage_revision: expectInteger(
          stage,
          "revision",
          "StageInstanceState",
        ),
        stage_status: expectString(
          stage,
          "status",
          "StageInstanceState",
        ),
      },
    );
  }

  assertPlayerControlsStageParticipant(worldState, stage, stored);
  assertRegisteredStageOutcomeType(
    stage,
    expectString(
      stored.message,
      "outcome_type",
      "StageOutcomeProposal",
    ),
    stageModules,
  );
}

function assertPlayerControlsStageParticipant(
  worldState: JsonObject,
  stage: JsonObject,
  stored: StoredReceivedCommand,
): void {
  const controls = asObjectArray(
    expectProperty(worldState, "control_bindings", "WorldState"),
    "WorldState.control_bindings",
  ).filter(
    (binding) =>
      expectString(binding, "binding_id", "ControlBinding") ===
      stored.session.controlBindingId,
  );
  const control = controls.length === 1 ? controls[0] : undefined;
  if (
    control === undefined ||
    expectString(control, "controller_kind", "ControlBinding") !==
      "human" ||
    expectString(control, "state", "ControlBinding") !== "active"
  ) {
    throw new EngineFault(
      "stage_outcome.orchestration.control_invalid",
      "Stage outcome requires the Session's active human ControlBinding",
      {
        control_binding_id: stored.session.controlBindingId,
        matches: controls.length,
      },
    );
  }
  const entity = expectJsonObject(
    expectProperty(control, "entity", "ControlBinding"),
    "ControlBinding.entity",
  );
  if (
    expectString(entity, "world_id", "EntityRef") !==
      stored.session.worldId ||
    expectString(entity, "entity_id", "EntityRef") !==
      stored.session.playerEntityId
  ) {
    throw new EngineFault(
      "stage_outcome.orchestration.control_subject_mismatch",
      "Stage outcome Session control does not own the accepted player Entity",
      {
        control_binding_id: stored.session.controlBindingId,
        player_entity_id: stored.session.playerEntityId,
      },
    );
  }
  const participants = asObjectArray(
    expectProperty(stage, "participants", "StageInstanceState"),
    "StageInstanceState.participants",
  );
  if (
    !participants.some(
      (participant) =>
        expectString(participant, "world_id", "EntityRef") ===
          stored.session.worldId &&
        expectString(participant, "entity_id", "EntityRef") ===
          stored.session.playerEntityId,
    )
  ) {
    throw new EngineFault(
      "stage_outcome.orchestration.player_not_participant",
      "Session player must be a participant of the target StageInstance",
      {
        stage_instance_id: expectString(
          stage,
          "stage_instance_id",
          "StageInstanceState",
        ),
        player_entity_id: stored.session.playerEntityId,
      },
    );
  }
}

function assertRegisteredStageOutcomeType(
  stage: JsonObject,
  outcomeType: string,
  registry: StageModuleRegistry,
): void {
  const lock = expectJsonObject(
    expectProperty(stage, "stage_module_lock", "StageInstanceState"),
    "StageInstanceState.stage_module_lock",
  );
  const registered = registry.requireModuleForDependency({
    package_id: expectString(lock, "module_id", "StageModuleLock"),
    version: expectString(
      lock,
      "implementation_version",
      "StageModuleLock",
    ),
    integrity_sha256: expectString(
      lock,
      "implementation_digest",
      "StageModuleLock",
    ),
  });
  if (!jsonEquals(registered.stageModuleLock.value, lock)) {
    throw new EngineFault(
      "stage_outcome.orchestration.module_lock_mismatch",
      "StageInstance lock differs from the registered StageModule",
      {
        stage_instance_id: expectString(
          stage,
          "stage_instance_id",
          "StageInstanceState",
        ),
      },
    );
  }
  const sceneId = expectString(stage, "scene_id", "StageInstanceState");
  registry.requireScene(registered, sceneId);
  const manifest = registered.indexed.document.value;
  const scenes = asObjectArray(
    expectProperty(manifest, "scenes", "StageModuleManifest"),
    "StageModuleManifest.scenes",
  ).filter(
    (scene) =>
      expectString(scene, "scene_id", "StageModuleScene") === sceneId,
  );
  const scene = scenes.length === 1 ? scenes[0] : undefined;
  if (scene === undefined) {
    throw new EngineFault(
      "stage_outcome.orchestration.scene_contract_missing",
      "Registered StageModule did not resolve exactly one scene contract",
      {
        module_id: registered.indexed.moduleId,
        scene_id: sceneId,
        matches: scenes.length,
      },
    );
  }
  const outcomeTypes = expectProperty(
    scene,
    "outcome_types",
    "StageModuleScene",
  );
  if (
    !Array.isArray(outcomeTypes) ||
    !outcomeTypes.includes(outcomeType)
  ) {
    throw new EngineFault(
      "stage_outcome.orchestration.outcome_type_not_declared",
      "Stage outcome_type is not declared by the exact StageModule scene",
      {
        module_id: registered.indexed.moduleId,
        scene_id: sceneId,
        outcome_type: outcomeType,
      },
    );
  }
}

function assertRecoveredStageOutcomeIdentity(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly stored: StoredReceivedCommand;
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly requestInput: JsonObject;
}): void {
  const execution = input.stored.stageOutcomeExecution;
  if (execution === undefined) {
    throw new EngineFault(
      "stage_outcome.orchestration.execution_identity_missing",
      "Recovered Stage outcome command lost its RulePlugin request identity",
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
    input.receipt.basisRevision !== input.stored.session.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      execution.ruleRequestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "stage_outcome.resolve" ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.stored.session.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.stored.session.worldId ||
    expectInteger(readonlyWorld, "world_revision", "WorldSnapshot") !==
      input.stored.session.worldRevision ||
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
      "stage_outcome.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its Stage outcome command identity",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        request_id: execution.ruleRequestId,
      },
    );
  }
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "stage_outcome.orchestration.world_shape_invalid",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
