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
  const activeIdentityKeys = new Set<string>();
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
    if (expectString(binding, "state", "VisualBinding") !== "active") {
      continue;
    }
    if (activeIdentityKeys.has(runtimeIdentityKey)) {
      throw new EngineFault(
        "runtime.save.visual_binding_active_identity_duplicate",
        "SaveEnvelope contains multiple active VisualBindings for one runtime subject revision and slot",
        {
          world_id: worldId,
          binding_id: bindingId,
          active_identity_key: runtimeIdentityKey,
        },
      );
    }
    activeIdentityKeys.add(runtimeIdentityKey);
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
