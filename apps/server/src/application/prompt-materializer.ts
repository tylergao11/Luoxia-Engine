import {
  EngineFault,
  expectProperty,
  expectString,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  WorldContentBinding,
} from "@luoxia/world-core/composition";

export type DirectorMode =
  | "daily_settlement"
  | "dialogue_events"
  | "system_dialogue";

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
  readonly event_context?: {
    readonly capability_catalog_digest: string;
    readonly world_law_catalog_digest: string;
    readonly content_bundle_digest: string;
    readonly event_contract_digest: string;
    readonly context_digest: string;
  };
}

export interface PromptMaterializer {
  materializeDirector(input: {
    readonly contentBinding: WorldContentBinding;
    readonly directorId: string;
    readonly mode: DirectorMode;
  }): MaterializedResidentContext;

  materializeCharacter(input: {
    readonly contentBinding: WorldContentBinding;
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
    readonly directorId: string;
    readonly mode: DirectorMode;
  }): MaterializedResidentContext {
    const packId = input.contentBinding.packId;
    const bundleDigest = input.contentBinding.bundleDigest;
    const worldDefinitionId = expectString(
      input.contentBinding.worldDefinition,
      "world_id",
      "WorldDefinition",
    );

    const profile = this.#catalog.findDirectorProfile({
      bundle_id: packId,
      bundle_digest: bundleDigest,
      director_id: input.directorId,
    });
    if (profile === undefined) {
      throw unresolved("director_profile", packId, bundleDigest, input.directorId);
    }

    const profileWorldId = expectString(profile, "world_id", "DirectorProfile");
    if (profileWorldId !== worldDefinitionId) {
      throw new EngineFault(
        "prompt.materializer.director_world_mismatch",
        "DirectorProfile.world_id must equal the WorldContentLock WorldDefinition.world_id",
        {
          director_id: input.directorId,
          director_world_id: profileWorldId,
          world_definition_id: worldDefinitionId,
          pack_id: packId,
          bundle_digest: bundleDigest,
        },
      );
    }

    const coreIds = asStringArray(
      expectProperty(profile, "core_prompt_ids", "DirectorProfile"),
      "DirectorProfile.core_prompt_ids",
    );
    const commonBlocks = coreIds.map((promptId) =>
      this.#materializeFragment({
        bundle_id: packId,
        bundle_digest: bundleDigest,
        prompt_id: promptId,
        expectedPurposePrefix: "director_",
      }),
    );

    const modePromptField =
      input.mode === "daily_settlement"
        ? "daily_settlement_prompt_id"
        : input.mode === "dialogue_events"
          ? "dialogue_events_prompt_id"
          : "system_dialogue_prompt_id";
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

    const eventContext = this.#materializeEventContext({
      bundle_id: packId,
      bundle_digest: bundleDigest,
    });

    const ordered_blocks = Object.freeze([...commonBlocks, modeBlock]);
    const commonRefs = commonBlocks.map((block) => cacheBlockRef(block));
    const modeRef = cacheBlockRef(modeBlock);
    const resident_digest = this.#digest.sha256(
      Object.freeze({
        common_blocks: commonRefs,
        event_context: eventContext.ref,
        mode: input.mode,
        mode_block: modeRef,
      }),
    );
    const resident_key = namespacedKey([
      packId,
      "director",
      input.directorId,
      input.mode,
    ]);

    const resident_context: JsonObject = Object.freeze({
      context_kind: "director",
      resident_key,
      resident_digest,
      director_id: input.directorId,
      common_blocks: commonRefs,
      event_context: eventContext.ref,
      mode: input.mode,
      mode_block: modeRef,
    });

    return Object.freeze({
      resident_context,
      ordered_blocks,
      event_context: eventContext.payload,
    });
  }

  public materializeCharacter(input: {
    readonly contentBinding: WorldContentBinding;
    readonly entityId: string;
    readonly mode: CharacterMode;
  }): MaterializedResidentContext {
    const packId = input.contentBinding.packId;
    const bundleDigest = input.contentBinding.bundleDigest;

    const profile = this.#catalog.findCharacterMindByEntityId({
      bundle_id: packId,
      bundle_digest: bundleDigest,
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

    const commonBlocks = [
      this.#materializeFragment({
        bundle_id: packId,
        bundle_digest: bundleDigest,
        prompt_id: personaIds[0] as string,
        expectedPurposePrefix: "character_",
      }),
    ];
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
      ...commonBlocks,
      ...personaBlocks,
      modeBlock,
    ]);
    const commonRefs = commonBlocks.map((block) => cacheBlockRef(block));
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
        common_blocks: commonRefs,
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
      common_blocks: commonRefs,
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

  #materializeEventContext(input: {
    readonly bundle_id: string;
    readonly bundle_digest: string;
  }): {
    readonly ref: JsonObject;
    readonly payload: MaterializedResidentContext["event_context"] & object;
  } {
    const capabilities = this.#catalog.listCapabilities(input);
    const worldLaws = this.#catalog.listWorldLaws(input);
    if (capabilities === undefined || worldLaws === undefined) {
      throw unresolved(
        "event_catalog",
        input.bundle_id,
        input.bundle_digest,
        input.bundle_id,
      );
    }

    const capability_catalog_digest = this.#digest.sha256(
      capabilities as JsonValue,
    );
    const world_law_catalog_digest = this.#digest.sha256(worldLaws as JsonValue);
    const content_bundle_digest = input.bundle_digest;
    const event_contract_digest = this.#digest.sha256(
      Object.freeze({
        contract: "model-protocol.v1",
        event_context: "director.event_invocation",
      }),
    );
    const context_digest = this.#digest.sha256(
      Object.freeze({
        event_contract_digest,
        content_bundle_digest,
        capability_catalog_digest,
        world_law_catalog_digest,
      }),
    );
    const ref: JsonObject = Object.freeze({
      context_digest,
      event_contract_digest,
      content_bundle_digest,
      capability_catalog_digest,
      world_law_catalog_digest,
    });
    return Object.freeze({
      ref,
      payload: Object.freeze({
        capability_catalog_digest,
        world_law_catalog_digest,
        content_bundle_digest,
        event_contract_digest,
        context_digest,
      }),
    });
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
