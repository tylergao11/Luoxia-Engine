import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
  type LoadedContentBundle,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime/portable";

import type { ContentRuntimeIdentityMapper } from "./content-runtime-identity.js";
import { materializeContentFieldValues } from "./content-field-values.js";
import type {
  PacketContentDigest,
  StaticComponentDigestLookup,
} from "./packet-semantic-gate.js";

export interface StaticDefinitionRefLike {
  readonly bundle_id: string;
  readonly bundle_digest: string;
  readonly local_id: string;
}

export interface RuleRefLike {
  readonly bundle_id: string;
  readonly bundle_digest: string;
  readonly rule_id: string;
}

/**
 * Content-side binding for rule.evaluate: WorldLaw + PluginOperationRef + DependencyLock.
 * Does not invent PluginLock.api_version — that comes only from a registered RulePlugin manifest.
 */
export interface RuleEvaluationBinding {
  readonly law: JsonObject;
  readonly evaluator: {
    readonly dependency_id: string;
    readonly operation_id: string;
  };
  readonly dependency: JsonObject;
}

export type ContentRulePluginOperationKind =
  | "rule.evaluate"
  | "capability.resolve"
  | "navigation.resolve"
  | "definition.validate"
  | "goal_plan.validate"
  | "world_extension.resolve"
  | "content_upgrade.transform"
  | "day_cycle.advance"
  | "state_machine.advance"
  | "automatic_event.world.resolve"
  | "automatic_event.character.resolve"
  | "stage_outcome.resolve"
  | "dialogue.open"
  | "dialogue.turn.append"
  | "dialogue.close"
  | "event_card.publish";

/**
 * Exact ContentBundle owner → PluginOperationRef → required DependencyLock binding.
 * `source` only localizes faults; `operation` and `dependency` are the original
 * immutable objects from the validated ContentBundle.
 */
export interface ContentRulePluginOperationBinding {
  readonly operationKind: ContentRulePluginOperationKind;
  readonly operation: JsonObject;
  readonly dependency: JsonObject;
  readonly source: JsonObject;
}

/**
 * Process-local derived read model over locked ContentBundle documents.
 * Does not own content truth; only indexes already-loaded, digest-locked bundles.
 */
export interface BundleLockRef {
  readonly bundle_id: string;
  readonly bundle_digest: string;
}

export type { WorldContentLockDocument };

/**
 * Exact binding from WorldContentLock to registered ContentBundle WorldDefinition.
 * Holds original frozen objects from registration — not a second DTO model.
 */
export interface WorldContentBinding {
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
  readonly worldDefinition: JsonObject;
  readonly directorProfile: JsonObject;
  readonly eventBudget: JsonObject;
  readonly initialization: WorldInitializationContent;
  readonly rulePluginOperations: readonly ContentRulePluginOperationBinding[];
}

/**
 * Original frozen ContentBundle objects selected for one runtime world.
 * Catalog entities/relations and character minds are bundle-wide by contract;
 * machine definitions/bindings are restricted to the selected world.
 */
export interface WorldInitializationContent {
  readonly entities: readonly JsonObject[];
  readonly relations: readonly JsonObject[];
  readonly characterMinds: readonly JsonObject[];
  readonly stateMachines: readonly JsonObject[];
  readonly machineBindings: readonly JsonObject[];
}

export interface ContentRuntimeCatalog extends StaticComponentDigestLookup {
  register(loaded: LoadedContentBundle): void;
  hasBundle(bundleId: string, bundleDigest: string): boolean;
  findStaticDefinition(ref: StaticDefinitionRefLike): JsonObject | undefined;
  /**
   * Resolve RuleRef to WorldLaw evaluator and rule_plugin DependencyLock.
   * Missing bundle or law returns undefined; illegal shapes fail hard.
   */
  resolveRuleEvaluationBinding(
    rule: RuleRefLike,
  ): RuleEvaluationBinding | undefined;
  /**
   * Exact resolve of WorldContentLock to WorldDefinition, initialization
   * content, DirectorProfile, and every world-owned RulePlugin operation.
   * Never guesses first/single/default world.
   */
  resolveWorldContentBinding(
    lock: WorldContentLockDocument,
  ): WorldContentBinding;
  findPromptFragment(
    ref: BundleLockRef & { readonly prompt_id: string },
  ): JsonObject | undefined;
  findCharacterMindForRuntimeEntity(
    ref: BundleLockRef & {
      readonly world_id: string;
      readonly entity_id: string;
    },
  ): JsonObject | undefined;
  /** Ordered capability objects for event-context digests (same bundle lock). */
  listCapabilities(ref: BundleLockRef): readonly JsonObject[] | undefined;
  listWorldLaws(ref: BundleLockRef): readonly JsonObject[] | undefined;
  /**
   * Registration-order WorldDefinitions for a locked bundle.
   * Missing bundle returns undefined; does not pick a default world.
   */
  listWorldDefinitions(ref: BundleLockRef): readonly JsonObject[] | undefined;
  /**
   * Enumerates every v1 content-owned RulePlugin operation binding for one
   * digest-locked bundle. Missing bundle returns undefined; illegal ownership,
   * dependency kind, or required flag fails hard.
   */
  listRulePluginOperationBindings(
    ref: BundleLockRef,
  ): readonly ContentRulePluginOperationBinding[] | undefined;
}

