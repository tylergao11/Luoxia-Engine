import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRulePluginOperationBinding,
  DeterministicContextAuthority,
} from "@luoxia/world-core/composition";

import type { DayCycleExecutionIdentityJournal } from "./day-cycle-execution-identity.js";
import type {
  RulePluginAbiRegistry,
} from "./rule-plugin-abi.js";
import type { RulePluginExecutor } from "./rule-plugin-executor.js";
import type {
  RuntimeRulePluginInvocationBinding,
} from "./rule-plugin-operation-binding.js";
import { resolveRulePluginInvocationBinding } from "./rule-plugin-operation-binding.js";
import type {
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";
import type {
  RuntimeModelFacades,
} from "./model-request-assembly.js";
import type {
  VerifiedModelInvocationReceipt,
} from "./model-gateway.js";
import type {
  RuntimeWorldBinding,
  RuntimeWorldBindingResolver,
} from "./runtime-world-binding.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

type DayCyclePhase = "autonomous" | "director_settlement" | "player";
type DayCycleTransitionKind =
  | "transition.autonomous_to_director"
  | "transition.director_to_player"
  | "transition.player_to_autonomous";

export interface DayCycleAdvanceResult {
  readonly worldId: string;
  readonly worldRevision: number;
  readonly day: number;
  readonly phase: "player";
}

export interface DayCycleOrchestrator {
  /**
   * Resume autonomous/director work until the world reaches player phase.
   * Calling this on an already-settled player phase is idempotent.
   */
  advanceToPlayer(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
  }): Promise<DayCycleAdvanceResult>;

  /**
   * Leave the current player day, expire its cards through day_cycle.advance,
   * and finish the next day's autonomous + Director settlement.
   */
  endPlayerDay(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
    /** Persisted command-owned source day; required for crash-safe recovery. */
    readonly fromDay: number;
  }): Promise<DayCycleAdvanceResult>;
}

export interface DayCycleOrchestratorDependencies {
  readonly worlds: RuntimeWorldBindingResolver;
  readonly identities: DayCycleExecutionIdentityJournal;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly models: RuntimeModelFacades;
  readonly mutations: WorldMutationOrchestrator;
  readonly directorDailySettlementModelProfileId: string;
  readonly characterReactModelProfileId: string;
}

interface DayCycleState {
  readonly binding: RuntimeWorldBinding;
  readonly worldState: JsonObject;
  readonly worldId: string;
  readonly worldRevision: number;
  readonly day: number;
  readonly phase: DayCyclePhase;
}

interface CharacterReactionRun {
  readonly entityId: string;
  readonly receipt: VerifiedModelInvocationReceipt;
}

export function createDayCycleOrchestrator(
  dependencies: DayCycleOrchestratorDependencies,
): DayCycleOrchestrator {
  return new DefaultDayCycleOrchestrator(dependencies);
}

class DefaultDayCycleOrchestrator implements DayCycleOrchestrator {
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #identities: DayCycleExecutionIdentityJournal;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #models: RuntimeModelFacades;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #directorDailySettlementModelProfileId: string;
  readonly #characterReactModelProfileId: string;

  public constructor(dependencies: DayCycleOrchestratorDependencies) {
    this.#worlds = dependencies.worlds;
    this.#identities = dependencies.identities;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#models = dependencies.models;
    this.#mutations = dependencies.mutations;
    this.#directorDailySettlementModelProfileId =
      dependencies.directorDailySettlementModelProfileId;
    this.#characterReactModelProfileId =
      dependencies.characterReactModelProfileId;
  }

