import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime/portable";

import type {
  ContentPacketDocument,
  PacketCommitIdentityDocument,
  PacketStateTransition,
  PacketTransitionCandidates,
  WorldSnapshotDocument,
} from "./composition.js";

/**
 * Pure ledger arithmetic over DecimalString balances.
 * Conservation, minting permission, and precision are owned by the composition root.
 */
export interface LedgerPostArithmetic {
  applyPost(input: {
    readonly ledgerId: string;
    readonly unitDefinition: JsonValue;
    readonly balances: readonly JsonObject[];
    readonly entries: readonly JsonObject[];
  }): readonly JsonObject[];
}

export interface PacketStateTransitionDependencies {
  readonly ledgerArithmetic: LedgerPostArithmetic;
}

const EFFECT_OPS = [
  "definition.register",
  "definition.retire",
  "entity.create",
  "entity.retire",
  "component.replace",
  "component.remove",
  "relation.upsert",
  "relation.remove",
  "ledger.post",
  "entity.relocate",
  "knowledge.record",
  "memory.append",
  "schedule.upsert",
  "schedule.cancel",
  "clock.advance",
  "stage.open",
  "stage.update",
  "stage.close",
  "goal_plan.upsert",
  "goal_plan.cancel",
  "materialization.request",
  "visual_binding.upsert",
  "domain_event.emit",
  "control_binding.upsert",
  "day_cycle.transition",
  "state_machine.create",
  "state_machine.set_state",
  "dialogue.open",
  "dialogue.turn.append",
  "dialogue.close",
  "event_card.publish",
  "event_card.trigger",
  "event_card.invalidate",
  "event_card.expire",
  "event_budget.open",
] as const;

type EffectOpName = (typeof EFFECT_OPS)[number];

interface TransitionContext {
  readonly worldId: string;
  readonly worldRevision: number;
  readonly committedEventId: string;
  readonly dependencies: PacketStateTransitionDependencies;
  readonly domainEventCandidates: JsonObject[];
  readonly materializationRequestCandidates: JsonObject[];
  world: MutableWorld;
}

type EffectHandler = (op: JsonObject, context: TransitionContext) => void;

interface MutableWorld {
  clock: JsonObject;
  dynamic_definitions: JsonObject[];
  entities: JsonObject[];
  relations: JsonObject[];
  ledgers: JsonObject[];
  facts: JsonObject[];
  knowledge: JsonObject[];
  memories: JsonObject[];
  schedules: JsonObject[];
  goal_plans: JsonObject[];
  stage_instances: JsonObject[];
  visual_bindings: JsonObject[];
  control_bindings: JsonObject[];
  day_cycle: JsonObject;
  state_machines: JsonObject[];
  dialogues: JsonObject[];
  event_budgets: JsonObject[];
  event_cards: JsonObject[];
}

export function createPacketStateTransition(
  dependencies: PacketStateTransitionDependencies,
): PacketStateTransition {
  return new DefaultPacketStateTransition(dependencies);
}

class DefaultPacketStateTransition implements PacketStateTransition {
  readonly #dependencies: PacketStateTransitionDependencies;

  public constructor(dependencies: PacketStateTransitionDependencies) {
    this.#dependencies = dependencies;
  }

