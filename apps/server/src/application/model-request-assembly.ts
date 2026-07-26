import { randomUUID } from "node:crypto";

import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonDigest,
  type JsonObject,
} from "@luoxia/contracts-runtime";

import type {
  ModelGateway,
  VerifiedModelInvocationReceipt,
  WorldSnapshotDocument,
} from "./model-gateway.js";
import type { PostgresRuntimeInvocationJournal } from "../adapters/postgres/runtime-invocation-journal.js";
import type {
  CharacterMode,
  DirectorMode,
  PromptMaterializer,
} from "./prompt-materializer.js";
import {
  projectCharacterSubjectiveView,
  projectDialogue,
  projectDirectorWorldView,
  projectKnowledgeView,
  projectObjectiveTraces,
  readDayNumber,
} from "./model-view-projection.js";
import type {
  CommittedEventReader,
  DailySettlementRunRecord,
  StoredModelInvocation,
} from "./runtime-persistence.js";
import type { RuntimeWorldBindingResolver } from "./runtime-world-binding.js";

export interface RuntimeModelFacades {
  directorDailySettlement(input: {
    readonly worldId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt>;
}

export function createRuntimeModelFacades(input: {
  readonly digest: JsonDigest;
  readonly worldBindingResolver: RuntimeWorldBindingResolver;
  readonly materializer: PromptMaterializer;
  readonly modelGateway: ModelGateway;
  readonly journal: PostgresRuntimeInvocationJournal;
  readonly events: CommittedEventReader;
}): RuntimeModelFacades {
  const assembly = new ModelRequestAssembly({
    digest: input.digest,
    worldBindingResolver: input.worldBindingResolver,
    modelGateway: input.modelGateway,
    journal: input.journal,
    materializer: input.materializer,
    events: input.events,
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
  readonly #worldBindingResolver: RuntimeWorldBindingResolver;
  readonly #modelGateway: ModelGateway;
  readonly #journal: PostgresRuntimeInvocationJournal;
  readonly #materializer: PromptMaterializer;
  readonly #events: CommittedEventReader;

  public constructor(input: {
    readonly digest: JsonDigest;
    readonly worldBindingResolver: RuntimeWorldBindingResolver;
    readonly modelGateway: ModelGateway;
    readonly journal: PostgresRuntimeInvocationJournal;
    readonly materializer: PromptMaterializer;
    readonly events: CommittedEventReader;
  }) {
    this.#digest = input.digest;
    this.#worldBindingResolver = input.worldBindingResolver;
    this.#modelGateway = input.modelGateway;
    this.#journal = input.journal;
    this.#materializer = input.materializer;
    this.#events = input.events;
  }

  public async directorDailySettlement(input: {
    readonly worldId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const snapshot = worldBinding.record.snapshot;
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const day = readDayNumber(worldState);
    const materialized = this.#materializer.materializeDirector({
      contentBinding: worldBinding.contentBinding,
      mode: "daily_settlement",
    });
    const storedRun = await this.#journal.read(input.worldId, day);
    if (storedRun !== undefined) {
      assertStoredDirectorDailyIdentity(storedRun, input);
      const prepared = this.#modelGateway.prepare(
        Object.freeze({ snapshot: storedRun.invocation.snapshot }),
        storedRun.invocation.request.value,
        Object.freeze({
          prompt_blocks: materialized.ordered_blocks,
          event_context: materialized.event_context,
        }),
      );
      return continueModelFromStored({
        modelGateway: this.#modelGateway,
        journal: this.#journal,
        prepared,
        stored: storedRun.invocation,
        requestId: storedRun.invocation.requestId,
        dailyRunId: storedRun.runId,
      });
    }

    assertDayCyclePhase(worldState, "director_settlement");
    const currentRevision = expectIntegerSafe(
      snapshot.value,
      "world_revision",
    );
    const committedEvents = await this.#events.readRevisionRange({
      worldId: input.worldId,
      afterRevisionExclusive:
        worldBinding.record.eventHistoryFloorRevision,
      throughRevisionInclusive: currentRevision,
    });
    const dynamicInput = Object.freeze({
      world_view: projectDirectorWorldView(worldState, day),
      objective_traces: projectObjectiveTraces({
        events: committedEvents,
        currentDay: day,
        createTraceId: randomUUID,
      }),
    });
    return this.#invoke({
      snapshot,
      requestKind: "director.daily_settlement",
      modelProfileId: input.model_profile_id,
      residentContext: materialized.resident_context,
      promptBlocks: materialized.ordered_blocks,
      eventContext: materialized.event_context,
      dynamicInput,
    });
  }

  public async directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "dialogue_events",
      input,
      async (ctx) => {
        const day = readDayNumber(ctx.worldState);
        return Object.freeze({
          world_view: projectDirectorWorldView(ctx.worldState, day),
          dialogue: projectDialogue(ctx.worldState, input.dialogueId),
        });
      },
    );
  }

  public async directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "system_dialogue",
      input,
      async (ctx) => {
        const day = readDayNumber(ctx.worldState);
        return Object.freeze({
          world_view: projectDirectorWorldView(ctx.worldState, day),
          knowledge_view: projectKnowledgeView(
            ctx.worldState,
            input.playerEntityId,
          ),
          dialogue: projectDialogue(ctx.worldState, input.dialogueId),
        });
      },
    );
  }

  public characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#characterDialogue(input);
  }

  async #characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    const stored = await this.#journal.readByRequestId(input.requestId);
    if (stored !== undefined) {
      return this.#recoverCharacterDialogue(input, stored);
    }
    try {
      return await this.#runCharacter("dialogue", input, async (ctx) =>
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
    } catch (error: unknown) {
      if (
        !(error instanceof EngineFault) ||
        error.code !== "model.invocation.identity_conflict"
      ) {
        throw error;
      }
      const raced = await this.#journal.readByRequestId(input.requestId);
      if (raced === undefined) {
        throw error;
      }
      return this.#recoverCharacterDialogue(input, raced);
    }
  }

  async #recoverCharacterDialogue(
    input: {
      readonly worldId: string;
      readonly entityId: string;
      readonly dialogueId: string;
      readonly latestPlayerTurnId: string;
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    stored: StoredModelInvocation,
  ): Promise<VerifiedModelInvocationReceipt> {
    assertStoredCharacterDialogueIdentity(stored, input);
    if (stored.phase === "verified") {
      const recovered = await this.#journal.recoverVerifiedByRequestId(
        input.requestId,
      );
      if (recovered === undefined) {
        throw new EngineFault(
          "model.assembly.verified_receipt_missing",
          "Verified character dialogue invocation could not be recovered",
          { request_id: input.requestId },
        );
      }
      return recovered;
    }
    if (stored.phase === "dispatched_ambiguous") {
      throw new EngineFault(
        "runtime.kernel.model_dispatch_ambiguous",
        "Character dialogue model invocation was dispatched without a verified receipt; execution is blocked",
        {
          request_id: input.requestId,
          request_kind: stored.requestKind,
          world_id: stored.worldId,
          world_revision: stored.worldRevision,
        },
      );
    }

    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const materialized = this.#materializer.materializeCharacter({
      contentBinding: worldBinding.contentBinding,
      runtimeWorldId: input.worldId,
      entityId: input.entityId,
      mode: "dialogue",
    });
    const prepared = this.#modelGateway.prepare(
      Object.freeze({ snapshot: stored.snapshot }),
      stored.request.value,
      Object.freeze({
        prompt_blocks: materialized.ordered_blocks,
      }),
    );
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId: input.requestId,
      dailyRunId: undefined,
    });
  }

  public async characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    if (input.events.length === 0) {
      throw new EngineFault(
        "model.assembly.react_events_empty",
        "character.react requires at least one CharacterEventStimulus from committed authority",
        { entity_id: input.entityId },
      );
    }
    const stored = await this.#journal.readByRequestId(input.requestId);
    if (stored !== undefined) {
      return this.#recoverCharacterReact(input, stored);
    }
    try {
      return await this.#runCharacter("react", input, async (ctx) =>
        Object.freeze({
          subjective_view: projectCharacterSubjectiveView(
            input.worldId,
            ctx.worldState,
            input.entityId,
          ),
          events: Object.freeze([...input.events]),
        }),
      );
    } catch (error: unknown) {
      if (
        !(error instanceof EngineFault) ||
        error.code !== "model.invocation.identity_conflict"
      ) {
        throw error;
      }
      const raced = await this.#journal.readByRequestId(input.requestId);
      if (raced === undefined) {
        throw error;
      }
      return this.#recoverCharacterReact(input, raced);
    }
  }

  async #recoverCharacterReact(
    input: {
      readonly worldId: string;
      readonly entityId: string;
      readonly events: readonly JsonObject[];
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    stored: StoredModelInvocation,
  ): Promise<VerifiedModelInvocationReceipt> {
    assertStoredCharacterReactIdentity(stored, input);
    if (stored.phase === "verified") {
      const recovered = await this.#journal.recoverVerifiedByRequestId(
        input.requestId,
      );
      if (recovered === undefined) {
        throw new EngineFault(
          "model.assembly.verified_receipt_missing",
          "Verified character reaction invocation could not be recovered",
          { request_id: input.requestId },
        );
      }
      return recovered;
    }
    if (stored.phase === "dispatched_ambiguous") {
      throw new EngineFault(
        "runtime.kernel.model_dispatch_ambiguous",
        "Character reaction model invocation was dispatched without a verified receipt; execution is blocked",
        {
          request_id: input.requestId,
          request_kind: stored.requestKind,
          world_id: stored.worldId,
          world_revision: stored.worldRevision,
        },
      );
    }

    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const materialized = this.#materializer.materializeCharacter({
      contentBinding: worldBinding.contentBinding,
      runtimeWorldId: input.worldId,
      entityId: input.entityId,
      mode: "react",
    });
    const prepared = this.#modelGateway.prepare(
      Object.freeze({ snapshot: stored.snapshot }),
      stored.request.value,
      Object.freeze({
        prompt_blocks: materialized.ordered_blocks,
      }),
    );
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId: input.requestId,
      dailyRunId: undefined,
    });
  }

  async #directorDialogueInvocation(
    mode: "dialogue_events" | "system_dialogue",
    input: {
      readonly worldId: string;
      readonly dialogueId: string;
      readonly playerEntityId?: string;
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
    }) => Promise<JsonObject>,
  ): Promise<VerifiedModelInvocationReceipt> {
    const stored = await this.#journal.readByRequestId(input.requestId);
    if (stored !== undefined) {
      return this.#recoverDirectorDialogue(mode, input, stored);
    }
    try {
      return await this.#runDirector(mode, input, buildInput);
    } catch (error: unknown) {
      if (
        !(error instanceof EngineFault) ||
        error.code !== "model.invocation.identity_conflict"
      ) {
        throw error;
      }
      const raced = await this.#journal.readByRequestId(input.requestId);
      if (raced === undefined) {
        throw error;
      }
      return this.#recoverDirectorDialogue(mode, input, raced);
    }
  }

  async #recoverDirectorDialogue(
    mode: "dialogue_events" | "system_dialogue",
    input: {
      readonly worldId: string;
      readonly dialogueId: string;
      readonly playerEntityId?: string;
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    stored: StoredModelInvocation,
  ): Promise<VerifiedModelInvocationReceipt> {
    assertStoredDirectorDialogueIdentity(stored, mode, input);
    if (stored.phase === "verified") {
      const recovered = await this.#journal.recoverVerifiedByRequestId(
        input.requestId,
      );
      if (recovered === undefined) {
        throw new EngineFault(
          "model.assembly.verified_receipt_missing",
          "Verified Director dialogue invocation could not be recovered",
          { request_id: input.requestId },
        );
      }
      return recovered;
    }
    if (stored.phase === "dispatched_ambiguous") {
      throw new EngineFault(
        "runtime.kernel.model_dispatch_ambiguous",
        "Director dialogue model invocation was dispatched without a verified receipt; execution is blocked",
        {
          request_id: input.requestId,
          request_kind: stored.requestKind,
          world_id: stored.worldId,
          world_revision: stored.worldRevision,
        },
      );
    }

    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const materialized = this.#materializer.materializeDirector({
      contentBinding: worldBinding.contentBinding,
      mode,
    });
    const prepared = this.#modelGateway.prepare(
      Object.freeze({ snapshot: stored.snapshot }),
      stored.request.value,
      Object.freeze({
        prompt_blocks: materialized.ordered_blocks,
        event_context: materialized.event_context,
      }),
    );
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId: input.requestId,
      dailyRunId: undefined,
    });
  }

  async #runDirector(
    mode: DirectorMode,
    input: {
      readonly worldId: string;
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
    }) => Promise<JsonObject>,
  ): Promise<VerifiedModelInvocationReceipt> {
    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const snapshot = worldBinding.record.snapshot;
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dynamicInput = await buildInput({ worldState, snapshot });
    const materialized = this.#materializer.materializeDirector({
      contentBinding: worldBinding.contentBinding,
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
      requestId: input.requestId,
    });
  }

  async #runCharacter(
    mode: CharacterMode,
    input: {
      readonly worldId: string;
      readonly entityId: string;
      readonly requestId?: string;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
    }) => Promise<JsonObject>,
  ): Promise<VerifiedModelInvocationReceipt> {
    const worldBinding = await this.#worldBindingResolver.resolveCurrent(
      input.worldId,
    );
    const snapshot = worldBinding.record.snapshot;
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const dynamicInput = await buildInput({ worldState, snapshot });
    const materialized = this.#materializer.materializeCharacter({
      contentBinding: worldBinding.contentBinding,
      runtimeWorldId: expectString(
        snapshot.value,
        "world_id",
        "WorldSnapshot",
      ),
      entityId: input.entityId,
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
      ...(input.requestId === undefined
        ? {}
        : { requestId: input.requestId }),
    });
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
    readonly requestId?: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    const basisRevision = expectIntegerSafe(
      input.snapshot.value,
      "world_revision",
    );
    const dynamic_input_digest = this.#digest.sha256(input.dynamicInput);
    const candidate = Object.freeze({
      contract_version: "model-protocol.v1",
      record_type: "model.request",
      request_id: input.requestId ?? randomUUID(),
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
      try {
        const receipt =
          await input.modelGateway.invokePrepared(authorization);
        if (input.dailyRunId === undefined) {
          await input.journal.recordVerified(receipt);
        } else {
          await input.journal.recordDirectorVerified(
            input.dailyRunId,
            receipt,
          );
        }
        return receipt;
      } catch (error: unknown) {
        if (
          error instanceof EngineFault &&
          error.code === "runtime.kernel.model_dispatch_ambiguous"
        ) {
          throw error;
        }
        throw new EngineFault(
          "runtime.kernel.model_dispatch_ambiguous",
          "Model invocation was dispatched but no verified durable receipt was recorded; execution is blocked",
          {
            request_id: input.requestId,
            request_kind: input.stored.requestKind,
            world_id: input.stored.worldId,
            world_revision: input.stored.worldRevision,
            failure_code:
              error instanceof EngineFault
                ? error.code
                : "model.dispatch.unknown_failure",
            ...(error instanceof EngineFault &&
            error.details !== undefined
              ? { failure_details: error.details }
              : {}),
          },
        );
      }
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

function assertStoredCharacterDialogueIdentity(
  stored: StoredModelInvocation,
  input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  },
): void {
  const request = stored.request.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const subjectiveView = expectJsonObject(
    expectProperty(
      dynamicInput,
      "subjective_view",
      "CharacterDialogueInput",
    ),
    "CharacterDialogueInput.subjective_view",
  );
  const character = expectJsonObject(
    expectProperty(
      subjectiveView,
      "character",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.character",
  );
  const dialogue = expectJsonObject(
    expectProperty(dynamicInput, "dialogue", "CharacterDialogueInput"),
    "CharacterDialogueInput.dialogue",
  );
  const mismatched =
    stored.requestId !== input.requestId ||
    stored.worldId !== input.worldId ||
    stored.requestKind !== "character.dialogue" ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      input.model_profile_id ||
    expectString(character, "world_id", "EntityRef") !== input.worldId ||
    expectString(character, "entity_id", "EntityRef") !== input.entityId ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      input.dialogueId ||
    expectString(
      dynamicInput,
      "latest_player_turn_id",
      "CharacterDialogueInput",
    ) !== input.latestPlayerTurnId;
  if (mismatched) {
    throw new EngineFault(
      "model.assembly.command_identity_conflict",
      "Persisted character dialogue invocation differs from its Command Journal identity",
      {
        request_id: input.requestId,
        world_id: input.worldId,
        entity_id: input.entityId,
        dialogue_id: input.dialogueId,
        latest_player_turn_id: input.latestPlayerTurnId,
      },
    );
  }
}

function assertStoredDirectorDailyIdentity(
  stored: DailySettlementRunRecord,
  input: {
    readonly worldId: string;
    readonly model_profile_id: string;
  },
): void {
  const request = stored.invocation.request.value;
  if (
    stored.worldId !== input.worldId ||
    stored.invocation.worldId !== input.worldId ||
    stored.invocation.requestKind !== "director.daily_settlement" ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      input.model_profile_id
  ) {
    throw new EngineFault(
      "model.assembly.daily_identity_conflict",
      "Persisted Director daily settlement differs from its world/day deployment identity",
      {
        world_id: input.worldId,
        day: stored.day,
        request_id: stored.invocation.requestId,
        model_profile_id: input.model_profile_id,
      },
    );
  }
}

function assertStoredDirectorDialogueIdentity(
  stored: StoredModelInvocation,
  mode: "dialogue_events" | "system_dialogue",
  input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId?: string;
    readonly requestId: string;
    readonly model_profile_id: string;
  },
): void {
  const request = stored.request.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const dialogue = expectJsonObject(
    expectProperty(dynamicInput, "dialogue", "DirectorDialogueInput"),
    "DirectorDialogueInput.dialogue",
  );
  const expectedKind =
    mode === "dialogue_events"
      ? "director.dialogue_events"
      : "director.system_dialogue";
  let playerIdentityMatches = true;
  if (mode === "system_dialogue") {
    const knowledgeView = expectJsonObject(
      expectProperty(
        dynamicInput,
        "knowledge_view",
        "DirectorSystemDialogueInput",
      ),
      "DirectorSystemDialogueInput.knowledge_view",
    );
    playerIdentityMatches =
      input.playerEntityId !== undefined &&
      expectString(
        knowledgeView,
        "viewer_entity_id",
        "KnowledgeView",
      ) === input.playerEntityId;
  }
  if (
    stored.requestId !== input.requestId ||
    stored.worldId !== input.worldId ||
    stored.requestKind !== expectedKind ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      input.model_profile_id ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      input.dialogueId ||
    !playerIdentityMatches
  ) {
    throw new EngineFault(
      "model.assembly.director_dialogue_identity_conflict",
      "Persisted Director dialogue invocation differs from its command-owned identity",
      {
        request_id: input.requestId,
        request_kind: expectedKind,
        world_id: input.worldId,
        dialogue_id: input.dialogueId,
        player_entity_id: input.playerEntityId ?? null,
      },
    );
  }
}

function assertStoredCharacterReactIdentity(
  stored: StoredModelInvocation,
  input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
    readonly model_profile_id: string;
  },
): void {
  const request = stored.request.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const subjectiveView = expectJsonObject(
    expectProperty(dynamicInput, "subjective_view", "CharacterReactInput"),
    "CharacterReactInput.subjective_view",
  );
  const character = expectJsonObject(
    expectProperty(
      subjectiveView,
      "character",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.character",
  );
  if (
    stored.requestId !== input.requestId ||
    stored.worldId !== input.worldId ||
    stored.requestKind !== "character.react" ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      input.model_profile_id ||
    expectString(character, "world_id", "EntityRef") !== input.worldId ||
    expectString(character, "entity_id", "EntityRef") !== input.entityId ||
    !jsonEquals(
      expectProperty(dynamicInput, "events", "CharacterReactInput"),
      input.events as unknown as import("@luoxia/contracts-runtime").JsonValue,
    )
  ) {
    throw new EngineFault(
      "model.assembly.character_react_identity_conflict",
      "Persisted character reaction invocation differs from its day-cycle identity",
      {
        request_id: input.requestId,
        world_id: input.worldId,
        entity_id: input.entityId,
      },
    );
  }
}

function assertDayCyclePhase(
  worldState: JsonObject,
  expectedPhase: string,
): void {
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const actualPhase = expectString(dayCycle, "phase", "DayCycleState");
  if (actualPhase !== expectedPhase) {
    throw new EngineFault(
      "model.assembly.day_cycle_phase_invalid",
      "Director daily settlement can run only during director_settlement phase",
      {
        expected_phase: expectedPhase,
        actual_phase: actualPhase,
      },
    );
  }
}
