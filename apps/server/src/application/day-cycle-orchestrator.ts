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
  StateMachineContractAuthority,
} from "@luoxia/world-core";

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
import type {
  DailySettlementProposalIdentity,
  DailySettlementRunJournal,
} from "./runtime-persistence.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";
import type { WorldExtensionOrchestrator } from "./world-extension-orchestrator.js";

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
  readonly stateMachineContracts: StateMachineContractAuthority;
  readonly models: RuntimeModelFacades;
  readonly dailySettlements: DailySettlementRunJournal;
  readonly mutations: WorldMutationOrchestrator;
  readonly worldExtensions: WorldExtensionOrchestrator;
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
  readonly eventOrdinalByProposalId: ReadonlyMap<string, number>;
}

interface MaterializedAutomaticEventRun {
  readonly draftOrdinal: number;
  readonly candidate: JsonObject;
  readonly characterEvent: JsonObject | undefined;
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
  readonly #stateMachineContracts: StateMachineContractAuthority;
  readonly #models: RuntimeModelFacades;
  readonly #dailySettlements: DailySettlementRunJournal;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #worldExtensions: WorldExtensionOrchestrator;

  public constructor(dependencies: DayCycleOrchestratorDependencies) {
    this.#worlds = dependencies.worlds;
    this.#identities = dependencies.identities;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#stateMachineContracts = dependencies.stateMachineContracts;
    this.#models = dependencies.models;
    this.#dailySettlements = dependencies.dailySettlements;
    this.#mutations = dependencies.mutations;
    this.#worldExtensions = dependencies.worldExtensions;
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
      await this.#worldExtensions.resolvePending({
        worldId: current.worldId,
      });
      current = await this.#readState(input.worldId);
      if (current.phase !== "autonomous") {
        throw phaseFault(current, "autonomous");
      }
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
    });
    const automaticEventDrafts =
      readDirectorAutomaticEvents(directorReceipt);
    const proposalIdentities =
      await this.#dailySettlements.prepareDailyProposals(
        expectString(
          directorReceipt.proof.value,
          "request_id",
          "VerifiedModelOutputRef",
        ),
      );
    const automaticEvents = materializeAutomaticEvents({
      worldId: current.worldId,
      expectedDay: current.day,
      locale: current.binding.contentBinding.defaultLocale,
      receipt: directorReceipt,
      drafts: automaticEventDrafts,
      proposalIdentities,
    });
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
      if (hasRetiredCharacterOwner(initial.worldState, machine)) {
        continue;
      }
      const resolvedMachine = this.#stateMachineContracts.assertBoundInstance({
        contentBinding: initial.binding.contentBinding,
        worldId: initial.worldId,
        instance: machine,
      });
      const currentStateId = expectString(
        machine,
        "state_id",
        "StateMachineInstanceState",
      );
      if (
        resolvedMachine.listOutgoingTransitions(currentStateId).length === 0
      ) {
        continue;
      }
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
          machine_definition: resolvedMachine.definition,
        }),
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
          ) === "state_machine.unchanged"
        ) {
          continue;
        }
        requireProposal(receipt, "state_machine.advance", {
          machine_instance_id: instanceId,
          day: initial.day,
        });
      }
      await this.#mutations.commitRulePluginReceipt(receipt);
    }
  }

  async #runCharacterReactions(
    worldId: string,
    day: number,
    automaticEvents: readonly MaterializedAutomaticEventRun[],
  ): Promise<ReadonlyMap<string, CharacterReactionRun>> {
    const grouped = new Map<
      string,
      {
        readonly events: JsonObject[];
        readonly eventOrdinalByProposalId: Map<string, number>;
      }
    >();
    for (const event of automaticEvents) {
      if (event.characterEvent === undefined) {
        continue;
      }
      const proposalId = expectString(
        event.candidate,
        "proposal_id",
        "MaterializedCharacterAutomaticEventCandidate",
      );
      for (const entityId of asStringArray(
        expectProperty(
          event.candidate,
          "target_entity_ids",
          "MaterializedCharacterAutomaticEventCandidate",
        ),
        "MaterializedCharacterAutomaticEventCandidate.target_entity_ids",
      )) {
        let group = grouped.get(entityId);
        if (group === undefined) {
          group = {
            events: [],
            eventOrdinalByProposalId: new Map<string, number>(),
          };
          grouped.set(entityId, group);
        }
        if (group.eventOrdinalByProposalId.has(proposalId)) {
          throw new EngineFault(
            "day_cycle.orchestration.reaction_event_duplicate",
            "A character reaction run cannot contain the same automatic proposal twice",
            { entity_id: entityId, proposal_id: proposalId },
          );
        }
        group.eventOrdinalByProposalId.set(proposalId, group.events.length);
        group.events.push(event.characterEvent);
      }
    }

    const runs = await Promise.all(
      [...grouped.entries()].map(async ([entityId, group]) => {
        const requestId = await this.#identities.reserve({
          worldId,
          day,
          executionKind: "character.react",
          subjectId: entityId,
        });
        const receipt = await this.#models.characterReact({
          worldId,
          entityId,
          day,
          events: Object.freeze([...group.events]),
          requestId,
        });
        return Object.freeze({
          entityId,
          receipt,
          eventOrdinalByProposalId: group.eventOrdinalByProposalId,
        });
      }),
    );
    return new Map(runs.map((run) => [run.entityId, run]));
  }

  async #resolveAutomaticEvents(input: {
    readonly worldId: string;
    readonly day: number;
    readonly automaticEvents: readonly MaterializedAutomaticEventRun[];
    readonly directorReceipt: VerifiedModelInvocationReceipt;
    readonly reactions: ReadonlyMap<string, CharacterReactionRun>;
  }): Promise<void> {
    for (const event of input.automaticEvents) {
      const proposal = event.candidate;
      const proposalId = expectString(
        proposal,
        "proposal_id",
        "MaterializedAutomaticEventCandidate",
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
        "MaterializedAutomaticEventCandidate",
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
            draft_ordinal: event.draftOrdinal,
            candidate: proposal,
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
          "MaterializedCharacterAutomaticEventCandidate",
        ),
        "MaterializedCharacterAutomaticEventCandidate.target_entity_ids",
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
        createReactionBatch(proposalId, run),
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
          draft_ordinal: event.draftOrdinal,
          candidate: proposal,
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
    this.#rulePlugins.assertExecutionRoot(receipt, input.requestId);
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
        root_request_id: input.requestId,
        terminal_request_id: expectString(
          request,
          "request_id",
          "RulePluginRequest",
        ),
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
    "day_cycle.orchestration.required_operation_unresolved",
    "A required day-cycle RulePlugin operation did not produce a ContentPacket proposal",
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

function materializeAutomaticEvents(input: {
  readonly worldId: string;
  readonly expectedDay: number;
  readonly locale: string;
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly drafts: readonly JsonObject[];
  readonly proposalIdentities: readonly DailySettlementProposalIdentity[];
}): readonly MaterializedAutomaticEventRun[] {
  const requestInput = modelRequestInput(input.receipt);
  const worldView = expectJsonObject(
    expectProperty(
      requestInput,
      "world_view",
      "DirectorDailySettlementInput",
    ),
    "DirectorDailySettlementInput.world_view",
  );
  const actors = asObjectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const snapshot = input.receipt.snapshot.value;
  const worldState = expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const snapshotWorldId = expectString(
    snapshot,
    "world_id",
    "WorldSnapshot",
  );
  const snapshotDay = expectInteger(dayCycle, "day", "DayCycleState");
  const viewDay = expectInteger(worldView, "day", "DirectorWorldView");
  if (
    snapshotWorldId !== input.worldId ||
    input.receipt.worldId !== input.worldId ||
    snapshotDay !== input.expectedDay ||
    viewDay !== input.expectedDay
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.director_basis_mismatch",
      "Verified daily Director request does not match its settlement basis",
      {
        world_id: input.worldId,
        snapshot_world_id: snapshotWorldId,
        receipt_world_id: input.receipt.worldId,
        expected_day: input.expectedDay,
        snapshot_day: snapshotDay,
        view_day: viewDay,
      },
    );
  }
  if (input.proposalIdentities.length !== input.drafts.length) {
    throw new EngineFault(
      "day_cycle.orchestration.proposal_identity_count_mismatch",
      "Daily proposal identities do not cover the verified Director drafts",
      {
        model_request_id: expectString(
          input.receipt.proof.value,
          "request_id",
          "VerifiedModelOutputRef",
        ),
        draft_count: input.drafts.length,
        identity_count: input.proposalIdentities.length,
      },
    );
  }

  return Object.freeze(
    input.drafts.map((draft, draftOrdinal) => {
      const identity = input.proposalIdentities[draftOrdinal];
      if (
        identity === undefined ||
        identity.ordinal !== draftOrdinal
      ) {
        throw new EngineFault(
          "day_cycle.orchestration.proposal_identity_ordinal_mismatch",
          "Daily proposal identity is not aligned with its Director draft",
          {
            draft_ordinal: draftOrdinal,
            identity_ordinal:
              identity === undefined ? null : identity.ordinal,
          },
        );
      }
      const candidate = materializeAutomaticEventCandidate({
        worldId: input.worldId,
        day: input.expectedDay,
        locale: input.locale,
        worldState,
        actors,
        draft,
        proposalId: identity.proposalId,
      });
      return Object.freeze({
        draftOrdinal,
        candidate,
        characterEvent:
          expectString(
            candidate,
            "proposal_kind",
            "MaterializedAutomaticEventCandidate",
          ) === "automatic.character"
            ? projectCharacterReactEvent(candidate)
            : undefined,
      });
    }),
  );
}

function materializeAutomaticEventCandidate(input: {
  readonly worldId: string;
  readonly day: number;
  readonly locale: string;
  readonly worldState: JsonObject;
  readonly actors: readonly JsonObject[];
  readonly draft: JsonObject;
  readonly proposalId: string;
}): JsonObject {
  const intent = input.draft;
  const scope = expectString(intent, "scope", "DailySettlementEventIntent");
  if (scope !== "world" && scope !== "character") {
    throw new EngineFault(
      "day_cycle.orchestration.event_scope_invalid",
      "Verified daily Director intent has an unknown scope",
      { proposal_id: input.proposalId, scope },
    );
  }
  const actorIndexField =
    scope === "world" ? "subject_actor_indices" : "target_actor_indices";
  const actorIndices = readModelIndices(
    intent,
    actorIndexField,
    "DailySettlementEventIntent",
    input.actors.length,
  );
  const situationActors = actorIndices.map(
    (actorIndex) => input.actors[actorIndex] as JsonObject,
  );
  const situationEntityRefs = Object.freeze(
    situationActors.map((actor, actorOrdinal) =>
      materializeActorEntityRef({
        worldId: input.worldId,
        worldState: input.worldState,
        actor,
        label: `DailySettlementEventIntent.actors[${actorOrdinal}]`,
      }),
    ),
  );
  const subjects = Object.freeze(
    situationEntityRefs.map(subjectFromEntityRef),
  );
  const outcomeId = "outcome_0";
  const agencyValue = intent["agency"];
  const hasAgency =
    scope === "character" &&
    agencyValue !== null &&
    agencyValue !== undefined;
  const gateId = hasAgency ? "gate_0" : undefined;
  const outcome = Object.freeze({
    outcome_id: outcomeId,
    outcome_type: expectString(
      intent,
      "outcome_type",
      "DailySettlementEventIntent",
    ),
    subjects,
    parameters: expectJsonObject(
      expectProperty(intent, "parameters", "DailySettlementEventIntent"),
      "DailySettlementEventIntent.parameters",
    ),
    ...(gateId === undefined
      ? {}
      : { requires_agency_gate_id: gateId }),
  });
  const situation = Object.freeze({
    event_type: expectString(
      intent,
      "event_type",
      "DailySettlementEventIntent",
    ),
    summary: localizedText(
      input.locale,
      expectString(intent, "summary", "DailySettlementEventIntent"),
    ),
    subjects,
    context: Object.freeze({}),
  });

  if (scope === "world") {
    return Object.freeze({
      proposal_kind: "automatic.world",
      proposal_id: input.proposalId,
      day: input.day,
      situation,
      candidate_outcomes: Object.freeze([outcome]),
    });
  }

  const targetEntityIds = Object.freeze(
    situationEntityRefs.map((entityRef) =>
      expectString(entityRef, "entity_id", "EntityRef"),
    ),
  );
  let agencyGates: readonly JsonObject[] = Object.freeze([]);
  if (hasAgency) {
    const agency = expectJsonObject(
      agencyValue as JsonValue,
      "DailySettlementEventIntent.agency",
    );
    agencyGates = Object.freeze([
      Object.freeze({
        gate_id: gateId as string,
        protected_outcome_ids: Object.freeze([outcomeId]),
        participants: situationEntityRefs,
        requirement: Object.freeze({
          semantic_intent: expectString(
            agency,
            "semantic_intent",
            "DailySettlementAgencyIntent",
          ),
          subjects,
          terms: expectJsonObject(
            expectProperty(agency, "terms", "DailySettlementAgencyIntent"),
            "DailySettlementAgencyIntent.terms",
          ),
        }),
        policy: expectJsonObject(
          expectProperty(agency, "policy", "DailySettlementAgencyIntent"),
          "DailySettlementAgencyIntent.policy",
        ),
        commitment_evidence: Object.freeze([]),
      }),
    ]);
  }
  return Object.freeze({
    proposal_kind: "automatic.character",
    proposal_id: input.proposalId,
    day: input.day,
    situation,
    target_entity_ids: targetEntityIds,
    candidate_outcomes: Object.freeze([outcome]),
    agency_gates: agencyGates,
  });
}

function materializeActorEntityRef(input: {
  readonly worldId: string;
  readonly worldState: JsonObject;
  readonly actor: JsonObject;
  readonly label: string;
}): JsonObject {
  const entityId = expectString(
    input.actor,
    "entity_id",
    "DirectorActorView",
  );
  const matches = asObjectArray(
    expectProperty(input.worldState, "entities", "WorldState"),
    "WorldState.entities",
  ).filter(
    (entity) =>
      expectString(entity, "entity_id", "EntityState") === entityId,
  );
  const entity = matches[0];
  if (matches.length !== 1 || entity === undefined) {
    throw new EngineFault(
      "day_cycle.orchestration.actor_resolution_invalid",
      "Verified Director actor does not resolve exactly once in its locked WorldState",
      { label: input.label, entity_id: entityId, matches: matches.length },
    );
  }
  return Object.freeze({
    world_id: input.worldId,
    entity_id: entityId,
    expected_revision: expectInteger(entity, "revision", "EntityState"),
  });
}

function subjectFromEntityRef(entity: JsonObject): JsonObject {
  return Object.freeze({ kind: "entity", entity });
}

function projectCharacterReactEvent(candidate: JsonObject): JsonObject {
  const situation = expectJsonObject(
    expectProperty(
      candidate,
      "situation",
      "MaterializedCharacterAutomaticEventCandidate",
    ),
    "MaterializedCharacterAutomaticEventCandidate.situation",
  );
  const outcomes = asObjectArray(
    expectProperty(
      candidate,
      "candidate_outcomes",
      "MaterializedCharacterAutomaticEventCandidate",
    ),
    "MaterializedCharacterAutomaticEventCandidate.candidate_outcomes",
  );
  const gates = asObjectArray(
    expectProperty(
      candidate,
      "agency_gates",
      "MaterializedCharacterAutomaticEventCandidate",
    ),
    "MaterializedCharacterAutomaticEventCandidate.agency_gates",
  );
  return Object.freeze({
    situation: Object.freeze({
      event_type: expectString(
        situation,
        "event_type",
        "MaterializedEventSituationCandidate",
      ),
      summary: expectJsonObject(
        expectProperty(
          situation,
          "summary",
          "MaterializedEventSituationCandidate",
        ),
        "MaterializedEventSituationCandidate.summary",
      ),
      subject_entity_ids: Object.freeze(
        asObjectArray(
          expectProperty(
            situation,
            "subjects",
            "MaterializedEventSituationCandidate",
          ),
          "MaterializedEventSituationCandidate.subjects",
        ).map((subject, ordinal) =>
          entityIdFromSubject(
            subject,
            `MaterializedEventSituationCandidate.subjects[${ordinal}]`,
          ),
        ),
      ),
      context: expectJsonObject(
        expectProperty(
          situation,
          "context",
          "MaterializedEventSituationCandidate",
        ),
        "MaterializedEventSituationCandidate.context",
      ),
    }),
    candidate_outcomes: Object.freeze(
      outcomes.map((outcome, ordinal) =>
        projectCharacterReactOutcome(outcome, ordinal),
      ),
    ),
    agency_gates: Object.freeze(
      gates.map((gate, ordinal) =>
        projectCharacterReactGate(gate, ordinal),
      ),
    ),
  });
}

function projectCharacterReactOutcome(
  outcome: JsonObject,
  ordinal: number,
): JsonObject {
  const requiresGateId = outcome["requires_agency_gate_id"];
  return Object.freeze({
    outcome_id: expectString(
      outcome,
      "outcome_id",
      "MaterializedSemanticOutcomeCandidate",
    ),
    outcome_type: expectString(
      outcome,
      "outcome_type",
      "MaterializedSemanticOutcomeCandidate",
    ),
    subject_entity_ids: Object.freeze(
      asObjectArray(
        expectProperty(
          outcome,
          "subjects",
          "MaterializedSemanticOutcomeCandidate",
        ),
        "MaterializedSemanticOutcomeCandidate.subjects",
      ).map((subject, subjectOrdinal) =>
        entityIdFromSubject(
          subject,
          `candidate_outcomes[${ordinal}].subjects[${subjectOrdinal}]`,
        ),
      ),
    ),
    parameters: expectJsonObject(
      expectProperty(
        outcome,
        "parameters",
        "MaterializedSemanticOutcomeCandidate",
      ),
      "MaterializedSemanticOutcomeCandidate.parameters",
    ),
    ...(requiresGateId === undefined
      ? {}
      : {
          requires_agency_gate_id: expectString(
            outcome,
            "requires_agency_gate_id",
            "MaterializedSemanticOutcomeCandidate",
          ),
        }),
  });
}

function projectCharacterReactGate(
  gate: JsonObject,
  ordinal: number,
): JsonObject {
  const requirement = expectJsonObject(
    expectProperty(
      gate,
      "requirement",
      "MaterializedAgencyGateCandidate",
    ),
    "MaterializedAgencyGateCandidate.requirement",
  );
  return Object.freeze({
    gate_id: expectString(
      gate,
      "gate_id",
      "MaterializedAgencyGateCandidate",
    ),
    protected_outcome_ids: Object.freeze(
      asStringArray(
        expectProperty(
          gate,
          "protected_outcome_ids",
          "MaterializedAgencyGateCandidate",
        ),
        "MaterializedAgencyGateCandidate.protected_outcome_ids",
      ),
    ),
    participant_entity_ids: Object.freeze(
      asObjectArray(
        expectProperty(
          gate,
          "participants",
          "MaterializedAgencyGateCandidate",
        ),
        "MaterializedAgencyGateCandidate.participants",
      ).map((participant, participantOrdinal) =>
        expectString(
          participant,
          "entity_id",
          `agency_gates[${ordinal}].participants[${participantOrdinal}]`,
        ),
      ),
    ),
    requirement: Object.freeze({
      semantic_intent: expectString(
        requirement,
        "semantic_intent",
        "AgencyRequirement",
      ),
      subject_entity_ids: Object.freeze(
        asObjectArray(
          expectProperty(
            requirement,
            "subjects",
            "AgencyRequirement",
          ),
          "AgencyRequirement.subjects",
        ).map((subject, subjectOrdinal) =>
          entityIdFromSubject(
            subject,
            `agency_gates[${ordinal}].requirement.subjects[${subjectOrdinal}]`,
          ),
        ),
      ),
      terms: expectJsonObject(
        expectProperty(requirement, "terms", "AgencyRequirement"),
        "AgencyRequirement.terms",
      ),
    }),
    policy: expectJsonObject(
      expectProperty(gate, "policy", "MaterializedAgencyGateCandidate"),
      "MaterializedAgencyGateCandidate.policy",
    ),
  });
}

function entityIdFromSubject(subject: JsonObject, path: string): string {
  if (expectString(subject, "kind", path) !== "entity") {
    throw new EngineFault(
      "day_cycle.orchestration.character_event_subject_invalid",
      "Character reaction events can contain only entity subjects",
      { path },
    );
  }
  return expectString(
    expectJsonObject(
      expectProperty(subject, "entity", path),
      `${path}.entity`,
    ),
    "entity_id",
    "EntityRef",
  );
}

function createReactionBatch(
  proposalId: string,
  run: CharacterReactionRun,
): JsonObject {
  const requestInput = modelRequestInput(run.receipt);
  const events = asObjectArray(
    expectProperty(requestInput, "events", "CharacterReactInput"),
    "CharacterReactInput.events",
  );
  const draftOrdinal = run.eventOrdinalByProposalId.get(proposalId);
  if (draftOrdinal === undefined) {
    throw new EngineFault(
      "day_cycle.orchestration.reaction_coverage_invalid",
      "Character reaction run has no locally owned event ordinal for the automatic proposal",
      {
        proposal_id: proposalId,
        entity_id: run.entityId,
      },
    );
  }
  const output = expectJsonObject(
    expectProperty(run.receipt.response.value, "output", "ModelResponse"),
    "ModelResponse.output",
  );
  const reactions = asObjectArray(
    expectProperty(output, "reactions", "CharacterReactOutput"),
    "CharacterReactOutput.reactions",
  );
  if (reactions.length !== events.length) {
    throw new EngineFault(
      "day_cycle.orchestration.reaction_ordinal_mismatch",
      "Character reaction drafts must align one-to-one with request events",
      {
        entity_id: run.entityId,
        event_count: events.length,
        reaction_count: reactions.length,
      },
    );
  }
  const reaction = reactions[draftOrdinal];
  const event = events[draftOrdinal];
  if (reaction === undefined || event === undefined) {
    throw new EngineFault(
      "day_cycle.orchestration.reaction_ordinal_missing",
      "Character reaction ordinal has no matching event and draft",
      {
        proposal_id: proposalId,
        entity_id: run.entityId,
        draft_ordinal: draftOrdinal,
      },
    );
  }
  const subjectiveView = expectJsonObject(
    expectProperty(
      requestInput,
      "subjective_view",
      "CharacterReactInput",
    ),
    "CharacterReactInput.subjective_view",
  );
  const character = expectJsonObject(
    expectProperty(
      subjectiveView,
      "character",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.character",
  );
  if (
    expectString(character, "entity_id", "EntityRef") !== run.entityId
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.reaction_character_mismatch",
      "Character reaction receipt belongs to another character",
      {
        proposal_id: proposalId,
        expected_entity_id: run.entityId,
        receipt_entity_id: expectString(
          character,
          "entity_id",
          "EntityRef",
        ),
      },
    );
  }
  return Object.freeze({
    character,
    model_proof: run.receipt.proof.value,
    candidates: Object.freeze([
      Object.freeze({
        draft_ordinal: draftOrdinal,
        candidate: materializeCharacterReactionCandidate({
          draft: reaction,
          event,
          subjectiveView,
        }),
      }),
    ]),
  });
}

function materializeCharacterReactionCandidate(input: {
  readonly draft: JsonObject;
  readonly event: JsonObject;
  readonly subjectiveView: JsonObject;
}): JsonObject {
  const gates = asObjectArray(
    expectProperty(
      input.event,
      "agency_gates",
      "CharacterReactEventInput",
    ),
    "CharacterReactEventInput.agency_gates",
  );
  const gateIds = gates.map((gate) =>
    expectString(gate, "gate_id", "CharacterReactAgencyGateInput"),
  );
  const agencyDecisions = Object.freeze(
    asObjectArray(
      expectProperty(
        input.draft,
        "agency_decisions",
        "CharacterReactionSemanticDraft",
      ),
      "CharacterReactionSemanticDraft.agency_decisions",
    ).map((decision, ordinal) => {
      const gateIndex = readModelIndex(
        expectProperty(
          decision,
          "gate_index",
          "AgencyDecisionSemanticDraft",
        ),
        `AgencyDecisionSemanticDraft[${ordinal}].gate_index`,
        gateIds.length,
      );
      return Object.freeze({
        gate_id: gateIds[gateIndex] as string,
        stance: expectString(
          decision,
          "stance",
          "AgencyDecisionSemanticDraft",
        ),
        terms: expectJsonObject(
          expectProperty(
            decision,
            "terms",
            "AgencyDecisionSemanticDraft",
          ),
          "AgencyDecisionSemanticDraft.terms",
        ),
      });
    }),
  );
  const selfOutcomes = Object.freeze(
    asObjectArray(
      expectProperty(
        input.draft,
        "self_outcomes",
        "CharacterReactionSemanticDraft",
      ),
      "CharacterReactionSemanticDraft.self_outcomes",
    ).map((outcome, ordinal) =>
      Object.freeze({
        outcome_id: `self_outcome_${ordinal}`,
        outcome_type: expectString(
          outcome,
          "outcome_type",
          "SelfSubjectiveOutcomeSemanticDraft",
        ),
        parameters: expectJsonObject(
          expectProperty(
            outcome,
            "parameters",
            "SelfSubjectiveOutcomeSemanticDraft",
          ),
          "SelfSubjectiveOutcomeSemanticDraft.parameters",
        ),
      }),
    ),
  );
  return Object.freeze({
    impact: expectString(
      input.draft,
      "impact",
      "CharacterReactionSemanticDraft",
    ),
    agency_decisions: agencyDecisions,
    self_outcomes: selfOutcomes,
    machine_decision: materializeMachineDecision(
      expectJsonObject(
        expectProperty(
          input.draft,
          "machine_decision",
          "CharacterReactionSemanticDraft",
        ),
        "CharacterReactionSemanticDraft.machine_decision",
      ),
      input.subjectiveView,
    ),
    source_event: Object.freeze({
      source_kind: "automatic",
      proposal_id: expectString(
        input.event,
        "proposal_id",
        "CharacterReactEventInput",
      ),
    }),
  });
}

function materializeMachineDecision(
  draft: JsonObject,
  subjectiveView: JsonObject,
): JsonObject {
  const decisionKind = expectString(
    draft,
    "decision_kind",
    "MachineDecisionSelector",
  );
  if (decisionKind === "keep") {
    return Object.freeze({ decision_kind: "keep" });
  }
  if (decisionKind !== "transition") {
    throw new EngineFault(
      "day_cycle.orchestration.machine_decision_invalid",
      "Character reaction has an unknown machine decision",
      { decision_kind: decisionKind },
    );
  }
  const actionMachine = expectJsonObject(
    expectProperty(
      subjectiveView,
      "action_machine",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.action_machine",
  );
  const outgoingTransitions = asObjectArray(
    expectProperty(
      actionMachine,
      "outgoing_transitions",
      "StateMachineModelView",
    ),
    "StateMachineModelView.outgoing_transitions",
  );
  const transitionIndex = readModelIndex(
    expectProperty(
      draft,
      "transition_index",
      "MachineDecisionSelector",
    ),
    "MachineDecisionSelector.transition_index",
    outgoingTransitions.length,
  );
  const transitionView = outgoingTransitions[transitionIndex] as JsonObject;
  const transition = expectJsonObject(
    expectProperty(
      transitionView,
      "transition",
      "StateMachineTransitionModelView",
    ),
    "StateMachineTransitionModelView.transition",
  );
  return Object.freeze({
    decision_kind: "transition",
    transition_id: expectString(
      transition,
      "transition_id",
      "MachineTransitionDefinition",
    ),
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

function hasRetiredCharacterOwner(
  worldState: JsonObject,
  instance: JsonObject,
): boolean {
  const owner = expectJsonObject(
    expectProperty(instance, "owner", "StateMachineInstanceState"),
    "StateMachineInstanceState.owner",
  );
  if (expectString(owner, "owner_kind", "StateMachineOwner") !== "character") {
    return false;
  }
  const entityId = expectString(owner, "entity_id", "StateMachineOwner");
  const matches = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  ).filter(
    (entity) =>
      expectString(entity, "entity_id", "EntityState") === entityId,
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "day_cycle.orchestration.machine_owner_invalid",
      "Character-owned state machine must resolve to exactly one Entity",
      { entity_id: entityId, matches: matches.length },
    );
  }
  return (
    expectString(matches[0] as JsonObject, "state", "EntityState") ===
    "retired"
  );
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
      "day_cycle.orchestration.basis_changed",
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
      "day_cycle.orchestration.basis_changed",
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

function modelRequestInput(
  receipt: VerifiedModelInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(receipt.request.value, "input", "ModelRequest"),
    "ModelRequest.input",
  );
}

function localizedText(locale: string, text: string): JsonObject {
  return Object.freeze({ [locale]: text });
}

function readModelIndices(
  object: JsonObject,
  field: string,
  label: string,
  collectionLength: number,
): readonly number[] {
  const value = expectProperty(object, field, label);
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "day_cycle.orchestration.model_index_array_invalid",
      `${label}.${field} must be an array`,
      { field },
    );
  }
  return Object.freeze(
    value.map((entry, ordinal) =>
      readModelIndex(
        entry,
        `${label}.${field}[${ordinal}]`,
        collectionLength,
      ),
    ),
  );
}

function readModelIndex(
  value: JsonValue,
  path: string,
  collectionLength: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= collectionLength
  ) {
    throw new EngineFault(
      "day_cycle.orchestration.model_index_out_of_range",
      `${path} is outside its verified collection`,
      {
        path,
        index: value,
        collection_length: collectionLength,
      },
    );
  }
  return value;
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
