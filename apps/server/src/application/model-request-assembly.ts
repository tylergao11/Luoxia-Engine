import { randomUUID } from "node:crypto";

import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type { ContentRuntimeCatalog } from "@luoxia/world-core/composition";

import type {
  ModelGateway,
  VerifiedModelInvocationReceipt,
  WorldSnapshotDocument,
} from "./model-gateway.js";
import type { PostgresRuntimeInvocationJournal } from "../adapters/postgres/runtime-invocation-journal.js";
import {
  createPromptMaterializer,
  type CharacterMode,
  type DirectorMode,
  type PromptMaterializer,
} from "./prompt-materializer.js";
import {
  projectCharacterSubjectiveView,
  projectDialogue,
  projectDirectorWorldView,
  projectKnowledgeView,
  projectObjectiveTracesEmpty,
  readDayNumber,
} from "./model-view-projection.js";
import type {
  RuntimeWorldReader,
  StoredModelInvocation,
} from "./runtime-persistence.js";

export interface ContentProfileLock {
  readonly bundle_id: string;
  readonly bundle_digest: string;
}

export interface DirectorContentLock extends ContentProfileLock {
  readonly director_id: string;
}

export interface CharacterContentLock extends ContentProfileLock {
  readonly mind_id: string;
}

export interface RuntimeModelFacades {
  directorDailySettlement(input: {
    readonly worldId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly content: CharacterContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly events: readonly JsonObject[];
    readonly content: CharacterContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;
}

export function createRuntimeModelFacades(input: {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly catalog: ContentRuntimeCatalog;
  readonly worlds: RuntimeWorldReader;
  readonly modelGateway: ModelGateway;
  readonly journal: PostgresRuntimeInvocationJournal;
  readonly materializer?: PromptMaterializer;
}): RuntimeModelFacades {
  void input.contracts;
  const materializer =
    input.materializer ??
    createPromptMaterializer({
      catalog: input.catalog,
      digest: input.digest,
    });
  const assembly = new ModelRequestAssembly({
    digest: input.digest,
    worlds: input.worlds,
    modelGateway: input.modelGateway,
    journal: input.journal,
    materializer,
  });
  return Object.freeze({
    directorDailySettlement: (
      args: Parameters<RuntimeModelFacades["directorDailySettlement"]>[0],
    ) => assembly.directorDailySettlement(args),
    directorDialogueEvents: (
      args: Parameters<RuntimeModelFacades["directorDialogueEvents"]>[0],
    ) => assembly.directorDialogueEvents(args),
    directorSystemDialogue: (
      args: Parameters<RuntimeModelFacades["directorSystemDialogue"]>[0],
    ) => assembly.directorSystemDialogue(args),
    characterDialogue: (
      args: Parameters<RuntimeModelFacades["characterDialogue"]>[0],
    ) => assembly.characterDialogue(args),
    characterReact: (
      args: Parameters<RuntimeModelFacades["characterReact"]>[0],
    ) => assembly.characterReact(args),
  });
}

class ModelRequestAssembly {
  readonly #digest: JsonDigest;
  readonly #worlds: RuntimeWorldReader;
  readonly #modelGateway: ModelGateway;
  readonly #journal: PostgresRuntimeInvocationJournal;
  readonly #materializer: PromptMaterializer;

  public constructor(input: {
    readonly digest: JsonDigest;
    readonly worlds: RuntimeWorldReader;
    readonly modelGateway: ModelGateway;
    readonly journal: PostgresRuntimeInvocationJournal;
    readonly materializer: PromptMaterializer;
  }) {
    this.#digest = input.digest;
    this.#worlds = input.worlds;
    this.#modelGateway = input.modelGateway;
    this.#journal = input.journal;
    this.#materializer = input.materializer;
  }

  public directorDailySettlement(input: {
    readonly worldId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#runDirector("daily_settlement", input, async (ctx) => {
      const day = readDayNumber(ctx.worldState);
      return Object.freeze({
        world_view: projectDirectorWorldView(ctx.worldState, day),
        objective_traces: projectObjectiveTracesEmpty(),
      });
    });
  }

  public directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#runDirector("dialogue_events", input, async (ctx) => {
      const day = readDayNumber(ctx.worldState);
      return Object.freeze({
        world_view: projectDirectorWorldView(ctx.worldState, day),
        dialogue: projectDialogue(ctx.worldState, input.dialogueId),
      });
    });
  }

  public directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly content: DirectorContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#runDirector("system_dialogue", input, async (ctx) => {
      const day = readDayNumber(ctx.worldState);
      return Object.freeze({
        world_view: projectDirectorWorldView(ctx.worldState, day),
        knowledge_view: projectKnowledgeView(
          ctx.worldState,
          input.playerEntityId,
        ),
        dialogue: projectDialogue(ctx.worldState, input.dialogueId),
      });
    });
  }

  public characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly content: CharacterContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#runCharacter("dialogue", input, async (ctx) =>
      Object.freeze({
        subjective_view: projectCharacterSubjectiveView(
          input.worldId,
          ctx.worldState,
          input.entityId,
        ),
        dialogue: projectDialogue(ctx.worldState, input.dialogueId),
        latest_player_turn_id: input.latestPlayerTurnId,
      }),
    );
  }

  public characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly events: readonly JsonObject[];
    readonly content: CharacterContentLock;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    if (input.events.length === 0) {
      throw new EngineFault(
        "model.assembly.react_events_empty",
        "character.react requires at least one CharacterEventStimulus from committed authority",
        { entity_id: input.entityId },
      );
    }
    return this.#runCharacter("react", input, async (ctx) =>
      Object.freeze({
        subjective_view: projectCharacterSubjectiveView(
          input.worldId,
          ctx.worldState,
          input.entityId,
        ),
        events: Object.freeze([...input.events]),
      }),
    );
  }

  async #runDirector(
    mode: DirectorMode,
    input: {
      readonly worldId: string;
      readonly content: DirectorContentLock;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
    }) => Promise<JsonObject>,
  ): Promise<VerifiedModelInvocationReceipt> {
    const snapshot = await this.#loadSnapshot(input.worldId);
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dynamicInput = await buildInput({ worldState, snapshot });
    const materialized = this.#materializer.materializeDirector({
      bundle_id: input.content.bundle_id,
      bundle_digest: input.content.bundle_digest,
      director_id: input.content.director_id,
      mode,
    });
    const requestKind =
      mode === "daily_settlement"
        ? "director.daily_settlement"
        : mode === "dialogue_events"
          ? "director.dialogue_events"
          : "director.system_dialogue";
    return this.#invoke({
      snapshot,
      requestKind,
      modelProfileId: input.model_profile_id,
      residentContext: materialized.resident_context,
      promptBlocks: materialized.ordered_blocks,
      eventContext: materialized.event_context,
      dynamicInput,
    });
  }

  async #runCharacter(
    mode: CharacterMode,
    input: {
      readonly worldId: string;
      readonly entityId: string;
      readonly content: CharacterContentLock;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
    }) => Promise<JsonObject>,
  ): Promise<VerifiedModelInvocationReceipt> {
    const snapshot = await this.#loadSnapshot(input.worldId);
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dynamicInput = await buildInput({ worldState, snapshot });
    const materialized = this.#materializer.materializeCharacter({
      bundle_id: input.content.bundle_id,
      bundle_digest: input.content.bundle_digest,
      mind_id: input.content.mind_id,
      entity_id: input.entityId,
      mode,
    });
    const requestKind =
      mode === "dialogue" ? "character.dialogue" : "character.react";
    return this.#invoke({
      snapshot,
      requestKind,
      modelProfileId: input.model_profile_id,
      residentContext: materialized.resident_context,
      promptBlocks: materialized.ordered_blocks,
      eventContext: undefined,
      dynamicInput,
    });
  }

  async #loadSnapshot(worldId: string): Promise<WorldSnapshotDocument> {
    return this.#worlds.readCurrent(worldId);
  }

  async #invoke(input: {
    readonly snapshot: WorldSnapshotDocument;
    readonly requestKind: string;
    readonly modelProfileId: string;
    readonly residentContext: JsonObject;
    readonly promptBlocks: readonly {
      readonly block_id: string;
      readonly content_digest: string;
      readonly text: string;
    }[];
    readonly eventContext:
      | {
          readonly capability_catalog_digest: string;
          readonly world_law_catalog_digest: string;
          readonly content_bundle_digest: string;
          readonly event_contract_digest: string;
          readonly context_digest: string;
        }
      | undefined;
    readonly dynamicInput: JsonObject;
  }): Promise<VerifiedModelInvocationReceipt> {
    const basisRevision = expectIntegerSafe(
      input.snapshot.value,
      "world_revision",
    );
    const dynamic_input_digest = this.#digest.sha256(input.dynamicInput);
    const candidate = Object.freeze({
      contract_version: "model-protocol.v1",
      record_type: "model.request",
      request_id: randomUUID(),
      request_kind: input.requestKind,
      model_profile_id: input.modelProfileId,
      basis_revision: basisRevision,
      resident_context: input.residentContext,
      dynamic_input_digest,
      input: input.dynamicInput,
    });

    const resolution =
      input.eventContext === undefined
        ? Object.freeze({ prompt_blocks: input.promptBlocks })
        : Object.freeze({
            prompt_blocks: input.promptBlocks,
            event_context: input.eventContext,
          });
    const prepared = this.#modelGateway.prepare(
      Object.freeze({ snapshot: input.snapshot }),
      candidate,
      resolution,
    );

    const requestId = expectString(
      prepared.request.value,
      "request_id",
      "ModelRequest",
    );
    const requestKind = expectString(
      prepared.request.value,
      "request_kind",
      "ModelRequest",
    );
    const isDaily = requestKind === "director.daily_settlement";

    if (isDaily) {
      const run = await this.#journal.prepareDirectorInvocation(prepared);
      return continueModelFromStored({
        modelGateway: this.#modelGateway,
        journal: this.#journal,
        prepared,
        stored: run.invocation,
        requestId,
        dailyRunId: run.runId,
      });
    }

    const stored = await this.#journal.persistPrepared(prepared);
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId,
      dailyRunId: undefined,
    });
  }
}

