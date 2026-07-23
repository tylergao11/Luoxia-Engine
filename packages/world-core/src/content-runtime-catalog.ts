import type { LoadedContentBundle } from "@luoxia/contracts-runtime";
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

/**
 * Process-local derived read model over locked ContentBundle documents.
 * Does not own content truth; only indexes already-loaded, digest-locked bundles.
 */
export interface BundleLockRef {
  readonly bundle_id: string;
  readonly bundle_digest: string;
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
  findPromptFragment(
    ref: BundleLockRef & { readonly prompt_id: string },
  ): JsonObject | undefined;
  findDirectorProfile(
    ref: BundleLockRef & { readonly director_id: string },
  ): JsonObject | undefined;
  findCharacterMindProfile(
    ref: BundleLockRef & { readonly mind_id: string },
  ): JsonObject | undefined;
  findCharacterMindByEntityId(
    ref: BundleLockRef & { readonly entity_id: string },
  ): JsonObject | undefined;
  /** Ordered capability objects for event-context digests (same bundle lock). */
  listCapabilities(ref: BundleLockRef): readonly JsonObject[] | undefined;
  listWorldLaws(ref: BundleLockRef): readonly JsonObject[] | undefined;
}

export interface ContentRuntimeCatalogDependencies {
  readonly digest: PacketContentDigest;
}

interface IndexedBundle {
  readonly packId: string;
  readonly bundleDigest: string;
  readonly document: JsonObject;
  readonly definitions: ReadonlyMap<string, JsonObject>;
  readonly worldLaws: ReadonlyMap<string, JsonObject>;
  readonly worldLawsOrdered: readonly JsonObject[];
  readonly dependencies: ReadonlyMap<string, JsonObject>;
  readonly promptFragments: ReadonlyMap<string, JsonObject>;
  readonly directorProfiles: ReadonlyMap<string, JsonObject>;
  readonly characterMinds: ReadonlyMap<string, JsonObject>;
  readonly characterMindsByEntityId: ReadonlyMap<string, JsonObject>;
  readonly capabilitiesOrdered: readonly JsonObject[];
}

export function createContentRuntimeCatalog(
  dependencies: ContentRuntimeCatalogDependencies,
): ContentRuntimeCatalog {
  return new DefaultContentRuntimeCatalog(dependencies.digest);
}

class DefaultContentRuntimeCatalog implements ContentRuntimeCatalog {
  readonly #digest: PacketContentDigest;
  readonly #bundles = new Map<string, IndexedBundle>();

  public constructor(digest: PacketContentDigest) {
    this.#digest = digest;
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
    const characterMindsByEntityId = new Map<string, JsonObject>();
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
      if (characterMindsByEntityId.has(entityId)) {
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
      characterMindsByEntityId.set(entityId, mind);
    }

    this.#bundles.set(
      key,
      Object.freeze({
        packId,
        bundleDigest,
        document: root,
        definitions,
        worldLaws,
        worldLawsOrdered: Object.freeze([...worldLawsList]),
        dependencies,
        promptFragments,
        directorProfiles,
        characterMinds,
        characterMindsByEntityId,
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

    const dependency = indexed.dependencies.get(dependencyId);
    if (dependency === undefined) {
      throw new EngineFault(
        "content.catalog.rule_dependency_missing",
        "WorldLaw evaluator dependency_id is not registered in ContentBundle.dependencies",
        {
          pack_id: rule.bundle_id,
          bundle_digest: rule.bundle_digest,
          rule_id: rule.rule_id,
          dependency_id: dependencyId,
        },
      );
    }

    const dependencyKind = expectString(
      dependency,
      "dependency_kind",
      "DependencyLock",
    );
    if (dependencyKind !== "rule_plugin") {
      throw new EngineFault(
        "content.catalog.rule_dependency_kind",
        "rule.evaluate binding requires dependency_kind=rule_plugin",
        {
          pack_id: rule.bundle_id,
          bundle_digest: rule.bundle_digest,
          rule_id: rule.rule_id,
          dependency_id: dependencyId,
          dependency_kind: dependencyKind,
        },
      );
    }

    return Object.freeze({
      law,
      evaluator: Object.freeze({
        dependency_id: dependencyId,
        operation_id: operationId,
      }),
      dependency,
    });
  }

  public findPromptFragment(
    ref: BundleLockRef & { readonly prompt_id: string },
  ): JsonObject | undefined {
    return this.#bundles
      .get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.promptFragments.get(ref.prompt_id);
  }

  public findDirectorProfile(
    ref: BundleLockRef & { readonly director_id: string },
  ): JsonObject | undefined {
    return this.#bundles
      .get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.directorProfiles.get(ref.director_id);
  }

  public findCharacterMindProfile(
    ref: BundleLockRef & { readonly mind_id: string },
  ): JsonObject | undefined {
    return this.#bundles
      .get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.characterMinds.get(ref.mind_id);
  }

  public findCharacterMindByEntityId(
    ref: BundleLockRef & { readonly entity_id: string },
  ): JsonObject | undefined {
    return this.#bundles
      .get(bundleKey(ref.bundle_id, ref.bundle_digest))
      ?.characterMindsByEntityId.get(ref.entity_id);
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
    const fields = expectProperty(component, "fields", "ComponentInstance");
    return this.#digest.sha256(fields);
  }
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
