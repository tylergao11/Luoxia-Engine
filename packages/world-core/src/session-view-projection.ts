import {
  CONTRACT_REF,
  EngineFault,
  assertJsonValue,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime/portable";

import type {
  SessionViewDocument,
  SessionViewProjectionInput,
  SessionViewProjector,
} from "./composition.js";

export interface SessionViewProjectorDependencies {
  readonly contracts: ContractValidator;
}

export function createSessionViewProjector(
  dependencies: SessionViewProjectorDependencies,
): SessionViewProjector {
  return new DefaultSessionViewProjector(dependencies.contracts);
}

class DefaultSessionViewProjector implements SessionViewProjector {
  readonly #contracts: ContractValidator;

  public constructor(contracts: ContractValidator) {
    this.#contracts = contracts;
  }

  public project(input: SessionViewProjectionInput): SessionViewDocument {
    const snapshot = input.snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshot, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const playerEntityId = resolvePlayerEntityId(
      worldState,
      input.controlBindingId,
    );
    const dayCycle = expectJsonObject(
      expectProperty(worldState, "day_cycle", "WorldState"),
      "WorldState.day_cycle",
    );
    const currentDay = expectInteger(dayCycle, "day", "DayCycleState");

    const view: JsonObject = {
      contract_version: "world-runtime.v1",
      record_type: "session.view",
      session_id: input.sessionId,
      view_revision: input.viewRevision,
      basis_token: input.basisToken,
      player_entity_id: playerEntityId,
      world_time: cloneJson(
        expectProperty(worldState, "clock", "WorldState"),
      ),
      render_nodes: input.renderNodeCandidates.map(cloneCandidate),
      goal_plans: projectGoalPlans(worldState, playerEntityId),
      notices: input.noticeCandidates.map(cloneCandidate),
      day_cycle: cloneJsonObject(dayCycle),
      event_budget: projectEventBudget(
        worldState,
        currentDay,
        input.controlBindingId,
      ),
      event_cards: projectEventCards(
        worldState,
        currentDay,
        input.controlBindingId,
      ),
      dialogues: projectDialogues(worldState, playerEntityId),
    };

    return this.#contracts.assertObject(CONTRACT_REF.sessionView, view);
  }
}

function resolvePlayerEntityId(
  worldState: JsonObject,
  controlBindingId: string,
): string {
  const bindings = asObjectArray(
    expectProperty(worldState, "control_bindings", "WorldState"),
    "WorldState.control_bindings",
  );
  const matches = bindings.filter(
    (binding) =>
      expectString(binding, "binding_id", "ControlBinding") ===
      controlBindingId,
  );
  if (matches.length !== 1) {
    throw fault(
      "world.session_view.control_binding_match",
      "Session control binding must resolve to exactly one binding",
      { control_binding_id: controlBindingId, matches: matches.length },
    );
  }
  const binding = matches[0] as JsonObject;
  assertEqual(
    "control_binding.binding_kind",
    "human",
    expectString(binding, "binding_kind", "ControlBinding"),
  );
  assertEqual(
    "control_binding.status",
    "active",
    expectString(binding, "status", "ControlBinding"),
  );
  const playerEntityId = expectString(binding, "entity_id", "ControlBinding");
  const entities = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  ).filter(
    (entity) => expectString(entity, "entity_id", "EntityState") === playerEntityId,
  );
  if (entities.length !== 1) {
    throw fault(
      "world.session_view.player_entity_match",
      "Human control binding must resolve to exactly one player entity",
      { entity_id: playerEntityId, matches: entities.length },
    );
  }
  assertEqual(
    "player_entity.state",
    "active",
    expectString(entities[0] as JsonObject, "state", "EntityState"),
  );
  return playerEntityId;
}

function projectEventBudget(
  worldState: JsonObject,
  currentDay: number,
  controlBindingId: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(worldState, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  ).filter(
    (budget) =>
      expectInteger(budget, "day", "EventBudgetState") === currentDay &&
      hasControlBinding(budget, controlBindingId, "EventBudgetState"),
  );
  if (matches.length !== 1) {
    throw fault(
      "world.session_view.event_budget_match",
      "Current day and control binding must resolve to exactly one event budget",
      {
        day: currentDay,
        control_binding_id: controlBindingId,
        matches: matches.length,
      },
    );
  }
  const budget = matches[0] as JsonObject;
  const capacity = expectInteger(budget, "capacity", "EventBudgetState");
  const spent = asObjectArray(
    expectProperty(budget, "charges", "EventBudgetState"),
    "EventBudgetState.charges",
  ).reduce(
    (total, charge) =>
      total +
      expectInteger(
        expectJsonObject(
          expectProperty(charge, "cost", "EventCharge"),
          "EventCharge.cost",
        ),
        "amount",
        "EventCost",
      ),
    0,
  );
  const remaining = capacity - spent;
  if (remaining < 0) {
    throw fault(
      "world.session_view.event_budget_negative",
      "Event budget charges exceed its capacity",
      { capacity, spent, remaining },
    );
  }
  return {
    day: currentDay,
    capacity,
    spent,
    remaining,
  };
}