async function continueModelFromStored(input: {
  readonly modelGateway: ModelGateway;
  readonly journal: PostgresRuntimeInvocationJournal;
  readonly prepared: ReturnType<ModelGateway["prepare"]>;
  readonly stored: StoredModelInvocation;
  readonly requestId: string;
  readonly dailyRunId: string | undefined;
}): Promise<VerifiedModelInvocationReceipt> {
  switch (input.stored.phase) {
    case "verified": {
      const recovered = await input.journal.recoverVerifiedByRequestId(
        input.requestId,
      );
      if (recovered === undefined) {
        throw new EngineFault(
          "runtime.kernel.model_verified_receipt_missing",
          "Stored model invocation is verified but formal receipt recovery failed",
          { request_id: input.requestId },
        );
      }
      return recovered;
    }
    case "dispatched_ambiguous":
      throw new EngineFault(
        "runtime.kernel.model_dispatch_ambiguous",
        "Model invocation was dispatched without a verified receipt; execution is blocked",
        {
          request_id: input.requestId,
          request_kind: input.stored.requestKind,
          world_id: input.stored.worldId,
          world_revision: input.stored.worldRevision,
        },
      );
    case "prepared": {
      const authorization =
        input.dailyRunId === undefined
          ? (await input.journal.markDispatched(input.prepared)).authorization
          : (
              await input.journal.markDirectorDispatched(
                input.dailyRunId,
                input.prepared,
              )
            ).authorization;
      const receipt = await input.modelGateway.invokePrepared(authorization);
      if (input.dailyRunId === undefined) {
        await input.journal.recordVerified(receipt);
      } else {
        await input.journal.recordDirectorVerified(input.dailyRunId, receipt);
      }
      return receipt;
    }
    default: {
      throw new EngineFault(
        "runtime.kernel.model_phase_unknown",
        "Stored model invocation phase is not recognized",
        { request_id: input.requestId },
      );
    }
  }
}

function expectIntegerSafe(object: JsonObject, field: string): number {
  const value = object[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EngineFault(
      "model.assembly.revision_shape",
      `${field} must be an integer`,
      { field },
    );
  }
  return value;
}
