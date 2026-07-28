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
  ContentRuntimeCatalog,
  ContentRuntimeIdentityMapper,
  WorldContentBinding,
  WorldContentLockDocument,
} from "@luoxia/world-core";

export interface SessionRenderNodeProjectionInput {
  readonly worldContentLock: WorldContentLockDocument;
  readonly worldId: string;
  readonly playerEntityId: string;
  readonly worldState: JsonObject;
}

export interface SessionRenderNodeProjector {
  project(input: SessionRenderNodeProjectionInput): readonly JsonObject[];
}

export interface SessionRenderNodeProjectorDependencies {
  readonly catalog: ContentRuntimeCatalog;
  readonly identityMapper: ContentRuntimeIdentityMapper;
  readonly digest: JsonDigest;
}

interface RenderCandidate {
  readonly binding: JsonObject;
  readonly bindingId: string;
  readonly nodeKind: string;
  readonly slotId: string;
  readonly priority: number;
  readonly instance: RenderInstance;
}

type RenderInstance =
  | {
      readonly kind: "world";
      readonly instanceKey: string;
    }
  | {
      readonly kind: "entity";
      readonly instanceKey: string;
      readonly entity: JsonObject;
      readonly subject: JsonObject;
    }
  | {
      readonly kind: "relation";
      readonly instanceKey: string;
      readonly relation: JsonObject;
    };

/**
 * Sole Server projection from one digest-locked ContentBundle plus player-
 * visible WorldState facts into the generic 2D RenderNode language.
 *
 * It is synchronous and read-only: no RulePlugin, model, asset I/O, fallback
 * guessing, or WorldState mutation is permitted on this path.
 */
export function createSessionRenderNodeProjector(
  dependencies: SessionRenderNodeProjectorDependencies,
): SessionRenderNodeProjector {
  return new DefaultSessionRenderNodeProjector(dependencies);
}