export interface ContentRuntimeCatalogDependencies {
  readonly digest: PacketContentDigest;
  readonly identityMapper: ContentRuntimeIdentityMapper;
}

interface IndexedBundle {
  readonly packId: string;
  readonly packVersion: string;
  readonly bundleDigest: string;
  readonly document: JsonObject;
  readonly definitions: ReadonlyMap<string, JsonObject>;
  /** WorldDefinition.world_id → original WorldDefinition object. */
  readonly worlds: ReadonlyMap<string, JsonObject>;
  /** Registration-order WorldDefinition objects (no sort, no default pick). */
  readonly worldsOrdered: readonly JsonObject[];
  readonly worldLaws: ReadonlyMap<string, JsonObject>;
  readonly worldLawsOrdered: readonly JsonObject[];
  readonly dependencies: ReadonlyMap<string, JsonObject>;
  readonly promptFragments: ReadonlyMap<string, JsonObject>;
  readonly directorProfiles: ReadonlyMap<string, JsonObject>;
  readonly characterMindsByLocalEntityId: ReadonlyMap<string, JsonObject>;
  readonly characterMindsOrdered: readonly JsonObject[];
  readonly initialEntities: readonly JsonObject[];
  readonly initialRelations: readonly JsonObject[];
  readonly stateMachines: ReadonlyMap<string, JsonObject>;
  readonly stateMachinesOrdered: readonly JsonObject[];
  readonly initialMachineBindings: readonly JsonObject[];
  readonly capabilitiesOrdered: readonly JsonObject[];
}

export function createContentRuntimeCatalog(
  dependencies: ContentRuntimeCatalogDependencies,
): ContentRuntimeCatalog {
  return new DefaultContentRuntimeCatalog(
    dependencies.digest,
    dependencies.identityMapper,
  );
}

class DefaultContentRuntimeCatalog implements ContentRuntimeCatalog {
  readonly #digest: PacketContentDigest;
  readonly #identityMapper: ContentRuntimeIdentityMapper;
  readonly #bundles = new Map<string, IndexedBundle>();

  public constructor(
    digest: PacketContentDigest,
    identityMapper: ContentRuntimeIdentityMapper,
  ) {
    this.#digest = digest;
    this.#identityMapper = identityMapper;
  }

  public register(loaded: LoadedContentBundle): void {
    const root = loaded.document.value;
    const bundle = expectJsonObject(
      expectProperty(root, "bundle", "ContentBundle"),
      "ContentBundle.bundle",
    );
    const manifest = expectJsonObject(
      expectProperty(bundle, "manifest", "bundle"),
      "bundle.manifest",
    );
    const packId = expectString(manifest, "pack_id", "manifest");
    const packVersion = expectString(manifest, "pack_version", "manifest");
    const bundleDigest = loaded.bundleDigest;
    if (bundleDigest.length !== 64) {
      throw new EngineFault(
        "content.catalog.bundle_digest_invalid",
        "LoadedContentBundle.bundleDigest must be a lowercase SHA-256 hex digest",
        { pack_id: packId, bundle_digest: bundleDigest },
      );
    }

    const release = expectJsonObject(
      expectProperty(root, "release", "ContentBundle"),
      "ContentBundle.release",
    );
    const declaredDigest = expectString(release, "bundle_digest", "release");
    if (declaredDigest !== bundleDigest) {
      throw new EngineFault(
        "content.catalog.bundle_digest_mismatch",
        "LoadedContentBundle.bundleDigest does not match release.bundle_digest",
        {
          pack_id: packId,
          declared_digest: declaredDigest,
          loaded_digest: bundleDigest,
        },
      );
    }

    const key = bundleKey(packId, bundleDigest);
    const existing = this.#bundles.get(key);
    if (existing !== undefined) {
      if (!jsonEquals(existing.document, root)) {
        throw new EngineFault(
          "content.catalog.bundle_conflict",
          "ContentBundle already registered with the same pack_id and digest but different document",
          { pack_id: packId, bundle_digest: bundleDigest },
        );
      }
      return;
    }

    const catalog = expectJsonObject(
      expectProperty(bundle, "catalog", "bundle"),
      "bundle.catalog",
    );
    const definitionsList = asObjectArray(
      expectProperty(catalog, "definitions", "catalog"),
      "catalog.definitions",
    );
    const definitions = new Map<string, JsonObject>();
    for (const definition of definitionsList) {
      const definitionId = expectString(
        definition,
        "definition_id",
        "StaticDefinition",
      );
      if (definitions.has(definitionId)) {
        throw new EngineFault(
          "content.catalog.duplicate_definition",
          `Duplicate definition_id ${definitionId} in registered ContentBundle`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            definition_id: definitionId,
          },
        );
      }
      definitions.set(definitionId, definition);
    }
    const initialEntities = asObjectArray(
      expectProperty(catalog, "entities", "catalog"),
      "catalog.entities",
    );
    const initialRelations = asObjectArray(
      expectProperty(catalog, "relations", "catalog"),
      "catalog.relations",
    );