  public async endPlayerDay(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
    readonly fromDay: number;
  }): Promise<DayCycleAdvanceResult> {
    const current = await this.#readState(input.worldId);
    requireControl(current, input.controlBindingId);
    if (input.fromDay >= Number.MAX_SAFE_INTEGER) {
      throw new EngineFault(
        "day_cycle.orchestration.day_exhausted",
        "World day cannot advance beyond the safe integer boundary",
        { world_id: current.worldId, day: input.fromDay },
      );
    }
    if (current.day === input.fromDay && current.phase === "player") {
      await this.#transition({
        state: current,
        controlBindingId: input.controlBindingId,
        executionKind: "transition.player_to_autonomous",
        toDay: current.day + 1,
        toPhase: "autonomous",
      });
    } else if (
      current.day !== input.fromDay + 1 ||
      (current.phase !== "autonomous" &&
        current.phase !== "director_settlement" &&
        current.phase !== "player")
    ) {
      throw new EngineFault(
        "day_cycle.orchestration.command_boundary_conflict",
        "World no longer matches the persisted player-day command boundary",
        {
          world_id: current.worldId,
          from_day: input.fromDay,
          current_day: current.day,
          current_phase: current.phase,
        },
      );
    }
    return this.advanceToPlayer(input);
  }

  public async advanceToPlayer(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
  }): Promise<DayCycleAdvanceResult> {
    let current = await this.#readState(input.worldId);
    requireControl(current, input.controlBindingId);
    if (current.phase === "player") {
      assertPlayerBudget(current, input.controlBindingId);
      return playerResult(current);
    }

    if (current.phase === "autonomous") {
      await this.#advanceStateMachines(current);
      current = await this.#readState(input.worldId);
      if (current.phase === "autonomous") {
        await this.#transition({
          state: current,
          controlBindingId: input.controlBindingId,
          executionKind: "transition.autonomous_to_director",
          toDay: current.day,
          toPhase: "director_settlement",
        });
      } else if (current.phase !== "director_settlement") {
        throw phaseFault(current, "director_settlement");
      }
      current = await this.#readState(input.worldId);
    }

    if (current.phase !== "director_settlement") {
      throw phaseFault(current, "director_settlement");
    }
    const directorReceipt = await this.#models.directorDailySettlement({
      worldId: current.worldId,
      model_profile_id: this.#directorDailySettlementModelProfileId,
    });
    const automaticEvents = readDirectorAutomaticEvents(directorReceipt);
    const reactions = await this.#runCharacterReactions(
      current.worldId,
      current.day,
      automaticEvents,
    );
    await this.#resolveAutomaticEvents({
      worldId: current.worldId,
      day: current.day,
      automaticEvents,
      directorReceipt,
      reactions,
    });

    current = await this.#readState(input.worldId);
    if (current.phase === "director_settlement") {
      await this.#transition({
        state: current,
        controlBindingId: input.controlBindingId,
        executionKind: "transition.director_to_player",
        toDay: current.day,
        toPhase: "player",
      });
    } else if (current.phase !== "player") {
      throw phaseFault(current, "player");
    }
    const settled = await this.#readState(input.worldId);
    requireControl(settled, input.controlBindingId);
    if (settled.phase !== "player") {
      throw phaseFault(settled, "player");
    }
    assertPlayerBudget(settled, input.controlBindingId);
    return playerResult(settled);
  }

  async #advanceStateMachines(initial: DayCycleState): Promise<void> {
    const machines = asObjectArray(
      expectProperty(
        initial.worldState,
        "state_machines",
        "WorldState",
      ),
      "WorldState.state_machines",
    );
    for (const machine of machines) {
      const instanceId = expectString(
        machine,
        "instance_id",
        "StateMachineInstanceState",
      );
      const machineRef = expectJsonObject(
        expectProperty(machine, "machine", "StateMachineInstanceState"),
        "StateMachineInstanceState.machine",
      );
      const machineId = expectString(
        machineRef,
        "local_id",
        "StateMachineCatalogRef",
      );
      assertMachineContentLock(initial, machineRef, machineId);
      const requestId = await this.#identities.reserve({
        worldId: initial.worldId,
        day: initial.day,
        executionKind: "state_machine.advance",
        subjectId: instanceId,
      });
      const receipt = await this.#executeRulePlugin({
        worldId: initial.worldId,
        requestId,
        operationKind: "state_machine.advance",
        modelInvocations: [],
        faultOwner: `state_machine:${machineId}`,
        sourcePredicate: (candidate) =>
          expectString(
            candidate.source,
            "owner_kind",
            "RulePlugin operation source",
          ) === "state_machine" &&
          expectString(
            candidate.source,
            "owner_id",
            "RulePlugin operation source",
          ) === machineId,
        assertBasis: (state) =>
          assertSameAutonomousDay(initial, state),
        requestInput: Object.freeze({
          machine_instance_id: instanceId,
          day: initial.day,
        }),
      });
      requireProposal(receipt, "state_machine.advance", {
        machine_instance_id: instanceId,
        day: initial.day,
      });
      await this.#mutations.commitRulePluginReceipt(receipt);
    }
  }

  async #runCharacterReactions(
    worldId: string,
    day: number,
    automaticEvents: readonly JsonObject[],
  ): Promise<ReadonlyMap<string, CharacterReactionRun>> {
    const grouped = new Map<string, JsonObject[]>();
    for (const proposal of automaticEvents) {
      if (
        expectString(
          proposal,
          "proposal_kind",
          "AutomaticEventProposal",
        ) !== "automatic.character"
      ) {
        continue;
      }
      const stimulus = toCharacterStimulus(proposal);
      for (const entityId of asStringArray(
        expectProperty(
          proposal,
          "target_entity_ids",
          "CharacterAutomaticEventProposal",
        ),
        "CharacterAutomaticEventProposal.target_entity_ids",
      )) {
        const events = grouped.get(entityId);
        if (events === undefined) {
          grouped.set(entityId, [stimulus]);
        } else {
          events.push(stimulus);
        }
      }
    }

    const runs = await Promise.all(
      [...grouped.entries()].map(async ([entityId, events]) => {
        const requestId = await this.#identities.reserve({
          worldId,
          day,
          executionKind: "character.react",
          subjectId: entityId,
        });
        const receipt = await this.#models.characterReact({
          worldId,
          entityId,
          events: Object.freeze([...events]),
          requestId,
          model_profile_id: this.#characterReactModelProfileId,
        });
        return Object.freeze({ entityId, receipt });
      }),
    );
    return new Map(runs.map((run) => [run.entityId, run]));
  }

  async #resolveAutomaticEvents(input: {
    readonly worldId: string;
    readonly day: number;
    readonly automaticEvents: readonly JsonObject[];
    readonly directorReceipt: VerifiedModelInvocationReceipt;
    readonly reactions: ReadonlyMap<string, CharacterReactionRun>;
  }): Promise<void> {
    for (const proposal of input.automaticEvents) {
      const proposalId = expectString(
        proposal,
        "proposal_id",
        "AutomaticEventProposal",
      );
      const requestId = await this.#identities.reserve({
        worldId: input.worldId,
        day: input.day,
        executionKind: "automatic_event.resolve",
        subjectId: proposalId,
      });
      const proposalKind = expectString(
        proposal,
        "proposal_kind",
        "AutomaticEventProposal",
      );
      if (proposalKind === "automatic.world") {
        const receipt = await this.#executeRulePlugin({
          worldId: input.worldId,
          requestId,
          operationKind: "automatic_event.world.resolve",
          modelInvocations: [input.directorReceipt],
          faultOwner: "world_definition",
          assertBasis: (state) =>
            assertSettlementDay(state, input.day),
          requestInput: Object.freeze({
            proposal,
            model_proof: input.directorReceipt.proof.value,
          }),
        });
        requireProposal(receipt, "automatic_event.world.resolve", {
          proposal_id: proposalId,
          day: input.day,
        });
        await this.#mutations.commitRulePluginReceipt(receipt);
        continue;
      }
      if (proposalKind !== "automatic.character") {
        throw new EngineFault(
          "day_cycle.orchestration.event_kind_invalid",
          "Director daily settlement returned an unknown automatic event kind",
          { proposal_id: proposalId, proposal_kind: proposalKind },
        );
      }

      const targetIds = asStringArray(
        expectProperty(
          proposal,
          "target_entity_ids",
          "CharacterAutomaticEventProposal",
        ),
        "CharacterAutomaticEventProposal.target_entity_ids",
      );
      const targetRuns = targetIds.map((entityId) => {
        const run = input.reactions.get(entityId);
        if (run === undefined) {
          throw new EngineFault(
            "day_cycle.orchestration.reaction_missing",
            "Character automatic event has no verified reaction run for a target",
            { proposal_id: proposalId, entity_id: entityId },
          );
        }
        return run;
      });
      const batches = targetRuns.map((run) =>
        createReactionBatch(input.worldId, proposalId, run),
      );
      const modelInvocations = [
        input.directorReceipt,
        ...targetRuns.map((run) => run.receipt),
      ];
      const receipt = await this.#executeRulePlugin({
        worldId: input.worldId,
        requestId,
        operationKind: "automatic_event.character.resolve",
        modelInvocations,
        faultOwner: "world_definition",
        assertBasis: (state) =>
          assertSettlementDay(state, input.day),
        requestInput: Object.freeze({
          proposal,
          character_reactions: Object.freeze(batches),
          director_proof: input.directorReceipt.proof.value,
        }),
      });
      requireProposal(receipt, "automatic_event.character.resolve", {
        proposal_id: proposalId,
        day: input.day,
      });
      await this.#mutations.commitRulePluginReceipt(receipt);
    }
  }

  async #transition(input: {
    readonly state: DayCycleState;
    readonly controlBindingId: string;
    readonly executionKind: DayCycleTransitionKind;
    readonly toDay: number;
    readonly toPhase: DayCyclePhase;
  }): Promise<void> {
    const requestId = await this.#identities.reserve({
      worldId: input.state.worldId,
      day: input.state.day,
      executionKind: input.executionKind,
    });
    const eventBudgetPolicy =
      input.toPhase === "player"
        ? input.state.binding.contentBinding.eventBudget
        : undefined;
    const receipt = await this.#executeRulePlugin({
      worldId: input.state.worldId,
      requestId,
      operationKind: "day_cycle.advance",
      modelInvocations: [],
      faultOwner: "world_definition",
      assertBasis: (state) =>
        assertTransitionBasis(input.state, state),
      requestInput: Object.freeze({
        from_day: input.state.day,
        from_phase: input.state.phase,
        to_day: input.toDay,
        to_phase: input.toPhase,
        control: Object.freeze({
          binding_id: input.controlBindingId,
        }),
        ...(eventBudgetPolicy === undefined
          ? {}
          : { event_budget_policy: eventBudgetPolicy }),
      }),
    });
    requireProposal(receipt, "day_cycle.advance", {
      from_day: input.state.day,
      from_phase: input.state.phase,
      to_day: input.toDay,
      to_phase: input.toPhase,
    });
    await this.#mutations.commitRulePluginReceipt(receipt);
  }

  async #executeRulePlugin(input: {
    readonly worldId: string;
    readonly requestId: string;
    readonly operationKind:
      | "day_cycle.advance"
      | "state_machine.advance"
      | "automatic_event.world.resolve"
      | "automatic_event.character.resolve";
    readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
    readonly faultOwner: string;
    readonly sourcePredicate?: (
      candidate: ContentRulePluginOperationBinding,
    ) => boolean;
    readonly assertBasis: (state: DayCycleState) => void;
    readonly requestInput: JsonObject;
  }): Promise<VerifiedRulePluginInvocationReceipt> {
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: input.requestId,
      modelInvocations: input.modelInvocations,
      candidateFactory: async () => {
        const state = await this.#readState(input.worldId);
        const invocation = resolveRulePluginInvocationBinding({
          binding: state.binding.contentBinding,
          operationKind: input.operationKind,
          abi: this.#rulePluginAbi,
          faultOwner: input.faultOwner,
          ...(input.sourcePredicate === undefined
            ? {}
            : { sourcePredicate: input.sourcePredicate }),
        });
        input.assertBasis(state);
        return this.#createRulePluginRequest({
          state,
          requestId: input.requestId,
          operationKind: input.operationKind,
          invocation,
          input: input.requestInput,
          modelInvocations: input.modelInvocations,
        });
      },
    });
    const current = await this.#readState(input.worldId);
    const invocation = resolveRulePluginInvocationBinding({
      binding: current.binding.contentBinding,
      operationKind: input.operationKind,
      abi: this.#rulePluginAbi,
      faultOwner: input.faultOwner,
      ...(input.sourcePredicate === undefined
        ? {}
        : { sourcePredicate: input.sourcePredicate }),
    });
    assertRecoveredRulePluginIdentity(receipt, {
      ...input,
      invocation,
    });
    return receipt;
  }

  #createRulePluginRequest(input: {
    readonly state: DayCycleState;
    readonly requestId: string;
    readonly operationKind:
      | "day_cycle.advance"
      | "state_machine.advance"
      | "automatic_event.world.resolve"
      | "automatic_event.character.resolve";
    readonly invocation: RuntimeRulePluginInvocationBinding;
    readonly input: JsonObject;
    readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
  }): JsonObject {
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: input.state.worldId,
      logicalTime: expectProperty(
        input.state.worldState,
        "clock",
        "WorldState",
      ),
      randomChoices: [],
      externalResults: input.modelInvocations.map((receipt, index) =>
        Object.freeze({
          result_id: `model_output_${index + 1}`,
          content_digest: expectString(
            receipt.proof.value,
            "output_digest",
            "VerifiedModelOutputRef",
          ),
          payload: expectProperty(
            receipt.response.value,
            "output",
            "ModelResponse",
          ),
        }),
      ),
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: input.requestId,
      plugin_lock: input.invocation.pluginLock,
      operation_id: input.invocation.operationId,
      operation_kind: input.operationKind,
      basis_revision: input.state.worldRevision,
      readonly_world: input.state.binding.record.snapshot.value,
      deterministic_context: deterministicContext.value,
      input: input.input,
    });
  }

  async #readState(worldId: string): Promise<DayCycleState> {
    const binding = await this.#worlds.resolveCurrent(worldId);
    const snapshot = binding.record.snapshot.value;
    const actualWorldId = expectString(snapshot, "world_id", "WorldSnapshot");
    if (actualWorldId !== worldId) {
      throw new EngineFault(
        "day_cycle.orchestration.world_identity_mismatch",
        "Runtime world binding returned a different world",
        { requested_world_id: worldId, actual_world_id: actualWorldId },
      );
    }
    const worldState = expectJsonObject(
      expectProperty(snapshot, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dayCycle = expectJsonObject(
      expectProperty(worldState, "day_cycle", "WorldState"),
      "WorldState.day_cycle",
    );
    return Object.freeze({
      binding,
      worldState,
      worldId,
      worldRevision: expectInteger(
        snapshot,
        "world_revision",
        "WorldSnapshot",
      ),
      day: expectInteger(dayCycle, "day", "DayCycleState"),
      phase: readPhase(dayCycle),
    });
  }
}