class DefaultSessionRenderNodeProjector
  implements SessionRenderNodeProjector
{
  readonly #catalog: ContentRuntimeCatalog;
  readonly #identityMapper: ContentRuntimeIdentityMapper;
  readonly #digest: JsonDigest;

  public constructor(
    dependencies: SessionRenderNodeProjectorDependencies,
  ) {
    this.#catalog = dependencies.catalog;
    this.#identityMapper = dependencies.identityMapper;
    this.#digest = dependencies.digest;
  }

  public project(
    input: SessionRenderNodeProjectionInput,
  ): readonly JsonObject[] {
    const content = this.#catalog.resolveWorldContentBinding(
      input.worldContentLock,
    );
    const entities = indexWorldRecords(
      objectArray(
        expectProperty(input.worldState, "entities", "WorldState"),
        "WorldState.entities",
      ),
      "entity_id",
      "EntityState",
    );
    const relations = indexWorldRecords(
      objectArray(
        expectProperty(input.worldState, "relations", "WorldState"),
        "WorldState.relations",
      ),
      "relation_id",
      "RelationState",
    );
    requireActiveEntity(
      entities,
      input.playerEntityId,
      "Session player",
    );

    const visibility = resolveVisibleWorldFacts({
      worldId: input.worldId,
      playerEntityId: input.playerEntityId,
      worldState: input.worldState,
      content,
      entities,
      relations,
    });
    const selected = selectCandidates(
      this.#collectCandidates({
        worldId: input.worldId,
        content,
        entities,
        relations,
        visibleEntityIds: visibility.entityIds,
        visibleRelationIds: visibility.relationIds,
      }),
    );
    const assets = indexContentObjects(
      content.presentation.assets,
      "asset_id",
      "PackAsset",
    );
    const profiles = indexContentObjects(
      content.presentation.materializationProfiles,
      "materialization_profile_id",
      "MaterializationProfile",
    );
    const visualBindings = objectArray(
      expectProperty(
        input.worldState,
        "visual_bindings",
        "WorldState",
      ),
      "WorldState.visual_bindings",
    );

    const nodes = selected.map((candidate) =>
      this.#materializeNode({
        candidate,
        worldId: input.worldId,
        assets,
        profiles,
        visualBindings,
      }),
    );
    return Object.freeze(nodes);
  }

  #collectCandidates(input: {
    readonly worldId: string;
    readonly content: WorldContentBinding;
    readonly entities: ReadonlyMap<string, JsonObject>;
    readonly relations: ReadonlyMap<string, JsonObject>;
    readonly visibleEntityIds: ReadonlySet<string>;
    readonly visibleRelationIds: ReadonlySet<string>;
  }): readonly RenderCandidate[] {
    const candidates: RenderCandidate[] = [];
    const worldDefinitionId = expectString(
      input.content.worldDefinition,
      "world_id",
      "WorldDefinition",
    );

    for (const binding of input.content.presentation.bindings) {
      if (binding.node_kind === undefined) {
        continue;
      }
      const bindingId = expectString(binding, "binding_id", "PackBinding");
      const subjectKind = expectString(
        binding,
        "subject_kind",
        "PackBinding",
      );
      const subjectId = expectString(binding, "subject_id", "PackBinding");
      const nodeKind = expectString(binding, "node_kind", "PackBinding");
      const slotId = expectString(binding, "slot_id", "PackBinding");
      const priority = expectInteger(binding, "priority", "PackBinding");

      switch (subjectKind) {
        case "world":
          if (subjectId === worldDefinitionId) {
            candidates.push({
              binding,
              bindingId,
              nodeKind,
              slotId,
              priority,
              instance: Object.freeze({
                kind: "world",
                instanceKey: `world:${input.worldId}`,
              }),
            });
          }
          break;
        case "entity": {
          const entityId = this.#identityMapper.toRuntimeUuid({
            worldId: input.worldId,
            packId: input.content.packId,
            kind: "entity",
            localId: subjectId,
          });
          if (!input.visibleEntityIds.has(entityId)) {
            break;
          }
          const entity = requireActiveEntity(
            input.entities,
            entityId,
            "Renderable content entity",
          );
          candidates.push(
            entityCandidate({
              binding,
              bindingId,
              nodeKind,
              slotId,
              priority,
              worldId: input.worldId,
              entity,
            }),
          );
          break;
        }
        case "definition":
          for (const entityId of input.visibleEntityIds) {
            const entity = requireActiveEntity(
              input.entities,
              entityId,
              "Visible entity",
            );
            if (
              staticDefinitionMatches(
                expectJsonObject(
                  expectProperty(entity, "archetype", "EntityState"),
                  "EntityState.archetype",
                ),
                input.content,
                subjectId,
              )
            ) {
              candidates.push(
                entityCandidate({
                  binding,
                  bindingId,
                  nodeKind,
                  slotId,
                  priority,
                  worldId: input.worldId,
                  entity,
                }),
              );
            }
          }
          break;
        case "relation": {
          const relationId = this.#identityMapper.toRuntimeUuid({
            worldId: input.worldId,
            packId: input.content.packId,
            kind: "relation",
            localId: subjectId,
          });
          if (!input.visibleRelationIds.has(relationId)) {
            break;
          }
          const relation = input.relations.get(relationId);
          if (
            relation === undefined ||
            expectString(relation, "state", "RelationState") !== "active"
          ) {
            throw new EngineFault(
              "session.render_node.relation_unavailable",
              "Visible content relation must exist and be active",
              { relation_id: relationId, binding_id: bindingId },
            );
          }
          candidates.push({
            binding,
            bindingId,
            nodeKind,
            slotId,
            priority,
            instance: Object.freeze({
              kind: "relation",
              instanceKey: `relation:${relationId}`,
              relation,
            }),
          });
          break;
        }
        case "capability":
        case "generation_archetype":
          throw new EngineFault(
            "session.render_node.subject_kind_unsupported",
            "Renderable PackBinding has no runtime-resolvable subject owner",
            { binding_id: bindingId, subject_kind: subjectKind },
          );
        default:
          throw new EngineFault(
            "session.render_node.subject_kind_unknown",
            "Renderable PackBinding has an unknown subject kind",
            { binding_id: bindingId, subject_kind: subjectKind },
          );
      }
    }
    return Object.freeze(candidates);
  }

  #materializeNode(input: {
    readonly candidate: RenderCandidate;
    readonly worldId: string;
    readonly assets: ReadonlyMap<string, JsonObject>;
    readonly profiles: ReadonlyMap<string, JsonObject>;
    readonly visualBindings: readonly JsonObject[];
  }): JsonObject {
    const { candidate } = input;
    const node: Record<string, JsonValue> = {
      node_id: `render.${this.#digest.sha256({
        binding_id: candidate.bindingId,
        instance_key: candidate.instance.instanceKey,
      })}`,
      node_kind: candidate.nodeKind,
      slot_id: candidate.slotId,
      parameters: expectJsonObject(
        expectProperty(candidate.binding, "parameters", "PackBinding"),
        "PackBinding.parameters",
      ),
      asset: resolveCandidateAsset({
        candidate,
        worldId: input.worldId,
        assets: input.assets,
        profiles: input.profiles,
        visualBindings: input.visualBindings,
      }),
    };

    if (candidate.instance.kind === "entity") {
      node.subject = candidate.instance.subject;
    }
    if (candidate.binding.text !== undefined) {
      node.text = expectJsonObject(
        candidate.binding.text,
        "PackBinding.text",
      );
    } else if (
      candidate.instance.kind === "entity" &&
      (candidate.nodeKind === "text" ||
        candidate.nodeKind === "interaction_anchor")
    ) {
      node.text = expectJsonObject(
        expectProperty(
          candidate.instance.entity,
          "name",
          "EntityState",
        ),
        "EntityState.name",
      );
    }
    return Object.freeze(node);
  }
}