    const dependenciesList = asObjectArray(
      expectProperty(bundle, "dependencies", "bundle"),
      "bundle.dependencies",
    );
    const dependencies = new Map<string, JsonObject>();
    for (const dependency of dependenciesList) {
      const dependencyId = expectString(
        dependency,
        "dependency_id",
        "DependencyLock",
      );
      if (dependencies.has(dependencyId)) {
        throw new EngineFault(
          "content.catalog.duplicate_dependency",
          `Duplicate dependency_id ${dependencyId} in registered ContentBundle`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            dependency_id: dependencyId,
          },
        );
      }
      dependencies.set(dependencyId, dependency);
    }

    const gameplay = expectJsonObject(
      expectProperty(bundle, "gameplay", "bundle"),
      "bundle.gameplay",
    );
    const worldLawsList = asObjectArray(
      expectProperty(gameplay, "world_laws", "gameplay"),
      "gameplay.world_laws",
    );
    const worldLaws = new Map<string, JsonObject>();
    for (const law of worldLawsList) {
      const lawId = expectString(law, "law_id", "WorldLaw");
      if (worldLaws.has(lawId)) {
        throw new EngineFault(
          "content.catalog.duplicate_world_law",
          `Duplicate law_id ${lawId} in registered ContentBundle`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            law_id: lawId,
          },
        );
      }
      worldLaws.set(lawId, law);
    }

    const promptFragments = uniqueIdMap(
      asObjectArray(
        expectProperty(gameplay, "prompt_fragments", "gameplay"),
        "gameplay.prompt_fragments",
      ),
      "prompt_id",
      "PromptFragment",
      packId,
      bundleDigest,
      "content.catalog.duplicate_prompt",
    );

    const capabilitiesOrdered = asObjectArray(
      expectProperty(gameplay, "capabilities", "gameplay"),
      "gameplay.capabilities",
    );

    const simulation = expectJsonObject(
      expectProperty(bundle, "simulation", "bundle"),
      "bundle.simulation",
    );
    const directorProfiles = uniqueIdMap(
      asObjectArray(
        expectProperty(simulation, "director_profiles", "simulation"),
        "simulation.director_profiles",
      ),
      "director_id",
      "DirectorProfile",
      packId,
      bundleDigest,
      "content.catalog.duplicate_director_profile",
    );
    const characterMindsList = asObjectArray(
      expectProperty(simulation, "character_minds", "simulation"),
      "simulation.character_minds",
    );
    const characterMinds = new Map<string, JsonObject>();
    const characterMindsByLocalEntityId = new Map<string, JsonObject>();
    for (const mind of characterMindsList) {
      const mindId = expectString(mind, "mind_id", "CharacterMindProfile");
      if (characterMinds.has(mindId)) {
        throw new EngineFault(
          "content.catalog.duplicate_character_mind",
          `Duplicate mind_id ${mindId} in registered ContentBundle`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            mind_id: mindId,
          },
        );
      }
      characterMinds.set(mindId, mind);
      const entityId = expectString(mind, "entity_id", "CharacterMindProfile");
      if (characterMindsByLocalEntityId.has(entityId)) {
        throw new EngineFault(
          "content.catalog.duplicate_character_mind_entity",
          `Duplicate CharacterMindProfile entity_id ${entityId}`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            entity_id: entityId,
          },
        );
      }
      characterMindsByLocalEntityId.set(entityId, mind);
    }
    const stateMachinesList = asObjectArray(
      expectProperty(simulation, "state_machines", "simulation"),
      "simulation.state_machines",
    );
    const stateMachines = uniqueIdMap(
      stateMachinesList,
      "machine_id",
      "StateMachineDefinition",
      packId,
      bundleDigest,
      "content.catalog.duplicate_state_machine",
    );
    const initialMachineBindings = asObjectArray(
      expectProperty(
        simulation,
        "initial_machine_bindings",
        "simulation",
      ),
      "simulation.initial_machine_bindings",
    );

    const worldsList = asObjectArray(
      expectProperty(bundle, "worlds", "bundle"),
      "bundle.worlds",
    );
    const worlds = new Map<string, JsonObject>();
    for (const worldDefinition of worldsList) {
      const worldDefinitionId = expectString(
        worldDefinition,
        "world_id",
        "WorldDefinition",
      );
      if (worlds.has(worldDefinitionId)) {
        throw new EngineFault(
          "content.catalog.duplicate_world_id",
          `Duplicate WorldDefinition.world_id ${worldDefinitionId} in registered ContentBundle`,
          {
            pack_id: packId,
            bundle_digest: bundleDigest,
            world_id: worldDefinitionId,
          },
        );
      }
      worlds.set(worldDefinitionId, worldDefinition);
    }

    this.#bundles.set(
      key,
      Object.freeze({
        packId,
        packVersion,
        bundleDigest,
        document: root,
        definitions,
        worlds,
        worldsOrdered: Object.freeze([...worldsList]),
        worldLaws,
        worldLawsOrdered: Object.freeze([...worldLawsList]),
        dependencies,
        promptFragments,
        directorProfiles,
        characterMindsByLocalEntityId,
        characterMindsOrdered: Object.freeze([...characterMindsList]),
        initialEntities: Object.freeze([...initialEntities]),
        initialRelations: Object.freeze([...initialRelations]),
        stateMachines,
        stateMachinesOrdered: Object.freeze([...stateMachinesList]),
        initialMachineBindings: Object.freeze([
          ...initialMachineBindings,
        ]),
        capabilitiesOrdered: Object.freeze([...capabilitiesOrdered]),
      }),
    );
  }

  public hasBundle(bundleId: string, bundleDigest: string): boolean {
    return this.#bundles.has(bundleKey(bundleId, bundleDigest));
  }

  public findStaticDefinition(
    ref: StaticDefinitionRefLike,
  ): JsonObject | undefined {
    const indexed = this.#bundles.get(
      bundleKey(ref.bundle_id, ref.bundle_digest),
    );
    if (indexed === undefined) {
      return undefined;
    }
    return indexed.definitions.get(ref.local_id);
  }

  public resolveRuleEvaluationBinding(
    rule: RuleRefLike,
  ): RuleEvaluationBinding | undefined {
    const indexed = this.#bundles.get(
      bundleKey(rule.bundle_id, rule.bundle_digest),
    );
    if (indexed === undefined) {
      return undefined;
    }

    const law = indexed.worldLaws.get(rule.rule_id);
    if (law === undefined) {
      return undefined;
    }

    const evaluator = expectJsonObject(
      expectProperty(law, "evaluator", "WorldLaw"),
      "WorldLaw.evaluator",
    );
    const dependencyId = expectString(
      evaluator,
      "dependency_id",
      "PluginOperationRef",
    );
    const operationId = expectString(
      evaluator,
      "operation_id",
      "PluginOperationRef",
    );

    const dependency = resolveRequiredRulePluginDependency(
      indexed,
      evaluator,
      Object.freeze({
        pack_id: rule.bundle_id,
        bundle_digest: rule.bundle_digest,
        owner_kind: "world_law",
        rule_id: rule.rule_id,
        owner_field: "evaluator",
      }),
    );

    return Object.freeze({
      law,
      evaluator: Object.freeze({
        dependency_id: dependencyId,
        operation_id: operationId,
      }),
      dependency,
    });
  }

  public resolveWorldContentBinding(
    lock: WorldContentLockDocument,
  ): WorldContentBinding {
    const lockValue = lock.value;
    const rootBundleLock = expectJsonObject(
      expectProperty(lockValue, "root_bundle_lock", "WorldContentLock"),
      "WorldContentLock.root_bundle_lock",
    );
    const packId = expectString(rootBundleLock, "pack_id", "PackLock");
    const packVersion = expectString(rootBundleLock, "pack_version", "PackLock");
    const bundleDigest = expectString(
      rootBundleLock,
      "bundle_digest",
      "PackLock",
    );
    const worldDefinitionId = expectString(
      lockValue,
      "world_definition_id",
      "WorldContentLock",
    );

    const indexed = this.#bundles.get(bundleKey(packId, bundleDigest));
    if (indexed === undefined) {
      throw new EngineFault(
        "content.catalog.world_bundle_missing",
        "WorldContentLock root_bundle_lock is not registered in ContentRuntimeCatalog",
        {
          pack_id: packId,
          pack_version: packVersion,
          bundle_digest: bundleDigest,
          world_definition_id: worldDefinitionId,
        },
      );
    }

    if (indexed.packVersion !== packVersion) {
      throw new EngineFault(
        "content.catalog.world_pack_version_mismatch",
        "WorldContentLock pack_version does not match registered ContentBundle pack_version",
        {
          pack_id: packId,
          lock_pack_version: packVersion,
          registered_pack_version: indexed.packVersion,
          bundle_digest: bundleDigest,
        },
      );
    }

    const worldDefinition = indexed.worlds.get(worldDefinitionId);
    if (worldDefinition === undefined) {
      throw new EngineFault(
        "content.catalog.world_definition_missing",
        "WorldContentLock.world_definition_id is not present in the registered ContentBundle",
        {
          pack_id: packId,
          bundle_digest: bundleDigest,
          world_definition_id: worldDefinitionId,
        },
      );
    }

    const eventBudget = expectJsonObject(
      expectProperty(worldDefinition, "event_budget", "WorldDefinition"),
      "WorldDefinition.event_budget",
    );
    const directorProfileId = expectString(
      worldDefinition,
      "director_profile_id",
      "WorldDefinition",
    );
    const directorProfile = indexed.directorProfiles.get(directorProfileId);
    if (directorProfile === undefined) {
      throw new EngineFault(
        "content.catalog.director_profile_missing",
        "WorldDefinition.director_profile_id is not present in the registered ContentBundle",
        {
          pack_id: packId,
          bundle_digest: bundleDigest,
          world_definition_id: worldDefinitionId,
          director_profile_id: directorProfileId,
        },
      );
    }
    const directorWorldId = expectString(
      directorProfile,
      "world_id",
      "DirectorProfile",
    );
    if (directorWorldId !== worldDefinitionId) {
      throw new EngineFault(
        "content.catalog.director_world_mismatch",
        "WorldDefinition.director_profile_id must select a DirectorProfile in the same world",
        {
          pack_id: packId,
          bundle_digest: bundleDigest,
          world_definition_id: worldDefinitionId,
          director_profile_id: directorProfileId,
          director_world_id: directorWorldId,
        },
      );
    }

    const rulePluginOperations = collectWorldRulePluginOperationBindings(
      indexed,
      worldDefinition,
    );
    const stateMachines = indexed.stateMachinesOrdered.filter(
      (machine) =>
        expectString(machine, "world_id", "StateMachineDefinition") ===
        worldDefinitionId,
    );
    const stateMachineIds = new Set(
      stateMachines.map((machine) =>
        expectString(machine, "machine_id", "StateMachineDefinition"),
      ),
    );
    const machineBindings = indexed.initialMachineBindings.filter(
      (binding) => {
        const machineId = expectString(
          binding,
          "machine_id",
          "InitialMachineBinding",
        );
        const machine = indexed.stateMachines.get(machineId);
        if (machine === undefined) {
          throw new EngineFault(
            "content.catalog.machine_binding_machine_missing",
            "InitialMachineBinding.machine_id is not present in the registered ContentBundle",
            {
              pack_id: packId,
              bundle_digest: bundleDigest,
              world_definition_id: worldDefinitionId,
              machine_id: machineId,
            },
          );
        }
        return stateMachineIds.has(machineId);
      },
    );
    const initialization: WorldInitializationContent = Object.freeze({
      entities: indexed.initialEntities,
      relations: indexed.initialRelations,
      characterMinds: indexed.characterMindsOrdered,
      stateMachines: Object.freeze(stateMachines),
      machineBindings: Object.freeze(machineBindings),
    });

    return Object.freeze({
      packId: indexed.packId,
      packVersion: indexed.packVersion,
      bundleDigest: indexed.bundleDigest,
      worldDefinition,
      directorProfile,
      eventBudget,
      initialization,
      rulePluginOperations,
    });
  }

  public findPromptFragment(
    ref: BundleLockRef & { readonly prompt_id: string },
  ): JsonObject | undefined {
    return this.#bundles
      .get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.promptFragments.get(ref.prompt_id);
  }

  public findCharacterMindForRuntimeEntity(
    ref: BundleLockRef & {
      readonly world_id: string;
      readonly entity_id: string;
    },
  ): JsonObject | undefined {
    const indexed = this.#bundles.get(
      bundleKey(ref.bundle_id, ref.bundle_digest),
    );
    if (indexed === undefined) {
      return undefined;
    }

    const targetEntityId = ref.entity_id.toLowerCase();
    let match: JsonObject | undefined;
    let matchedLocalEntityId: string | undefined;
    for (const [
      localEntityId,
      profile,
    ] of indexed.characterMindsByLocalEntityId.entries()) {
      const runtimeEntityId = this.#identityMapper.toRuntimeUuid({
        worldId: ref.world_id,
        packId: indexed.packId,
        kind: "entity",
        localId: localEntityId,
      });
      if (runtimeEntityId !== targetEntityId) {
        continue;
      }
      if (match !== undefined && matchedLocalEntityId !== undefined) {
        throw new EngineFault(
          "content.catalog.runtime_identity_collision",
          "Multiple CharacterMindProfile local entity IDs map to the same runtime UUID",
          {
            pack_id: indexed.packId,
            bundle_digest: indexed.bundleDigest,
            world_id: ref.world_id,
            runtime_entity_id: targetEntityId,
            first_local_entity_id: matchedLocalEntityId,
            second_local_entity_id: localEntityId,
          },
        );
      }
      match = profile;
      matchedLocalEntityId = localEntityId;
    }
    return match;
  }

  public listCapabilities(
    ref: BundleLockRef,
  ): readonly JsonObject[] | undefined {
    return this.#bundles.get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.capabilitiesOrdered;
  }

  public listWorldLaws(ref: BundleLockRef): readonly JsonObject[] | undefined {
    return this.#bundles.get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.worldLawsOrdered;
  }

  public listWorldDefinitions(
    ref: BundleLockRef,
  ): readonly JsonObject[] | undefined {
    return this.#bundles.get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.worldsOrdered;
  }

  public listRulePluginOperationBindings(
    ref: BundleLockRef,
  ): readonly ContentRulePluginOperationBinding[] | undefined {
    const indexed = this.#bundles.get(
      bundleKey(ref.bundle_id, ref.bundle_digest),
    );
    if (indexed === undefined) {
      return undefined;
    }
    return collectBundleRulePluginOperationBindings(indexed);
  }

  public async findValueDigest(input: {
    readonly definition: JsonObject;
    readonly componentType: JsonValue;
    readonly ordinal: number;
  }): Promise<string | undefined> {
    if (expectString(input.definition, "kind", "DefinitionRef") !== "static") {
      return undefined;
    }

    const bundleId = expectString(
      input.definition,
      "bundle_id",
      "StaticDefinitionRef",
    );
    const bundleDigest = expectString(
      input.definition,
      "bundle_digest",
      "StaticDefinitionRef",
    );
    const localId = expectString(
      input.definition,
      "local_id",
      "StaticDefinitionRef",
    );

    const indexed = this.#bundles.get(bundleKey(bundleId, bundleDigest));
    if (indexed === undefined) {
      return undefined;
    }

    const definition = indexed.definitions.get(localId);
    if (definition === undefined) {
      return undefined;
    }

    if (!isJsonObject(input.componentType)) {
      throw new EngineFault(
        "content.catalog.component_type_shape",
        "componentType must be a CatalogRef object",
        {},
      );
    }
    const componentType = input.componentType;
    const catalogKind = expectString(
      componentType,
      "catalog_kind",
      "CatalogRef",
    );
    if (catalogKind !== "component_type") {
      throw new EngineFault(
        "content.catalog.component_type_kind",
        "Static component lookup requires catalog_kind=component_type",
        { catalog_kind: catalogKind },
      );
    }
    const typeLocalId = expectString(componentType, "local_id", "CatalogRef");
    const typeBundleId = expectString(componentType, "bundle_id", "CatalogRef");
    const typeBundleDigest = expectString(
      componentType,
      "bundle_digest",
      "CatalogRef",
    );
    if (typeBundleId !== bundleId || typeBundleDigest !== bundleDigest) {
      throw new EngineFault(
        "content.catalog.component_type_lock_mismatch",
        "Component type CatalogRef must lock the same bundle as the static definition",
        {
          definition_bundle_id: bundleId,
          definition_bundle_digest: bundleDigest,
          component_bundle_id: typeBundleId,
          component_bundle_digest: typeBundleDigest,
        },
      );
    }

    const components = asObjectArray(
      expectProperty(definition, "components", "StaticDefinition"),
      "StaticDefinition.components",
    );
    const matches = components.filter((component) => {
      const ordinal = expectInteger(component, "ordinal", "ComponentInstance");
      const componentTypeId = expectString(
        component,
        "component_type_id",
        "ComponentInstance",
      );
      return ordinal === input.ordinal && componentTypeId === typeLocalId;
    });

    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw new EngineFault(
        "content.catalog.component_ambiguous",
        "Multiple static components match type and ordinal",
        {
          definition_id: localId,
          component_type_id: typeLocalId,
          ordinal: input.ordinal,
          matches: matches.length,
        },
      );
    }

    const component = matches[0] as JsonObject;
    const fields = materializeContentFieldValues(
      expectProperty(component, "fields", "ComponentInstance"),
      "ComponentInstance.fields",
    );
    return this.#digest.sha256(fields);
  }
}