function assertRecoveredRulePluginIdentity(
  receipt: VerifiedRulePluginInvocationReceipt,
  input: {
    readonly worldId: string;
    readonly requestId: string;
    readonly operationKind: string;
    readonly requestInput: JsonObject;
    readonly invocation: RuntimeRulePluginInvocationBinding;
  },
): void {
  const request = receipt.request.value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  if (
    receipt.worldId !== input.worldId ||
    expectString(request, "request_id", "RulePluginRequest") !==
      input.requestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      input.operationKind ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    !jsonEquals(
      expectProperty(request, "plugin_lock", "RulePluginRequest"),
      input.invocation.pluginLock,
    ) ||
    !jsonEquals(
      expectProperty(request, "input", "RulePluginRequest"),
      input.requestInput,
    ) ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !== input.worldId
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its day-cycle execution identity",
      {
        world_id: input.worldId,
        request_id: input.requestId,
        operation_kind: input.operationKind,
      },
    );
  }
}

function requireProposal(
  receipt: VerifiedRulePluginInvocationReceipt,
  operationKind: string,
  details: JsonObject,
): void {
  if (receipt.proposal !== undefined) {
    return;
  }
  const output = expectJsonObject(
    expectProperty(
      receipt.response.value,
      "output",
      "RulePluginResponse",
    ),
    "RulePluginResponse.output",
  );
  throw new EngineFault(
    "day_cycle.orchestration.stage_unresolved",
    "A required day-cycle RulePlugin stage did not produce a ContentPacket proposal",
    {
      operation_kind: operationKind,
      output_kind: expectString(
        output,
        "output_kind",
        "RulePluginResponse.output",
      ),
      request_id: expectString(
        receipt.request.value,
        "request_id",
        "RulePluginRequest",
      ),
      ...details,
    },
  );
}

