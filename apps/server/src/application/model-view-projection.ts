import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  CommittedEventDocument,
  StateMachineContractAuthority,
  WorldContentBinding,
} from "@luoxia/world-core";

/**
 * Closed ModelRequest dialogue turn window: keep the most recent N turns only.
 * Server owns truncation; models must not invent summary structures.
 * Documented in contracts/model-protocol.v1.schema.json (ProviderDialogueView).
 */
export const MODEL_DIALOGUE_TURN_WINDOW = 24 as const;

export type DirectorWorldViewScope =
  | {
      readonly mode: "day_settlement";
      readonly keepEntityIds: ReadonlySet<string>;
    }
  | {
      readonly mode: "dialogue_related";
      readonly dialogue: JsonObject;
    };

/**
 * Project ModelRequest dynamic views from a locked WorldSnapshot only.
 * Callers never supply arbitrary View JSON. Scope is required: there is no
 * silent full-graph default.
 *
 * `dialogue_related` keeps participants + one-hop relation neighbors + related
 * facts + stages catalog + player-phase event_budget. `day_settlement` keeps
 * active entities ∪ objective trace subjects (wider than dialogue, still drops
 * retired unused noise) and omits stages/event_budget; Provider projection
 * still drops empty-component noise and objective_traces.visibility.
 */
export function projectDirectorWorldView(
  worldId: string,
  worldState: JsonObject,
  day: number,
  contentBinding: WorldContentBinding,
  stateMachineContracts: StateMachineContractAuthority,
  scope: DirectorWorldViewScope,
): JsonObject {
  const entities = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  const relations = asObjectArray(
    expectProperty(worldState, "relations", "WorldState"),
    "WorldState.relations",
  );
  const machines = asObjectArray(
    expectProperty(worldState, "state_machines", "WorldState"),
    "WorldState.state_machines",
  );
  const facts = asObjectArray(
    expectProperty(worldState, "facts", "WorldState"),
    "WorldState.facts",
  );

  const entityScope =
    scope.mode === "dialogue_related"
      ? resolveDialogueRelatedEntityScope(worldState, scope.dialogue)
      : resolveDaySettlementEntityScope(entities, scope.keepEntityIds);

  const scopedEntities = entities.filter((entity) =>
    entityScope.has(expectString(entity, "entity_id", "EntityState")),
  );
  for (const entityId of entityScope) {
    const matches = scopedEntities.filter(
      (entity) =>
        expectString(entity, "entity_id", "EntityState") === entityId,
    );
    if (matches.length !== 1) {
      throw new EngineFault(
        scope.mode === "dialogue_related"
          ? "model.view.dialogue_related_entity_missing"
          : "model.view.day_settlement_entity_missing",
        scope.mode === "dialogue_related"
          ? "Dialogue-related world_view seed entity is absent from locked WorldState"
          : "Day-settlement world_view keep-entity is absent from locked WorldState",
        { entity_id: entityId, matches: matches.length },
      );
    }
  }

  const actors = scopedEntities.map((entity) => {
    const entityId = expectString(entity, "entity_id", "EntityState");
    const components = asObjectArray(
      expectProperty(entity, "components", "EntityState"),
      "EntityState.components",
    );
    const actionMachines = machines.filter((machine) => {
      const owner = expectJsonObject(
        expectProperty(machine, "owner", "StateMachineInstanceState"),
        "StateMachineInstanceState.owner",
      );
      return (
        expectString(owner, "owner_kind", "StateMachineOwner") ===
          "character" &&
        expectString(owner, "entity_id", "StateMachineOwner") === entityId
      );
    });
    if (actionMachines.length > 1) {
      throw new EngineFault(
        "model.view.action_machine_ambiguous",
        "Entity resolves to more than one character state machine",
        { entity_id: entityId, matches: actionMachines.length },
      );
    }
    const actionMachine = actionMachines[0];
    const actor: Record<string, JsonValue> = {
      entity_id: entityId,
      status: expectString(entity, "state", "EntityState"),
      objective_components: components,
    };
    if (actionMachine !== undefined) {
      actor.action_machine = projectStateMachineModelView(
        worldId,
        actionMachine,
        contentBinding,
        stateMachineContracts,
      );
    }
    return Object.freeze(actor);
  });

  const scopedRelations = relations.filter((relation) =>
    relationEntityEndpoints(relation).every((entityId) =>
      entityScope.has(entityId),
    ),
  );

  const scopedFacts = filterScopedFacts(worldState, facts, entityScope);

  const worldMachines = machines
    .filter((machine) => {
      const owner = expectJsonObject(
        expectProperty(machine, "owner", "StateMachineInstanceState"),
        "StateMachineInstanceState.owner",
      );
      return (
        expectString(owner, "owner_kind", "StateMachineOwner") === "world"
      );
    })
    .map((machine) =>
      projectStateMachineModelView(
        worldId,
        machine,
        contentBinding,
        stateMachineContracts,
      ),
    );

  const projected: Record<string, JsonValue> = {
    day,
    actors: Object.freeze(actors),
    relations: Object.freeze(scopedRelations),
    world_machines: Object.freeze(worldMachines),
    facts: Object.freeze(scopedFacts),
  };
  // Stage catalog and EventBudget belong to EventCard / planning paths only.
  // daily_settlement omits both: budget opens only when entering player.
  if (scope.mode === "dialogue_related") {
    projected.stages = Object.freeze(projectDirectorStages(contentBinding));
    projected.event_budget = Object.freeze(
      projectDirectorEventBudget(worldState, day),
    );
  }
  return Object.freeze(projected);
}