const WORLD_RULE_PLUGIN_OPERATION_OWNERS = [
  ["calendar_resolver", "day_cycle.advance"],
  ["navigation_resolver", "navigation.resolve"],
  ["goal_plan_validator", "goal_plan.validate"],
  ["world_automatic_event_resolver", "automatic_event.world.resolve"],
  [
    "character_automatic_event_resolver",
    "automatic_event.character.resolve",
  ],
  ["stage_outcome_resolver", "stage_outcome.resolve"],
  ["dialogue_open_resolver", "dialogue.open"],
  ["dialogue_turn_append_resolver", "dialogue.turn.append"],
  ["dialogue_close_resolver", "dialogue.close"],
] as const satisfies readonly (
  readonly [string, ContentRulePluginOperationKind]
)[];

function collectBundleRulePluginOperationBindings(
  indexed: IndexedBundle,
): readonly ContentRulePluginOperationBinding[] {
  const bundle = expectJsonObject(
    expectProperty(indexed.document, "bundle", "ContentBundle"),
    "ContentBundle.bundle",
  );
  const bindings: ContentRulePluginOperationBinding[] = [];

  const append = (
    owner: JsonObject,
    ownerField: string,
    operationKind: ContentRulePluginOperationKind,
    source: JsonObject,
  ): void => {
    const operation = expectJsonObject(
      expectProperty(owner, ownerField, `${String(source["owner_kind"])} owner`),
      `${String(source["owner_kind"])}.${ownerField}`,
    );
    bindings.push(
      createContentRulePluginOperationBinding(
        indexed,
        operation,
        operationKind,
        source,
      ),
    );
  };

  const catalog = expectJsonObject(
    expectProperty(bundle, "catalog", "bundle"),
    "bundle.catalog",
  );
  for (const typeDefinition of asObjectArray(
    expectProperty(catalog, "types", "catalog"),
    "catalog.types",
  )) {
    if (typeDefinition.validator === undefined) {
      continue;
    }
    append(
      typeDefinition,
      "validator",
      "definition.validate",
      contentOperationSource(indexed, {
        owner_kind: "type_definition",
        owner_id: expectString(typeDefinition, "type_id", "TypeDefinition"),
        owner_field: "validator",
      }),
    );
  }

  const gameplay = expectJsonObject(
    expectProperty(bundle, "gameplay", "bundle"),
    "bundle.gameplay",
  );
  for (const capability of asObjectArray(
    expectProperty(gameplay, "capabilities", "gameplay"),
    "gameplay.capabilities",
  )) {
    append(
      capability,
      "resolver",
      "capability.resolve",
      contentOperationSource(indexed, {
        owner_kind: "capability",
        owner_id: expectString(capability, "capability_id", "Capability"),
        owner_field: "resolver",
      }),
    );
  }
  for (const law of indexed.worldLawsOrdered) {
    append(
      law,
      "evaluator",
      "rule.evaluate",
      contentOperationSource(indexed, {
        owner_kind: "world_law",
        owner_id: expectString(law, "law_id", "WorldLaw"),
        owner_field: "evaluator",
      }),
    );
  }
  for (const archetype of asObjectArray(
    expectProperty(gameplay, "generation_archetypes", "gameplay"),
    "gameplay.generation_archetypes",
  )) {
    append(
      archetype,
      "generator",
      "world_extension.resolve",
      contentOperationSource(indexed, {
        owner_kind: "generation_archetype",
        owner_id: expectString(
          archetype,
          "archetype_id",
          "GenerationArchetype",
        ),
        owner_field: "generator",
      }),
    );
  }

  for (const worldDefinition of indexed.worldsOrdered) {
    bindings.push(
      ...collectWorldRulePluginOperationBindings(indexed, worldDefinition),
    );
  }

  for (const upgrade of asObjectArray(
    expectProperty(bundle, "content_upgrades", "bundle"),
    "bundle.content_upgrades",
  )) {
    append(
      upgrade,
      "transformer",
      "content_upgrade.transform",
      contentOperationSource(indexed, {
        owner_kind: "content_upgrade",
        owner_id: expectString(upgrade, "migration_id", "ContentUpgrade"),
        owner_field: "transformer",
      }),
    );
  }

  const simulation = expectJsonObject(
    expectProperty(bundle, "simulation", "bundle"),
    "bundle.simulation",
  );
  for (const machine of asObjectArray(
    expectProperty(simulation, "state_machines", "simulation"),
    "simulation.state_machines",
  )) {
    append(
      machine,
      "advance_resolver",
      "state_machine.advance",
      contentOperationSource(indexed, {
        owner_kind: "state_machine",
        owner_id: expectString(machine, "machine_id", "StateMachineDefinition"),
        owner_field: "advance_resolver",
      }),
    );
  }

  return Object.freeze(bindings);
}

