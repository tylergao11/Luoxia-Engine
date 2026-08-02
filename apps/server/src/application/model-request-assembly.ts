import { randomUUID } from "node:crypto";

import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonDigest,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  StateMachineContractAuthority,
  WorldContentBinding,
} from "@luoxia/world-core";

import type {
  ModelGateway,
  VerifiedModelInvocationReceipt,
  WorldSnapshotDocument,
} from "./model-gateway.js";
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
  resolveDaySettlementKeepEntityIds,
} from "./model-view-projection.js";
import type {
  CommittedEventReader,
  DailySettlementRunRecord,
  RuntimeModelInvocationJournal,
  StoredModelInvocation,
} from "./runtime-persistence.js";
import type { RuntimeWorldBindingResolver } from "./runtime-world-binding.js";

export interface RuntimeModelFacades {
  directorDailySettlement(input: {
    readonly worldId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorGoalPlan(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  directorDefinitionDraft(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly purpose: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterDialogue(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;

  characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly day: number;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt>;
}

export function createRuntimeModelFacades(input: {
  readonly digest: JsonDigest;
  readonly worldBindingResolver: RuntimeWorldBindingResolver;
  readonly materializer: PromptMaterializer;
  readonly modelGateway: ModelGateway;
  readonly journal: RuntimeModelInvocationJournal;
  readonly events: CommittedEventReader;
  readonly stateMachineContracts: StateMachineContractAuthority;
  readonly directorDailySettlementModelProfileId: string;
  readonly directorDialogueEventsModelProfileId: string;
  readonly directorSystemDialogueModelProfileId: string;
  readonly directorGoalPlanModelProfileId: string;
  readonly directorDefinitionDraftModelProfileId: string;
  readonly characterDialogueModelProfileId: string;
  readonly characterReactModelProfileId: string;
}): RuntimeModelFacades {
  const assembly = new ModelRequestAssembly({
    digest: input.digest,
    worldBindingResolver: input.worldBindingResolver,
    modelGateway: input.modelGateway,
    journal: input.journal,
    materializer: input.materializer,
    events: input.events,
    stateMachineContracts: input.stateMachineContracts,
    directorDailySettlementModelProfileId:
      input.directorDailySettlementModelProfileId,
    directorDialogueEventsModelProfileId:
      input.directorDialogueEventsModelProfileId,
    directorSystemDialogueModelProfileId:
      input.directorSystemDialogueModelProfileId,
    directorGoalPlanModelProfileId:
      input.directorGoalPlanModelProfileId,
    directorDefinitionDraftModelProfileId:
      input.directorDefinitionDraftModelProfileId,
    characterDialogueModelProfileId:
      input.characterDialogueModelProfileId,
    characterReactModelProfileId:
      input.characterReactModelProfileId,
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
    directorGoalPlan: (
      args: Parameters<RuntimeModelFacades["directorGoalPlan"]>[0],
    ) => assembly.directorGoalPlan(args),
    directorDefinitionDraft: (
      args: Parameters<RuntimeModelFacades["directorDefinitionDraft"]>[0],
    ) => assembly.directorDefinitionDraft(args),
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
  readonly #journal: RuntimeModelInvocationJournal;
  readonly #materializer: PromptMaterializer;
  readonly #events: CommittedEventReader;
  readonly #stateMachineContracts: StateMachineContractAuthority;
  readonly #directorDailySettlementModelProfileId: string;
  readonly #directorDialogueEventsModelProfileId: string;
  readonly #directorSystemDialogueModelProfileId: string;
  readonly #directorGoalPlanModelProfileId: string;
  readonly #directorDefinitionDraftModelProfileId: string;
  readonly #characterDialogueModelProfileId: string;
  readonly #characterReactModelProfileId: string;

  public constructor(input: {
    readonly digest: JsonDigest;
    readonly worldBindingResolver: RuntimeWorldBindingResolver;
    readonly modelGateway: ModelGateway;
    readonly journal: RuntimeModelInvocationJournal;
    readonly materializer: PromptMaterializer;
    readonly events: CommittedEventReader;
    readonly stateMachineContracts: StateMachineContractAuthority;
    readonly directorDailySettlementModelProfileId: string;
    readonly directorDialogueEventsModelProfileId: string;
    readonly directorSystemDialogueModelProfileId: string;
    readonly directorGoalPlanModelProfileId: string;
    readonly directorDefinitionDraftModelProfileId: string;
    readonly characterDialogueModelProfileId: string;
    readonly characterReactModelProfileId: string;
  }) {
    this.#digest = input.digest;
    this.#worldBindingResolver = input.worldBindingResolver;
    this.#modelGateway = input.modelGateway;
    this.#journal = input.journal;
    this.#materializer = input.materializer;
    this.#events = input.events;
    this.#stateMachineContracts = input.stateMachineContracts;
    this.#directorDailySettlementModelProfileId =
      input.directorDailySettlementModelProfileId;
    this.#directorDialogueEventsModelProfileId =
      input.directorDialogueEventsModelProfileId;
    this.#directorSystemDialogueModelProfileId =
      input.directorSystemDialogueModelProfileId;
    this.#directorGoalPlanModelProfileId =
      input.directorGoalPlanModelProfileId;
    this.#directorDefinitionDraftModelProfileId =
      input.directorDefinitionDraftModelProfileId;
    this.#characterDialogueModelProfileId =
      input.characterDialogueModelProfileId;
    this.#characterReactModelProfileId =
      input.characterReactModelProfileId;
  }

  public async directorDailySettlement(input: {
    readonly worldId: string;
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
      assertStoredDirectorDailyIdentity(
        storedRun,
        input,
        this.#directorDailySettlementModelProfileId,
      );
      const prepared = this.#modelGateway.prepare(
        Object.freeze({ snapshot: storedRun.invocation.snapshot }),
        storedRun.invocation.request.value,
        Object.freeze({
          prompt_blocks: materialized.ordered_blocks,
        }),
      );
      return continueModelFromStored({
        modelGateway: this.#modelGateway,
        journal: this.#journal,
        prepared,
        stored: storedRun.invocation,
        requestId: storedRun.invocation.requestId,
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
    const objectiveTraces = projectObjectiveTraces({
      events: committedEvents,
      currentDay: day,
    });
    const dynamicInput = Object.freeze({
      world_view: projectDirectorWorldView(
        input.worldId,
        worldState,
        day,
        worldBinding.contentBinding,
        this.#stateMachineContracts,
        Object.freeze({
          mode: "day_settlement",
          keepEntityIds: resolveDaySettlementKeepEntityIds(
            worldState,
            objectiveTraces,
          ),
        }),
      ),
      objective_traces: objectiveTraces,
    });
    return this.#invoke({
      snapshot,
      requestKind: "director.daily_settlement",
      modelProfileId: this.#directorDailySettlementModelProfileId,
      residentContext: materialized.resident_context,
      promptBlocks: materialized.ordered_blocks,
      dynamicInput,
    });
  }

  public async directorDialogueEvents(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "dialogue_events",
      Object.freeze({
        ...input,
        model_profile_id: this.#directorDialogueEventsModelProfileId,
      }),
      async (ctx) => {
        const day = readDayNumber(ctx.worldState);
        const dialogue = projectDialogue(
          ctx.worldState,
          input.dialogueId,
        );
        return Object.freeze({
          world_view: projectDirectorWorldView(
            input.worldId,
            ctx.worldState,
            day,
            ctx.contentBinding,
            this.#stateMachineContracts,
            Object.freeze({ mode: "dialogue_related", dialogue }),
          ),
          dialogue,
          response_locale: readDialogueTurnLocale(
            dialogue,
            input.latestPlayerTurnId,
          ),
        });
      },
    );
  }

  public async directorSystemDialogue(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "system_dialogue",
      Object.freeze({
        ...input,
        model_profile_id: this.#directorSystemDialogueModelProfileId,
      }),
      async (ctx) => {
        const dialogue = projectDialogue(ctx.worldState, input.dialogueId);
        return Object.freeze({
          knowledge_view: projectKnowledgeView(
            ctx.worldState,
            input.playerEntityId,
          ),
          dialogue,
          response_locale: readDialogueTurnLocale(
            dialogue,
            input.latestPlayerTurnId,
          ),
        });
      },
    );
  }

  public async directorGoalPlan(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "goal_plan",
      Object.freeze({
        ...input,
        model_profile_id: this.#directorGoalPlanModelProfileId,
      }),
      async (ctx) => {
        const dialogue = projectDialogue(ctx.worldState, input.dialogueId);
        return Object.freeze({
          world_view: projectDirectorWorldView(
            input.worldId,
            ctx.worldState,
            readDayNumber(ctx.worldState),
            ctx.contentBinding,
            this.#stateMachineContracts,
            Object.freeze({ mode: "dialogue_related", dialogue }),
          ),
          knowledge_view: projectKnowledgeView(
            ctx.worldState,
            input.playerEntityId,
          ),
          dialogue,
          response_locale: readDialogueTurnLocale(
            dialogue,
            input.latestPlayerTurnId,
          ),
        });
      },
    );
  }

  public async directorDefinitionDraft(input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId: string;
    readonly latestPlayerTurnId: string;
    readonly purpose: string;
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#directorDialogueInvocation(
      "definition_draft",
      Object.freeze({
        ...input,
        model_profile_id: this.#directorDefinitionDraftModelProfileId,
      }),
      async (ctx) => {
        const dialogue = projectDialogue(ctx.worldState, input.dialogueId);
        return Object.freeze({
          knowledge_view: projectKnowledgeView(
            ctx.worldState,
            input.playerEntityId,
          ),
          dialogue,
          response_locale: readDialogueTurnLocale(
            dialogue,
            input.latestPlayerTurnId,
          ),
          purpose: input.purpose,
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
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#characterDialogue(
      Object.freeze({
        ...input,
        model_profile_id: this.#characterDialogueModelProfileId,
      }),
    );
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
        {
          const dialogue = projectDialogue(ctx.worldState, input.dialogueId);
          return Object.freeze({
            subjective_view: projectCharacterSubjectiveView(
              input.worldId,
              ctx.worldState,
              input.entityId,
              ctx.contentBinding,
              this.#stateMachineContracts,
            ),
            dialogue,
            response_locale: readDialogueTurnLocale(
              dialogue,
              input.latestPlayerTurnId,
            ),
          });
        },
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
    });
  }

  public async characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly day: number;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    return this.#characterReact(
      Object.freeze({
        ...input,
        model_profile_id: this.#characterReactModelProfileId,
      }),
    );
  }

  async #characterReact(input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly day: number;
    readonly events: readonly JsonObject[];
    readonly requestId: string;
    readonly model_profile_id: string;
  }): Promise<VerifiedModelInvocationReceipt> {
    if (input.events.length === 0) {
      throw new EngineFault(
        "model.assembly.react_events_empty",
        "character.react requires at least one locally materialized CharacterReactEventInput",
        { entity_id: input.entityId },
      );
    }
    const stored = await this.#journal.readByRequestId(input.requestId);
    if (stored !== undefined) {
      return this.#recoverCharacterReact(input, stored);
    }
    try {
      return await this.#runCharacter("react", input, async (ctx) => {
        const authoritativeDay = readDayNumber(ctx.worldState);
        if (authoritativeDay !== input.day) {
          throw new EngineFault(
            "model.assembly.character_react_day_mismatch",
            "Character reaction request day differs from its locked WorldState",
            {
              requested_day: input.day,
              authoritative_day: authoritativeDay,
              world_id: input.worldId,
              entity_id: input.entityId,
            },
          );
        }
        return Object.freeze({
          subjective_view: projectCharacterSubjectiveView(
            input.worldId,
            ctx.worldState,
            input.entityId,
            ctx.contentBinding,
            this.#stateMachineContracts,
          ),
          day: authoritativeDay,
          events: Object.freeze([...input.events]),
        });
      });
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
      readonly day: number;
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
    });
  }

  async #directorDialogueInvocation(
    mode:
      | "dialogue_events"
      | "system_dialogue"
      | "goal_plan"
      | "definition_draft",
    input: {
      readonly worldId: string;
      readonly dialogueId: string;
      readonly playerEntityId?: string;
      readonly latestPlayerTurnId?: string;
      readonly purpose?: string;
      readonly requestId: string;
      readonly model_profile_id: string;
    },
    buildInput: (ctx: {
      readonly worldState: JsonObject;
      readonly snapshot: WorldSnapshotDocument;
      readonly contentBinding: WorldContentBinding;
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
    mode:
      | "dialogue_events"
      | "system_dialogue"
      | "goal_plan"
      | "definition_draft",
    input: {
      readonly worldId: string;
      readonly dialogueId: string;
      readonly playerEntityId?: string;
      readonly latestPlayerTurnId?: string;
      readonly purpose?: string;
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
      }),
    );
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId: input.requestId,
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
      readonly contentBinding: WorldContentBinding;
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
    const dynamicInput = await buildInput({
      worldState,
      snapshot,
      contentBinding: worldBinding.contentBinding,
    });
    const materialized = this.#materializer.materializeDirector({
      contentBinding: worldBinding.contentBinding,
      mode,
    });
    const requestKind = directorRequestKind(mode);
    return this.#invoke({
      snapshot,
      requestKind,
      modelProfileId: input.model_profile_id,
      residentContext: materialized.resident_context,
      promptBlocks: materialized.ordered_blocks,
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
      readonly contentBinding: WorldContentBinding;
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
    const dynamicInput = await buildInput({
      worldState,
      snapshot,
      contentBinding: worldBinding.contentBinding,
    });
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

    const prepared = this.#modelGateway.prepare(
      Object.freeze({ snapshot: input.snapshot }),
      candidate,
      Object.freeze({ prompt_blocks: input.promptBlocks }),
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
      });
    }

    const stored = await this.#journal.persistPrepared(prepared);
    return continueModelFromStored({
      modelGateway: this.#modelGateway,
      journal: this.#journal,
      prepared,
      stored,
      requestId,
    });
  }
}

