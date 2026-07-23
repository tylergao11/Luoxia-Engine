import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

import type {
  RulePluginRequestDocument,
  RulePluginResponseDocument,
  RulePluginSemanticGate,
} from "./rule-plugin-gateway.js";
import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";

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
  readonly request: RulePluginRequestDocument;
  readonly response: RulePluginResponseDocument;
  readonly digest: JsonDigest;
  readonly operationKind: OperationKind;
  readonly input: JsonObject;
  readonly output: JsonObject;
  readonly outputKind: string;
  readonly worldId: string;
  readonly world: JsonObject;
}

interface EvidenceContext {
  readonly request: RulePluginRequestDocument;
  readonly digest: JsonDigest;
  readonly operationKind: OperationKind;
  readonly input: JsonObject;
  readonly worldId: string;
  readonly basisRevision: number;
  readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
}

type OperationHandler = (context: OperationContext) => void;

export function createRulePluginSemanticGate(
  digest: JsonDigest,
): RulePluginSemanticGate {
  return new DefaultRulePluginSemanticGate(digest);
}

class DefaultRulePluginSemanticGate implements RulePluginSemanticGate {
  readonly #digest: JsonDigest;

  public constructor(digest: JsonDigest) {
    this.#digest = digest;
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
    assertModelEvidenceForOperation({
      request,
      digest: this.#digest,
      operationKind,
      input: expectJsonObject(
        expectProperty(request.value, "input", "RulePluginRequest"),
        "RulePluginRequest.input",
      ),
      worldId,
      basisRevision,
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

    handler({
      request,
      response,
      digest: this.#digest,
      operationKind,
      input,
      output,
      outputKind: expectString(output, "output_kind", "RulePluginResponse.output"),
      worldId,
      world,
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
    case "choice.required":
      assertChoiceSpec(context.output);
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
      assertChoiceSpec(context.output);
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
      const modelProposal = expectJsonObject(
        expectProperty(context.input, "proposal", "DefinitionValidationInput"),
        "DefinitionValidationInput.proposal",
      );
      const draft = expectJsonObject(
        expectProperty(modelProposal, "draft", "DynamicDefinitionProposal"),
        "DynamicDefinitionProposal.draft",
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
      const modelProposal = expectJsonObject(
        expectProperty(context.input, "proposal", "GoalPlanValidateInput"),
        "GoalPlanValidateInput.proposal",
      );
      const draft = expectJsonObject(
        expectProperty(modelProposal, "draft", "GoalPlanProposal"),
        "GoalPlanProposal.draft",
      );
      const proposalId = expectString(
        modelProposal,
        "proposal_id",
        "GoalPlanProposal",
      );
      const ownerActorId = expectString(
        modelProposal,
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
      assertModelProofRevisionCompatible(context, context.input, "model_proof");
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
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
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
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

      assertEqual(
        "content_upgrade.source_bundle_digest",
        expectString(sourceBundle, "bundle_digest", "PackLock"),
        expectString(context.output, "source_bundle_digest", "ContentUpgradeOutput"),
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
  switch (context.outputKind) {
    case "reject":
      return;
    case "packet.proposal": {
      const proposal = assertPacketProposalProvenance(context);
      const op = singleOp(proposal, "state_machine.set_state", context.operationKind);
      const machineInstanceId = expectString(
        context.input,
        "machine_instance_id",
        "StateMachineAdvanceInput",
      );
      assertEqual(
        "state_machine.machine_instance_id",
        machineInstanceId,
        expectString(op, "machine_instance_id", "StateMachineSetStateOp"),
        context.operationKind,
      );
      if (!findStateMachine(context.world, machineInstanceId)) {
        throw fault(
          "rule_plugin.semantic.state_machine_missing",
          `State machine instance ${machineInstanceId} is absent from readonly_world`,
          {
            operation_kind: context.operationKind,
            machine_instance_id: machineInstanceId,
          },
        );
      }
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
      assertChoiceSpec(context.output);
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
      assertChoiceSpec(context.output);
      return;
    case "packet.proposal": {
      assertPacketProposalProvenance(context);
      assertModelProofRevisionCompatible(context, context.input, "director_proof");
      const proposal = expectJsonObject(
        expectProperty(
          context.input,
          "proposal",
          "CharacterAutomaticEventResolveInput",
        ),
        "CharacterAutomaticEventResolveInput.proposal",
      );
      const proposalId = expectString(
        proposal,
        "proposal_id",
        "CharacterAutomaticEventProposal",
      );
      const targetIds = new Set(
        asStringArray(
          expectProperty(
            proposal,
            "target_entity_ids",
            "CharacterAutomaticEventProposal",
          ),
          "CharacterAutomaticEventProposal.target_entity_ids",
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
          expectProperty(batch, "reactions", "CharacterReactionBatch"),
          "CharacterReactionBatch.reactions",
        );
        for (const reaction of reactions) {
          const sourceEvent = expectJsonObject(
            expectProperty(reaction, "source_event", "CharacterReactionProposal"),
            "CharacterReactionProposal.source_event",
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
      return;
    }
    default:
      throw unexpectedOutput(context);
  }
}

function handleStageOutcomeResolve(context: OperationContext): void {
  switch (context.outputKind) {
    case "reject":
      return;
    case "choice.required":
      assertChoiceSpec(context.output);
      return;
    case "packet.proposal":
      assertPacketProposalProvenance(context);
      assertControlExists(context, context.input);
      return;
    default:
      throw unexpectedOutput(context);
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
      assertControlExists(context, context.input);
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
      assertJsonFieldEqual(
        "dialogue.append.turn",
        expectProperty(context.input, "turn", "DialogueTurnAppendInput"),
        expectProperty(op, "turn", "DialogueTurnAppendOp"),
        context.operationKind,
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

      if (context.input.control !== undefined) {
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
      const cardProposal = expectJsonObject(
        expectProperty(context.input, "proposal", "EventCardPublishInput"),
        "EventCardPublishInput.proposal",
      );
      const control = expectJsonObject(
        expectProperty(context.input, "control", "EventCardPublishInput"),
        "EventCardPublishInput.control",
      );
      assertModelProofRevisionCompatible(context, context.input, "model_proof");

      assertEqual(
        "event_card.source_proposal_id",
        expectString(cardProposal, "proposal_id", "EventCardProposal"),
        expectString(op, "source_proposal_id", "EventCardPublishOp"),
        context.operationKind,
      );
      assertEqual(
        "event_card.source_dialogue_id",
        expectString(cardProposal, "source_dialogue_id", "EventCardProposal"),
        expectString(op, "source_dialogue_id", "EventCardPublishOp"),
        context.operationKind,
      );
      assertEqual(
        "event_card.day",
        expectInteger(cardProposal, "day", "EventCardProposal"),
        expectInteger(op, "day", "EventCardPublishOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "event_card.title",
        expectProperty(cardProposal, "title", "EventCardProposal"),
        expectProperty(op, "title", "EventCardPublishOp"),
        context.operationKind,
      );
      assertJsonFieldEqual(
        "event_card.summary",
        expectProperty(cardProposal, "summary", "EventCardProposal"),
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
        expectString(cardProposal, "proposal_id", "EventCardProposal"),
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
      assertEqual(
        "sealed.deterministic_context_id",
        expectString(deterministicContext, "context_id", "DeterministicContext"),
        expectString(sealed, "deterministic_context_id", "SealedEventResult"),
        context.operationKind,
      );
      assertEqual(
        "sealed.deterministic_context_digest",
        expectString(
          deterministicContext,
          "context_digest",
          "DeterministicContext",
        ),
        expectString(sealed, "deterministic_context_digest", "SealedEventResult"),
        context.operationKind,
      );

      const selectedOptionId = expectString(
        sealed,
        "selected_option_id",
        "SealedEventResult",
      );
      const options = asObjectArray(
        expectProperty(cardProposal, "result_options", "EventCardProposal"),
        "EventCardProposal.result_options",
      );
      const selected = options.find(
        (option) =>
          expectString(option, "option_id", "EventCardOutcomeDraft") ===
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
        expectProperty(selected, "presentation", "EventCardOutcomeDraft"),
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
        cardProposal,
        selected,
        sealed,
        expectInteger(cardProposal, "day", "EventCardProposal"),
      );
      assertDialogueQuotesExist(context, sealed);
      assertControlExists(context, context.input);
      assertEventBudgetSufficient(
        context,
        control,
        expectInteger(cardProposal, "day", "EventCardProposal"),
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
  cardProposal: JsonObject,
  selectedOption: JsonObject,
  sealed: JsonObject,
  day: number,
): void {
  const gates = asObjectArray(
    expectProperty(cardProposal, "agency_gates", "EventCardProposal"),
    "EventCardProposal.agency_gates",
  );
  const selectedOutcomes = asObjectArray(
    expectProperty(selectedOption, "outcomes", "EventCardOutcomeDraft"),
    "EventCardOutcomeDraft.outcomes",
  );
  const selectedOutcomeIds = new Set(
    selectedOutcomes.map((outcome) =>
      expectString(outcome, "outcome_id", "SemanticOutcomeProposal"),
    ),
  );

  const requiredCommitmentKeys = new Set<string>();
  for (const gate of gates) {
    const protectedIds = asStringArray(
      expectProperty(gate, "protected_outcome_ids", "AgencyGate"),
      "AgencyGate.protected_outcome_ids",
    );
    const protectsSelected = protectedIds.some((id) => selectedOutcomeIds.has(id));
    if (!protectsSelected) {
      continue;
    }
    const evidence = asObjectArray(
      expectProperty(gate, "commitment_evidence", "AgencyGate"),
      "AgencyGate.commitment_evidence",
    );
    if (evidence.length === 0) {
      throw fault(
        "rule_plugin.semantic.event_card_agency_evidence_missing",
        `Agency gate protecting selected outcomes has empty commitment_evidence`,
        {
          operation_kind: context.operationKind,
          gate_id: expectString(gate, "gate_id", "AgencyGate"),
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
    expectProperty(gate, "requirement", "AgencyGate"),
    "AgencyGate.requirement",
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

function assertDialogueQuotesExist(
  context: OperationContext,
  sealed: JsonObject,
): void {
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
      const receipt = requireModelInvocation(
        context,
        context.input,
        "model_proof",
        ["director.system_dialogue"],
      );
      assertReceiptCollectionMember(
        receipt,
        "definitions",
        expectProperty(context.input, "proposal", "DefinitionValidationInput"),
        "definition.validate proposal",
      );
      return;
    }
    case "goal_plan.validate": {
      const receipt = requireModelInvocation(
        context,
        context.input,
        "model_proof",
        ["director.system_dialogue"],
      );
      assertReceiptCollectionMember(
        receipt,
        "goal_plans",
        expectProperty(context.input, "proposal", "GoalPlanValidateInput"),
        "goal_plan.validate proposal",
      );
      return;
    }
    case "automatic_event.world.resolve": {
      const receipt = requireModelInvocation(
        context,
        context.input,
        "model_proof",
        ["director.daily_settlement"],
      );
      assertReceiptCollectionMember(
        receipt,
        "automatic_events",
        expectProperty(
          context.input,
          "proposal",
          "WorldAutomaticEventResolveInput",
        ),
        "automatic_event.world.resolve proposal",
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
      const receipt = requireModelInvocation(
        context,
        context.input,
        "model_proof",
        ["director.dialogue_events", "director.system_dialogue"],
      );
      assertReceiptCollectionMember(
        receipt,
        "event_cards",
        expectProperty(context.input, "proposal", "EventCardPublishInput"),
        "event_card.publish proposal",
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
  const directorReceipt = requireModelInvocation(
    context,
    context.input,
    "director_proof",
    ["director.daily_settlement"],
  );
  const proposal = expectJsonObject(
    expectProperty(
      context.input,
      "proposal",
      "CharacterAutomaticEventResolveInput",
    ),
    "CharacterAutomaticEventResolveInput.proposal",
  );
  assertReceiptCollectionMember(
    directorReceipt,
    "automatic_events",
    proposal,
    "automatic_event.character.resolve proposal",
  );
  const proposalId = expectString(
    proposal,
    "proposal_id",
    "CharacterAutomaticEventProposal",
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
        proposal,
        "target_entity_ids",
        "CharacterAutomaticEventProposal",
      ),
      "CharacterAutomaticEventProposal.target_entity_ids",
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
    const matchingStimuli = stimuli.filter(
      (stimulus) =>
        expectString(stimulus, "proposal_id", "CharacterEventStimulus") ===
        proposalId,
    );
    if (matchingStimuli.length !== 1) {
      throw fault(
        "rule_plugin.semantic.model_evidence_stimulus_missing",
        "Character reaction proof must contain exactly one stimulus for the automatic event",
        {
          operation_kind: context.operationKind,
          proposal_id: proposalId,
          matching_stimuli: matchingStimuli.length,
          batch_index: batchIndex,
        },
      );
    }
    assertStimulusMatchesProposal(
      matchingStimuli[0] as JsonObject,
      proposal,
      context.operationKind,
    );

    const output = modelReceiptOutput(receipt);
    const verifiedReactions = asObjectArray(
      expectProperty(output, "reactions", "CharacterReactOutput"),
      "CharacterReactOutput.reactions",
    );
    const reactions = asObjectArray(
      expectProperty(batch, "reactions", "CharacterReactionBatch"),
      "CharacterReactionBatch.reactions",
    );
    const seenReactionIds = new Set<string>();
    for (const reaction of reactions) {
      const reactionId = expectString(
        reaction,
        "reaction_id",
        "CharacterReactionProposal",
      );
      if (seenReactionIds.has(reactionId)) {
        throw fault(
          "rule_plugin.semantic.model_evidence_reaction_duplicate",
          "CharacterReactionBatch contains a duplicate verified reaction",
          {
            operation_kind: context.operationKind,
            reaction_id: reactionId,
            batch_index: batchIndex,
          },
        );
      }
      seenReactionIds.add(reactionId);
      const source = expectJsonObject(
        expectProperty(reaction, "source_event", "CharacterReactionProposal"),
        "CharacterReactionProposal.source_event",
      );
      if (
        expectString(source, "proposal_id", "CharacterEventRef") !== proposalId
      ) {
        throw fault(
          "rule_plugin.semantic.model_evidence_reaction_wrong_event",
          "CharacterReactionBatch may only contain reactions for the current proposal",
          {
            operation_kind: context.operationKind,
            proposal_id: proposalId,
            reaction_id: reactionId,
          },
        );
      }
      if (
        !verifiedReactions.some((verified) => jsonEquals(verified, reaction))
      ) {
        throw fault(
          "rule_plugin.semantic.model_evidence_member_missing",
          "CharacterReactionBatch reaction is not an exact member of its verified model output",
          {
            operation_kind: context.operationKind,
            proposal_id: proposalId,
            reaction_id: reactionId,
          },
        );
      }
    }
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
  const turn = expectJsonObject(
    expectProperty(context.input, "turn", "DialogueTurnAppendInput"),
    "DialogueTurnAppendInput.turn",
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
  if (sourceKind === "human") {
    return;
  }

  const expectedKinds =
    sourceKind === "character_mind"
      ? (["character.dialogue"] as const)
      : sourceKind === "director_system"
        ? (["director.system_dialogue"] as const)
        : undefined;
  if (expectedKinds === undefined) {
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
    expectedKinds,
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
  assertReplyMatchesTurn(context, reply, turn);

  if (sourceKind === "character_mind") {
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
    assertCommitmentsMatchDrafts(context, output, turn);
  }
}

function assertReplyMatchesTurn(
  context: EvidenceContext,
  reply: JsonObject,
  turn: JsonObject,
): void {
  for (const field of ["locale", "text"] as const) {
    assertEqual(
      `dialogue.turn.${field}`,
      expectString(reply, field, "DialogueReplyDraft"),
      expectString(turn, field, "DialogueTurn"),
      context.operationKind,
    );
  }
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
  output: JsonObject,
  turn: JsonObject,
): void {
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
  for (const [index, commitment] of commitments.entries()) {
    const commitmentId = expectString(
      commitment,
      "commitment_id",
      "AgencyCommitment",
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
    if (
      !jsonEquals(
        omitField(commitment, "commitment_id"),
        drafts[index] as JsonObject,
      )
    ) {
      throw fault(
        "rule_plugin.semantic.model_evidence_commitment_mismatch",
        "Agency commitment fields other than commitment_id must exactly match the verified draft",
        {
          operation_kind: context.operationKind,
          commitment_index: index,
        },
      );
    }
  }
}

function assertStimulusMatchesProposal(
  stimulus: JsonObject,
  proposal: JsonObject,
  operationKind: OperationKind,
): void {
  for (const field of [
    "proposal_id",
    "day",
    "situation",
    "candidate_outcomes",
    "agency_gates",
  ] as const) {
    assertJsonFieldEqual(
      `character_stimulus.${field}`,
      expectProperty(proposal, field, "CharacterAutomaticEventProposal"),
      expectProperty(stimulus, field, "CharacterEventStimulus"),
      operationKind,
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

function assertReceiptCollectionMember(
  receipt: VerifiedModelInvocationReceipt,
  collectionField: string,
  candidate: JsonValue,
  label: string,
): void {
  const output = modelReceiptOutput(receipt);
  const members = asObjectArray(
    expectProperty(output, collectionField, "ModelOutput"),
    `ModelOutput.${collectionField}`,
  );
  if (!members.some((member) => jsonEquals(member, candidate))) {
    throw fault(
      "rule_plugin.semantic.model_evidence_member_missing",
      `${label} is not an exact member of the verified model output`,
      {
        request_id: expectString(
          receipt.request.value,
          "request_id",
          "ModelRequest",
        ),
        collection: collectionField,
      },
    );
  }
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

function assertChoiceSpec(output: JsonObject): void {
  const options = asObjectArray(
    expectProperty(output, "options", "ChoiceSpec"),
    "ChoiceSpec.options",
  );
  if (options.length < 2) {
    throw fault(
      "rule_plugin.semantic.choice_options",
      "ChoiceSpec requires at least two options",
      { option_count: options.length },
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
