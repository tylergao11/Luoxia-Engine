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
} from "@luoxia/contracts-runtime";
import {
  materializeContentFieldValues,
  type ContentRuntimeCatalog,
  type ContentRuntimeIdentityMapper,
  type WorldContentBinding,
} from "@luoxia/world-core";

import type {
  RuntimeWorldRecord,
} from "./runtime-persistence.js";
import type { RuntimeSaveService } from "./runtime-save.js";

export interface RuntimeWorldCreationIdFactory {
  createId(): string;
}

export interface RuntimeWorldCreationClock {
  now(): string;
}

export interface RuntimeWorldCreationService {
  create(input: {
    readonly worldContentLockCandidate: unknown;
    readonly playerNameCandidate: unknown;
  }): Promise<RuntimeWorldCreationResult>;
}

export interface RuntimeWorldCreationResult {
  readonly worldId: string;
  readonly playerEntityId: string;
  readonly humanControlBindingId: string;
  readonly world: RuntimeWorldRecord;
}

export interface RuntimeWorldCreationServiceDependencies {
  readonly contracts: ContractValidator;
  readonly catalog: ContentRuntimeCatalog;
  readonly identityMapper: ContentRuntimeIdentityMapper;
  readonly idFactory: RuntimeWorldCreationIdFactory;
  readonly clock: RuntimeWorldCreationClock;
  readonly saves: RuntimeSaveService;
}

interface RuntimeIdentityMaps {
  readonly entities: ReadonlyMap<string, string>;
  readonly relations: ReadonlyMap<string, string>;
  readonly machineBindings: ReadonlyMap<string, string>;
}

interface InitialWorldContext {
  readonly binding: WorldContentBinding;
  readonly worldId: string;
  readonly playerEntityId: string;
  readonly humanControlBindingId: string;
  readonly playerLocationRelationId: string;
  readonly playerName: JsonObject;
  readonly createdAt: string;
  readonly identities: RuntimeIdentityMaps;
  readonly claims: RuntimeIdentityClaims;
  readonly idFactory: RuntimeWorldCreationIdFactory;
}

/**
 * Sole callable new-world bootstrap.
 *
 * The input contains only the explicit content lock and player name. Runtime
 * identities and time are Server-owned. The complete revision-zero snapshot is
 * Schema-validated, wrapped in the deployment-derived SaveEnvelope, and only
 * then atomically decomposed into PostgreSQL.
 */
export function createRuntimeWorldCreationService(
  dependencies: RuntimeWorldCreationServiceDependencies,
): RuntimeWorldCreationService {
  return Object.freeze({
    async create(input: {
      readonly worldContentLockCandidate: unknown;
      readonly playerNameCandidate: unknown;
    }): Promise<RuntimeWorldCreationResult> {
      const worldContentLock = dependencies.contracts.assertObject(
        CONTRACT_REF.worldContentLock,
        input.worldContentLockCandidate,
      );
      const playerName = dependencies.contracts.assertObject(
        CONTRACT_REF.localizedText,
        input.playerNameCandidate,
      );
      const binding =
        dependencies.catalog.resolveWorldContentBinding(worldContentLock);
      const claims = new RuntimeIdentityClaims(dependencies.contracts);
      const worldId = claims.claim(
        dependencies.idFactory.createId(),
        "runtime world",
      );
      const identities = buildContentIdentityMaps({
        binding,
        worldId,
        identityMapper: dependencies.identityMapper,
        claims,
      });
      const playerEntityId = claims.claim(
        dependencies.idFactory.createId(),
        "player Entity",
      );
      const humanControlBindingId = claims.claim(
        dependencies.idFactory.createId(),
        "human ControlBinding",
      );
      const playerLocationRelationId = claims.claim(
        dependencies.idFactory.createId(),
        "player location Relation",
      );
      const createdAt = dependencies.clock.now();
      const context: InitialWorldContext = Object.freeze({
        binding,
        worldId,
        playerEntityId,
        humanControlBindingId,
        playerLocationRelationId,
        playerName: playerName.value,
        createdAt,
        identities,
        claims,
        idFactory: dependencies.idFactory,
      });
      const snapshot = dependencies.contracts.assertObject(
        CONTRACT_REF.worldSnapshot,
        buildWorldSnapshotCandidate(context),
      );
      const world = await dependencies.saves.createInitial({
        snapshot,
        worldContentLock,
        createdAt,
      });
      return Object.freeze({
        worldId,
        playerEntityId,
        humanControlBindingId,
        world,
      });
    },
  });
}