function readDirectorAutomaticEvents(
  receipt: VerifiedModelInvocationReceipt,
): readonly JsonObject[] {
  const output = expectJsonObject(
    expectProperty(receipt.response.value, "output", "ModelResponse"),
    "ModelResponse.output",
  );
  if (
    expectString(output, "output_kind", "DirectorDailySettlementOutput") !==
    "director.daily_settlement"
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.director_output_invalid",
      "Verified Director daily settlement has an unexpected output kind",
      {
        request_id: expectString(
          receipt.request.value,
          "request_id",
          "ModelRequest",
        ),
      },
    );
  }
  return asObjectArray(
    expectProperty(
      output,
      "automatic_events",
      "DirectorDailySettlementOutput",
    ),
    "DirectorDailySettlementOutput.automatic_events",
  );
}

function toCharacterStimulus(proposal: JsonObject): JsonObject {
  return Object.freeze({
    stimulus_kind: "automatic",
    proposal_id: expectString(
      proposal,
      "proposal_id",
      "CharacterAutomaticEventProposal",
    ),
    day: expectInteger(
      proposal,
      "day",
      "CharacterAutomaticEventProposal",
    ),
    situation: expectProperty(
      proposal,
      "situation",
      "CharacterAutomaticEventProposal",
    ),
    candidate_outcomes: expectProperty(
      proposal,
      "candidate_outcomes",
      "CharacterAutomaticEventProposal",
    ),
    agency_gates: expectProperty(
      proposal,
      "agency_gates",
      "CharacterAutomaticEventProposal",
    ),
  });
}