/**
 * Day settlement keep-set: every active entity, plus any entity named as a
 * subject on the settlement-window objective_traces (even if retired).
 */
export function resolveDaySettlementKeepEntityIds(
  worldState: JsonObject,
  objectiveTraces: readonly JsonObject[],
): ReadonlySet<string> {
  const entities = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  const keep = new Set<string>();
  for (const entity of entities) {
    if (expectString(entity, "state", "EntityState") === "active") {
      keep.add(expectString(entity, "entity_id", "EntityState"));
    }
  }
  for (const [traceIndex, trace] of objectiveTraces.entries()) {
    const subjects = asObjectArray(
      expectProperty(trace, "subjects", "ObjectiveTraceEntry"),
      `ObjectiveTraceEntry[${traceIndex}].subjects`,
    );
    for (const subject of subjects) {
      const entityId = entityIdFromSubjectRef(subject);
      if (entityId !== undefined) {
        keep.add(entityId);
      }
    }
  }
  if (keep.size === 0) {
    throw new EngineFault(
      "model.view.day_settlement_entity_scope_empty",
      "Day-settlement world_view requires at least one active entity or objective-trace subject",
      {},
    );
  }
  return keep;
}

function resolveDaySettlementEntityScope(
  entities: readonly JsonObject[],
  keepEntityIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (keepEntityIds.size === 0) {
    throw new EngineFault(
      "model.view.day_settlement_entity_scope_empty",
      "Day-settlement world_view keepEntityIds must be non-empty",
      {},
    );
  }
  const known = new Set(
    entities.map((entity) =>
      expectString(entity, "entity_id", "EntityState"),
    ),
  );
  for (const entityId of keepEntityIds) {
    if (!known.has(entityId)) {
      throw new EngineFault(
        "model.view.day_settlement_entity_missing",
        "Day-settlement keepEntityIds names an entity absent from locked WorldState",
        { entity_id: entityId },
      );
    }
  }
  return keepEntityIds;
}

function projectDirectorStages(
  contentBinding: WorldContentBinding,
): readonly JsonObject[] {
  return contentBinding.stages.map((stage) => {
    const projected: Record<string, JsonValue> = {
      stage_kind: expectString(stage, "stage_kind", "StageCatalogEntry"),
      intent_coverage: expectProperty(
        stage,
        "intent_coverage",
        "StageCatalogEntry",
      ),
      participants: expectProperty(
        stage,
        "participants",
        "StageCatalogEntry",
      ),
      npc_participation: expectString(
        stage,
        "npc_participation",
        "StageCatalogEntry",
      ),
    };
    if (stage.example_intents !== undefined) {
      projected.example_intents = expectProperty(
        stage,
        "example_intents",
        "StageCatalogEntry",
      );
    }
    return Object.freeze(projected);
  });
}

