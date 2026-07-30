import {
  CONTRACT_REF,
  type SaveEnvelopeDocument,
} from "./references.js";
import { EngineFault } from "./fault.js";
import {
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { ContractValidator } from "./contract-validator.js";

/**
 * Intrinsic SaveEnvelope relationships shared by import/export and World Core.
 * Deployment compatibility remains a Server responsibility because exporting
 * an older, digest-locked save must not depend on the active deployment graph.
 */
export function assertSaveEnvelopeRelationships(
  contracts: ContractValidator,
  envelope: SaveEnvelopeDocument,
): void {
  const value = envelope.value;
  const worldId = expectString(value, "world_id", "SaveEnvelope");
  const worldRevision = expectInteger(
    value,
    "world_revision",
    "SaveEnvelope",
  );
  const eventCursor = expectInteger(
    value,
    "event_cursor",
    "SaveEnvelope",
  );
  if (eventCursor !== worldRevision) {
    throw new EngineFault(
      "runtime.save.event_cursor_mismatch",
      "SaveEnvelope v1 requires event_cursor to equal world_revision",
      {
        world_id: worldId,
        world_revision: worldRevision,
        event_cursor: eventCursor,
      },
    );
  }

  const worldState = expectJsonObject(
    expectProperty(value, "world_state", "SaveEnvelope"),
    "SaveEnvelope.world_state",
  );
  contracts.assertObject(CONTRACT_REF.worldSnapshot, {
    world_id: worldId,
    world_revision: worldRevision,
    world_state: worldState,
  });
  assertStateMachineRelationships(worldState, worldId);
  assertStageInstanceRelationships(worldState, worldId);
  assertVisualBindingRelationships(worldState, worldId);
  const worldContentLock = expectJsonObject(
    expectProperty(value, "world_content_lock", "SaveEnvelope"),
    "SaveEnvelope.world_content_lock",
  );
  const rootBundleLock = expectJsonObject(
    expectProperty(
      worldContentLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  const rootPackId = expectString(rootBundleLock, "pack_id", "PackLock");

  const dependencyLocks = asObjectArray(
    expectProperty(value, "dependency_bundle_locks", "SaveEnvelope"),
    "SaveEnvelope.dependency_bundle_locks",
  );
  const dependenciesById = indexUniqueLocks(
    dependencyLocks,
    "pack_id",
    "PackLock",
    "runtime.save.dependency_bundle_lock_duplicate",
  );
  if (dependenciesById.has(rootPackId)) {
    throw new EngineFault(
      "runtime.save.root_bundle_repeated",
      "SaveEnvelope root bundle must not also appear in dependency_bundle_locks",
      { world_id: worldId, pack_id: rootPackId },
    );
  }
  indexUniqueLocks(
    asObjectArray(
      expectProperty(value, "rule_plugin_locks", "SaveEnvelope"),
      "SaveEnvelope.rule_plugin_locks",
    ),
    "plugin_id",
    "PluginLock",
    "runtime.save.rule_plugin_lock_duplicate",
  );
  indexUniqueLocks(
    asObjectArray(
      expectProperty(value, "stage_module_locks", "SaveEnvelope"),
      "SaveEnvelope.stage_module_locks",
    ),
    "module_id",
    "StageModuleLock",
    "runtime.save.stage_module_lock_duplicate",
  );
}

function assertStateMachineRelationships(
  worldState: JsonObject,
  worldId: string,
): void {
  const entitiesById = new Map<string, JsonObject[]>();
  for (const entity of asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  )) {
    const entityId = expectString(entity, "entity_id", "EntityState");
    const matches = entitiesById.get(entityId) ?? [];
    matches.push(entity);
    entitiesById.set(entityId, matches);
  }

  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const currentDay = expectInteger(dayCycle, "day", "DayCycleState");
  if (!Number.isSafeInteger(currentDay)) {
    throw new EngineFault(
      "runtime.save.day_unsafe",
      "SaveEnvelope DayCycleState.day must be a safe integer",
      { world_id: worldId, day: currentDay },
    );
  }

  const instanceIds = new Set<string>();
  const characterOwners = new Set<string>();
  const worldMachineOwners = new Set<string>();
  for (const instance of asObjectArray(
    expectProperty(worldState, "state_machines", "WorldState"),
    "WorldState.state_machines",
  )) {
    const instanceId = expectString(
      instance,
      "instance_id",
      "StateMachineInstanceState",
    );
    if (instanceIds.has(instanceId)) {
      throw new EngineFault(
        "runtime.save.state_machine_instance_id_duplicate",
        "SaveEnvelope StateMachineInstanceState identities must be unique",
        { world_id: worldId, machine_instance_id: instanceId },
      );
    }
    instanceIds.add(instanceId);

    const enteredDay = expectInteger(
      instance,
      "entered_day",
      "StateMachineInstanceState",
    );
    if (!Number.isSafeInteger(enteredDay)) {
      throw new EngineFault(
        "runtime.save.state_machine_entered_day_unsafe",
        "StateMachineInstanceState.entered_day must be a safe integer",
        {
          world_id: worldId,
          machine_instance_id: instanceId,
          entered_day: enteredDay,
        },
      );
    }
    if (enteredDay > currentDay) {
      throw new EngineFault(
        "runtime.save.state_machine_entered_day_future",
        "StateMachineInstanceState.entered_day cannot be later than the current world day",
        {
          world_id: worldId,
          machine_instance_id: instanceId,
          entered_day: enteredDay,
          current_day: currentDay,
        },
      );
    }

    const owner = expectJsonObject(
      expectProperty(instance, "owner", "StateMachineInstanceState"),
      "StateMachineInstanceState.owner",
    );
    const ownerKind = expectString(
      owner,
      "owner_kind",
      "StateMachineOwner",
    );
    if (ownerKind === "character") {
      const entityId = expectString(
        owner,
        "entity_id",
        "StateMachineOwner",
      );
      const matches = entitiesById.get(entityId) ?? [];
      if (matches.length !== 1) {
        throw new EngineFault(
          "runtime.save.state_machine_owner_unresolved",
          "Character StateMachine owner must resolve to exactly one EntityState",
          {
            world_id: worldId,
            machine_instance_id: instanceId,
            entity_id: entityId,
            matches: matches.length,
          },
        );
      }
      if (characterOwners.has(entityId)) {
        throw new EngineFault(
          "runtime.save.character_state_machine_ambiguous",
          "An Entity can own only one character StateMachine instance",
          {
            world_id: worldId,
            machine_instance_id: instanceId,
            entity_id: entityId,
          },
        );
      }
      characterOwners.add(entityId);
      continue;
    }

    if (ownerKind === "world") {
      const ownerWorldId = expectString(
        owner,
        "world_id",
        "StateMachineOwner",
      );
      if (ownerWorldId !== worldId) {
        throw new EngineFault(
          "runtime.save.state_machine_owner_world_mismatch",
          "World StateMachine owner must match the SaveEnvelope world",
          {
            world_id: worldId,
            machine_instance_id: instanceId,
            owner_world_id: ownerWorldId,
          },
        );
      }
      const machine = expectJsonObject(
        expectProperty(instance, "machine", "StateMachineInstanceState"),
        "StateMachineInstanceState.machine",
      );
      const ownerIdentity = JSON.stringify([
        ownerWorldId,
        expectString(machine, "bundle_id", "StateMachineCatalogRef"),
        expectString(
          machine,
          "bundle_digest",
          "StateMachineCatalogRef",
        ),
        expectString(machine, "local_id", "StateMachineCatalogRef"),
      ]);
      if (worldMachineOwners.has(ownerIdentity)) {
        throw new EngineFault(
          "runtime.save.world_state_machine_ambiguous",
          "A world can own only one instance of the same StateMachine definition",
          {
            world_id: worldId,
            machine_instance_id: instanceId,
            machine_identity: ownerIdentity,
          },
        );
      }
      worldMachineOwners.add(ownerIdentity);
      continue;
    }

    throw new EngineFault(
      "runtime.save.state_machine_owner_kind_unsupported",
      "StateMachineOwner.owner_kind is unsupported",
      {
        world_id: worldId,
        machine_instance_id: instanceId,
        owner_kind: ownerKind,
      },
    );
  }
}

function assertStageInstanceRelationships(
  worldState: JsonObject,
  worldId: string,
): void {
  const entityIdentityCounts = new Map<string, number>();
  for (const entity of asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  )) {
    const entityId = expectString(entity, "entity_id", "EntityState");
    entityIdentityCounts.set(
      entityId,
      (entityIdentityCounts.get(entityId) ?? 0) + 1,
    );
  }

  const stageInstanceIds = new Set<string>();
  for (const stage of asObjectArray(
    expectProperty(worldState, "stage_instances", "WorldState"),
    "WorldState.stage_instances",
  )) {
    const stageInstanceId = expectString(
      stage,
      "stage_instance_id",
      "StageInstanceState",
    );
    const stageRevision = expectInteger(
      stage,
      "revision",
      "StageInstanceState",
    );
    if (!Number.isSafeInteger(stageRevision)) {
      throw new EngineFault(
        "runtime.save.stage_revision_unsafe",
        "SaveEnvelope StageInstance revision must be a safe integer",
        {
          world_id: worldId,
          stage_instance_id: stageInstanceId,
          stage_revision: stageRevision,
        },
      );
    }
    if (stageInstanceIds.has(stageInstanceId)) {
      throw new EngineFault(
        "runtime.save.stage_instance_id_duplicate",
        "SaveEnvelope StageInstance identities must be unique",
        { world_id: worldId, stage_instance_id: stageInstanceId },
      );
    }
    stageInstanceIds.add(stageInstanceId);

    if (expectString(stage, "status", "StageInstanceState") === "closed") {
      continue;
    }
    const participantEntityIds = new Set<string>();
    for (const participant of asObjectArray(
      expectProperty(
        stage,
        "participants",
        "StageInstanceState",
      ),
      "StageInstanceState.participants",
    )) {
      const participantWorldId = expectString(
        participant,
        "world_id",
        "EntityRef",
      );
      const participantEntityId = expectString(
        participant,
        "entity_id",
        "EntityRef",
      );
      if (participantWorldId !== worldId) {
        throw new EngineFault(
          "runtime.save.stage_participant_world_mismatch",
          "Open Stage participant must belong to the SaveEnvelope world",
          {
            world_id: worldId,
            stage_instance_id: stageInstanceId,
            participant_world_id: participantWorldId,
            participant_entity_id: participantEntityId,
          },
        );
      }
      if (participantEntityIds.has(participantEntityId)) {
        throw new EngineFault(
          "runtime.save.stage_participant_duplicate",
          "Open Stage participant identities must be unique",
          {
            world_id: worldId,
            stage_instance_id: stageInstanceId,
            participant_entity_id: participantEntityId,
          },
        );
      }
      participantEntityIds.add(participantEntityId);
      const entityMatches =
        entityIdentityCounts.get(participantEntityId) ?? 0;
      if (entityMatches !== 1) {
        throw new EngineFault(
          "runtime.save.stage_participant_entity_unresolved",
          "Open Stage participant identity must resolve to exactly one EntityState in the SaveEnvelope",
          {
            world_id: worldId,
            stage_instance_id: stageInstanceId,
            participant_entity_id: participantEntityId,
            matches: entityMatches,
          },
        );
      }
    }
  }
}

function assertVisualBindingRelationships(
  worldState: JsonObject,
  worldId: string,
): void {
  const bindingIds = new Set<string>();
  const runtimeIdentityKeys = new Set<string>();
  for (const binding of asObjectArray(
    expectProperty(
      worldState,
      "visual_bindings",
      "WorldState",
    ),
    "WorldState.visual_bindings",
  )) {
    const bindingId = expectString(
      binding,
      "binding_id",
      "VisualBinding",
    );
    if (bindingIds.has(bindingId)) {
      throw new EngineFault(
        "runtime.save.visual_binding_id_duplicate",
        "SaveEnvelope VisualBinding identities must be unique",
        { world_id: worldId, binding_id: bindingId },
      );
    }
    bindingIds.add(bindingId);

    const bindingWorldId = expectString(
      binding,
      "world_id",
      "VisualBinding",
    );
    if (bindingWorldId !== worldId) {
      throw new EngineFault(
        "runtime.save.visual_binding_world_mismatch",
        "VisualBinding must belong to the SaveEnvelope world",
        {
          world_id: worldId,
          binding_id: bindingId,
          binding_world_id: bindingWorldId,
        },
      );
    }
    const runtimeIdentityKey = visualBindingRuntimeIdentityKey(
      binding,
      "VisualBinding",
    );
    assertVisualBindingSubjectCurrent(binding, worldState, worldId);
    if (runtimeIdentityKeys.has(runtimeIdentityKey)) {
      throw new EngineFault(
        "runtime.save.visual_binding_identity_duplicate",
        "SaveEnvelope contains multiple VisualBindings for one runtime subject revision and slot",
        {
          world_id: worldId,
          binding_id: bindingId,
          runtime_identity_key: runtimeIdentityKey,
        },
      );
    }
    runtimeIdentityKeys.add(runtimeIdentityKey);
  }
}

function assertVisualBindingSubjectCurrent(
  binding: JsonObject,
  worldState: JsonObject,
  worldId: string,
): void {
  const bindingId = expectString(binding, "binding_id", "VisualBinding");
  const subjectRevision = expectInteger(
    binding,
    "subject_revision",
    "VisualBinding",
  );
  const subject = expectJsonObject(
    expectProperty(binding, "subject", "VisualBinding"),
    "VisualBinding.subject",
  );
  const subjectKind = expectString(subject, "kind", "SubjectRef");
  if (subjectKind === "entity") {
    const entityRef = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    const current = asObjectArray(
      expectProperty(worldState, "entities", "WorldState"),
      "WorldState.entities",
    ).find(
      (entity) =>
        expectString(entity, "entity_id", "EntityState") === entityId,
    );
    if (
      current === undefined ||
      expectString(current, "state", "EntityState") !== "active" ||
      expectInteger(current, "revision", "EntityState") !== subjectRevision
    ) {
      throw new EngineFault(
        "runtime.save.visual_binding_subject_not_current",
        "VisualBinding must target the current active Entity revision",
        {
          world_id: worldId,
          binding_id: bindingId,
          subject_kind: subjectKind,
          subject_id: entityId,
          subject_revision: subjectRevision,
        },
      );
    }
    return;
  }
  if (subjectKind === "definition") {
    const definitionRef = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (expectString(definitionRef, "kind", "DefinitionRef") !== "dynamic") {
      throw new EngineFault(
        "runtime.save.visual_binding_subject_immutable",
        "VisualBinding can target only a runtime Entity or DynamicDefinition",
        {
          world_id: worldId,
          binding_id: bindingId,
          subject_kind: "static_definition",
        },
      );
    }
    const definitionId = expectString(
      definitionRef,
      "definition_id",
      "DynamicDefinitionRef",
    );
    const current = asObjectArray(
      expectProperty(
        worldState,
        "dynamic_definitions",
        "WorldState",
      ),
      "WorldState.dynamic_definitions",
    ).find(
      (definition) =>
        expectString(
          definition,
          "definition_id",
          "DynamicDefinitionState",
        ) === definitionId,
    );
    if (
      current === undefined ||
      expectString(current, "state", "DynamicDefinitionState") !== "active" ||
      expectInteger(current, "revision", "DynamicDefinitionState") !==
        subjectRevision
    ) {
      throw new EngineFault(
        "runtime.save.visual_binding_subject_not_current",
        "VisualBinding must target the current active DynamicDefinition revision",
        {
          world_id: worldId,
          binding_id: bindingId,
          subject_kind: "dynamic_definition",
          subject_id: definitionId,
          subject_revision: subjectRevision,
        },
      );
    }
  }
}

export function visualBindingRuntimeIdentityKey(
  binding: JsonObject,
  label: string,
): string {
  const bindingWorldId = expectString(binding, "world_id", label);
  const subjectRevision = expectInteger(
    binding,
    "subject_revision",
    label,
  );
  if (!Number.isSafeInteger(subjectRevision)) {
    throw new EngineFault(
      "runtime.visual_binding.subject_revision_unsafe",
      `${label}.subject_revision must be a safe integer`,
      { subject_revision: subjectRevision },
    );
  }
  const slotId = expectString(binding, "slot_id", label);
  const subject = expectJsonObject(
    expectProperty(binding, "subject", label),
    `${label}.subject`,
  );
  const subjectKind = expectString(subject, "kind", "SubjectRef");
  if (subjectKind === "entity") {
    const entity = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    const subjectWorldId = expectString(
      entity,
      "world_id",
      "EntityRef",
    );
    if (subjectWorldId !== bindingWorldId) {
      throw new EngineFault(
        "runtime.visual_binding.subject_world_mismatch",
        "VisualBinding EntityRef must belong to the binding world",
        {
          binding_world_id: bindingWorldId,
          subject_world_id: subjectWorldId,
        },
      );
    }
    if (
      entity["expected_revision"] !== undefined &&
      expectInteger(entity, "expected_revision", "EntityRef") !==
        subjectRevision
    ) {
      throw new EngineFault(
        "runtime.visual_binding.subject_revision_mismatch",
        "VisualBinding EntityRef.expected_revision must match subject_revision",
        {
          subject_kind: subjectKind,
          subject_revision: subjectRevision,
          ref_revision: expectInteger(
            entity,
            "expected_revision",
            "EntityRef",
          ),
        },
      );
    }
    return JSON.stringify([
      "entity",
      bindingWorldId,
      expectString(entity, "entity_id", "EntityRef"),
      subjectRevision,
      slotId,
    ]);
  }
  if (subjectKind === "definition") {
    const definition = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    const definitionKind = expectString(
      definition,
      "kind",
      "DefinitionRef",
    );
    if (definitionKind !== "dynamic") {
      throw new EngineFault(
        "runtime.visual_binding.subject_immutable",
        "VisualBinding can target only Entity or DynamicDefinition subjects",
        { definition_kind: definitionKind },
      );
    }
    const subjectWorldId = expectString(
      definition,
      "world_id",
      "DynamicDefinitionRef",
    );
    if (subjectWorldId !== bindingWorldId) {
      throw new EngineFault(
        "runtime.visual_binding.subject_world_mismatch",
        "VisualBinding DynamicDefinitionRef must belong to the binding world",
        {
          binding_world_id: bindingWorldId,
          subject_world_id: subjectWorldId,
        },
      );
    }
    const refRevision = expectInteger(
      definition,
      "revision",
      "DynamicDefinitionRef",
    );
    if (refRevision !== subjectRevision) {
      throw new EngineFault(
        "runtime.visual_binding.subject_revision_mismatch",
        "VisualBinding DynamicDefinitionRef.revision must match subject_revision",
        {
          subject_kind: "dynamic_definition",
          subject_revision: subjectRevision,
          ref_revision: refRevision,
        },
      );
    }
    return JSON.stringify([
      "dynamic_definition",
      bindingWorldId,
      expectString(
        definition,
        "definition_id",
        "DynamicDefinitionRef",
      ),
      subjectRevision,
      slotId,
    ]);
  }
  throw new EngineFault(
    "runtime.visual_binding.subject_kind_unsupported",
    "VisualBinding references an unsupported SubjectRef kind",
    { subject_kind: subjectKind },
  );
}

function indexUniqueLocks(
  locks: readonly JsonObject[],
  identityField: string,
  label: string,
  faultCode: string,
): ReadonlyMap<string, JsonObject> {
  const indexed = new Map<string, JsonObject>();
  for (const lock of locks) {
    const identity = expectString(lock, identityField, label);
    if (indexed.has(identity)) {
      throw new EngineFault(
        faultCode,
        `SaveEnvelope contains more than one ${label} for the same identity`,
        { identity_field: identityField, identity },
      );
    }
    indexed.set(identity, lock);
  }
  return indexed;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.save.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
