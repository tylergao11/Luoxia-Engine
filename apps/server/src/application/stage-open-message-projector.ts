import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeIdentityMapper,
  WorldContentBinding,
  WorldContentLockDocument,
} from "@luoxia/world-core";

import type { StageContractAuthority } from "./stage-contract-authority.js";

export type StageOpenMessageDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageOpen
>;

export interface StageOpenProjectionInput {
  readonly worldId: string;
  readonly worldContentLock: WorldContentLockDocument;
  readonly stageModuleLocks: readonly JsonObject[];
  readonly worldState: JsonObject;
  readonly playerEntityId: string;
  /**
   * Omit for synchronization of every player-owned open Stage. Supply exact
   * committed ids when projecting a command response.
   */
  readonly stageInstanceIds?: readonly string[];
}

export interface StageOpenMessageProjector {
  project(
    input: StageOpenProjectionInput,
  ): readonly StageOpenMessageDocument[];
}

export interface StageOpenMessageProjectorDependencies {
  readonly contracts: ContractValidator;
  readonly identityMapper: ContentRuntimeIdentityMapper;
  readonly stageContracts: StageContractAuthority;
}

interface BindingCandidate {
  readonly bindingId: string;
  readonly slotId: string;
  readonly priority: number;
  readonly asset: JsonObject;
  readonly instance: BindingInstance;
}

type BindingInstance =
  | {
      readonly kind: "world";
      readonly worldId: string;
      readonly subject: JsonObject;
    }
  | {
      readonly kind: "entity";
      readonly worldId: string;
      readonly entityId: string;
      readonly entity: JsonObject;
      readonly subject: JsonObject;
    };

export function createStageOpenMessageProjector(
  dependencies: StageOpenMessageProjectorDependencies,
): StageOpenMessageProjector {
  return new DefaultStageOpenMessageProjector(dependencies);
}