/**
 * Project EventBudgetView for dialogue_related DirectorWorldView.
 * Player phase must own exactly one active human ControlBinding and its
 * current-day EventBudget (day/capacity/spent/remaining).
 */
function projectDirectorEventBudget(
  worldState: JsonObject,
  day: number,
): JsonObject {
  const controlBindingId = resolveActiveHumanControlBindingId(worldState);
  const matches = asObjectArray(
    expectProperty(worldState, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  ).filter((budget) => {
    const control = expectJsonObject(
      expectProperty(budget, "control", "EventBudgetState"),
      "EventBudgetState.control",
    );
    return (
      expectInteger(budget, "day", "EventBudgetState") === day &&
      expectString(control, "binding_id", "ControlBindingRef") ===
        controlBindingId
    );
  });
  if (matches.length !== 1) {
    throw new EngineFault(
      "model.view.event_budget_match",
      "Dialogue-related world_view requires exactly one EventBudget for the active human control and current day",
      {
        day,
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
  ).reduce((total, charge) => {
    const cost = expectJsonObject(
      expectProperty(charge, "cost", "EventCharge"),
      "EventCharge.cost",
    );
    return total + expectInteger(cost, "amount", "EventCost");
  }, 0);
  const remaining = capacity - spent;
  if (remaining < 0) {
    throw new EngineFault(
      "model.view.event_budget_negative",
      "Event budget charges exceed its capacity",
      { capacity, spent, remaining },
    );
  }
  return Object.freeze({
    day,
    capacity,
    spent,
    remaining,
  });
}

function resolveActiveHumanControlBindingId(worldState: JsonObject): string {
  const matches = asObjectArray(
    expectProperty(worldState, "control_bindings", "WorldState"),
    "WorldState.control_bindings",
  ).filter(
    (binding) =>
      expectString(binding, "binding_kind", "ControlBinding") === "human" &&
      expectString(binding, "status", "ControlBinding") === "active",
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "model.view.human_control_binding_match",
      "Dialogue-related world_view requires exactly one active human ControlBinding",
      { matches: matches.length },
    );
  }
  return expectString(
    matches[0] as JsonObject,
    "binding_id",
    "ControlBinding",
  );
}

export function projectObjectiveTraces(input: {
  readonly events: readonly CommittedEventDocument[];
  readonly currentDay: number;
}): readonly JsonObject[] {
  const eventDays = reconstructEventDays(input.events, input.currentDay);
  const settlementIndexes: number[] = [];
  for (const [index, event] of input.events.entries()) {
    const transition = findDayCycleTransition(event.value);
    if (
      transition !== undefined &&
      expectString(transition, "from_phase", "DayCycleTransitionOp") ===
        "autonomous" &&
      expectString(transition, "to_phase", "DayCycleTransitionOp") ===
        "director_settlement"
    ) {
      settlementIndexes.push(index);
    }
  }

  const currentSettlementIndex = settlementIndexes.at(-1);
  const previousSettlementIndex =
    settlementIndexes.length < 2
      ? -1
      : (settlementIndexes.at(-2) as number);
  const throughIndex =
    currentSettlementIndex === undefined
      ? input.events.length - 1
      : currentSettlementIndex;
  const traces: JsonObject[] = [];
  for (
    let eventIndex = previousSettlementIndex + 1;
    eventIndex <= throughIndex;
    eventIndex += 1
  ) {
    const event = input.events[eventIndex];
    if (event === undefined) {
      continue;
    }
    const domainEvents = asObjectArray(
      expectProperty(event.value, "domain_events", "CommittedEvent"),
      "CommittedEvent.domain_events",
    );
    for (const domainEvent of domainEvents) {
      traces.push(
        Object.freeze({
          day: eventDays[eventIndex] as number,
          event_type: expectProperty(
            domainEvent,
            "event_type",
            "DomainEvent",
          ),
          subjects: expectProperty(domainEvent, "subjects", "DomainEvent"),
          payload: expectProperty(domainEvent, "payload", "DomainEvent"),
          visibility: expectProperty(
            domainEvent,
            "visibility",
            "DomainEvent",
          ),
        }),
      );
    }
  }
  return Object.freeze(traces);
}

export function projectDialogue(
  worldState: JsonObject,
  dialogueId: string,
  options: {
    readonly turnWindow?: number;
  } = {},
): JsonObject {
  const dialogues = asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  );
  const dialogue = dialogues.find(
    (entry) =>
      expectString(entry, "dialogue_id", "DialogueRecord") === dialogueId,
  );
  if (dialogue === undefined) {
    throw new EngineFault(
      "model.view.dialogue_missing",
      `Dialogue ${dialogueId} is absent from locked WorldState`,
      { dialogue_id: dialogueId },
    );
  }
  const turnWindow = options.turnWindow ?? MODEL_DIALOGUE_TURN_WINDOW;
  if (
    !Number.isSafeInteger(turnWindow) ||
    turnWindow < 1
  ) {
    throw new EngineFault(
      "model.view.dialogue_turn_window_invalid",
      "Dialogue turn window must be a positive safe integer",
      { turn_window: turnWindow },
    );
  }
  const turns = asObjectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  if (turns.length <= turnWindow) {
    return Object.freeze({ ...dialogue });
  }
  return Object.freeze({
    ...dialogue,
    turns: Object.freeze(turns.slice(-turnWindow)),
  });
}

export function projectKnowledgeView(
  worldState: JsonObject,
  viewerEntityId: string,
): JsonObject {
  const knowledge = asObjectArray(
    expectProperty(worldState, "knowledge", "WorldState"),
    "WorldState.knowledge",
  );
  const facts = asObjectArray(
    expectProperty(worldState, "facts", "WorldState"),
    "WorldState.facts",
  );
  const knownFactIds = new Set(
    knowledge
      .filter(
        (entry) =>
          expectString(entry, "knower_entity_id", "KnowledgeState") ===
          viewerEntityId,
      )
      .map((entry) => expectString(entry, "fact_id", "KnowledgeState")),
  );
  const visibleFacts = facts.filter((fact) =>
    knownFactIds.has(expectString(fact, "fact_id", "FactRecord")),
  );

  const memoriesAll = asObjectArray(
    expectProperty(worldState, "memories", "WorldState"),
    "WorldState.memories",
  );
  const memories = memoriesAll
    .filter(
      (entry) =>
        expectString(entry, "actor_entity_id", "MemoryRecord") ===
        viewerEntityId,
    )
    .map((entry) =>
      Object.freeze({
        memory_id: expectString(entry, "memory_id", "MemoryRecord"),
        source_event_id: expectString(entry, "source_event_id", "MemoryRecord"),
        summary: expectProperty(entry, "summary", "MemoryRecord"),
        salience: entry.salience as JsonValue,
      }),
    );

  return Object.freeze({
    viewer_entity_id: viewerEntityId,
    facts: Object.freeze(visibleFacts),
    memories: Object.freeze(memories),
  });
}

export function projectCharacterSubjectiveView(
  worldId: string,
  worldState: JsonObject,
  entityId: string,
  contentBinding: WorldContentBinding,
  stateMachineContracts: StateMachineContractAuthority,
): JsonObject {
  const entities = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  const entity = entities.find(
    (entry) => expectString(entry, "entity_id", "EntityState") === entityId,
  );
  if (entity === undefined) {
    throw new EngineFault(
      "model.view.entity_missing",
      `Entity ${entityId} is absent from locked WorldState`,
      { entity_id: entityId },
    );
  }
  const machines = asObjectArray(
    expectProperty(worldState, "state_machines", "WorldState"),
    "WorldState.state_machines",
  );
  const actionMachines = machines.filter((machine) => {
    const owner = expectJsonObject(
      expectProperty(machine, "owner", "StateMachineInstanceState"),
      "StateMachineInstanceState.owner",
    );
    return (
      expectString(owner, "owner_kind", "StateMachineOwner") === "character" &&
      expectString(owner, "entity_id", "StateMachineOwner") === entityId
    );
  });
  if (actionMachines.length !== 1) {
    throw new EngineFault(
      "model.view.action_machine_invalid",
      `Entity ${entityId} must resolve to exactly one character state machine`,
      { entity_id: entityId, matches: actionMachines.length },
    );
  }
  const actionMachine = actionMachines[0] as JsonObject;
  return Object.freeze({
    character: Object.freeze({
      world_id: worldId,
      entity_id: entityId,
    }),
    knowledge_view: projectKnowledgeView(worldState, entityId),
    action_machine: projectStateMachineModelView(
      worldId,
      actionMachine,
      contentBinding,
      stateMachineContracts,
    ),
  });
}

export function readDayNumber(worldState: JsonObject): number {
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  return expectInteger(dayCycle, "day", "DayCycleState");
}

/**
 * Participants ∪ one-hop relation neighbors. System participants contribute
 * no entity seed; at least one entity participant is required.
 */
export function resolveDialogueRelatedEntityScope(
  worldState: JsonObject,
  dialogue: JsonObject,
): ReadonlySet<string> {
  const seed = dialogueParticipantEntityIds(dialogue);
  if (seed.length === 0) {
    throw new EngineFault(
      "model.view.dialogue_entity_participants_empty",
      "Dialogue-related world_view requires at least one entity participant",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
      },
    );
  }
  const seedSet = new Set(seed);
  const relations = asObjectArray(
    expectProperty(worldState, "relations", "WorldState"),
    "WorldState.relations",
  );
  const scope = new Set(seedSet);
  for (const relation of relations) {
    const endpoints = relationEntityEndpoints(relation);
    const touchesSeed = endpoints.some((entityId) => seedSet.has(entityId));
    if (!touchesSeed) {
      continue;
    }
    for (const entityId of endpoints) {
      scope.add(entityId);
    }
  }
  return scope;
}