function createReactionBatch(
  worldId: string,
  proposalId: string,
  run: CharacterReactionRun,
): JsonObject {
  const output = expectJsonObject(
    expectProperty(run.receipt.response.value, "output", "ModelResponse"),
    "ModelResponse.output",
  );
  const reactions = asObjectArray(
    expectProperty(output, "reactions", "CharacterReactOutput"),
    "CharacterReactOutput.reactions",
  ).filter((reaction) => {
    const source = expectJsonObject(
      expectProperty(
        reaction,
        "source_event",
        "CharacterReactionProposal",
      ),
      "CharacterReactionProposal.source_event",
    );
    return (
      expectString(source, "proposal_id", "CharacterEventRef") === proposalId
    );
  });
  if (reactions.length !== 1) {
    throw new EngineFault(
      "day_cycle.orchestration.reaction_coverage_invalid",
      "Character reaction output must contain exactly one reaction for the automatic event",
      {
        proposal_id: proposalId,
        entity_id: run.entityId,
        reactions: reactions.length,
      },
    );
  }
  return Object.freeze({
    character: Object.freeze({
      world_id: worldId,
      entity_id: run.entityId,
    }),
    model_proof: run.receipt.proof.value,
    reactions: Object.freeze(reactions),
  });
}

function requireControl(
  state: DayCycleState,
  controlBindingId: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(
      state.worldState,
      "control_bindings",
      "WorldState",
    ),
    "WorldState.control_bindings",
  ).filter(
    (binding) =>
      expectString(binding, "binding_id", "ControlBinding") ===
      controlBindingId,
  );
  if (
    matches.length !== 1 ||
    expectString(
      matches[0] as JsonObject,
      "binding_kind",
      "ControlBinding",
    ) !== "human" ||
    expectString(
      matches[0] as JsonObject,
      "status",
      "ControlBinding",
    ) !== "active"
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.control_invalid",
      "Day-cycle orchestration requires the world's active human ControlBinding",
      {
        world_id: state.worldId,
        binding_id: controlBindingId,
        matches: matches.length,
      },
    );
  }
  return matches[0] as JsonObject;
}