function entityCandidate(input: {
  readonly binding: JsonObject;
  readonly bindingId: string;
  readonly nodeKind: string;
  readonly slotId: string;
  readonly priority: number;
  readonly worldId: string;
  readonly entity: JsonObject;
}): RenderCandidate {
  const entityId = expectString(input.entity, "entity_id", "EntityState");
  return Object.freeze({
    binding: input.binding,
    bindingId: input.bindingId,
    nodeKind: input.nodeKind,
    slotId: input.slotId,
    priority: input.priority,
    instance: Object.freeze({
      kind: "entity",
      instanceKey: `entity:${entityId}`,
      entity: input.entity,
      subject: Object.freeze({
        kind: "entity",
        entity: Object.freeze({
          world_id: input.worldId,
          entity_id: entityId,
          expected_revision: expectInteger(
            input.entity,
            "revision",
            "EntityState",
          ),
        }),
      }),
    }),
  });
}

function resolveVisibleWorldFacts(input: {
  readonly worldId: string;
  readonly playerEntityId: string;
  readonly worldState: JsonObject;
  readonly content: WorldContentBinding;
  readonly entities: ReadonlyMap<string, JsonObject>;
  readonly relations: ReadonlyMap<string, JsonObject>;
}): {
  readonly entityIds: ReadonlySet<string>;
  readonly relationIds: ReadonlySet<string>;
} {
  const entityIds = new Set<string>([input.playerEntityId]);
  const relationIds = new Set<string>();
  const locationRelationType: JsonObject = Object.freeze({
    bundle_id: input.content.packId,
    bundle_digest: input.content.bundleDigest,
    catalog_kind: "relation_type",
    local_id: expectString(
      input.content.worldDefinition,
      "player_location_relation_type_id",
      "WorldDefinition",
    ),
  });
  const playerLocationRelations = [...input.relations.values()].filter(
    (relation) =>
      expectString(relation, "state", "RelationState") === "active" &&
      jsonEquals(
        expectProperty(relation, "relation_type", "RelationState"),
        locationRelationType,
      ) &&
      entitySubjectId(
        expectJsonObject(
          expectProperty(relation, "from", "RelationState"),
          "RelationState.from",
        ),
        input.worldId,
      ) === input.playerEntityId,
  );
  if (playerLocationRelations.length !== 1) {
    throw new EngineFault(
      "session.render_node.player_location_ambiguous",
      "Player must have exactly one active location relation",
      {
        player_entity_id: input.playerEntityId,
        matches: playerLocationRelations.length,
      },
    );
  }
  const playerLocation = playerLocationRelations[0] as JsonObject;
  relationIds.add(
    expectString(playerLocation, "relation_id", "RelationState"),
  );
  addEntitySubject({
    subject: expectJsonObject(
      expectProperty(playerLocation, "to", "RelationState"),
      "RelationState.to",
    ),
    worldId: input.worldId,
    entities: input.entities,
    visible: entityIds,
    source: "Player location",
  });

  for (const relation of input.relations.values()) {
    if (
      expectString(relation, "state", "RelationState") !== "active" ||
      !relationVisibleToPlayer(relation, input.playerEntityId)
    ) {
      continue;
    }
    relationIds.add(expectString(relation, "relation_id", "RelationState"));
    addEntitySubject({
      subject: expectJsonObject(
        expectProperty(relation, "from", "RelationState"),
        "RelationState.from",
      ),
      worldId: input.worldId,
      entities: input.entities,
      visible: entityIds,
      source: "Visible relation",
    });
    addEntitySubject({
      subject: expectJsonObject(
        expectProperty(relation, "to", "RelationState"),
        "RelationState.to",
      ),
      worldId: input.worldId,
      entities: input.entities,
      visible: entityIds,
      source: "Visible relation",
    });
  }

  const dialogues = objectArray(
    expectProperty(input.worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  );
  for (const dialogue of dialogues) {
    if (
      expectString(dialogue, "status", "DialogueRecord") !== "active"
    ) {
      continue;
    }
    const participants = objectArray(
      expectProperty(dialogue, "participants", "DialogueRecord"),
      "DialogueRecord.participants",
    );
    const participantEntityIds = participants
      .map((participant) =>
        dialogueParticipantEntityId(participant, input.worldId),
      )
      .filter((entityId): entityId is string => entityId !== undefined);
    if (!participantEntityIds.includes(input.playerEntityId)) {
      continue;
    }
    for (const entityId of participantEntityIds) {
      requireActiveEntity(
        input.entities,
        entityId,
        "Active dialogue participant",
      );
      entityIds.add(entityId);
    }
  }

  return Object.freeze({
    entityIds,
    relationIds,
  });
}

function relationVisibleToPlayer(
  relation: JsonObject,
  playerEntityId: string,
): boolean {
  const visibility = expectJsonObject(
    expectProperty(relation, "visibility", "RelationState"),
    "RelationState.visibility",
  );
  const scope = expectString(visibility, "scope", "Visibility");
  switch (scope) {
    case "public":
      return true;
    case "known_to":
      return stringArray(
        expectProperty(visibility, "actor_ids", "Visibility"),
        "Visibility.actor_ids",
      ).includes(playerEntityId);
    case "private":
    case "owner":
      return false;
    default:
      throw new EngineFault(
        "session.render_node.visibility_scope_unknown",
        "Relation has an unknown visibility scope",
        { scope },
      );
  }
}

function addEntitySubject(input: {
  readonly subject: JsonObject;
  readonly worldId: string;
  readonly entities: ReadonlyMap<string, JsonObject>;
  readonly visible: Set<string>;
  readonly source: string;
}): void {
  const entityId = entitySubjectId(input.subject, input.worldId);
  if (entityId === undefined) {
    return;
  }
  requireActiveEntity(input.entities, entityId, input.source);
  input.visible.add(entityId);
}

function entitySubjectId(
  subject: JsonObject,
  worldId: string,
): string | undefined {
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind === "definition") {
    return undefined;
  }
  if (kind !== "entity") {
    throw new EngineFault(
      "session.render_node.subject_kind_unknown",
      "WorldState SubjectRef has an unknown kind",
      { subject_kind: kind },
    );
  }
  const entity = expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
  const subjectWorldId = expectString(entity, "world_id", "EntityRef");
  if (subjectWorldId !== worldId) {
    throw new EngineFault(
      "session.render_node.subject_world_mismatch",
      "WorldState relation subject belongs to another world",
      {
        world_id: worldId,
        subject_world_id: subjectWorldId,
        entity_id: expectString(entity, "entity_id", "EntityRef"),
      },
    );
  }
  return expectString(entity, "entity_id", "EntityRef");
}

