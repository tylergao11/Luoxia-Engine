import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  WorldContentBinding,
} from "@luoxia/world-core";

export type DirectorMode =
  | "daily_settlement"
  | "dialogue_events"
  | "system_dialogue"
  | "goal_plan"
  | "definition_draft";

export type CharacterMode = "dialogue" | "react";

export interface MaterializedPromptBlock {
  readonly block_id: string;
  readonly content_digest: string;
  readonly text: string;
  readonly purpose: string;
}

export interface MaterializedResidentContext {
  readonly resident_context: JsonObject;
  readonly ordered_blocks: readonly MaterializedPromptBlock[];
}

export interface PromptMaterializer {
  materializeDirector(input: {
    readonly contentBinding: WorldContentBinding;
    readonly mode: DirectorMode;
  }): MaterializedResidentContext;

  materializeCharacter(input: {
    readonly contentBinding: WorldContentBinding;
    readonly runtimeWorldId: string;
    readonly entityId: string;
    readonly mode: CharacterMode;
  }): MaterializedResidentContext;
}

export function createPromptMaterializer(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly digest: JsonDigest;
}): PromptMaterializer {
  return new DefaultPromptMaterializer(input.catalog, input.digest);
}

class DefaultPromptMaterializer implements PromptMaterializer {
  readonly #catalog: ContentRuntimeCatalog;
  readonly #digest: JsonDigest;

  public constructor(catalog: ContentRuntimeCatalog, digest: JsonDigest) {
    this.#catalog = catalog;
    this.#digest = digest;
  }