function assertPlayerBudget(
  state: DayCycleState,
  controlBindingId: string,
): void {
  const control = Object.freeze({ binding_id: controlBindingId });
  const matches = asObjectArray(
    expectProperty(state.worldState, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  ).filter(
    (budget) =>
      expectInteger(budget, "day", "EventBudgetState") === state.day &&
      jsonEquals(
        expectProperty(budget, "control", "EventBudgetState"),
        control,
      ),
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "day_cycle.orchestration.player_budget_invalid",
      "Player phase must own exactly one EventBudget for its active human control",
      {
        world_id: state.worldId,
        day: state.day,
        binding_id: controlBindingId,
        matches: matches.length,
      },
    );
  }
}

function assertMachineContentLock(
  state: DayCycleState,
  machineRef: JsonObject,
  machineId: string,
): void {
  if (
    expectString(machineRef, "catalog_kind", "StateMachineCatalogRef") !==
      "state_machine" ||
    expectString(machineRef, "bundle_id", "StateMachineCatalogRef") !==
      state.binding.contentBinding.packId ||
    expectString(
      machineRef,
      "bundle_digest",
      "StateMachineCatalogRef",
    ) !== state.binding.contentBinding.bundleDigest
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.machine_content_mismatch",
      "Runtime state machine does not belong to the world's locked ContentBundle",
      {
        world_id: state.worldId,
        machine_id: machineId,
      },
    );
  }
}

