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
 * Project ModelRequest dynamic views from a locked WorldSnapshot only.
 * Callers never supply arbitrary View JSON.
 */
export function projectDirectorWorldView(
  worldId: string,
  worldState: JsonObject,
  day: number,
  contentBinding: WorldContentBinding,
  stateMachineContracts: StateMachineContractAuthority,
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
      status: expectString(entity, "status", "EntityState"),
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

  return Object.freeze({
    day,
    actors: Object.freeze(actors),
    relations: Object.freeze(relations),
    world_machines: Object.freeze(worldMachines),
    facts: Object.freeze(facts),
  });
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