  public materializeDirector(input: {
    readonly contentBinding: WorldContentBinding;
    readonly mode: DirectorMode;
  }): MaterializedResidentContext {
    const packId = input.contentBinding.packId;
    const bundleDigest = input.contentBinding.bundleDigest;
    const profile = input.contentBinding.directorProfile;
    const directorProfileId = expectString(
      profile,
      "director_id",
      "DirectorProfile",
    );

    const coreIds = asStringArray(
      expectProperty(profile, "core_prompt_ids", "DirectorProfile"),
      "DirectorProfile.core_prompt_ids",
    );
    const directorCoreBlocks = coreIds.map((promptId) =>
      this.#materializeFragment({
        bundle_id: packId,
        bundle_digest: bundleDigest,
        prompt_id: promptId,
        expectedPurposePrefix: "director_",
      }),
    );
    const systemPersonaBlock =
      input.mode === "system_dialogue"
        ? this.#materializeFragment({
            bundle_id: packId,
            bundle_digest: bundleDigest,
            prompt_id: expectString(
              expectJsonObject(
                expectProperty(
                  input.contentBinding.worldDefinition,
                  "system",
                  "WorldDefinition",
                ),
                "WorldDefinition.system",
              ),
              "persona_prompt_id",
              "WorldDefinition.system",
            ),
            expectedPurposePrefix: "system_",
          })
        : undefined;

    const modePromptField = directorModePromptField(input.mode);
    const modePromptId = expectString(
      profile,
      modePromptField,
      "DirectorProfile",
    );
    const modeBlock = this.#materializeFragment({
      bundle_id: packId,
      bundle_digest: bundleDigest,
      prompt_id: modePromptId,
      expectedPurposePrefix: "director_",
    });
    // Selection-space guidance must not re-embed PromptFragment text already
    // present earlier in this resident prefix (same content_digest).
    const priorResidentDigests = new Set<string>(
      directorCoreBlocks.map((block) => block.content_digest),
    );
    if (systemPersonaBlock !== undefined) {
      priorResidentDigests.add(systemPersonaBlock.content_digest);
    }
    const selectionSpaceBlock =
      this.#materializeSelectionSpace(
        input.contentBinding,
        input.mode,
        priorResidentDigests,
      );

    const ordered_blocks = Object.freeze([
      ...directorCoreBlocks,
      ...(systemPersonaBlock === undefined
        ? []
        : [systemPersonaBlock]),
      ...(selectionSpaceBlock === undefined
        ? []
        : [selectionSpaceBlock]),
      modeBlock,
    ]);
    // DeepSeek/OpenAI-style providers send ordered_blocks as consecutive system
    // messages (stable resident prefix), then schema instruction, then dynamic
    // user JSON only. Keep shared core/persona/selection before mode so prefix
    // caching does not see operation input earlier than necessary.
    const coreRefs = directorCoreBlocks.map((block) =>
      cacheBlockRef(block),
    );
    const systemPersonaRef =
      systemPersonaBlock === undefined
        ? undefined
        : cacheBlockRef(systemPersonaBlock);
    const selectionSpaceRef =
      selectionSpaceBlock === undefined
        ? undefined
        : cacheBlockRef(selectionSpaceBlock);
    const modeRef = cacheBlockRef(modeBlock);
    const residentDigestInput: Record<string, JsonValue> = {
      core_blocks: coreRefs,
      mode: input.mode,
      mode_block: modeRef,
    };
    if (systemPersonaRef !== undefined) {
      residentDigestInput.system_persona_block = systemPersonaRef;
    }
    if (selectionSpaceRef !== undefined) {
      residentDigestInput.selection_space_block = selectionSpaceRef;
    }
    const resident_digest = this.#digest.sha256(
      Object.freeze(residentDigestInput),
    );
    const resident_key = namespacedKey([
      packId,
      "director",
      directorProfileId,
      input.mode,
    ]);

    const residentContext: Record<string, JsonValue> = {
      context_kind: "director",
      resident_key,
      resident_digest,
      director_id: directorProfileId,
      core_blocks: coreRefs,
      mode: input.mode,
      mode_block: modeRef,
    };
    if (systemPersonaRef !== undefined) {
      residentContext.system_persona_block = systemPersonaRef;
    }
    if (selectionSpaceRef !== undefined) {
      residentContext.selection_space_block = selectionSpaceRef;
    }
    const resident_context: JsonObject = Object.freeze(residentContext);

    return Object.freeze({
      resident_context,
      ordered_blocks,
    });
  }

  public materializeCharacter(input: {
    readonly contentBinding: WorldContentBinding;
    readonly runtimeWorldId: string;
    readonly entityId: string;
    readonly mode: CharacterMode;
  }): MaterializedResidentContext {
    const packId = input.contentBinding.packId;
    const bundleDigest = input.contentBinding.bundleDigest;

    const profile = this.#catalog.findCharacterMindForRuntimeEntity({
      bundle_id: packId,
      bundle_digest: bundleDigest,
      world_id: input.runtimeWorldId,
      entity_id: input.entityId,
    });
    if (profile === undefined) {
      throw unresolved(
        "character_mind_by_entity",
        packId,
        bundleDigest,
        input.entityId,
      );
    }

    const mindId = expectString(profile, "mind_id", "CharacterMindProfile");

    const personaIds = asStringArray(
      expectProperty(profile, "persona_prompt_ids", "CharacterMindProfile"),
      "CharacterMindProfile.persona_prompt_ids",
    );
    if (personaIds.length === 0) {
      throw new EngineFault(
        "prompt.materializer.persona_empty",
        "CharacterMindProfile.persona_prompt_ids must contain at least one prompt",
        { mind_id: mindId, entity_id: input.entityId },
      );
    }

    const personaBlocks = personaIds.map((promptId) =>
      this.#materializeFragment({
        bundle_id: packId,
        bundle_digest: bundleDigest,
        prompt_id: promptId,
        expectedPurposePrefix: "character_",
      }),
    );

    const modePromptId = expectString(
      profile,
      input.mode === "dialogue" ? "dialogue_prompt_id" : "reaction_prompt_id",
      "CharacterMindProfile",
    );
    const modeBlock = this.#materializeFragment({
      bundle_id: packId,
      bundle_digest: bundleDigest,
      prompt_id: modePromptId,
      expectedPurposePrefix: "character_",
    });

    const ordered_blocks = Object.freeze([
      ...personaBlocks,
      modeBlock,
    ]);
    const personaRefs = personaBlocks.map((block) => cacheBlockRef(block));
    const modeRef = cacheBlockRef(modeBlock);
    const mind_profile: JsonObject = Object.freeze({
      catalog_kind: "character_mind",
      bundle_id: packId,
      bundle_digest: bundleDigest,
      local_id: mindId,
    });
    const resident_digest = this.#digest.sha256(
      Object.freeze({
        entity_id: input.entityId,
        mind_profile,
        persona_blocks: personaRefs,
        mode: input.mode,
        mode_block: modeRef,
      }),
    );
    const resident_key = namespacedKey([
      packId,
      "character",
      mindId,
      input.mode,
    ]);

    const resident_context: JsonObject = Object.freeze({
      context_kind: "character",
      resident_key,
      resident_digest,
      entity_id: input.entityId,
      mind_profile,
      persona_blocks: personaRefs,
      mode: input.mode,
      mode_block: modeRef,
    });

    return Object.freeze({
      resident_context,
      ordered_blocks,
    });
  }

  #materializeFragment(input: {
    readonly bundle_id: string;
    readonly bundle_digest: string;
    readonly prompt_id: string;
    readonly expectedPurposePrefix: string;
  }): MaterializedPromptBlock {
    const fragment = this.#catalog.findPromptFragment({
      bundle_id: input.bundle_id,
      bundle_digest: input.bundle_digest,
      prompt_id: input.prompt_id,
    });
    if (fragment === undefined) {
      throw unresolved(
        "prompt_fragment",
        input.bundle_id,
        input.bundle_digest,
        input.prompt_id,
      );
    }
    const purpose = expectString(fragment, "purpose", "PromptFragment");
    if (
      !purpose.startsWith(input.expectedPurposePrefix) &&
      purpose !== "system_persona"
    ) {
      if (
        input.expectedPurposePrefix === "director_" &&
        !purpose.startsWith("director_")
      ) {
        throw new EngineFault(
          "prompt.materializer.purpose_mismatch",
          "PromptFragment purpose does not match Director materialization",
          {
            prompt_id: input.prompt_id,
            purpose,
          },
        );
      }
    }
    const text = expectString(fragment, "text", "PromptFragment");
    const content_digest = this.#digest.sha256(text);
    const block_id = namespacedKey([input.bundle_id, "prompt", input.prompt_id]);
    return Object.freeze({
      block_id,
      content_digest,
      text,
      purpose,
    });
  }

  #materializeSelectionSpace(
    contentBinding: WorldContentBinding,
    mode: DirectorMode,
    priorResidentDigests: ReadonlySet<string>,
  ): MaterializedPromptBlock | undefined {
    if (
      mode !== "goal_plan" &&
      mode !== "definition_draft"
    ) {
      return undefined;
    }
    const ref = {
      bundle_id: contentBinding.packId,
      bundle_digest: contentBinding.bundleDigest,
    };
    const catalog = this.#catalog.listModelSelectionCatalog(ref);
    if (catalog === undefined) {
      throw unresolved(
        "model_selection_catalog",
        ref.bundle_id,
        ref.bundle_digest,
        ref.bundle_id,
      );
    }
    const worldId = expectString(
      contentBinding.worldDefinition,
      "world_id",
      "WorldDefinition",
    );
    const selectionSpace =
      mode === "goal_plan"
        ? this.#goalPlanSelectionSpace(
            ref,
            worldId,
            catalog,
            priorResidentDigests,
          )
        : definitionSelectionSpace(catalog);
    const text =
      "Use only zero-based indices from this immutable ContentBundle selection space. " +
      "Never invent catalog or rule identifiers. " +
      JSON.stringify(selectionSpace);
    return Object.freeze({
      block_id: namespacedKey([
        ref.bundle_id,
        "director",
        mode,
        "selection_space",
      ]),
      content_digest: this.#digest.sha256(text),
      text,
      purpose: `director_${mode}_selection_space`,
    });
  }

  #goalPlanSelectionSpace(
    ref: {
      readonly bundle_id: string;
      readonly bundle_digest: string;
    },
    worldId: string,
    catalog: ReturnType<
      ContentRuntimeCatalog["listModelSelectionCatalog"]
    > & object,
    priorResidentDigests: ReadonlySet<string>,
  ): JsonObject {
    const capabilities = catalog.capabilities.filter(
      (entry) =>
        expectString(entry, "world_id", "Capability") ===
        worldId,
    );
    const worldLaws = catalog.worldLaws.filter(
      (entry) =>
        expectString(entry, "world_id", "WorldLaw") === worldId,
    );
    const generationArchetypes =
      catalog.generationArchetypes.filter(
        (entry) =>
          expectString(
            entry,
            "world_id",
            "GenerationArchetype",
          ) === worldId,
      );
    if (
      worldLaws.length === 0 ||
      (capabilities.length === 0 &&
        generationArchetypes.length === 0)
    ) {
      throw new EngineFault(
        "prompt.materializer.selection_space_empty",
        "Goal planning requires at least one world law and one capability or generation archetype",
        {
          bundle_id: ref.bundle_id,
          bundle_digest: ref.bundle_digest,
          world_id: worldId,
          capability_count: capabilities.length,
          world_law_count: worldLaws.length,
          generation_archetype_count:
            generationArchetypes.length,
        },
      );
    }
    return Object.freeze({
      selection_space_kind: "goal_plan",
      capabilities: Object.freeze(
        capabilities.map((entry, index) => {
          const base: Record<string, JsonValue> = {
            index,
            name: expectProperty(entry, "name", "Capability"),
            description: expectProperty(
              entry,
              "description",
              "Capability",
            ),
          };
          if (entry.planning_prompt_id !== undefined) {
            const guidance = this.#promptTextIfNew(
              ref,
              expectString(
                entry,
                "planning_prompt_id",
                "Capability",
              ),
              priorResidentDigests,
            );
            if (guidance !== undefined) {
              base.planning_guidance = guidance;
            }
          }
          return Object.freeze(base);
        }),
      ),
      world_laws: Object.freeze(
        worldLaws.map((entry, index) => {
          const base: Record<string, JsonValue> = {
            index,
            name: expectProperty(entry, "name", "WorldLaw"),
            description: expectProperty(
              entry,
              "description",
              "WorldLaw",
            ),
            law_mode: expectString(
              entry,
              "law_mode",
              "WorldLaw",
            ),
            priority: expectProperty(
              entry,
              "priority",
              "WorldLaw",
            ),
          };
          if (entry.explanation_prompt_id !== undefined) {
            const explanation = this.#promptTextIfNew(
              ref,
              expectString(
                entry,
                "explanation_prompt_id",
                "WorldLaw",
              ),
              priorResidentDigests,
            );
            if (explanation !== undefined) {
              base.explanation = explanation;
            }
          }
          return Object.freeze(base);
        }),
      ),
      generation_archetypes: Object.freeze(
        generationArchetypes.map((entry, index) => {
          const base: Record<string, JsonValue> = {
            index,
            name: expectProperty(
              entry,
              "name",
              "GenerationArchetype",
            ),
            description: expectProperty(
              entry,
              "description",
              "GenerationArchetype",
            ),
            result_kind: expectString(
              entry,
              "result_kind",
              "GenerationArchetype",
            ),
          };
          const guidance = this.#promptTextIfNew(
            ref,
            expectString(
              entry,
              "prompt_fragment_id",
              "GenerationArchetype",
            ),
            priorResidentDigests,
          );
          if (guidance !== undefined) {
            base.guidance = guidance;
          }
          return Object.freeze(base);
        }),
      ),
    });
  }

  /**
   * Returns prompt text only when its digest is not already carried by an
   * earlier resident block of the same materialization. Missing fragments still
   * fail hard; omission means the model already has the identical text.
   */
  #promptTextIfNew(
    ref: {
      readonly bundle_id: string;
      readonly bundle_digest: string;
    },
    promptId: string,
    priorResidentDigests: ReadonlySet<string>,
  ): string | undefined {
    const text = this.#promptText(ref, promptId);
    const textDigest = this.#digest.sha256(text);
    if (priorResidentDigests.has(textDigest)) {
      return undefined;
    }
    return text;
  }

  #promptText(
    ref: {
      readonly bundle_id: string;
      readonly bundle_digest: string;
    },
    promptId: string,
  ): string {
    const fragment = this.#catalog.findPromptFragment({
      ...ref,
      prompt_id: promptId,
    });
    if (fragment === undefined) {
      throw unresolved(
        "prompt_fragment",
        ref.bundle_id,
        ref.bundle_digest,
        promptId,
      );
    }
    return expectString(fragment, "text", "PromptFragment");
  }
}