function dialogueParticipantEntityId(
  participant: JsonObject,
  worldId: string,
): string | undefined {
  const participantKind = expectString(
    participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind === "system") {
    return undefined;
  }
  if (participantKind !== "entity") {
    throw new EngineFault(
      "session.render_node.dialogue_participant_kind_unknown",
      "Dialogue has an unknown participant kind",
      { participant_kind: participantKind },
    );
  }
  const entity = expectJsonObject(
    expectProperty(participant, "entity", "DialogueParticipantRef"),
    "DialogueParticipantRef.entity",
  );
  const participantWorldId = expectString(
    entity,
    "world_id",
    "EntityRef",
  );
  if (participantWorldId !== worldId) {
    throw new EngineFault(
      "session.render_node.dialogue_world_mismatch",
      "Dialogue participant belongs to another world",
      {
        world_id: worldId,
        participant_world_id: participantWorldId,
        entity_id: expectString(entity, "entity_id", "EntityRef"),
      },
    );
  }
  return expectString(entity, "entity_id", "EntityRef");
}

function staticDefinitionMatches(
  archetype: JsonObject,
  content: WorldContentBinding,
  localId: string,
): boolean {
  return (
    expectString(archetype, "kind", "DefinitionRef") === "static" &&
    expectString(archetype, "bundle_id", "StaticDefinitionRef") ===
      content.packId &&
    expectString(
      archetype,
      "bundle_digest",
      "StaticDefinitionRef",
    ) === content.bundleDigest &&
    expectString(archetype, "local_id", "StaticDefinitionRef") === localId
  );
}

