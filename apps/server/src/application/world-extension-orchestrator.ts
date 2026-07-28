import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRulePluginOperationBinding,
  DeterministicContextAuthority,
} from "@luoxia/world-core/composition";

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
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

export interface WorldExtensionExecutionIdentityInput {
  readonly worldId: string;
  readonly goalPlanId: string;
  readonly goalNodeId: string;
  readonly extensionRequestId: string;
}

export interface WorldExtensionExecutionIdentityFactory {
  createRuleRequestId(
    input: WorldExtensionExecutionIdentityInput,
  ): string;
}

export interface WorldExtensionProvenanceClock {
  now(): string;
}

export interface WorldExtensionResolutionResult {
  readonly worldId: string;
  readonly worldRevision: number;
  readonly resolvedCount: number;
}

export interface WorldExtensionOrchestrator {
  resolvePending(input: {
    readonly worldId: string;
  }): Promise<WorldExtensionResolutionResult>;
}

export interface WorldExtensionOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly identities: WorldExtensionExecutionIdentityFactory;
  readonly provenanceClock: WorldExtensionProvenanceClock;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly mutations: WorldMutationOrchestrator;
}

interface WorldExtensionState {
  readonly binding: RuntimeWorldBinding;
  readonly worldState: JsonObject;
  readonly worldId: string;
  readonly worldRevision: number;
}

interface PendingWorldExtension {
  readonly goalPlanId: string;
  readonly goalNodeId: string;
  readonly extensionRequestId: string;
  readonly selectedArchetype: JsonObject;
}

export function createWorldExtensionOrchestrator(
  dependencies: WorldExtensionOrchestratorDependencies,
): WorldExtensionOrchestrator {
  return new DefaultWorldExtensionOrchestrator(dependencies);
}

