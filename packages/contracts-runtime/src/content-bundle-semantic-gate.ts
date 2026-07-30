import type {
  ContentBundleDocument,
  ContentBundleSemanticGate,
} from "./content-bundle.js";
import type { ContractValidator } from "./contract-validator.js";
import { EngineFault } from "./fault.js";
import {
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import { CONTRACT_REF } from "./references.js";

type TypeKind = "definition" | "component" | "relation";
type DependencyKind =
  | "content_pack"
  | "rule_plugin"
  | "stage_module"
  | "asset_provider";
interface DependencyRecord {
  readonly kind: DependencyKind;
  readonly required: boolean;
}
type PromptPurpose =
  | "character_persona"
  | "character_dialogue"
  | "character_reaction"
  | "director_core"
  | "director_daily_settlement"
  | "director_dialogue_events"
  | "director_system_dialogue"
  | "director_goal_plan"
  | "director_definition_draft"
  | "system_persona"
  | "asset_subject"
  | "asset_style"
  | "asset_negative";
type OwnerKind =
  | "world"
  | "definition"
  | "component"
  | "relation"
  | "capability"
  | "world_law"
  | "generation_archetype"
  | "art_profile"
  | "materialization_profile"
  | "asset"
  | "binding"
  | "state_machine"
  | "machine_state"
  | "machine_transition"
  | "character_mind"
  | "director_profile";
type RefKind =
  | "world"
  | "type"
  | "definition"
  | "entity"
  | "relation"
  | "capability"
  | "world_law"
  | "generation_archetype"
  | "prompt"
  | "art_profile"
  | "materialization_profile"
  | "asset"
  | "binding"
  | "dependency";
type ValueType =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "id_ref"
  | "world_time"
  | "duration";

export interface ValidatedDecimalStringComparer {
  compare(left: string, right: string): -1 | 0 | 1;
}

export interface ContentBundleSemanticGateDependencies {
  readonly contracts: ContractValidator;
  readonly decimalComparer: ValidatedDecimalStringComparer;
}

interface ExtensionFieldRecord {
  readonly field: JsonObject;
  readonly fieldId: string;
  readonly ownerKind: OwnerKind;
  readonly ownerTypeId: string | undefined;
  readonly valueType: ValueType;
  readonly cardinality: "one" | "many";
  readonly required: boolean;
  readonly enumSetId: string | undefined;
  readonly reference: { readonly refKind: RefKind; readonly refTypeId: string | undefined } | undefined;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly decimalMinimum: string | undefined;
  readonly decimalMaximum: string | undefined;
  readonly pattern: string | undefined;
  readonly translatable: boolean;
}

interface TypeRecord {
  readonly type: JsonObject;
  readonly typeId: string;
  readonly typeKind: TypeKind;
  readonly parentTypeId: string | undefined;
  readonly componentCardinality: "one" | "many" | undefined;
}

interface PromptRecord {
  readonly prompt: JsonObject;
  readonly promptId: string;
  readonly purpose: PromptPurpose;
}

interface MachineRecord {
  readonly machine: JsonObject;
  readonly machineId: string;
  readonly worldId: string;
  readonly machineScope: "character" | "world";
  readonly stateIds: ReadonlySet<string>;
}

interface BundleIndex {
  readonly semanticDependencies: ContentBundleSemanticGateDependencies;
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
  readonly dependencies: ReadonlyMap<string, DependencyRecord>;
  readonly worlds: ReadonlySet<string>;
  readonly types: ReadonlyMap<string, TypeRecord>;
  readonly extensionFields: readonly ExtensionFieldRecord[];
  readonly enumSets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly definitions: ReadonlySet<string>;
  readonly definitionTypeById: ReadonlyMap<string, string>;
  readonly entities: ReadonlySet<string>;
  readonly relations: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<string>;
  readonly worldLaws: ReadonlySet<string>;
  readonly generationArchetypes: ReadonlySet<string>;
  readonly prompts: ReadonlyMap<string, PromptRecord>;
  readonly artProfiles: ReadonlySet<string>;
  readonly materializationProfiles: ReadonlyMap<string, JsonObject>;
  readonly assets: ReadonlySet<string>;
  readonly bindings: ReadonlySet<string>;
  readonly machines: ReadonlyMap<string, MachineRecord>;
  readonly machineBindings: ReadonlySet<string>;
  readonly directorProfileWorlds: ReadonlyMap<string, string>;
}

export function createContentBundleSemanticGate(
  dependencies: ContentBundleSemanticGateDependencies,
): ContentBundleSemanticGate {
  return new DefaultContentBundleSemanticGate(dependencies);
}

class DefaultContentBundleSemanticGate implements ContentBundleSemanticGate {
  readonly #dependencies: ContentBundleSemanticGateDependencies;

  public constructor(dependencies: ContentBundleSemanticGateDependencies) {
    this.#dependencies = Object.freeze({
      contracts: dependencies.contracts,
      decimalComparer: dependencies.decimalComparer,
    });
  }

  public async assertValid(bundle: ContentBundleDocument): Promise<void> {
    assertContentBundleSemantics(bundle, this.#dependencies);
  }
}

function assertContentBundleSemantics(
  document: ContentBundleDocument,
  dependencies: ContentBundleSemanticGateDependencies,
): void {
  const root = document.value;
  const release = expectJsonObject(
    expectProperty(root, "release", "ContentBundle"),
    "ContentBundle.release",
  );
  const bundle = expectJsonObject(
    expectProperty(root, "bundle", "ContentBundle"),
    "ContentBundle.bundle",
  );
  const bundleDigest = expectString(release, "bundle_digest", "release");
  const index = buildIndex(bundle, bundleDigest, dependencies);

  assertManifest(bundle, index);
  assertWorlds(bundle, index);
  assertCatalog(bundle, index);
  assertGameplay(bundle, index);
  assertPresentation(bundle, index);
  assertContentUpgrades(bundle, index);
  assertSimulation(bundle, index);
}

function buildIndex(
  bundle: JsonObject,
  bundleDigest: string,
  semanticDependencies: ContentBundleSemanticGateDependencies,
): BundleIndex {
  const manifest = expectJsonObject(
    expectProperty(bundle, "manifest", "bundle"),
    "bundle.manifest",
  );
  const packId = expectString(manifest, "pack_id", "manifest");
  const packVersion = expectString(
    manifest,
    "pack_version",
    "manifest",
  );

  const dependencies = uniqueIndex(
    asObjectArray(expectProperty(bundle, "dependencies", "bundle"), "bundle.dependencies"),
    "dependency_id",
    "bundle.dependencies",
    (item) =>
      Object.freeze({
        kind: expectEnum(
          item,
          "dependency_kind",
          "DependencyLock",
        ) as DependencyKind,
        required: expectBoolean(item, "required", "DependencyLock"),
      }),
  );

  const worlds = uniqueIdSet(
    asObjectArray(expectProperty(bundle, "worlds", "bundle"), "bundle.worlds"),
    "world_id",
    "bundle.worlds",
  );

  const catalog = expectJsonObject(
    expectProperty(bundle, "catalog", "bundle"),
    "bundle.catalog",
  );
  const types = buildTypeIndex(
    asObjectArray(expectProperty(catalog, "types", "catalog"), "catalog.types"),
  );
  const extensionFields = buildExtensionFieldIndex(
    asObjectArray(
      expectProperty(catalog, "extension_fields", "catalog"),
      "catalog.extension_fields",
    ),
    semanticDependencies.decimalComparer,
  );
  const enumSets = buildEnumSetIndex(
    asObjectArray(expectProperty(catalog, "enum_sets", "catalog"), "catalog.enum_sets"),
  );
  const definitionsArray = asObjectArray(
    expectProperty(catalog, "definitions", "catalog"),
    "catalog.definitions",
  );
  const definitions = uniqueIdSet(definitionsArray, "definition_id", "catalog.definitions");
  const definitionTypeById = new Map<string, string>();
  for (const definition of definitionsArray) {
    definitionTypeById.set(
      expectString(definition, "definition_id", "StaticDefinition"),
      expectString(definition, "definition_type_id", "StaticDefinition"),
    );
  }
  const entities = uniqueIdSet(
    asObjectArray(expectProperty(catalog, "entities", "catalog"), "catalog.entities"),
    "entity_id",
    "catalog.entities",
  );
  const relations = uniqueIdSet(
    asObjectArray(expectProperty(catalog, "relations", "catalog"), "catalog.relations"),
    "relation_id",
    "catalog.relations",
  );

  const gameplay = expectJsonObject(
    expectProperty(bundle, "gameplay", "bundle"),
    "bundle.gameplay",
  );
  const capabilities = uniqueIdSet(
    asObjectArray(
      expectProperty(gameplay, "capabilities", "gameplay"),
      "gameplay.capabilities",
    ),
    "capability_id",
    "gameplay.capabilities",
  );
  const worldLaws = uniqueIdSet(
    asObjectArray(expectProperty(gameplay, "world_laws", "gameplay"), "gameplay.world_laws"),
    "law_id",
    "gameplay.world_laws",
  );
  const generationArchetypes = uniqueIdSet(
    asObjectArray(
      expectProperty(gameplay, "generation_archetypes", "gameplay"),
      "gameplay.generation_archetypes",
    ),
    "archetype_id",
    "gameplay.generation_archetypes",
  );
  const prompts = buildPromptIndex(
    asObjectArray(
      expectProperty(gameplay, "prompt_fragments", "gameplay"),
      "gameplay.prompt_fragments",
    ),
  );

  const presentation = expectJsonObject(
    expectProperty(bundle, "presentation", "bundle"),
    "bundle.presentation",
  );
  const artProfiles = uniqueIdSet(
    asObjectArray(
      expectProperty(presentation, "art_profiles", "presentation"),
      "presentation.art_profiles",
    ),
    "art_profile_id",
    "presentation.art_profiles",
  );
  const materializationProfiles = uniqueIndex(
    asObjectArray(
      expectProperty(presentation, "materialization_profiles", "presentation"),
      "presentation.materialization_profiles",
    ),
    "materialization_profile_id",
    "presentation.materialization_profiles",
    (profile) => profile,
  );
  const assets = uniqueIdSet(
    asObjectArray(
      expectProperty(presentation, "assets", "presentation"),
      "presentation.assets",
    ),
    "asset_id",
    "presentation.assets",
  );
  const bindings = uniqueIdSet(
    asObjectArray(
      expectProperty(presentation, "bindings", "presentation"),
      "presentation.bindings",
    ),
    "binding_id",
    "presentation.bindings",
  );

  uniqueIdSet(
    asObjectArray(
      expectProperty(bundle, "content_upgrades", "bundle"),
      "bundle.content_upgrades",
    ),
    "migration_id",
    "bundle.content_upgrades",
  );

  const simulation = expectJsonObject(
    expectProperty(bundle, "simulation", "bundle"),
    "bundle.simulation",
  );
  const machines = buildMachineIndex(
    asObjectArray(
      expectProperty(simulation, "state_machines", "simulation"),
      "simulation.state_machines",
    ),
  );
  const machineBindings = uniqueIdSet(
    asObjectArray(
      expectProperty(simulation, "initial_machine_bindings", "simulation"),
      "simulation.initial_machine_bindings",
    ),
    "binding_id",
    "simulation.initial_machine_bindings",
  );
  uniqueIdSet(
    asObjectArray(
      expectProperty(simulation, "character_minds", "simulation"),
      "simulation.character_minds",
    ),
    "mind_id",
    "simulation.character_minds",
  );
  const directorProfileWorlds = uniqueIndex(
    asObjectArray(
      expectProperty(simulation, "director_profiles", "simulation"),
      "simulation.director_profiles",
    ),
    "director_id",
    "simulation.director_profiles",
    (director) =>
      expectString(director, "world_id", "DirectorProfile"),
  );

  assertComponentIdUniqueness(definitionsArray, catalog);

  return Object.freeze({
    semanticDependencies,
    packId,
    packVersion,
    bundleDigest,
    dependencies,
    worlds,
    types,
    extensionFields,
    enumSets,
    definitions,
    definitionTypeById,
    entities,
    relations,
    capabilities,
    worldLaws,
    generationArchetypes,
    prompts,
    artProfiles,
    materializationProfiles,
    assets,
    bindings,
    machines,
    machineBindings,
    directorProfileWorlds,
  });
}