function definitionSelectionSpace(
  catalog: ReturnType<
    ContentRuntimeCatalog["listModelSelectionCatalog"]
  > & object,
): JsonObject {
  const definitionTypes = catalog.definitionTypes.filter(
    (entry) =>
      entry.runtime_creatable === true &&
      entry.validator !== undefined,
  );
  if (definitionTypes.length === 0) {
    throw new EngineFault(
      "prompt.materializer.selection_space_empty",
      "Definition drafting requires at least one runtime-creatable definition type with an explicit validator",
    );
  }
  return Object.freeze({
    selection_space_kind: "definition_draft",
    definition_types: Object.freeze(
      definitionTypes.map((entry, index) =>
        Object.freeze({
          index,
          name: expectProperty(
            entry,
            "name",
            "TypeDefinition",
          ),
          description: expectProperty(
            entry,
            "description",
            "TypeDefinition",
          ),
        }),
      ),
    ),
    component_types: Object.freeze(
      catalog.componentTypes.map((entry, index) =>
        Object.freeze({
          index,
          name: expectProperty(
            entry,
            "name",
            "TypeDefinition",
          ),
          description: expectProperty(
            entry,
            "description",
            "TypeDefinition",
          ),
          cardinality: expectString(
            entry,
            "component_cardinality",
            "TypeDefinition",
          ),
        }),
      ),
    ),
  });
}