  public apply(
    packet: ContentPacketDocument,
    snapshot: WorldSnapshotDocument,
    commitIdentity: PacketCommitIdentityDocument,
  ): PacketTransitionCandidates {
    const packetValue = packet.value;
    const snapshotValue = snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshotValue, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const worldId = expectString(snapshotValue, "world_id", "WorldSnapshot");
    const worldRevision = expectInteger(
      snapshotValue,
      "world_revision",
      "WorldSnapshot",
    );

    if (expectString(packetValue, "world_id", "ContentPacket") !== worldId) {
      throw fault(
        "world.transition.world_id_mismatch",
        "Packet world_id does not match snapshot",
        {},
      );
    }
    if (
      expectInteger(packetValue, "basis_revision", "ContentPacket") !==
      worldRevision
    ) {
      throw fault(
        "world.transition.basis_revision_mismatch",
        "Packet basis_revision does not match snapshot",
        {},
      );
    }

    const committedEventId = expectString(
      commitIdentity.value,
      "event_id",
      "PacketCommitIdentity",
    );

    const context: TransitionContext = {
      worldId,
      worldRevision,
      committedEventId,
      dependencies: this.#dependencies,
      domainEventCandidates: [],
      materializationRequestCandidates: [],
      world: cloneWorld(worldState),
    };

    const ops = asObjectArray(
      expectProperty(packetValue, "ops", "ContentPacket"),
      "ContentPacket.ops",
    );

    for (const [index, op] of ops.entries()) {
      const opName = expectString(op, "op", `ContentPacket.ops[${index}]`) as EffectOpName;
      const handler = EFFECT_HANDLERS[opName];
      if (handler === undefined) {
        throw fault(
          "world.transition.op_unknown",
          `Unknown EffectOp ${opName}`,
          { op: opName, index },
        );
      }
      try {
        handler(op, context);
      } catch (error: unknown) {
        if (error instanceof EngineFault) {
          throw error;
        }
        throw fault(
          "world.transition.op_failed",
          `EffectOp ${opName} failed at index ${index}`,
          {
            op: opName,
            index,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    return Object.freeze({
      nextWorldStateCandidate: freezeWorld(context.world),
      domainEventCandidates: Object.freeze(context.domainEventCandidates),
      materializationRequestCandidates: Object.freeze(
        context.materializationRequestCandidates,
      ),
    });
  }
}

const EFFECT_HANDLERS: { readonly [K in EffectOpName]: EffectHandler } = {
  "definition.register": (op, context) => {
    const definitionId = expectString(op, "definition_id", "DefinitionRegisterOp");
    if (findDefinition(context.world, definitionId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `Dynamic definition ${definitionId} already exists`,
        { definition_id: definitionId },
      );
    }
    const components = asObjectArray(
      expectProperty(op, "components", "DefinitionRegisterOp"),
      "DefinitionRegisterOp.components",
    );
    assertUniqueComponentKeys(components, "definition.components");
    const record: Record<string, JsonValue> = {
      definition_id: definitionId,
      revision: 1,
      definition_type: expectProperty(op, "definition_type", "DefinitionRegisterOp"),
      name: expectProperty(op, "name", "DefinitionRegisterOp"),
      components: components.map((component) => cloneJsonObject(component)),
      state: "active",
      provenance: cloneJson(
        expectProperty(op, "provenance", "DefinitionRegisterOp"),
      ),
    };
    if (op.summary !== undefined) {
      record.summary = cloneJson(op.summary);
    }
    context.world.dynamic_definitions.push(record);
  },

  "definition.retire": (op, context) => {
    const definitionRef = expectJsonObject(
      expectProperty(op, "definition", "DefinitionRetireOp"),
      "DefinitionRetireOp.definition",
    );
    assertEqual(
      "definition.kind",
      "dynamic",
      expectString(definitionRef, "kind", "DynamicDefinitionRef"),
    );
    const definitionId = expectString(
      definitionRef,
      "definition_id",
      "DynamicDefinitionRef",
    );
    const expectedRevision = expectInteger(
      definitionRef,
      "revision",
      "DynamicDefinitionRef",
    );
    const index = findDefinitionIndex(context.world, definitionId);
    if (index < 0) {
      throw missing("definition", definitionId);
    }
    const current = context.world.dynamic_definitions[index] as JsonObject;
    assertEqual(
      "definition.revision",
      expectedRevision,
      expectInteger(current, "revision", "DynamicDefinitionState"),
    );
    assertEqual(
      "definition.state",
      "active",
      expectString(current, "state", "DynamicDefinitionState"),
    );
    context.world.dynamic_definitions[index] = {
      ...cloneJsonObject(current),
      state: "retired",
      revision: expectedRevision + 1,
    };
  },

  "entity.create": (op, context) => {
    const entityId = expectString(op, "entity_id", "EntityCreateOp");
    if (findEntity(context.world, entityId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `Entity ${entityId} already exists`,
        { entity_id: entityId },
      );
    }
    const components = asObjectArray(
      expectProperty(op, "components", "EntityCreateOp"),
      "EntityCreateOp.components",
    );
    assertUniqueComponentKeys(components, "entity.components");
    const record: Record<string, JsonValue> = {
      entity_id: entityId,
      revision: 0,
      archetype: cloneJson(expectProperty(op, "archetype", "EntityCreateOp")),
      name: cloneJson(expectProperty(op, "name", "EntityCreateOp")),
      components: components.map((component) => cloneJsonObject(component)),
      state: "active",
      provenance: cloneJson(expectProperty(op, "provenance", "EntityCreateOp")),
    };
    if (op.summary !== undefined) {
      record.summary = cloneJson(op.summary);
    }
    context.world.entities.push(record);
  },

  "entity.retire": (op, context) => {
    const entityRef = expectJsonObject(
      expectProperty(op, "entity", "EntityRetireOp"),
      "EntityRetireOp.entity",
    );
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    assertEntityReferenceWorld(entityRef, context.worldId);
    const index = findEntityIndex(context.world, entityId);
    if (index < 0) {
      throw missing("entity", entityId);
    }
    const current = context.world.entities[index] as JsonObject;
    assertEntityExpectedRevision(entityRef, current);
    assertEqual(
      "entity.state",
      "active",
      expectString(current, "state", "EntityState"),
    );
    context.world.entities[index] = {
      ...cloneJsonObject(current),
      state: "retired",
      revision: expectInteger(current, "revision", "EntityState") + 1,
    };
  },

  "component.replace": (op, context) => {
    const subject = expectJsonObject(
      expectProperty(op, "subject", "ComponentReplaceOp"),
      "ComponentReplaceOp.subject",
    );
    const componentType = expectProperty(
      op,
      "component_type",
      "ComponentReplaceOp",
    );
    const ordinal = expectInteger(op, "ordinal", "ComponentReplaceOp");
    const value = cloneJson(expectProperty(op, "value", "ComponentReplaceOp"));
    mutateSubjectComponents(context, subject, (components, bump) => {
      const index = components.findIndex(
        (component) =>
          jsonEquals(
            expectProperty(component, "component_type", "ComponentValue"),
            componentType,
          ) && expectInteger(component, "ordinal", "ComponentValue") === ordinal,
      );
      if (index < 0) {
        throw fault(
          "world.transition.component_missing",
          "component.replace target component is absent",
          { ordinal },
        );
      }
      components[index] = {
        component_type: cloneJson(componentType),
        ordinal,
        value,
      };
      bump();
    });
  },

  "component.remove": (op, context) => {
    const subject = expectJsonObject(
      expectProperty(op, "subject", "ComponentRemoveOp"),
      "ComponentRemoveOp.subject",
    );
    const componentType = expectProperty(
      op,
      "component_type",
      "ComponentRemoveOp",
    );
    const ordinal = expectInteger(op, "ordinal", "ComponentRemoveOp");
    mutateSubjectComponents(context, subject, (components, bump) => {
      const index = components.findIndex(
        (component) =>
          jsonEquals(
            expectProperty(component, "component_type", "ComponentValue"),
            componentType,
          ) && expectInteger(component, "ordinal", "ComponentValue") === ordinal,
      );
      if (index < 0) {
        throw fault(
          "world.transition.component_missing",
          "component.remove target component is absent",
          { ordinal },
        );
      }
      components.splice(index, 1);
      bump();
    });
  },

  "relation.upsert": (op, context) => {
    const relationId = expectString(op, "relation_id", "RelationUpsertOp");
    assertSubjectReferenceWorld(
      expectJsonObject(
        expectProperty(op, "from", "RelationUpsertOp"),
        "RelationUpsertOp.from",
      ),
      context.worldId,
    );
    assertSubjectReferenceWorld(
      expectJsonObject(
        expectProperty(op, "to", "RelationUpsertOp"),
        "RelationUpsertOp.to",
      ),
      context.worldId,
    );
    const index = findRelationIndex(context.world, relationId);
    if (index < 0) {
      context.world.relations.push({
        relation_id: relationId,
        revision: 0,
        relation_type: cloneJson(
          expectProperty(op, "relation_type", "RelationUpsertOp"),
        ),
        from: cloneJson(expectProperty(op, "from", "RelationUpsertOp")),
        to: cloneJson(expectProperty(op, "to", "RelationUpsertOp")),
        data: cloneJson(expectProperty(op, "data", "RelationUpsertOp")),
        visibility: cloneJson(
          expectProperty(op, "visibility", "RelationUpsertOp"),
        ),
        state: "active",
        provenance: cloneJson(
          expectProperty(op, "provenance", "RelationUpsertOp"),
        ),
      });
      return;
    }
    const current = context.world.relations[index] as JsonObject;
    context.world.relations[index] = {
      ...cloneJsonObject(current),
      relation_type: cloneJson(
        expectProperty(op, "relation_type", "RelationUpsertOp"),
      ),
      from: cloneJson(expectProperty(op, "from", "RelationUpsertOp")),
      to: cloneJson(expectProperty(op, "to", "RelationUpsertOp")),
      data: cloneJson(expectProperty(op, "data", "RelationUpsertOp")),
      visibility: cloneJson(
        expectProperty(op, "visibility", "RelationUpsertOp"),
      ),
      provenance: cloneJson(
        expectProperty(op, "provenance", "RelationUpsertOp"),
      ),
      state: "active",
      revision: expectInteger(current, "revision", "RelationState") + 1,
    };
  },

  "relation.remove": (op, context) => {
    const relationId = expectString(op, "relation_id", "RelationRemoveOp");
    const index = findRelationIndex(context.world, relationId);
    if (index < 0) {
      throw missing("relation", relationId);
    }
    const current = context.world.relations[index] as JsonObject;
    assertEqual(
      "relation.state",
      "active",
      expectString(current, "state", "RelationState"),
    );
    context.world.relations[index] = {
      ...cloneJsonObject(current),
      state: "retired",
      revision: expectInteger(current, "revision", "RelationState") + 1,
    };
  },

  "ledger.post": (op, context) => {
    const ledgerId = expectString(op, "ledger_id", "LedgerPostOp");
    const transactionId = expectString(op, "transaction_id", "LedgerPostOp");
    const unitDefinition = expectProperty(
      op,
      "unit_definition",
      "LedgerPostOp",
    );
    const entries = asObjectArray(
      expectProperty(op, "entries", "LedgerPostOp"),
      "LedgerPostOp.entries",
    );
    if (entries.length < 2) {
      throw fault(
        "world.transition.ledger_entries",
        "ledger.post requires at least two entries",
        { ledger_id: ledgerId },
      );
    }
    const index = findLedgerIndex(context.world, ledgerId);
    if (index < 0) {
      throw missing("ledger", ledgerId);
    }
    const current = context.world.ledgers[index] as JsonObject;
    if (
      expectString(current, "last_transaction_id", "LedgerState") ===
      transactionId
    ) {
      throw fault(
        "world.transition.ledger_transaction_duplicate",
        `Ledger transaction ${transactionId} already applied`,
        { ledger_id: ledgerId, transaction_id: transactionId },
      );
    }
    assertJsonEqual(
      "ledger.unit_definition",
      expectProperty(current, "unit_definition", "LedgerState"),
      unitDefinition,
    );
    const balances = asObjectArray(
      expectProperty(current, "balances", "LedgerState"),
      "LedgerState.balances",
    );
    const nextBalances = context.dependencies.ledgerArithmetic.applyPost({
      ledgerId,
      unitDefinition,
      balances,
      entries,
    });
    context.world.ledgers[index] = {
      ...cloneJsonObject(current),
      balances: nextBalances.map((entry) => cloneJsonObject(entry)),
      last_transaction_id: transactionId,
    };
  },

  "entity.relocate": (op, context) => {
    const entityRef = expectJsonObject(
      expectProperty(op, "entity", "EntityRelocateOp"),
      "EntityRelocateOp.entity",
    );
    const destination = expectProperty(op, "destination", "EntityRelocateOp");
    const locationRelationType = expectProperty(
      op,
      "location_relation_type",
      "EntityRelocateOp",
    );
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    assertEntityReferenceWorld(entityRef, context.worldId);
    const destinationRef = expectJsonObject(
      destination,
      "EntityRelocateOp.destination",
    );
    assertEntityReferenceWorld(destinationRef, context.worldId);
    const destinationEntityId = expectString(
      destinationRef,
      "entity_id",
      "EntityRef",
    );
    const destinationEntity = findEntity(context.world, destinationEntityId);
    if (destinationEntity === undefined) {
      throw missing("entity", destinationEntityId);
    }
    assertEntityExpectedRevision(destinationRef, destinationEntity);
    assertEqual(
      "entity.relocate.destination.state",
      "active",
      expectString(destinationEntity, "state", "EntityState"),
    );
    const entity = findEntity(context.world, entityId);
    if (entity === undefined) {
      throw missing("entity", entityId);
    }
    assertEntityExpectedRevision(entityRef, entity);
    assertEqual(
      "entity.state",
      "active",
      expectString(entity, "state", "EntityState"),
    );

    const matches: number[] = [];
    for (const [index, relation] of context.world.relations.entries()) {
      if (expectString(relation, "state", "RelationState") !== "active") {
        continue;
      }
      if (
        !jsonEquals(
          expectProperty(relation, "relation_type", "RelationState"),
          locationRelationType,
        )
      ) {
        continue;
      }
      const from = expectJsonObject(
        expectProperty(relation, "from", "RelationState"),
        "RelationState.from",
      );
      if (subjectIsEntity(from, entityId)) {
        matches.push(index);
      }
    }
    if (matches.length === 0) {
      throw fault(
        "world.transition.relocate_relation_missing",
        `No active location relation for entity ${entityId}; cannot invent relation_id`,
        { entity_id: entityId },
      );
    }
    if (matches.length > 1) {
      throw fault(
        "world.transition.relocate_relation_ambiguous",
        `Multiple active location relations for entity ${entityId}`,
        { entity_id: entityId, count: matches.length },
      );
    }
    const relationIndex = matches[0] as number;
    const current = context.world.relations[relationIndex] as JsonObject;
    context.world.relations[relationIndex] = {
      ...cloneJsonObject(current),
      to: {
        kind: "entity",
        entity: cloneJson(destination),
      },
      revision: expectInteger(current, "revision", "RelationState") + 1,
    };
    const entityIndex = findEntityIndex(context.world, entityId);
    context.world.entities[entityIndex] = {
      ...cloneJsonObject(entity),
      revision: expectInteger(entity, "revision", "EntityState") + 1,
    };
  },

  "knowledge.record": (op, context) => {
    const knower = expectJsonObject(
      expectProperty(op, "knower", "KnowledgeRecordOp"),
      "KnowledgeRecordOp.knower",
    );
    const knowerEntityId = expectString(knower, "entity_id", "EntityRef");
    assertEntityReferenceWorld(knower, context.worldId);
    const knowerIndex = findEntityIndex(context.world, knowerEntityId);
    if (knowerIndex < 0) {
      throw missing("entity", knowerEntityId);
    }
    const knowerState = context.world.entities[knowerIndex] as JsonObject;
    assertEntityExpectedRevision(knower, knowerState);
    assertEqual(
      "knowledge.knower.state",
      "active",
      expectString(knowerState, "state", "EntityState"),
    );

    const fact = cloneJsonObject(
      expectJsonObject(
        expectProperty(op, "fact", "KnowledgeRecordOp"),
        "KnowledgeRecordOp.fact",
      ),
    );
    const factId = expectString(fact, "fact_id", "FactRecord");
    const factIndex = findFactIndex(context.world, factId);
    if (factIndex < 0) {
      context.world.facts.push(fact);
    } else if (!jsonEquals(context.world.facts[factIndex] as JsonObject, fact)) {
      throw fault(
        "world.transition.fact_conflict",
        `Fact ${factId} already exists with different content`,
        { fact_id: factId },
      );
    }

    const confidence = expectNumber(op, "confidence", "KnowledgeRecordOp");
    const knowledgeIndex = findKnowledgeIndex(
      context.world,
      knowerEntityId,
      factId,
    );
    const nextKnowledge = {
      knower_entity_id: knowerEntityId,
      fact_id: factId,
      confidence,
    };
    if (knowledgeIndex < 0) {
      context.world.knowledge.push(nextKnowledge);
      return;
    }
    context.world.knowledge[knowledgeIndex] = nextKnowledge;
  },

  "memory.append": (op, context) => {
    const actor = expectJsonObject(
      expectProperty(op, "actor", "MemoryAppendOp"),
      "MemoryAppendOp.actor",
    );
    const actorEntityId = expectString(actor, "entity_id", "EntityRef");
    assertEntityReferenceWorld(actor, context.worldId);
    const actorIndex = findEntityIndex(context.world, actorEntityId);
    if (actorIndex < 0) {
      throw missing("entity", actorEntityId);
    }
    const actorState = context.world.entities[actorIndex] as JsonObject;
    assertEntityExpectedRevision(actor, actorState);
    assertEqual(
      "memory.actor.state",
      "active",
      expectString(actorState, "state", "EntityState"),
    );

    const memoryId = expectString(op, "memory_id", "MemoryAppendOp");
    if (findMemoryIndex(context.world, memoryId) >= 0) {
      throw fault(
        "world.transition.duplicate_id",
        `Memory ${memoryId} already exists`,
        { memory_id: memoryId },
      );
    }
    context.world.memories.push({
      memory_id: memoryId,
      actor_entity_id: actorEntityId,
      source_event_id: expectString(op, "source_event_id", "MemoryAppendOp"),
      summary: cloneJson(expectProperty(op, "summary", "MemoryAppendOp")),
      salience: expectNumber(op, "salience", "MemoryAppendOp"),
      visibility: cloneJson(
        expectProperty(op, "visibility", "MemoryAppendOp"),
      ),
    });
  },

  "schedule.upsert": (op, context) => {
    const scheduleId = expectString(op, "schedule_id", "ScheduleUpsertOp");
    assertSubjectReferenceWorld(
      expectJsonObject(
        expectProperty(op, "owner", "ScheduleUpsertOp"),
        "ScheduleUpsertOp.owner",
      ),
      context.worldId,
    );
    const next: JsonObject = {
      schedule_id: scheduleId,
      owner: cloneJson(expectProperty(op, "owner", "ScheduleUpsertOp")),
      due: cloneJson(expectProperty(op, "due", "ScheduleUpsertOp")),
      signal_type: expectString(op, "signal_type", "ScheduleUpsertOp"),
      payload: cloneJson(expectProperty(op, "payload", "ScheduleUpsertOp")),
      status: "active",
    };
    const index = findScheduleIndex(context.world, scheduleId);
    if (index < 0) {
      context.world.schedules.push(next);
      return;
    }
    context.world.schedules[index] = next;
  },

  "schedule.cancel": (op, context) => {
    const scheduleId = expectString(op, "schedule_id", "ScheduleCancelOp");
    const index = findScheduleIndex(context.world, scheduleId);
    if (index < 0) {
      throw missing("schedule", scheduleId);
    }
    const current = context.world.schedules[index] as JsonObject;
    assertEqual(
      "schedule.status",
      "active",
      expectString(current, "status", "ScheduleState"),
    );
    context.world.schedules[index] = {
      ...cloneJsonObject(current),
      status: "cancelled",
      cancel_reason_code: expectString(
        op,
        "reason_code",
        "ScheduleCancelOp",
      ),
    };
  },

  "clock.advance": (op, context) => {
    const clockId = expectString(op, "clock_id", "ClockAdvanceOp");
    const fromTick = expectInteger(op, "from_tick", "ClockAdvanceOp");
    const toTick = expectInteger(op, "to_tick", "ClockAdvanceOp");
    if (toTick <= fromTick) {
      throw fault(
        "world.transition.clock_order",
        "clock.advance requires to_tick > from_tick",
        { from_tick: fromTick, to_tick: toTick },
      );
    }
    const clock = context.world.clock;
    assertEqual(
      "clock.clock_id",
      clockId,
      expectString(clock, "clock_id", "LogicalTime"),
    );
    assertEqual(
      "clock.from_tick",
      fromTick,
      expectInteger(clock, "tick", "LogicalTime"),
    );
    const next: Record<string, JsonValue> = {
      ...cloneJsonObject(clock),
      tick: toTick,
    };
    context.world.clock = next;
  },

  "stage.open": (op, context) => {
    const stageInstanceId = expectString(
      op,
      "stage_instance_id",
      "StageOpenOp",
    );
    if (findStage(context.world, stageInstanceId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `Stage instance ${stageInstanceId} already exists`,
        { stage_instance_id: stageInstanceId },
      );
    }
    const participants = asObjectArray(
      expectProperty(op, "participants", "StageOpenOp"),
      "StageOpenOp.participants",
    );
    assertUniqueEntityReferences(participants, "stage.participants");
    for (const participant of participants) {
      assertEntityReferenceWorld(participant, context.worldId);
      assertActiveEntityId(
        context.world,
        expectString(participant, "entity_id", "EntityRef"),
        "stage.participant",
      );
    }
    context.world.stage_instances.push({
      stage_instance_id: stageInstanceId,
      revision: 0,
      stage_module_lock: cloneJson(
        expectProperty(op, "stage_module_lock", "StageOpenOp"),
      ),
      scene_id: expectString(op, "scene_id", "StageOpenOp"),
      participants: participants.map((participant) => cloneJsonObject(participant)),
      state: cloneJson(expectProperty(op, "state", "StageOpenOp")),
      status: "open",
      completion_rules: cloneJson(
        expectProperty(op, "completion_rules", "StageOpenOp"),
      ),
    });
  },

  "stage.update": (op, context) => {
    const stageInstanceId = expectString(
      op,
      "stage_instance_id",
      "StageUpdateOp",
    );
    const expectedRevision = expectInteger(op, "revision", "StageUpdateOp");
    const index = findStageIndex(context.world, stageInstanceId);
    if (index < 0) {
      throw missing("stage", stageInstanceId);
    }
    const current = context.world.stage_instances[index] as JsonObject;
    assertEqual(
      "stage.status",
      "open",
      expectString(current, "status", "StageInstanceState"),
    );
    assertEqual(
      "stage.revision",
      expectedRevision,
      expectInteger(current, "revision", "StageInstanceState"),
    );
    context.world.stage_instances[index] = {
      ...cloneJsonObject(current),
      state: cloneJson(expectProperty(op, "state", "StageUpdateOp")),
      revision: expectedRevision + 1,
    };
  },

  "stage.close": (op, context) => {
    const stageInstanceId = expectString(
      op,
      "stage_instance_id",
      "StageCloseOp",
    );
    const expectedRevision = expectInteger(op, "revision", "StageCloseOp");
    const index = findStageIndex(context.world, stageInstanceId);
    if (index < 0) {
      throw missing("stage", stageInstanceId);
    }
    const current = context.world.stage_instances[index] as JsonObject;
    assertEqual(
      "stage.status",
      "open",
      expectString(current, "status", "StageInstanceState"),
    );
    assertEqual(
      "stage.revision",
      expectedRevision,
      expectInteger(current, "revision", "StageInstanceState"),
    );
    context.world.stage_instances[index] = {
      ...cloneJsonObject(current),
      status: "closed",
      revision: expectedRevision + 1,
      state: {
        ...cloneJsonObject(
          expectJsonObject(
            expectProperty(current, "state", "StageInstanceState"),
            "StageInstanceState.state",
          ),
        ),
        close_outcome_type: expectString(
          op,
          "outcome_type",
          "StageCloseOp",
        ),
        close_outcome: cloneJson(expectProperty(op, "outcome", "StageCloseOp")),
      },
    };
  },

  "goal_plan.upsert": (op, context) => {
    const goalPlan = expectJsonObject(
      expectProperty(op, "goal_plan", "GoalPlanUpsertOp"),
      "GoalPlanUpsertOp.goal_plan",
    );
    const expectedRevision = expectInteger(
      op,
      "expected_revision",
      "GoalPlanUpsertOp",
    );
    assertEqual(
      "goal_plan.world_id",
      context.worldId,
      expectString(goalPlan, "world_id", "GoalPlan"),
    );
    assertActiveEntityId(
      context.world,
      expectString(goalPlan, "owner_actor_id", "GoalPlan"),
      "goal_plan.owner",
    );
    const planId = expectString(goalPlan, "plan_id", "GoalPlan");
    const index = findGoalPlanIndex(context.world, planId);
    if (expectedRevision === 0) {
      if (index >= 0) {
        throw fault(
          "world.transition.duplicate_id",
          `GoalPlan ${planId} already exists`,
          { plan_id: planId },
        );
      }
      assertEqual(
        "goal_plan.revision",
        1,
        expectInteger(goalPlan, "revision", "GoalPlan"),
      );
      context.world.goal_plans.push(cloneJsonObject(goalPlan));
      return;
    }
    if (index < 0) {
      throw missing("goal_plan", planId);
    }
    const current = context.world.goal_plans[index] as JsonObject;
    assertEqual(
      "goal_plan.expected_revision",
      expectedRevision,
      expectInteger(current, "revision", "GoalPlan"),
    );
    assertEqual(
      "goal_plan.next_revision",
      expectedRevision + 1,
      expectInteger(goalPlan, "revision", "GoalPlan"),
    );
    context.world.goal_plans[index] = cloneJsonObject(goalPlan);
  },

  "goal_plan.cancel": (op, context) => {
    const planId = expectString(op, "goal_plan_id", "GoalPlanCancelOp");
    const index = findGoalPlanIndex(context.world, planId);
    if (index < 0) {
      throw missing("goal_plan", planId);
    }
    const current = context.world.goal_plans[index] as JsonObject;
    const status = expectString(current, "status", "GoalPlan");
    if (status === "cancelled" || status === "completed" || status === "failed") {
      throw fault(
        "world.transition.goal_plan_terminal",
        `GoalPlan ${planId} is already terminal (${status})`,
        { plan_id: planId, status },
      );
    }
    context.world.goal_plans[index] = {
      ...cloneJsonObject(current),
      status: "cancelled",
      revision: expectInteger(current, "revision", "GoalPlan") + 1,
    };
  },

  "materialization.request": (op, context) => {
    const draft = expectJsonObject(
      expectProperty(op, "request", "MaterializationRequestOp"),
      "MaterializationRequestOp.request",
    );
    const requestId = expectString(
      draft,
      "request_id",
      "MaterializationRequestDraft",
    );
    assertEqual(
      "materialization_request.world_id",
      context.worldId,
      expectString(draft, "world_id", "MaterializationRequestDraft"),
    );
    assertSubjectReferenceWorld(
      expectJsonObject(
        expectProperty(draft, "subject", "MaterializationRequestDraft"),
        "MaterializationRequestDraft.subject",
      ),
      context.worldId,
    );
    if (
      context.materializationRequestCandidates.some(
        (candidate) =>
          expectString(candidate, "request_id", "MaterializationRequest") ===
          requestId,
      )
    ) {
      throw fault(
        "world.transition.duplicate_id",
        `Materialization request ${requestId} appears more than once in one packet`,
        { request_id: requestId },
      );
    }
    context.materializationRequestCandidates.push({
      contract_version: "materialization.v1",
      record_type: "materialization.request",
      ...cloneJsonObject(draft),
      requested_by_event_id: context.committedEventId,
      status: "pending",
    });
  },

  "visual_binding.upsert": (op, context) => {
    const draft = expectJsonObject(
      expectProperty(op, "binding", "VisualBindingUpsertOp"),
      "VisualBindingUpsertOp.binding",
    );
    const bindingId = expectString(draft, "binding_id", "VisualBindingDraft");
    assertEqual(
      "visual_binding.world_id",
      context.worldId,
      expectString(draft, "world_id", "VisualBindingDraft"),
    );
    assertSubjectReferenceWorld(
      expectJsonObject(
        expectProperty(draft, "subject", "VisualBindingDraft"),
        "VisualBindingDraft.subject",
      ),
      context.worldId,
    );
    const binding: Record<string, JsonValue> = {
      contract_version: "materialization.v1",
      record_type: "visual.binding",
      binding_id: bindingId,
      world_id: expectString(draft, "world_id", "VisualBindingDraft"),
      subject: cloneJson(expectProperty(draft, "subject", "VisualBindingDraft")),
      subject_revision: expectInteger(
        draft,
        "subject_revision",
        "VisualBindingDraft",
      ),
      slot_id: expectString(draft, "slot_id", "VisualBindingDraft"),
      asset: cloneJson(expectProperty(draft, "asset", "VisualBindingDraft")),
      scope: "session",
      created_by_event_id: context.committedEventId,
      state: "active",
    };
    if (draft.source_request_id !== undefined) {
      binding.source_request_id = expectString(
        draft,
        "source_request_id",
        "VisualBindingDraft",
      );
      binding.acceptance_id = expectString(
        draft,
        "acceptance_id",
        "VisualBindingDraft",
      );
    }
    const index = context.world.visual_bindings.findIndex(
      (entry) =>
        expectString(entry, "binding_id", "VisualBinding") === bindingId,
    );
    if (index < 0) {
      context.world.visual_bindings.push(binding);
      return;
    }
    context.world.visual_bindings[index] = binding;
  },

  "domain_event.emit": (op, context) => {
    context.domainEventCandidates.push({
      event_type: expectString(op, "event_type", "DomainEventEmitOp"),
      subjects: cloneJson(
        expectProperty(op, "subjects", "DomainEventEmitOp"),
      ),
      payload: cloneJson(expectProperty(op, "payload", "DomainEventEmitOp")),
      visibility: cloneJson(
        expectProperty(op, "visibility", "DomainEventEmitOp"),
      ),
    });
  },

  "control_binding.upsert": (op, context) => {
    const binding = expectJsonObject(
      expectProperty(op, "binding", "ControlBindingUpsertOp"),
      "ControlBindingUpsertOp.binding",
    );
    const bindingId = expectString(binding, "binding_id", "ControlBinding");
    assertActiveEntityId(
      context.world,
      expectString(binding, "entity_id", "ControlBinding"),
      "control_binding.entity",
    );
    const index = context.world.control_bindings.findIndex(
      (entry) =>
        expectString(entry, "binding_id", "ControlBinding") === bindingId,
    );
    if (index < 0) {
      context.world.control_bindings.push(cloneJsonObject(binding));
      return;
    }
    context.world.control_bindings[index] = cloneJsonObject(binding);
  },

  "day_cycle.transition": (op, context) => {
    const dayCycle = context.world.day_cycle;
    assertEqual(
      "day_cycle.from_day",
      expectInteger(op, "from_day", "DayCycleTransitionOp"),
      expectInteger(dayCycle, "day", "DayCycleState"),
    );
    assertEqual(
      "day_cycle.from_phase",
      expectString(op, "from_phase", "DayCycleTransitionOp"),
      expectString(dayCycle, "phase", "DayCycleState"),
    );
    context.world.day_cycle = {
      day: expectInteger(op, "to_day", "DayCycleTransitionOp"),
      phase: expectString(op, "to_phase", "DayCycleTransitionOp"),
      phase_revision:
        expectInteger(dayCycle, "phase_revision", "DayCycleState") + 1,
    };
  },

  "state_machine.create": (op, context) => {
    const instance = expectJsonObject(
      expectProperty(op, "instance", "StateMachineCreateOp"),
      "StateMachineCreateOp.instance",
    );
    const instanceId = expectString(
      instance,
      "instance_id",
      "StateMachineInstanceState",
    );
    if (findStateMachine(context.world, instanceId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `State machine instance ${instanceId} already exists`,
        { instance_id: instanceId },
      );
    }
    assertEqual(
      "state_machine.revision",
      0,
      expectInteger(instance, "revision", "StateMachineInstanceState"),
    );
    assertUniqueFrameIds(
      asObjectArray(
        expectProperty(instance, "frames", "StateMachineInstanceState"),
        "StateMachineInstanceState.frames",
      ),
    );
    const machineScope = expectString(
      instance,
      "machine_scope",
      "StateMachineInstanceState",
    );
    if (machineScope === "character") {
      assertActiveEntityId(
        context.world,
        expectString(instance, "owner_entity_id", "StateMachineInstanceState"),
        "state_machine.owner",
      );
    } else if (machineScope === "world") {
      assertEqual(
        "state_machine.world_id",
        context.worldId,
        expectString(instance, "world_id", "StateMachineInstanceState"),
      );
    } else {
      throw fault(
        "world.transition.state_machine_scope",
        `Unsupported state machine scope ${machineScope}`,
        { machine_scope: machineScope },
      );
    }
    context.world.state_machines.push(cloneJsonObject(instance));
  },

  "state_machine.set_state": (op, context) => {
    const instanceId = expectString(
      op,
      "machine_instance_id",
      "StateMachineSetStateOp",
    );
    const index = findStateMachineIndex(context.world, instanceId);
    if (index < 0) {
      throw missing("state_machine", instanceId);
    }
    const current = context.world.state_machines[index] as JsonObject;
    const frames = asObjectArray(
      expectProperty(current, "frames", "StateMachineInstanceState"),
      "StateMachineInstanceState.frames",
    );
    if (frames.length === 0) {
      throw fault(
        "world.transition.state_machine_frames_empty",
        `State machine ${instanceId} has no frames`,
        { instance_id: instanceId },
      );
    }
    // Op has no frame_id; update the top frame in place (no ID minting).
    const top = frames[frames.length - 1] as JsonObject;
    const nextTop: Record<string, JsonValue> = {
      ...cloneJsonObject(top),
      state: cloneJson(expectProperty(op, "state", "StateMachineSetStateOp")),
      tenure: cloneJson(expectProperty(op, "tenure", "StateMachineSetStateOp")),
      continuation: cloneJson(
        expectProperty(op, "continuation", "StateMachineSetStateOp"),
      ),
      entered_day: expectInteger(
        context.world.day_cycle,
        "day",
        "DayCycleState",
      ),
    };
    const nextFrames = [
      ...frames.slice(0, -1).map((frame) => cloneJsonObject(frame)),
      nextTop,
    ];
    context.world.state_machines[index] = {
      ...cloneJsonObject(current),
      frames: nextFrames,
      revision: expectInteger(current, "revision", "StateMachineInstanceState") + 1,
    };
  },

  "dialogue.open": (op, context) => {
    const dialogueId = expectString(op, "dialogue_id", "DialogueOpenOp");
    if (findDialogue(context.world, dialogueId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `Dialogue ${dialogueId} already exists`,
        { dialogue_id: dialogueId },
      );
    }
    const firstTurn = cloneJsonObject(
      expectJsonObject(
        expectProperty(op, "first_turn", "DialogueOpenOp"),
        "DialogueOpenOp.first_turn",
      ),
    );
    assertDialogueParticipants(
      context.world,
      context.worldId,
      asObjectArray(
        expectProperty(op, "participants", "DialogueOpenOp"),
        "DialogueOpenOp.participants",
      ),
    );
    context.world.dialogues.push({
      dialogue_id: dialogueId,
      day: expectInteger(op, "day", "DialogueOpenOp"),
      participants: cloneJson(
        expectProperty(op, "participants", "DialogueOpenOp"),
      ),
      turns: [firstTurn],
      status: "active",
      revision: 1,
    });
  },

  "dialogue.turn.append": (op, context) => {
    const dialogueId = expectString(op, "dialogue_id", "DialogueTurnAppendOp");
    const expectedRevision = expectInteger(
      op,
      "expected_revision",
      "DialogueTurnAppendOp",
    );
    const index = findDialogueIndex(context.world, dialogueId);
    if (index < 0) {
      throw missing("dialogue", dialogueId);
    }
    const current = context.world.dialogues[index] as JsonObject;
    assertEqual(
      "dialogue.status",
      "active",
      expectString(current, "status", "DialogueRecord"),
    );
    assertEqual(
      "dialogue.revision",
      expectedRevision,
      expectInteger(current, "revision", "DialogueRecord"),
    );
    const turns = asObjectArray(
      expectProperty(current, "turns", "DialogueRecord"),
      "DialogueRecord.turns",
    );
    const turn = expectJsonObject(
      expectProperty(op, "turn", "DialogueTurnAppendOp"),
      "DialogueTurnAppendOp.turn",
    );
    const turnId = expectString(turn, "turn_id", "DialogueTurn");
    if (
      turns.some(
        (entry) => expectString(entry, "turn_id", "DialogueTurn") === turnId,
      )
    ) {
      throw fault(
        "world.transition.duplicate_id",
        `Dialogue turn ${turnId} already exists`,
        { dialogue_id: dialogueId, turn_id: turnId },
      );
    }
    context.world.dialogues[index] = {
      ...cloneJsonObject(current),
      turns: [...turns.map((entry) => cloneJsonObject(entry)), cloneJsonObject(turn)],
      revision: expectedRevision + 1,
    };
  },

  "dialogue.close": (op, context) => {
    const dialogueId = expectString(op, "dialogue_id", "DialogueCloseOp");
    const expectedRevision = expectInteger(
      op,
      "expected_revision",
      "DialogueCloseOp",
    );
    const index = findDialogueIndex(context.world, dialogueId);
    if (index < 0) {
      throw missing("dialogue", dialogueId);
    }
    const current = context.world.dialogues[index] as JsonObject;
    assertEqual(
      "dialogue.status",
      "active",
      expectString(current, "status", "DialogueRecord"),
    );
    assertEqual(
      "dialogue.revision",
      expectedRevision,
      expectInteger(current, "revision", "DialogueRecord"),
    );
    context.world.dialogues[index] = {
      ...cloneJsonObject(current),
      status: "closed",
      revision: expectedRevision + 1,
    };
  },

  "event_card.publish": (op, context) => {
    const eventCardId = expectString(op, "event_card_id", "EventCardPublishOp");
    if (findEventCard(context.world, eventCardId) !== undefined) {
      throw fault(
        "world.transition.duplicate_id",
        `Event card ${eventCardId} already exists`,
        { event_card_id: eventCardId },
      );
    }
    const control = expectJsonObject(
      expectProperty(op, "control", "EventCardPublishOp"),
      "EventCardPublishOp.control",
    );
    const day = expectInteger(op, "day", "EventCardPublishOp");
    const cost = expectJsonObject(
      expectProperty(op, "cost", "EventCardPublishOp"),
      "EventCardPublishOp.cost",
    );
    const chargeId = expectString(op, "charge_id", "EventCardPublishOp");
    const amount = expectInteger(cost, "amount", "EventCost");
    if (amount < 1) {
      throw fault(
        "world.transition.event_card_cost",
        "EventCard cost.amount must be positive",
        { amount },
      );
    }

    const budgetIndex = context.world.event_budgets.findIndex((budget) => {
      return (
        expectInteger(budget, "day", "EventBudgetState") === day &&
        jsonEquals(
          expectProperty(budget, "control", "EventBudgetState"),
          control,
        )
      );
    });
    if (budgetIndex < 0) {
      throw fault(
        "world.transition.event_budget_missing",
        "No EventBudget for control and day when publishing EventCard",
        { day },
      );
    }
    const budget = context.world.event_budgets[budgetIndex] as JsonObject;
    const charges = asObjectArray(
      expectProperty(budget, "charges", "EventBudgetState"),
      "EventBudgetState.charges",
    );
    if (
      context.world.event_budgets.some((budget) =>
        asObjectArray(
          expectProperty(budget, "charges", "EventBudgetState"),
          "EventBudgetState.charges",
        ).some(
          (charge) =>
            expectString(charge, "charge_id", "EventCharge") === chargeId,
        ),
      )
    ) {
      throw fault(
        "world.transition.duplicate_id",
        `Event charge ${chargeId} already exists`,
        { charge_id: chargeId },
      );
    }
    const spent = charges.reduce(
      (sum, charge) =>
        sum +
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
    const capacity = expectInteger(budget, "capacity", "EventBudgetState");
    if (spent + amount > capacity) {
      throw fault(
        "world.transition.event_budget_exceeded",
        "EventCard charge exceeds remaining EventBudget capacity",
        { capacity, spent, amount },
      );
    }

    context.world.event_cards.push({
      event_card_id: eventCardId,
      source_proposal_id: expectString(
        op,
        "source_proposal_id",
        "EventCardPublishOp",
      ),
      source_dialogue_id: expectString(
        op,
        "source_dialogue_id",
        "EventCardPublishOp",
      ),
      day,
      title: cloneJson(expectProperty(op, "title", "EventCardPublishOp")),
      summary: cloneJson(expectProperty(op, "summary", "EventCardPublishOp")),
      sealed_result: cloneJson(
        expectProperty(op, "sealed_result", "EventCardPublishOp"),
      ),
      control: cloneJsonObject(control),
      charge_id: chargeId,
      cost: cloneJsonObject(cost),
      status: "available",
      published_revision: context.worldRevision + 1,
    });

    context.world.event_budgets[budgetIndex] = {
      ...cloneJsonObject(budget),
      charges: [
        ...charges.map((charge) => cloneJsonObject(charge)),
        {
          charge_id: chargeId,
          event_card_id: eventCardId,
          cost: cloneJsonObject(cost),
        },
      ],
    };
  },

  "event_card.trigger": (op, context) => {
    const eventCardId = expectString(op, "event_card_id", "EventCardTriggerOp");
    const index = findEventCardIndex(context.world, eventCardId);
    if (index < 0) {
      throw missing("event_card", eventCardId);
    }
    const current = context.world.event_cards[index] as JsonObject;
    assertEqual(
      "event_card.status",
      "available",
      expectString(current, "status", "EventCardState"),
    );
    assertJsonEqual(
      "event_card.control",
      expectProperty(current, "control", "EventCardState"),
      expectProperty(op, "control", "EventCardTriggerOp"),
    );
    assertEqual(
      "event_card.day",
      expectInteger(op, "day", "EventCardTriggerOp"),
      expectInteger(current, "day", "EventCardState"),
    );
    const sealed = expectJsonObject(
      expectProperty(current, "sealed_result", "EventCardState"),
      "EventCardState.sealed_result",
    );
    assertEqual(
      "event_card.sealed_result_digest",
      expectString(op, "sealed_result_digest", "EventCardTriggerOp"),
      expectString(sealed, "result_digest", "SealedEventResult"),
    );
    context.world.event_cards[index] = {
      ...cloneJsonObject(current),
      status: "triggered",
      terminal_revision: context.worldRevision + 1,
      triggered_event_id: context.committedEventId,
    };
  },

  "event_card.expire": (op, context) => {
    const eventCardId = expectString(op, "event_card_id", "EventCardExpireOp");
    const index = findEventCardIndex(context.world, eventCardId);
    if (index < 0) {
      throw missing("event_card", eventCardId);
    }
    const current = context.world.event_cards[index] as JsonObject;
    assertEqual(
      "event_card.status",
      "available",
      expectString(current, "status", "EventCardState"),
    );
    assertJsonEqual(
      "event_card.control",
      expectProperty(current, "control", "EventCardState"),
      expectProperty(op, "control", "EventCardExpireOp"),
    );
    assertEqual(
      "event_card.expected_card_day",
      expectInteger(op, "expected_card_day", "EventCardExpireOp"),
      expectInteger(current, "day", "EventCardState"),
    );
    context.world.event_cards[index] = {
      ...cloneJsonObject(current),
      status: "expired",
      terminal_revision: context.worldRevision + 1,
    };
  },

  "event_card.invalidate": (op, context) => {
    const eventCardId = expectString(
      op,
      "event_card_id",
      "EventCardInvalidateOp",
    );
    const index = findEventCardIndex(context.world, eventCardId);
    if (index < 0) {
      throw missing("event_card", eventCardId);
    }
    const current = context.world.event_cards[index] as JsonObject;
    assertEqual(
      "event_card.status",
      "available",
      expectString(current, "status", "EventCardState"),
    );
    assertJsonEqual(
      "event_card.control",
      expectProperty(current, "control", "EventCardState"),
      expectProperty(op, "control", "EventCardInvalidateOp"),
    );
    context.world.event_cards[index] = {
      ...cloneJsonObject(current),
      status: "invalidated",
      terminal_revision: context.worldRevision + 1,
      invalidation_code: expectString(
        op,
        "reason_code",
        "EventCardInvalidateOp",
      ),
    };
  },

  "event_budget.open": (op, context) => {
    const budgetId = expectString(op, "budget_id", "EventBudgetOpenOp");
    const day = expectInteger(op, "day", "EventBudgetOpenOp");
    const control = expectProperty(op, "control", "EventBudgetOpenOp");
    if (
      context.world.event_budgets.some(
        (budget) =>
          expectString(budget, "budget_id", "EventBudgetState") === budgetId,
      )
    ) {
      throw fault(
        "world.transition.duplicate_id",
        `EventBudget ${budgetId} already exists`,
        { budget_id: budgetId },
      );
    }
    if (
      context.world.event_budgets.some(
        (budget) =>
          expectInteger(budget, "day", "EventBudgetState") === day &&
          jsonEquals(
            expectProperty(budget, "control", "EventBudgetState"),
            control,
          ),
      )
    ) {
      throw fault(
        "world.transition.event_budget_duplicate_day",
        "EventBudget already open for control and day",
        { day },
      );
    }
    context.world.event_budgets.push({
      budget_id: budgetId,
      control: cloneJson(control),
      day,
      capacity: expectInteger(op, "capacity", "EventBudgetOpenOp"),
      charges: [],
    });
  },
};

function mutateSubjectComponents(
  context: TransitionContext,
  subject: JsonObject,
  mutator: (components: JsonObject[], bump: () => void) => void,
): void {
  assertSubjectReferenceWorld(subject, context.worldId);
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind === "entity") {
    const entityRef = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    const index = findEntityIndex(context.world, entityId);
    if (index < 0) {
      throw missing("entity", entityId);
    }
    const current = context.world.entities[index] as JsonObject;
    assertEntityExpectedRevision(entityRef, current);
    assertEqual(
      "entity.state",
      "active",
      expectString(current, "state", "EntityState"),
    );
    const components = asObjectArray(
      expectProperty(current, "components", "EntityState"),
      "EntityState.components",
    ).map((component) => cloneJsonObject(component));
    let bumped = false;
    mutator(components, () => {
      bumped = true;
    });
    if (!bumped) {
      throw fault(
        "world.transition.internal",
        "component mutation did not bump subject",
        {},
      );
    }
    context.world.entities[index] = {
      ...cloneJsonObject(current),
      components,
      revision: expectInteger(current, "revision", "EntityState") + 1,
    };
    return;
  }
  if (kind === "definition") {
    const definitionRef = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    assertEqual(
      "definition.kind",
      "dynamic",
      expectString(definitionRef, "kind", "DefinitionRef"),
    );
    const definitionId = expectString(
      definitionRef,
      "definition_id",
      "DynamicDefinitionRef",
    );
    const expectedRevision = expectInteger(
      definitionRef,
      "revision",
      "DynamicDefinitionRef",
    );
    const index = findDefinitionIndex(context.world, definitionId);
    if (index < 0) {
      throw missing("definition", definitionId);
    }
    const current = context.world.dynamic_definitions[index] as JsonObject;
    assertEqual(
      "definition.revision",
      expectedRevision,
      expectInteger(current, "revision", "DynamicDefinitionState"),
    );
    assertEqual(
      "definition.state",
      "active",
      expectString(current, "state", "DynamicDefinitionState"),
    );
    const components = asObjectArray(
      expectProperty(current, "components", "DynamicDefinitionState"),
      "DynamicDefinitionState.components",
    ).map((component) => cloneJsonObject(component));
    let bumped = false;
    mutator(components, () => {
      bumped = true;
    });
    if (!bumped) {
      throw fault(
        "world.transition.internal",
        "component mutation did not bump subject",
        {},
      );
    }
    context.world.dynamic_definitions[index] = {
      ...cloneJsonObject(current),
      components,
      revision: expectedRevision + 1,
    };
    return;
  }
  throw fault(
    "world.transition.subject_kind",
    `Unsupported SubjectRef kind ${kind}`,
    { kind },
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

function assertEntityExpectedRevision(
  entityRef: JsonObject,
  entity: JsonObject,
): void {
  if (entityRef.expected_revision === undefined) {
    return;
  }
  assertEqual(
    "entity.expected_revision",
    expectInteger(entityRef, "expected_revision", "EntityRef"),
    expectInteger(entity, "revision", "EntityState"),
  );
}

function assertEntityReferenceWorld(entityRef: JsonObject, worldId: string): void {
  assertEqual(
    "entity_ref.world_id",
    worldId,
    expectString(entityRef, "world_id", "EntityRef"),
  );
}

function assertSubjectReferenceWorld(subject: JsonObject, worldId: string): void {
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind === "entity") {
    assertEntityReferenceWorld(
      expectJsonObject(
        expectProperty(subject, "entity", "SubjectRef"),
        "SubjectRef.entity",
      ),
      worldId,
    );
    return;
  }
  if (kind === "definition") {
    const definition = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (expectString(definition, "kind", "DefinitionRef") === "dynamic") {
      assertEqual(
        "dynamic_definition_ref.world_id",
        worldId,
        expectString(definition, "world_id", "DynamicDefinitionRef"),
      );
    }
    return;
  }
  throw fault(
    "world.transition.subject_kind",
    `Unsupported SubjectRef kind ${kind}`,
    { kind },
  );
}

function assertActiveEntityId(
  world: MutableWorld,
  entityId: string,
  field: string,
): void {
  const entity = findEntity(world, entityId);
  if (entity === undefined) {
    throw missing("entity", entityId);
  }
  assertEqual(
    `${field}.state`,
    "active",
    expectString(entity, "state", "EntityState"),
  );
}

function assertDialogueParticipants(
  world: MutableWorld,
  worldId: string,
  participants: readonly JsonObject[],
): void {
  const entityIds = new Set<string>();
  for (const participant of participants) {
    const kind = expectString(
      participant,
      "participant_kind",
      "DialogueParticipantRef",
    );
    if (kind === "system") {
      continue;
    }
    if (kind !== "entity") {
      throw fault(
        "world.transition.dialogue_participant_kind",
        `Unsupported dialogue participant kind ${kind}`,
        { participant_kind: kind },
      );
    }
    const entityRef = expectJsonObject(
      expectProperty(participant, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    );
    assertEntityReferenceWorld(entityRef, worldId);
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    if (entityIds.has(entityId)) {
      throw fault(
        "world.transition.duplicate_id",
        `Dialogue participants contain entity ${entityId} more than once`,
        { entity_id: entityId },
      );
    }
    entityIds.add(entityId);
    assertActiveEntityId(world, entityId, "dialogue.participant");
  }
}

function assertUniqueComponentKeys(
  components: readonly JsonObject[],
  field: string,
): void {
  const keys = new Set<string>();
  for (const component of components) {
    const key = JSON.stringify([
      expectProperty(component, "component_type", "ComponentValue"),
      expectInteger(component, "ordinal", "ComponentValue"),
    ]);
    if (keys.has(key)) {
      throw fault(
        "world.transition.component_duplicate",
        `Duplicate component key in ${field}`,
        { field },
      );
    }
    keys.add(key);
  }
}

function assertUniqueEntityReferences(
  entityRefs: readonly JsonObject[],
  field: string,
): void {
  const entityIds = new Set<string>();
  for (const entityRef of entityRefs) {
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    if (entityIds.has(entityId)) {
      throw fault(
        "world.transition.duplicate_id",
        `Duplicate entity ${entityId} in ${field}`,
        { entity_id: entityId, field },
      );
    }
    entityIds.add(entityId);
  }
}

function assertUniqueFrameIds(frames: readonly JsonObject[]): void {
  const frameIds = new Set<string>();
  for (const frame of frames) {
    const frameId = expectString(frame, "frame_id", "StateMachineFrame");
    if (frameIds.has(frameId)) {
      throw fault(
        "world.transition.duplicate_id",
        `State machine contains duplicate frame ${frameId}`,
        { frame_id: frameId },
      );
    }
    frameIds.add(frameId);
  }
}

function cloneWorld(worldState: JsonObject): MutableWorld {
  return {
    clock: cloneJsonObject(
      expectJsonObject(
        expectProperty(worldState, "clock", "WorldState"),
        "WorldState.clock",
      ),
    ),
    dynamic_definitions: asObjectArray(
      expectProperty(worldState, "dynamic_definitions", "WorldState"),
      "WorldState.dynamic_definitions",
    ).map((entry) => cloneJsonObject(entry)),
    entities: asObjectArray(
      expectProperty(worldState, "entities", "WorldState"),
      "WorldState.entities",
    ).map((entry) => cloneJsonObject(entry)),
    relations: asObjectArray(
      expectProperty(worldState, "relations", "WorldState"),
      "WorldState.relations",
    ).map((entry) => cloneJsonObject(entry)),
    ledgers: asObjectArray(
      expectProperty(worldState, "ledgers", "WorldState"),
      "WorldState.ledgers",
    ).map((entry) => cloneJsonObject(entry)),
    facts: asObjectArray(
      expectProperty(worldState, "facts", "WorldState"),
      "WorldState.facts",
    ).map((entry) => cloneJsonObject(entry)),
    knowledge: asObjectArray(
      expectProperty(worldState, "knowledge", "WorldState"),
      "WorldState.knowledge",
    ).map((entry) => cloneJsonObject(entry)),
    memories: asObjectArray(
      expectProperty(worldState, "memories", "WorldState"),
      "WorldState.memories",
    ).map((entry) => cloneJsonObject(entry)),
    schedules: asObjectArray(
      expectProperty(worldState, "schedules", "WorldState"),
      "WorldState.schedules",
    ).map((entry) => cloneJsonObject(entry)),
    goal_plans: asObjectArray(
      expectProperty(worldState, "goal_plans", "WorldState"),
      "WorldState.goal_plans",
    ).map((entry) => cloneJsonObject(entry)),
    stage_instances: asObjectArray(
      expectProperty(worldState, "stage_instances", "WorldState"),
      "WorldState.stage_instances",
    ).map((entry) => cloneJsonObject(entry)),
    visual_bindings: asObjectArray(
      expectProperty(worldState, "visual_bindings", "WorldState"),
      "WorldState.visual_bindings",
    ).map((entry) => cloneJsonObject(entry)),
    control_bindings: asObjectArray(
      expectProperty(worldState, "control_bindings", "WorldState"),
      "WorldState.control_bindings",
    ).map((entry) => cloneJsonObject(entry)),
    day_cycle: cloneJsonObject(
      expectJsonObject(
        expectProperty(worldState, "day_cycle", "WorldState"),
        "WorldState.day_cycle",
      ),
    ),
    state_machines: asObjectArray(
      expectProperty(worldState, "state_machines", "WorldState"),
      "WorldState.state_machines",
    ).map((entry) => cloneJsonObject(entry)),
    dialogues: asObjectArray(
      expectProperty(worldState, "dialogues", "WorldState"),
      "WorldState.dialogues",
    ).map((entry) => cloneJsonObject(entry)),
    event_budgets: asObjectArray(
      expectProperty(worldState, "event_budgets", "WorldState"),
      "WorldState.event_budgets",
    ).map((entry) => cloneJsonObject(entry)),
    event_cards: asObjectArray(
      expectProperty(worldState, "event_cards", "WorldState"),
      "WorldState.event_cards",
    ).map((entry) => cloneJsonObject(entry)),
  };
}

function freezeWorld(world: MutableWorld): JsonObject {
  return {
    clock: world.clock,
    dynamic_definitions: world.dynamic_definitions,
    entities: world.entities,
    relations: world.relations,
    ledgers: world.ledgers,
    facts: world.facts,
    knowledge: world.knowledge,
    memories: world.memories,
    schedules: world.schedules,
    goal_plans: world.goal_plans,
    stage_instances: world.stage_instances,
    visual_bindings: world.visual_bindings,
    control_bindings: world.control_bindings,
    day_cycle: world.day_cycle,
    state_machines: world.state_machines,
    dialogues: world.dialogues,
    event_budgets: world.event_budgets,
    event_cards: world.event_cards,
  };
}

function findDefinition(
  world: MutableWorld,
  definitionId: string,
): JsonObject | undefined {
  return world.dynamic_definitions.find(
    (entry) =>
      expectString(entry, "definition_id", "DynamicDefinitionState") ===
      definitionId,
  );
}

function findDefinitionIndex(world: MutableWorld, definitionId: string): number {
  return world.dynamic_definitions.findIndex(
    (entry) =>
      expectString(entry, "definition_id", "DynamicDefinitionState") ===
      definitionId,
  );
}

function findEntity(world: MutableWorld, entityId: string): JsonObject | undefined {
  return world.entities.find(
    (entry) => expectString(entry, "entity_id", "EntityState") === entityId,
  );
}

function findEntityIndex(world: MutableWorld, entityId: string): number {
  return world.entities.findIndex(
    (entry) => expectString(entry, "entity_id", "EntityState") === entityId,
  );
}

function findRelationIndex(world: MutableWorld, relationId: string): number {
  return world.relations.findIndex(
    (entry) => expectString(entry, "relation_id", "RelationState") === relationId,
  );
}

function findLedgerIndex(world: MutableWorld, ledgerId: string): number {
  return world.ledgers.findIndex(
    (entry) => expectString(entry, "ledger_id", "LedgerState") === ledgerId,
  );
}

function findFactIndex(world: MutableWorld, factId: string): number {
  return world.facts.findIndex(
    (entry) => expectString(entry, "fact_id", "FactRecord") === factId,
  );
}

function findKnowledgeIndex(
  world: MutableWorld,
  knowerEntityId: string,
  factId: string,
): number {
  return world.knowledge.findIndex(
    (entry) =>
      expectString(entry, "knower_entity_id", "KnowledgeState") ===
        knowerEntityId &&
      expectString(entry, "fact_id", "KnowledgeState") === factId,
  );
}

function findMemoryIndex(world: MutableWorld, memoryId: string): number {
  return world.memories.findIndex(
    (entry) => expectString(entry, "memory_id", "MemoryRecord") === memoryId,
  );
}

function findScheduleIndex(world: MutableWorld, scheduleId: string): number {
  return world.schedules.findIndex(
    (entry) => expectString(entry, "schedule_id", "ScheduleState") === scheduleId,
  );
}

function findStage(world: MutableWorld, stageInstanceId: string): JsonObject | undefined {
  return world.stage_instances.find(
    (entry) =>
      expectString(entry, "stage_instance_id", "StageInstanceState") ===
      stageInstanceId,
  );
}

function findStageIndex(world: MutableWorld, stageInstanceId: string): number {
  return world.stage_instances.findIndex(
    (entry) =>
      expectString(entry, "stage_instance_id", "StageInstanceState") ===
      stageInstanceId,
  );
}

function findGoalPlanIndex(world: MutableWorld, planId: string): number {
  return world.goal_plans.findIndex(
    (entry) => expectString(entry, "plan_id", "GoalPlan") === planId,
  );
}

function findStateMachine(
  world: MutableWorld,
  instanceId: string,
): JsonObject | undefined {
  return world.state_machines.find(
    (entry) =>
      expectString(entry, "instance_id", "StateMachineInstanceState") ===
      instanceId,
  );
}

function findStateMachineIndex(world: MutableWorld, instanceId: string): number {
  return world.state_machines.findIndex(
    (entry) =>
      expectString(entry, "instance_id", "StateMachineInstanceState") ===
      instanceId,
  );
}

function findDialogue(
  world: MutableWorld,
  dialogueId: string,
): JsonObject | undefined {
  return world.dialogues.find(
    (entry) =>
      expectString(entry, "dialogue_id", "DialogueRecord") === dialogueId,
  );
}

function findDialogueIndex(world: MutableWorld, dialogueId: string): number {
  return world.dialogues.findIndex(
    (entry) =>
      expectString(entry, "dialogue_id", "DialogueRecord") === dialogueId,
  );
}

function findEventCard(
  world: MutableWorld,
  eventCardId: string,
): JsonObject | undefined {
  return world.event_cards.find(
    (entry) =>
      expectString(entry, "event_card_id", "EventCardState") === eventCardId,
  );
}

function findEventCardIndex(world: MutableWorld, eventCardId: string): number {
  return world.event_cards.findIndex(
    (entry) =>
      expectString(entry, "event_card_id", "EventCardState") === eventCardId,
  );
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value) as JsonObject;
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry as JsonValue));
  }
  const next: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = cloneJson(entry);
  }
  return next;
}

function asObjectArray(value: JsonValue, path: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault("world.transition.shape", `${path} must be an array`, { path });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw fault(
        "world.transition.shape",
        `${path}[${index}] must be an object`,
        { path: `${path}[${index}]` },
      );
    }
    return entry as JsonObject;
  });
}