function assertComponentIdUniqueness(
  definitions: readonly JsonObject[],
  catalog: JsonObject,
): void {
  const ids = new Set<string>();
  const register = (ownerPath: string, components: readonly JsonObject[]): void => {
    for (const [index, component] of components.entries()) {
      const componentId = expectString(
        component,
        "component_id",
        `${ownerPath}[${index}]`,
      );
      if (ids.has(componentId)) {
        throw semanticFault(
          "content_bundle.semantic.duplicate_id",
          `Duplicate component_id ${componentId}`,
          { namespace: "component_id", id: componentId, path: `${ownerPath}[${index}]` },
        );
      }
      ids.add(componentId);
    }
  };

  for (const [index, definition] of definitions.entries()) {
    register(
      `catalog.definitions[${index}].components`,
      asObjectArray(
        expectProperty(definition, "components", "StaticDefinition"),
        `catalog.definitions[${index}].components`,
      ),
    );
  }

  const entities = asObjectArray(
    expectProperty(catalog, "entities", "catalog"),
    "catalog.entities",
  );
  for (const [index, entity] of entities.entries()) {
    register(
      `catalog.entities[${index}].components`,
      asObjectArray(
        expectProperty(entity, "components", "InitialEntity"),
        `catalog.entities[${index}].components`,
      ),
    );
  }
}

function buildTypeIndex(items: readonly JsonObject[]): ReadonlyMap<string, TypeRecord> {
  const map = new Map<string, TypeRecord>();
  for (const [index, item] of items.entries()) {
    const typeId = expectString(item, "type_id", `catalog.types[${index}]`);
    if (map.has(typeId)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate type_id ${typeId}`,
        { namespace: "type_id", id: typeId },
      );
    }
    map.set(
      typeId,
      Object.freeze({
        type: item,
        typeId,
        typeKind: expectEnum(item, "type_kind", `catalog.types[${index}]`) as TypeKind,
        parentTypeId: optionalString(item, "parent_type_id"),
        componentCardinality:
          item.component_cardinality === undefined
            ? undefined
            : (expectEnum(
                item,
                "component_cardinality",
                `catalog.types[${index}]`,
              ) as "one" | "many"),
      }),
    );
  }
  return map;
}

function buildExtensionFieldIndex(
  items: readonly JsonObject[],
  decimalComparer: ValidatedDecimalStringComparer,
): readonly ExtensionFieldRecord[] {
  const seen = new Set<string>();
  const records: ExtensionFieldRecord[] = [];
  for (const [index, item] of items.entries()) {
    const fieldId = expectString(item, "field_id", `catalog.extension_fields[${index}]`);
    if (seen.has(fieldId)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate field_id ${fieldId}`,
        { namespace: "field_id", id: fieldId },
      );
    }
    seen.add(fieldId);
    const valueType = expectEnum(
      item,
      "value_type",
      `catalog.extension_fields[${index}]`,
    ) as ValueType;

    let reference:
      | { readonly refKind: RefKind; readonly refTypeId: string | undefined }
      | undefined;
    if (item.reference !== undefined) {
      const referenceObject = expectJsonObject(
        expectProperty(item, "reference", `catalog.extension_fields[${index}]`),
        `catalog.extension_fields[${index}].reference`,
      );
      reference = Object.freeze({
        refKind: expectEnum(referenceObject, "ref_kind", "ExtensionField.reference") as RefKind,
        refTypeId: optionalString(referenceObject, "ref_type_id"),
      });
    }

    const field = Object.freeze({
      field: item,
      fieldId,
      ownerKind: expectEnum(item, "owner_kind", `catalog.extension_fields[${index}]`) as OwnerKind,
      ownerTypeId: optionalString(item, "owner_type_id"),
      valueType,
      cardinality: expectEnum(
        item,
        "cardinality",
        `catalog.extension_fields[${index}]`,
      ) as "one" | "many",
      required: expectBoolean(item, "required", `catalog.extension_fields[${index}]`),
      enumSetId: optionalString(item, "enum_set_id"),
      reference,
      minimum: valueType === "decimal" ? undefined : optionalNumber(item, "minimum"),
      maximum: valueType === "decimal" ? undefined : optionalNumber(item, "maximum"),
      decimalMinimum:
        valueType === "decimal" ? optionalString(item, "minimum") : undefined,
      decimalMaximum:
        valueType === "decimal" ? optionalString(item, "maximum") : undefined,
      pattern: optionalString(item, "pattern"),
      translatable: expectBoolean(item, "translatable", `catalog.extension_fields[${index}]`),
    });
    assertFieldBoundsDefinition(field, decimalComparer);
    records.push(field);
  }
  return records;
}

function buildEnumSetIndex(
  items: readonly JsonObject[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, ReadonlySet<string>>();
  for (const [index, item] of items.entries()) {
    const enumSetId = expectString(item, "enum_set_id", `catalog.enum_sets[${index}]`);
    if (map.has(enumSetId)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate enum_set_id ${enumSetId}`,
        { namespace: "enum_set_id", id: enumSetId },
      );
    }
    const enumItems = asObjectArray(
      expectProperty(item, "items", `catalog.enum_sets[${index}]`),
      `catalog.enum_sets[${index}].items`,
    );
    const itemIds = new Set<string>();
    for (const [itemIndex, enumItem] of enumItems.entries()) {
      const itemId = expectString(
        enumItem,
        "item_id",
        `catalog.enum_sets[${index}].items[${itemIndex}]`,
      );
      if (itemIds.has(itemId)) {
        throw semanticFault(
          "content_bundle.semantic.duplicate_id",
          `Duplicate enum item_id ${itemId} in enum_set ${enumSetId}`,
          { namespace: "enum_item_id", id: itemId, enum_set_id: enumSetId },
        );
      }
      itemIds.add(itemId);
    }
    map.set(enumSetId, itemIds);
  }
  return map;
}

function buildPromptIndex(
  items: readonly JsonObject[],
): ReadonlyMap<string, PromptRecord> {
  const map = new Map<string, PromptRecord>();
  for (const [index, item] of items.entries()) {
    const promptId = expectString(item, "prompt_id", `gameplay.prompt_fragments[${index}]`);
    if (map.has(promptId)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate prompt_id ${promptId}`,
        { namespace: "prompt_id", id: promptId },
      );
    }
    map.set(
      promptId,
      Object.freeze({
        prompt: item,
        promptId,
        purpose: expectEnum(
          item,
          "purpose",
          `gameplay.prompt_fragments[${index}]`,
        ) as PromptPurpose,
      }),
    );
  }
  return map;
}