function dialogueParticipantEntityIds(
  dialogue: JsonObject,
): readonly string[] {
  const participants = asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  );
  const entityIds: string[] = [];
  for (const [index, participant] of participants.entries()) {
    const participantKind = expectString(
      participant,
      "participant_kind",
      "DialogueParticipantRef",
    );
    if (participantKind === "system") {
      continue;
    }
    if (participantKind !== "entity") {
      throw new EngineFault(
        "model.view.dialogue_participant_kind_unknown",
        `Dialogue participant kind ${participantKind} is not supported`,
        {
          participant_index: index,
          participant_kind: participantKind,
        },
      );
    }
    const entity = expectJsonObject(
      expectProperty(participant, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    );
    entityIds.push(expectString(entity, "entity_id", "EntityRef"));
  }
  return Object.freeze(entityIds);
}

function relationEntityEndpoints(relation: JsonObject): readonly string[] {
  const endpoints: string[] = [];
  for (const side of ["from", "to"] as const) {
    const subject = expectJsonObject(
      expectProperty(relation, side, "RelationState"),
      `RelationState.${side}`,
    );
    const entityId = entityIdFromSubjectRef(subject);
    if (entityId !== undefined) {
      endpoints.push(entityId);
    }
  }
  return Object.freeze(endpoints);
}