function collectWorldRulePluginOperationBindings(
  indexed: IndexedBundle,
  worldDefinition: JsonObject,
): readonly ContentRulePluginOperationBinding[] {
  const worldId = expectString(
    worldDefinition,
    "world_id",
    "WorldDefinition",
  );
  const bindings = WORLD_RULE_PLUGIN_OPERATION_OWNERS.map(
    ([ownerField, operationKind]) => {
      const operation = expectJsonObject(
        expectProperty(worldDefinition, ownerField, "WorldDefinition"),
        `WorldDefinition.${ownerField}`,
      );
      return createContentRulePluginOperationBinding(
        indexed,
        operation,
        operationKind,
        contentOperationSource(indexed, {
          owner_kind: "world_definition",
          owner_id: worldId,
          owner_field: ownerField,
        }),
      );
    },
  );

  const eventBudget = expectJsonObject(
    expectProperty(worldDefinition, "event_budget", "WorldDefinition"),
    "WorldDefinition.event_budget",
  );
  const cardCostOperation = expectJsonObject(
    expectProperty(
      eventBudget,
      "card_cost_resolver",
      "EventBudgetPolicy",
    ),
    "EventBudgetPolicy.card_cost_resolver",
  );
  bindings.push(
    createContentRulePluginOperationBinding(
      indexed,
      cardCostOperation,
      "event_card.publish",
      contentOperationSource(indexed, {
        owner_kind: "world_definition",
        owner_id: worldId,
        owner_field: "event_budget.card_cost_resolver",
      }),
    ),
  );
  return Object.freeze(bindings);
}