function buildContentIdentityMaps(input: {
  readonly binding: WorldContentBinding;
  readonly worldId: string;
  readonly identityMapper: ContentRuntimeIdentityMapper;
  readonly claims: RuntimeIdentityClaims;
}): RuntimeIdentityMaps {
  const entities = new Map<string, string>();
  for (const [index, entity] of input.binding.initialization.entities.entries()) {
    const localId = expectString(
      entity,
      "entity_id",
      `WorldInitializationContent.entities[${index}]`,
    );
    if (entities.has(localId)) {
      throw new EngineFault(
        "runtime.world_creation.content_identity_duplicate",
        "Initial content Entity local ID appears more than once",
        { local_id: localId, content_kind: "entity" },
      );
    }
    entities.set(
      localId,
      input.claims.claim(
        input.identityMapper.toRuntimeUuid({
          worldId: input.worldId,
          packId: input.binding.packId,
          kind: "entity",
          localId,
        }),
        `content Entity ${localId}`,
      ),
    );
  }

  const relations = new Map<string, string>();
  for (const [
    index,
    relation,
  ] of input.binding.initialization.relations.entries()) {
    const localId = expectString(
      relation,
      "relation_id",
      `WorldInitializationContent.relations[${index}]`,
    );
    if (relations.has(localId)) {
      throw new EngineFault(
        "runtime.world_creation.content_identity_duplicate",
        "Initial content Relation local ID appears more than once",
        { local_id: localId, content_kind: "relation" },
      );
    }
    relations.set(
      localId,
      input.claims.claim(
        input.identityMapper.toRuntimeUuid({
          worldId: input.worldId,
          packId: input.binding.packId,
          kind: "relation",
          localId,
        }),
        `content Relation ${localId}`,
      ),
    );
  }

  const machineBindings = new Map<string, string>();
  for (const [
    index,
    binding,
  ] of input.binding.initialization.machineBindings.entries()) {
    const localId = expectString(
      binding,
      "binding_id",
      `WorldInitializationContent.machineBindings[${index}]`,
    );
    if (machineBindings.has(localId)) {
      throw new EngineFault(
        "runtime.world_creation.content_identity_duplicate",
        "Initial machine binding local ID appears more than once",
        { local_id: localId, content_kind: "state_machine_binding" },
      );
    }
    machineBindings.set(
      localId,
      input.claims.claim(
        input.identityMapper.toRuntimeUuid({
          worldId: input.worldId,
          packId: input.binding.packId,
          kind: "state_machine_binding",
          localId,
        }),
        `content StateMachine binding ${localId}`,
      ),
    );
  }

  return Object.freeze({
    entities,
    relations,
    machineBindings,
  });
}