function buildMachineIndex(
  items: readonly JsonObject[],
): ReadonlyMap<string, MachineRecord> {
  const map = new Map<string, MachineRecord>();
  for (const [index, item] of items.entries()) {
    const machineId = expectString(item, "machine_id", `simulation.state_machines[${index}]`);
    if (map.has(machineId)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate machine_id ${machineId}`,
        { namespace: "machine_id", id: machineId },
      );
    }
    const states = asObjectArray(
      expectProperty(item, "states", `simulation.state_machines[${index}]`),
      `simulation.state_machines[${index}].states`,
    );
    const stateIds = new Set<string>();
    for (const [stateIndex, state] of states.entries()) {
      const stateId = expectString(
        state,
        "state_id",
        `simulation.state_machines[${index}].states[${stateIndex}]`,
      );
      if (stateIds.has(stateId)) {
        throw semanticFault(
          "content_bundle.semantic.duplicate_id",
          `Duplicate state_id ${stateId} in machine ${machineId}`,
          { namespace: "state_id", id: stateId, machine_id: machineId },
        );
      }
      stateIds.add(stateId);
    }

    const transitions = asObjectArray(
      expectProperty(item, "transitions", `simulation.state_machines[${index}]`),
      `simulation.state_machines[${index}].transitions`,
    );
    const transitionIds = new Set<string>();
    for (const [transitionIndex, transition] of transitions.entries()) {
      const transitionId = expectString(
        transition,
        "transition_id",
        `simulation.state_machines[${index}].transitions[${transitionIndex}]`,
      );
      if (transitionIds.has(transitionId)) {
        throw semanticFault(
          "content_bundle.semantic.duplicate_id",
          `Duplicate transition_id ${transitionId} in machine ${machineId}`,
          { namespace: "transition_id", id: transitionId, machine_id: machineId },
        );
      }
      transitionIds.add(transitionId);
    }

    map.set(
      machineId,
      Object.freeze({
        machine: item,
        machineId,
        worldId: expectString(item, "world_id", `simulation.state_machines[${index}]`),
        machineScope: expectEnum(
          item,
          "machine_scope",
          `simulation.state_machines[${index}]`,
        ) as "character" | "world",
        stateIds,
      }),
    );
  }
  return map;
}

function assertManifest(bundle: JsonObject, index: BundleIndex): void {
  const manifest = expectJsonObject(
    expectProperty(bundle, "manifest", "bundle"),
    "bundle.manifest",
  );
  requireId(
    index.worlds,
    expectString(manifest, "entry_world_id", "manifest"),
    "manifest.entry_world_id",
    "world",
  );
}

function assertWorlds(bundle: JsonObject, index: BundleIndex): void {
  const worlds = asObjectArray(expectProperty(bundle, "worlds", "bundle"), "bundle.worlds");
  for (const [worldIndex, world] of worlds.entries()) {
    const path = `bundle.worlds[${worldIndex}]`;
    const worldId = expectString(world, "world_id", path);
    requireId(
      index.entities,
      expectString(world, "start_location_entity_id", path),
      `${path}.start_location_entity_id`,
      "entity",
    );
    requireId(
      index.definitions,
      expectString(world, "player_archetype_definition_id", path),
      `${path}.player_archetype_definition_id`,
      "definition",
    );
    assertComponents(
      asObjectArray(
        expectProperty(world, "player_initial_components", path),
        `${path}.player_initial_components`,
      ),
      `${path}.player_initial_components`,
      index,
    );
    const playerLocationRelationTypeId = expectString(
      world,
      "player_location_relation_type_id",
      path,
    );
    requireTypeKind(
      index,
      playerLocationRelationTypeId,
      "relation",
      `${path}.player_location_relation_type_id`,
    );
    assertFieldValues(
      asObjectArray(
        expectProperty(world, "player_location_fields", path),
        `${path}.player_location_fields`,
      ),
      `${path}.player_location_fields`,
      index,
      "relation",
      playerLocationRelationTypeId,
    );
    assertInitialVisibility(
      expectJsonObject(
        expectProperty(world, "player_location_visibility", path),
        `${path}.player_location_visibility`,
      ),
      `${path}.player_location_visibility`,
      index,
    );
    const directorProfileId = expectString(
      world,
      "director_profile_id",
      path,
    );
    const directorWorldId = index.directorProfileWorlds.get(directorProfileId);
    if (directorWorldId === undefined) {
      throw unresolved(
        directorProfileId,
        `${path}.director_profile_id`,
        "director_profile",
      );
    }
    if (directorWorldId !== worldId) {
      throw semanticFault(
        "content_bundle.semantic.director_world_mismatch",
        "WorldDefinition.director_profile_id must select a DirectorProfile in the same world",
        {
          path: `${path}.director_profile_id`,
          world_id: worldId,
          director_profile_id: directorProfileId,
          director_world_id: directorWorldId,
        },
      );
    }
    assertPluginOperationRef(
      expectJsonObject(
        expectProperty(world, "calendar_resolver", path),
        `${path}.calendar_resolver`,
      ),
      `${path}.calendar_resolver`,
      index,
      "rule_plugin",
    );
    for (const operationField of [
      "goal_plan_validator",
      "world_automatic_event_resolver",
      "character_automatic_event_resolver",
      "stage_outcome_resolver",
      "dialogue_open_resolver",
      "dialogue_turn_append_resolver",
      "dialogue_close_resolver",
    ] as const) {
      assertPluginOperationRef(
        expectJsonObject(
          expectProperty(world, operationField, path),
          `${path}.${operationField}`,
        ),
        `${path}.${operationField}`,
        index,
        "rule_plugin",
      );
    }
    assertPluginOperationRef(
      expectJsonObject(
        expectProperty(world, "navigation_resolver", path),
        `${path}.navigation_resolver`,
      ),
      `${path}.navigation_resolver`,
      index,
      "rule_plugin",
    );
    requireId(
      index.artProfiles,
      expectString(world, "default_art_profile_id", path),
      `${path}.default_art_profile_id`,
      "art_profile",
    );
    requireId(
      index.materializationProfiles,
      expectString(world, "default_materialization_profile_id", path),
      `${path}.default_materialization_profile_id`,
      "materialization_profile",
    );

    if (world.default_stage !== undefined) {
      assertStageRef(
        expectJsonObject(expectProperty(world, "default_stage", path), `${path}.default_stage`),
        `${path}.default_stage`,
        index,
      );
    }

    const system = expectJsonObject(
      expectProperty(world, "system", path),
      `${path}.system`,
    );
    requirePrompt(
      index,
      expectString(system, "persona_prompt_id", `${path}.system`),
      `${path}.system.persona_prompt_id`,
      "system_persona",
    );
    if (system.art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(system, "art_profile_id", `${path}.system`),
        `${path}.system.art_profile_id`,
        "art_profile",
      );
    }

    const eventBudget = expectJsonObject(
      expectProperty(world, "event_budget", path),
      `${path}.event_budget`,
    );
    assertPluginOperationRef(
      expectJsonObject(
        expectProperty(eventBudget, "card_cost_resolver", `${path}.event_budget`),
        `${path}.event_budget.card_cost_resolver`,
      ),
      `${path}.event_budget.card_cost_resolver`,
      index,
      "rule_plugin",
    );

    if (world.fields !== undefined) {
      assertFieldValues(
        asObjectArray(expectProperty(world, "fields", path), `${path}.fields`),
        `${path}.fields`,
        index,
        "world",
        undefined,
      );
    }
  }
}

function assertCatalog(bundle: JsonObject, index: BundleIndex): void {
  const catalog = expectJsonObject(
    expectProperty(bundle, "catalog", "bundle"),
    "bundle.catalog",
  );

  for (const type of index.types.values()) {
    if (type.parentTypeId !== undefined) {
      const parent = index.types.get(type.parentTypeId);
      if (parent === undefined) {
        throw unresolved(type.parentTypeId, `type ${type.typeId}.parent_type_id`, "type");
      }
      if (parent.typeKind !== type.typeKind) {
        throw semanticFault(
          "content_bundle.semantic.kind_mismatch",
          `parent_type_id ${type.parentTypeId} kind ${parent.typeKind} does not match ${type.typeKind}`,
          {
            type_id: type.typeId,
            parent_type_id: type.parentTypeId,
            expected_kind: type.typeKind,
            actual_kind: parent.typeKind,
          },
        );
      }
    }
    if (type.type.validator !== undefined) {
      if (type.typeKind !== "definition") {
        throw semanticFault(
          "content_bundle.semantic.validator_owner_kind",
          "TypeDefinition.validator is only valid when type_kind=definition",
          {
            type_id: type.typeId,
            type_kind: type.typeKind,
            path: `catalog.types[${type.typeId}].validator`,
          },
        );
      }
      assertPluginOperationRef(
        expectJsonObject(
          expectProperty(type.type, "validator", `type ${type.typeId}`),
          `type.${type.typeId}.validator`,
        ),
        `catalog.types[${type.typeId}].validator`,
        index,
        "rule_plugin",
      );
    }
  }
  assertTypeParentAcyclic(index.types);

  for (const field of index.extensionFields) {
    if (field.ownerTypeId !== undefined) {
      requireId(index.types, field.ownerTypeId, `extension_field ${field.fieldId}.owner_type_id`, "type");
    }
    if (field.enumSetId !== undefined) {
      if (!index.enumSets.has(field.enumSetId)) {
        throw unresolved(field.enumSetId, `extension_field ${field.fieldId}.enum_set_id`, "enum_set");
      }
    }
    if (field.valueType === "id_ref" && field.reference === undefined) {
      throw semanticFault(
        "content_bundle.semantic.field_reference_required",
        `id_ref field ${field.fieldId} must declare reference.ref_kind`,
        { field_id: field.fieldId },
      );
    }
    if (field.reference?.refTypeId !== undefined) {
      requireId(
        index.types,
        field.reference.refTypeId,
        `extension_field ${field.fieldId}.reference.ref_type_id`,
        "type",
      );
    }
  }

  const definitions = asObjectArray(
    expectProperty(catalog, "definitions", "catalog"),
    "catalog.definitions",
  );
  for (const [definitionIndex, definition] of definitions.entries()) {
    const path = `catalog.definitions[${definitionIndex}]`;
    const definitionId = expectString(definition, "definition_id", path);
    const definitionTypeId = expectString(definition, "definition_type_id", path);
    requireTypeKind(index, definitionTypeId, "definition", `${path}.definition_type_id`);
    if (definition.parent_definition_id !== undefined) {
      requireId(
        index.definitions,
        expectString(definition, "parent_definition_id", path),
        `${path}.parent_definition_id`,
        "definition",
      );
    }
    assertComponents(
      asObjectArray(expectProperty(definition, "components", path), `${path}.components`),
      `${path}.components`,
      index,
    );
    assertFieldValues(
      asObjectArray(expectProperty(definition, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "definition",
      definitionTypeId,
    );
    void definitionId;
  }

  const entities = asObjectArray(
    expectProperty(catalog, "entities", "catalog"),
    "catalog.entities",
  );
  for (const [entityIndex, entity] of entities.entries()) {
    const path = `catalog.entities[${entityIndex}]`;
    const archetypeId = expectString(entity, "archetype_definition_id", path);
    requireId(index.definitions, archetypeId, `${path}.archetype_definition_id`, "definition");
    assertComponents(
      asObjectArray(expectProperty(entity, "components", path), `${path}.components`),
      `${path}.components`,
      index,
    );
    const archetypeTypeId = index.definitionTypeById.get(archetypeId);
    assertFieldValues(
      asObjectArray(expectProperty(entity, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "definition",
      archetypeTypeId,
    );
  }

  const relations = asObjectArray(
    expectProperty(catalog, "relations", "catalog"),
    "catalog.relations",
  );
  for (const [relationIndex, relation] of relations.entries()) {
    const path = `catalog.relations[${relationIndex}]`;
    const relationTypeId = expectString(relation, "relation_type_id", path);
    requireTypeKind(index, relationTypeId, "relation", `${path}.relation_type_id`);
    assertLocalSubjectRef(
      expectJsonObject(expectProperty(relation, "from", path), `${path}.from`),
      `${path}.from`,
      index,
    );
    assertLocalSubjectRef(
      expectJsonObject(expectProperty(relation, "to", path), `${path}.to`),
      `${path}.to`,
      index,
    );
    assertFieldValues(
      asObjectArray(expectProperty(relation, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "relation",
      relationTypeId,
    );
    assertInitialVisibility(
      expectJsonObject(
        expectProperty(relation, "visibility", path),
        `${path}.visibility`,
      ),
      `${path}.visibility`,
      index,
    );
  }
}

function assertComponents(
  components: readonly JsonObject[],
  path: string,
  index: BundleIndex,
): void {
  const componentKeys = new Set<string>();
  const componentCounts = new Map<string, number>();
  for (const [componentIndex, component] of components.entries()) {
    const componentPath = `${path}[${componentIndex}]`;
    const componentTypeId = expectString(component, "component_type_id", componentPath);
    requireTypeKind(index, componentTypeId, "component", `${componentPath}.component_type_id`);
    const ordinal = expectInteger(component, "ordinal", componentPath);
    const key = `${componentTypeId}\u0000${ordinal}`;
    if (componentKeys.has(key)) {
      throw semanticFault(
        "content_bundle.semantic.component_duplicate",
        "Component type and ordinal must be unique within one owner",
        {
          path: componentPath,
          component_type_id: componentTypeId,
          ordinal,
        },
      );
    }
    componentKeys.add(key);

    const count = (componentCounts.get(componentTypeId) ?? 0) + 1;
    componentCounts.set(componentTypeId, count);
    const type = index.types.get(componentTypeId);
    if (type?.componentCardinality === "one" && count > 1) {
      throw semanticFault(
        "content_bundle.semantic.component_cardinality",
        "component_cardinality=one permits only one component of that type per owner",
        {
          path: componentPath,
          component_type_id: componentTypeId,
          component_cardinality: type.componentCardinality,
          component_count: count,
        },
      );
    }
    assertFieldValues(
      asObjectArray(
        expectProperty(component, "fields", componentPath),
        `${componentPath}.fields`,
      ),
      `${componentPath}.fields`,
      index,
      "component",
      componentTypeId,
    );
  }
}

function assertLocalSubjectRef(
  subject: JsonObject,
  path: string,
  index: BundleIndex,
): void {
  const kind = expectEnum(subject, "kind", path);
  const id = expectString(subject, "id", path);
  if (kind === "definition") {
    requireId(index.definitions, id, path, "definition");
    return;
  }
  if (kind === "entity") {
    requireId(index.entities, id, path, "entity");
    return;
  }
  throw semanticFault(
    "content_bundle.semantic.kind_mismatch",
    `LocalSubjectRef kind ${String(kind)} is not supported`,
    { path, kind: String(kind) },
  );
}

function assertInitialVisibility(
  visibility: JsonObject,
  path: string,
  index: BundleIndex,
): void {
  const scope = expectString(visibility, "scope", path);
  switch (scope) {
    case "private":
    case "owner":
    case "public":
      return;
    case "known_to": {
      const actors = asObjectArray(
        expectProperty(visibility, "actors", path),
        `${path}.actors`,
      );
      for (const [actorIndex, actor] of actors.entries()) {
        const actorPath = `${path}.actors[${actorIndex}]`;
        const actorKind = expectString(actor, "actor_kind", actorPath);
        switch (actorKind) {
          case "player":
            break;
          case "entity":
            requireId(
              index.entities,
              expectString(actor, "entity_id", actorPath),
              `${actorPath}.entity_id`,
              "entity",
            );
            break;
          default:
            throw semanticFault(
              "content_bundle.semantic.visibility_actor_kind_unknown",
              `Unknown InitialVisibility actor_kind ${actorKind}`,
              { path: actorPath, actor_kind: actorKind },
            );
        }
      }
      return;
    }
    default:
      throw semanticFault(
        "content_bundle.semantic.visibility_scope_unknown",
        `Unknown InitialVisibility scope ${scope}`,
        { path, scope },
      );
  }
}

function assertGameplay(bundle: JsonObject, index: BundleIndex): void {
  const gameplay = expectJsonObject(
    expectProperty(bundle, "gameplay", "bundle"),
    "bundle.gameplay",
  );

  const capabilities = asObjectArray(
    expectProperty(gameplay, "capabilities", "gameplay"),
    "gameplay.capabilities",
  );
  for (const [capabilityIndex, capability] of capabilities.entries()) {
    const path = `gameplay.capabilities[${capabilityIndex}]`;
    requireId(
      index.worlds,
      expectString(capability, "world_id", path),
      `${path}.world_id`,
      "world",
    );
    if (capability.actor_definition_type_id !== undefined) {
      requireTypeKind(
        index,
        expectString(capability, "actor_definition_type_id", path),
        "definition",
        `${path}.actor_definition_type_id`,
      );
    }
    if (capability.target_definition_type_id !== undefined) {
      requireTypeKind(
        index,
        expectString(capability, "target_definition_type_id", path),
        "definition",
        `${path}.target_definition_type_id`,
      );
    }
    if (capability.availability_law_id !== undefined) {
      requireId(
        index.worldLaws,
        expectString(capability, "availability_law_id", path),
        `${path}.availability_law_id`,
        "world_law",
      );
    }
    assertPluginOperationRef(
      expectJsonObject(expectProperty(capability, "resolver", path), `${path}.resolver`),
      `${path}.resolver`,
      index,
      "rule_plugin",
    );
    if (capability.planning_prompt_id !== undefined) {
      requirePromptExists(
        index,
        expectString(capability, "planning_prompt_id", path),
        `${path}.planning_prompt_id`,
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(capability, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "capability",
      undefined,
    );
  }

  const laws = asObjectArray(
    expectProperty(gameplay, "world_laws", "gameplay"),
    "gameplay.world_laws",
  );
  for (const [lawIndex, law] of laws.entries()) {
    const path = `gameplay.world_laws[${lawIndex}]`;
    requireId(index.worlds, expectString(law, "world_id", path), `${path}.world_id`, "world");
    assertPluginOperationRef(
      expectJsonObject(expectProperty(law, "evaluator", path), `${path}.evaluator`),
      `${path}.evaluator`,
      index,
      "rule_plugin",
    );
    if (law.explanation_prompt_id !== undefined) {
      requirePromptExists(
        index,
        expectString(law, "explanation_prompt_id", path),
        `${path}.explanation_prompt_id`,
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(law, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "world_law",
      undefined,
    );
  }

  const archetypes = asObjectArray(
    expectProperty(gameplay, "generation_archetypes", "gameplay"),
    "gameplay.generation_archetypes",
  );
  for (const [archetypeIndex, archetype] of archetypes.entries()) {
    const path = `gameplay.generation_archetypes[${archetypeIndex}]`;
    requireId(
      index.worlds,
      expectString(archetype, "world_id", path),
      `${path}.world_id`,
      "world",
    );
    if (archetype.target_type_id !== undefined) {
      requireId(
        index.types,
        expectString(archetype, "target_type_id", path),
        `${path}.target_type_id`,
        "type",
      );
    }
    if (archetype.base_definition_id !== undefined) {
      requireId(
        index.definitions,
        expectString(archetype, "base_definition_id", path),
        `${path}.base_definition_id`,
        "definition",
      );
    }
    if (archetype.eligibility_law_id !== undefined) {
      requireId(
        index.worldLaws,
        expectString(archetype, "eligibility_law_id", path),
        `${path}.eligibility_law_id`,
        "world_law",
      );
    }
    assertPluginOperationRef(
      expectJsonObject(expectProperty(archetype, "generator", path), `${path}.generator`),
      `${path}.generator`,
      index,
      "rule_plugin",
    );
    requirePromptExists(
      index,
      expectString(archetype, "prompt_fragment_id", path),
      `${path}.prompt_fragment_id`,
    );
    if (archetype.art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(archetype, "art_profile_id", path),
        `${path}.art_profile_id`,
        "art_profile",
      );
    }
    if (archetype.materialization_profile_id !== undefined) {
      requireId(
        index.materializationProfiles,
        expectString(archetype, "materialization_profile_id", path),
        `${path}.materialization_profile_id`,
        "materialization_profile",
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(archetype, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "generation_archetype",
      undefined,
    );
  }
}

function assertPresentation(bundle: JsonObject, index: BundleIndex): void {
  const presentation = expectJsonObject(
    expectProperty(bundle, "presentation", "bundle"),
    "bundle.presentation",
  );

  const artProfiles = asObjectArray(
    expectProperty(presentation, "art_profiles", "presentation"),
    "presentation.art_profiles",
  );
  for (const [artIndex, art] of artProfiles.entries()) {
    const path = `presentation.art_profiles[${artIndex}]`;
    requirePrompt(
      index,
      expectString(art, "style_prompt_id", path),
      `${path}.style_prompt_id`,
      "asset_style",
    );
    if (art.negative_prompt_id !== undefined) {
      requirePrompt(
        index,
        expectString(art, "negative_prompt_id", path),
        `${path}.negative_prompt_id`,
        "asset_negative",
      );
    }
    if (art.parent_art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(art, "parent_art_profile_id", path),
        `${path}.parent_art_profile_id`,
        "art_profile",
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(art, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "art_profile",
      undefined,
    );
  }

  const materializationProfiles = asObjectArray(
    expectProperty(presentation, "materialization_profiles", "presentation"),
    "presentation.materialization_profiles",
  );
  for (const [profileIndex, profile] of materializationProfiles.entries()) {
    const path = `presentation.materialization_profiles[${profileIndex}]`;
    requireId(
      index.assets,
      expectString(profile, "fallback_asset_id", path),
      `${path}.fallback_asset_id`,
      "asset",
    );
    if (profile.asset_provider_dependency_id !== undefined) {
      assertRequiredDependency(
        expectString(profile, "asset_provider_dependency_id", path),
        `${path}.asset_provider_dependency_id`,
        index,
        "asset_provider",
      );
    }
    if (profile.art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(profile, "art_profile_id", path),
        `${path}.art_profile_id`,
        "art_profile",
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(profile, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "materialization_profile",
      undefined,
    );
  }

  const assets = asObjectArray(
    expectProperty(presentation, "assets", "presentation"),
    "presentation.assets",
  );
  for (const [assetIndex, asset] of assets.entries()) {
    const path = `presentation.assets[${assetIndex}]`;
    if (asset.art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(asset, "art_profile_id", path),
        `${path}.art_profile_id`,
        "art_profile",
      );
    }
    assertFieldValues(
      asObjectArray(expectProperty(asset, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "asset",
      undefined,
    );
  }

  const bindings = asObjectArray(
    expectProperty(presentation, "bindings", "presentation"),
    "presentation.bindings",
  );
  for (const [bindingIndex, binding] of bindings.entries()) {
    const path = `presentation.bindings[${bindingIndex}]`;
    const subjectKind = expectEnum(binding, "subject_kind", path);
    const subjectId = expectString(binding, "subject_id", path);
    resolveBindingSubject(index, subjectKind, subjectId, `${path}.subject_id`);
    if (
      binding.node_kind !== undefined &&
      subjectKind !== "world" &&
      subjectKind !== "definition" &&
      subjectKind !== "entity" &&
      subjectKind !== "relation"
    ) {
      throw semanticFault(
        "content_bundle.semantic.render_subject_kind_unsupported",
        "2D RenderNode PackBinding must target a runtime-resolvable world, definition, entity, or relation",
        { path, subject_kind: subjectKind },
      );
    }
    if (binding.asset_id !== undefined) {
      requireId(
        index.assets,
        expectString(binding, "asset_id", path),
        `${path}.asset_id`,
        "asset",
      );
    }
    if (binding.materialization_profile_id !== undefined) {
      const materializationProfileId = expectString(
        binding,
        "materialization_profile_id",
        path,
      );
      requireId(
        index.materializationProfiles,
        materializationProfileId,
        `${path}.materialization_profile_id`,
        "materialization_profile",
      );
      const materializationProfile =
        index.materializationProfiles.get(materializationProfileId);
      if (materializationProfile === undefined) {
        throw unresolved(
          materializationProfileId,
          `${path}.materialization_profile_id`,
          "materialization_profile",
        );
      }
      if (
        binding.stage !== undefined &&
        subjectKind === "world" &&
        expectString(
          materializationProfile,
          "generation_policy",
          "MaterializationProfile",
        ) === "on_demand"
      ) {
        throw semanticFault(
          "content_bundle.semantic.stage_world_materialization_unsupported",
          "Stage world PackBinding cannot use an on_demand MaterializationProfile because MaterializationRequest has no world subject contract",
          {
            path,
            subject_kind: subjectKind,
            materialization_profile_id: materializationProfileId,
          },
        );
      }
    }
    if (binding.art_profile_id !== undefined) {
      requireId(
        index.artProfiles,
        expectString(binding, "art_profile_id", path),
        `${path}.art_profile_id`,
        "art_profile",
      );
    }
    if (binding.stage !== undefined) {
      assertStageRef(
        expectJsonObject(expectProperty(binding, "stage", path), `${path}.stage`),
        `${path}.stage`,
        index,
      );
      if (
        subjectKind !== "world" &&
        subjectKind !== "entity" &&
        subjectKind !== "definition"
      ) {
        throw semanticFault(
          "content_bundle.semantic.stage_subject_kind_unsupported",
          "Stage PackBinding must target a world, entity, or definition with an unambiguous runtime instance",
          {
            path,
            subject_kind: subjectKind,
          },
        );
      }
      const hasAsset = binding.asset_id !== undefined;
      const hasMaterializationProfile =
        binding.materialization_profile_id !== undefined;
      if (hasAsset === hasMaterializationProfile) {
        throw semanticFault(
          "content_bundle.semantic.stage_binding_asset_ambiguous",
          "Stage PackBinding must select exactly one asset_id or materialization_profile_id",
          {
            path,
            has_asset_id: hasAsset,
            has_materialization_profile_id: hasMaterializationProfile,
          },
        );
      }
    }
    assertFieldValues(
      asObjectArray(expectProperty(binding, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "binding",
      undefined,
    );
  }
}

function resolveBindingSubject(
  index: BundleIndex,
  subjectKind: string,
  subjectId: string,
  path: string,
): void {
  switch (subjectKind) {
    case "world":
      requireId(index.worlds, subjectId, path, "world");
      return;
    case "definition":
      requireId(index.definitions, subjectId, path, "definition");
      return;
    case "entity":
      requireId(index.entities, subjectId, path, "entity");
      return;
    case "relation":
      requireId(index.relations, subjectId, path, "relation");
      return;
    case "capability":
      requireId(index.capabilities, subjectId, path, "capability");
      return;
    case "generation_archetype":
      requireId(index.generationArchetypes, subjectId, path, "generation_archetype");
      return;
    default:
      throw semanticFault(
        "content_bundle.semantic.kind_mismatch",
        `Unknown PackBinding subject_kind ${subjectKind}`,
        { path, subject_kind: subjectKind },
      );
  }
}

function assertContentUpgrades(bundle: JsonObject, index: BundleIndex): void {
  const upgrades = asObjectArray(
    expectProperty(bundle, "content_upgrades", "bundle"),
    "bundle.content_upgrades",
  );
  for (const [upgradeIndex, upgrade] of upgrades.entries()) {
    const path = `bundle.content_upgrades[${upgradeIndex}]`;
    const migrationId = expectString(upgrade, "migration_id", path);
    const fromPackVersion = expectString(
      upgrade,
      "from_pack_version",
      path,
    );
    const fromBundleDigest = expectString(
      upgrade,
      "from_bundle_digest",
      path,
    );
    const toPackVersion = expectString(
      upgrade,
      "to_pack_version",
      path,
    );
    if (toPackVersion !== index.packVersion) {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_target_version_mismatch",
        "ContentUpgrade.to_pack_version must equal its containing ContentBundle pack_version",
        {
          path,
          migration_id: migrationId,
          to_pack_version: toPackVersion,
          pack_version: index.packVersion,
        },
      );
    }
    if (fromPackVersion === toPackVersion) {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_version_unchanged",
        "ContentUpgrade must move between distinct pack versions",
        {
          path,
          migration_id: migrationId,
          pack_version: toPackVersion,
        },
      );
    }
    if (fromBundleDigest === index.bundleDigest) {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_digest_unchanged",
        "ContentUpgrade source and target bundle digests must differ",
        {
          path,
          migration_id: migrationId,
          bundle_digest: index.bundleDigest,
        },
      );
    }
    assertContentUpgradeMappings(
      asObjectArray(
        expectProperty(upgrade, "declared_mapping", path),
        `${path}.declared_mapping`,
      ),
      path,
      migrationId,
      index,
    );
    assertPluginOperationRef(
      expectJsonObject(expectProperty(upgrade, "transformer", path), `${path}.transformer`),
      `${path}.transformer`,
      index,
      "rule_plugin",
    );
  }
}

function assertContentUpgradeMappings(
  mappings: readonly JsonObject[],
  path: string,
  migrationId: string,
  index: BundleIndex,
): void {
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  for (const [mappingIndex, mapping] of mappings.entries()) {
    const mappingPath = `${path}.declared_mapping[${mappingIndex}]`;
    const catalogKind = expectString(
      mapping,
      "catalog_kind",
      mappingPath,
    );
    const sourceId = expectString(mapping, "source_id", mappingPath);
    const targetId = expectString(mapping, "target_id", mappingPath);
    assertContentUpgradeMappingTarget(
      index,
      catalogKind,
      targetId,
      mappingPath,
      migrationId,
    );
    const sourceKey = `${catalogKind}\u0000${sourceId}`;
    const targetKey = `${catalogKind}\u0000${targetId}`;
    if (sourceKeys.has(sourceKey)) {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_mapping_source_duplicate",
        "ContentUpgrade declared_mapping must map each source identity at most once",
        {
          path: mappingPath,
          migration_id: migrationId,
          catalog_kind: catalogKind,
          source_id: sourceId,
        },
      );
    }
    if (targetKeys.has(targetKey)) {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_mapping_target_duplicate",
        "ContentUpgrade declared_mapping must not merge multiple source identities into one target identity",
        {
          path: mappingPath,
          migration_id: migrationId,
          catalog_kind: catalogKind,
          target_id: targetId,
        },
      );
    }
    sourceKeys.add(sourceKey);
    targetKeys.add(targetKey);
  }
}

function assertContentUpgradeMappingTarget(
  index: BundleIndex,
  catalogKind: string,
  targetId: string,
  path: string,
  migrationId: string,
): void {
  let exists: boolean;
  switch (catalogKind) {
    case "type":
      exists = index.types.has(targetId);
      break;
    case "definition":
      exists = index.definitions.has(targetId);
      break;
    case "entity":
      exists = index.entities.has(targetId);
      break;
    case "relation":
      exists = index.relations.has(targetId);
      break;
    case "capability":
      exists = index.capabilities.has(targetId);
      break;
    case "world_law":
      exists = index.worldLaws.has(targetId);
      break;
    case "generation_archetype":
      exists = index.generationArchetypes.has(targetId);
      break;
    case "prompt":
      exists = index.prompts.has(targetId);
      break;
    case "art_profile":
      exists = index.artProfiles.has(targetId);
      break;
    case "materialization_profile":
      exists = index.materializationProfiles.has(targetId);
      break;
    case "asset":
      exists = index.assets.has(targetId);
      break;
    case "binding":
      exists = index.bindings.has(targetId);
      break;
    case "state_machine_binding":
      exists = index.machineBindings.has(targetId);
      break;
    default: {
      throw semanticFault(
        "content_bundle.semantic.content_upgrade_mapping_catalog_kind",
        `Unsupported ContentUpgrade catalog_kind ${catalogKind}`,
        { path, migration_id: migrationId, catalog_kind: catalogKind },
      );
    }
  }

  if (!exists) {
    throw semanticFault(
      "content_bundle.semantic.content_upgrade_mapping_target_unknown",
      "ContentUpgrade declared_mapping target_id must exist in the target ContentBundle catalog kind",
      {
        path,
        migration_id: migrationId,
        catalog_kind: catalogKind,
        target_id: targetId,
      },
    );
  }
}

function assertSimulation(bundle: JsonObject, index: BundleIndex): void {
  const simulation = expectJsonObject(
    expectProperty(bundle, "simulation", "bundle"),
    "bundle.simulation",
  );

  for (const machine of index.machines.values()) {
    requireId(index.worlds, machine.worldId, `state_machine ${machine.machineId}.world_id`, "world");
    const initialStateId = expectString(machine.machine, "initial_state_id", "StateMachine");
    if (!machine.stateIds.has(initialStateId)) {
      throw unresolved(
        initialStateId,
        `state_machine ${machine.machineId}.initial_state_id`,
        "state",
      );
    }
    assertPluginOperationRef(
      expectJsonObject(
        expectProperty(machine.machine, "advance_resolver", "StateMachine"),
        `state_machine.${machine.machineId}.advance_resolver`,
      ),
      `simulation.state_machines[${machine.machineId}].advance_resolver`,
      index,
      "rule_plugin",
    );

    const transitions = asObjectArray(
      expectProperty(machine.machine, "transitions", "StateMachine"),
      `state_machine.${machine.machineId}.transitions`,
    );
    for (const [transitionIndex, transition] of transitions.entries()) {
      const path = `state_machine.${machine.machineId}.transitions[${transitionIndex}]`;
      const fromStateId = expectString(transition, "from_state_id", path);
      const toStateId = expectString(transition, "to_state_id", path);
      if (!machine.stateIds.has(fromStateId)) {
        throw unresolved(fromStateId, `${path}.from_state_id`, "state");
      }
      if (!machine.stateIds.has(toStateId)) {
        throw unresolved(toStateId, `${path}.to_state_id`, "state");
      }
      if (transition.guard !== undefined) {
        assertLocalRuleRef(
          expectJsonObject(expectProperty(transition, "guard", path), `${path}.guard`),
          `${path}.guard`,
          index,
        );
      }
      assertFieldValues(
        asObjectArray(
          expectProperty(transition, "fields", "MachineTransitionDefinition"),
          `${path}.fields`,
        ),
        `${path}.fields`,
        index,
        "machine_transition",
        undefined,
      );
    }

    assertFieldValues(
      asObjectArray(
        expectProperty(machine.machine, "fields", "StateMachine"),
        `state_machine.${machine.machineId}.fields`,
      ),
      `state_machine.${machine.machineId}.fields`,
      index,
      "state_machine",
      undefined,
    );

    const states = asObjectArray(
      expectProperty(machine.machine, "states", "StateMachine"),
      `state_machine.${machine.machineId}.states`,
    );
    for (const [stateIndex, state] of states.entries()) {
      assertFieldValues(
        asObjectArray(
          expectProperty(state, "fields", "MachineStateDefinition"),
          `state_machine.${machine.machineId}.states[${stateIndex}].fields`,
        ),
        `state_machine.${machine.machineId}.states[${stateIndex}].fields`,
        index,
        "machine_state",
        undefined,
      );
    }
  }

  const bindings = asObjectArray(
    expectProperty(simulation, "initial_machine_bindings", "simulation"),
    "simulation.initial_machine_bindings",
  );
  const characterMachineBindings = new Set<string>();
  const worldMachineBindings = new Set<string>();
  for (const [bindingIndex, binding] of bindings.entries()) {
    const path = `simulation.initial_machine_bindings[${bindingIndex}]`;
    const bindingKind = expectEnum(binding, "binding_kind", path);
    const machineId = expectString(binding, "machine_id", path);
    const machine = index.machines.get(machineId);
    if (machine === undefined) {
      throw unresolved(machineId, `${path}.machine_id`, "state_machine");
    }
    if (bindingKind === "character") {
      const entityId = expectString(binding, "entity_id", path);
      requireId(
        index.entities,
        entityId,
        `${path}.entity_id`,
        "entity",
      );
      if (machine.machineScope !== "character") {
        throw semanticFault(
          "content_bundle.semantic.kind_mismatch",
          `Character machine binding requires machine_scope=character`,
          {
            path,
            machine_id: machineId,
            machine_scope: machine.machineScope,
          },
        );
      }
      const targetKey = `${machine.worldId}\u0000${entityId}`;
      if (characterMachineBindings.has(targetKey)) {
        throw semanticFault(
          "content_bundle.semantic.character_machine_binding_ambiguous",
          "An Entity can have only one initial character state machine in a world",
          {
            path,
            world_id: machine.worldId,
            entity_id: entityId,
          },
        );
      }
      characterMachineBindings.add(targetKey);
    } else if (bindingKind === "world") {
      const bindingWorldId = expectString(binding, "world_id", path);
      requireId(
        index.worlds,
        bindingWorldId,
        `${path}.world_id`,
        "world",
      );
      if (machine.machineScope !== "world") {
        throw semanticFault(
          "content_bundle.semantic.kind_mismatch",
          `World machine binding requires machine_scope=world`,
          {
            path,
            machine_id: machineId,
            machine_scope: machine.machineScope,
          },
        );
      }
      if (machine.worldId !== bindingWorldId) {
        throw semanticFault(
          "content_bundle.semantic.machine_binding_world_mismatch",
          "World machine binding world_id must match its StateMachineDefinition.world_id",
          {
            path,
            machine_id: machineId,
            machine_world_id: machine.worldId,
            binding_world_id: bindingWorldId,
          },
        );
      }
      const targetKey = `${bindingWorldId}\u0000${machineId}`;
      if (worldMachineBindings.has(targetKey)) {
        throw semanticFault(
          "content_bundle.semantic.world_machine_binding_ambiguous",
          "A world StateMachineDefinition can have only one initial binding",
          {
            path,
            world_id: bindingWorldId,
            machine_id: machineId,
          },
        );
      }
      worldMachineBindings.add(targetKey);
    } else {
      throw semanticFault(
        "content_bundle.semantic.kind_mismatch",
        `Unknown machine binding_kind ${String(bindingKind)}`,
        { path, binding_kind: String(bindingKind) },
      );
    }
  }

  const minds = asObjectArray(
    expectProperty(simulation, "character_minds", "simulation"),
    "simulation.character_minds",
  );
  for (const [mindIndex, mind] of minds.entries()) {
    const path = `simulation.character_minds[${mindIndex}]`;
    const entityId = expectString(mind, "entity_id", path);
    requireId(
      index.entities,
      entityId,
      `${path}.entity_id`,
      "entity",
    );
    for (const worldId of index.worlds) {
      if (characterMachineBindings.has(`${worldId}\u0000${entityId}`)) {
        continue;
      }
      throw semanticFault(
        "content_bundle.semantic.character_machine_binding_missing",
        "Every CharacterMind Entity must have one initial character state machine in every WorldDefinition",
        {
          path,
          world_id: worldId,
          entity_id: entityId,
        },
      );
    }
    const personaPromptIds = asStringArray(
      expectProperty(mind, "persona_prompt_ids", path),
      `${path}.persona_prompt_ids`,
    );
    for (const [promptIndex, promptId] of personaPromptIds.entries()) {
      requirePrompt(
        index,
        promptId,
        `${path}.persona_prompt_ids[${promptIndex}]`,
        "character_persona",
      );
    }
    requirePrompt(
      index,
      expectString(mind, "dialogue_prompt_id", path),
      `${path}.dialogue_prompt_id`,
      "character_dialogue",
    );
    requirePrompt(
      index,
      expectString(mind, "reaction_prompt_id", path),
      `${path}.reaction_prompt_id`,
      "character_reaction",
    );
    assertFieldValues(
      asObjectArray(expectProperty(mind, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "character_mind",
      undefined,
    );
  }

  const directors = asObjectArray(
    expectProperty(simulation, "director_profiles", "simulation"),
    "simulation.director_profiles",
  );
  for (const [directorIndex, director] of directors.entries()) {
    const path = `simulation.director_profiles[${directorIndex}]`;
    const worldId = expectString(director, "world_id", path);
    requireId(index.worlds, worldId, `${path}.world_id`, "world");

    const corePromptIds = asStringArray(
      expectProperty(director, "core_prompt_ids", path),
      `${path}.core_prompt_ids`,
    );
    for (const [promptIndex, promptId] of corePromptIds.entries()) {
      requirePrompt(
        index,
        promptId,
        `${path}.core_prompt_ids[${promptIndex}]`,
        "director_core",
      );
    }
    requirePrompt(
      index,
      expectString(director, "daily_settlement_prompt_id", path),
      `${path}.daily_settlement_prompt_id`,
      "director_daily_settlement",
    );
    requirePrompt(
      index,
      expectString(director, "dialogue_events_prompt_id", path),
      `${path}.dialogue_events_prompt_id`,
      "director_dialogue_events",
    );
    requirePrompt(
      index,
      expectString(director, "system_dialogue_prompt_id", path),
      `${path}.system_dialogue_prompt_id`,
      "director_system_dialogue",
    );
    requirePrompt(
      index,
      expectString(director, "goal_plan_prompt_id", path),
      `${path}.goal_plan_prompt_id`,
      "director_goal_plan",
    );
    requirePrompt(
      index,
      expectString(director, "definition_draft_prompt_id", path),
      `${path}.definition_draft_prompt_id`,
      "director_definition_draft",
    );
    assertFieldValues(
      asObjectArray(expectProperty(director, "fields", path), `${path}.fields`),
      `${path}.fields`,
      index,
      "director_profile",
      undefined,
    );
  }
}

function assertPluginOperationRef(
  ref: JsonObject,
  path: string,
  index: BundleIndex,
  expectedKind: DependencyKind,
): void {
  const dependencyId = expectString(ref, "dependency_id", path);
  assertRequiredDependency(
    dependencyId,
    `${path}.dependency_id`,
    index,
    expectedKind,
  );
  expectString(ref, "operation_id", path);
}

function assertRequiredDependency(
  dependencyId: string,
  path: string,
  index: BundleIndex,
  expectedKind: DependencyKind,
): void {
  const dependency = index.dependencies.get(dependencyId);
  if (dependency === undefined) {
    throw unresolved(dependencyId, path, "dependency");
  }
  if (dependency.kind !== expectedKind) {
    throw semanticFault(
      "content_bundle.semantic.kind_mismatch",
      `Dependency ${dependencyId} kind is ${dependency.kind}, expected ${expectedKind}`,
      {
        path,
        dependency_id: dependencyId,
        expected_kind: expectedKind,
        actual_kind: dependency.kind,
      },
    );
  }
  if (!dependency.required) {
    throw semanticFault(
      "content_bundle.semantic.dependency_not_required",
      `Referenced ${expectedKind} dependency ${dependencyId} must set required=true`,
      {
        path,
        dependency_id: dependencyId,
        dependency_kind: dependency.kind,
      },
    );
  }
}

function assertStageRef(ref: JsonObject, path: string, index: BundleIndex): void {
  const dependencyId = expectString(ref, "stage_module_dependency_id", path);
  const dependency = index.dependencies.get(dependencyId);
  if (dependency === undefined) {
    throw unresolved(dependencyId, `${path}.stage_module_dependency_id`, "dependency");
  }
  if (dependency.kind !== "stage_module") {
    throw semanticFault(
      "content_bundle.semantic.kind_mismatch",
      `Stage module dependency ${dependencyId} kind is ${dependency.kind}, expected stage_module`,
      {
        path,
        dependency_id: dependencyId,
        actual_kind: dependency.kind,
      },
    );
  }
  if (!dependency.required) {
    throw semanticFault(
      "content_bundle.semantic.stage_dependency_not_required",
      `Referenced stage_module dependency ${dependencyId} must set required=true`,
      {
        path,
        dependency_id: dependencyId,
      },
    );
  }
  expectString(ref, "scene_id", path);
}

function assertLocalRuleRef(ref: JsonObject, path: string, index: BundleIndex): void {
  const bundleId = expectString(ref, "bundle_id", path);
  const bundleDigest = expectString(ref, "bundle_digest", path);
  const ruleId = expectString(ref, "rule_id", path);

  if (bundleId !== index.packId || bundleDigest !== index.bundleDigest) {
    throw semanticFault(
      "content_bundle.semantic.rule_ref_lock",
      `RuleRef must lock the current pack_id and bundle_digest`,
      {
        path,
        expected_bundle_id: index.packId,
        actual_bundle_id: bundleId,
        expected_bundle_digest: index.bundleDigest,
        actual_bundle_digest: bundleDigest,
      },
    );
  }
  requireId(index.worldLaws, ruleId, `${path}.rule_id`, "world_law");
}

function assertFieldValues(
  values: readonly JsonObject[],
  path: string,
  index: BundleIndex,
  ownerKind: OwnerKind,
  ownerTypeId: string | undefined,
): void {
  const applicable = index.extensionFields.filter(
    (field) =>
      field.ownerKind === ownerKind &&
      (field.ownerTypeId === undefined || field.ownerTypeId === ownerTypeId),
  );
  const applicableById = new Map(applicable.map((field) => [field.fieldId, field]));
  const seen = new Map<string, Set<number>>();

  for (const [valueIndex, valueObject] of values.entries()) {
    const valuePath = `${path}[${valueIndex}]`;
    const fieldId = expectString(valueObject, "field_id", valuePath);
    const field = applicableById.get(fieldId);
    if (field === undefined) {
      throw semanticFault(
        "content_bundle.semantic.field_unknown",
        `Field ${fieldId} is not applicable to ${ownerKind}`,
        {
          path: valuePath,
          field_id: fieldId,
          owner_kind: ownerKind,
          owner_type_id: ownerTypeId ?? null,
        },
      );
    }

    const ordinal = expectInteger(valueObject, "ordinal", valuePath);
    const ordinals = seen.get(fieldId) ?? new Set<number>();
    if (ordinals.has(ordinal)) {
      throw semanticFault(
        "content_bundle.semantic.field_ordinal_duplicate",
        `Duplicate ordinal ${ordinal} for field ${fieldId}`,
        { path: valuePath, field_id: fieldId, ordinal },
      );
    }
    ordinals.add(ordinal);
    seen.set(fieldId, ordinals);

    if (field.cardinality === "one" && ordinals.size > 1) {
      throw semanticFault(
        "content_bundle.semantic.field_cardinality",
        `Field ${fieldId} has cardinality one but multiple values`,
        { path: valuePath, field_id: fieldId },
      );
    }

    if (valueObject.locale !== undefined) {
      const locale = expectString(valueObject, "locale", valuePath);
      if (!field.translatable) {
        throw semanticFault(
          "content_bundle.semantic.field_locale",
          `Field ${fieldId} is not translatable but locale is present`,
          { path: valuePath, field_id: fieldId, locale },
        );
      }
    }

    const rawValue = expectProperty(valueObject, "value", valuePath);
    assertFieldValueShape(field, rawValue, valuePath, index);
  }

  for (const field of applicable) {
    if (!field.required) {
      continue;
    }
    if (!seen.has(field.fieldId)) {
      throw semanticFault(
        "content_bundle.semantic.field_required",
        `Required field ${field.fieldId} is missing for ${ownerKind}`,
        {
          path,
          field_id: field.fieldId,
          owner_kind: ownerKind,
          owner_type_id: ownerTypeId ?? null,
        },
      );
    }
  }
}

function assertFieldValueShape(
  field: ExtensionFieldRecord,
  value: JsonValue,
  path: string,
  index: BundleIndex,
): void {
  if (field.enumSetId !== undefined) {
    if (typeof value !== "string") {
      throw semanticFault(
        "content_bundle.semantic.field_value_type",
        `Enum field ${field.fieldId} value must be a string item_id`,
        { path, field_id: field.fieldId },
      );
    }
    const items = index.enumSets.get(field.enumSetId);
    if (items === undefined || !items.has(value)) {
      throw semanticFault(
        "content_bundle.semantic.field_enum",
        `Value ${value} is not in enum_set ${field.enumSetId}`,
        {
          path,
          field_id: field.fieldId,
          enum_set_id: field.enumSetId,
          value,
        },
      );
    }
    return;
  }

  switch (field.valueType) {
    case "text": {
      if (typeof value !== "string") {
        throw fieldTypeFault(field, path, "string");
      }
      assertNumericBounds(field, value.length, path);
      assertPattern(field, value, path);
      return;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw fieldTypeFault(field, path, "integer");
      }
      assertNumericBounds(field, value, path);
      return;
    }
    case "decimal": {
      if (typeof value !== "string") {
        throw fieldTypeFault(field, path, "decimal string");
      }
      assertFieldContractValue(
        index.semanticDependencies.contracts,
        CONTRACT_REF.decimalString,
        value,
        field,
        path,
        "DecimalString",
      );
      assertDecimalBounds(
        field,
        value,
        path,
        index.semanticDependencies.decimalComparer,
      );
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw fieldTypeFault(field, path, "boolean");
      }
      return;
    }
    case "id_ref": {
      if (typeof value !== "string") {
        throw fieldTypeFault(field, path, "identifier");
      }
      assertFieldContractValue(
        index.semanticDependencies.contracts,
        CONTRACT_REF.identifier,
        value,
        field,
        path,
        "Identifier",
      );
      if (field.reference === undefined) {
        throw semanticFault(
          "content_bundle.semantic.field_reference_required",
          `id_ref field ${field.fieldId} missing reference metadata`,
          { path, field_id: field.fieldId },
        );
      }
      resolveRefKind(index, field.reference.refKind, value, path);
      return;
    }
    case "world_time": {
      if (!isJsonObject(value)) {
        throw fieldTypeFault(field, path, "LogicalTime object");
      }
      expectString(value, "clock_id", path);
      expectInteger(value, "tick", path);
      if (value.calendar_label !== undefined && typeof value.calendar_label !== "string") {
        throw fieldTypeFault(field, path, "calendar_label string");
      }
      return;
    }
    case "duration": {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw fieldTypeFault(field, path, "non-negative integer duration");
      }
      assertNumericBounds(field, value, path);
      return;
    }
    default: {
      const exhaustive: never = field.valueType;
      throw semanticFault(
        "content_bundle.semantic.field_value_type",
        `Unsupported value_type ${String(exhaustive)}`,
        { path, field_id: field.fieldId },
      );
    }
  }
}

function resolveRefKind(
  index: BundleIndex,
  refKind: RefKind,
  id: string,
  path: string,
): void {
  switch (refKind) {
    case "world":
      requireId(index.worlds, id, path, "world");
      return;
    case "type":
      requireId(index.types, id, path, "type");
      return;
    case "definition":
      requireId(index.definitions, id, path, "definition");
      return;
    case "entity":
      requireId(index.entities, id, path, "entity");
      return;
    case "relation":
      requireId(index.relations, id, path, "relation");
      return;
    case "capability":
      requireId(index.capabilities, id, path, "capability");
      return;
    case "world_law":
      requireId(index.worldLaws, id, path, "world_law");
      return;
    case "generation_archetype":
      requireId(index.generationArchetypes, id, path, "generation_archetype");
      return;
    case "prompt":
      requirePromptExists(index, id, path);
      return;
    case "art_profile":
      requireId(index.artProfiles, id, path, "art_profile");
      return;
    case "materialization_profile":
      requireId(index.materializationProfiles, id, path, "materialization_profile");
      return;
    case "asset":
      requireId(index.assets, id, path, "asset");
      return;
    case "binding":
      requireId(index.bindings, id, path, "binding");
      return;
    case "dependency":
      if (!index.dependencies.has(id)) {
        throw unresolved(id, path, "dependency");
      }
      return;
    default: {
      const exhaustive: never = refKind;
      throw semanticFault(
        "content_bundle.semantic.kind_mismatch",
        `Unsupported ref_kind ${String(exhaustive)}`,
        { path },
      );
    }
  }
}

function assertTypeParentAcyclic(types: ReadonlyMap<string, TypeRecord>): void {
  for (const type of types.values()) {
    const seen = new Set<string>();
    let current: string | undefined = type.typeId;
    while (current !== undefined) {
      if (seen.has(current)) {
        throw semanticFault(
          "content_bundle.semantic.type_cycle",
          `Type parent chain contains a cycle at ${current}`,
          { type_id: type.typeId, cycle_at: current },
        );
      }
      seen.add(current);
      current = types.get(current)?.parentTypeId;
    }
  }
}

function assertFieldContractValue(
  contracts: ContractValidator,
  schemaRef: string,
  value: JsonValue,
  field: ExtensionFieldRecord,
  path: string,
  expected: string,
): void {
  try {
    contracts.assert(schemaRef, value);
  } catch (error: unknown) {
    if (
      error instanceof EngineFault &&
      error.code === "contract.value.invalid"
    ) {
      throw fieldTypeFault(field, path, expected);
    }
    throw error;
  }
}

function assertDecimalBounds(
  field: ExtensionFieldRecord,
  value: string,
  path: string,
  comparer: ValidatedDecimalStringComparer,
): void {
  if (
    field.decimalMinimum !== undefined &&
    comparer.compare(value, field.decimalMinimum) < 0
  ) {
    throw semanticFault(
      "content_bundle.semantic.field_bounds",
      `Field ${field.fieldId} is below minimum`,
      {
        path,
        field_id: field.fieldId,
        value,
        minimum: field.decimalMinimum,
      },
    );
  }
  if (
    field.decimalMaximum !== undefined &&
    comparer.compare(value, field.decimalMaximum) > 0
  ) {
    throw semanticFault(
      "content_bundle.semantic.field_bounds",
      `Field ${field.fieldId} is above maximum`,
      {
        path,
        field_id: field.fieldId,
        value,
        maximum: field.decimalMaximum,
      },
    );
  }
}

function assertFieldBoundsDefinition(
  field: ExtensionFieldRecord,
  comparer: ValidatedDecimalStringComparer,
): void {
  const numericBoundsReversed =
    field.minimum !== undefined &&
    field.maximum !== undefined &&
    field.minimum > field.maximum;
  const decimalBoundsReversed =
    field.decimalMinimum !== undefined &&
    field.decimalMaximum !== undefined &&
    comparer.compare(field.decimalMinimum, field.decimalMaximum) > 0;
  if (!numericBoundsReversed && !decimalBoundsReversed) {
    return;
  }

  throw semanticFault(
    "content_bundle.semantic.field_bounds",
    `Field ${field.fieldId} minimum must not exceed maximum`,
    {
      path: `extension_field ${field.fieldId}`,
      field_id: field.fieldId,
      minimum: field.decimalMinimum ?? field.minimum ?? null,
      maximum: field.decimalMaximum ?? field.maximum ?? null,
    },
  );
}

function assertNumericBounds(
  field: ExtensionFieldRecord,
  value: number,
  path: string,
): void {
  if (field.minimum !== undefined && value < field.minimum) {
    throw semanticFault(
      "content_bundle.semantic.field_bounds",
      `Field ${field.fieldId} is below minimum`,
      { path, field_id: field.fieldId, value, minimum: field.minimum },
    );
  }
  if (field.maximum !== undefined && value > field.maximum) {
    throw semanticFault(
      "content_bundle.semantic.field_bounds",
      `Field ${field.fieldId} is above maximum`,
      { path, field_id: field.fieldId, value, maximum: field.maximum },
    );
  }
}

function assertPattern(field: ExtensionFieldRecord, value: string, path: string): void {
  if (field.pattern === undefined) {
    return;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(field.pattern);
  } catch {
    throw semanticFault(
      "content_bundle.semantic.field_pattern_invalid",
      `Field ${field.fieldId} pattern is not a valid regular expression`,
      { path, field_id: field.fieldId, pattern: field.pattern },
    );
  }
  if (!regex.test(value)) {
    throw semanticFault(
      "content_bundle.semantic.field_pattern",
      `Field ${field.fieldId} value does not match pattern`,
      { path, field_id: field.fieldId },
    );
  }
}

function fieldTypeFault(
  field: ExtensionFieldRecord,
  path: string,
  expected: string,
): EngineFault {
  return semanticFault(
    "content_bundle.semantic.field_value_type",
    `Field ${field.fieldId} value must be ${expected}`,
    {
      path,
      field_id: field.fieldId,
      value_type: field.valueType,
      expected,
    },
  );
}

function requireTypeKind(
  index: BundleIndex,
  typeId: string,
  expectedKind: TypeKind,
  path: string,
): void {
  const type = index.types.get(typeId);
  if (type === undefined) {
    throw unresolved(typeId, path, "type");
  }
  if (type.typeKind !== expectedKind) {
    throw semanticFault(
      "content_bundle.semantic.kind_mismatch",
      `Type ${typeId} kind is ${type.typeKind}, expected ${expectedKind}`,
      {
        path,
        type_id: typeId,
        expected_kind: expectedKind,
        actual_kind: type.typeKind,
      },
    );
  }
}

function requirePrompt(
  index: BundleIndex,
  promptId: string,
  path: string,
  expectedPurpose: PromptPurpose,
): void {
  const prompt = index.prompts.get(promptId);
  if (prompt === undefined) {
    throw unresolved(promptId, path, "prompt");
  }
  if (prompt.purpose !== expectedPurpose) {
    throw semanticFault(
      "content_bundle.semantic.purpose_mismatch",
      `Prompt ${promptId} purpose is ${prompt.purpose}, expected ${expectedPurpose}`,
      {
        path,
        prompt_id: promptId,
        expected_purpose: expectedPurpose,
        actual_purpose: prompt.purpose,
      },
    );
  }
}

function requirePromptExists(index: BundleIndex, promptId: string, path: string): void {
  if (!index.prompts.has(promptId)) {
    throw unresolved(promptId, path, "prompt");
  }
}

function requireId(
  set: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  id: string,
  path: string,
  namespace: string,
): void {
  const present = set instanceof Map ? set.has(id) : set.has(id);
  if (!present) {
    throw unresolved(id, path, namespace);
  }
}

function unresolved(id: string, path: string, namespace: string): EngineFault {
  return semanticFault(
    "content_bundle.semantic.unresolved_ref",
    `Unresolved ${namespace} reference ${id} at ${path}`,
    { path, id, namespace },
  );
}

function uniqueIdSet(
  items: readonly JsonObject[],
  idProperty: string,
  path: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = expectString(item, idProperty, `${path}[${index}]`);
    if (ids.has(id)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate ${idProperty} ${id}`,
        { namespace: idProperty, id, path: `${path}[${index}]` },
      );
    }
    ids.add(id);
  }
  return ids;
}

