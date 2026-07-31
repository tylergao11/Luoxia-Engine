import {
  CONTRACT_REF,
  EngineFault,
  assertSaveEnvelopeRelationships,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
  type ContractValidator,
  type StageOutcomeTransitionKind,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  ContentUpgradeAuthorizationAuthority,
  StateMachineContractAuthority,
  WorldContentLockDocument,
} from "@luoxia/world-core";

import {
  closeAgencyGateOutcomeLinks,
  effectiveEventCardAgencyGates,
  listDialogueCommitmentSelectors,
  withEffectiveOutcomeSubjects,
} from "./event-card-draft-normalize.js";
import type {
  RulePluginRequestDocument,
  RulePluginResponseDocument,
  RulePluginSemanticGate,
} from "./rule-plugin-gateway.js";
import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";
import type { StageContractAuthority } from "./stage-contract-authority.js";

const OPERATION_KINDS = [
  "rule.evaluate",
  "capability.resolve",
  "navigation.resolve",
  "definition.validate",
  "goal_plan.validate",
  "world_extension.resolve",
  "content_upgrade.transform",
  "day_cycle.advance",
  "state_machine.advance",
  "automatic_event.world.resolve",
  "automatic_event.character.resolve",
  "stage_outcome.resolve",
  "dialogue.open",
  "dialogue.turn.append",
  "dialogue.close",
  "event_card.publish",
] as const;

type OperationKind = (typeof OPERATION_KINDS)[number];

interface OperationContext {
  readonly contracts: ContractValidator;
  readonly request: RulePluginRequestDocument;
  readonly response: RulePluginResponseDocument;
  readonly digest: JsonDigest;
  readonly operationKind: OperationKind;
  readonly input: JsonObject;
  readonly output: JsonObject;
  readonly outputKind: string;
  readonly worldId: string;
  readonly world: JsonObject;
  readonly worldContentLock: WorldContentLockDocument;
  readonly stageContracts: StageContractAuthority;
  readonly stateMachineContracts: StateMachineContractAuthority;
}

interface EvidenceContext {
  readonly request: RulePluginRequestDocument;
  readonly digest: JsonDigest;
  readonly operationKind: OperationKind;
  readonly input: JsonObject;
  readonly worldId: string;
  readonly basisRevision: number;
  readonly catalog: ContentRuntimeCatalog;
  readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
}

type OperationHandler = (context: OperationContext) => void;

export interface RulePluginContentUpgradeClock {
  now(): string;
}

export interface RulePluginSemanticGateDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly catalog: ContentRuntimeCatalog;
  readonly contentUpgradeAuthorizations: ContentUpgradeAuthorizationAuthority;
  readonly contentUpgradeClock: RulePluginContentUpgradeClock;
  readonly stageContracts: StageContractAuthority;
  readonly stateMachineContracts: StateMachineContractAuthority;
}

export function createRulePluginSemanticGate(
  dependencies: RulePluginSemanticGateDependencies,
): RulePluginSemanticGate {
  return new DefaultRulePluginSemanticGate(dependencies);
}

class DefaultRulePluginSemanticGate implements RulePluginSemanticGate {
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #catalog: ContentRuntimeCatalog;
  readonly #contentUpgradeAuthorizations: ContentUpgradeAuthorizationAuthority;
  readonly #contentUpgradeClock: RulePluginContentUpgradeClock;
  readonly #stageContracts: StageContractAuthority;
  readonly #stateMachineContracts: StateMachineContractAuthority;