class DefaultStageOpenMessageProjector
  implements StageOpenMessageProjector
{
  readonly #contracts: ContractValidator;
  readonly #identityMapper: ContentRuntimeIdentityMapper;
  readonly #stageContracts: StageContractAuthority;

  public constructor(dependencies: StageOpenMessageProjectorDependencies) {
    this.#contracts = dependencies.contracts;
    this.#identityMapper = dependencies.identityMapper;
    this.#stageContracts = dependencies.stageContracts;
  }

  public project(
    input: StageOpenProjectionInput,
  ): readonly StageOpenMessageDocument[] {
    this.#contracts.assert(CONTRACT_REF.uuid, input.worldId);
    const worldId = input.worldId;
    const entities = indexRecords(
      objectArray(
        expectProperty(input.worldState, "entities", "WorldState"),
        "WorldState.entities",
      ),
      "entity_id",
      "EntityState",
    );
    requireActiveEntity(entities, input.playerEntityId, "Session player");
    const visualBindings = objectArray(
      expectProperty(
        input.worldState,
        "visual_bindings",
        "WorldState",
      ),
      "WorldState.visual_bindings",
    );
    const requestedIds = readRequestedStageIds(input.stageInstanceIds);
    const stages = objectArray(
      expectProperty(
        input.worldState,
        "stage_instances",
        "WorldState",
      ),
      "WorldState.stage_instances",
    )
      .filter((stage) =>
        stageIsProjected({
          stage,
          worldId,
          playerEntityId: input.playerEntityId,
          requestedIds,
        }),
      )
      .sort((left, right) =>
        compareText(
          expectString(left, "stage_instance_id", "StageInstanceState"),
          expectString(right, "stage_instance_id", "StageInstanceState"),
        ),
      );

    if (requestedIds !== undefined) {
      const projectedIds = new Set(
        stages.map((stage) =>
          expectString(stage, "stage_instance_id", "StageInstanceState"),
        ),
      );
      for (const stageInstanceId of requestedIds) {
        if (!projectedIds.has(stageInstanceId)) {
          throw new EngineFault(
            "stage_open.projection.stage_unavailable",
            "Requested Stage must exist, be open, and include the Session player",
            {
              stage_instance_id: stageInstanceId,
              player_entity_id: input.playerEntityId,
            },
          );
        }
      }
    }

    return Object.freeze(
      stages.map((stage) =>
        this.#projectStage({
          worldContentLock: input.worldContentLock,
          stageModuleLocks: input.stageModuleLocks,
          worldId,
          stage,
          entities,
          visualBindings,
        }),
      ),
    );
  }

  #projectStage(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly worldId: string;
    readonly stage: JsonObject;
    readonly entities: ReadonlyMap<string, JsonObject>;
    readonly visualBindings: readonly JsonObject[];
  }): StageOpenMessageDocument {
    const stageInstanceId = expectString(
      input.stage,
      "stage_instance_id",
      "StageInstanceState",
    );
    const stageModuleLock = expectJsonObject(
      expectProperty(
        input.stage,
        "stage_module_lock",
        "StageInstanceState",
      ),
      "StageInstanceState.stage_module_lock",
    );
    const sceneId = expectString(
      input.stage,
      "scene_id",
      "StageInstanceState",
    );
    const contract = this.#stageContracts.assertAllowed({
      worldContentLock: input.worldContentLock,
      stageModuleLocks: input.stageModuleLocks,
      stageModuleLock,
      sceneId,
      completionRules: objectArray(
        expectProperty(
          input.stage,
          "completion_rules",
          "StageInstanceState",
        ),
        "StageInstanceState.completion_rules",
      ),
    });
    const scene = contract.scene;
    const participantIds = new Set(
      objectArray(
        expectProperty(
          input.stage,
          "participants",
          "StageInstanceState",
        ),
        "StageInstanceState.participants",
      ).map((participant) => {
        const participantWorldId = expectString(
          participant,
          "world_id",
          "EntityRef",
        );
        if (participantWorldId !== input.worldId) {
          throw new EngineFault(
            "stage_open.projection.participant_world_mismatch",
            "Stage participant belongs to another world",
            {
              stage_instance_id: stageInstanceId,
              expected_world_id: input.worldId,
              participant_world_id: participantWorldId,
            },
          );
        }
        const entityId = expectString(
          participant,
          "entity_id",
          "EntityRef",
        );
        requireEntity(
          input.entities,
          entityId,
          "Open Stage participant",
        );
        return entityId;
      }),
    );
    const assets = indexRecords(
      contract.content.presentation.assets,
      "asset_id",
      "PackAsset",
    );
    const profiles = indexRecords(
      contract.content.presentation.materializationProfiles,
      "materialization_profile_id",
      "MaterializationProfile",
    );
    const candidates: BindingCandidate[] = [];

    for (const binding of contract.bindings) {
      candidates.push(
        ...this.#bindingCandidates({
          binding,
          worldId: input.worldId,
          content: contract.content,
          participantIds,
          entities: input.entities,
          assets,
          profiles,
          visualBindings: input.visualBindings,
        }),
      );
    }

    const selected = selectStageBindings(candidates);
    return this.#contracts.assertObject(CONTRACT_REF.stageOpen, {
      type: "stage.open",
      stage_instance_id: stageInstanceId,
      stage_revision: expectInteger(
        input.stage,
        "revision",
        "StageInstanceState",
      ),
      stage_module_lock: stageModuleLock,
      scene_id: sceneId,
      visible_context: expectProperty(
        input.stage,
        "state",
        "StageInstanceState",
      ),
      allowed_input_types: scene.inputTypes,
      bindings: selected.map((candidate) =>
        Object.freeze({
          binding_id: candidate.bindingId,
          subject: candidate.instance.subject,
          slot_id: candidate.slotId,
          asset: candidate.asset,
        }),
      ),
    });
  }

  #bindingCandidates(input: {
    readonly binding: JsonObject;
    readonly worldId: string;
    readonly content: WorldContentBinding;
    readonly participantIds: ReadonlySet<string>;
    readonly entities: ReadonlyMap<string, JsonObject>;
    readonly assets: ReadonlyMap<string, JsonObject>;
    readonly profiles: ReadonlyMap<string, JsonObject>;
    readonly visualBindings: readonly JsonObject[];
  }): readonly BindingCandidate[] {
    const subjectKind = expectString(
      input.binding,
      "subject_kind",
      "PackBinding",
    );
    const subjectId = expectString(
      input.binding,
      "subject_id",
      "PackBinding",
    );
    const instances: BindingInstance[] = [];
    switch (subjectKind) {
      case "world":
        if (
          subjectId ===
          expectString(
            input.content.worldDefinition,
            "world_id",
            "WorldDefinition",
          )
        ) {
          instances.push(
            Object.freeze({
              kind: "world",
              worldId: input.worldId,
              subject: Object.freeze({
                kind: "world",
                world_id: input.worldId,
              }),
            }),
          );
        }
        break;
      case "entity": {
        const entityId = this.#identityMapper.toRuntimeUuid({
          worldId: input.worldId,
          packId: input.content.packId,
          kind: "entity",
          localId: subjectId,
        });
        if (input.participantIds.has(entityId)) {
          instances.push(
            createEntityBindingInstance({
              worldId: input.worldId,
              entityId,
              entity: requireEntity(
                input.entities,
                entityId,
                "Stage content entity",
              ),
            }),
          );
        }
        break;
      }
      case "definition":
        for (const entityId of input.participantIds) {
          const entity = requireEntity(
            input.entities,
            entityId,
            "Stage participant",
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
            instances.push(
              createEntityBindingInstance({
                worldId: input.worldId,
                entityId,
                entity,
              }),
            );
          }
        }
        break;
      case "relation":
      case "capability":
      case "generation_archetype":
        throw new EngineFault(
          "stage_open.projection.subject_kind_unsupported",
          "Stage PackBinding subject has no unambiguous Stage participant instance",
          {
            binding_id: expectString(
              input.binding,
              "binding_id",
              "PackBinding",
            ),
            subject_kind: subjectKind,
          },
        );
      default:
        throw new EngineFault(
          "stage_open.projection.subject_kind_unknown",
          "Stage PackBinding has an unknown subject kind",
          { subject_kind: subjectKind },
        );
    }

    return Object.freeze(
      instances.map((instance) =>
        Object.freeze({
          bindingId: expectString(
            input.binding,
            "binding_id",
            "PackBinding",
          ),
          slotId: expectString(input.binding, "slot_id", "PackBinding"),
          priority: expectInteger(
            input.binding,
            "priority",
            "PackBinding",
          ),
          asset: resolveBindingAsset({
            binding: input.binding,
            worldId: input.worldId,
            instanceEntity:
              instance.kind === "entity" ? instance.entity : undefined,
            assets: input.assets,
            profiles: input.profiles,
            visualBindings: input.visualBindings,
          }),
          instance,
        }),
      ),
    );
  }
}