function projectEventCards(
  worldState: JsonObject,
  currentDay: number,
  controlBindingId: string,
): JsonObject[] {
  return asObjectArray(
    expectProperty(worldState, "event_cards", "WorldState"),
    "WorldState.event_cards",
  )
    .filter(
      (card) =>
        expectInteger(card, "day", "EventCardState") === currentDay &&
        hasControlBinding(card, controlBindingId, "EventCardState"),
    )
    .map((card) => ({
      event_card_id: expectString(card, "event_card_id", "EventCardState"),
      day: expectInteger(card, "day", "EventCardState"),
      title: cloneJson(expectProperty(card, "title", "EventCardState")),
      summary: cloneJson(expectProperty(card, "summary", "EventCardState")),
      event_cost: cloneJsonObject(
        expectJsonObject(
          expectProperty(card, "cost", "EventCardState"),
          "EventCardState.cost",
        ),
      ),
      status: expectString(card, "status", "EventCardState"),
    }));
}

function projectGoalPlans(
  worldState: JsonObject,
  playerEntityId: string,
): JsonObject[] {
  return asObjectArray(
    expectProperty(worldState, "goal_plans", "WorldState"),
    "WorldState.goal_plans",
  )
    .filter(
      (plan) =>
        expectString(plan, "owner_actor_id", "GoalPlan") === playerEntityId,
    )
    .map((plan) => ({
      plan_id: expectString(plan, "plan_id", "GoalPlan"),
      goal: cloneJson(expectProperty(plan, "goal", "GoalPlan")),
      status: expectString(plan, "status", "GoalPlan"),
      current_steps: asObjectArray(
        expectProperty(plan, "nodes", "GoalPlan"),
        "GoalPlan.nodes",
      )
        .filter((node) => isCurrentGoalNode(node))
        .map((node) => cloneJson(expectProperty(node, "title", "GoalNode"))),
    }));
}

function projectDialogues(
  worldState: JsonObject,
  playerEntityId: string,
): JsonObject[] {
  return asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  )
    .filter((dialogue) => dialogueIncludesEntity(dialogue, playerEntityId))
    .map((dialogue) => ({
      dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
      day: expectInteger(dialogue, "day", "DialogueRecord"),
      participants: asObjectArray(
        expectProperty(dialogue, "participants", "DialogueRecord"),
        "DialogueRecord.participants",
      ).map(projectDialogueParticipant),
      turns: asObjectArray(
        expectProperty(dialogue, "turns", "DialogueRecord"),
        "DialogueRecord.turns",
      ).map(projectDialogueTurn),
      status: expectString(dialogue, "status", "DialogueRecord"),
    }));
}

function projectDialogueTurn(turn: JsonObject): JsonObject {
  const view: Record<string, JsonValue> = {
    turn_id: expectString(turn, "turn_id", "DialogueTurn"),
    speaker: projectDialogueParticipant(
      expectJsonObject(
        expectProperty(turn, "speaker", "DialogueTurn"),
        "DialogueTurn.speaker",
      ),
    ),
    locale: expectString(turn, "locale", "DialogueTurn"),
    text: expectString(turn, "text", "DialogueTurn"),
    occurred_at: cloneJson(
      expectProperty(turn, "occurred_at", "DialogueTurn"),
    ),
  };
  if (turn.emotion_id !== undefined) {
    view.emotion_id = expectString(turn, "emotion_id", "DialogueTurn");
  }
  return view;
}

function projectDialogueParticipant(participant: JsonObject): JsonObject {
  const participantKind = expectString(
    participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind === "system") {
    return { participant_kind: "system" };
  }
  if (participantKind !== "entity") {
    throw fault(
      "world.session_view.dialogue_participant_kind",
      `Unsupported dialogue participant kind ${participantKind}`,
      { participant_kind: participantKind },
    );
  }
  const entity = expectJsonObject(
    expectProperty(participant, "entity", "DialogueParticipantRef"),
    "DialogueParticipantRef.entity",
  );
  return {
    participant_kind: "entity",
    entity: {
      world_id: expectString(entity, "world_id", "EntityRef"),
      entity_id: expectString(entity, "entity_id", "EntityRef"),
    },
  };
}

function hasControlBinding(
  source: JsonObject,
  controlBindingId: string,
  scope: string,
): boolean {
  const control = expectJsonObject(
    expectProperty(source, "control", scope),
    `${scope}.control`,
  );
  return expectString(control, "binding_id", "ControlBindingRef") === controlBindingId;
}

function dialogueIncludesEntity(
  dialogue: JsonObject,
  playerEntityId: string,
): boolean {
  return asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).some((participant) => {
    if (
      expectString(participant, "participant_kind", "DialogueParticipantRef") !==
      "entity"
    ) {
      return false;
    }
    const entity = expectJsonObject(
      expectProperty(participant, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    );
    return expectString(entity, "entity_id", "EntityRef") === playerEntityId;
  });
}

function isCurrentGoalNode(node: JsonObject): boolean {
  const state = expectString(node, "state", "GoalNode");
  return state === "blocked" || state === "available" || state === "active";
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault("world.session_view.shape", `${path} must be an array`, { path });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw fault(
        "world.session_view.shape",
        `${path}[${index}] must be an object`,
        { path: `${path}[${index}]` },
      );
    }
    return entry as JsonObject;
  });
}

function cloneCandidate(value: unknown): JsonValue {
  try {
    assertJsonValue(value, "SessionView candidate");
  } catch (error: unknown) {
    throw fault(
      "world.session_view.candidate_not_json",
      "SessionView candidate must be JSON",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return cloneJson(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value) as JsonObject;
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry));
  }
  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = cloneJson(entry);
  }
  return copy;
}

function assertEqual(
  field: string,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) {
    throw fault(
      "world.session_view.field_mismatch",
      `SessionView field ${field} mismatch`,
      { field, expected, actual },
    );
  }
}

function fault(code: string, message: string, details: JsonObject): EngineFault {
  return new EngineFault(code, message, details);
}