function expectNumber(
  value: JsonObject,
  property: string,
  scope: string,
): number {
  const candidate = expectProperty(value, property, scope);
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw fault(
      "world.transition.shape",
      `${scope}.${property} must be a finite number`,
      { property, scope },
    );
  }
  return candidate;
}

function assertEqual(
  field: string,
  expected: number | string,
  actual: number | string,
): void {
  if (expected !== actual) {
    throw fault(
      "world.transition.field_mismatch",
      `State transition field ${field} mismatch`,
      { field, expected, actual },
    );
  }
}

function assertJsonEqual(
  field: string,
  expected: JsonValue,
  actual: JsonValue,
): void {
  if (!jsonEquals(expected, actual)) {
    throw fault(
      "world.transition.field_mismatch",
      `State transition field ${field} mismatch`,
      { field },
    );
  }
}

function missing(kind: string, id: string): EngineFault {
  return fault(
    "world.transition.missing",
    `${kind} ${id} is absent`,
    { kind, id },
  );
}

function fault(code: string, message: string, details: JsonObject): EngineFault {
  return new EngineFault(code, message, details);
}

const _exhaustive: { readonly [K in EffectOpName]: true } = {
  "definition.register": true,
  "definition.retire": true,
  "entity.create": true,
  "entity.retire": true,
  "component.replace": true,
  "component.remove": true,
  "relation.upsert": true,
  "relation.remove": true,
  "ledger.post": true,
  "entity.relocate": true,
  "knowledge.record": true,
  "memory.append": true,
  "schedule.upsert": true,
  "schedule.cancel": true,
  "clock.advance": true,
  "stage.open": true,
  "stage.update": true,
  "stage.close": true,
  "goal_plan.upsert": true,
  "goal_plan.cancel": true,
  "materialization.request": true,
  "visual_binding.upsert": true,
  "domain_event.emit": true,
  "control_binding.upsert": true,
  "day_cycle.transition": true,
  "state_machine.create": true,
  "state_machine.set_state": true,
  "dialogue.open": true,
  "dialogue.turn.append": true,
  "dialogue.close": true,
  "event_card.publish": true,
  "event_card.trigger": true,
  "event_card.invalidate": true,
  "event_card.expire": true,
  "event_budget.open": true,
};
void _exhaustive;