function createEntityBindingInstance(input: {
  readonly worldId: string;
  readonly entityId: string;
  readonly entity: JsonObject;
}): BindingInstance {
  return Object.freeze({
    kind: "entity",
    worldId: input.worldId,
    entityId: input.entityId,
    entity: input.entity,
    subject: Object.freeze({
      kind: "entity",
      entity: Object.freeze({
        world_id: input.worldId,
        entity_id: input.entityId,
        expected_revision: expectInteger(
          input.entity,
          "revision",
          "EntityState",
        ),
      }),
    }),
  });
}

function readRequestedStageIds(
  stageInstanceIds: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (stageInstanceIds === undefined) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const stageInstanceId of stageInstanceIds) {
    if (ids.has(stageInstanceId)) {
      throw new EngineFault(
        "stage_open.projection.stage_id_duplicate",
        "Requested Stage instance ids must be unique",
        { stage_instance_id: stageInstanceId },
      );
    }
    ids.add(stageInstanceId);
  }
  return ids;
}

function stageIsProjected(input: {
  readonly stage: JsonObject;
  readonly worldId: string;
  readonly playerEntityId: string;
  readonly requestedIds: ReadonlySet<string> | undefined;
}): boolean {
  const stageInstanceId = expectString(
    input.stage,
    "stage_instance_id",
    "StageInstanceState",
  );
  if (
    input.requestedIds !== undefined &&
    !input.requestedIds.has(stageInstanceId)
  ) {
    return false;
  }
  if (
    expectString(input.stage, "status", "StageInstanceState") !== "open"
  ) {
    return false;
  }
  return objectArray(
    expectProperty(input.stage, "participants", "StageInstanceState"),
    "StageInstanceState.participants",
  ).some(
    (participant) =>
      expectString(participant, "world_id", "EntityRef") === input.worldId &&
      expectString(participant, "entity_id", "EntityRef") ===
        input.playerEntityId,
  );
}