function createContentRulePluginOperationBinding(
  indexed: IndexedBundle,
  operation: JsonObject,
  operationKind: ContentRulePluginOperationKind,
  source: JsonObject,
): ContentRulePluginOperationBinding {
  return Object.freeze({
    operationKind,
    operation,
    dependency: resolveRequiredRulePluginDependency(
      indexed,
      operation,
      source,
    ),
    source,
  });
}

function contentOperationSource(
  indexed: IndexedBundle,
  owner: JsonObject,
): JsonObject {
  return Object.freeze({
    pack_id: indexed.packId,
    bundle_digest: indexed.bundleDigest,
    ...owner,
  });
}

/**
 * Shared resolver for PluginOperationRef → required rule_plugin DependencyLock.
 * Returns the original dependency object from the indexed bundle (no copy).
 */
function resolveRequiredRulePluginDependency(
  indexed: IndexedBundle,
  operationRef: JsonObject,
  source: JsonObject,
): JsonObject {
  const dependencyId = expectString(
    operationRef,
    "dependency_id",
    "PluginOperationRef",
  );
  expectString(operationRef, "operation_id", "PluginOperationRef");

  const dependency = indexed.dependencies.get(dependencyId);
  const faultDetails = Object.freeze({
    ...source,
    dependency_id: dependencyId,
  });
  if (dependency === undefined) {
    throw new EngineFault(
      "content.catalog.operation_dependency_missing",
      "PluginOperationRef dependency_id is not registered in ContentBundle.dependencies",
      faultDetails,
    );
  }

  const dependencyKind = expectString(
    dependency,
    "dependency_kind",
    "DependencyLock",
  );
  if (dependencyKind !== "rule_plugin") {
    throw new EngineFault(
      "content.catalog.operation_dependency_kind",
      "Content-owned RulePlugin operation requires dependency_kind=rule_plugin",
      Object.freeze({ ...faultDetails, dependency_kind: dependencyKind }),
    );
  }

  const required = dependency["required"];
  if (required !== true) {
    throw new EngineFault(
      "content.catalog.operation_dependency_not_required",
      "Content-owned RulePlugin operation DependencyLock.required must be true",
      faultDetails,
    );
  }

  return dependency;
}

function bundleKey(bundleId: string, bundleDigest: string): string {
  return `${bundleId}\u0000${bundleDigest}`;
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "content.catalog.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function uniqueIdMap(
  items: readonly JsonObject[],
  idField: string,
  typeName: string,
  packId: string,
  bundleDigest: string,
  faultCode: string,
): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const item of items) {
    const id = expectString(item, idField, typeName);
    if (map.has(id)) {
      throw new EngineFault(
        faultCode,
        `Duplicate ${idField} ${id} in registered ContentBundle`,
        {
          pack_id: packId,
          bundle_digest: bundleDigest,
          [idField]: id,
        },
      );
    }
    map.set(id, item);
  }
  return map;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