function directorModePromptField(
  mode: DirectorMode,
):
  | "daily_settlement_prompt_id"
  | "dialogue_events_prompt_id"
  | "system_dialogue_prompt_id"
  | "goal_plan_prompt_id"
  | "definition_draft_prompt_id" {
  switch (mode) {
    case "daily_settlement":
      return "daily_settlement_prompt_id";
    case "dialogue_events":
      return "dialogue_events_prompt_id";
    case "system_dialogue":
      return "system_dialogue_prompt_id";
    case "goal_plan":
      return "goal_plan_prompt_id";
    case "definition_draft":
      return "definition_draft_prompt_id";
  }
}

function cacheBlockRef(block: MaterializedPromptBlock): JsonObject {
  return Object.freeze({
    block_id: block.block_id,
    content_digest: block.content_digest,
  });
}

function namespacedKey(parts: readonly string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const piece of part.split(".")) {
      if (piece.length === 0) {
        continue;
      }
      segments.push(piece.replace(/[^a-z0-9_-]/gi, "_").toLowerCase());
    }
  }
  if (segments.length < 2) {
    segments.unshift("luoxia");
  }
  return segments.join(".");
}

function asStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "prompt.materializer.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new EngineFault(
        "prompt.materializer.shape",
        `${path}[${index}] must be a string`,
        { path },
      );
    }
    return entry;
  });
}

function unresolved(
  kind: string,
  bundleId: string,
  bundleDigest: string,
  localId: string,
): EngineFault {
  return new EngineFault(
    "prompt.materializer.unresolved",
    `ContentRuntimeCatalog cannot resolve ${kind} under the locked bundle`,
    {
      kind,
      bundle_id: bundleId,
      bundle_digest: bundleDigest,
      local_id: localId,
    },
  );
}