function resolveBindingAsset(input: {
  readonly binding: JsonObject;
  readonly worldId: string;
  readonly instanceEntity: JsonObject | undefined;
  readonly assets: ReadonlyMap<string, JsonObject>;
  readonly profiles: ReadonlyMap<string, JsonObject>;
  readonly visualBindings: readonly JsonObject[];
}): JsonObject {
  const assetId = optionalString(input.binding, "asset_id");
  const profileId = optionalString(
    input.binding,
    "materialization_profile_id",
  );
  if ((assetId === undefined) === (profileId === undefined)) {
    throw new EngineFault(
      "stage_open.projection.asset_owner_ambiguous",
      "Stage PackBinding must select exactly one direct asset or materialization profile",
      {
        binding_id: expectString(
          input.binding,
          "binding_id",
          "PackBinding",
        ),
      },
    );
  }
  if (assetId !== undefined) {
    return requireAssetContent(input.assets, assetId, input.binding);
  }

  const profile = input.profiles.get(profileId as string);
  if (profile === undefined) {
    throw new EngineFault(
      "stage_open.projection.materialization_profile_missing",
      "Stage PackBinding references an unavailable MaterializationProfile",
      {
        binding_id: expectString(
          input.binding,
          "binding_id",
          "PackBinding",
        ),
        materialization_profile_id: profileId as string,
      },
    );
  }
  if (input.instanceEntity !== undefined) {
    const entityId = expectString(
      input.instanceEntity,
      "entity_id",
      "EntityState",
    );
    const entityRevision = expectInteger(
      input.instanceEntity,
      "revision",
      "EntityState",
    );
    const slotId = expectString(input.binding, "slot_id", "PackBinding");
    const matches = input.visualBindings.filter((binding) =>
      visualBindingMatches({
        binding,
        worldId: input.worldId,
        entityId,
        entityRevision,
        slotId,
      }),
    );
    if (matches.length > 1) {
      throw new EngineFault(
        "stage_open.projection.visual_binding_ambiguous",
        "Multiple VisualBindings target the same Stage entity revision and slot",
        {
          entity_id: entityId,
          entity_revision: entityRevision,
          slot_id: slotId,
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
    input.binding,
  );
}

function visualBindingMatches(input: {
  readonly binding: JsonObject;
  readonly worldId: string;
  readonly entityId: string;
  readonly entityRevision: number;
  readonly slotId: string;
}): boolean {
  if (
    expectString(input.binding, "world_id", "VisualBinding") !==
      input.worldId ||
    expectInteger(
      input.binding,
      "subject_revision",
      "VisualBinding",
    ) !== input.entityRevision ||
    expectString(input.binding, "slot_id", "VisualBinding") !== input.slotId
  ) {
    return false;
  }
  const subject = expectJsonObject(
    expectProperty(input.binding, "subject", "VisualBinding"),
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
    expectString(entity, "world_id", "EntityRef") === input.worldId &&
    expectString(entity, "entity_id", "EntityRef") === input.entityId
  );
}

function requireAssetContent(
  assets: ReadonlyMap<string, JsonObject>,
  assetId: string,
  binding: JsonObject,
): JsonObject {
  const asset = assets.get(assetId);
  if (asset === undefined) {
    throw new EngineFault(
      "stage_open.projection.asset_missing",
      "Stage PackBinding references an unavailable PackAsset",
      {
        binding_id: expectString(binding, "binding_id", "PackBinding"),
        asset_id: assetId,
      },
    );
  }
  return expectJsonObject(
    expectProperty(asset, "content", "PackAsset"),
    "PackAsset.content",
  );
}

function selectStageBindings(
  candidates: readonly BindingCandidate[],
): readonly BindingCandidate[] {
  const worldSelections = new Map<
    string,
    Map<string, BindingCandidate>
  >();
  const entitySelections = new Map<
    string,
    Map<string, Map<string, BindingCandidate>>
  >();

  for (const candidate of candidates) {
    if (candidate.instance.kind === "world") {
      const slotSelections = getOrCreate(
        worldSelections,
        candidate.instance.worldId,
        () => new Map<string, BindingCandidate>(),
      );
      selectSubjectSlotBinding(slotSelections, candidate);
      continue;
    }

    const entityWorldSelections = getOrCreate(
      entitySelections,
      candidate.instance.worldId,
      () => new Map<string, Map<string, BindingCandidate>>(),
    );
    const slotSelections = getOrCreate(
      entityWorldSelections,
      candidate.instance.entityId,
      () => new Map<string, BindingCandidate>(),
    );
    selectSubjectSlotBinding(slotSelections, candidate);
  }

  const selected: BindingCandidate[] = [];
  for (const slotSelections of worldSelections.values()) {
    selected.push(...slotSelections.values());
  }
  for (const entityWorldSelections of entitySelections.values()) {
    for (const slotSelections of entityWorldSelections.values()) {
      selected.push(...slotSelections.values());
    }
  }
  selected.sort(compareStageBindingCandidates);
  return Object.freeze(selected);
}

function selectSubjectSlotBinding(
  slotSelections: Map<string, BindingCandidate>,
  candidate: BindingCandidate,
): void {
  const current = slotSelections.get(candidate.slotId);
  if (current === undefined || candidate.priority > current.priority) {
    slotSelections.set(candidate.slotId, candidate);
    return;
  }
  if (candidate.priority === current.priority) {
    throw new EngineFault(
      "stage_open.projection.binding_priority_ambiguous",
      "Stage PackBindings tie at the same runtime subject slot priority",
      {
        subject: candidate.instance.subject,
        slot_id: candidate.slotId,
        priority: candidate.priority,
        first_binding_id: current.bindingId,
        second_binding_id: candidate.bindingId,
      },
    );
  }
}

function compareStageBindingCandidates(
  left: BindingCandidate,
  right: BindingCandidate,
): number {
  const slotOrder = compareText(left.slotId, right.slotId);
  if (slotOrder !== 0) {
    return slotOrder;
  }
  if (left.instance.kind !== right.instance.kind) {
    return left.instance.kind === "world" ? -1 : 1;
  }
  const worldOrder = compareText(
    left.instance.worldId,
    right.instance.worldId,
  );
  if (worldOrder !== 0) {
    return worldOrder;
  }
  if (
    left.instance.kind === "entity" &&
    right.instance.kind === "entity"
  ) {
    return compareText(left.instance.entityId, right.instance.entityId);
  }
  return 0;
}

function getOrCreate<TKey, TValue>(
  index: Map<TKey, TValue>,
  key: TKey,
  create: () => TValue,
): TValue {
  const current = index.get(key);
  if (current !== undefined) {
    return current;
  }
  const value = create();
  index.set(key, value);
  return value;
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

function requireActiveEntity(
  entities: ReadonlyMap<string, JsonObject>,
  entityId: string,
  source: string,
): JsonObject {
  const entity = requireEntity(entities, entityId, source);
  if (expectString(entity, "state", "EntityState") !== "active") {
    throw new EngineFault(
      "stage_open.projection.entity_unavailable",
      `${source} must reference an active EntityState`,
      { entity_id: entityId, source },
    );
  }
  return entity;
}

function requireEntity(
  entities: ReadonlyMap<string, JsonObject>,
  entityId: string,
  source: string,
): JsonObject {
  const entity = entities.get(entityId);
  if (entity === undefined) {
    throw new EngineFault(
      "stage_open.projection.entity_missing",
      `${source} must reference an existing EntityState`,
      { entity_id: entityId, source },
    );
  }
  return entity;
}

function indexRecords(
  records: readonly JsonObject[],
  idField: string,
  label: string,
): ReadonlyMap<string, JsonObject> {
  const index = new Map<string, JsonObject>();
  for (const record of records) {
    const id = expectString(record, idField, label);
    if (index.has(id)) {
      throw new EngineFault(
        "stage_open.projection.identity_duplicate",
        `${label} identities must be unique`,
        {
          record_type: label,
          record_id: id,
        },
      );
    }
    index.set(id, record);
  }
  return index;
}

function optionalString(
  object: JsonObject,
  property: string,
): string | undefined {
  const value = object[property];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new EngineFault(
      "stage_open.projection.shape_invalid",
      `${property} must be a string when present`,
      { property },
    );
  }
  return value;
}

function objectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "stage_open.projection.shape_invalid",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry, `${path}[${index}]`),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