function entityIdFromSubjectRef(subject: JsonObject): string | undefined {
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind !== "entity") {
    return undefined;
  }
  const entity = expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
  return expectString(entity, "entity_id", "EntityRef");
}

function filterScopedFacts(
  worldState: JsonObject,
  facts: readonly JsonObject[],
  entityScope: ReadonlySet<string>,
): readonly JsonObject[] {
  const knowledge = asObjectArray(
    expectProperty(worldState, "knowledge", "WorldState"),
    "WorldState.knowledge",
  );
  const knownFactIds = new Set(
    knowledge
      .filter((entry) =>
        entityScope.has(
          expectString(entry, "knower_entity_id", "KnowledgeState"),
        ),
      )
      .map((entry) => expectString(entry, "fact_id", "KnowledgeState")),
  );
  return facts.filter((fact) => {
    const factId = expectString(fact, "fact_id", "FactRecord");
    if (knownFactIds.has(factId)) {
      return true;
    }
    const visibility = expectJsonObject(
      expectProperty(fact, "visibility", "FactRecord"),
      "FactRecord.visibility",
    );
    if (visibilityTouchesEntityScope(visibility, entityScope)) {
      return true;
    }
    return jsonTreeContainsEntityId(
      expectProperty(fact, "claim", "FactRecord"),
      entityScope,
    );
  });
}

