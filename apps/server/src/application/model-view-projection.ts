import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

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

export function projectObjectiveTracesEmpty(): readonly JsonObject[] {
  // No WorldState collection owns objective traces in v1; empty is authoritative.
  return Object.freeze([]);
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
  const revision = expectInteger(entity, "revision", "EntityState");
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
      revision,
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
