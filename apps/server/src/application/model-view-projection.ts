import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type { CommittedEventDocument } from "@luoxia/world-core";

/**
 * Project ModelRequest dynamic views from a locked WorldSnapshot only.
 * Callers never supply arbitrary View JSON.
 */
export function projectDirectorWorldView(
  worldState: JsonObject,
  day: number,
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

  const actors = entities.map((entity) => {
    const entityId = expectString(entity, "entity_id", "EntityState");
    const components = asObjectArray(
      expectProperty(entity, "components", "EntityState"),
      "EntityState.components",
    );
    const entityRelations = relations.filter((relation) =>
      relationMentionsEntity(relation, entityId),
    );
    const actionMachine = machines.find((machine) => {
      const scope = expectString(
        machine,
        "machine_scope",
        "StateMachineInstanceState",
      );
      return (
        scope === "character" &&
        expectString(
          machine,
          "owner_entity_id",
          "StateMachineInstanceState",
        ) === entityId
      );
    });
    const actor: Record<string, JsonValue> = {
      entity_id: entityId,
      objective_components: components,
      relations: entityRelations,
    };
    if (actionMachine !== undefined) {
      actor.action_machine = actionMachine;
    }
    return Object.freeze(actor);
  });

  const worldMachines = machines.filter(
    (machine) =>
      expectString(machine, "machine_scope", "StateMachineInstanceState") ===
      "world",
  );

  return Object.freeze({
    day,
    actors: Object.freeze(actors),
    world_machines: Object.freeze(worldMachines),
    facts: Object.freeze(facts),
  });
}

export function projectObjectiveTraces(input: {
  readonly events: readonly CommittedEventDocument[];
  readonly currentDay: number;
  readonly createTraceId: () => string;
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
  const traceIds = new Set<string>();
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
      const traceId = input.createTraceId();
      if (traceIds.has(traceId)) {
        throw new EngineFault(
          "model.view.objective_trace_id_collision",
          "Server-generated ObjectiveTraceEntry identities must be unique",
          { trace_id: traceId },
        );
      }
      traceIds.add(traceId);
      traces.push(
        Object.freeze({
          trace_id: traceId,
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
  return dialogue;
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
  const actionMachine = machines.find(
    (machine) =>
      expectString(machine, "machine_scope", "StateMachineInstanceState") ===
        "character" &&
      expectString(
        machine,
        "owner_entity_id",
        "StateMachineInstanceState",
      ) === entityId,
  );
  if (actionMachine === undefined) {
    throw new EngineFault(
      "model.view.action_machine_missing",
      `Entity ${entityId} has no character state machine in locked WorldState`,
      { entity_id: entityId },
    );
  }
  return Object.freeze({
    character: Object.freeze({
      world_id: worldId,
      entity_id: entityId,
    }),
    knowledge_view: projectKnowledgeView(worldState, entityId),
    action_machine: actionMachine,
  });
}

export function readDayNumber(worldState: JsonObject): number {
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  return expectInteger(dayCycle, "day", "DayCycleState");
}

function relationMentionsEntity(
  relation: JsonObject,
  entityId: string,
): boolean {
  return (
    subjectIsEntity(
      expectJsonObject(
        expectProperty(relation, "from", "RelationState"),
        "RelationState.from",
      ),
      entityId,
    ) ||
    subjectIsEntity(
      expectJsonObject(
        expectProperty(relation, "to", "RelationState"),
        "RelationState.to",
      ),
      entityId,
    )
  );
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

function subjectIsEntity(subject: JsonObject, entityId: string): boolean {
  if (expectString(subject, "kind", "SubjectRef") !== "entity") {
    return false;
  }
  const entity = expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
  return expectString(entity, "entity_id", "EntityRef") === entityId;
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