async function continueModelFromStored(input: {
  readonly modelGateway: ModelGateway;
  readonly journal: RuntimeModelInvocationJournal;
  readonly prepared: ReturnType<ModelGateway["prepare"]>;
  readonly stored: StoredModelInvocation;
  readonly requestId: string;
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
      const authorization = (
        await input.journal.markDispatched(input.prepared)
      ).authorization;
      try {
        const completion =
          await input.modelGateway.invokePrepared(authorization);
        await input.journal.recordVerified(
          completion.receipt,
          completion.usage,
        );
        return completion.receipt;
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

function readDialogueTurnLocale(
  dialogue: JsonObject,
  turnId: string,
): string {
  const turnsValue = expectProperty(dialogue, "turns", "DialogueRecord");
  if (!Array.isArray(turnsValue)) {
    throw new EngineFault(
      "model.assembly.dialogue_turns_shape",
      "DialogueRecord.turns must be an array",
      { turn_id: turnId },
    );
  }
  const matches = turnsValue
    .map((entry, index) =>
      expectJsonObject(entry as never, `DialogueRecord.turns[${index}]`),
    )
    .filter(
      (turn) => expectString(turn, "turn_id", "DialogueTurn") === turnId,
    );
  if (matches.length !== 1) {
    throw new EngineFault(
      "model.assembly.player_turn_identity_invalid",
      "The command-owned player turn must resolve exactly once in the locked dialogue",
      { turn_id: turnId, matches: matches.length },
    );
  }
  const turn = matches[0] as JsonObject;
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (expectString(source, "source_kind", "DialogueTurnSource") !== "human") {
    throw new EngineFault(
      "model.assembly.player_turn_source_invalid",
      "The response locale must come from the exact human turn",
      { turn_id: turnId },
    );
  }
  return expectString(turn, "locale", "DialogueTurn");
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
      "response_locale",
      "CharacterDialogueInput",
    ) !== readDialogueTurnLocale(dialogue, input.latestPlayerTurnId);
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
  },
  expectedModelProfileId: string,
): void {
  const request = stored.invocation.request.value;
  if (
    stored.worldId !== input.worldId ||
    stored.invocation.worldId !== input.worldId ||
    stored.invocation.requestKind !== "director.daily_settlement" ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      expectedModelProfileId
  ) {
    throw new EngineFault(
      "model.assembly.daily_identity_conflict",
      "Persisted Director daily settlement differs from its world/day deployment identity",
      {
        world_id: input.worldId,
        day: stored.day,
        request_id: stored.invocation.requestId,
        model_profile_id: expectedModelProfileId,
      },
    );
  }
}

function assertStoredDirectorDialogueIdentity(
  stored: StoredModelInvocation,
  mode:
    | "dialogue_events"
    | "system_dialogue"
    | "goal_plan"
    | "definition_draft",
  input: {
    readonly worldId: string;
    readonly dialogueId: string;
    readonly playerEntityId?: string;
    readonly latestPlayerTurnId?: string;
    readonly purpose?: string;
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
  const expectedKind = directorRequestKind(mode);
  let playerIdentityMatches = true;
  if (mode === "dialogue_events") {
    playerIdentityMatches =
      input.latestPlayerTurnId !== undefined &&
      expectString(
        dynamicInput,
        "response_locale",
        "DirectorDialogueEventsInput",
      ) === readDialogueTurnLocale(dialogue, input.latestPlayerTurnId);
  } else {
    const knowledgeView = expectJsonObject(
      expectProperty(
        dynamicInput,
        "knowledge_view",
        "Director dialogue interaction input",
      ),
      "Director dialogue interaction input.knowledge_view",
    );
    playerIdentityMatches =
      input.playerEntityId !== undefined &&
      input.latestPlayerTurnId !== undefined &&
      expectString(
        knowledgeView,
        "viewer_entity_id",
        "KnowledgeView",
      ) === input.playerEntityId &&
      expectString(
        dynamicInput,
        "response_locale",
        "Director dialogue interaction input",
      ) === readDialogueTurnLocale(dialogue, input.latestPlayerTurnId);
  }
  const purposeMatches =
    mode !== "definition_draft" ||
    (input.purpose !== undefined &&
      expectString(
        dynamicInput,
        "purpose",
        "DirectorDefinitionDraftInput",
      ) === input.purpose);
  if (
    stored.requestId !== input.requestId ||
    stored.worldId !== input.worldId ||
    stored.requestKind !== expectedKind ||
    expectString(request, "model_profile_id", "ModelRequest") !==
      input.model_profile_id ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      input.dialogueId ||
    !playerIdentityMatches ||
    !purposeMatches
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

function directorRequestKind(mode: DirectorMode): string {
  switch (mode) {
    case "daily_settlement":
      return "director.daily_settlement";
    case "dialogue_events":
      return "director.dialogue_events";
    case "system_dialogue":
      return "director.system_dialogue";
    case "goal_plan":
      return "director.goal_plan";
    case "definition_draft":
      return "director.definition_draft";
  }
}

function assertStoredCharacterReactIdentity(
  stored: StoredModelInvocation,
  input: {
    readonly worldId: string;
    readonly entityId: string;
    readonly day: number;
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
    expectInteger(dynamicInput, "day", "CharacterReactInput") !== input.day ||
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