class DefaultWorldExtensionOrchestrator
  implements WorldExtensionOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #identities: WorldExtensionExecutionIdentityFactory;
  readonly #provenanceClock: WorldExtensionProvenanceClock;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #mutations: WorldMutationOrchestrator;

  public constructor(
    dependencies: WorldExtensionOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#worlds = dependencies.worlds;
    this.#identities = dependencies.identities;
    this.#provenanceClock = dependencies.provenanceClock;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#mutations = dependencies.mutations;
  }

  public async resolvePending(input: {
    readonly worldId: string;
  }): Promise<WorldExtensionResolutionResult> {
    let resolvedCount = 0;
    for (;;) {
      const state = await this.#readAutonomousState(input.worldId);
      const pending = findFirstPendingWorldExtension(state);
      if (pending === undefined) {
        return Object.freeze({
          worldId: state.worldId,
          worldRevision: state.worldRevision,
          resolvedCount,
        });
      }
      await this.#resolveOne(state, pending);
      resolvedCount += 1;
    }
  }

  async #resolveOne(
    initial: WorldExtensionState,
    pending: PendingWorldExtension,
  ): Promise<void> {
    const ruleRequestId = this.#contracts.assert(
      CONTRACT_REF.uuid,
      this.#identities.createRuleRequestId({
        worldId: initial.worldId,
        goalPlanId: pending.goalPlanId,
        goalNodeId: pending.goalNodeId,
        extensionRequestId: pending.extensionRequestId,
      }),
    ).value;
    if (
      typeof ruleRequestId !== "string" ||
      ruleRequestId !== ruleRequestId.toLowerCase() ||
      ruleRequestId === pending.extensionRequestId
    ) {
      throw new EngineFault(
        "world_extension.orchestration.execution_identity_invalid",
        "WorldExtension RulePlugin request identity must be a distinct lowercase canonical UUID",
        {
          world_id: initial.worldId,
          goal_plan_id: pending.goalPlanId,
          goal_node_id: pending.goalNodeId,
          extension_request_id: pending.extensionRequestId,
        },
      );
    }
    const requestInput = Object.freeze({
      goal_plan_id: pending.goalPlanId,
      goal_node_id: pending.goalNodeId,
      request_id: pending.extensionRequestId,
    });
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: ruleRequestId,
      modelInvocations: [],
      candidateFactory: async () => {
        const state = await this.#readAutonomousState(initial.worldId);
        assertSamePendingBasis(state, initial, pending);
        const invocation = resolveWorldExtensionBinding(
          state,
          pending.selectedArchetype,
          this.#rulePluginAbi,
        );
        const deterministicContext = this.#deterministicContexts.issue({
          worldId: state.worldId,
          logicalTime: expectProperty(
            state.worldState,
            "clock",
            "WorldState",
          ),
          randomChoices: [],
          externalResults: [
            createProvenanceTimestampResult(
              this.#provenanceClock.now(),
              this.#digest,
            ),
          ],
        });
        return Object.freeze({
          contract_version: "rule-plugin.v1",
          record_type: "rule_plugin.request",
          request_id: ruleRequestId,
          plugin_lock: invocation.pluginLock,
          operation_id: invocation.operationId,
          operation_kind: "world_extension.resolve",
          basis_revision: state.worldRevision,
          readonly_world: state.binding.record.snapshot.value,
          deterministic_context: deterministicContext.value,
          input: requestInput,
        });
      },
    });

    const currentBinding = await this.#worlds.resolveCurrent(initial.worldId);
    const invocation = resolveWorldExtensionBinding(
      Object.freeze({
        binding: currentBinding,
        worldState: expectJsonObject(
          expectProperty(
            currentBinding.record.snapshot.value,
            "world_state",
            "WorldSnapshot",
          ),
          "WorldSnapshot.world_state",
        ),
        worldId: initial.worldId,
        worldRevision: expectInteger(
          currentBinding.record.snapshot.value,
          "world_revision",
          "WorldSnapshot",
        ),
      }),
      pending.selectedArchetype,
      this.#rulePluginAbi,
    );
    assertRecoveredWorldExtensionIdentity({
      receipt,
      initial,
      pending,
      requestId: ruleRequestId,
      requestInput,
      invocation,
      digest: this.#digest,
    });
    requireWorldExtensionProposal(receipt, pending);

    const result = await this.#mutations.commitRulePluginReceipt(receipt);
    const expectedRevision = initial.worldRevision + 1;
    const proposalId = expectString(
      (receipt.proposal as NonNullable<
        VerifiedRulePluginInvocationReceipt["proposal"]
      >).value,
      "proposal_id",
      "PacketProposal",
    );
    const actualRevision = expectInteger(
      result.value,
      "world_revision",
      "ApplyPacketResult",
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
        "world_extension.orchestration.commit_identity_mismatch",
        "WorldExtension packet commit returned an unexpected authoritative identity",
        {
          world_id: initial.worldId,
          goal_plan_id: pending.goalPlanId,
          goal_node_id: pending.goalNodeId,
          request_id: pending.extensionRequestId,
          proposal_id: proposalId,
          expected_world_revision: Number.isSafeInteger(expectedRevision)
            ? expectedRevision
            : null,
          actual_world_revision: actualRevision,
          result_status: resultStatus,
        },
      );
    }

    const after = await this.#readAutonomousState(initial.worldId);
    if (after.worldRevision !== expectedRevision) {
      throw new EngineFault(
        "world_extension.orchestration.post_commit_revision_mismatch",
        "World changed concurrently after a WorldExtension packet committed",
        {
          world_id: initial.worldId,
          request_id: pending.extensionRequestId,
          expected_world_revision: expectedRevision,
          actual_world_revision: after.worldRevision,
        },
      );
    }
    assertWorldExtensionConsumed(after, pending);
  }

  async #readAutonomousState(
    worldId: string,
  ): Promise<WorldExtensionState> {
    const binding = await this.#worlds.resolveCurrent(worldId);
    const snapshot = binding.record.snapshot.value;
    const actualWorldId = expectString(
      snapshot,
      "world_id",
      "WorldSnapshot",
    );
    if (actualWorldId !== worldId) {
      throw new EngineFault(
        "world_extension.orchestration.world_identity_mismatch",
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
    const phase = expectString(dayCycle, "phase", "DayCycleState");
    if (phase !== "autonomous") {
      throw new EngineFault(
        "world_extension.orchestration.phase_invalid",
        "Committed WorldExtension requests are resolved only during the autonomous phase",
        { world_id: worldId, phase },
      );
    }
    return Object.freeze({
      binding,
      worldState,
      worldId,
      worldRevision: expectInteger(
        snapshot,
        "world_revision",
        "WorldSnapshot",
      ),
    });
  }
}

function findFirstPendingWorldExtension(
  state: WorldExtensionState,
): PendingWorldExtension | undefined {
  for (const plan of asObjectArray(
    expectProperty(state.worldState, "goal_plans", "WorldState"),
    "WorldState.goal_plans",
  )) {
    if (expectString(plan, "status", "GoalPlan") !== "active") {
      continue;
    }
    if (
      expectString(plan, "world_id", "GoalPlan") !== state.worldId
    ) {
      throw new EngineFault(
        "world_extension.orchestration.plan_world_mismatch",
        "GoalPlan belongs to a different runtime world",
        {
          world_id: state.worldId,
          goal_plan_id: expectString(plan, "plan_id", "GoalPlan"),
        },
      );
    }
    for (const node of asObjectArray(
      expectProperty(plan, "nodes", "GoalPlan"),
      "GoalPlan.nodes",
    )) {
      if (node.world_extension === undefined) {
        continue;
      }
      const extension = expectJsonObject(
        node.world_extension,
        "GoalNode.world_extension",
      );
      const requirement = expectJsonObject(
        expectProperty(
          node,
          "capability_requirement",
          "GoalNode",
        ),
        "GoalNode.capability_requirement",
      );
      if (
        expectString(
          requirement,
          "requirement_kind",
          "CapabilityRequirement",
        ) !== "demand"
      ) {
        throw new EngineFault(
          "world_extension.orchestration.requirement_invalid",
          "WorldExtensionRequest requires a demand capability requirement",
          {
            goal_plan_id: expectString(plan, "plan_id", "GoalPlan"),
            goal_node_id: expectString(node, "node_id", "GoalNode"),
          },
        );
      }
      const demand = expectJsonObject(
        expectProperty(
          requirement,
          "demand",
          "CapabilityRequirement",
        ),
        "CapabilityRequirement.demand",
      );
      const nodeId = expectString(node, "node_id", "GoalNode");
      const demandId = expectString(
        demand,
        "demand_id",
        "CapabilityDemand",
      );
      if (
        expectString(
          extension,
          "goal_node_id",
          "WorldExtensionRequest",
        ) !== nodeId ||
        expectString(
          extension,
          "demand_id",
          "WorldExtensionRequest",
        ) !== demandId
      ) {
        throw new EngineFault(
          "world_extension.orchestration.request_identity_mismatch",
          "WorldExtensionRequest does not match its owning GoalNode demand",
          {
            goal_plan_id: expectString(plan, "plan_id", "GoalPlan"),
            goal_node_id: nodeId,
            demand_id: demandId,
          },
        );
      }
      const selectedArchetype = expectJsonObject(
        expectProperty(
          extension,
          "selected_archetype",
          "WorldExtensionRequest",
        ),
        "WorldExtensionRequest.selected_archetype",
      );
      const allowed = asObjectArray(
        expectProperty(
          demand,
          "allowed_archetypes",
          "CapabilityDemand",
        ),
        "CapabilityDemand.allowed_archetypes",
      );
      if (
        allowed.filter((candidate) =>
          jsonEquals(candidate, selectedArchetype),
        ).length !== 1
      ) {
        throw new EngineFault(
          "world_extension.orchestration.archetype_not_allowed",
          "WorldExtensionRequest selected archetype is not an exact allowed demand archetype",
          {
            goal_plan_id: expectString(plan, "plan_id", "GoalPlan"),
            goal_node_id: nodeId,
            demand_id: demandId,
          },
        );
      }
      return Object.freeze({
        goalPlanId: expectString(plan, "plan_id", "GoalPlan"),
        goalNodeId: nodeId,
        extensionRequestId: expectString(
          extension,
          "request_id",
          "WorldExtensionRequest",
        ),
        selectedArchetype,
      });
    }
  }
  return undefined;
}

function resolveWorldExtensionBinding(
  state: WorldExtensionState,
  selectedArchetype: JsonObject,
  abi: RulePluginAbiRegistry,
): RuntimeRulePluginInvocationBinding {
  const bundleId = expectString(
    selectedArchetype,
    "bundle_id",
    "GenerationArchetypeCatalogRef",
  );
  const bundleDigest = expectString(
    selectedArchetype,
    "bundle_digest",
    "GenerationArchetypeCatalogRef",
  );
  const localId = expectString(
    selectedArchetype,
    "local_id",
    "GenerationArchetypeCatalogRef",
  );
  if (
    expectString(
      selectedArchetype,
      "catalog_kind",
      "GenerationArchetypeCatalogRef",
    ) !== "generation_archetype" ||
    bundleId !== state.binding.contentBinding.packId ||
    bundleDigest !== state.binding.contentBinding.bundleDigest
  ) {
    throw new EngineFault(
      "world_extension.orchestration.archetype_lock_mismatch",
      "Selected GenerationArchetype must belong to the current locked root ContentBundle",
      {
        world_id: state.worldId,
        bundle_id: bundleId,
        bundle_digest: bundleDigest,
        archetype_id: localId,
      },
    );
  }
  return resolveRulePluginInvocationBinding({
    binding: state.binding.contentBinding,
    operationKind: "world_extension.resolve",
    abi,
    faultOwner: `generation_archetype:${localId}`,
    sourcePredicate: (
      candidate: ContentRulePluginOperationBinding,
    ): boolean =>
      expectString(
        candidate.source,
        "pack_id",
        "RulePlugin operation source",
      ) === bundleId &&
      expectString(
        candidate.source,
        "bundle_digest",
        "RulePlugin operation source",
      ) === bundleDigest &&
      expectString(
        candidate.source,
        "owner_kind",
        "RulePlugin operation source",
      ) === "generation_archetype" &&
      expectString(
        candidate.source,
        "owner_id",
        "RulePlugin operation source",
      ) === localId,
  });
}

function assertSamePendingBasis(
  current: WorldExtensionState,
  initial: WorldExtensionState,
  pending: PendingWorldExtension,
): void {
  if (
    current.worldRevision !== initial.worldRevision ||
    findMatchingPendingWorldExtension(current, pending) === undefined
  ) {
    throw new EngineFault(
      "world_extension.orchestration.basis_changed",
      "WorldExtension request changed before its RulePlugin request was persisted",
      {
        world_id: initial.worldId,
        goal_plan_id: pending.goalPlanId,
        goal_node_id: pending.goalNodeId,
        request_id: pending.extensionRequestId,
        expected_world_revision: initial.worldRevision,
        actual_world_revision: current.worldRevision,
      },
    );
  }
}

function findMatchingPendingWorldExtension(
  state: WorldExtensionState,
  pending: PendingWorldExtension,
): PendingWorldExtension | undefined {
  for (const plan of asObjectArray(
    expectProperty(state.worldState, "goal_plans", "WorldState"),
    "WorldState.goal_plans",
  )) {
    if (
      expectString(plan, "plan_id", "GoalPlan") !==
      pending.goalPlanId
    ) {
      continue;
    }
    for (const node of asObjectArray(
      expectProperty(plan, "nodes", "GoalPlan"),
      "GoalPlan.nodes",
    )) {
      if (
        expectString(node, "node_id", "GoalNode") !==
          pending.goalNodeId ||
        node.world_extension === undefined
      ) {
        continue;
      }
      const extension = expectJsonObject(
        node.world_extension,
        "GoalNode.world_extension",
      );
      const selected = expectJsonObject(
        expectProperty(
          extension,
          "selected_archetype",
          "WorldExtensionRequest",
        ),
        "WorldExtensionRequest.selected_archetype",
      );
      if (
        expectString(
          extension,
          "request_id",
          "WorldExtensionRequest",
        ) === pending.extensionRequestId &&
        jsonEquals(selected, pending.selectedArchetype)
      ) {
        return pending;
      }
    }
  }
  return undefined;
}

function assertRecoveredWorldExtensionIdentity(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly initial: WorldExtensionState;
  readonly pending: PendingWorldExtension;
  readonly requestId: string;
  readonly requestInput: JsonObject;
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly digest: JsonDigest;
}): void {
  const request = input.receipt.request.value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      request,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const provenanceResults = asObjectArray(
    expectProperty(
      deterministicContext,
      "external_results",
      "DeterministicContext",
    ),
    "DeterministicContext.external_results",
  ).filter(
    (result) =>
      expectString(
        result,
        "result_id",
        "DeterministicExternalResult",
      ) === "system_provenance_created_at",
  );
  const provenanceResult = provenanceResults[0];
  const provenancePayload = provenanceResult?.payload;
  if (
    input.receipt.worldId !== input.initial.worldId ||
    input.receipt.basisRevision !== input.initial.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      input.requestId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "world_extension.resolve" ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.initial.worldRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.initial.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== input.initial.worldRevision ||
    !jsonEquals(
      expectProperty(request, "plugin_lock", "RulePluginRequest"),
      input.invocation.pluginLock,
    ) ||
    !jsonEquals(
      expectProperty(request, "input", "RulePluginRequest"),
      input.requestInput,
    ) ||
    provenanceResults.length !== 1 ||
    typeof provenancePayload !== "string" ||
    expectString(
      provenanceResult as JsonObject,
      "content_digest",
      "DeterministicExternalResult",
    ) !== input.digest.sha256(provenancePayload)
  ) {
    throw new EngineFault(
      "world_extension.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its committed WorldExtensionRequest",
      {
        world_id: input.initial.worldId,
        goal_plan_id: input.pending.goalPlanId,
        goal_node_id: input.pending.goalNodeId,
        request_id: input.pending.extensionRequestId,
        rule_request_id: input.requestId,
      },
    );
  }
}