function buildWorldSnapshotCandidate(context: InitialWorldContext): JsonObject {
  const worldDefinition = context.binding.worldDefinition;
  const contentProvenance = (): JsonObject => ({
    origin_kind: "content_bundle",
    origin_id: context.binding.bundleDigest,
    created_at: context.createdAt,
  });
  const creationProvenance = (): JsonObject => ({
    origin_kind: "operator",
    origin_id: context.worldId,
    created_at: context.createdAt,
  });

  const entities = context.binding.initialization.entities.map(
    (entity, index): JsonObject => {
      const path = `WorldInitializationContent.entities[${index}]`;
      const localId = expectString(entity, "entity_id", path);
      return {
        entity_id: requireMappedIdentity(
          context.identities.entities,
          localId,
          `${path}.entity_id`,
        ),
        revision: 0,
        archetype: staticDefinitionRef(
          context.binding,
          expectString(entity, "archetype_definition_id", path),
        ),
        name: expectProperty(entity, "name", path),
        components: materializeComponents(
          expectProperty(entity, "components", path),
          `${path}.components`,
          context.binding,
        ),
        state: "active",
        provenance: contentProvenance(),
      };
    },
  );
  entities.push({
    entity_id: context.playerEntityId,
    revision: 0,
    archetype: staticDefinitionRef(
      context.binding,
      expectString(
        worldDefinition,
        "player_archetype_definition_id",
        "WorldDefinition",
      ),
    ),
    name: context.playerName,
    components: materializeComponents(
      expectProperty(
        worldDefinition,
        "player_initial_components",
        "WorldDefinition",
      ),
      "WorldDefinition.player_initial_components",
      context.binding,
    ),
    state: "active",
    provenance: creationProvenance(),
  });

  const relations = context.binding.initialization.relations.map(
    (relation, index): JsonObject => {
      const path = `WorldInitializationContent.relations[${index}]`;
      const localId = expectString(relation, "relation_id", path);
      return {
        relation_id: requireMappedIdentity(
          context.identities.relations,
          localId,
          `${path}.relation_id`,
        ),
        revision: 0,
        relation_type: catalogRef(
          context.binding,
          "relation_type",
          expectString(relation, "relation_type_id", path),
        ),
        from: materializeLocalSubject(
          expectProperty(relation, "from", path),
          `${path}.from`,
          context,
        ),
        to: materializeLocalSubject(
          expectProperty(relation, "to", path),
          `${path}.to`,
          context,
        ),
        data: materializeContentFieldValues(
          expectProperty(relation, "fields", path),
          `${path}.fields`,
        ),
        visibility: materializeInitialVisibility(
          expectProperty(relation, "visibility", path),
          `${path}.visibility`,
          context,
        ),
        state: "active",
        provenance: contentProvenance(),
      };
    },
  );
  const startLocationLocalId = expectString(
    worldDefinition,
    "start_location_entity_id",
    "WorldDefinition",
  );
  relations.push({
    relation_id: context.playerLocationRelationId,
    revision: 0,
    relation_type: catalogRef(
      context.binding,
      "relation_type",
      expectString(
        worldDefinition,
        "player_location_relation_type_id",
        "WorldDefinition",
      ),
    ),
    from: entitySubject(context.worldId, context.playerEntityId),
    to: entitySubject(
      context.worldId,
      requireMappedIdentity(
        context.identities.entities,
        startLocationLocalId,
        "WorldDefinition.start_location_entity_id",
      ),
    ),
    data: materializeContentFieldValues(
      expectProperty(
        worldDefinition,
        "player_location_fields",
        "WorldDefinition",
      ),
      "WorldDefinition.player_location_fields",
    ),
    visibility: materializeInitialVisibility(
      expectProperty(
        worldDefinition,
        "player_location_visibility",
        "WorldDefinition",
      ),
      "WorldDefinition.player_location_visibility",
      context,
    ),
    state: "active",
    provenance: creationProvenance(),
  });

  const controlBindings: JsonObject[] = [
    {
      binding_id: context.humanControlBindingId,
      binding_kind: "human",
      entity_id: context.playerEntityId,
      status: "active",
    },
  ];
  for (const [
    index,
    mind,
  ] of context.binding.initialization.characterMinds.entries()) {
    const path = `WorldInitializationContent.characterMinds[${index}]`;
    const localEntityId = expectString(mind, "entity_id", path);
    const mindId = expectString(mind, "mind_id", path);
    controlBindings.push({
      binding_id: context.claims.claim(
        context.idFactory.createId(),
        `CharacterMind ControlBinding ${mindId}`,
      ),
      binding_kind: "character_mind",
      entity_id: requireMappedIdentity(
        context.identities.entities,
        localEntityId,
        `${path}.entity_id`,
      ),
      mind_profile: catalogRef(
        context.binding,
        "character_mind",
        mindId,
      ),
      status: "active",
    });
  }

  return {
    world_id: context.worldId,
    world_revision: 0,
    world_state: {
      clock: expectJsonObject(
        expectProperty(worldDefinition, "initial_time", "WorldDefinition"),
        "WorldDefinition.initial_time",
      ),
      dynamic_definitions: [],
      entities,
      relations,
      ledgers: [],
      facts: [],
      knowledge: [],
      memories: [],
      schedules: [],
      goal_plans: [],
      stage_instances: [],
      visual_bindings: [],
      control_bindings: controlBindings,
      day_cycle: {
        day: 1,
        phase: "autonomous",
        phase_revision: 0,
      },
      state_machines: materializeInitialStateMachines(context),
      dialogues: [],
      event_budgets: [],
      event_cards: [],
    },
  };
}