  public constructor(dependencies: RulePluginSemanticGateDependencies) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#catalog = dependencies.catalog;
    this.#contentUpgradeAuthorizations =
      dependencies.contentUpgradeAuthorizations;
    this.#contentUpgradeClock = dependencies.contentUpgradeClock;
    this.#stageContracts = dependencies.stageContracts;
    this.#stateMachineContracts = dependencies.stateMachineContracts;
  }

  public async assertRequestEvidence(
    request: RulePluginRequestDocument,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<void> {
    const operationKind = expectString(
      request.value,
      "operation_kind",
      "RulePluginRequest",
    ) as OperationKind;
    if (OPERATION_HANDLERS[operationKind] === undefined) {
      throw fault(
        "rule_plugin.semantic.operation_unknown",
        `Unknown RulePlugin operation_kind ${operationKind}`,
        { operation_kind: operationKind },
      );
    }
    const worldSnapshot = expectJsonObject(
      expectProperty(request.value, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const worldId = expectString(
      worldSnapshot,
      "world_id",
      "RulePluginRequest.readonly_world",
    );
    const worldRevision = expectInteger(
      worldSnapshot,
      "world_revision",
      "RulePluginRequest.readonly_world",
    );
    const basisRevision = expectInteger(
      request.value,
      "basis_revision",
      "RulePluginRequest",
    );
    if (worldRevision !== basisRevision) {
      throw fault(
        "rule_plugin.semantic.world_snapshot_revision_mismatch",
        "RulePluginRequest readonly_world revision does not match basis_revision",
        {
          world_id: worldId,
          world_revision: worldRevision,
          basis_revision: basisRevision,
        },
      );
    }
    const input = expectJsonObject(
      expectProperty(request.value, "input", "RulePluginRequest"),
      "RulePluginRequest.input",
    );
    if (operationKind === "content_upgrade.transform") {
      assertContentUpgradeRequest({
        contracts: this.#contracts,
        digest: this.#digest,
        authorizations: this.#contentUpgradeAuthorizations,
        currentTime: this.#contentUpgradeClock.now(),
        request: request.value,
        input,
        readonlyWorld: worldSnapshot,
      });
    }
    if (operationKind === "state_machine.advance") {
      assertStateMachineAdvanceInput({
        input,
        world: expectJsonObject(
          expectProperty(
            worldSnapshot,
            "world_state",
            "RulePluginRequest.readonly_world",
          ),
          "RulePluginRequest.readonly_world.world_state",
        ),
        worldId,
        worldContentLock: this.#contracts.assertObject(
          CONTRACT_REF.worldContentLock,
          worldContentLock(
            worldSnapshot,
            "RulePluginRequest.readonly_world",
          ),
        ),
        authority: this.#stateMachineContracts,
      });
    }
    assertModelEvidenceForOperation({
      request,
      digest: this.#digest,
      operationKind,
      input,
      worldId,
      basisRevision,
      catalog: this.#catalog,
      modelInvocations,
    });
  }

  public async assertValid(
    request: RulePluginRequestDocument,
    response: RulePluginResponseDocument,
  ): Promise<void> {
    const operationKind = expectString(
      request.value,
      "operation_kind",
      "RulePluginRequest",
    ) as OperationKind;
    const handler = OPERATION_HANDLERS[operationKind];
    if (handler === undefined) {
      throw fault(
        "rule_plugin.semantic.operation_unknown",
        `Unknown RulePlugin operation_kind ${operationKind}`,
        { operation_kind: operationKind },
      );
    }

    const input = expectJsonObject(
      expectProperty(request.value, "input", "RulePluginRequest"),
      "RulePluginRequest.input",
    );
    const output = expectJsonObject(
      expectProperty(response.value, "output", "RulePluginResponse"),
      "RulePluginResponse.output",
    );
    const worldSnapshot = expectJsonObject(
      expectProperty(request.value, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const worldId = expectString(
      worldSnapshot,
      "world_id",
      "RulePluginRequest.readonly_world",
    );
    const world = expectJsonObject(
      expectProperty(
        worldSnapshot,
        "world_state",
        "RulePluginRequest.readonly_world",
      ),
      "RulePluginRequest.readonly_world.world_state",
    );
    const validatedWorldContentLock = this.#contracts.assertObject(
      CONTRACT_REF.worldContentLock,
      worldContentLock(worldSnapshot, "RulePluginRequest.readonly_world"),
    );

    handler({
      contracts: this.#contracts,
      request,
      response,
      digest: this.#digest,
      operationKind,
      input,
      output,
      outputKind: expectString(output, "output_kind", "RulePluginResponse.output"),
      worldId,
      world,
      worldContentLock: validatedWorldContentLock,
      stageContracts: this.#stageContracts,
      stateMachineContracts: this.#stateMachineContracts,
    });
  }
}

const OPERATION_HANDLERS: {
  readonly [K in OperationKind]: OperationHandler;
} = {
  "rule.evaluate": handleRuleEvaluate,
  "capability.resolve": handleCapabilityResolve,
  "navigation.resolve": handleNavigationResolve,
  "definition.validate": handleDefinitionValidate,
  "goal_plan.validate": handleGoalPlanValidate,
  "world_extension.resolve": handleWorldExtensionResolve,
  "content_upgrade.transform": handleContentUpgradeTransform,
  "day_cycle.advance": handleDayCycleAdvance,
  "state_machine.advance": handleStateMachineAdvance,
  "automatic_event.world.resolve": handleWorldAutomaticEventResolve,
  "automatic_event.character.resolve": handleCharacterAutomaticEventResolve,
  "stage_outcome.resolve": handleStageOutcomeResolve,
  "dialogue.open": handleDialogueOpen,
  "dialogue.turn.append": handleDialogueTurnAppend,
  "dialogue.close": handleDialogueClose,
  "event_card.publish": handleEventCardPublish,
};

function handleRuleEvaluate(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "validation":
      assertValidationOutput(context.output);
      return;
    default:
      throw unexpectedOutput(context);
  }
}

function handleCapabilityResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "choice.required":
      assertChoiceSpec(context);
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      assertActorEntityExists(context, context.input);
      void proposal;
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleNavigationResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "entity.relocate", context.operationKind);
      const actor = expectJsonObject(
        expectProperty(context.input, "actor", "NavigationResolveInput"),
        "NavigationResolveInput.actor",
      );
      const destination = expectJsonObject(
        expectProperty(context.input, "destination", "NavigationResolveInput"),
        "NavigationResolveInput.destination",
      );
      const opEntity = expectJsonObject(
        expectProperty(op, "entity", "EntityRelocateOp"),
        "EntityRelocateOp.entity",
      );
      const opDestination = expectJsonObject(
        expectProperty(op, "destination", "EntityRelocateOp"),
        "EntityRelocateOp.destination",
      );
      assertJsonFieldEqual(
        "navigation.actor",
        actor,
        opEntity,
        context.operationKind,
      );
      assertJsonFieldEqual(
        "navigation.destination",
        destination,
        opDestination,
        context.operationKind,
      );
      assertHumanControlMatchesActor(context, context.input, actor);
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleDefinitionValidate(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "definition.register", context.operationKind);
      const definitionId = expectString(
        context.input,
        "definition_id",
        "DefinitionValidationInput",
      );
      const candidate = expectJsonObject(
        expectProperty(context.input, "candidate", "DefinitionValidationInput"),
        "DefinitionValidationInput.candidate",
      );
      const draft = expectJsonObject(
        expectProperty(candidate, "draft", "DynamicDefinitionProposal"),
        "DynamicDefinitionProposal.draft",
      );
      const modelProposalId = expectString(
        candidate,
        "proposal_id",
        "DynamicDefinitionProposal",
      );
      assertEqual(
        "definition_id",
        definitionId,
        expectString(op, "definition_id", "DefinitionRegisterOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "definition_type",
        expectProperty(draft, "definition_type", "DynamicDefinitionDraft"),
        expectProperty(op, "definition_type", "DefinitionRegisterOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "definition.name",
        expectProperty(draft, "name", "DynamicDefinitionDraft"),
        expectProperty(op, "name", "DefinitionRegisterOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "definition.components",
        expectProperty(draft, "components", "DynamicDefinitionDraft"),
        expectProperty(op, "components", "DefinitionRegisterOp"),
        context.operationKind,
      );
      if (draft.summary !== undefined || op.summary !== undefined) {
        assertJsonFieldEqual(
          "definition.summary",
          draft.summary ?? null,
          op.summary ?? null,
          context.operationKind,
        );
      }
      assertModelProposalProvenance(
        context,
        expectJsonObject(
          expectProperty(op, "provenance", "DefinitionRegisterOp"),
          "DefinitionRegisterOp.provenance",
        ),
        modelProposalId,
      );
      assertModelProofRevisionCompatible(context, context.input, "model_proof");
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleGoalPlanValidate(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "goal_plan.upsert", context.operationKind);
      const goalPlan = expectJsonObject(
        expectProperty(op, "goal_plan", "GoalPlanUpsertOp"),
        "GoalPlanUpsertOp.goal_plan",
      );
      const planId = expectString(context.input, "plan_id", "GoalPlanValidateInput");
      const candidate = expectJsonObject(
        expectProperty(context.input, "candidate", "GoalPlanValidateInput"),
        "GoalPlanValidateInput.candidate",
      );
      const draft = expectJsonObject(
        expectProperty(candidate, "draft", "GoalPlanProposal"),
        "GoalPlanProposal.draft",
      );
      const proposalId = expectString(
        candidate,
        "proposal_id",
        "GoalPlanProposal",
      );
      const ownerActorId = expectString(
        candidate,
        "owner_actor_id",
        "GoalPlanProposal",
      );
      const requestBasis = expectInteger(
        context.request.value,
        "basis_revision",
        "RulePluginRequest",
      );

      assertEqual(
        "goal_plan.plan_id",
        planId,
        expectString(goalPlan, "plan_id", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.source_proposal_id",
        proposalId,
        expectString(goalPlan, "source_proposal_id", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.owner_actor_id",
        ownerActorId,
        expectString(goalPlan, "owner_actor_id", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.basis_revision",
        requestBasis,
        expectInteger(goalPlan, "basis_revision", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.world_id",
        context.worldId,
        expectString(goalPlan, "world_id", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.expected_revision",
        0,
        expectInteger(op, "expected_revision", "GoalPlanUpsertOp"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.revision",
        1,
        expectInteger(goalPlan, "revision", "GoalPlan"),
        context.operationKind,
      );
      assertEqual(
        "goal_plan.status",
        "active",
        expectString(goalPlan, "status", "GoalPlan"),
        context.operationKind,
      );
      if (goalPlan.failure_code !== undefined) {
        throw fault(
          "rule_plugin.semantic.goal_plan_initial_failure_forbidden",
          "A newly validated active GoalPlan must not carry failure_code",
          { operation_kind: context.operationKind, plan_id: planId },
        );
      }

      const draftDigest = context.digest.sha256(draft);
      assertEqual(
        "goal_plan.source_draft_digest",
        draftDigest,
        expectString(goalPlan, "source_draft_digest", "GoalPlan"),
        context.operationKind,
      );

      for (const field of [
        "goal",
        "expected_state",
        "fact_refs",
        "constraints",
        "knowledge_scope",
      ] as const) {
        assertJsonFieldEqual(
          `goal_plan.${field}`,
          expectProperty(draft, field, "GoalPlanDraft"),
          expectProperty(goalPlan, field, "GoalPlan"),
          context.operationKind,
        );
      }

      assertGoalPlanNodesFromDraft(context, draft, goalPlan);
      assertModelProposalProvenance(
        context,
        expectJsonObject(
          expectProperty(goalPlan, "provenance", "GoalPlan"),
          "GoalPlan.provenance",
        ),
        proposalId,
        ownerActorId,
      );
      assertModelProofRevisionCompatible(context, context.input, "model_proof");
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertModelProposalProvenance(
  context: OperationContext,
  provenance: JsonObject,
  proposalId: string,
  actorId?: string,
): void {
  const createdAt = requireSystemProvenanceCreatedAt(context);
  if (
    expectString(provenance, "origin_kind", "Provenance") !==
      "model_proposal" ||
    expectString(provenance, "origin_id", "Provenance") !== proposalId ||
    expectString(provenance, "created_at", "Provenance") !== createdAt ||
    (actorId === undefined
      ? provenance.actor_id !== undefined
      : expectString(provenance, "actor_id", "Provenance") !== actorId) ||
    provenance.parent_event_ids !== undefined
  ) {
    throw fault(
      "rule_plugin.semantic.model_provenance_mismatch",
      "Validated model proposal provenance must use its proposal identity and Journal-owned stable timestamp",
      {
        operation_kind: context.operationKind,
        proposal_id: proposalId,
        expected_actor_id: actorId ?? "",
        expected_created_at: createdAt,
      },
    );
  }
}

function requireSystemProvenanceCreatedAt(
  context: OperationContext,
): string {
  const deterministicContext = expectJsonObject(
    expectProperty(
      context.request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const matches = asObjectArray(
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
  if (matches.length !== 1) {
    throw fault(
      "rule_plugin.semantic.system_provenance_result_count",
      "Definition and GoalPlan validation require exactly one Journal-owned provenance timestamp result",
      {
        operation_kind: context.operationKind,
        result_count: matches.length,
      },
    );
  }
  const result = matches[0] as JsonObject;
  const payload = expectProperty(
    result,
    "payload",
    "DeterministicExternalResult",
  );
  if (typeof payload !== "string") {
    throw fault(
      "rule_plugin.semantic.system_provenance_payload_invalid",
      "Journal-owned provenance timestamp payload must be a string",
      { operation_kind: context.operationKind },
    );
  }
  assertEqual(
    "system_provenance_created_at.content_digest",
    context.digest.sha256(payload),
    expectString(
      result,
      "content_digest",
      "DeterministicExternalResult",
    ),
    context.operationKind,
  );
  return payload;
}

function assertGoalPlanNodesFromDraft(
  context: OperationContext,
  draft: JsonObject,
  goalPlan: JsonObject,
): void {
  const draftNodes = asObjectArray(
    expectProperty(draft, "nodes", "GoalPlanDraft"),
    "GoalPlanDraft.nodes",
  );
  const planNodes = asObjectArray(
    expectProperty(goalPlan, "nodes", "GoalPlan"),
    "GoalPlan.nodes",
  );
  if (draftNodes.length !== planNodes.length) {
    throw fault(
      "rule_plugin.semantic.goal_plan_nodes_length",
      "GoalPlan nodes length must match GoalPlanDraft nodes",
      {
        operation_kind: context.operationKind,
        draft_count: draftNodes.length,
        plan_count: planNodes.length,
      },
    );
  }

  const planById = new Map<string, JsonObject>();
  const extensionRequestIds = new Set<string>();
  for (const node of planNodes) {
    const nodeId = expectString(node, "node_id", "GoalNode");
    if (planById.has(nodeId)) {
      throw fault(
        "rule_plugin.semantic.goal_plan_duplicate_node",
        `Duplicate GoalPlan node_id ${nodeId}`,
        { operation_kind: context.operationKind, node_id: nodeId },
      );
    }
    planById.set(nodeId, node);
  }

  for (const draftNode of draftNodes) {
    const nodeKey = expectString(draftNode, "node_key", "GoalNodeDraft");
    const planNode = planById.get(nodeKey);
    if (planNode === undefined) {
      throw fault(
        "rule_plugin.semantic.goal_plan_node_missing",
        `GoalPlan missing node for draft node_key ${nodeKey}`,
        { operation_kind: context.operationKind, node_key: nodeKey },
      );
    }

    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.title`,
      expectProperty(draftNode, "title", "GoalNodeDraft"),
      expectProperty(planNode, "title", "GoalNode"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.capability_requirement`,
      expectProperty(draftNode, "capability_requirement", "GoalNodeDraft"),
      expectProperty(planNode, "capability_requirement", "GoalNode"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.arguments`,
      expectProperty(draftNode, "arguments", "GoalNodeDraft"),
      expectProperty(planNode, "arguments", "GoalNode"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.depends_on`,
      expectProperty(draftNode, "depends_on", "GoalNodeDraft"),
      expectProperty(planNode, "depends_on", "GoalNode"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.completion_rules`,
      expectProperty(draftNode, "completion_rules", "GoalNodeDraft"),
      expectProperty(planNode, "completion_rules", "GoalNode"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      `goal_plan.node.${nodeKey}.alternatives`,
      expectProperty(draftNode, "alternative_node_keys", "GoalNodeDraft"),
      expectProperty(planNode, "alternative_node_ids", "GoalNode"),
      context.operationKind,
    );

    const requirement = expectJsonObject(
      expectProperty(draftNode, "capability_requirement", "GoalNodeDraft"),
      "GoalNodeDraft.capability_requirement",
    );
    const requirementKind = expectString(
      requirement,
      "requirement_kind",
      "CapabilityRequirement",
    );
    if (requirementKind === "demand") {
      assertEqual(
        `goal_plan.node.${nodeKey}.state`,
        "blocked",
        expectString(planNode, "state", "GoalNode"),
        context.operationKind,
      );
      const extension = expectJsonObject(
        expectProperty(planNode, "world_extension", "GoalNode"),
        "GoalNode.world_extension",
      );
      const demand = expectJsonObject(
        expectProperty(requirement, "demand", "CapabilityRequirement"),
        "CapabilityRequirement.demand",
      );
      assertEqual(
        `goal_plan.node.${nodeKey}.world_extension.goal_node_id`,
        nodeKey,
        expectString(extension, "goal_node_id", "WorldExtensionRequest"),
        context.operationKind,
      );
      assertEqual(
        `goal_plan.node.${nodeKey}.world_extension.demand_id`,
        expectString(demand, "demand_id", "CapabilityDemand"),
        expectString(extension, "demand_id", "WorldExtensionRequest"),
        context.operationKind,
      );
      const selectedArchetype = expectJsonObject(
        expectProperty(
          extension,
          "selected_archetype",
          "WorldExtensionRequest",
        ),
        "WorldExtensionRequest.selected_archetype",
      );
      const allowedArchetypes = asObjectArray(
        expectProperty(
          demand,
          "allowed_archetypes",
          "CapabilityDemand",
        ),
        "CapabilityDemand.allowed_archetypes",
      );
      if (
        allowedArchetypes.filter((candidate) =>
          jsonEquals(candidate, selectedArchetype),
        ).length !== 1
      ) {
        throw fault(
          "rule_plugin.semantic.goal_plan_extension_archetype_not_allowed",
          "WorldExtensionRequest.selected_archetype must be one exact member of CapabilityDemand.allowed_archetypes",
          {
            operation_kind: context.operationKind,
            node_id: nodeKey,
            demand_id: expectString(
              demand,
              "demand_id",
              "CapabilityDemand",
            ),
          },
        );
      }
      const extensionRequestId = expectString(
        extension,
        "request_id",
        "WorldExtensionRequest",
      );
      if (extensionRequestIds.has(extensionRequestId)) {
        throw fault(
          "rule_plugin.semantic.goal_plan_extension_request_duplicate",
          `Duplicate WorldExtensionRequest request_id ${extensionRequestId}`,
          {
            operation_kind: context.operationKind,
            request_id: extensionRequestId,
          },
        );
      }
      extensionRequestIds.add(extensionRequestId);
    } else if (planNode.world_extension !== undefined) {
      throw fault(
        "rule_plugin.semantic.goal_plan_extension_forbidden",
        `Bound GoalNode ${nodeKey} must not carry world_extension`,
        { operation_kind: context.operationKind, node_id: nodeKey },
      );
    }
  }
}

function handleWorldExtensionResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const goalPlanId = expectString(
        context.input,
        "goal_plan_id",
        "WorldExtensionResolveInput",
      );
      const goalNodeId = expectString(
        context.input,
        "goal_node_id",
        "WorldExtensionResolveInput",
      );
      const requestId = expectString(
        context.input,
        "request_id",
        "WorldExtensionResolveInput",
      );

      const worldPlan = findGoalPlan(context.world, goalPlanId);
      if (worldPlan === undefined) {
        throw fault(
          "rule_plugin.semantic.world_extension_plan_missing",
          `WorldExtension request references missing goal plan ${goalPlanId}`,
          { operation_kind: context.operationKind, goal_plan_id: goalPlanId },
        );
      }
      const worldNode = findGoalNode(worldPlan, goalNodeId);
      if (worldNode === undefined) {
        throw fault(
          "rule_plugin.semantic.world_extension_node_missing",
          `WorldExtension request references missing goal node ${goalNodeId}`,
          {
            operation_kind: context.operationKind,
            goal_plan_id: goalPlanId,
            goal_node_id: goalNodeId,
          },
        );
      }
      const extension = worldNode.world_extension;
      if (extension === undefined || !isJsonObject(extension)) {
        throw fault(
          "rule_plugin.semantic.world_extension_request_missing",
          `Goal node ${goalNodeId} has no world_extension request`,
          {
            operation_kind: context.operationKind,
            goal_plan_id: goalPlanId,
            goal_node_id: goalNodeId,
          },
        );
      }
      assertEqual(
        "world_extension.request_id",
        requestId,
        expectString(extension, "request_id", "WorldExtensionRequest"),
        context.operationKind,
      );
      assertEqual(
        "world_extension.goal_node_id",
        goalNodeId,
        expectString(extension, "goal_node_id", "WorldExtensionRequest"),
        context.operationKind,
      );
      const requirement = expectJsonObject(
        expectProperty(
          worldNode,
          "capability_requirement",
          "GoalNode",
        ),
        "GoalNode.capability_requirement",
      );
      const demand = expectJsonObject(
        expectProperty(
          requirement,
          "demand",
          "CapabilityRequirement",
        ),
        "CapabilityRequirement.demand",
      );
      assertEqual(
        "world_extension.demand_id",
        expectString(demand, "demand_id", "CapabilityDemand"),
        expectString(extension, "demand_id", "WorldExtensionRequest"),
        context.operationKind,
      );
      const selectedArchetype = expectJsonObject(
        expectProperty(
          extension,
          "selected_archetype",
          "WorldExtensionRequest",
        ),
        "WorldExtensionRequest.selected_archetype",
      );
      const allowedArchetypes = asObjectArray(
        expectProperty(
          demand,
          "allowed_archetypes",
          "CapabilityDemand",
        ),
        "CapabilityDemand.allowed_archetypes",
      );
      if (
        allowedArchetypes.filter((candidate) =>
          jsonEquals(candidate, selectedArchetype),
        ).length !== 1
      ) {
        throw fault(
          "rule_plugin.semantic.world_extension_archetype_not_allowed",
          "Committed WorldExtensionRequest selected archetype is no longer allowed by its demand",
          {
            operation_kind: context.operationKind,
            request_id: requestId,
          },
        );
      }

      const ops = asObjectArray(
        expectProperty(proposal, "ops", "PacketProposal"),
        "PacketProposal.ops",
      );
      const upserts = ops.filter(
        (op) => expectString(op, "op", "EffectOp") === "goal_plan.upsert",
      );
      if (upserts.length !== 1) {
        throw fault(
          "rule_plugin.semantic.world_extension_upsert_count",
          "world_extension.resolve packet must contain exactly one goal_plan.upsert",
          {
            operation_kind: context.operationKind,
            upsert_count: upserts.length,
          },
        );
      }
      const upserted = expectJsonObject(
        expectProperty(upserts[0] as JsonObject, "goal_plan", "GoalPlanUpsertOp"),
        "GoalPlanUpsertOp.goal_plan",
      );
      assertEqual(
        "world_extension.upsert.plan_id",
        goalPlanId,
        expectString(upserted, "plan_id", "GoalPlan"),
        context.operationKind,
      );
      const currentPlanRevision = expectInteger(
        worldPlan,
        "revision",
        "GoalPlan",
      );
      assertEqual(
        "world_extension.upsert.expected_revision",
        currentPlanRevision,
        expectInteger(
          upserts[0] as JsonObject,
          "expected_revision",
          "GoalPlanUpsertOp",
        ),
        context.operationKind,
      );
      assertEqual(
        "world_extension.upsert.revision",
        currentPlanRevision + 1,
        expectInteger(upserted, "revision", "GoalPlan"),
        context.operationKind,
      );
      const resolvedNode = findGoalNode(upserted, goalNodeId);
      if (resolvedNode === undefined) {
        throw fault(
          "rule_plugin.semantic.world_extension_resolved_node_missing",
          "world_extension.resolve must preserve the target GoalNode",
          {
            operation_kind: context.operationKind,
            goal_plan_id: goalPlanId,
            goal_node_id: goalNodeId,
          },
        );
      }
      const resolvedRequirement = expectJsonObject(
        expectProperty(
          resolvedNode,
          "capability_requirement",
          "GoalNode",
        ),
        "GoalNode.capability_requirement",
      );
      if (
        resolvedNode.world_extension !== undefined ||
        expectString(
          resolvedRequirement,
          "requirement_kind",
          "CapabilityRequirement",
        ) !== "bound"
      ) {
        throw fault(
          "rule_plugin.semantic.world_extension_not_consumed",
          "world_extension.resolve must consume the target request and bind its GoalNode capability",
          {
            operation_kind: context.operationKind,
            request_id: requestId,
            goal_node_id: goalNodeId,
          },
        );
      }
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertContentUpgradeRequest(input: {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly authorizations: ContentUpgradeAuthorizationAuthority;
  readonly currentTime: string;
  readonly request: JsonObject;
  readonly input: JsonObject;
  readonly readonlyWorld: JsonObject;
}): void {
  const migrationId = expectString(
    input.input,
    "migration_id",
    "ContentUpgradeInput",
  );
  const sourceBundle = expectJsonObject(
    expectProperty(input.input, "source_bundle", "ContentUpgradeInput"),
    "ContentUpgradeInput.source_bundle",
  );
  const targetBundle = expectJsonObject(
    expectProperty(input.input, "target_bundle", "ContentUpgradeInput"),
    "ContentUpgradeInput.target_bundle",
  );
  const sourceSaveCandidate = expectProperty(
    input.input,
    "source_save",
    "ContentUpgradeInput",
  );
  const sourceSave = input.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    sourceSaveCandidate,
  );
  assertSaveEnvelopeRelationships(input.contracts, sourceSave);
  const authorization = input.authorizations.assertAuthentic(
    expectProperty(
      input.input,
      "authorization",
      "ContentUpgradeInput",
    ),
    input.currentTime,
  ).value;
  const sourceSaveValue = sourceSave.value;
  const sourceWorldId = expectString(
    sourceSaveValue,
    "world_id",
    "SaveEnvelope",
  );
  const sourceWorldRevision = expectInteger(
    sourceSaveValue,
    "world_revision",
    "SaveEnvelope",
  );
  const requestBasisRevision = expectInteger(
    input.request,
    "basis_revision",
    "RulePluginRequest",
  );

  assertEqual(
    "content_upgrade.request.world_id",
    expectString(input.readonlyWorld, "world_id", "WorldSnapshot"),
    sourceWorldId,
    "content_upgrade.transform",
  );
  assertEqual(
    "content_upgrade.request.world_revision",
    expectInteger(input.readonlyWorld, "world_revision", "WorldSnapshot"),
    sourceWorldRevision,
    "content_upgrade.transform",
  );
  assertEqual(
    "content_upgrade.request.basis_revision",
    requestBasisRevision,
    sourceWorldRevision,
    "content_upgrade.transform",
  );
  if (
    !jsonEquals(
      expectProperty(input.readonlyWorld, "world_state", "WorldSnapshot"),
      expectProperty(sourceSaveValue, "world_state", "SaveEnvelope"),
    )
  ) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_source_snapshot_mismatch",
      "ContentUpgradeInput.source_save must contain the exact RulePlugin readonly_world snapshot",
      { operation_kind: "content_upgrade.transform", world_id: sourceWorldId },
    );
  }

  const sourceContentLock = expectJsonObject(
    expectProperty(
      sourceSaveValue,
      "world_content_lock",
      "SaveEnvelope",
    ),
    "SaveEnvelope.world_content_lock",
  );
  const sourceRootBundle = expectJsonObject(
    expectProperty(
      sourceContentLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  if (!jsonEquals(sourceRootBundle, sourceBundle)) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_source_lock_mismatch",
      "ContentUpgradeInput.source_bundle must equal source_save WorldContentLock root bundle",
      { operation_kind: "content_upgrade.transform", world_id: sourceWorldId },
    );
  }
  assertEqual(
    "content_upgrade.request.pack_id",
    expectString(sourceBundle, "pack_id", "PackLock"),
    expectString(targetBundle, "pack_id", "PackLock"),
    "content_upgrade.transform",
  );
  if (
    expectString(sourceBundle, "bundle_digest", "PackLock") ===
    expectString(targetBundle, "bundle_digest", "PackLock")
  ) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_digest_unchanged",
      "Content Upgrade source and target bundle digests must differ",
      { operation_kind: "content_upgrade.transform", migration_id: migrationId },
    );
  }

  const expectedSourceSaveDigest = input.digest.sha256(sourceSaveValue);
  for (const pair of [
    [
      "content_upgrade.authorization.world_id",
      sourceWorldId,
      expectString(authorization, "world_id", "UpgradeAuthorization"),
    ],
    [
      "content_upgrade.authorization.migration_id",
      migrationId,
      expectString(authorization, "migration_id", "UpgradeAuthorization"),
    ],
    [
      "content_upgrade.authorization.source_save_digest",
      expectedSourceSaveDigest,
      expectString(
        authorization,
        "source_save_digest",
        "UpgradeAuthorization",
      ),
    ],
    [
      "content_upgrade.authorization.source_bundle_digest",
      expectString(sourceBundle, "bundle_digest", "PackLock"),
      expectString(
        authorization,
        "source_bundle_digest",
        "UpgradeAuthorization",
      ),
    ],
    [
      "content_upgrade.authorization.target_bundle_digest",
      expectString(targetBundle, "bundle_digest", "PackLock"),
      expectString(
        authorization,
        "target_bundle_digest",
        "UpgradeAuthorization",
      ),
    ],
  ] as const) {
    assertEqual(pair[0], pair[1], pair[2], "content_upgrade.transform");
  }
  assertEqual(
    "content_upgrade.authorization.source_world_revision",
    sourceWorldRevision,
    expectInteger(
      authorization,
      "source_world_revision",
      "UpgradeAuthorization",
    ),
    "content_upgrade.transform",
  );
}

function handleContentUpgradeTransform(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "content_upgrade.candidate": {
      const sourceBundle = expectJsonObject(
        expectProperty(context.input, "source_bundle", "ContentUpgradeInput"),
        "ContentUpgradeInput.source_bundle",
      );
      const targetBundle = expectJsonObject(
        expectProperty(context.input, "target_bundle", "ContentUpgradeInput"),
        "ContentUpgradeInput.target_bundle",
      );
      const authorization = expectJsonObject(
        expectProperty(context.input, "authorization", "ContentUpgradeInput"),
        "ContentUpgradeInput.authorization",
      );
      const migrationId = expectString(
        context.input,
        "migration_id",
        "ContentUpgradeInput",
      );
      const sourceSave = context.contracts.assertObject(
        CONTRACT_REF.saveEnvelope,
        expectProperty(context.input, "source_save", "ContentUpgradeInput"),
      );
      const candidateSave = context.contracts.assertObject(
        CONTRACT_REF.saveEnvelope,
        expectProperty(
          context.output,
          "candidate_save",
          "ContentUpgradeOutput",
        ),
      );
      assertSaveEnvelopeRelationships(context.contracts, candidateSave);

      assertEqual(
        "content_upgrade.source_bundle_digest",
        expectString(sourceBundle, "bundle_digest", "PackLock"),
        expectString(context.output, "source_bundle_digest", "ContentUpgradeOutput"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.migration_id",
        migrationId,
        expectString(context.output, "migration_id", "ContentUpgradeOutput"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.authorization.migration_id",
        migrationId,
        expectString(authorization, "migration_id", "UpgradeAuthorization"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.target_bundle_digest",
        expectString(targetBundle, "bundle_digest", "PackLock"),
        expectString(context.output, "target_bundle_digest", "ContentUpgradeOutput"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.authorization.source_bundle_digest",
        expectString(sourceBundle, "bundle_digest", "PackLock"),
        expectString(authorization, "source_bundle_digest", "UpgradeAuthorization"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.authorization.target_bundle_digest",
        expectString(targetBundle, "bundle_digest", "PackLock"),
        expectString(authorization, "target_bundle_digest", "UpgradeAuthorization"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.upgrade_command_id",
        expectString(authorization, "upgrade_command_id", "UpgradeAuthorization"),
        expectString(context.output, "upgrade_command_id", "ContentUpgradeOutput"),
        context.operationKind,
      );
      assertEqual(
        "content_upgrade.authorization_digest",
        expectString(authorization, "authorization_digest", "UpgradeAuthorization"),
        expectString(context.output, "authorization_digest", "ContentUpgradeOutput"),
        context.operationKind,
      );
      assertContentUpgradeCandidateRelationships(
        context,
        sourceSave.value,
        candidateSave.value,
        authorization,
        migrationId,
        sourceBundle,
        targetBundle,
      );
      context.stageContracts.assertSaveOpenStagesAllowed(candidateSave);
      assertEqual(
        "content_upgrade.result_digest",
        context.digest.sha256(omitField(context.output, "result_digest")),
        expectString(context.output, "result_digest", "ContentUpgradeOutput"),
        context.operationKind,
      );
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertContentUpgradeCandidateRelationships(
  context: OperationContext,
  sourceSave: JsonObject,
  candidateSave: JsonObject,
  authorization: JsonObject,
  migrationId: string,
  sourceBundle: JsonObject,
  targetBundle: JsonObject,
): void {
  const sourceWorldId = expectString(
    sourceSave,
    "world_id",
    "SaveEnvelope",
  );
  const sourceRevision = expectInteger(
    sourceSave,
    "world_revision",
    "SaveEnvelope",
  );
  if (sourceRevision >= Number.MAX_SAFE_INTEGER) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_revision_exhausted",
      "Content Upgrade cannot advance a world beyond the safe revision range",
      { world_id: sourceWorldId, world_revision: sourceRevision },
    );
  }
  const candidateRevision = sourceRevision + 1;
  for (const pair of [
    [
      "content_upgrade.candidate.world_id",
      sourceWorldId,
      expectString(candidateSave, "world_id", "SaveEnvelope"),
    ],
    [
      "content_upgrade.candidate.save_schema_version",
      expectString(sourceSave, "save_schema_version", "SaveEnvelope"),
      expectString(candidateSave, "save_schema_version", "SaveEnvelope"),
    ],
    [
      "content_upgrade.candidate.engine_contract_version",
      expectString(sourceSave, "engine_contract_version", "SaveEnvelope"),
      expectString(candidateSave, "engine_contract_version", "SaveEnvelope"),
    ],
  ] as const) {
    assertEqual(pair[0], pair[1], pair[2], context.operationKind);
  }
  assertEqual(
    "content_upgrade.candidate.world_revision",
    candidateRevision,
    expectInteger(candidateSave, "world_revision", "SaveEnvelope"),
    context.operationKind,
  );
  assertEqual(
    "content_upgrade.candidate.event_cursor",
    candidateRevision,
    expectInteger(candidateSave, "event_cursor", "SaveEnvelope"),
    context.operationKind,
  );

  const sourceContentLock = expectJsonObject(
    expectProperty(sourceSave, "world_content_lock", "SaveEnvelope"),
    "SaveEnvelope.world_content_lock",
  );
  const candidateContentLock = expectJsonObject(
    expectProperty(candidateSave, "world_content_lock", "SaveEnvelope"),
    "SaveEnvelope.world_content_lock",
  );
  const candidateRootBundle = expectJsonObject(
    expectProperty(
      candidateContentLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  if (!jsonEquals(candidateRootBundle, targetBundle)) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_target_lock_mismatch",
      "ContentUpgradeOutput candidate_save must use the exact requested target PackLock",
      { operation_kind: context.operationKind, migration_id: migrationId },
    );
  }
  assertEqual(
    "content_upgrade.candidate.world_definition_id",
    expectString(
      sourceContentLock,
      "world_definition_id",
      "WorldContentLock",
    ),
    expectString(
      candidateContentLock,
      "world_definition_id",
      "WorldContentLock",
    ),
    context.operationKind,
  );

  const sourceHistory = asObjectArray(
    expectProperty(sourceSave, "migration_history", "SaveEnvelope"),
    "SaveEnvelope.migration_history",
  );
  const candidateHistory = asObjectArray(
    expectProperty(candidateSave, "migration_history", "SaveEnvelope"),
    "SaveEnvelope.migration_history",
  );
  if (
    candidateHistory.length !== sourceHistory.length + 1 ||
    !sourceHistory.every((entry, index) =>
      jsonEquals(entry, candidateHistory[index] as JsonObject),
    )
  ) {
    throw fault(
      "rule_plugin.semantic.content_upgrade_history_not_append_only",
      "Content Upgrade candidate must append exactly one migration history entry",
      {
        operation_kind: context.operationKind,
        source_history_length: sourceHistory.length,
        candidate_history_length: candidateHistory.length,
      },
    );
  }
  const historyEntry = candidateHistory.at(-1) as JsonObject;
  const pluginLock = expectJsonObject(
    expectProperty(context.request.value, "plugin_lock", "RulePluginRequest"),
    "RulePluginRequest.plugin_lock",
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      context.request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  for (const pair of [
    [
      "content_upgrade.history.migration_kind",
      "content_upgrade",
      expectString(historyEntry, "migration_kind", "MigrationHistoryEntry"),
    ],
    [
      "content_upgrade.history.source",
      expectString(sourceBundle, "bundle_digest", "PackLock"),
      expectString(historyEntry, "source", "MigrationHistoryEntry"),
    ],
    [
      "content_upgrade.history.target",
      expectString(targetBundle, "bundle_digest", "PackLock"),
      expectString(historyEntry, "target", "MigrationHistoryEntry"),
    ],
    [
      "content_upgrade.history.implementation_digest",
      expectString(pluginLock, "implementation_digest", "PluginLock"),
      expectString(
        historyEntry,
        "implementation_digest",
        "MigrationHistoryEntry",
      ),
    ],
    [
      "content_upgrade.history.executed_at",
      expectString(authorization, "issued_at", "UpgradeAuthorization"),
      expectString(historyEntry, "executed_at", "MigrationHistoryEntry"),
    ],
    [
      "content_upgrade.history.upgrade_command_id",
      expectString(
        authorization,
        "upgrade_command_id",
        "UpgradeAuthorization",
      ),
      expectString(
        historyEntry,
        "upgrade_command_id",
        "MigrationHistoryEntry",
      ),
    ],
    [
      "content_upgrade.history.migration_id",
      migrationId,
      expectString(historyEntry, "migration_id", "MigrationHistoryEntry"),
    ],
    [
      "content_upgrade.history.source_save_digest",
      expectString(
        authorization,
        "source_save_digest",
        "UpgradeAuthorization",
      ),
      expectString(
        historyEntry,
        "source_save_digest",
        "MigrationHistoryEntry",
      ),
    ],
    [
      "content_upgrade.history.authorization_digest",
      expectString(
        authorization,
        "authorization_digest",
        "UpgradeAuthorization",
      ),
      expectString(
        historyEntry,
        "authorization_digest",
        "MigrationHistoryEntry",
      ),
    ],
    [
      "content_upgrade.history.deterministic_context_digest",
      expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      ),
      expectString(
        historyEntry,
        "deterministic_context_digest",
        "MigrationHistoryEntry",
      ),
    ],
  ] as const) {
    assertEqual(pair[0], pair[1], pair[2], context.operationKind);
  }
  assertEqual(
    "content_upgrade.history.result_digest",
    context.digest.sha256(
      contentUpgradeCandidateDigestBody(candidateSave, candidateHistory),
    ),
    expectString(historyEntry, "result_digest", "MigrationHistoryEntry"),
    context.operationKind,
  );
}

function contentUpgradeCandidateDigestBody(
  candidateSave: JsonObject,
  history: readonly JsonObject[],
): JsonObject {
  return Object.freeze({
    ...candidateSave,
    migration_history: history.map((entry, index) =>
      index === history.length - 1
        ? omitField(entry, "result_digest")
        : entry,
    ),
  });
}

function handleDayCycleAdvance(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const ops = asObjectArray(
        expectProperty(proposal, "ops", "PacketProposal"),
        "PacketProposal.ops",
      );
      const transitions = ops.filter(
        (op) => expectString(op, "op", "EffectOp") === "day_cycle.transition",
      );
      if (transitions.length !== 1) {
        throw fault(
          "rule_plugin.semantic.day_cycle_transition_count",
          "day_cycle.advance packet must contain exactly one day_cycle.transition",
          {
            operation_kind: context.operationKind,
            transition_count: transitions.length,
          },
        );
      }
      const transition = transitions[0] as JsonObject;
      const fromDay = expectInteger(context.input, "from_day", "DayCycleAdvanceInput");
      const fromPhase = expectString(context.input, "from_phase", "DayCycleAdvanceInput");
      const toDay = expectInteger(context.input, "to_day", "DayCycleAdvanceInput");
      const toPhase = expectString(context.input, "to_phase", "DayCycleAdvanceInput");
      assertAllowedDayCycleTransition(
        context.operationKind,
        fromDay,
        fromPhase,
        toDay,
        toPhase,
      );

      assertEqual(
        "day_cycle.from_day",
        fromDay,
        expectInteger(transition, "from_day", "DayCycleTransitionOp"),
        context.operationKind,
      );
      assertEqual(
        "day_cycle.from_phase",
        fromPhase,
        expectString(transition, "from_phase", "DayCycleTransitionOp"),
        context.operationKind,
      );
      assertEqual(
        "day_cycle.to_day",
        toDay,
        expectInteger(transition, "to_day", "DayCycleTransitionOp"),
        context.operationKind,
      );
      assertEqual(
        "day_cycle.to_phase",
        toPhase,
        expectString(transition, "to_phase", "DayCycleTransitionOp"),
        context.operationKind,
      );

      const dayCycle = expectJsonObject(
        expectProperty(context.world, "day_cycle", "WorldState"),
        "WorldState.day_cycle",
      );
      assertEqual(
        "day_cycle.world.from_day",
        expectInteger(dayCycle, "day", "DayCycleState"),
        fromDay,
        context.operationKind,
      );
      assertEqual(
        "day_cycle.world.from_phase",
        expectString(dayCycle, "phase", "DayCycleState"),
        fromPhase,
        context.operationKind,
      );

      const control = expectJsonObject(
        expectProperty(context.input, "control", "DayCycleAdvanceInput"),
        "DayCycleAdvanceInput.control",
      );
      assertActiveHumanControl(context, control);
      const expireOps = ops.filter(
        (op) => expectString(op, "op", "EffectOp") === "event_card.expire",
      );
      const openOps = ops.filter(
        (op) => expectString(op, "op", "EffectOp") === "event_budget.open",
      );

      if (fromPhase === "player") {
        assertExhaustiveCardExpiry(context, expireOps, fromDay, control);
      } else if (expireOps.length > 0) {
        throw fault(
          "rule_plugin.semantic.day_cycle_expire_forbidden",
          "event_card.expire is only valid when leaving player phase",
          {
            operation_kind: context.operationKind,
            from_phase: fromPhase,
            expire_count: expireOps.length,
          },
        );
      }

      if (toPhase === "player") {
        if (openOps.length !== 1) {
          throw fault(
            "rule_plugin.semantic.day_cycle_budget_open_count",
            "Entering player phase requires exactly one event_budget.open",
            {
              operation_kind: context.operationKind,
              open_count: openOps.length,
            },
          );
        }
        const openOp = openOps[0] as JsonObject;
        const policy = expectJsonObject(
          expectProperty(
            context.input,
            "event_budget_policy",
            "DayCycleAdvanceInput",
          ),
          "DayCycleAdvanceInput.event_budget_policy",
        );
        assertEqual(
          "event_budget.open.day",
          toDay,
          expectInteger(openOp, "day", "EventBudgetOpenOp"),
          context.operationKind,
        );
        assertEqual(
          "event_budget.open.capacity",
          expectInteger(policy, "daily_capacity", "EventBudgetPolicy"),
          expectInteger(openOp, "capacity", "EventBudgetOpenOp"),
          context.operationKind,
        );
        assertJsonFieldEqual(
          "event_budget.open.control",
          control,
          expectProperty(openOp, "control", "EventBudgetOpenOp"),
          context.operationKind,
        );
      } else if (openOps.length > 0) {
        throw fault(
          "rule_plugin.semantic.day_cycle_budget_open_forbidden",
          "event_budget.open is only valid when entering player phase",
          {
            operation_kind: context.operationKind,
            to_phase: toPhase,
            open_count: openOps.length,
          },
        );
      }
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertAllowedDayCycleTransition(
  operationKind: OperationKind,
  fromDay: number,
  fromPhase: string,
  toDay: number,
  toPhase: string,
): void {
  const sameDay =
    toDay === fromDay &&
    ((fromPhase === "autonomous" && toPhase === "director_settlement") ||
      (fromPhase === "director_settlement" && toPhase === "player"));
  const nextDay =
    fromPhase === "player" &&
    toPhase === "autonomous" &&
    fromDay < Number.MAX_SAFE_INTEGER &&
    toDay === fromDay + 1;
  if (sameDay || nextDay) {
    return;
  }
  throw fault(
    "rule_plugin.semantic.day_cycle_transition_invalid",
    "day_cycle.advance must follow autonomous → director_settlement → player → next-day autonomous",
    {
      operation_kind: operationKind,
      from_day: fromDay,
      from_phase: fromPhase,
      to_day: toDay,
      to_phase: toPhase,
    },
  );
}

function assertActiveHumanControl(
  context: OperationContext,
  control: JsonObject,
): void {
  const bindingId = expectString(control, "binding_id", "ControlBindingRef");
  const binding = findControlBinding(context.world, bindingId);
  if (
    binding === undefined ||
    expectString(binding, "binding_kind", "ControlBinding") !== "human" ||
    expectString(binding, "status", "ControlBinding") !== "active"
  ) {
    throw fault(
      "rule_plugin.semantic.day_cycle_control_invalid",
      "day_cycle.advance requires an active human ControlBinding",
      {
        operation_kind: context.operationKind,
        binding_id: bindingId,
      },
    );
  }
}

function assertExhaustiveCardExpiry(
  context: OperationContext,
  expireOps: readonly JsonObject[],
  fromDay: number,
  control: JsonObject,
): void {
  const cards = asObjectArray(
    expectProperty(context.world, "event_cards", "WorldState"),
    "WorldState.event_cards",
  );
  const requiredIds = new Set<string>();
  for (const card of cards) {
    const status = expectString(card, "status", "EventCardState");
    const day = expectInteger(card, "day", "EventCardState");
    if (status !== "available" || day !== fromDay) {
      continue;
    }
    const cardControl = expectJsonObject(
      expectProperty(card, "control", "EventCardState"),
      "EventCardState.control",
    );
    if (!jsonEquals(cardControl, control)) {
      continue;
    }
    requiredIds.add(expectString(card, "event_card_id", "EventCardState"));
  }

  const expiredIds = new Set<string>();
  for (const op of expireOps) {
    const eventCardId = expectString(op, "event_card_id", "EventCardExpireOp");
    assertEqual(
      "event_card.expire.expected_card_day",
      fromDay,
      expectInteger(op, "expected_card_day", "EventCardExpireOp"),
      context.operationKind,
    );
    assertJsonFieldEqual(
      "event_card.expire.control",
      control,
      expectProperty(op, "control", "EventCardExpireOp"),
      context.operationKind,
    );
    if (expiredIds.has(eventCardId)) {
      throw fault(
        "rule_plugin.semantic.day_cycle_expire_duplicate",
        `Duplicate event_card.expire for ${eventCardId}`,
        { operation_kind: context.operationKind, event_card_id: eventCardId },
      );
    }
    expiredIds.add(eventCardId);
  }

  if (requiredIds.size !== expiredIds.size) {
    throw fault(
      "rule_plugin.semantic.day_cycle_expire_incomplete",
      "Leaving player phase must expire every available card for the day and control",
      {
        operation_kind: context.operationKind,
        required_count: requiredIds.size,
        expired_count: expiredIds.size,
      },
    );
  }
  for (const id of requiredIds) {
    if (!expiredIds.has(id)) {
      throw fault(
        "rule_plugin.semantic.day_cycle_expire_missing",
        `Missing event_card.expire for available card ${id}`,
        { operation_kind: context.operationKind, event_card_id: id },
      );
    }
  }
  for (const id of expiredIds) {
    if (!requiredIds.has(id)) {
      throw fault(
        "rule_plugin.semantic.day_cycle_expire_unknown",
        `event_card.expire targets non-required card ${id}`,
        { operation_kind: context.operationKind, event_card_id: id },
      );
    }
  }
}

function handleStateMachineAdvance(context: OperationContext): void {
  const resolved = assertStateMachineAdvanceInput({
    input: context.input,
    world: context.world,
    worldId: context.worldId,
    worldContentLock: context.worldContentLock,
    authority: context.stateMachineContracts,
  });
  switch (context.outputKind) {
    case "reject":
    case "state_machine.unchanged":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(
        proposal,
        "state_machine.transition",
        context.operationKind,
      );
      const machineInstanceId = expectString(
        context.input,
        "machine_instance_id",
        "StateMachineAdvanceInput",
      );
      assertEqual(
        "state_machine.machine_instance_id",
        machineInstanceId,
        expectString(
          op,
          "machine_instance_id",
          "StateMachineTransitionOp",
        ),
        context.operationKind,
      );
      const transitionId = expectString(
        op,
        "transition_id",
        "StateMachineTransitionOp",
      );
      const transition = resolved.machine.resolveTransition(
        resolved.instance,
        transitionId,
      ).transition;
      assertStateMachineGuardEvidence(proposal, transition, context);
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleWorldAutomaticEventResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "choice.required":
      assertChoiceSpec(context);
      return;
    case "packet.proposal":
      assertPacketProposalProvenance(context);
      assertModelProofRevisionCompatible(context, context.input, "model_proof");
      return;
    default:
      throw unexpectedOutput(context);
  }
}

function handleCharacterAutomaticEventResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "choice.required":
      assertChoiceSpec(context);
      return;
    case "packet.proposal": {
      const packetProposal = assertPacketProposalProvenance(context);
      assertModelProofRevisionCompatible(context, context.input, "director_proof");
      const eventCandidate = expectJsonObject(
        expectProperty(
          context.input,
          "candidate",
          "CharacterAutomaticEventResolveInput",
        ),
        "CharacterAutomaticEventResolveInput.candidate",
      );
      const proposalId = expectString(
        eventCandidate,
        "proposal_id",
        "MaterializedCharacterAutomaticEventCandidate",
      );
      const targetIds = new Set(
        asStringArray(
          expectProperty(
            eventCandidate,
            "target_entity_ids",
            "MaterializedCharacterAutomaticEventCandidate",
          ),
          "MaterializedCharacterAutomaticEventCandidate.target_entity_ids",
        ),
      );
      const batches = asObjectArray(
        expectProperty(
          context.input,
          "character_reactions",
          "CharacterAutomaticEventResolveInput",
        ),
        "CharacterAutomaticEventResolveInput.character_reactions",
      );
      const seenCharacters = new Set<string>();
      for (const batch of batches) {
        const character = expectJsonObject(
          expectProperty(batch, "character", "CharacterReactionBatch"),
          "CharacterReactionBatch.character",
        );
        const entityId = expectString(character, "entity_id", "EntityRef");
        if (!targetIds.has(entityId)) {
          throw fault(
            "rule_plugin.semantic.character_reaction_target",
            `Character reaction batch entity ${entityId} is not a target of the automatic event`,
            {
              operation_kind: context.operationKind,
              entity_id: entityId,
              proposal_id: proposalId,
            },
          );
        }
        if (seenCharacters.has(entityId)) {
          throw fault(
            "rule_plugin.semantic.character_reaction_duplicate",
            `Duplicate character reaction batch for entity ${entityId}`,
            { operation_kind: context.operationKind, entity_id: entityId },
          );
        }
        seenCharacters.add(entityId);
        assertModelProofRevisionCompatible(context, batch, "model_proof");

        const reactions = asObjectArray(
          expectProperty(batch, "candidates", "CharacterReactionBatch"),
          "CharacterReactionBatch.candidates",
        );
        for (const ordinalCandidate of reactions) {
          const reaction = expectJsonObject(
            expectProperty(
              ordinalCandidate,
              "candidate",
              "OrdinalCharacterReactionCandidate",
            ),
            "OrdinalCharacterReactionCandidate.candidate",
          );
          const sourceEvent = expectJsonObject(
            expectProperty(
              reaction,
              "source_event",
              "MaterializedCharacterReactionCandidate",
            ),
            "MaterializedCharacterReactionCandidate.source_event",
          );
          assertEqual(
            "character_reaction.source_event.proposal_id",
            proposalId,
            expectString(sourceEvent, "proposal_id", "CharacterEventRef"),
            context.operationKind,
          );
        }
      }
      if (
        seenCharacters.size !== targetIds.size ||
        [...targetIds].some((entityId) => !seenCharacters.has(entityId))
      ) {
        throw fault(
          "rule_plugin.semantic.character_reaction_targets_incomplete",
          "Character reaction batches must exactly cover every automatic event target",
          {
            operation_kind: context.operationKind,
            proposal_id: proposalId,
            target_entity_ids: [...targetIds],
            reaction_entity_ids: [...seenCharacters],
          },
        );
      }
      assertCharacterMachineDecisions(
        context,
        packetProposal,
        batches,
        proposalId,
      );
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertCharacterMachineDecisions(
  context: OperationContext,
  packetProposal: JsonObject,
  batches: readonly JsonObject[],
  eventProposalId: string,
): void {
  const transitionOps = asObjectArray(
    expectProperty(packetProposal, "ops", "PacketProposal"),
    "PacketProposal.ops",
  ).filter(
    (op) => expectString(op, "op", "EffectOp") === "state_machine.transition",
  );
  const coveredMachineIds = new Set<string>();

  for (const [batchIndex, batch] of batches.entries()) {
    const character = expectJsonObject(
      expectProperty(batch, "character", "CharacterReactionBatch"),
      "CharacterReactionBatch.character",
    );
    const entityId = expectString(character, "entity_id", "EntityRef");
    const reactions = asObjectArray(
      expectProperty(batch, "candidates", "CharacterReactionBatch"),
      "CharacterReactionBatch.candidates",
    ).filter((ordinalCandidate) => {
      const reaction = expectJsonObject(
        expectProperty(
          ordinalCandidate,
          "candidate",
          "OrdinalCharacterReactionCandidate",
        ),
        "OrdinalCharacterReactionCandidate.candidate",
      );
      const source = expectJsonObject(
        expectProperty(
          reaction,
          "source_event",
          "MaterializedCharacterReactionCandidate",
        ),
        "MaterializedCharacterReactionCandidate.source_event",
      );
      return (
        expectString(source, "proposal_id", "CharacterEventRef") ===
        eventProposalId
      );
    });
    if (reactions.length !== 1) {
      throw fault(
        "rule_plugin.semantic.character_machine_decision_ambiguous",
        "Each CharacterReactionBatch must contain exactly one reaction for the current automatic event",
        {
          operation_kind: context.operationKind,
          proposal_id: eventProposalId,
          entity_id: entityId,
          batch_index: batchIndex,
          matching_reactions: reactions.length,
        },
      );
    }
    const ownedMachines = asObjectArray(
      expectProperty(context.world, "state_machines", "WorldState"),
      "WorldState.state_machines",
    ).filter((instance) => {
      const owner = expectJsonObject(
        expectProperty(instance, "owner", "StateMachineInstanceState"),
        "StateMachineInstanceState.owner",
      );
      return (
        expectString(owner, "owner_kind", "StateMachineOwner") ===
          "character" &&
        expectString(owner, "entity_id", "StateMachineOwner") === entityId
      );
    });
    if (ownedMachines.length !== 1) {
      throw fault(
        "rule_plugin.semantic.character_machine_owner_invalid",
        "Character machine decision requires exactly one current character state machine",
        {
          operation_kind: context.operationKind,
          entity_id: entityId,
          machines: ownedMachines.length,
        },
      );
    }
    const instance = ownedMachines[0] as JsonObject;
    const instanceId = expectString(
      instance,
      "instance_id",
      "StateMachineInstanceState",
    );
    coveredMachineIds.add(instanceId);
    const matchingOps = transitionOps.filter(
      (op) =>
        expectString(
          op,
          "machine_instance_id",
          "StateMachineTransitionOp",
        ) === instanceId,
    );
    const decision = expectJsonObject(
      expectProperty(
        expectJsonObject(
          expectProperty(
            reactions[0] as JsonObject,
            "candidate",
            "OrdinalCharacterReactionCandidate",
          ),
          "OrdinalCharacterReactionCandidate.candidate",
        ),
        "machine_decision",
        "MaterializedCharacterReactionCandidate",
      ),
      "MaterializedCharacterReactionCandidate.machine_decision",
    );
    const decisionKind = expectString(
      decision,
      "decision_kind",
      "MachineDecision",
    );
    if (decisionKind === "keep") {
      if (matchingOps.length !== 0) {
        throw fault(
          "rule_plugin.semantic.character_machine_keep_violated",
          "Character keep decision forbids a state-machine transition for that character",
          {
            operation_kind: context.operationKind,
            entity_id: entityId,
            machine_instance_id: instanceId,
            transitions: matchingOps.length,
          },
        );
      }
      continue;
    }
    if (decisionKind !== "transition" || matchingOps.length !== 1) {
      throw fault(
        "rule_plugin.semantic.character_machine_transition_missing",
        "Character transition decision requires exactly one matching state-machine transition",
        {
          operation_kind: context.operationKind,
          entity_id: entityId,
          machine_instance_id: instanceId,
          decision_kind: decisionKind,
          transitions: matchingOps.length,
        },
      );
    }
    const selectedTransitionId = expectString(
      decision,
      "transition_id",
      "MachineDecision",
    );
    assertEqual(
      "character_machine.transition_id",
      selectedTransitionId,
      expectString(
        matchingOps[0] as JsonObject,
        "transition_id",
        "StateMachineTransitionOp",
      ),
      context.operationKind,
    );
    const machine = context.stateMachineContracts.assertLockedInstance({
      worldContentLock: context.worldContentLock,
      worldId: context.worldId,
      instance,
    });
    const selectedTransition = machine.resolveTransition(
      instance,
      selectedTransitionId,
    ).transition;
    assertStateMachineGuardEvidence(
      packetProposal,
      selectedTransition,
      context,
    );
  }

  const extra = transitionOps.filter(
    (op) =>
      !coveredMachineIds.has(
        expectString(
          op,
          "machine_instance_id",
          "StateMachineTransitionOp",
        ),
      ),
  );
  const worldMachineShadow = new Map(
    asObjectArray(
      expectProperty(context.world, "state_machines", "WorldState"),
      "WorldState.state_machines",
    ).map((instance) => [
      expectString(
        instance,
        "instance_id",
        "StateMachineInstanceState",
      ),
      instance,
    ]),
  );
  for (const op of extra) {
    const instanceId = expectString(
      op,
      "machine_instance_id",
      "StateMachineTransitionOp",
    );
    const instance = worldMachineShadow.get(instanceId);
    if (instance === undefined) {
      throw fault(
        "rule_plugin.semantic.character_machine_transition_instance_missing",
        "Character automatic-event packet references an absent state-machine instance",
        {
          operation_kind: context.operationKind,
          proposal_id: eventProposalId,
          machine_instance_id: instanceId,
        },
      );
    }
    const owner = expectJsonObject(
      expectProperty(instance, "owner", "StateMachineInstanceState"),
      "StateMachineInstanceState.owner",
    );
    const ownerKind = expectString(owner, "owner_kind", "StateMachineOwner");
    if (ownerKind !== "world") {
      throw fault(
        "rule_plugin.semantic.character_machine_transition_extra",
        "Character automatic-event packet cannot transition a non-target character machine",
        {
          operation_kind: context.operationKind,
          proposal_id: eventProposalId,
          machine_instance_id: instanceId,
          owner_kind: ownerKind,
        },
      );
    }
    assertEqual(
      "world_machine.owner.world_id",
      context.worldId,
      expectString(owner, "world_id", "StateMachineOwner"),
      context.operationKind,
    );
    const machine = context.stateMachineContracts.assertLockedInstance({
      worldContentLock: context.worldContentLock,
      worldId: context.worldId,
      instance,
    });
    const transitionId = expectString(
      op,
      "transition_id",
      "StateMachineTransitionOp",
    );
    const resolvedTransition = machine.resolveTransition(
      instance,
      transitionId,
    );
    const transition = resolvedTransition.transition;
    assertStateMachineGuardEvidence(packetProposal, transition, context);
    worldMachineShadow.set(instanceId, {
      ...instance,
      state_id: expectString(
        resolvedTransition.toState,
        "state_id",
        "MachineStateDefinition",
      ),
    });
  }
}

function handleStageOutcomeResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "choice.required":
      assertChoiceSpec(context);
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      assertControlExists(context, context.input);
      const clientProposal = expectJsonObject(
        expectProperty(
          context.input,
          "proposal",
          "StageOutcomeResolveInput",
        ),
        "StageOutcomeResolveInput.proposal",
      );
      const stageId = expectString(
        clientProposal,
        "stage_instance_id",
        "StageOutcomeProposal",
      );
      const stageRevision = expectInteger(
        clientProposal,
        "stage_revision",
        "StageOutcomeProposal",
      );
      const stage = findStage(context.world, stageId);
      if (
        stage === undefined ||
        expectString(stage, "status", "StageInstanceState") !== "open" ||
        expectInteger(stage, "revision", "StageInstanceState") !==
          stageRevision
      ) {
        throw fault(
          "rule_plugin.semantic.stage_outcome_basis_mismatch",
          "Stage outcome must target the exact open StageInstance revision",
          {
            operation_kind: context.operationKind,
            stage_instance_id: stageId,
            stage_revision: stageRevision,
          },
        );
      }
      const outcomeType = expectString(
        clientProposal,
        "outcome_type",
        "StageOutcomeProposal",
      );
      const transitionKind =
        context.stageContracts.requireOutcomeTransition({
          stageInstance: stage,
          outcomeType,
        });
      const ops = asObjectArray(
        expectProperty(proposal, "ops", "PacketProposal"),
        "PacketProposal.ops",
      );
      const stageOps = ops.filter((op) => {
        const opKind = expectString(op, "op", "EffectOp");
        return opKind === "stage.update" || opKind === "stage.close";
      });
      const stageOp = stageOps.length === 1 ? stageOps[0] : undefined;
      const expectedStageOp =
        transitionKind === "stage.update"
          ? "stage.update"
          : "stage.close";
      if (
        stageOp === undefined ||
        ops[ops.length - 1] !== stageOp ||
        expectString(stageOp, "op", "EffectOp") !== expectedStageOp
      ) {
        throw fault(
          "rule_plugin.semantic.stage_outcome_transition_shape",
          "Stage outcome packet must end with the exact declared Stage transition",
          {
            operation_kind: context.operationKind,
            outcome_type: outcomeType,
            transition_kind: transitionKind,
            expected_op: expectedStageOp,
            stage_operation_count: stageOps.length,
            op_count: ops.length,
          },
        );
      }
      assertEqual(
        "stage_outcome.stage_instance_id",
        stageId,
        expectString(stageOp, "stage_instance_id", "Stage outcome op"),
        context.operationKind,
      );
      assertEqual(
        "stage_outcome.revision",
        stageRevision,
        expectInteger(stageOp, "revision", "Stage outcome op"),
        context.operationKind,
      );
      if (transitionKind === "stage.update") {
        assertEqual(
          "stage_outcome.evidence_digest",
          expectString(
            clientProposal,
            "evidence_digest",
            "StageOutcomeProposal",
          ),
          expectString(stageOp, "evidence_digest", "StageUpdateOp"),
          context.operationKind,
        );
        return;
      }
      assertEqual(
        "stage_outcome.outcome_type",
        outcomeType,
        expectString(stageOp, "outcome_type", "StageCloseOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "stage_outcome.outcome",
        expectProperty(
          clientProposal,
          "outcome",
          "StageOutcomeProposal",
        ),
        expectProperty(stageOp, "outcome", "StageCloseOp"),
        context.operationKind,
      );
      assertStageOutcomeCompletionPreconditions({
        proposal,
        stage,
        transitionKind,
        outcomeType,
        operationKind: context.operationKind,
      });
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertStateMachineAdvanceInput(
  parameters: {
    readonly input: JsonObject;
    readonly world: JsonObject;
    readonly worldId: string;
    readonly worldContentLock: WorldContentLockDocument;
    readonly authority: StateMachineContractAuthority;
  },
): {
  readonly instance: JsonObject;
  readonly machine: ReturnType<
    StateMachineContractAuthority["assertLockedInstance"]
  >;
} {
  const {
    input,
    world,
    worldId,
    worldContentLock: lockedContent,
    authority,
  } = parameters;
  const machineInstanceId = expectString(
    input,
    "machine_instance_id",
    "StateMachineAdvanceInput",
  );
  const instance = findStateMachine(world, machineInstanceId);
  if (instance === undefined) {
    throw fault(
      "rule_plugin.semantic.state_machine_missing",
      `State machine instance ${machineInstanceId} is absent from readonly_world`,
      {
        operation_kind: "state_machine.advance",
        machine_instance_id: machineInstanceId,
      },
    );
  }
  const machine = authority.assertLockedInstance({
    worldContentLock: lockedContent,
    worldId,
    instance,
  });
  const inputDefinition = expectJsonObject(
    expectProperty(input, "machine_definition", "StateMachineAdvanceInput"),
    "StateMachineAdvanceInput.machine_definition",
  );
  if (!jsonEquals(inputDefinition, machine.definition)) {
    throw fault(
      "rule_plugin.semantic.state_machine_definition_mismatch",
      "state_machine.advance input must carry the exact registered definition selected by the runtime instance",
      {
        operation_kind: "state_machine.advance",
        machine_instance_id: machineInstanceId,
      },
    );
  }
  return Object.freeze({ instance, machine });
}

function assertStateMachineGuardEvidence(
  proposal: JsonObject,
  transition: JsonObject,
  context: OperationContext,
): void {
  const guard = transition["guard"];
  if (guard === undefined) {
    return;
  }
  const guardRule = expectJsonObject(
    guard,
    "MachineTransitionDefinition.guard",
  );
  const matches = asObjectArray(
    expectProperty(proposal, "preconditions", "PacketProposal"),
    "PacketProposal.preconditions",
  ).filter(
    (precondition) =>
      expectString(precondition, "kind", "PacketPrecondition") ===
        "rule.holds" &&
      jsonEquals(
        expectProperty(precondition, "rule", "PacketPrecondition"),
        guardRule,
      ),
  );
  if (matches.length !== 1) {
    throw fault(
      "rule_plugin.semantic.state_machine_guard_evidence",
      "Guarded state-machine proposal requires exactly one matching rule.holds precondition",
      {
        operation_kind: context.operationKind,
        transition_id: expectString(
          transition,
          "transition_id",
          "MachineTransitionDefinition",
        ),
        matching_preconditions: matches.length,
      },
    );
  }
}

function assertStageOutcomeCompletionPreconditions(input: {
  readonly proposal: JsonObject;
  readonly stage: JsonObject;
  readonly transitionKind: Exclude<
    StageOutcomeTransitionKind,
    "stage.update"
  >;
  readonly outcomeType: string;
  readonly operationKind: OperationKind;
}): void {
  const completionRules = asObjectArray(
    expectProperty(
      input.stage,
      "completion_rules",
      "StageInstanceState",
    ),
    "StageInstanceState.completion_rules",
  );
  const preconditions = asObjectArray(
    expectProperty(
      input.proposal,
      "preconditions",
      "PacketProposal",
    ),
    "PacketProposal.preconditions",
  );
  const matchingRules: JsonObject[] = [];
  for (const precondition of preconditions) {
    if (
      expectString(
        precondition,
        "kind",
        "PacketPrecondition",
      ) !== "rule.holds"
    ) {
      continue;
    }
    const rule = expectJsonObject(
      expectProperty(
        precondition,
        "rule",
        "PacketPrecondition",
      ),
      "PacketPrecondition.rule",
    );
    if (
      completionRules.some((completionRule) =>
        jsonEquals(completionRule, rule),
      )
    ) {
      matchingRules.push(rule);
    }
  }

  if (input.transitionKind === "stage.close.non_completion") {
    if (matchingRules.length !== 0) {
      throw fault(
        "rule_plugin.semantic.stage_outcome_non_completion_rule_forbidden",
        "A non-completion Stage close cannot claim any instance completion rule",
        {
          operation_kind: input.operationKind,
          outcome_type: input.outcomeType,
          matching_completion_rule_count: matchingRules.length,
        },
      );
    }
    return;
  }

  if (
    matchingRules.length !== completionRules.length ||
    matchingRules.some((rule, index) => {
      const expectedRule = completionRules[index];
      return (
        expectedRule === undefined ||
        !jsonEquals(rule, expectedRule)
      );
    })
  ) {
    throw fault(
      "rule_plugin.semantic.stage_outcome_completion_rules_mismatch",
      "A completion Stage close must carry every instance completion rule exactly once and in order",
      {
        operation_kind: input.operationKind,
        outcome_type: input.outcomeType,
        expected_completion_rule_count: completionRules.length,
        matching_completion_rule_count: matchingRules.length,
      },
    );
  }
}

function handleDialogueOpen(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "dialogue.open", context.operationKind);
      for (const field of ["dialogue_id", "day"] as const) {
        assertEqual(
          `dialogue.open.${field}`,
          expectProperty(context.input, field, "DialogueOpenInput") as string | number,
          expectProperty(op, field, "DialogueOpenOp") as string | number,
          context.operationKind,
        );
      }
      assertJsonFieldEqual(
        "dialogue.open.participants",
        expectProperty(context.input, "participants", "DialogueOpenInput"),
        expectProperty(op, "participants", "DialogueOpenOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "dialogue.open.first_turn",
        expectProperty(context.input, "first_turn", "DialogueOpenInput"),
        expectProperty(op, "first_turn", "DialogueOpenOp"),
        context.operationKind,
      );
      const firstTurn = expectJsonObject(
        expectProperty(
          context.input,
          "first_turn",
          "DialogueOpenInput",
        ),
        "DialogueOpenInput.first_turn",
      );
      const participants = asObjectArray(
        expectProperty(
          context.input,
          "participants",
          "DialogueOpenInput",
        ),
        "DialogueOpenInput.participants",
      );
      assertHumanDialogueControlAndSource(
        context,
        context.input,
        firstTurn,
        participants,
        proposal,
      );
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleDialogueTurnAppend(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "dialogue.turn.append", context.operationKind);
      assertEqual(
        "dialogue.append.dialogue_id",
        expectString(context.input, "dialogue_id", "DialogueTurnAppendInput"),
        expectString(op, "dialogue_id", "DialogueTurnAppendOp"),
        context.operationKind,
      );
      assertEqual(
        "dialogue.append.expected_revision",
        expectInteger(context.input, "expected_revision", "DialogueTurnAppendInput"),
        expectInteger(op, "expected_revision", "DialogueTurnAppendOp"),
        context.operationKind,
      );
      const turn = readDialogueTurnCandidate(context.input);
      const committedTurn = expectJsonObject(
        expectProperty(op, "turn", "DialogueTurnAppendOp"),
        "DialogueTurnAppendOp.turn",
      );

      const dialogueId = expectString(
        context.input,
        "dialogue_id",
        "DialogueTurnAppendInput",
      );
      const dialogue = findDialogue(context.world, dialogueId);
      if (dialogue === undefined) {
        throw fault(
          "rule_plugin.semantic.dialogue_missing",
          `Dialogue ${dialogueId} is absent from readonly_world`,
          { operation_kind: context.operationKind, dialogue_id: dialogueId },
        );
      }
      assertEqual(
        "dialogue.append.world_revision",
        expectInteger(dialogue, "revision", "DialogueRecord"),
        expectInteger(context.input, "expected_revision", "DialogueTurnAppendInput"),
        context.operationKind,
      );

      const participants = asObjectArray(
        expectProperty(
          dialogue,
          "participants",
          "DialogueRecord",
        ),
        "DialogueRecord.participants",
      );
      const source = expectJsonObject(
        expectProperty(turn, "source", "DialogueTurn"),
        "DialogueTurn.source",
      );
      const sourceKind = expectString(
        source,
        "source_kind",
        "DialogueTurnSource",
      );
      if (sourceKind === "character_mind") {
        assertCharacterTurnProposalMatchesCandidate(
          context,
          turn,
          committedTurn,
        );
      } else {
        assertJsonFieldEqual(
          "dialogue.append.turn",
          turn,
          committedTurn,
          context.operationKind,
        );
      }
      assertDialogueSpeakerIsParticipant(
        context,
        turn,
        participants,
      );
      if (sourceKind === "human") {
        assertHumanDialogueControlAndSource(
          context,
          context.input,
          turn,
          participants,
          proposal,
        );
      } else if (sourceKind === "character_mind") {
        assertActiveCharacterMindSpeaker(context, turn);
      } else if (sourceKind === "director_system") {
        assertControlExists(context, context.input);
      }
      if (context.input.model_proof !== undefined) {
        assertModelProofRevisionCompatible(context, context.input, "model_proof");
      }
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleDialogueClose(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "dialogue.close", context.operationKind);
      assertEqual(
        "dialogue.close.dialogue_id",
        expectString(context.input, "dialogue_id", "DialogueCloseInput"),
        expectString(op, "dialogue_id", "DialogueCloseOp"),
        context.operationKind,
      );
      assertEqual(
        "dialogue.close.expected_revision",
        expectInteger(context.input, "expected_revision", "DialogueCloseInput"),
        expectInteger(op, "expected_revision", "DialogueCloseOp"),
        context.operationKind,
      );
      assertEqual(
        "dialogue.close.reason_code",
        expectString(context.input, "reason_code", "DialogueCloseInput"),
        expectString(op, "reason_code", "DialogueCloseOp"),
        context.operationKind,
      );
      const dialogueId = expectString(
        context.input,
        "dialogue_id",
        "DialogueCloseInput",
      );
      const dialogue = findDialogue(context.world, dialogueId);
      if (dialogue === undefined) {
        throw fault(
          "rule_plugin.semantic.dialogue_missing",
          `Dialogue ${dialogueId} is absent from readonly_world`,
          { operation_kind: context.operationKind, dialogue_id: dialogueId },
        );
      }
      assertEqual(
        "dialogue.close.world_revision",
        expectInteger(dialogue, "revision", "DialogueRecord"),
        expectInteger(context.input, "expected_revision", "DialogueCloseInput"),
        context.operationKind,
      );
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleEventCardPublish(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "event_card.publish", context.operationKind);
      const cardCandidate = expectJsonObject(
        expectProperty(context.input, "candidate", "EventCardPublishInput"),
        "EventCardPublishInput.candidate",
      );
      const control = expectJsonObject(
        expectProperty(context.input, "control", "EventCardPublishInput"),
        "EventCardPublishInput.control",
      );
      assertModelProofRevisionCompatible(context, context.input, "model_proof");

      assertEqual(
        "event_card.source_proposal_id",
        expectString(cardCandidate, "proposal_id", "EventCardPublishCandidate"),
        expectString(op, "source_proposal_id", "EventCardPublishOp"),
        context.operationKind,
      );
      assertEqual(
        "event_card.source_dialogue_id",
        expectString(
          cardCandidate,
          "source_dialogue_id",
          "EventCardPublishCandidate",
        ),
        expectString(op, "source_dialogue_id", "EventCardPublishOp"),
        context.operationKind,
      );
      assertEqual(
        "event_card.day",
        expectInteger(cardCandidate, "day", "EventCardPublishCandidate"),
        expectInteger(op, "day", "EventCardPublishOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "event_card.title",
        expectProperty(cardCandidate, "title", "EventCardPublishCandidate"),
        expectProperty(op, "title", "EventCardPublishOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "event_card.summary",
        expectProperty(cardCandidate, "summary", "EventCardPublishCandidate"),
        expectProperty(op, "summary", "EventCardPublishOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "event_card.control",
        control,
        expectProperty(op, "control", "EventCardPublishOp"),
        context.operationKind,
      );

      const sealed = expectJsonObject(
        expectProperty(op, "sealed_result", "EventCardPublishOp"),
        "EventCardPublishOp.sealed_result",
      );
      assertEqual(
        "sealed.source_proposal_id",
        expectString(cardCandidate, "proposal_id", "EventCardPublishCandidate"),
        expectString(sealed, "source_proposal_id", "SealedEventResult"),
        context.operationKind,
      );
      assertEqual(
        "sealed.adjudicated_at_revision",
        expectInteger(context.request.value, "basis_revision", "RulePluginRequest"),
        expectInteger(sealed, "adjudicated_at_revision", "SealedEventResult"),
        context.operationKind,
      );

      const deterministicContext = expectJsonObject(
        expectProperty(
          context.request.value,
          "deterministic_context",
          "RulePluginRequest",
        ),
        "RulePluginRequest.deterministic_context",
      );
      assertJsonFieldEqual(
        "sealed.deterministic_context",
        deterministicContext,
        expectProperty(
          sealed,
          "deterministic_context",
          "SealedEventResult",
        ),
        context.operationKind,
      );

      const selectedOptionId = expectString(
        sealed,
        "selected_option_id",
        "SealedEventResult",
      );
      const options = asObjectArray(
        expectProperty(
          cardCandidate,
          "result_options",
          "EventCardPublishCandidate",
        ),
        "EventCardPublishCandidate.result_options",
      );
      const selected = options.find(
        (option) =>
          expectString(
            option,
            "option_id",
            "MaterializedEventCardOutcomeCandidate",
          ) ===
          selectedOptionId,
      );
      if (selected === undefined) {
        throw fault(
          "rule_plugin.semantic.event_card_option_unknown",
          `Sealed selected_option_id ${selectedOptionId} is not in proposal result_options`,
          {
            operation_kind: context.operationKind,
            selected_option_id: selectedOptionId,
          },
        );
      }
      assertJsonFieldEqual(
        "sealed.presentation",
        expectProperty(
          selected,
          "presentation",
          "MaterializedEventCardOutcomeCandidate",
        ),
        expectProperty(sealed, "presentation", "SealedEventResult"),
        context.operationKind,
      );

      const sealedWithoutDigest = omitField(sealed, "result_digest");
      assertEqual(
        "sealed.result_digest",
        context.digest.sha256(sealedWithoutDigest),
        expectString(sealed, "result_digest", "SealedEventResult"),
        context.operationKind,
      );

      const cost = expectJsonObject(
        expectProperty(op, "cost", "EventCardPublishOp"),
        "EventCardPublishOp.cost",
      );
      const amount = expectInteger(cost, "amount", "EventCost");
      if (amount < 1) {
        throw fault(
          "rule_plugin.semantic.event_card_cost",
          "EventCard publish cost.amount must be positive",
          { operation_kind: context.operationKind, amount },
        );
      }

      assertEventCardAgency(
        context,
        cardCandidate,
        selected,
        sealed,
        expectInteger(cardCandidate, "day", "EventCardPublishCandidate"),
      );
      assertDialogueQuotesVisible(
        context,
        cardCandidate,
        control,
        sealed,
      );
      assertControlExists(context, context.input);
      assertEventBudgetSufficient(
        context,
        control,
        expectInteger(cardCandidate, "day", "EventCardPublishCandidate"),
        amount,
      );
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function assertEventBudgetSufficient(
  context: OperationContext,
  control: JsonObject,
  day: number,
  newChargeAmount: number,
): void {
  const bindingId = expectString(control, "binding_id", "ControlBindingRef");
  const budgets = asObjectArray(
    expectProperty(context.world, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  );
  const matchingBudgets = budgets.filter((budget) => {
    const budgetControl = expectJsonObject(
      expectProperty(budget, "control", "EventBudgetState"),
      "EventBudgetState.control",
    );
    return (
      expectString(budgetControl, "binding_id", "ControlBindingRef") === bindingId &&
      expectInteger(budget, "day", "EventBudgetState") === day
    );
  });

  if (matchingBudgets.length !== 1) {
    throw fault(
      "rule_plugin.semantic.event_budget_count",
      "EventCard publish requires exactly one budget for the control and day",
      {
        operation_kind: context.operationKind,
        control_binding_id: bindingId,
        day,
        budget_count: matchingBudgets.length,
      },
    );
  }

  const budget = matchingBudgets[0] as JsonObject;
  const capacity = expectInteger(budget, "capacity", "EventBudgetState");
  const charges = asObjectArray(
    expectProperty(budget, "charges", "EventBudgetState"),
    "EventBudgetState.charges",
  );
  const spent = charges.reduce((total, charge) => {
    const cost = expectJsonObject(
      expectProperty(charge, "cost", "EventCharge"),
      "EventCharge.cost",
    );
    return total + expectInteger(cost, "amount", "EventCost");
  }, 0);

  if (spent + newChargeAmount > capacity) {
    throw fault(
      "rule_plugin.semantic.event_budget_insufficient",
      "EventCard publish cost exceeds the remaining event budget",
      {
        operation_kind: context.operationKind,
        control_binding_id: bindingId,
        day,
        capacity,
        spent,
        requested: newChargeAmount,
      },
    );
  }
}

function assertEventCardAgency(
  context: OperationContext,
  cardCandidate: JsonObject,
  selectedOption: JsonObject,
  sealed: JsonObject,
  day: number,
): void {
  const gates = asObjectArray(
    expectProperty(
      cardCandidate,
      "agency_gates",
      "EventCardPublishCandidate",
    ),
    "EventCardPublishCandidate.agency_gates",
  );
  const selectedOutcomes = asObjectArray(
    expectProperty(
      selectedOption,
      "outcomes",
      "MaterializedEventCardOutcomeCandidate",
    ),
    "MaterializedEventCardOutcomeCandidate.outcomes",
  );
  const selectedOutcomeIds = new Set(
    selectedOutcomes.map((outcome) =>
      expectString(
        outcome,
        "outcome_id",
        "MaterializedSemanticOutcomeCandidate",
      ),
    ),
  );

  const requiredCommitmentKeys = new Set<string>();
  for (const gate of gates) {
    const protectedIds = asStringArray(
      expectProperty(
        gate,
        "protected_outcome_ids",
        "MaterializedAgencyGateCandidate",
      ),
      "MaterializedAgencyGateCandidate.protected_outcome_ids",
    );
    const protectsSelected = protectedIds.some((id) => selectedOutcomeIds.has(id));
    if (!protectsSelected) {
      continue;
    }
    const evidence = asObjectArray(
      expectProperty(
        gate,
        "commitment_evidence",
        "MaterializedAgencyGateCandidate",
      ),
      "MaterializedAgencyGateCandidate.commitment_evidence",
    );
    if (evidence.length === 0) {
      throw fault(
        "rule_plugin.semantic.event_card_agency_evidence_missing",
        `Agency gate protecting selected outcomes has empty commitment_evidence`,
        {
          operation_kind: context.operationKind,
          gate_id: expectString(
            gate,
            "gate_id",
            "MaterializedAgencyGateCandidate",
          ),
        },
      );
    }
    for (const ref of evidence) {
      const dialogueId = expectString(ref, "dialogue_id", "AgencyCommitmentRef");
      const turnId = expectString(ref, "turn_id", "AgencyCommitmentRef");
      const commitmentId = expectString(
        ref,
        "commitment_id",
        "AgencyCommitmentRef",
      );
      const key = `${dialogueId}:${turnId}:${commitmentId}`;
      requiredCommitmentKeys.add(key);
      assertCommitmentRefResolves(context, ref, day, gate);
    }
  }

  const preconditions = asObjectArray(
    expectProperty(sealed, "preconditions", "SealedEventResult"),
    "SealedEventResult.preconditions",
  );
  const sealedCommitmentKeys = new Set<string>();
  for (const precondition of preconditions) {
    if (
      expectString(precondition, "kind", "PacketPrecondition") !==
      "agency.commitment_valid"
    ) {
      continue;
    }
    const commitment = expectJsonObject(
      expectProperty(precondition, "commitment", "PacketPrecondition"),
      "PacketPrecondition.commitment",
    );
    sealedCommitmentKeys.add(
      `${expectString(commitment, "dialogue_id", "AgencyCommitmentRef")}:${expectString(commitment, "turn_id", "AgencyCommitmentRef")}:${expectString(commitment, "commitment_id", "AgencyCommitmentRef")}`,
    );
  }

  for (const key of requiredCommitmentKeys) {
    if (!sealedCommitmentKeys.has(key)) {
      throw fault(
        "rule_plugin.semantic.event_card_agency_precondition_missing",
        `Sealed result missing agency.commitment_valid for ${key}`,
        { operation_kind: context.operationKind, commitment: key },
      );
    }
  }
}

function assertCommitmentRefResolves(
  context: OperationContext,
  ref: JsonObject,
  day: number,
  gate: JsonObject,
): void {
  const dialogueId = expectString(ref, "dialogue_id", "AgencyCommitmentRef");
  const turnId = expectString(ref, "turn_id", "AgencyCommitmentRef");
  const commitmentId = expectString(ref, "commitment_id", "AgencyCommitmentRef");
  const dialogue = findDialogue(context.world, dialogueId);
  if (dialogue === undefined) {
    throw fault(
      "rule_plugin.semantic.agency_dialogue_missing",
      `Agency commitment dialogue ${dialogueId} is absent`,
      { operation_kind: context.operationKind, dialogue_id: dialogueId },
    );
  }
  const turns = asObjectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const turn = turns.find(
    (entry) => expectString(entry, "turn_id", "DialogueTurn") === turnId,
  );
  if (turn === undefined) {
    throw fault(
      "rule_plugin.semantic.agency_turn_missing",
      `Agency commitment turn ${turnId} is absent from dialogue ${dialogueId}`,
      {
        operation_kind: context.operationKind,
        dialogue_id: dialogueId,
        turn_id: turnId,
      },
    );
  }
  const commitments = asObjectArray(
    expectProperty(turn, "agency_commitments", "DialogueTurn"),
    "DialogueTurn.agency_commitments",
  );
  const commitment = commitments.find(
    (entry) =>
      expectString(entry, "commitment_id", "AgencyCommitment") === commitmentId,
  );
  if (commitment === undefined) {
    throw fault(
      "rule_plugin.semantic.agency_commitment_missing",
      `Agency commitment ${commitmentId} is absent from turn ${turnId}`,
      {
        operation_kind: context.operationKind,
        dialogue_id: dialogueId,
        turn_id: turnId,
        commitment_id: commitmentId,
      },
    );
  }

  const requirement = expectJsonObject(
    expectProperty(
      gate,
      "requirement",
      "MaterializedAgencyGateCandidate",
    ),
    "MaterializedAgencyGateCandidate.requirement",
  );
  assertEqual(
    "agency.semantic_intent",
    expectString(requirement, "semantic_intent", "AgencyRequirement"),
    expectString(commitment, "semantic_intent", "AgencyCommitment"),
    context.operationKind,
  );
  assertJsonFieldEqual(
    "agency.subjects",
    expectProperty(requirement, "subjects", "AgencyRequirement"),
    expectProperty(commitment, "subjects", "AgencyCommitment"),
    context.operationKind,
  );
  assertJsonFieldEqual(
    "agency.terms",
    expectProperty(requirement, "terms", "AgencyRequirement"),
    expectProperty(commitment, "terms", "AgencyCommitment"),
    context.operationKind,
  );
  const validThrough = expectInteger(
    commitment,
    "valid_through_day",
    "AgencyCommitment",
  );
  if (validThrough < day) {
    throw fault(
      "rule_plugin.semantic.agency_commitment_expired",
      `Agency commitment ${commitmentId} expired before event day`,
      {
        operation_kind: context.operationKind,
        commitment_id: commitmentId,
        valid_through_day: validThrough,
        event_day: day,
      },
    );
  }
}

function assertDialogueQuotesVisible(
  context: OperationContext,
  cardCandidate: JsonObject,
  control: JsonObject,
  sealed: JsonObject,
): void {
  const controlBindingId = expectString(
    control,
    "binding_id",
    "ControlBindingRef",
  );
  const binding = findControlBinding(context.world, controlBindingId);
  if (
    binding === undefined ||
    expectString(binding, "binding_kind", "ControlBinding") !== "human" ||
    expectString(binding, "status", "ControlBinding") !== "active"
  ) {
    throw fault(
      "rule_plugin.semantic.event_card_human_control_required",
      "EventCard presentation requires one active human ControlBinding",
      {
        operation_kind: context.operationKind,
        binding_id: controlBindingId,
      },
    );
  }
  const playerEntityId = expectString(
    binding,
    "entity_id",
    "ControlBinding",
  );
  const sourceDialogueId = expectString(
    cardCandidate,
    "source_dialogue_id",
    "EventCardPublishCandidate",
  );
  const sourceDialogue = findDialogue(context.world, sourceDialogueId);
  if (
    sourceDialogue === undefined ||
    !dialogueContainsEntity(sourceDialogue, playerEntityId)
  ) {
    throw fault(
      "rule_plugin.semantic.event_card_source_dialogue_not_visible",
      "EventCard source dialogue must be visible to its human control",
      {
        operation_kind: context.operationKind,
        dialogue_id: sourceDialogueId,
        binding_id: controlBindingId,
        player_entity_id: playerEntityId,
      },
    );
  }

  const presentation = expectJsonObject(
    expectProperty(sealed, "presentation", "SealedEventResult"),
    "SealedEventResult.presentation",
  );
  const segments = asObjectArray(
    expectProperty(presentation, "segments", "EventResultPresentation"),
    "EventResultPresentation.segments",
  );
  for (const segment of segments) {
    const kind = expectString(segment, "segment_kind", "NarrativeSegment");
    if (kind !== "dialogue_quote") {
      continue;
    }
    const dialogueId = expectString(segment, "dialogue_id", "DialogueTurnQuoteSegment");
    const turnId = expectString(segment, "turn_id", "DialogueTurnQuoteSegment");
    const dialogue = findDialogue(context.world, dialogueId);
    if (dialogue === undefined) {
      throw fault(
        "rule_plugin.semantic.dialogue_quote_missing",
        `dialogue_quote references missing dialogue ${dialogueId}`,
        { operation_kind: context.operationKind, dialogue_id: dialogueId },
      );
    }
    if (!dialogueContainsEntity(dialogue, playerEntityId)) {
      throw fault(
        "rule_plugin.semantic.dialogue_quote_not_visible",
        `dialogue_quote references dialogue ${dialogueId} outside the EventCard control view`,
        {
          operation_kind: context.operationKind,
          dialogue_id: dialogueId,
          turn_id: turnId,
          binding_id: controlBindingId,
          player_entity_id: playerEntityId,
        },
      );
    }
    const turns = asObjectArray(
      expectProperty(dialogue, "turns", "DialogueRecord"),
      "DialogueRecord.turns",
    );
    const turn = turns.find(
      (entry) => expectString(entry, "turn_id", "DialogueTurn") === turnId,
    );
    if (turn === undefined) {
      throw fault(
        "rule_plugin.semantic.dialogue_quote_turn_missing",
        `dialogue_quote references missing turn ${turnId}`,
        {
          operation_kind: context.operationKind,
          dialogue_id: dialogueId,
          turn_id: turnId,
        },
      );
    }
  }
}

function assertPacketProposalProvenance(context: OperationContext): JsonObject {
  const proposal = expectJsonObject(
    expectProperty(context.output, "proposal", "RulePluginResponse.output"),
    "RulePluginResponse.output.proposal",
  );
  const proposedBy = expectJsonObject(
    expectProperty(proposal, "proposed_by", "PacketProposal"),
    "PacketProposal.proposed_by",
  );
  const pluginLock = expectJsonObject(
    expectProperty(context.request.value, "plugin_lock", "RulePluginRequest"),
    "RulePluginRequest.plugin_lock",
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      context.request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );

  const pairs: readonly CorrelationPair[] = [
    {
      field: "proposed_by.plugin_id",
      expected: expectString(pluginLock, "plugin_id", "PluginLock"),
      actual: expectString(proposedBy, "plugin_id", "PacketProposal.proposed_by"),
    },
    {
      field: "proposed_by.operation_id",
      expected: expectString(context.request.value, "operation_id", "RulePluginRequest"),
      actual: expectString(proposedBy, "operation_id", "PacketProposal.proposed_by"),
    },
    {
      field: "proposed_by.request_id",
      expected: expectString(context.request.value, "request_id", "RulePluginRequest"),
      actual: expectString(proposedBy, "request_id", "PacketProposal.proposed_by"),
    },
    {
      field: "basis_revision",
      expected: expectInteger(
        context.request.value,
        "basis_revision",
        "RulePluginRequest",
      ),
      actual: expectInteger(proposal, "basis_revision", "PacketProposal"),
    },
    {
      field: "deterministic_context_id",
      expected: expectString(
        deterministicContext,
        "context_id",
        "DeterministicContext",
      ),
      actual: expectString(proposal, "deterministic_context_id", "PacketProposal"),
    },
    {
      field: "deterministic_context_digest",
      expected: expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      ),
      actual: expectString(
        proposal,
        "deterministic_context_digest",
        "PacketProposal",
      ),
    },
  ];

  for (const pair of pairs) {
    if (pair.expected !== pair.actual) {
      throw fault(
        "rule_plugin.semantic.packet_proposal_provenance_mismatch",
        `PacketProposal ${pair.field} does not match its RulePluginRequest`,
        {
          field: pair.field,
          expected: pair.expected,
          actual: pair.actual,
          operation_kind: context.operationKind,
          request_id: expectString(
            context.request.value,
            "request_id",
            "RulePluginRequest",
          ),
        },
      );
    }
  }

  return proposal;
}

function assertModelEvidenceForOperation(context: EvidenceContext): void {
  switch (context.operationKind) {
    case "definition.validate": {
      const verified = requireSingleVerifiedDraft(
        context,
        context.input,
        "model_proof",
        "director.definition_draft",
        "draft",
      );
      assertDefinitionCandidateMatchesDraft(
        context,
        verified.receipt,
        verified.draft,
      );
      return;
    }
    case "goal_plan.validate": {
      const verified = requireSingleVerifiedDraft(
        context,
        context.input,
        "model_proof",
        "director.goal_plan",
        "draft",
      );
      assertGoalPlanCandidateMatchesDraft(
        context,
        verified.receipt,
        verified.draft,
      );
      return;
    }
    case "automatic_event.world.resolve": {
      const verified = requireVerifiedCollectionDraft(
        context,
        context.input,
        "model_proof",
        "director.daily_settlement",
        "automatic_events",
      );
      assertAutomaticEventCandidateMatchesDraft(
        context,
        verified.receipt,
        verified.draft,
        "world",
      );
      return;
    }
    case "automatic_event.character.resolve":
      assertCharacterAutomaticEventEvidence(context);
      return;
    case "dialogue.turn.append":
      assertDialogueTurnEvidence(context);
      return;
    case "event_card.publish": {
      const verified = requireVerifiedCollectionDraft(
        context,
        context.input,
        "model_proof",
        "director.dialogue_events",
        "event_cards",
      );
      assertEventCardCandidateMatchesDraft(
        context,
        verified.receipt,
        verified.draft,
      );
      return;
    }
    case "rule.evaluate":
    case "capability.resolve":
    case "navigation.resolve":
    case "world_extension.resolve":
    case "content_upgrade.transform":
    case "day_cycle.advance":
    case "state_machine.advance":
    case "stage_outcome.resolve":
    case "dialogue.open":
    case "dialogue.close":
      return;
  }
}

function assertCharacterAutomaticEventEvidence(
  context: EvidenceContext,
): void {
  const verifiedEvent = requireVerifiedCollectionDraft(
    context,
    context.input,
    "director_proof",
    "director.daily_settlement",
    "automatic_events",
  );
  assertAutomaticEventCandidateMatchesDraft(
    context,
    verifiedEvent.receipt,
    verifiedEvent.draft,
    "character",
  );
  const eventCandidate = expectJsonObject(
    expectProperty(
      context.input,
      "candidate",
      "CharacterAutomaticEventResolveInput",
    ),
    "CharacterAutomaticEventResolveInput.candidate",
  );
  const proposalId = expectString(
    eventCandidate,
    "proposal_id",
    "MaterializedCharacterAutomaticEventCandidate",
  );
  const batches = asObjectArray(
    expectProperty(
      context.input,
      "character_reactions",
      "CharacterAutomaticEventResolveInput",
    ),
    "CharacterAutomaticEventResolveInput.character_reactions",
  );
  const targetIds = new Set(
    asStringArray(
      expectProperty(
        eventCandidate,
        "target_entity_ids",
        "MaterializedCharacterAutomaticEventCandidate",
      ),
      "MaterializedCharacterAutomaticEventCandidate.target_entity_ids",
    ),
  );
  const batchCharacterIds = new Set<string>();
  for (const [batchIndex, batch] of batches.entries()) {
    const receipt = requireModelInvocation(
      context,
      batch,
      "model_proof",
      ["character.react"],
    );
    const receiptInput = modelReceiptInput(receipt);
    assertEqual(
      "character_react.day",
      expectInteger(eventCandidate, "day", "MaterializedCharacterAutomaticEventCandidate"),
      expectInteger(receiptInput, "day", "CharacterReactInput"),
      context.operationKind,
    );
    const subjective = expectJsonObject(
      expectProperty(receiptInput, "subjective_view", "CharacterReactInput"),
      "CharacterReactInput.subjective_view",
    );
    const receiptCharacter = expectProperty(
      subjective,
      "character",
      "CharacterSubjectiveView",
    );
    const batchCharacter = expectProperty(
      batch,
      "character",
      "CharacterReactionBatch",
    );
    if (!jsonEquals(receiptCharacter, batchCharacter)) {
      throw fault(
        "rule_plugin.semantic.model_evidence_character_mismatch",
        "CharacterReactionBatch character does not match its verified model invocation",
        {
          operation_kind: context.operationKind,
          batch_index: batchIndex,
        },
      );
    }
    const batchCharacterObject = expectJsonObject(
      batchCharacter,
      "CharacterReactionBatch.character",
    );
    const batchCharacterId = expectString(
      batchCharacterObject,
      "entity_id",
      "EntityRef",
    );
    if (batchCharacterIds.has(batchCharacterId)) {
      throw fault(
        "rule_plugin.semantic.character_reaction_duplicate",
        "Character automatic event contains duplicate character reaction batches",
        {
          operation_kind: context.operationKind,
          entity_id: batchCharacterId,
        },
      );
    }
    batchCharacterIds.add(batchCharacterId);

    const stimuli = asObjectArray(
      expectProperty(receiptInput, "events", "CharacterReactInput"),
      "CharacterReactInput.events",
    );
    const output = modelReceiptOutput(receipt);
    const verifiedReactions = asObjectArray(
      expectProperty(output, "reactions", "CharacterReactOutput"),
      "CharacterReactOutput.reactions",
    );
    assertArrayLength(
      context,
      "character_react.events_and_reactions",
      stimuli,
      verifiedReactions,
    );
    const candidates = asObjectArray(
      expectProperty(batch, "candidates", "CharacterReactionBatch"),
      "CharacterReactionBatch.candidates",
    );
    if (candidates.length !== 1) {
      throw fault(
        "rule_plugin.semantic.model_evidence_reaction_count",
        "CharacterReactionBatch must carry exactly one candidate for the automatic event being resolved",
        {
          operation_kind: context.operationKind,
          proposal_id: proposalId,
          batch_index: batchIndex,
          candidate_count: candidates.length,
        },
      );
    }
    const ordinalCandidate = candidates[0] as JsonObject;
    const draftOrdinal = expectInteger(
      ordinalCandidate,
      "draft_ordinal",
      "OrdinalCharacterReactionCandidate",
    );
    const stimulus = stimuli[draftOrdinal];
    const rawDraft = verifiedReactions[draftOrdinal];
    if (stimulus === undefined || rawDraft === undefined) {
      throw fault(
        "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
        "Character reaction draft_ordinal is outside its verified event/reaction pair",
        {
          operation_kind: context.operationKind,
          proposal_id: proposalId,
          batch_index: batchIndex,
          draft_ordinal: draftOrdinal,
          event_count: stimuli.length,
          draft_count: verifiedReactions.length,
        },
      );
    }
    assertStimulusMatchesCandidate(
      context,
      stimulus,
      eventCandidate,
    );
    const reactionCandidate = expectJsonObject(
      expectProperty(
        ordinalCandidate,
        "candidate",
        "OrdinalCharacterReactionCandidate",
      ),
      "OrdinalCharacterReactionCandidate.candidate",
    );
    assertCharacterReactionCandidateMatchesDraft({
      context,
      receipt,
      rawDraft,
      stimulus,
      proposalId,
      candidate: reactionCandidate,
    });
  }
  if (
    targetIds.size !== batchCharacterIds.size ||
    [...targetIds].some((entityId) => !batchCharacterIds.has(entityId))
  ) {
    throw fault(
      "rule_plugin.semantic.character_reaction_targets_incomplete",
      "Character reaction batches must exactly cover every automatic event target",
      {
        operation_kind: context.operationKind,
        proposal_id: proposalId,
        target_entity_ids: [...targetIds],
        reaction_entity_ids: [...batchCharacterIds],
      },
    );
  }
}

function assertDialogueTurnEvidence(context: EvidenceContext): void {
  const turn = readDialogueTurnCandidate(context.input);
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  const sourceKind = expectString(
    source,
    "source_kind",
    "DialogueTurnSource",
  );
  if (sourceKind === "human") {
    return;
  }

  const expectedKind =
    sourceKind === "character_mind"
      ? "character.dialogue"
      : sourceKind === "director_system"
        ? "director.system_dialogue"
        : undefined;
  if (expectedKind === undefined) {
    throw fault(
      "rule_plugin.semantic.dialogue_source_unknown",
      `Unknown DialogueTurn source_kind ${sourceKind}`,
      {
        operation_kind: context.operationKind,
        source_kind: sourceKind,
      },
    );
  }
  const receipt = requireModelInvocation(
    context,
    context.input,
    "model_proof",
    [expectedKind],
  );
  assertEqual(
    "dialogue.source.model_request_id",
    expectString(receipt.proof.value, "request_id", "VerifiedModelOutputRef"),
    expectString(source, "model_request_id", "DialogueTurnSource"),
    context.operationKind,
  );
  assertEqual(
    "dialogue.source.model_output_digest",
    expectString(
      receipt.proof.value,
      "output_digest",
      "VerifiedModelOutputRef",
    ),
    expectString(source, "model_output_digest", "DialogueTurnSource"),
    context.operationKind,
  );

  const receiptInput = modelReceiptInput(receipt);
  const receiptDialogue = expectJsonObject(
    expectProperty(receiptInput, "dialogue", "ModelDialogueInput"),
    "ModelDialogueInput.dialogue",
  );
  assertEqual(
    "dialogue.receipt.dialogue_id",
    expectString(context.input, "dialogue_id", "DialogueTurnAppendInput"),
    expectString(receiptDialogue, "dialogue_id", "DialogueRecord"),
    context.operationKind,
  );
  assertEqual(
    "dialogue.receipt.revision",
    expectInteger(
      context.input,
      "expected_revision",
      "DialogueTurnAppendInput",
    ),
    expectInteger(receiptDialogue, "revision", "DialogueRecord"),
    context.operationKind,
  );
  const output = modelReceiptOutput(receipt);
  const reply = expectJsonObject(
    expectProperty(output, "reply", "ModelDialogueOutput"),
    "ModelDialogueOutput.reply",
  );
  assertReplyMatchesTurn(context, receiptInput, reply, turn);
  assertJsonFieldEqual(
    "dialogue.turn.occurred_at",
    expectProperty(
      requestWorldState(context),
      "clock",
      "WorldState",
    ),
    expectProperty(turn, "occurred_at", "DialogueTurn"),
    context.operationKind,
  );

  if (sourceKind === "character_mind") {
    if (context.input.candidate === undefined) {
      throw fault(
        "rule_plugin.semantic.dialogue_character_candidate_missing",
        "Character dialogue RulePlugin input must use its materialized candidate",
        { operation_kind: context.operationKind },
      );
    }
    const subjective = expectJsonObject(
      expectProperty(
        receiptInput,
        "subjective_view",
        "CharacterDialogueInput",
      ),
      "CharacterDialogueInput.subjective_view",
    );
    const character = expectJsonObject(
      expectProperty(subjective, "character", "CharacterSubjectiveView"),
      "CharacterSubjectiveView.character",
    );
    const speaker = expectJsonObject(
      expectProperty(turn, "speaker", "DialogueTurn"),
      "DialogueTurn.speaker",
    );
    const speakerEntity = expectJsonObject(
      expectProperty(speaker, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    );
    assertEqual(
      "dialogue.turn.speaker_entity_id",
      expectString(character, "entity_id", "EntityRef"),
      expectString(speakerEntity, "entity_id", "EntityRef"),
      context.operationKind,
    );
    assertCommitmentsMatchDrafts(
      context,
      receiptInput,
      output,
      turn,
    );
  } else if (context.input.turn === undefined) {
    throw fault(
      "rule_plugin.semantic.dialogue_system_turn_missing",
      "System dialogue RulePlugin input must carry its complete turn",
      { operation_kind: context.operationKind },
    );
  }
}

function readDialogueTurnCandidate(input: JsonObject): JsonObject {
  if (input.candidate !== undefined) {
    return expectJsonObject(
      input.candidate,
      "CharacterDialogueTurnAppendInput.candidate",
    );
  }
  return expectJsonObject(
    expectProperty(input, "turn", "DialogueTurnAppendInput"),
    "DialogueTurnAppendInput.turn",
  );
}

function assertReplyMatchesTurn(
  context: EvidenceContext,
  receiptInput: JsonObject,
  reply: JsonObject,
  turn: JsonObject,
): void {
  assertEqual(
    "dialogue.turn.locale",
    expectString(
      receiptInput,
      "response_locale",
      "ModelDialogueInput",
    ),
    expectString(turn, "locale", "DialogueTurn"),
    context.operationKind,
  );
  assertEqual(
    "dialogue.turn.text",
    expectString(reply, "text", "DialogueReplyDraft"),
    expectString(turn, "text", "DialogueTurn"),
    context.operationKind,
  );
  if (reply.emotion_id !== undefined || turn.emotion_id !== undefined) {
    if (reply.emotion_id !== turn.emotion_id) {
      throw fault(
        "rule_plugin.semantic.model_evidence_reply_mismatch",
        "Dialogue turn emotion_id does not match verified model reply",
        {
          operation_kind: context.operationKind,
          field: "emotion_id",
        },
      );
    }
  }
}

function assertCommitmentsMatchDrafts(
  context: EvidenceContext,
  receiptInput: JsonObject,
  output: JsonObject,
  turn: JsonObject,
): void {
  // commitments always required on model draft ([] when none).
  const drafts = asObjectArray(
    expectProperty(output, "commitments", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.commitments",
  );
  const commitments = asObjectArray(
    expectProperty(turn, "agency_commitments", "DialogueTurn"),
    "DialogueTurn.agency_commitments",
  );
  if (drafts.length !== commitments.length) {
    throw fault(
      "rule_plugin.semantic.model_evidence_commitment_count",
      "Runtime dialogue commitments must preserve every verified commitment draft",
      {
        operation_kind: context.operationKind,
        draft_count: drafts.length,
        commitment_count: commitments.length,
      },
    );
  }
  const commitmentIds = new Set<string>();
  const dialogue = expectJsonObject(
    expectProperty(
      receiptInput,
      "dialogue",
      "CharacterDialogueInput",
    ),
    "CharacterDialogueInput.dialogue",
  );
  const participants = asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  );
  for (const [index, commitment] of commitments.entries()) {
    const commitmentId = expectString(
      commitment,
      "commitment_id",
      "MaterializedAgencyCommitmentCandidate",
    );
    if (commitmentIds.has(commitmentId)) {
      throw fault(
        "rule_plugin.semantic.model_evidence_commitment_id_duplicate",
        "Runtime-generated commitment_id values must be unique within a turn",
        {
          operation_kind: context.operationKind,
          commitment_id: commitmentId,
        },
      );
    }
    commitmentIds.add(commitmentId);
    const draft = drafts[index] as JsonObject;
    for (const field of [
      "semantic_intent",
      "stance",
      "terms",
    ] as const) {
      assertJsonFieldEqual(
        `dialogue.commitment.${index}.${field}`,
        expectProperty(
          draft,
          field,
          "AgencyCommitmentSemanticDraft",
        ),
        expectProperty(
          commitment,
          field,
          "MaterializedAgencyCommitmentCandidate",
        ),
        context.operationKind,
      );
    }
    assertJsonFieldEqual(
      `dialogue.commitment.${index}.subjects`,
      readDialogueParticipantSubjects({
        context,
        participants,
        indices: readModelIndices(
          draft,
          "subject_participant_indices",
          "AgencyCommitmentSemanticDraft",
        ),
        label: `dialogue.commitment.${index}.subjects`,
      }),
      expectProperty(
        commitment,
        "subjects",
        "MaterializedAgencyCommitmentCandidate",
      ),
      context.operationKind,
    );
    // valid_through_day is Server-owned (not in model draft); must be present on
    // the materialized candidate / committed AgencyCommitment and match.
    expectInteger(
      commitment,
      "valid_through_day",
      "MaterializedAgencyCommitmentCandidate",
    );
  }
}

function assertStimulusMatchesCandidate(
  context: EvidenceContext,
  stimulus: JsonObject,
  candidate: JsonObject,
): void {
  assertCharacterReactSituationMatchesCandidate(
    context,
    expectJsonObject(
      expectProperty(
        candidate,
        "situation",
        "MaterializedCharacterAutomaticEventCandidate",
      ),
      "MaterializedCharacterAutomaticEventCandidate.situation",
    ),
    expectJsonObject(
      expectProperty(stimulus, "situation", "CharacterReactEventInput"),
      "CharacterReactEventInput.situation",
    ),
  );
  assertCharacterReactOutcomesMatchCandidate(
    context,
    asObjectArray(
      expectProperty(
        candidate,
        "candidate_outcomes",
        "MaterializedCharacterAutomaticEventCandidate",
      ),
      "MaterializedCharacterAutomaticEventCandidate.candidate_outcomes",
    ),
    asObjectArray(
      expectProperty(
        stimulus,
        "candidate_outcomes",
        "CharacterReactEventInput",
      ),
      "CharacterReactEventInput.candidate_outcomes",
    ),
  );
  assertCharacterReactAgencyGatesMatchCandidate(
    context,
    asObjectArray(
      expectProperty(
        candidate,
        "agency_gates",
        "MaterializedCharacterAutomaticEventCandidate",
      ),
      "MaterializedCharacterAutomaticEventCandidate.agency_gates",
    ),
    asObjectArray(
      expectProperty(
        stimulus,
        "agency_gates",
        "CharacterReactEventInput",
      ),
      "CharacterReactEventInput.agency_gates",
    ),
  );
}

function requireSingleVerifiedDraft(
  context: EvidenceContext,
  owner: JsonObject,
  proofField: string,
  requestKind: string,
  draftField: string,
): {
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly draft: JsonObject;
} {
  const receipt = requireModelInvocation(
    context,
    owner,
    proofField,
    [requestKind],
  );
  const ordinal = expectInteger(
    owner,
    "draft_ordinal",
    context.operationKind,
  );
  if (ordinal !== 0) {
    throw fault(
      "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
      "A single-draft model output can only be selected with draft_ordinal 0",
      {
        operation_kind: context.operationKind,
        request_kind: requestKind,
        draft_ordinal: ordinal,
      },
    );
  }
  return Object.freeze({
    receipt,
    draft: expectJsonObject(
      expectProperty(
        modelReceiptOutput(receipt),
        draftField,
        "ModelOutput",
      ),
      `ModelOutput.${draftField}`,
    ),
  });
}

function requireVerifiedCollectionDraft(
  context: EvidenceContext,
  owner: JsonObject,
  proofField: string,
  requestKind: string,
  collectionField: string,
): {
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly draft: JsonObject;
  readonly ordinal: number;
} {
  const receipt = requireModelInvocation(
    context,
    owner,
    proofField,
    [requestKind],
  );
  const ordinal = expectInteger(
    owner,
    "draft_ordinal",
    context.operationKind,
  );
  const drafts = asObjectArray(
    expectProperty(
      modelReceiptOutput(receipt),
      collectionField,
      "ModelOutput",
    ),
    `ModelOutput.${collectionField}`,
  );
  const draft = drafts[ordinal];
  if (draft === undefined) {
    throw fault(
      "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
      "draft_ordinal is outside the referenced verified model collection",
      {
        operation_kind: context.operationKind,
        request_kind: requestKind,
        collection: collectionField,
        draft_ordinal: ordinal,
        draft_count: drafts.length,
      },
    );
  }
  return Object.freeze({ receipt, draft, ordinal });
}

function assertDefinitionCandidateMatchesDraft(
  context: EvidenceContext,
  receipt: VerifiedModelInvocationReceipt,
  rawDraft: JsonObject,
): void {
  const selectionSpace = requireModelSelectionSpace(context, receipt);
  const candidate = expectJsonObject(
    expectProperty(
      context.input,
      "candidate",
      "DefinitionValidationInput",
    ),
    "DefinitionValidationInput.candidate",
  );
  const candidateDraft = expectJsonObject(
    expectProperty(candidate, "draft", "DynamicDefinitionProposal"),
    "DynamicDefinitionProposal.draft",
  );
  const requestInput = modelReceiptInput(receipt);
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorDefinitionDraftInput",
  );
  assertLocalizedText(
    context,
    "definition.purpose",
    locale,
    expectString(
      requestInput,
      "purpose",
      "DirectorDefinitionDraftInput",
    ),
    expectProperty(candidate, "purpose", "DynamicDefinitionProposal"),
  );
  assertPlanningCatalogIndexMaterialization({
    context,
    label: "definition.definition_type",
    owner: rawDraft,
    indexField: "definition_type_index",
    selectorLabel: "DynamicDefinitionSemanticDraft",
    entries: selectionSpace.definitionTypes,
    entryLabel: "TypeDefinition",
    localIdField: "type_id",
    materialized: expectJsonObject(
      expectProperty(
        candidateDraft,
        "definition_type",
        "DynamicDefinitionDraft",
      ),
      "DynamicDefinitionDraft.definition_type",
    ),
    catalogKind: "definition_type",
  });
  for (const field of ["name", "summary"] as const) {
    assertLocalizedText(
      context,
      `definition.${field}`,
      locale,
      expectString(
        rawDraft,
        field,
        "DynamicDefinitionSemanticDraft",
      ),
      expectProperty(candidateDraft, field, "DynamicDefinitionDraft"),
    );
  }
  assertEqual(
    "definition.rationale",
    expectString(
      rawDraft,
      "rationale",
      "DynamicDefinitionSemanticDraft",
    ),
    expectString(candidateDraft, "rationale", "DynamicDefinitionDraft"),
    context.operationKind,
  );
  const rawComponents = asObjectArray(
    expectProperty(
      rawDraft,
      "components",
      "DynamicDefinitionSemanticDraft",
    ),
    "DynamicDefinitionSemanticDraft.components",
  );
  const components = asObjectArray(
    expectProperty(
      candidateDraft,
      "components",
      "DynamicDefinitionDraft",
    ),
    "DynamicDefinitionDraft.components",
  );
  assertArrayLength(
    context,
    "definition.components",
    rawComponents,
    components,
  );
  for (const [ordinal, rawComponent] of rawComponents.entries()) {
    const component = components[ordinal] as JsonObject;
    assertEqual(
      `definition.components.${ordinal}.ordinal`,
      ordinal,
      expectInteger(component, "ordinal", "ComponentValue"),
      context.operationKind,
    );
    assertPlanningCatalogIndexMaterialization({
      context,
      label: `definition.components.${ordinal}.component_type`,
      owner: rawComponent,
      indexField: "component_type_index",
      selectorLabel: "DefinitionComponentSemanticDraft",
      entries: selectionSpace.componentTypes,
      entryLabel: "TypeDefinition",
      localIdField: "type_id",
      materialized: expectJsonObject(
        expectProperty(component, "component_type", "ComponentValue"),
        "ComponentValue.component_type",
      ),
      catalogKind: "component_type",
    });
    assertJsonFieldEqual(
      `definition.components.${ordinal}.value`,
      expectProperty(
        rawComponent,
        "value",
        "DefinitionComponentSemanticDraft",
      ),
      expectProperty(component, "value", "ComponentValue"),
      context.operationKind,
    );
  }
}

function assertGoalPlanCandidateMatchesDraft(
  context: EvidenceContext,
  receipt: VerifiedModelInvocationReceipt,
  rawDraft: JsonObject,
): void {
  const selectionSpace = requireModelSelectionSpace(context, receipt);
  const candidate = expectJsonObject(
    expectProperty(context.input, "candidate", "GoalPlanValidateInput"),
    "GoalPlanValidateInput.candidate",
  );
  const candidateDraft = expectJsonObject(
    expectProperty(candidate, "draft", "GoalPlanProposal"),
    "GoalPlanProposal.draft",
  );
  const requestInput = modelReceiptInput(receipt);
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorGoalPlanInput",
  );
  const worldView = expectJsonObject(
    expectProperty(requestInput, "world_view", "DirectorGoalPlanInput"),
    "DirectorGoalPlanInput.world_view",
  );
  const knowledgeView = expectJsonObject(
    expectProperty(
      requestInput,
      "knowledge_view",
      "DirectorGoalPlanInput",
    ),
    "DirectorGoalPlanInput.knowledge_view",
  );
  assertEqual(
    "goal_plan.owner_actor_id",
    expectString(
      knowledgeView,
      "viewer_entity_id",
      "KnowledgeView",
    ),
    expectString(candidate, "owner_actor_id", "GoalPlanProposal"),
    context.operationKind,
  );
  assertLocalizedText(
    context,
    "goal_plan.goal",
    locale,
    expectString(rawDraft, "goal", "GoalPlanSemanticDraft"),
    expectProperty(candidateDraft, "goal", "GoalPlanDraft"),
  );
  for (const field of ["expected_state", "knowledge_scope"] as const) {
    assertJsonFieldEqual(
      `goal_plan.${field}`,
      expectProperty(rawDraft, field, "GoalPlanSemanticDraft"),
      expectProperty(candidateDraft, field, "GoalPlanDraft"),
      context.operationKind,
    );
  }
  const expectedFacts = asObjectArray(
    expectProperty(rawDraft, "facts", "GoalPlanSemanticDraft"),
    "GoalPlanSemanticDraft.facts",
  ).map((selector, ordinal) =>
    resolveFactSelector(
      context,
      worldView,
      knowledgeView,
      selector,
      ordinal,
    ),
  );
  assertJsonFieldEqual(
    "goal_plan.fact_refs",
    expectedFacts,
    expectProperty(candidateDraft, "fact_refs", "GoalPlanDraft"),
    context.operationKind,
  );
  assertWorldLawIndexMaterialization({
    context,
    label: "goal_plan.constraints",
    owner: rawDraft,
    indexField: "constraint_law_indices",
    selectorLabel: "GoalPlanSemanticDraft",
    laws: selectionSpace.worldLaws,
    materialized: asObjectArray(
      expectProperty(candidateDraft, "constraints", "GoalPlanDraft"),
      "GoalPlanDraft.constraints",
    ),
  });
  assertGoalPlanCandidateNodes({
    context,
    selectionSpace,
    locale,
    rawDraft,
    candidateDraft,
  });
}

function assertGoalPlanCandidateNodes(input: {
  readonly context: EvidenceContext;
  readonly selectionSpace: ModelSelectionSpace;
  readonly locale: string;
  readonly rawDraft: JsonObject;
  readonly candidateDraft: JsonObject;
}): void {
  const rawNodes = asObjectArray(
    expectProperty(
      input.rawDraft,
      "nodes",
      "GoalPlanSemanticDraft",
    ),
    "GoalPlanSemanticDraft.nodes",
  );
  const nodes = asObjectArray(
    expectProperty(input.candidateDraft, "nodes", "GoalPlanDraft"),
    "GoalPlanDraft.nodes",
  );
  assertArrayLength(input.context, "goal_plan.nodes", rawNodes, nodes);
  const demandIds = new Set<string>();
  const nodeKeys = readUniqueIdentifiers(
    input.context,
    nodes,
    "node_key",
    "GoalNodeDraft",
    "goal_plan.nodes",
  );
  for (const [ordinal, rawNode] of rawNodes.entries()) {
    const node = nodes[ordinal] as JsonObject;
    assertLocalizedText(
      input.context,
      `goal_plan.nodes.${ordinal}.title`,
      input.locale,
      expectString(rawNode, "title", "GoalNodeSemanticDraft"),
      expectProperty(node, "title", "GoalNodeDraft"),
    );
    assertJsonFieldEqual(
      `goal_plan.nodes.${ordinal}.arguments`,
      expectProperty(rawNode, "arguments", "GoalNodeSemanticDraft"),
      expectProperty(node, "arguments", "GoalNodeDraft"),
      input.context.operationKind,
    );
    for (const mapping of [
      ["depends_on", "depends_on"],
      ["alternatives", "alternative_node_keys"],
    ] as const) {
      assertJsonFieldEqual(
        `goal_plan.nodes.${ordinal}.${mapping[1]}`,
        readModelIndices(
          rawNode,
          mapping[0],
          "GoalNodeSemanticDraft",
        ).map((index) => {
          const selected = nodeKeys[index];
          if (selected === undefined) {
            throw fault(
              "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
              "Goal node selector is outside its verified node collection",
              {
                operation_kind: input.context.operationKind,
                node_ordinal: ordinal,
                field: mapping[0],
                selected_ordinal: index,
                node_count: nodeKeys.length,
              },
            );
          }
          return selected;
        }),
        expectProperty(node, mapping[1], "GoalNodeDraft"),
        input.context.operationKind,
      );
    }
    assertWorldLawIndexMaterialization({
      context: input.context,
      label: `goal_plan.nodes.${ordinal}.completion_rules`,
      owner: rawNode,
      indexField: "completion_rule_indices",
      selectorLabel: "GoalNodeSemanticDraft",
      laws: input.selectionSpace.worldLaws,
      materialized: asObjectArray(
        expectProperty(
          node,
          "completion_rules",
          "GoalNodeDraft",
        ),
        "GoalNodeDraft.completion_rules",
      ),
    });
    assertCapabilityRequirementMaterialization({
      context: input.context,
      selectionSpace: input.selectionSpace,
      locale: input.locale,
      label: `goal_plan.nodes.${ordinal}.capability_requirement`,
      selector: expectJsonObject(
        expectProperty(
          rawNode,
          "capability_requirement",
          "GoalNodeSemanticDraft",
        ),
        "GoalNodeSemanticDraft.capability_requirement",
      ),
      materialized: expectJsonObject(
        expectProperty(
          node,
          "capability_requirement",
          "GoalNodeDraft",
        ),
        "GoalNodeDraft.capability_requirement",
      ),
      demandIds,
    });
  }
}

function assertCapabilityRequirementMaterialization(input: {
  readonly context: EvidenceContext;
  readonly selectionSpace: ModelSelectionSpace;
  readonly locale: string;
  readonly label: string;
  readonly selector: JsonObject;
  readonly materialized: JsonObject;
  readonly demandIds: Set<string>;
}): void {
  const kind = expectString(
    input.selector,
    "requirement_kind",
    "CapabilityRequirementSelector",
  );
  assertEqual(
    `${input.label}.requirement_kind`,
    kind,
    expectString(
      input.materialized,
      "requirement_kind",
      "CapabilityRequirement",
    ),
    input.context.operationKind,
  );
  if (kind === "bound") {
    assertPlanningCatalogIndexMaterialization({
      context: input.context,
      label: `${input.label}.capability`,
      owner: input.selector,
      indexField: "capability_index",
      selectorLabel: "CapabilityRequirementSelector",
      entries: input.selectionSpace.capabilities,
      entryLabel: "Capability",
      localIdField: "capability_id",
      materialized: expectJsonObject(
        expectProperty(
          input.materialized,
          "capability",
          "CapabilityRequirement",
        ),
        "CapabilityRequirement.capability",
      ),
      catalogKind: "capability",
    });
    return;
  }
  if (kind !== "demand") {
    throw fault(
      "rule_plugin.semantic.goal_plan_requirement_kind",
      "Goal-plan candidate has an unknown capability requirement kind",
      {
        operation_kind: input.context.operationKind,
        requirement_kind: kind,
      },
    );
  }
  const demand = expectJsonObject(
    expectProperty(
      input.materialized,
      "demand",
      "CapabilityRequirement",
    ),
    "CapabilityRequirement.demand",
  );
  const demandId = expectString(demand, "demand_id", "CapabilityDemand");
  if (input.demandIds.has(demandId)) {
    throw fault(
      "rule_plugin.semantic.goal_plan_demand_id_duplicate",
      "Goal-plan candidate demand_id values must be unique",
      {
        operation_kind: input.context.operationKind,
        demand_id: demandId,
      },
    );
  }
  input.demandIds.add(demandId);
  assertEqual(
    `${input.label}.semantic_intent`,
    expectString(
      input.selector,
      "semantic_intent",
      "CapabilityRequirementSelector",
    ),
    expectString(demand, "semantic_intent", "CapabilityDemand"),
    input.context.operationKind,
  );
  assertLocalizedText(
    input.context,
    `${input.label}.description`,
    input.locale,
    expectString(
      input.selector,
      "description",
      "CapabilityRequirementSelector",
    ),
    expectProperty(demand, "description", "CapabilityDemand"),
  );
  const archetypeIndices = readModelIndices(
    input.selector,
    "allowed_archetype_indices",
    "CapabilityRequirementSelector",
  );
  const archetypes = asObjectArray(
    expectProperty(
      demand,
      "allowed_archetypes",
      "CapabilityDemand",
    ),
    "CapabilityDemand.allowed_archetypes",
  );
  assertArrayLength(
    input.context,
    `${input.label}.allowed_archetypes`,
    archetypeIndices,
    archetypes,
  );
  for (const [ordinal, index] of archetypeIndices.entries()) {
    assertPlanningCatalogEntryMaterialization({
      context: input.context,
      label: `${input.label}.allowed_archetypes.${ordinal}`,
      entry: requireModelSelectionEntry(
        input.context,
        input.selectionSpace.generationArchetypes,
        index,
        `${input.label}.allowed_archetype_indices`,
      ),
      entryLabel: "GenerationArchetype",
      localIdField: "archetype_id",
      materialized: archetypes[ordinal] as JsonObject,
      catalogKind: "generation_archetype",
    });
  }
  assertWorldLawIndexMaterialization({
    context: input.context,
    label: `${input.label}.constraints`,
    owner: input.selector,
    indexField: "constraint_law_indices",
    selectorLabel: "CapabilityRequirementSelector",
    laws: input.selectionSpace.worldLaws,
    materialized: asObjectArray(
      expectProperty(demand, "constraints", "CapabilityDemand"),
      "CapabilityDemand.constraints",
    ),
  });
}

interface ModelSelectionSpace {
  readonly definitionTypes: readonly JsonObject[];
  readonly componentTypes: readonly JsonObject[];
  readonly capabilities: readonly JsonObject[];
  readonly worldLaws: readonly JsonObject[];
  readonly generationArchetypes: readonly JsonObject[];
}

function requireModelSelectionSpace(
  context: EvidenceContext,
  receipt: VerifiedModelInvocationReceipt,
): ModelSelectionSpace {
  const requestLock = worldContentLock(
    expectJsonObject(
      expectProperty(
        context.request.value,
        "readonly_world",
        "RulePluginRequest",
      ),
      "RulePluginRequest.readonly_world",
    ),
    "RulePluginRequest.readonly_world",
  );
  const proofLock = worldContentLock(
    receipt.snapshot.value,
    "VerifiedModelInvocationReceipt.snapshot",
  );
  assertJsonFieldEqual(
    "model_selection.world_content_lock",
    proofLock,
    requestLock,
    context.operationKind,
  );
  const rootBundle = expectJsonObject(
    expectProperty(
      requestLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  const bundleId = expectString(rootBundle, "pack_id", "PackLock");
  const bundleDigest = expectString(
    rootBundle,
    "bundle_digest",
    "PackLock",
  );
  const registered = context.catalog.listModelSelectionCatalog({
    bundle_id: bundleId,
    bundle_digest: bundleDigest,
  });
  if (registered === undefined) {
    throw fault(
      "rule_plugin.semantic.model_selection_catalog_missing",
      "Locked ContentBundle model selection catalog is unavailable",
      {
        operation_kind: context.operationKind,
        bundle_id: bundleId,
        bundle_digest: bundleDigest,
      },
    );
  }
  const worldDefinitionId = expectString(
    requestLock,
    "world_definition_id",
    "WorldContentLock",
  );
  const forCurrentWorld = (
    entries: readonly JsonObject[],
    label: string,
  ): readonly JsonObject[] =>
    Object.freeze(
      entries.filter(
        (entry) =>
          expectString(entry, "world_id", label) === worldDefinitionId,
      ),
    );
  return Object.freeze({
    definitionTypes: Object.freeze(
      registered.definitionTypes.filter(
        (entry) =>
          expectString(entry, "type_kind", "TypeDefinition") ===
            "definition" &&
          entry.runtime_creatable === true &&
          entry.validator !== undefined,
      ),
    ),
    componentTypes: Object.freeze(
      registered.componentTypes.filter(
        (entry) =>
          expectString(entry, "type_kind", "TypeDefinition") ===
          "component",
      ),
    ),
    capabilities: forCurrentWorld(registered.capabilities, "Capability"),
    worldLaws: forCurrentWorld(registered.worldLaws, "WorldLaw"),
    generationArchetypes: forCurrentWorld(
      registered.generationArchetypes,
      "GenerationArchetype",
    ),
  });
}

function assertPlanningCatalogIndexMaterialization(input: {
  readonly context: EvidenceContext;
  readonly label: string;
  readonly owner: JsonObject;
  readonly indexField: string;
  readonly selectorLabel: string;
  readonly entries: readonly JsonObject[];
  readonly entryLabel: string;
  readonly localIdField: string;
  readonly materialized: JsonObject;
  readonly catalogKind: string;
}): void {
  const index = expectInteger(
    input.owner,
    input.indexField,
    input.selectorLabel,
  );
  assertPlanningCatalogEntryMaterialization({
    context: input.context,
    label: input.label,
    entry: requireModelSelectionEntry(
      input.context,
      input.entries,
      index,
      `${input.selectorLabel}.${input.indexField}`,
    ),
    entryLabel: input.entryLabel,
    localIdField: input.localIdField,
    materialized: input.materialized,
    catalogKind: input.catalogKind,
  });
}

function assertPlanningCatalogEntryMaterialization(input: {
  readonly context: EvidenceContext;
  readonly label: string;
  readonly entry: JsonObject;
  readonly entryLabel: string;
  readonly localIdField: string;
  readonly materialized: JsonObject;
  readonly catalogKind: string;
}): void {
  const rootBundle = requestRootBundleLock(input.context);
  const bundleId = expectString(rootBundle, "pack_id", "PackLock");
  const expected = Object.freeze({
    bundle_id: bundleId,
    bundle_digest: expectString(
      rootBundle,
      "bundle_digest",
      "PackLock",
    ),
    catalog_kind: input.catalogKind,
    local_id: expectString(
      input.entry,
      input.localIdField,
      input.entryLabel,
    ),
  });
  assertJsonFieldEqual(
    input.label,
    expected,
    input.materialized,
    input.context.operationKind,
  );
}

function assertWorldLawIndexMaterialization(input: {
  readonly context: EvidenceContext;
  readonly label: string;
  readonly owner: JsonObject;
  readonly indexField: string;
  readonly selectorLabel: string;
  readonly laws: readonly JsonObject[];
  readonly materialized: readonly JsonObject[];
}): void {
  const indices = readModelIndices(
    input.owner,
    input.indexField,
    input.selectorLabel,
  );
  assertArrayLength(
    input.context,
    input.label,
    indices,
    input.materialized,
  );
  const rootBundle = requestRootBundleLock(input.context);
  const digest = expectString(
    rootBundle,
    "bundle_digest",
    "PackLock",
  );
  const rootPackId = expectString(
    rootBundle,
    "pack_id",
    "PackLock",
  );
  for (const [ordinal, index] of indices.entries()) {
    const law = requireModelSelectionEntry(
      input.context,
      input.laws,
      index,
      `${input.selectorLabel}.${input.indexField}`,
    );
    assertJsonFieldEqual(
      `${input.label}.${ordinal}`,
      Object.freeze({
        bundle_id: rootPackId,
        bundle_digest: digest,
        rule_id: expectString(law, "law_id", "WorldLaw"),
      }),
      input.materialized[ordinal] as JsonObject,
      input.context.operationKind,
    );
  }
}

function requireModelSelectionEntry(
  context: EvidenceContext,
  entries: readonly JsonObject[],
  index: number,
  label: string,
): JsonObject {
  const entry = entries[index];
  if (entry === undefined) {
    throw fault(
      "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
      "Model selector is outside its locked selection space",
      {
        operation_kind: context.operationKind,
        field: label,
        selected_ordinal: index,
        selection_count: entries.length,
      },
    );
  }
  return entry;
}

function requestRootBundleLock(context: EvidenceContext): JsonObject {
  const snapshot = expectJsonObject(
    expectProperty(
      context.request.value,
      "readonly_world",
      "RulePluginRequest",
    ),
    "RulePluginRequest.readonly_world",
  );
  return expectJsonObject(
    expectProperty(
      worldContentLock(snapshot, "RulePluginRequest.readonly_world"),
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
}

function worldContentLock(
  snapshot: JsonObject,
  label: string,
): JsonObject {
  return expectJsonObject(
    expectProperty(snapshot, "world_content_lock", label),
    `${label}.world_content_lock`,
  );
}

function resolveFactSelector(
  context: EvidenceContext,
  worldView: JsonObject,
  knowledgeView: JsonObject,
  selector: JsonObject,
  ordinal: number,
): string {
  const source = expectString(selector, "source", "FactSelector");
  const index = expectInteger(selector, "index", "FactSelector");
  const collection =
    source === "world"
      ? asObjectArray(
          expectProperty(worldView, "facts", "DirectorWorldView"),
          "DirectorWorldView.facts",
        )
      : source === "knowledge"
        ? asObjectArray(
            expectProperty(knowledgeView, "facts", "KnowledgeView"),
            "KnowledgeView.facts",
          )
        : undefined;
  const fact = collection?.[index];
  if (fact === undefined) {
    throw fault(
      "rule_plugin.semantic.goal_plan_fact_selector",
      "Goal-plan fact selector is outside its verified fact collection",
      {
        operation_kind: context.operationKind,
        selector_ordinal: ordinal,
        source,
        index,
      },
    );
  }
  return expectString(fact, "fact_id", "FactRecord");
}

function assertAutomaticEventCandidateMatchesDraft(
  context: EvidenceContext,
  receipt: VerifiedModelInvocationReceipt,
  rawDraft: JsonObject,
  expectedScope: "world" | "character",
): void {
  const inputLabel =
    expectedScope === "world"
      ? "WorldAutomaticEventResolveInput"
      : "CharacterAutomaticEventResolveInput";
  const candidate = expectJsonObject(
    expectProperty(context.input, "candidate", inputLabel),
    `${inputLabel}.candidate`,
  );
  const candidateLabel =
    expectedScope === "world"
      ? "MaterializedWorldAutomaticEventCandidate"
      : "MaterializedCharacterAutomaticEventCandidate";
  assertEqual(
    "automatic_event.event_scope",
    expectedScope,
    expectString(rawDraft, "scope", "DailySettlementEventIntent"),
    context.operationKind,
  );
  assertEqual(
    "automatic_event.proposal_kind",
    `automatic.${expectedScope}`,
    expectString(candidate, "proposal_kind", candidateLabel),
    context.operationKind,
  );
  const requestInput = modelReceiptInput(receipt);
  const worldView = expectJsonObject(
    expectProperty(
      requestInput,
      "world_view",
      "DirectorDailySettlementInput",
    ),
    "DirectorDailySettlementInput.world_view",
  );
  const day = expectInteger(worldView, "day", "DirectorWorldView");
  assertEqual(
    "automatic_event.day",
    day,
    expectInteger(candidate, "day", candidateLabel),
    context.operationKind,
  );
  assertEqual(
    "automatic_event.current_day",
    day,
    expectInteger(
      expectJsonObject(
        expectProperty(
          requestWorldState(context),
          "day_cycle",
          "WorldState",
        ),
        "WorldState.day_cycle",
      ),
      "day",
      "DayCycleState",
    ),
    context.operationKind,
  );
  const actors = asObjectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const indexField =
    expectedScope === "world"
      ? "subject_actor_indices"
      : "target_actor_indices";
  // Match day-cycle materialize defaults:
  // world empty → all actors; character empty → machine-bearing actors only;
  // character explicit → filter to machine-bearing (same set as target_entity_ids).
  const worldState = requestWorldState(context);
  let actorIndices: readonly number[];
  if (
    !Object.prototype.hasOwnProperty.call(rawDraft, indexField) ||
    (Array.isArray(rawDraft[indexField]) &&
      (rawDraft[indexField] as unknown[]).length === 0)
  ) {
    actorIndices =
      expectedScope === "character"
        ? characterMachineActorIndicesFromWorld(worldState, actors)
        : actors.map((_, index) => index);
  } else {
    actorIndices = readModelIndices(
      rawDraft,
      indexField,
      "DailySettlementEventIntent",
    );
    if (expectedScope === "character") {
      actorIndices = actorIndices.filter((index) => {
        const actor = actors[index];
        if (actor === undefined) {
          return false;
        }
        return entityHasCharacterActionMachineInWorld(
          worldState,
          expectString(actor, "entity_id", "DirectorActorView"),
        );
      });
    }
  }
  const expectedEntityIds = actorIndices.map((index) => {
    const actor = actors[index];
    if (actor === undefined) {
      throw fault(
        "rule_plugin.semantic.daily_intent_actor_missing",
        "Daily settlement intent actor index is missing from verified world_view",
        { index, operation_kind: context.operationKind },
      );
    }
    return expectString(actor, "entity_id", "DirectorActorView");
  });
  const situation = expectJsonObject(
    expectProperty(candidate, "situation", candidateLabel),
    `${candidateLabel}.situation`,
  );
  assertEqual(
    "automatic_event.event_type",
    expectString(rawDraft, "event_type", "DailySettlementEventIntent"),
    expectString(situation, "event_type", `${candidateLabel}.situation`),
    context.operationKind,
  );
  const summary = expectJsonObject(
    expectProperty(situation, "summary", `${candidateLabel}.situation`),
    `${candidateLabel}.situation.summary`,
  );
  // LocalizedText must contain the intent summary string as one locale value.
  const summaryValues = Object.values(summary).filter(
    (value): value is string => typeof value === "string",
  );
  if (
    !summaryValues.includes(
      expectString(rawDraft, "summary", "DailySettlementEventIntent"),
    )
  ) {
    throw fault(
      "rule_plugin.semantic.daily_intent_summary_mismatch",
      "Materialized automatic event summary does not match daily settlement intent",
      { operation_kind: context.operationKind },
    );
  }
  assertJsonFieldEqual(
    "automatic_event.situation.context",
    Object.freeze({}),
    expectProperty(situation, "context", `${candidateLabel}.situation`),
    context.operationKind,
  );
  const situationSubjects = asObjectArray(
    expectProperty(situation, "subjects", `${candidateLabel}.situation`),
    `${candidateLabel}.situation.subjects`,
  );
  const situationEntityIds = situationSubjects.map((subject) =>
    expectString(
      expectJsonObject(
        expectProperty(subject, "entity", "SubjectRef"),
        "SubjectRef.entity",
      ),
      "entity_id",
      "EntityRef",
    ),
  );
  assertJsonFieldEqual(
    "automatic_event.situation.subjects",
    expectedEntityIds,
    situationEntityIds,
    context.operationKind,
  );

  const outcomes = asObjectArray(
    expectProperty(candidate, "candidate_outcomes", candidateLabel),
    `${candidateLabel}.candidate_outcomes`,
  );
  if (outcomes.length !== 1) {
    throw fault(
      "rule_plugin.semantic.daily_intent_outcome_count",
      "Daily settlement materialization must produce exactly one outcome",
      {
        operation_kind: context.operationKind,
        outcome_count: outcomes.length,
      },
    );
  }
  const outcome = outcomes[0] as JsonObject;
  assertEqual(
    "automatic_event.outcome_type",
    expectString(rawDraft, "outcome_type", "DailySettlementEventIntent"),
    expectString(outcome, "outcome_type", "MaterializedSemanticOutcomeCandidate"),
    context.operationKind,
  );
  assertJsonFieldEqual(
    "automatic_event.outcome.parameters",
    expectProperty(rawDraft, "parameters", "DailySettlementEventIntent"),
    expectProperty(outcome, "parameters", "MaterializedSemanticOutcomeCandidate"),
    context.operationKind,
  );
  const outcomeSubjects = asObjectArray(
    expectProperty(outcome, "subjects", "MaterializedSemanticOutcomeCandidate"),
    "MaterializedSemanticOutcomeCandidate.subjects",
  );
  assertJsonFieldEqual(
    "automatic_event.outcome.subjects",
    expectedEntityIds,
    outcomeSubjects.map((subject) =>
      expectString(
        expectJsonObject(
          expectProperty(subject, "entity", "SubjectRef"),
          "SubjectRef.entity",
        ),
        "entity_id",
        "EntityRef",
      ),
    ),
    context.operationKind,
  );

  if (expectedScope === "character") {
    assertJsonFieldEqual(
      "automatic_event.target_entity_ids",
      expectedEntityIds,
      expectProperty(candidate, "target_entity_ids", candidateLabel),
      context.operationKind,
    );
    // Daily settlement: Server never materializes agency gates (no dialogue
    // commitment_evidence channel). Model-authored agency is structural noise.
    const gates = asObjectArray(
      expectProperty(candidate, "agency_gates", candidateLabel),
      `${candidateLabel}.agency_gates`,
    );
    if (gates.length !== 0) {
      throw fault(
        "rule_plugin.semantic.daily_intent_agency_mismatch",
        "Daily character automatic events must materialize empty agency_gates",
        { operation_kind: context.operationKind, gate_count: gates.length },
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(outcome, "requires_agency_gate_id")
    ) {
      throw fault(
        "rule_plugin.semantic.daily_intent_agency_mismatch",
        "Daily character automatic outcomes must not require an agency gate",
        { operation_kind: context.operationKind },
      );
    }
  }
}

function assertEventCardCandidateMatchesDraft(
  context: EvidenceContext,
  receipt: VerifiedModelInvocationReceipt,
  rawDraft: JsonObject,
): void {
  const candidate = expectJsonObject(
    expectProperty(context.input, "candidate", "EventCardPublishInput"),
    "EventCardPublishInput.candidate",
  );
  const requestInput = modelReceiptInput(receipt);
  const worldView = expectJsonObject(
    expectProperty(
      requestInput,
      "world_view",
      "DirectorDialogueEventsInput",
    ),
    "DirectorDialogueEventsInput.world_view",
  );
  const actors = asObjectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const dialogue = expectJsonObject(
    expectProperty(
      requestInput,
      "dialogue",
      "DirectorDialogueEventsInput",
    ),
    "DirectorDialogueEventsInput.dialogue",
  );
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorDialogueEventsInput",
  );
  assertEqual(
    "event_card.source_dialogue_id",
    expectString(dialogue, "dialogue_id", "DialogueRecord"),
    expectString(
      candidate,
      "source_dialogue_id",
      "EventCardPublishCandidate",
    ),
    context.operationKind,
  );
  const currentDay = expectInteger(
    expectJsonObject(
      expectProperty(
        requestWorldState(context),
        "day_cycle",
        "WorldState",
      ),
      "WorldState.day_cycle",
    ),
    "day",
    "DayCycleState",
  );
  assertEqual(
    "event_card.proof_day",
    expectInteger(worldView, "day", "DirectorWorldView"),
    currentDay,
    context.operationKind,
  );
  assertEqual(
    "event_card.day",
    currentDay,
    expectInteger(candidate, "day", "EventCardPublishCandidate"),
    context.operationKind,
  );
  const situationDraft = expectJsonObject(
    expectProperty(rawDraft, "situation", "EventCardSemanticDraft"),
    "EventCardSemanticDraft.situation",
  );
  const situationActorIndices = readModelIndices(
    situationDraft,
    "subject_actor_indices",
    "EventSituationSemanticDraft",
  );
  assertEventSituationCandidateMatchesDraft({
    context,
    actors,
    raw: situationDraft,
    candidate: expectJsonObject(
      expectProperty(
        candidate,
        "situation",
        "EventCardPublishCandidate",
      ),
      "EventCardPublishCandidate.situation",
    ),
    locale,
    label: "event_card.situation",
  });
  for (const field of ["title", "summary"] as const) {
    assertLocalizedText(
      context,
      `event_card.${field}`,
      locale,
      expectString(rawDraft, field, "EventCardSemanticDraft"),
      expectProperty(candidate, field, "EventCardPublishCandidate"),
    );
  }

  const rawOptions = asObjectArray(
    expectProperty(
      rawDraft,
      "result_options",
      "EventCardSemanticDraft",
    ),
    "EventCardSemanticDraft.result_options",
  );
  const options = asObjectArray(
    expectProperty(
      candidate,
      "result_options",
      "EventCardPublishCandidate",
    ),
    "EventCardPublishCandidate.result_options",
  );
  assertArrayLength(context, "event_card.result_options", rawOptions, options);
  // Same effective gates as materialize/semantic: omit → []; zero commitments → [].
  const rawGates = effectiveEventCardAgencyGates(rawDraft, dialogue);
  const gates = asObjectArray(
    expectProperty(
      candidate,
      "agency_gates",
      "EventCardPublishCandidate",
    ),
    "EventCardPublishCandidate.agency_gates",
  );
  if (rawGates.length !== gates.length) {
    throw new EngineFault(
      "rule_plugin.semantic.event_card_agency_gate_count",
      "Materialized agency_gates count must match effective model draft (omit/zero-commitment → empty)",
      {
        operation_kind: context.operationKind,
        raw_gate_count: rawGates.length,
        candidate_gate_count: gates.length,
      },
    );
  }
  const gateIds = readUniqueIdentifiers(
    context,
    gates,
    "gate_id",
    "MaterializedAgencyGateCandidate",
    "event_card.agency_gates",
  );
  const rawOutcomes = rawOptions.flatMap((option) =>
    asObjectArray(
      expectProperty(
        option,
        "outcomes",
        "EventCardOutcomeSemanticDraft",
      ),
      "EventCardOutcomeSemanticDraft.outcomes",
    ),
  );
  const outcomeCandidates = options.flatMap((option) =>
    asObjectArray(
      expectProperty(
        option,
        "outcomes",
        "MaterializedEventCardOutcomeCandidate",
      ),
      "MaterializedEventCardOutcomeCandidate.outcomes",
    ),
  );
  // Same Server closure as model-output-semantic-gate + materialize.
  const subjectClosed = withEffectiveOutcomeSubjects(
    rawOutcomes,
    situationActorIndices,
    actors.length,
  );
  const { outcomes: closedOutcomes } = closeAgencyGateOutcomeLinks(
    subjectClosed,
    rawGates,
  );
  const outcomeIds = assertSemanticOutcomeCandidates({
    context,
    actors,
    allowedActorIndices: new Set(situationActorIndices),
    rawOutcomes: closedOutcomes,
    candidates: outcomeCandidates,
    gateIds,
    label: "event_card.result_options.outcomes",
  });
  const presentationIds = new Set<string>();
  readUniqueIdentifiers(
    context,
    options,
    "option_id",
    "MaterializedEventCardOutcomeCandidate",
    "event_card.result_options",
  );
  for (const [ordinal, rawOption] of rawOptions.entries()) {
    const option = options[ordinal] as JsonObject;
    assertEventCardPresentationMatchesDraft({
      context,
      dialogue,
      locale,
      raw: expectJsonObject(
        expectProperty(
          rawOption,
          "presentation",
          "EventCardOutcomeSemanticDraft",
        ),
        "EventCardOutcomeSemanticDraft.presentation",
      ),
      candidate: expectJsonObject(
        expectProperty(
          option,
          "presentation",
          "MaterializedEventCardOutcomeCandidate",
        ),
        "MaterializedEventCardOutcomeCandidate.presentation",
      ),
      presentationIds,
      label: `event_card.result_options.${ordinal}.presentation`,
    });
  }
  // Evidence is Server-assembled from dialogue for every gate (not model draft).
  const serverEvidenceSelectors = listDialogueCommitmentSelectors(dialogue);
  assertAgencyGateCandidates({
    context,
    actors,
    allowedActorIndices: new Set(situationActorIndices),
    rawGates,
    candidates: gates,
    outcomeIds,
    commitmentEvidence: () =>
      materializeCommitmentEvidenceRefs(
        context,
        dialogue,
        serverEvidenceSelectors,
      ),
    label: "event_card.agency_gates",
  });
}

function assertEventSituationCandidateMatchesDraft(input: {
  readonly context: EvidenceContext;
  readonly actors: readonly JsonObject[];
  readonly raw: JsonObject;
  readonly candidate: JsonObject;
  readonly locale: string | undefined;
  readonly label: string;
}): readonly JsonObject[] {
  assertJsonFieldEqual(
    `${input.label}.event_type`,
    expectProperty(input.raw, "event_type", "EventSituationSemanticDraft"),
    expectProperty(
      input.candidate,
      "event_type",
      "MaterializedEventSituationCandidate",
    ),
    input.context.operationKind,
  );
  // situation.context is Server-owned empty {}; model may omit. Compare only
  // the materialized empty bag to the candidate (never require model context).
  const candidateContext = expectJsonObject(
    expectProperty(
      input.candidate,
      "context",
      "MaterializedEventSituationCandidate",
    ),
    "MaterializedEventSituationCandidate.context",
  );
  if (Object.keys(candidateContext).length > 0) {
    throw new EngineFault(
      "rule_plugin.semantic.event_situation_context_not_empty",
      "Materialized EventSituation.context must be the Server empty object",
      {
        operation_kind: input.context.operationKind,
        path: `${input.label}.context`,
        key_count: Object.keys(candidateContext).length,
      },
    );
  }
  if (Object.prototype.hasOwnProperty.call(input.raw, "context")) {
    const rawContext = expectJsonObject(
      expectProperty(input.raw, "context", "EventSituationSemanticDraft"),
      "EventSituationSemanticDraft.context",
    );
    if (Object.keys(rawContext).length > 0) {
      throw new EngineFault(
        "rule_plugin.semantic.event_situation_context_model_authored",
        "Model EventSituation.context must be omitted or empty; Server materializes {}",
        {
          operation_kind: input.context.operationKind,
          path: `${input.label}.context`,
          key_count: Object.keys(rawContext).length,
        },
      );
    }
  }
  const summary = expectString(
    input.raw,
    "summary",
    "EventSituationSemanticDraft",
  );
  const localizedSummary = expectProperty(
    input.candidate,
    "summary",
    "MaterializedEventSituationCandidate",
  );
  if (input.locale === undefined) {
    assertSingleLocalizedTextValue(
      input.context,
      `${input.label}.summary`,
      summary,
      localizedSummary,
    );
  } else {
    assertLocalizedText(
      input.context,
      `${input.label}.summary`,
      input.locale,
      summary,
      localizedSummary,
    );
  }
  const subjects = readActorSubjects(
    input.context,
    input.actors,
    readModelIndices(
      input.raw,
      "subject_actor_indices",
      "EventSituationSemanticDraft",
    ),
    `${input.label}.subjects`,
  );
  assertJsonFieldEqual(
    `${input.label}.subjects`,
    subjects,
    expectProperty(
      input.candidate,
      "subjects",
      "MaterializedEventSituationCandidate",
    ),
    input.context.operationKind,
  );
  return subjects;
}

function assertSemanticOutcomeCandidates(input: {
  readonly context: EvidenceContext;
  readonly actors: readonly JsonObject[];
  readonly allowedActorIndices: ReadonlySet<number>;
  readonly rawOutcomes: readonly JsonObject[];
  readonly candidates: readonly JsonObject[];
  readonly gateIds: readonly string[];
  readonly label: string;
}): readonly string[] {
  assertArrayLength(
    input.context,
    input.label,
    input.rawOutcomes,
    input.candidates,
  );
  const outcomeIds = readUniqueIdentifiers(
    input.context,
    input.candidates,
    "outcome_id",
    "MaterializedSemanticOutcomeCandidate",
    input.label,
  );
  for (const [ordinal, raw] of input.rawOutcomes.entries()) {
    const candidate = input.candidates[ordinal] as JsonObject;
    for (const field of ["outcome_type", "parameters"] as const) {
      assertJsonFieldEqual(
        `${input.label}.${ordinal}.${field}`,
        expectProperty(raw, field, "SemanticOutcomeDraft"),
        expectProperty(
          candidate,
          field,
          "MaterializedSemanticOutcomeCandidate",
        ),
        input.context.operationKind,
      );
    }
    const subjectIndices = readModelIndices(
      raw,
      "subject_indices",
      "SemanticOutcomeDraft",
    );
    assertActorIndicesAllowed(
      input.context,
      subjectIndices,
      input.allowedActorIndices,
      `${input.label}.${ordinal}.subjects`,
    );
    assertJsonFieldEqual(
      `${input.label}.${ordinal}.subjects`,
      readActorSubjects(
        input.context,
        input.actors,
        subjectIndices,
        `${input.label}.${ordinal}.subjects`,
      ),
      expectProperty(
        candidate,
        "subjects",
        "MaterializedSemanticOutcomeCandidate",
      ),
      input.context.operationKind,
    );
    const gateIndex = raw.requires_agency_gate_index;
    const expectedGateId =
      gateIndex === undefined
        ? undefined
        : input.gateIds[
            requireModelIndex(
              input.context,
              gateIndex,
              input.gateIds.length,
              `${input.label}.${ordinal}.requires_agency_gate_index`,
            )
          ];
    const actualGateId = candidate.requires_agency_gate_id;
    if (expectedGateId !== actualGateId) {
      throw fault(
        "rule_plugin.semantic.model_candidate_mismatch",
        "Materialized outcome agency-gate link differs from its verified selector",
        {
          operation_kind: input.context.operationKind,
          field: `${input.label}.${ordinal}.requires_agency_gate_id`,
          expected: expectedGateId ?? "",
          actual:
            typeof actualGateId === "string" ? actualGateId : "",
        },
      );
    }
  }
  return Object.freeze(outcomeIds);
}

function assertAgencyGateCandidates(input: {
  readonly context: EvidenceContext;
  readonly actors: readonly JsonObject[];
  readonly allowedActorIndices: ReadonlySet<number>;
  readonly rawGates: readonly JsonObject[];
  readonly candidates: readonly JsonObject[];
  readonly outcomeIds: readonly string[];
  readonly commitmentEvidence: (
    rawGate: JsonObject,
  ) => readonly JsonObject[];
  readonly label: string;
}): void {
  assertArrayLength(
    input.context,
    input.label,
    input.rawGates,
    input.candidates,
  );
  for (const [ordinal, raw] of input.rawGates.entries()) {
    const candidate = input.candidates[ordinal] as JsonObject;
    assertJsonFieldEqual(
      `${input.label}.${ordinal}.protected_outcome_ids`,
      readModelIndices(
        raw,
        "protected_outcome_indices",
        "AgencyGateSemanticDraft",
      ).map((index) => {
        const outcomeId = input.outcomeIds[index];
        if (outcomeId === undefined) {
          throw fault(
            "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
            "Agency gate protects an outcome ordinal outside its draft",
            {
              operation_kind: input.context.operationKind,
              gate_ordinal: ordinal,
              outcome_ordinal: index,
            },
          );
        }
        return outcomeId;
      }),
      expectProperty(
        candidate,
        "protected_outcome_ids",
        "MaterializedAgencyGateCandidate",
      ),
      input.context.operationKind,
    );
    const participantIndices = readModelIndices(
      raw,
      "participant_subject_indices",
      "AgencyGateSemanticDraft",
    );
    assertActorIndicesAllowed(
      input.context,
      participantIndices,
      input.allowedActorIndices,
      `${input.label}.${ordinal}.participants`,
    );
    const participantSubjects = readActorSubjects(
      input.context,
      input.actors,
      participantIndices,
      `${input.label}.${ordinal}.participants`,
    );
    assertJsonFieldEqual(
      `${input.label}.${ordinal}.participants`,
      participantSubjects.map((subject) =>
        expectJsonObject(
          expectProperty(subject, "entity", "SubjectRef"),
          "SubjectRef.entity",
        ),
      ),
      expectProperty(
        candidate,
        "participants",
        "MaterializedAgencyGateCandidate",
      ),
      input.context.operationKind,
    );
    const rawRequirement = expectJsonObject(
      expectProperty(raw, "requirement", "AgencyGateSemanticDraft"),
      "AgencyGateSemanticDraft.requirement",
    );
    const requirement = expectJsonObject(
      expectProperty(
        candidate,
        "requirement",
        "MaterializedAgencyGateCandidate",
      ),
      "MaterializedAgencyGateCandidate.requirement",
    );
    for (const field of ["semantic_intent", "terms"] as const) {
      assertJsonFieldEqual(
        `${input.label}.${ordinal}.requirement.${field}`,
        expectProperty(
          rawRequirement,
          field,
          "AgencyRequirementSemanticDraft",
        ),
        expectProperty(requirement, field, "AgencyRequirement"),
        input.context.operationKind,
      );
    }
    const requirementIndices = readModelIndices(
      rawRequirement,
      "subject_indices",
      "AgencyRequirementSemanticDraft",
    );
    assertActorIndicesAllowed(
      input.context,
      requirementIndices,
      input.allowedActorIndices,
      `${input.label}.${ordinal}.requirement.subjects`,
    );
    assertJsonFieldEqual(
      `${input.label}.${ordinal}.requirement.subjects`,
      readActorSubjects(
        input.context,
        input.actors,
        requirementIndices,
        `${input.label}.${ordinal}.requirement.subjects`,
      ),
      expectProperty(requirement, "subjects", "AgencyRequirement"),
      input.context.operationKind,
    );
    for (const field of ["policy", "commitment_evidence"] as const) {
      const expected =
        field === "policy"
          ? expectProperty(raw, "policy", "AgencyGateSemanticDraft")
          : input.commitmentEvidence(raw);
      assertJsonFieldEqual(
        `${input.label}.${ordinal}.${field}`,
        expected,
        expectProperty(
          candidate,
          field,
          "MaterializedAgencyGateCandidate",
        ),
        input.context.operationKind,
      );
    }
  }
}

function assertEventCardPresentationMatchesDraft(input: {
  readonly context: EvidenceContext;
  readonly dialogue: JsonObject;
  readonly locale: string;
  readonly raw: JsonObject;
  readonly candidate: JsonObject;
  readonly presentationIds: Set<string>;
  readonly label: string;
}): void {
  const presentationId = expectString(
    input.candidate,
    "presentation_id",
    "EventResultPresentation",
  );
  if (input.presentationIds.has(presentationId)) {
    throw fault(
      "rule_plugin.semantic.event_card_presentation_id_duplicate",
      "Materialized EventCard presentation_id values must be unique",
      {
        operation_kind: input.context.operationKind,
        presentation_id: presentationId,
      },
    );
  }
  input.presentationIds.add(presentationId);
  const rawSegments = asObjectArray(
    expectProperty(
      input.raw,
      "segments",
      "EventResultPresentationSemanticDraft",
    ),
    "EventResultPresentationSemanticDraft.segments",
  );
  const segments = asObjectArray(
    expectProperty(
      input.candidate,
      "segments",
      "EventResultPresentation",
    ),
    "EventResultPresentation.segments",
  );
  assertArrayLength(
    input.context,
    `${input.label}.segments`,
    rawSegments,
    segments,
  );
  const turns = asObjectArray(
    expectProperty(input.dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const dialogueId = expectString(
    input.dialogue,
    "dialogue_id",
    "DialogueRecord",
  );
  for (const [ordinal, rawSegment] of rawSegments.entries()) {
    const segment = segments[ordinal] as JsonObject;
    const kind = expectString(
      rawSegment,
      "segment_kind",
      "NarrativeSegmentSemanticDraft",
    );
    assertEqual(
      `${input.label}.segments.${ordinal}.segment_kind`,
      kind,
      expectString(segment, "segment_kind", "NarrativeSegment"),
      input.context.operationKind,
    );
    if (kind === "dialogue_quote") {
      const turnIndex = expectInteger(
        rawSegment,
        "turn_index",
        "DialogueTurnQuoteSelector",
      );
      const turn = turns[turnIndex];
      if (turn === undefined) {
        throw fault(
          "rule_plugin.semantic.event_card_quote_selector",
          "EventCard dialogue quote selector is outside the verified dialogue",
          {
            operation_kind: input.context.operationKind,
            segment_ordinal: ordinal,
            turn_index: turnIndex,
          },
        );
      }
      assertEqual(
        `${input.label}.segments.${ordinal}.dialogue_id`,
        dialogueId,
        expectString(segment, "dialogue_id", "DialogueTurnQuoteSegment"),
        input.context.operationKind,
      );
      assertEqual(
        `${input.label}.segments.${ordinal}.turn_id`,
        expectString(turn, "turn_id", "DialogueTurn"),
        expectString(segment, "turn_id", "DialogueTurnQuoteSegment"),
        input.context.operationKind,
      );
      continue;
    }
    assertLocalizedText(
      input.context,
      `${input.label}.segments.${ordinal}.text`,
      input.locale,
      expectString(
        rawSegment,
        "text",
        "GeneratedNarrativeSegmentSemanticDraft",
      ),
      expectProperty(segment, "text", "GeneratedNarrativeSegment"),
    );
  }
}

function materializeCommitmentEvidenceRefs(
  context: EvidenceContext,
  dialogue: JsonObject,
  selectors: readonly JsonObject[],
): readonly JsonObject[] {
  const turns = asObjectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const dialogueId = expectString(dialogue, "dialogue_id", "DialogueRecord");
  return Object.freeze(
    selectors.map((selector, ordinal) => {
      const turnIndex = expectInteger(
        selector,
        "turn_index",
        "DialogueCommitmentSelector",
      );
      const commitmentIndex = expectInteger(
        selector,
        "commitment_index",
        "DialogueCommitmentSelector",
      );
      const turn = turns[turnIndex];
      const commitment =
        turn === undefined
          ? undefined
          : asObjectArray(
              expectProperty(
                turn,
                "agency_commitments",
                "DialogueTurn",
              ),
              "DialogueTurn.agency_commitments",
            )[commitmentIndex];
      if (turn === undefined || commitment === undefined) {
        throw fault(
          "rule_plugin.semantic.event_card_commitment_selector",
          "EventCard commitment selector is outside the verified dialogue",
          {
            operation_kind: context.operationKind,
            selector_ordinal: ordinal,
            turn_index: turnIndex,
            commitment_index: commitmentIndex,
          },
        );
      }
      return Object.freeze({
        dialogue_id: dialogueId,
        turn_id: expectString(turn, "turn_id", "DialogueTurn"),
        commitment_id: expectString(
          commitment,
          "commitment_id",
          "AgencyCommitment",
        ),
      });
    }),
  );
}

function assertCharacterReactionCandidateMatchesDraft(input: {
  readonly context: EvidenceContext;
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly rawDraft: JsonObject;
  readonly stimulus: JsonObject;
  readonly proposalId: string;
  readonly candidate: JsonObject;
}): void {
  assertEqual(
    "character_reaction.impact",
    expectString(
      input.rawDraft,
      "impact",
      "CharacterReactionSemanticDraft",
    ),
    expectString(
      input.candidate,
      "impact",
      "MaterializedCharacterReactionCandidate",
    ),
    input.context.operationKind,
  );
  assertJsonFieldEqual(
    "character_reaction.source_event",
    Object.freeze({
      source_kind: "automatic",
      proposal_id: input.proposalId,
    }),
    expectProperty(
      input.candidate,
      "source_event",
      "MaterializedCharacterReactionCandidate",
    ),
    input.context.operationKind,
  );
  const stimulusGates = asObjectArray(
    expectProperty(
      input.stimulus,
      "agency_gates",
      "CharacterReactEventInput",
    ),
    "CharacterReactEventInput.agency_gates",
  );
  // agency_decisions optional on draft; omit → [].
  const rawDecisionsAll = Object.prototype.hasOwnProperty.call(
    input.rawDraft,
    "agency_decisions",
  )
    ? asObjectArray(
        expectProperty(
          input.rawDraft,
          "agency_decisions",
          "CharacterReactionSemanticDraft",
        ),
        "CharacterReactionSemanticDraft.agency_decisions",
      )
    : [];
  // Align with materialize: no stimulus gates → ignore model decision noise.
  const rawDecisions =
    stimulusGates.length === 0 ? [] : rawDecisionsAll;
  const decisions = asObjectArray(
    expectProperty(
      input.candidate,
      "agency_decisions",
      "MaterializedCharacterReactionCandidate",
    ),
    "MaterializedCharacterReactionCandidate.agency_decisions",
  );
  assertArrayLength(
    input.context,
    "character_reaction.agency_decisions",
    rawDecisions,
    decisions,
  );
  for (const [ordinal, rawDecision] of rawDecisions.entries()) {
    const decision = decisions[ordinal] as JsonObject;
    const gateIndex = expectInteger(
      rawDecision,
      "gate_index",
      "AgencyDecisionSemanticDraft",
    );
    const gate = stimulusGates[gateIndex];
    if (gate === undefined) {
      throw fault(
        "rule_plugin.semantic.character_reaction_gate_selector",
        "Character reaction gate selector is outside the verified stimulus",
        {
          operation_kind: input.context.operationKind,
          decision_ordinal: ordinal,
          gate_index: gateIndex,
        },
      );
    }
    assertEqual(
      `character_reaction.agency_decisions.${ordinal}.gate_id`,
      expectString(gate, "gate_id", "CharacterReactAgencyGateInput"),
      expectString(decision, "gate_id", "AgencyDecision"),
      input.context.operationKind,
    );
    for (const field of ["stance", "terms"] as const) {
      assertJsonFieldEqual(
        `character_reaction.agency_decisions.${ordinal}.${field}`,
        expectProperty(
          rawDecision,
          field,
          "AgencyDecisionSemanticDraft",
        ),
        expectProperty(decision, field, "AgencyDecision"),
        input.context.operationKind,
      );
    }
  }
  const rawOutcomes = asObjectArray(
    expectProperty(
      input.rawDraft,
      "self_outcomes",
      "CharacterReactionSemanticDraft",
    ),
    "CharacterReactionSemanticDraft.self_outcomes",
  );
  const outcomes = asObjectArray(
    expectProperty(
      input.candidate,
      "self_outcomes",
      "MaterializedCharacterReactionCandidate",
    ),
    "MaterializedCharacterReactionCandidate.self_outcomes",
  );
  assertArrayLength(
    input.context,
    "character_reaction.self_outcomes",
    rawOutcomes,
    outcomes,
  );
  readUniqueIdentifiers(
    input.context,
    outcomes,
    "outcome_id",
    "MaterializedSelfSubjectiveOutcomeCandidate",
    "character_reaction.self_outcomes",
  );
  for (const [ordinal, rawOutcome] of rawOutcomes.entries()) {
    const outcome = outcomes[ordinal] as JsonObject;
    for (const field of ["outcome_type", "parameters"] as const) {
      assertJsonFieldEqual(
        `character_reaction.self_outcomes.${ordinal}.${field}`,
        expectProperty(
          rawOutcome,
          field,
          "SelfSubjectiveOutcomeSemanticDraft",
        ),
        expectProperty(
          outcome,
          field,
          "MaterializedSelfSubjectiveOutcomeCandidate",
        ),
        input.context.operationKind,
      );
    }
  }
  assertMachineDecisionMaterialization(input);
}

function assertMachineDecisionMaterialization(input: {
  readonly context: EvidenceContext;
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly rawDraft: JsonObject;
  readonly candidate: JsonObject;
}): void {
  const rawDecision = expectJsonObject(
    expectProperty(
      input.rawDraft,
      "machine_decision",
      "CharacterReactionSemanticDraft",
    ),
    "CharacterReactionSemanticDraft.machine_decision",
  );
  const decision = expectJsonObject(
    expectProperty(
      input.candidate,
      "machine_decision",
      "MaterializedCharacterReactionCandidate",
    ),
    "MaterializedCharacterReactionCandidate.machine_decision",
  );
  const kind = expectString(
    rawDecision,
    "decision_kind",
    "MachineDecisionSelector",
  );
  assertEqual(
    "character_reaction.machine_decision.decision_kind",
    kind,
    expectString(decision, "decision_kind", "MachineDecision"),
    input.context.operationKind,
  );
  if (kind === "keep") {
    return;
  }
  const subjective = expectJsonObject(
    expectProperty(
      modelReceiptInput(input.receipt),
      "subjective_view",
      "CharacterReactInput",
    ),
    "CharacterReactInput.subjective_view",
  );
  const actionMachine = expectJsonObject(
    expectProperty(
      subjective,
      "action_machine",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.action_machine",
  );
  const transitions = asObjectArray(
    expectProperty(
      actionMachine,
      "outgoing_transitions",
      "StateMachineModelView",
    ),
    "StateMachineModelView.outgoing_transitions",
  );
  const transitionIndex = expectInteger(
    rawDecision,
    "transition_index",
    "MachineDecisionSelector",
  );
  const selected = transitions[transitionIndex];
  if (selected === undefined) {
    throw fault(
      "rule_plugin.semantic.character_reaction_transition_selector",
      "Character reaction transition selector is outside the verified action machine",
      {
        operation_kind: input.context.operationKind,
        transition_index: transitionIndex,
      },
    );
  }
  const transition = expectJsonObject(
    expectProperty(
      selected,
      "transition",
      "StateMachineTransitionModelView",
    ),
    "StateMachineTransitionModelView.transition",
  );
  assertEqual(
    "character_reaction.machine_decision.transition_id",
    expectString(
      transition,
      "transition_id",
      "MachineTransitionDefinition",
    ),
    expectString(decision, "transition_id", "MachineDecision"),
    input.context.operationKind,
  );
}

function assertCharacterTurnProposalMatchesCandidate(
  context: OperationContext,
  candidate: JsonObject,
  committed: JsonObject,
): void {
  for (const field of [
    "turn_id",
    "speaker",
    "locale",
    "text",
    "occurred_at",
    "source",
  ] as const) {
    assertJsonFieldEqual(
      `dialogue.append.character.${field}`,
      expectProperty(
        candidate,
        field,
        "CharacterDialogueTurnCandidate",
      ),
      expectProperty(committed, field, "DialogueTurn"),
      context.operationKind,
    );
  }
  if (
    candidate.emotion_id !== undefined ||
    committed.emotion_id !== undefined
  ) {
    assertJsonFieldEqual(
      "dialogue.append.character.emotion_id",
      candidate.emotion_id ?? null,
      committed.emotion_id ?? null,
      context.operationKind,
    );
  }
  const candidates = asObjectArray(
    expectProperty(
      candidate,
      "agency_commitments",
      "CharacterDialogueTurnCandidate",
    ),
    "CharacterDialogueTurnCandidate.agency_commitments",
  );
  const commitments = asObjectArray(
    expectProperty(
      committed,
      "agency_commitments",
      "DialogueTurn",
    ),
    "DialogueTurn.agency_commitments",
  );
  assertArrayLength(context, "dialogue.append.character.commitments", candidates, commitments);
  for (const [ordinal, commitmentCandidate] of candidates.entries()) {
    const commitment = commitments[ordinal] as JsonObject;
    for (const field of [
      "commitment_id",
      "semantic_intent",
      "subjects",
      "stance",
      "terms",
      "valid_through_day",
    ] as const) {
      assertJsonFieldEqual(
        `dialogue.append.character.commitments.${ordinal}.${field}`,
        expectProperty(
          commitmentCandidate,
          field,
          "MaterializedAgencyCommitmentCandidate",
        ),
        expectProperty(commitment, field, "AgencyCommitment"),
        context.operationKind,
      );
    }
  }
}

function assertCharacterReactSituationMatchesCandidate(
  context: EvidenceContext,
  candidate: JsonObject,
  reactionInput: JsonObject,
): void {
  for (const field of ["event_type", "summary", "context"] as const) {
    assertJsonFieldEqual(
      `character_react_event.situation.${field}`,
      expectProperty(
        candidate,
        field,
        "MaterializedEventSituationCandidate",
      ),
      expectProperty(reactionInput, field, "CharacterReactSituationInput"),
      context.operationKind,
    );
  }
  assertJsonFieldEqual(
    "character_react_event.situation.subject_entity_ids",
    characterReactSubjectEntityIds(
      context,
      asObjectArray(
        expectProperty(
          candidate,
          "subjects",
          "MaterializedEventSituationCandidate",
        ),
        "MaterializedEventSituationCandidate.subjects",
      ),
      "character_react_event.situation.subject_entity_ids",
    ),
    expectProperty(
      reactionInput,
      "subject_entity_ids",
      "CharacterReactSituationInput",
    ),
    context.operationKind,
  );
}

function assertCharacterReactOutcomesMatchCandidate(
  context: EvidenceContext,
  candidates: readonly JsonObject[],
  reactionInputs: readonly JsonObject[],
): void {
  assertArrayLength(
    context,
    "character_react_event.candidate_outcomes",
    candidates,
    reactionInputs,
  );
  for (const [ordinal, candidate] of candidates.entries()) {
    const reactionInput = reactionInputs[ordinal] as JsonObject;
    for (const field of [
      "outcome_id",
      "outcome_type",
      "parameters",
    ] as const) {
      assertJsonFieldEqual(
        `character_react_event.candidate_outcomes.${ordinal}.${field}`,
        expectProperty(
          candidate,
          field,
          "MaterializedSemanticOutcomeCandidate",
        ),
        expectProperty(
          reactionInput,
          field,
          "CharacterReactOutcomeInput",
        ),
        context.operationKind,
      );
    }
    assertJsonFieldEqual(
      `character_react_event.candidate_outcomes.${ordinal}.subject_entity_ids`,
      characterReactSubjectEntityIds(
        context,
        asObjectArray(
          expectProperty(
            candidate,
            "subjects",
            "MaterializedSemanticOutcomeCandidate",
          ),
          "MaterializedSemanticOutcomeCandidate.subjects",
        ),
        `character_react_event.candidate_outcomes.${ordinal}.subject_entity_ids`,
      ),
      expectProperty(
        reactionInput,
        "subject_entity_ids",
        "CharacterReactOutcomeInput",
      ),
      context.operationKind,
    );
    if (
      candidate.requires_agency_gate_id !== undefined ||
      reactionInput.requires_agency_gate_id !== undefined
    ) {
      assertJsonFieldEqual(
        `character_react_event.candidate_outcomes.${ordinal}.requires_agency_gate_id`,
        candidate.requires_agency_gate_id ?? null,
        reactionInput.requires_agency_gate_id ?? null,
        context.operationKind,
      );
    }
  }
}

function assertCharacterReactAgencyGatesMatchCandidate(
  context: EvidenceContext,
  candidates: readonly JsonObject[],
  reactionInputs: readonly JsonObject[],
): void {
  assertArrayLength(
    context,
    "character_react_event.agency_gates",
    candidates,
    reactionInputs,
  );
  for (const [ordinal, candidate] of candidates.entries()) {
    const reactionInput = reactionInputs[ordinal] as JsonObject;
    for (const field of [
      "gate_id",
      "protected_outcome_ids",
      "policy",
    ] as const) {
      assertJsonFieldEqual(
        `character_react_event.agency_gates.${ordinal}.${field}`,
        expectProperty(
          candidate,
          field,
          "MaterializedAgencyGateCandidate",
        ),
        expectProperty(
          reactionInput,
          field,
          "CharacterReactAgencyGateInput",
        ),
        context.operationKind,
      );
    }
    assertJsonFieldEqual(
      `character_react_event.agency_gates.${ordinal}.participant_entity_ids`,
      asObjectArray(
        expectProperty(
          candidate,
          "participants",
          "MaterializedAgencyGateCandidate",
        ),
        "MaterializedAgencyGateCandidate.participants",
      ).map((participant) =>
        expectString(participant, "entity_id", "EntityRef"),
      ),
      expectProperty(
        reactionInput,
        "participant_entity_ids",
        "CharacterReactAgencyGateInput",
      ),
      context.operationKind,
    );

    const candidateRequirement = expectJsonObject(
      expectProperty(
        candidate,
        "requirement",
        "MaterializedAgencyGateCandidate",
      ),
      "MaterializedAgencyGateCandidate.requirement",
    );
    const reactionRequirement = expectJsonObject(
      expectProperty(
        reactionInput,
        "requirement",
        "CharacterReactAgencyGateInput",
      ),
      "CharacterReactAgencyGateInput.requirement",
    );
    for (const field of ["semantic_intent", "terms"] as const) {
      assertJsonFieldEqual(
        `character_react_event.agency_gates.${ordinal}.requirement.${field}`,
        expectProperty(candidateRequirement, field, "AgencyRequirement"),
        expectProperty(
          reactionRequirement,
          field,
          "CharacterReactRequirementInput",
        ),
        context.operationKind,
      );
    }
    assertJsonFieldEqual(
      `character_react_event.agency_gates.${ordinal}.requirement.subject_entity_ids`,
      characterReactSubjectEntityIds(
        context,
        asObjectArray(
          expectProperty(
            candidateRequirement,
            "subjects",
            "AgencyRequirement",
          ),
          "AgencyRequirement.subjects",
        ),
        `character_react_event.agency_gates.${ordinal}.requirement.subject_entity_ids`,
      ),
      expectProperty(
        reactionRequirement,
        "subject_entity_ids",
        "CharacterReactRequirementInput",
      ),
      context.operationKind,
    );
  }
}

function characterReactSubjectEntityIds(
  context: EvidenceContext,
  subjects: readonly JsonObject[],
  label: string,
): readonly string[] {
  return Object.freeze(
    subjects.map((subject, ordinal) => {
      if (expectString(subject, "kind", "SubjectRef") !== "entity") {
        throw fault(
          "rule_plugin.semantic.character_react_subject_kind",
          "CharacterReact projection can contain only entity subjects",
          {
            operation_kind: context.operationKind,
            field: label,
            subject_ordinal: ordinal,
          },
        );
      }
      return expectString(
        expectJsonObject(
          expectProperty(subject, "entity", "SubjectRef"),
          "SubjectRef.entity",
        ),
        "entity_id",
        "EntityRef",
      );
    }),
  );
}

function requestWorldState(context: EvidenceContext): JsonObject {
  const snapshot = expectJsonObject(
    expectProperty(
      context.request.value,
      "readonly_world",
      "RulePluginRequest",
    ),
    "RulePluginRequest.readonly_world",
  );
  return expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
}

function entityHasCharacterActionMachineInWorld(
  worldState: JsonObject,
  entityId: string,
): boolean {
  const machines = asObjectArray(
    expectProperty(worldState, "state_machines", "WorldState"),
    "WorldState.state_machines",
  );
  let matches = 0;
  for (const machine of machines) {
    const owner = expectJsonObject(
      expectProperty(machine, "owner", "StateMachineInstanceState"),
      "StateMachineInstanceState.owner",
    );
    if (
      expectString(owner, "owner_kind", "StateMachineOwner") === "character" &&
      expectString(owner, "entity_id", "StateMachineOwner") === entityId
    ) {
      matches += 1;
    }
  }
  return matches === 1;
}

function characterMachineActorIndicesFromWorld(
  worldState: JsonObject,
  actors: readonly JsonObject[],
): number[] {
  const indices: number[] = [];
  for (const [index, actor] of actors.entries()) {
    if (
      entityHasCharacterActionMachineInWorld(
        worldState,
        expectString(actor, "entity_id", "DirectorActorView"),
      )
    ) {
      indices.push(index);
    }
  }
  return indices;
}

function readActorSubjects(
  context: EvidenceContext,
  actors: readonly JsonObject[],
  indices: readonly number[],
  label: string,
): readonly JsonObject[] {
  const world = requestWorldState(context);
  return Object.freeze(
    indices.map((index) => {
      const actor = actors[index];
      if (actor === undefined) {
        throw fault(
          "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
          "Actor selector is outside its verified world-view actor collection",
          {
            operation_kind: context.operationKind,
            field: label,
            actor_index: index,
            actor_count: actors.length,
          },
        );
      }
      const entityId = expectString(
        actor,
        "entity_id",
        "DirectorActorView",
      );
      const entity = findEntity(world, entityId);
      if (entity === undefined) {
        throw fault(
          "rule_plugin.semantic.model_candidate_entity_missing",
          "Verified actor selected by a model draft is absent from the locked RulePlugin world",
          {
            operation_kind: context.operationKind,
            field: label,
            actor_index: index,
            entity_id: entityId,
          },
        );
      }
      return Object.freeze({
        kind: "entity",
        entity: Object.freeze({
          world_id: context.worldId,
          entity_id: entityId,
          expected_revision: expectInteger(
            entity,
            "revision",
            "EntityState",
          ),
        }),
      });
    }),
  );
}

function assertActorIndicesAllowed(
  context: EvidenceContext,
  indices: readonly number[],
  allowedActorIndices: ReadonlySet<number>,
  label: string,
): void {
  for (const index of indices) {
    if (!allowedActorIndices.has(index)) {
      throw fault(
        "rule_plugin.semantic.subject_outside_situation",
        "Subject selector must name a world_view actor already selected by the situation",
        {
          operation_kind: context.operationKind,
          field: label,
          actor_index: index,
          situation_actor_indices: [...allowedActorIndices].sort(
            (left, right) => left - right,
          ),
        },
      );
    }
  }
}

function readDialogueParticipantSubjects(input: {
  readonly context: EvidenceContext;
  readonly participants: readonly JsonObject[];
  readonly indices: readonly number[];
  readonly label: string;
}): readonly JsonObject[] {
  const world = requestWorldState(input.context);
  return Object.freeze(
    input.indices.map((index) => {
      const participant = input.participants[index];
      if (participant === undefined) {
        throw fault(
          "rule_plugin.semantic.dialogue_commitment_selector",
          "Dialogue commitment participant selector is outside the verified dialogue",
          {
            operation_kind: input.context.operationKind,
            field: input.label,
            participant_index: index,
            participant_count: input.participants.length,
          },
        );
      }
      if (
        expectString(
          participant,
          "participant_kind",
          "DialogueParticipantRef",
        ) !== "entity"
      ) {
        throw fault(
          "rule_plugin.semantic.dialogue_commitment_subject_kind",
          "Dialogue commitment subjects must select entity participants",
          {
            operation_kind: input.context.operationKind,
            field: input.label,
            participant_index: index,
          },
        );
      }
      const participantEntity = expectJsonObject(
        expectProperty(
          participant,
          "entity",
          "DialogueParticipantRef",
        ),
        "DialogueParticipantRef.entity",
      );
      const entityId = expectString(
        participantEntity,
        "entity_id",
        "EntityRef",
      );
      const entity = findEntity(world, entityId);
      if (entity === undefined) {
        throw fault(
          "rule_plugin.semantic.dialogue_commitment_entity_missing",
          "Dialogue commitment participant is absent from the locked RulePlugin world",
          {
            operation_kind: input.context.operationKind,
            field: input.label,
            participant_index: index,
            entity_id: entityId,
          },
        );
      }
      return Object.freeze({
        kind: "entity",
        entity: Object.freeze({
          world_id: input.context.worldId,
          entity_id: entityId,
          expected_revision: expectInteger(
            entity,
            "revision",
            "EntityState",
          ),
        }),
      });
    }),
  );
}

function readModelIndices(
  owner: JsonObject,
  field: string,
  label: string,
): readonly number[] {
  const value = expectProperty(owner, field, label);
  if (!Array.isArray(value)) {
    throw fault(
      "rule_plugin.semantic.shape",
      `${label}.${field} must be an array`,
      { field: `${label}.${field}` },
    );
  }
  return Object.freeze(
    value.map((entry, ordinal) => {
      if (
        typeof entry !== "number" ||
        !Number.isSafeInteger(entry) ||
        entry < 0
      ) {
        throw fault(
          "rule_plugin.semantic.model_evidence_index_invalid",
          "Model selector index must be a safe non-negative integer",
          {
            field: `${label}.${field}`,
            ordinal,
          },
        );
      }
      return entry;
    }),
  );
}

function requireModelIndex(
  context: EvidenceContext,
  value: JsonValue,
  length: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= length
  ) {
    throw fault(
      "rule_plugin.semantic.model_evidence_ordinal_out_of_range",
      "Model selector index is outside its referenced collection",
      {
        operation_kind: context.operationKind,
        field: label,
        index: value,
        collection_length: length,
      },
    );
  }
  return value;
}

function readUniqueIdentifiers(
  context: EvidenceContext,
  values: readonly JsonObject[],
  field: string,
  label: string,
  path: string,
): readonly string[] {
  const identifiers = values.map((value) =>
    expectString(value, field, label),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    throw fault(
      "rule_plugin.semantic.model_candidate_identity_duplicate",
      "Locally materialized candidate identities must be unique within their ordinal collection",
      {
        operation_kind: context.operationKind,
        field: path,
      },
    );
  }
  return Object.freeze(identifiers);
}

function assertLocalizedText(
  context: EvidenceContext,
  label: string,
  locale: string,
  text: string,
  actual: JsonValue,
): void {
  assertJsonFieldEqual(
    label,
    Object.freeze({ [locale]: text }),
    actual,
    context.operationKind,
  );
}

function assertSingleLocalizedTextValue(
  context: EvidenceContext,
  label: string,
  text: string,
  actual: JsonValue,
): void {
  const localized = expectJsonObject(actual, label);
  const entries = Object.entries(localized);
  if (
    entries.length !== 1 ||
    entries[0]?.[1] !== text
  ) {
    throw fault(
      "rule_plugin.semantic.model_candidate_localized_text_mismatch",
      "Locally materialized text must preserve the verified raw text under exactly one locale",
      {
        operation_kind: context.operationKind,
        field: label,
      },
    );
  }
}

function assertArrayLength(
  context: Pick<EvidenceContext, "operationKind">,
  label: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
): void {
  if (expected.length !== actual.length) {
    throw fault(
      "rule_plugin.semantic.model_candidate_collection_length",
      "Locally materialized candidate collection length differs from its verified raw draft",
      {
        operation_kind: context.operationKind,
        field: label,
        expected_count: expected.length,
        actual_count: actual.length,
      },
    );
  }
}

function requireModelInvocation(
  context: EvidenceContext,
  owner: JsonObject,
  proofField: string,
  expectedKinds: readonly string[],
): VerifiedModelInvocationReceipt {
  const proof = expectJsonObject(
    expectProperty(owner, proofField, context.operationKind),
    `${context.operationKind}.${proofField}`,
  );
  const matches = context.modelInvocations.filter((receipt) =>
    jsonEquals(receipt.proof.value, proof),
  );
  if (matches.length !== 1) {
    throw fault(
      "rule_plugin.semantic.model_evidence_receipt_count",
      "Referenced model proof must match exactly one verified invocation receipt",
      {
        operation_kind: context.operationKind,
        proof_field: proofField,
        request_id: expectString(
          proof,
          "request_id",
          "VerifiedModelOutputRef",
        ),
        matching_receipts: matches.length,
      },
    );
  }
  const receipt = matches[0] as VerifiedModelInvocationReceipt;
  if (receipt.worldId !== context.worldId) {
    throw fault(
      "rule_plugin.semantic.model_evidence_world_mismatch",
      "Verified model receipt belongs to a different world",
      {
        operation_kind: context.operationKind,
        receipt_world_id: receipt.worldId,
        rule_world_id: context.worldId,
      },
    );
  }
  const proofBasis = expectInteger(
    proof,
    "basis_revision",
    "VerifiedModelOutputRef",
  );
  if (receipt.worldRevision !== proofBasis) {
    throw fault(
      "rule_plugin.semantic.model_evidence_scope_mismatch",
      "Verified model receipt world revision does not match its proof",
      {
        operation_kind: context.operationKind,
        receipt_world_revision: receipt.worldRevision,
        proof_basis_revision: proofBasis,
      },
    );
  }
  if (proofBasis > context.basisRevision) {
    throw fault(
      "rule_plugin.semantic.model_proof_from_future",
      "Verified model proof cannot observe a revision newer than the RulePlugin request",
      {
        operation_kind: context.operationKind,
        model_basis_revision: proofBasis,
        rule_basis_revision: context.basisRevision,
      },
    );
  }
  const requestKind = expectString(
    receipt.request.value,
    "request_kind",
    "ModelRequest",
  );
  if (!expectedKinds.includes(requestKind)) {
    throw fault(
      "rule_plugin.semantic.model_evidence_kind_mismatch",
      "Verified model receipt kind is not authorized for this RulePlugin input",
      {
        operation_kind: context.operationKind,
        request_kind: requestKind,
        expected_request_kinds: [...expectedKinds],
      },
    );
  }
  const outputKind = expectString(
    modelReceiptOutput(receipt),
    "output_kind",
    "ModelOutput",
  );
  if (outputKind !== requestKind) {
    throw fault(
      "rule_plugin.semantic.model_evidence_output_kind_mismatch",
      "Verified model receipt output_kind does not match its request_kind",
      {
        operation_kind: context.operationKind,
        request_kind: requestKind,
        output_kind: outputKind,
      },
    );
  }
  return receipt;
}

function modelReceiptInput(
  receipt: VerifiedModelInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(receipt.request.value, "input", "ModelRequest"),
    "ModelRequest.input",
  );
}

function modelReceiptOutput(
  receipt: VerifiedModelInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(receipt.response.value, "output", "ModelResponse"),
    "ModelResponse.output",
  );
}

function assertValidationOutput(output: JsonObject): void {
  const valid = output.valid;
  if (typeof valid !== "boolean") {
    throw fault(
      "rule_plugin.semantic.validation_shape",
      "ValidationOutput.valid must be boolean",
      {},
    );
  }
  const issues = asObjectArray(
    expectProperty(output, "issues", "ValidationOutput"),
    "ValidationOutput.issues",
  );
  if (valid && issues.length > 0) {
    throw fault(
      "rule_plugin.semantic.validation_issues",
      "ValidationOutput.valid=true requires empty issues",
      { issue_count: issues.length },
    );
  }
  if (!valid && issues.length === 0) {
    throw fault(
      "rule_plugin.semantic.validation_issues",
      "ValidationOutput.valid=false requires at least one issue",
      {},
    );
  }
}

function assertChoiceSpec(context: OperationContext): void {
  const options = asObjectArray(
    expectProperty(context.output, "options", "ChoiceSpec"),
    "ChoiceSpec.options",
  );
  if (options.length < 2) {
    throw fault(
      "rule_plugin.semantic.choice_options",
      "ChoiceSpec requires at least two options",
      { option_count: options.length },
    );
  }
  const choiceId = expectString(
    context.output,
    "choice_id",
    "ChoiceSpec",
  );
  const optionIds = new Set<string>();
  for (const option of options) {
    const optionId = expectString(option, "option_id", "ChoiceOption");
    if (optionIds.has(optionId)) {
      throw fault(
        "rule_plugin.semantic.choice_option_duplicate",
        "ChoiceSpec option_id values must be unique",
        { choice_id: choiceId, option_id: optionId },
      );
    }
    optionIds.add(optionId);
  }
  const deterministicContext = expectJsonObject(
    expectProperty(
      context.request.value,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const priorChoices = asObjectArray(
    expectProperty(
      deterministicContext,
      "random_choices",
      "DeterministicContext",
    ),
    "DeterministicContext.random_choices",
  );
  if (
    priorChoices.some(
      (entry) =>
        expectString(
          entry,
          "choice_id",
          "DeterministicContext.random_choices[]",
        ) === choiceId,
    )
  ) {
    throw fault(
      "rule_plugin.semantic.choice_identity_reused",
      "RulePlugin cannot request a choice_id already resolved in its DeterministicContext",
      { choice_id: choiceId },
    );
  }
}

function assertModelProofRevisionCompatible(
  context: OperationContext,
  owner: JsonObject,
  field: string,
): void {
  const proof = expectJsonObject(
    expectProperty(owner, field, context.operationKind),
    `${context.operationKind}.${field}`,
  );
  const requestBasis = expectInteger(
    context.request.value,
    "basis_revision",
    "RulePluginRequest",
  );
  const proofBasis = expectInteger(
    proof,
    "basis_revision",
    "VerifiedModelOutputRef",
  );
  if (proofBasis > requestBasis) {
    throw fault(
      "rule_plugin.semantic.model_proof_from_future",
      "Verified model proof cannot observe a revision newer than the RulePlugin request",
      {
        operation_kind: context.operationKind,
        field,
        model_basis_revision: proofBasis,
        rule_basis_revision: requestBasis,
      },
    );
  }
}

function assertActorEntityExists(
  context: OperationContext,
  input: JsonObject,
): void {
  if (input.actor === undefined) {
    return;
  }
  const actor = expectJsonObject(
    expectProperty(input, "actor", context.operationKind),
    `${context.operationKind}.actor`,
  );
  const entityId = expectString(actor, "entity_id", "EntityRef");
  if (!findEntity(context.world, entityId)) {
    throw fault(
      "rule_plugin.semantic.entity_missing",
      `Actor entity ${entityId} is absent from readonly_world`,
      { operation_kind: context.operationKind, entity_id: entityId },
    );
  }
}

function assertHumanControlMatchesActor(
  context: OperationContext,
  input: JsonObject,
  actor: JsonObject,
): void {
  const control = expectJsonObject(
    expectProperty(input, "control", context.operationKind),
    `${context.operationKind}.control`,
  );
  const bindingId = expectString(control, "binding_id", "ControlBindingRef");
  const binding = findControlBinding(context.world, bindingId);
  if (binding === undefined) {
    throw fault(
      "rule_plugin.semantic.control_missing",
      `Control binding ${bindingId} is absent from readonly_world`,
      { operation_kind: context.operationKind, binding_id: bindingId },
    );
  }
  assertEqual(
    "control.binding_kind",
    "human",
    expectString(binding, "binding_kind", "ControlBinding"),
    context.operationKind,
  );
  assertEqual(
    "control.status",
    "active",
    expectString(binding, "status", "ControlBinding"),
    context.operationKind,
  );
  assertEqual(
    "control.entity_id",
    expectString(actor, "entity_id", "EntityRef"),
    expectString(binding, "entity_id", "ControlBinding"),
    context.operationKind,
  );
}

function assertHumanDialogueControlAndSource(
  context: OperationContext,
  owner: JsonObject,
  turn: JsonObject,
  participants: readonly JsonObject[],
  proposal: JsonObject,
): void {
  const control = expectJsonObject(
    expectProperty(owner, "control", context.operationKind),
    `${context.operationKind}.control`,
  );
  const bindingId = expectString(
    control,
    "binding_id",
    "ControlBindingRef",
  );
  const binding = findControlBinding(context.world, bindingId);
  if (binding === undefined) {
    throw fault(
      "rule_plugin.semantic.control_missing",
      `Control binding ${bindingId} is absent from readonly_world`,
      { operation_kind: context.operationKind, binding_id: bindingId },
    );
  }
  assertEqual(
    "dialogue.control.binding_kind",
    "human",
    expectString(binding, "binding_kind", "ControlBinding"),
    context.operationKind,
  );
  assertEqual(
    "dialogue.control.status",
    "active",
    expectString(binding, "status", "ControlBinding"),
    context.operationKind,
  );

  const speakerEntity = requireDialogueTurnSpeakerEntity(context, turn);
  assertEqual(
    "dialogue.speaker.world_id",
    context.worldId,
    expectString(speakerEntity, "world_id", "EntityRef"),
    context.operationKind,
  );
  const speakerEntityId = expectString(
    speakerEntity,
    "entity_id",
    "EntityRef",
  );
  assertEqual(
    "dialogue.control.entity_id",
    speakerEntityId,
    expectString(binding, "entity_id", "ControlBinding"),
    context.operationKind,
  );
  const entity = findEntity(context.world, speakerEntityId);
  if (
    entity === undefined ||
    expectString(entity, "state", "EntityState") !== "active"
  ) {
    throw fault(
      "rule_plugin.semantic.dialogue_human_speaker_unavailable",
      "Human dialogue speaker must be an active Entity in readonly_world",
      {
        operation_kind: context.operationKind,
        entity_id: speakerEntityId,
      },
    );
  }
  assertDialogueSpeakerIsParticipant(context, turn, participants);

  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  assertEqual(
    "dialogue.source.source_kind",
    "human",
    expectString(source, "source_kind", "DialogueTurnSource"),
    context.operationKind,
  );
  const commandId = expectString(
    source,
    "command_id",
    "HumanDialogueTurnSource",
  );
  assertEqual(
    "dialogue.proposal.cause_id",
    commandId,
    expectString(proposal, "cause_id", "PacketProposal"),
    context.operationKind,
  );
}

function assertDialogueSpeakerIsParticipant(
  context: OperationContext,
  turn: JsonObject,
  participants: readonly JsonObject[],
): void {
  const speaker = expectJsonObject(
    expectProperty(turn, "speaker", "DialogueTurn"),
    "DialogueTurn.speaker",
  );
  const matches = participants.filter((participant) =>
    jsonEquals(participant, speaker),
  );
  if (matches.length !== 1) {
    throw fault(
      "rule_plugin.semantic.dialogue_speaker_not_participant",
      "Dialogue turn speaker must match exactly one dialogue participant",
      {
        operation_kind: context.operationKind,
        matching_participants: matches.length,
      },
    );
  }
}

function dialogueContainsEntity(
  dialogue: JsonObject,
  entityId: string,
): boolean {
  return asObjectArray(
    expectProperty(
      dialogue,
      "participants",
      "DialogueRecord",
    ),
    "DialogueRecord.participants",
  ).some((participant) => {
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
      expectString(entity, "entity_id", "EntityRef") === entityId
    );
  });
}

function assertActiveCharacterMindSpeaker(
  context: OperationContext,
  turn: JsonObject,
): void {
  const speakerEntity = requireDialogueTurnSpeakerEntity(context, turn);
  assertEqual(
    "dialogue.speaker.world_id",
    context.worldId,
    expectString(speakerEntity, "world_id", "EntityRef"),
    context.operationKind,
  );
  const entityId = expectString(
    speakerEntity,
    "entity_id",
    "EntityRef",
  );
  const entity = findEntity(context.world, entityId);
  if (
    entity === undefined ||
    expectString(entity, "state", "EntityState") !== "active"
  ) {
    throw fault(
      "rule_plugin.semantic.dialogue_character_speaker_unavailable",
      "CharacterMind dialogue speaker must be an active Entity",
      { operation_kind: context.operationKind, entity_id: entityId },
    );
  }
  const bindings = asObjectArray(
    expectProperty(
      context.world,
      "control_bindings",
      "WorldState",
    ),
    "WorldState.control_bindings",
  ).filter(
    (binding) =>
      expectString(binding, "binding_kind", "ControlBinding") ===
        "character_mind" &&
      expectString(binding, "entity_id", "ControlBinding") === entityId &&
      expectString(binding, "status", "ControlBinding") === "active",
  );
  if (bindings.length !== 1) {
    throw fault(
      "rule_plugin.semantic.dialogue_character_binding_count",
      "CharacterMind dialogue speaker must have exactly one active CharacterMind ControlBinding",
      {
        operation_kind: context.operationKind,
        entity_id: entityId,
        matching_bindings: bindings.length,
      },
    );
  }
}

function requireDialogueTurnSpeakerEntity(
  context: OperationContext,
  turn: JsonObject,
): JsonObject {
  const speaker = expectJsonObject(
    expectProperty(turn, "speaker", "DialogueTurn"),
    "DialogueTurn.speaker",
  );
  const participantKind = expectString(
    speaker,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind !== "entity") {
    throw fault(
      "rule_plugin.semantic.dialogue_entity_speaker_required",
      "Human and CharacterMind dialogue turns require an Entity speaker",
      {
        operation_kind: context.operationKind,
        participant_kind: participantKind,
      },
    );
  }
  return expectJsonObject(
    expectProperty(speaker, "entity", "DialogueParticipantRef"),
    "DialogueParticipantRef.entity",
  );
}

function assertControlExists(context: OperationContext, owner: JsonObject): void {
  const control = expectJsonObject(
    expectProperty(owner, "control", context.operationKind),
    `${context.operationKind}.control`,
  );
  const bindingId = expectString(control, "binding_id", "ControlBindingRef");
  if (!findControlBinding(context.world, bindingId)) {
    throw fault(
      "rule_plugin.semantic.control_missing",
      `Control binding ${bindingId} is absent from readonly_world`,
      { operation_kind: context.operationKind, binding_id: bindingId },
    );
  }
}

function singleOp(
  proposal: JsonObject,
  expectedOp: string,
  operationKind: OperationKind,
): JsonObject {
  const ops = asObjectArray(
    expectProperty(proposal, "ops", "PacketProposal"),
    "PacketProposal.ops",
  );
  if (ops.length !== 1) {
    throw fault(
      "rule_plugin.semantic.op_count",
      `${operationKind} packet must contain exactly one op`,
      { operation_kind: operationKind, op_count: ops.length, expected_op: expectedOp },
    );
  }
  const op = ops[0] as JsonObject;
  assertEqual(
    "op",
    expectedOp,
    expectString(op, "op", "EffectOp"),
    operationKind,
  );
  return op;
}

function findGoalPlan(world: JsonObject, planId: string): JsonObject | undefined {
  const plans = asObjectArray(
    expectProperty(world, "goal_plans", "WorldState"),
    "WorldState.goal_plans",
  );
  return plans.find(
    (plan) => expectString(plan, "plan_id", "GoalPlan") === planId,
  );
}

function findGoalNode(
  plan: JsonObject,
  nodeId: string,
): JsonObject | undefined {
  const nodes = asObjectArray(
    expectProperty(plan, "nodes", "GoalPlan"),
    "GoalPlan.nodes",
  );
  return nodes.find(
    (node) => expectString(node, "node_id", "GoalNode") === nodeId,
  );
}

function findDialogue(
  world: JsonObject,
  dialogueId: string,
): JsonObject | undefined {
  const dialogues = asObjectArray(
    expectProperty(world, "dialogues", "WorldState"),
    "WorldState.dialogues",
  );
  return dialogues.find(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueRecord") === dialogueId,
  );
}

function findStage(
  world: JsonObject,
  stageInstanceId: string,
): JsonObject | undefined {
  const stages = asObjectArray(
    expectProperty(world, "stage_instances", "WorldState"),
    "WorldState.stage_instances",
  );
  return stages.find(
    (stage) =>
      expectString(
        stage,
        "stage_instance_id",
        "StageInstanceState",
      ) === stageInstanceId,
  );
}

function findEntity(world: JsonObject, entityId: string): JsonObject | undefined {
  const entities = asObjectArray(
    expectProperty(world, "entities", "WorldState"),
    "WorldState.entities",
  );
  return entities.find(
    (entity) => expectString(entity, "entity_id", "EntityState") === entityId,
  );
}

function findControlBinding(
  world: JsonObject,
  bindingId: string,
): JsonObject | undefined {
  const bindings = asObjectArray(
    expectProperty(world, "control_bindings", "WorldState"),
    "WorldState.control_bindings",
  );
  return bindings.find(
    (binding) =>
      expectString(binding, "binding_id", "ControlBinding") === bindingId,
  );
}

function findStateMachine(
  world: JsonObject,
  machineInstanceId: string,
): JsonObject | undefined {
  const machines = asObjectArray(
    expectProperty(world, "state_machines", "WorldState"),
    "WorldState.state_machines",
  );
  return machines.find(
    (machine) =>
      expectString(machine, "instance_id", "StateMachineInstanceState") ===
      machineInstanceId,
  );
}

function omitField(object: JsonObject, field: string): JsonObject {
  const next: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== field) {
      next[key] = value;
    }
  }
  return next;
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault("rule_plugin.semantic.shape", `${path} must be an array`, { path });
  }
  return value.map((entry, index) => {
    if (!isJsonObject(entry as JsonValue)) {
      throw fault(
        "rule_plugin.semantic.shape",
        `${path}[${index}] must be an object`,
        { path: `${path}[${index}]` },
      );
    }
    return entry as JsonObject;
  });
}

function asStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw fault(
      "rule_plugin.semantic.shape",
      `${path} must be a string array`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw fault(
        "rule_plugin.semantic.shape",
        `${path}[${index}] must be a string`,
        { path: `${path}[${index}]` },
      );
    }
    return entry;
  });
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEqual(
  field: string,
  expected: number | string,
  actual: number | string,
  operationKind: OperationKind,
): void {
  if (expected !== actual) {
    throw fault(
      "rule_plugin.semantic.field_mismatch",
      `${operationKind} ${field} mismatch`,
      {
        field,
        expected,
        actual,
        operation_kind: operationKind,
      },
    );
  }
}

function assertJsonFieldEqual(
  field: string,
  expected: JsonValue,
  actual: JsonValue,
  operationKind: OperationKind,
): void {
  if (!jsonEquals(expected, actual)) {
    throw fault(
      "rule_plugin.semantic.field_mismatch",
      `${operationKind} ${field} mismatch`,
      {
        field,
        operation_kind: operationKind,
      },
    );
  }
}

function unexpectedOutput(context: OperationContext): EngineFault {
  return fault(
    "rule_plugin.semantic.output_kind_unexpected",
    `Unexpected output_kind ${context.outputKind} for ${context.operationKind}`,
    {
      operation_kind: context.operationKind,
      output_kind: context.outputKind,
    },
  );
}

function fault(
  code: string,
  message: string,
  details: JsonObject,
): EngineFault {
  return new EngineFault(code, message, details);
}

interface CorrelationPair {
  readonly field: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

// Compile-time exhaustiveness: adding an OperationKind without a handler fails.
const _exhaustive: {
  readonly [K in (typeof OPERATION_KINDS)[number]]: true;
} = {
  "rule.evaluate": true,
  "capability.resolve": true,
  "navigation.resolve": true,
  "definition.validate": true,
  "goal_plan.validate": true,
  "world_extension.resolve": true,
  "content_upgrade.transform": true,
  "day_cycle.advance": true,
  "state_machine.advance": true,
  "automatic_event.world.resolve": true,
  "automatic_event.character.resolve": true,
  "stage_outcome.resolve": true,
  "dialogue.open": true,
  "dialogue.turn.append": true,
  "dialogue.close": true,
  "event_card.publish": true,
};
void _exhaustive;