function visibilityTouchesEntityScope(
  visibility: JsonObject,
  entityScope: ReadonlySet<string>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(visibility, "actor_ids")) {
    return false;
  }
  const actorIds = expectProperty(visibility, "actor_ids", "Visibility");
  if (!Array.isArray(actorIds)) {
    throw new EngineFault(
      "model.view.visibility_actor_ids_shape",
      "Visibility.actor_ids must be an array when present",
      {},
    );
  }
  return actorIds.some(
    (entry) => typeof entry === "string" && entityScope.has(entry),
  );
}

function jsonTreeContainsEntityId(
  value: JsonValue,
  entityScope: ReadonlySet<string>,
): boolean {
  if (typeof value === "string") {
    return entityScope.has(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      jsonTreeContainsEntityId(entry as JsonValue, entityScope),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as JsonObject).some((entry) =>
      jsonTreeContainsEntityId(entry as JsonValue, entityScope),
    );
  }
  return false;
}

function projectStateMachineModelView(
  worldId: string,
  instance: JsonObject,
  contentBinding: WorldContentBinding,
  stateMachineContracts: StateMachineContractAuthority,
): JsonObject {
  const machine = stateMachineContracts.assertBoundInstance({
    contentBinding,
    worldId,
    instance,
  });
  const stateId = expectString(
    instance,
    "state_id",
    "StateMachineInstanceState",
  );
  const outgoingTransitions = machine
    .listOutgoingTransitions(stateId)
    .map((transition) =>
      Object.freeze({
        transition,
        target_state: machine.requireState(
          expectString(
            transition,
            "to_state_id",
            "MachineTransitionDefinition",
          ),
        ),
      }),
    );
  return Object.freeze({
    entered_day: expectInteger(
      instance,
      "entered_day",
      "StateMachineInstanceState",
    ),
    current_state: machine.requireState(stateId),
    outgoing_transitions: Object.freeze(outgoingTransitions),
  });
}

function reconstructEventDays(
  events: readonly CommittedEventDocument[],
  currentDay: number,
): readonly number[] {
  const days = new Array<number>(events.length);
  let dayAfter = currentDay;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as CommittedEventDocument;
    const transition = findDayCycleTransition(event.value);
    if (transition === undefined) {
      days[index] = dayAfter;
      continue;
    }
    const transitionToDay = expectInteger(
      transition,
      "to_day",
      "DayCycleTransitionOp",
    );
    if (transitionToDay !== dayAfter) {
      throw new EngineFault(
        "model.view.day_cycle_history_inconsistent",
        "Committed day-cycle transition does not connect to the current WorldState day",
        {
          event_id: expectString(event.value, "event_id", "CommittedEvent"),
          expected_to_day: dayAfter,
          actual_to_day: transitionToDay,
        },
      );
    }
    const dayBefore = expectInteger(
      transition,
      "from_day",
      "DayCycleTransitionOp",
    );
    days[index] = dayBefore;
    dayAfter = dayBefore;
  }
  return Object.freeze(days);
}

function findDayCycleTransition(
  event: JsonObject,
): JsonObject | undefined {
  const packet = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const transitions = ops.filter(
    (op) => expectString(op, "op", "EffectOp") === "day_cycle.transition",
  );
  if (transitions.length > 1) {
    throw new EngineFault(
      "model.view.day_cycle_history_inconsistent",
      "Committed packet contains more than one day-cycle transition",
      {
        event_id: expectString(event, "event_id", "CommittedEvent"),
        transition_count: transitions.length,
      },
    );
  }
  return transitions[0];
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "model.view.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