function materializeComponents(
  candidate: JsonValue,
  path: string,
  binding: WorldContentBinding,
): JsonObject[] {
  return asObjectArray(candidate, path).map(
    (component, index): JsonObject => {
      const componentPath = `${path}[${index}]`;
      return {
        component_type: catalogRef(
          binding,
          "component_type",
          expectString(component, "component_type_id", componentPath),
        ),
        ordinal: expectInteger(component, "ordinal", componentPath),
        value: materializeContentFieldValues(
          expectProperty(component, "fields", componentPath),
          `${componentPath}.fields`,
        ),
      };
    },
  );
}

function materializeLocalSubject(
  candidate: JsonValue,
  path: string,
  context: InitialWorldContext,
): JsonObject {
  const subject = expectJsonObject(candidate, path);
  const kind = expectString(subject, "kind", path);
  const localId = expectString(subject, "id", path);
  switch (kind) {
    case "entity":
      return entitySubject(
        context.worldId,
        requireMappedIdentity(
          context.identities.entities,
          localId,
          `${path}.id`,
        ),
      );
    case "definition":
      return {
        kind: "definition",
        definition: staticDefinitionRef(context.binding, localId),
      };
    default:
      throw new EngineFault(
        "runtime.world_creation.subject_kind_unknown",
        "Initial relation subject kind is not supported",
        { path, kind },
      );
  }
}

function materializeInitialVisibility(
  candidate: JsonValue,
  path: string,
  context: InitialWorldContext,
): JsonObject {
  const visibility = expectJsonObject(candidate, path);
  const scope = expectString(visibility, "scope", path);
  switch (scope) {
    case "private":
    case "owner":
    case "public":
      return { scope };
    case "known_to": {
      const actorIds: string[] = [];
      const seen = new Set<string>();
      for (const [index, actor] of asObjectArray(
        expectProperty(visibility, "actors", path),
        `${path}.actors`,
      ).entries()) {
        const actorPath = `${path}.actors[${index}]`;
        const actorKind = expectString(actor, "actor_kind", actorPath);
        const actorId =
          actorKind === "player"
            ? context.playerEntityId
            : actorKind === "entity"
              ? requireMappedIdentity(
                  context.identities.entities,
                  expectString(actor, "entity_id", actorPath),
                  `${actorPath}.entity_id`,
                )
              : undefined;
        if (actorId === undefined) {
          throw new EngineFault(
            "runtime.world_creation.visibility_actor_kind_unknown",
            "Initial visibility actor kind is not supported",
            { path: actorPath, actor_kind: actorKind },
          );
        }
        if (seen.has(actorId)) {
          throw new EngineFault(
            "runtime.world_creation.visibility_actor_duplicate",
            "Initial visibility actors resolve to the same runtime Entity",
            { path: actorPath, actor_id: actorId },
          );
        }
        seen.add(actorId);
        actorIds.push(actorId);
      }
      return { scope, actor_ids: actorIds };
    }
    default:
      throw new EngineFault(
        "runtime.world_creation.visibility_scope_unknown",
        "Initial visibility scope is not supported",
        { path, scope },
      );
  }
}