function uniqueIndex<TValue>(
  items: readonly JsonObject[],
  idProperty: string,
  path: string,
  mapValue: (item: JsonObject) => TValue,
): ReadonlyMap<string, TValue> {
  const map = new Map<string, TValue>();
  for (const [index, item] of items.entries()) {
    const id = expectString(item, idProperty, `${path}[${index}]`);
    if (map.has(id)) {
      throw semanticFault(
        "content_bundle.semantic.duplicate_id",
        `Duplicate ${idProperty} ${id}`,
        { namespace: idProperty, id, path: `${path}[${index}]` },
      );
    }
    map.set(id, mapValue(item));
  }
  return map;
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw semanticFault(
      "content_bundle.semantic.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function asStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw semanticFault(
      "content_bundle.semantic.shape",
      `${path} must be an array of strings`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw semanticFault(
        "content_bundle.semantic.shape",
        `${path}[${index}] must be a string`,
        { path: `${path}[${index}]` },
      );
    }
    return entry;
  });
}

function expectEnum(object: JsonObject, property: string, label: string): string {
  return expectString(object, property, label);
}

function expectBoolean(object: JsonObject, property: string, label: string): boolean {
  const value = object[property];
  if (typeof value !== "boolean") {
    throw new TypeError(`${label}.${property} must be a boolean`);
  }
  return value;
}

function optionalString(object: JsonObject, property: string): string | undefined {
  const value = object[property];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${property} must be a string when present`);
  }
  return value;
}

function optionalNumber(object: JsonObject, property: string): number | undefined {
  const value = object[property];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${property} must be a finite number when present`);
  }
  return value;
}

function semanticFault(
  code: string,
  message: string,
  details: JsonObject,
): EngineFault {
  return new EngineFault(code, message, details);
}