function selectCandidates(
  candidates: readonly RenderCandidate[],
): readonly RenderCandidate[] {
  const selected = new Map<string, RenderCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.slotId}\0${candidate.instance.instanceKey}`;
    const current = selected.get(key);
    if (current === undefined || candidate.priority > current.priority) {
      selected.set(key, candidate);
      continue;
    }
    if (candidate.priority === current.priority) {
      throw new EngineFault(
        "session.render_node.priority_ambiguous",
        "Visible RenderNode bindings tie at the same subject slot priority",
        {
          slot_id: candidate.slotId,
          instance_key: candidate.instance.instanceKey,
          priority: candidate.priority,
          first_binding_id: current.bindingId,
          second_binding_id: candidate.bindingId,
        },
      );
    }
  }
  return Object.freeze(
    [...selected.values()].sort((left, right) => {
      const slotOrder = compareText(left.slotId, right.slotId);
      if (slotOrder !== 0) {
        return slotOrder;
      }
      const instanceOrder = compareText(
        left.instance.instanceKey,
        right.instance.instanceKey,
      );
      return instanceOrder !== 0
        ? instanceOrder
        : compareText(left.bindingId, right.bindingId);
    }),
  );
}

function resolveCandidateAsset(input: {
  readonly candidate: RenderCandidate;
  readonly worldId: string;
  readonly assets: ReadonlyMap<string, JsonObject>;
  readonly profiles: ReadonlyMap<string, JsonObject>;
  readonly visualBindings: readonly JsonObject[];
}): JsonObject {
  const directAssetId = optionalString(
    input.candidate.binding,
    "asset_id",
    "PackBinding",
  );
  const profileId = optionalString(
    input.candidate.binding,
    "materialization_profile_id",
    "PackBinding",
  );
  if ((directAssetId === undefined) === (profileId === undefined)) {
    throw new EngineFault(
      "session.render_node.asset_owner_ambiguous",
      "Renderable PackBinding must select exactly one direct asset or materialization profile",
      { binding_id: input.candidate.bindingId },
    );
  }
  if (directAssetId !== undefined) {
    return requireAssetContent(
      input.assets,
      directAssetId,
      input.candidate.bindingId,
    );
  }

  const profile = input.profiles.get(profileId as string);
  if (profile === undefined) {
    throw new EngineFault(
      "session.render_node.materialization_profile_missing",
      "Renderable PackBinding references an unavailable MaterializationProfile",
      {
        binding_id: input.candidate.bindingId,
        materialization_profile_id: profileId as string,
      },
    );
  }
  if (input.candidate.instance.kind === "entity") {
    const entityId = expectString(
      input.candidate.instance.entity,
      "entity_id",
      "EntityState",
    );
    const entityRevision = expectInteger(
      input.candidate.instance.entity,
      "revision",
      "EntityState",
    );
    const matches = input.visualBindings.filter(
      (binding) =>
        expectString(binding, "state", "VisualBinding") === "active" &&
        expectString(binding, "world_id", "VisualBinding") ===
          input.worldId &&
        expectString(binding, "slot_id", "VisualBinding") ===
          input.candidate.slotId &&
        expectInteger(
          binding,
          "subject_revision",
          "VisualBinding",
        ) === entityRevision &&
        visualBindingTargetsEntity(binding, input.worldId, entityId),
    );
    if (matches.length > 1) {
      throw new EngineFault(
        "session.render_node.visual_binding_ambiguous",
        "Multiple active VisualBindings target the same entity revision and slot",
        {
          binding_id: input.candidate.bindingId,
          entity_id: entityId,
          entity_revision: entityRevision,
          slot_id: input.candidate.slotId,
          matches: matches.length,
        },
      );
    }
    if (matches.length === 1) {
      return expectJsonObject(
        expectProperty(
          matches[0] as JsonObject,
          "asset",
          "VisualBinding",
        ),
        "VisualBinding.asset",
      );
    }
  }
  return requireAssetContent(
    input.assets,
    expectString(
      profile,
      "fallback_asset_id",
      "MaterializationProfile",
    ),
    input.candidate.bindingId,
  );
}

function visualBindingTargetsEntity(
  binding: JsonObject,
  worldId: string,
  entityId: string,
): boolean {
  const subject = expectJsonObject(
    expectProperty(binding, "subject", "VisualBinding"),
    "VisualBinding.subject",
  );
  if (expectString(subject, "kind", "SubjectRef") !== "entity") {
    return false;
  }
  const entity = expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
  return (
    expectString(entity, "world_id", "EntityRef") === worldId &&
    expectString(entity, "entity_id", "EntityRef") === entityId
  );
}

function requireAssetContent(
  assets: ReadonlyMap<string, JsonObject>,
  assetId: string,
  bindingId: string,
): JsonObject {
  const asset = assets.get(assetId);
  if (asset === undefined) {
    throw new EngineFault(
      "session.render_node.asset_missing",
      "Renderable PackBinding references an unavailable PackAsset",
      { binding_id: bindingId, asset_id: assetId },
    );
  }
  return expectJsonObject(
    expectProperty(asset, "content", "PackAsset"),
    "PackAsset.content",
  );
}

function indexWorldRecords(
  records: readonly JsonObject[],
  idField: string,
  label: string,
): ReadonlyMap<string, JsonObject> {
  const index = new Map<string, JsonObject>();
  for (const record of records) {
    const id = expectString(record, idField, label);
    if (index.has(id)) {
      throw new EngineFault(
        "session.render_node.world_identity_duplicate",
        "WorldState contains duplicate runtime record identities",
        { record_type: label, id_field: idField, record_id: id },
      );
    }
    index.set(id, record);
  }
  return index;
}

function indexContentObjects(
  records: readonly JsonObject[],
  idField: string,
  label: string,
): ReadonlyMap<string, JsonObject> {
  const index = new Map<string, JsonObject>();
  for (const record of records) {
    const id = expectString(record, idField, label);
    if (index.has(id)) {
      throw new EngineFault(
        "session.render_node.content_identity_duplicate",
        "Locked ContentBundle contains duplicate presentation identities",
        { record_type: label, id_field: idField, record_id: id },
      );
    }
    index.set(id, record);
  }
  return index;
}

function requireActiveEntity(
  entities: ReadonlyMap<string, JsonObject>,
  entityId: string,
  source: string,
): JsonObject {
  const entity = entities.get(entityId);
  if (
    entity === undefined ||
    expectString(entity, "state", "EntityState") !== "active"
  ) {
    throw new EngineFault(
      "session.render_node.entity_unavailable",
      `${source} must reference an active EntityState`,
      { entity_id: entityId, source },
    );
  }
  return entity;
}

function optionalString(
  object: JsonObject,
  property: string,
  label: string,
): string | undefined {
  const value = object[property];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${property} must be a string`);
  }
  return value;
}

function objectArray(
  value: JsonValue,
  label: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) =>
    expectJsonObject(entry, `${label}[${index}]`),
  );
}

function stringArray(
  value: JsonValue,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new TypeError(`${label}[${index}] must be a string`);
    }
    return entry;
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