function materializeInitialStateMachines(
  context: InitialWorldContext,
): JsonObject[] {
  const machines = new Map<string, JsonObject>();
  for (const [
    index,
    machine,
  ] of context.binding.initialization.stateMachines.entries()) {
    const machineId = expectString(
      machine,
      "machine_id",
      `WorldInitializationContent.stateMachines[${index}]`,
    );
    if (machines.has(machineId)) {
      throw new EngineFault(
        "runtime.world_creation.machine_duplicate",
        "Initial state machine ID appears more than once",
        { machine_id: machineId },
      );
    }
    machines.set(machineId, machine);
  }

  return context.binding.initialization.machineBindings.map(
    (machineBinding, index): JsonObject => {
      const path = `WorldInitializationContent.machineBindings[${index}]`;
      const bindingId = expectString(machineBinding, "binding_id", path);
      const machineId = expectString(machineBinding, "machine_id", path);
      const machine = machines.get(machineId);
      if (machine === undefined) {
        throw new EngineFault(
          "runtime.world_creation.machine_missing",
          "InitialMachineBinding references a machine outside the selected world",
          { binding_id: bindingId, machine_id: machineId },
        );
      }
      const bindingKind = expectString(
        machineBinding,
        "binding_kind",
        path,
      );
      const machineScope = expectString(
        machine,
        "machine_scope",
        "StateMachineDefinition",
      );
      if (bindingKind !== machineScope) {
        throw new EngineFault(
          "runtime.world_creation.machine_scope_mismatch",
          "InitialMachineBinding kind differs from its StateMachineDefinition scope",
          {
            binding_id: bindingId,
            binding_kind: bindingKind,
            machine_id: machineId,
            machine_scope: machineScope,
          },
        );
      }
      const base: Record<string, JsonValue> = {
        instance_id: requireMappedIdentity(
          context.identities.machineBindings,
          bindingId,
          `${path}.binding_id`,
        ),
        machine_scope: machineScope,
        machine: catalogRef(
          context.binding,
          "state_machine",
          machineId,
        ),
        frames: [
          {
            frame_id: context.claims.claim(
              context.idFactory.createId(),
              `StateMachine initial frame ${bindingId}`,
            ),
            state: {
              state_kind: "defined",
              state_id: expectString(
                machine,
                "initial_state_id",
                "StateMachineDefinition",
              ),
            },
            entered_day: 1,
            tenure: {
              tenure_kind: "indefinite",
            },
            continuation: {
              continuation_kind: "remain",
            },
          },
        ],
        revision: 0,
      };
      if (machineScope === "character") {
        base["owner_entity_id"] = requireMappedIdentity(
          context.identities.entities,
          expectString(machineBinding, "entity_id", path),
          `${path}.entity_id`,
        );
      } else if (machineScope === "world") {
        base["world_id"] = context.worldId;
      } else {
        throw new EngineFault(
          "runtime.world_creation.machine_scope_unknown",
          "StateMachineDefinition scope is not supported",
          { machine_id: machineId, machine_scope: machineScope },
        );
      }
      return base;
    },
  );
}

function staticDefinitionRef(
  binding: WorldContentBinding,
  localId: string,
): JsonObject {
  return {
    kind: "static",
    bundle_id: binding.packId,
    bundle_digest: binding.bundleDigest,
    local_id: localId,
  };
}

function catalogRef(
  binding: WorldContentBinding,
  catalogKind:
    | "component_type"
    | "relation_type"
    | "state_machine"
    | "character_mind",
  localId: string,
): JsonObject {
  return {
    bundle_id: binding.packId,
    bundle_digest: binding.bundleDigest,
    catalog_kind: catalogKind,
    local_id: localId,
  };
}

function entitySubject(worldId: string, entityId: string): JsonObject {
  return {
    kind: "entity",
    entity: {
      world_id: worldId,
      entity_id: entityId,
    },
  };
}

function requireMappedIdentity(
  identities: ReadonlyMap<string, string>,
  localId: string,
  path: string,
): string {
  const runtimeId = identities.get(localId);
  if (runtimeId === undefined) {
    throw new EngineFault(
      "runtime.world_creation.content_identity_missing",
      "Content local ID has no runtime identity in the selected bundle",
      { path, local_id: localId },
    );
  }
  return runtimeId;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.world_creation.array_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry, `${path}[${index}]`),
  );
}

class RuntimeIdentityClaims {
  readonly #contracts: ContractValidator;
  readonly #labels = new Map<string, string>();

  public constructor(contracts: ContractValidator) {
    this.#contracts = contracts;
  }

  public claim(candidate: string, label: string): string {
    this.#contracts.assert(CONTRACT_REF.uuid, candidate);
    if (candidate !== candidate.toLowerCase()) {
      throw new EngineFault(
        "runtime.world_creation.uuid_noncanonical",
        "Server-created runtime UUIDs must use lowercase canonical text",
        { label, uuid: candidate },
      );
    }
    const existing = this.#labels.get(candidate);
    if (existing !== undefined) {
      throw new EngineFault(
        "runtime.world_creation.uuid_collision",
        "Two new-world identities resolved to the same runtime UUID",
        {
          uuid: candidate,
          first_identity: existing,
          second_identity: label,
        },
      );
    }
    this.#labels.set(candidate, label);
    return candidate;
  }
}