function createProvenanceTimestampResult(
  preparedAt: string,
  digest: JsonDigest,
): JsonObject {
  return Object.freeze({
    result_id: "system_provenance_created_at",
    content_digest: digest.sha256(preparedAt),
    payload: preparedAt,
  });
}

function requireWorldExtensionProposal(
  receipt: VerifiedRulePluginInvocationReceipt,
  pending: PendingWorldExtension,
): asserts receipt is VerifiedRulePluginInvocationReceipt & {
  readonly proposal: NonNullable<
    VerifiedRulePluginInvocationReceipt["proposal"]
  >;
} {
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
    "Required WorldExtension resolution did not produce a ContentPacket proposal",
    {
      operation_kind: "world_extension.resolve",
      output_kind: expectString(
        output,
        "output_kind",
        "RulePluginResponse.output",
      ),
      reject_code:
        output.code === undefined
          ? ""
          : expectString(output, "code", "RejectOutput"),
      request_id: pending.extensionRequestId,
      goal_plan_id: pending.goalPlanId,
      goal_node_id: pending.goalNodeId,
    },
  );
}

function assertWorldExtensionConsumed(
  state: WorldExtensionState,
  pending: PendingWorldExtension,
): void {
  if (findMatchingPendingWorldExtension(state, pending) !== undefined) {
    throw new EngineFault(
      "world_extension.orchestration.request_not_consumed",
      "Committed WorldExtension packet did not consume its target request",
      {
        world_id: state.worldId,
        goal_plan_id: pending.goalPlanId,
        goal_node_id: pending.goalNodeId,
        request_id: pending.extensionRequestId,
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
      "world_extension.orchestration.world_shape_invalid",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