function assertSameAutonomousDay(
  expected: DayCycleState,
  actual: DayCycleState,
): void {
  if (
    actual.worldId !== expected.worldId ||
    actual.day !== expected.day ||
    actual.phase !== "autonomous"
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.stage_basis_changed",
      "State-machine advancement no longer owns the expected autonomous day",
      {
        world_id: expected.worldId,
        expected_day: expected.day,
        actual_day: actual.day,
        actual_phase: actual.phase,
      },
    );
  }
}

function assertSettlementDay(state: DayCycleState, day: number): void {
  if (state.day !== day || state.phase !== "director_settlement") {
    throw new EngineFault(
      "day_cycle.orchestration.stage_basis_changed",
      "Automatic event resolution no longer owns the expected Director settlement day",
      {
        world_id: state.worldId,
        expected_day: day,
        actual_day: state.day,
        actual_phase: state.phase,
      },
    );
  }
}

function assertTransitionBasis(
  expected: DayCycleState,
  actual: DayCycleState,
): void {
  if (
    expected.worldId !== actual.worldId ||
    expected.day !== actual.day ||
    expected.phase !== actual.phase
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.transition_basis_changed",
      "Day-cycle transition no longer owns its expected source phase",
      {
        world_id: expected.worldId,
        expected_day: expected.day,
        actual_day: actual.day,
        expected_phase: expected.phase,
        actual_phase: actual.phase,
      },
    );
  }
}

function readPhase(dayCycle: JsonObject): DayCyclePhase {
  const phase = expectString(dayCycle, "phase", "DayCycleState");
  if (
    phase !== "autonomous" &&
    phase !== "director_settlement" &&
    phase !== "player"
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.phase_invalid",
      "WorldState contains an unknown day-cycle phase",
      { phase },
    );
  }
  return phase;
}

function phaseFault(
  state: DayCycleState,
  expected: DayCyclePhase,
): EngineFault {
  return new EngineFault(
    "day_cycle.orchestration.phase_conflict",
    "World day-cycle phase does not match the requested operation",
    {
      world_id: state.worldId,
      day: state.day,
      expected_phase: expected,
      actual_phase: state.phase,
    },
  );
}

function playerResult(state: DayCycleState): DayCycleAdvanceResult {
  return Object.freeze({
    worldId: state.worldId,
    worldRevision: state.worldRevision,
    day: state.day,
    phase: "player" as const,
  });
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "day_cycle.orchestration.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function asStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "day_cycle.orchestration.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new EngineFault(
        "day_cycle.orchestration.shape",
        `${path}[${index}] must be a string`,
        { path: `${path}[${index}]` },
      );
    }
    return entry;
  });
}
