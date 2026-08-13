import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  DeterministicContextAuthority,
  WorldContentBinding,
} from "@luoxia/world-core";

import type { CommandJournal, StoredReceivedCommand } from "./command-journal.js";
import type { CommandFinalizer } from "./command-finalizer.js";
import { materializeAgencyCommitmentsFromCharacterDrafts } from "./dialogue-agency-commitment-materialize.js";
import {
  closeAgencyGateOutcomeLinks,
  effectiveEventCardAgencyGates,
  listDialogueCommitmentSelectors,
  withEffectiveOutcomeSubjects,
} from "./event-card-draft-normalize.js";
import type {
  DialogueDefinitionRunRecord,
  DialogueDirectorRunJournal,
  DialogueDirectorRunRecord,
  DialogueEventCardRunRecord,
  DialogueGoalPlanRunRecord,
} from "./dialogue-director-run.js";
import type { VerifiedModelInvocationReceipt } from "./model-gateway.js";
import type { RuntimeModelFacades } from "./model-request-assembly.js";
import type {
  RulePluginAbiRegistry,
} from "./rule-plugin-abi.js";
import type { VerifiedRulePluginInvocationReceipt } from "./rule-plugin-gateway.js";
import {
  resolveRulePluginInvocationBinding,
  type RuntimeRulePluginInvocationBinding,
} from "./rule-plugin-operation-binding.js";
import type { RulePluginExecutor } from "./rule-plugin-executor.js";
import type {
  RuntimeWorldBinding,
  RuntimeWorldBindingResolver,
} from "./runtime-world-binding.js";
import type { ServerEnvelopeDocument } from "./server-envelope.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

type DialogueOperationKind = "dialogue.open" | "dialogue.turn.append";
type DialogueInteractionKind =
  | "dialogue"
  | "goal_plan"
  | "definition_draft";
type OrchestratedOperationKind =
  | DialogueOperationKind
  | "definition.validate"
  | "goal_plan.validate";

export interface DialogueLocalIdFactory {
  createId(): string;
}

export interface DialogueCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface DialogueCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly catalog: ContentRuntimeCatalog;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly models: RuntimeModelFacades;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
  readonly directorRuns: DialogueDirectorRunJournal;
  readonly localIds: DialogueLocalIdFactory;
}

interface HumanStageContext {
  readonly binding: RuntimeWorldBinding;
  readonly input: JsonObject;
}

type DialogueResponder =
  | {
      readonly responderKind: "character_mind";
      readonly entityId: string;
    }
  | {
      readonly responderKind: "director_system";
    };

type SystemPlanningInvocation =
  | {
      readonly interactionKind: "dialogue";
    }
  | {
      readonly interactionKind: "goal_plan";
      readonly run: DialogueDirectorRunRecord;
      readonly modelReceipt: VerifiedModelInvocationReceipt;
    }
  | {
      readonly interactionKind: "definition_draft";
      readonly run: DialogueDirectorRunRecord;
      readonly modelReceipt: VerifiedModelInvocationReceipt;
    };

export function createDialogueCommandOrchestrator(
  dependencies: DialogueCommandOrchestratorDependencies,
): DialogueCommandOrchestrator {
  return new DefaultDialogueCommandOrchestrator(dependencies);
}

class DefaultDialogueCommandOrchestrator
  implements DialogueCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #catalog: ContentRuntimeCatalog;
  readonly #commands: CommandJournal;
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #models: RuntimeModelFacades;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #finalizer: CommandFinalizer;
  readonly #directorRuns: DialogueDirectorRunJournal;
  readonly #localIds: DialogueLocalIdFactory;

  public constructor(
    dependencies: DialogueCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#catalog = dependencies.catalog;
    this.#commands = dependencies.commands;
    this.#worlds = dependencies.worlds;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#models = dependencies.models;
    this.#mutations = dependencies.mutations;
    this.#finalizer = dependencies.finalizer;
    this.#directorRuns = dependencies.directorRuns;
    this.#localIds = dependencies.localIds;
  }

  public async execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      clientEnvelopeCandidate,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ClientEnvelope"),
      "ClientEnvelope.message",
    );
    const candidateKind = expectString(
      message,
      "type",
      "ClientMessage",
    );
    if (
      candidateKind !== "dialogue.start" &&
      candidateKind !== "dialogue.continue"
    ) {
      throw new EngineFault(
        "dialogue.orchestration.command_kind_invalid",
        "Dialogue orchestrator accepts only dialogue.start or dialogue.continue",
        { command_kind: candidateKind },
      );
    }
    const stored = await this.#commands.receive(envelope.value);
    if (
      stored.commandKind !== "dialogue.start" &&
      stored.commandKind !== "dialogue.continue"
    ) {
      throw new EngineFault(
        "dialogue.orchestration.command_kind_invalid",
        "Dialogue orchestrator accepts only dialogue.start or dialogue.continue",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          command_kind: stored.commandKind,
        },
      );
    }
    if (stored.phase === "completed") {
      const replay = await this.#finalizer.readCompleted(
        stored.session.sessionId,
        stored.commandId,
      );
      if (replay === undefined) {
        throw new EngineFault(
          "dialogue.orchestration.completed_output_missing",
          "Completed dialogue command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    if (stored.dialogueExecution === undefined) {
      throw new EngineFault(
        "dialogue.orchestration.execution_identity_missing",
        "Received dialogue command has no persisted execution identities",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }

    // Token-consuming dialogue requires remaining EventBudget. remaining === 0
    // rejects before any model or RulePlugin side effect (no free Token burn).
    const budgetGate = await this.#readSessionEventBudgetRemaining(stored);
    if (budgetGate === 0) {
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: "dialogue.event_budget.exhausted",
      });
    }

    const humanReceipt = await this.#rulePlugins.executeRecoverable({
      requestId: stored.dialogueExecution.humanRuleRequestId,
      candidateFactory: async () =>
        this.#createHumanRulePluginRequest(stored),
      modelInvocations: [],
    });
    const responder =
      await this.#assertHumanReceiptIdentity(stored, humanReceipt);
    const interactionKind = readDialogueInteractionKind(stored);
    if (humanReceipt.proposal === undefined) {
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: readRejectCode(humanReceipt),
      });
    }
    if (
      responder.responderKind === "character_mind" &&
      interactionKind !== "dialogue"
    ) {
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: "dialogue.interaction_kind_recipient_invalid",
      });
    }
    const humanCommit =
      await this.#mutations.commitRulePluginReceipt(humanReceipt);
    assertCommittedRevision(
      humanCommit.value,
      stored.session.worldRevision + 1,
      stored,
      "human",
    );
    const humanWorldRevision = stored.session.worldRevision + 1;
    if (responder.responderKind === "director_system") {
      return this.#executeSystemResponse({
        command: stored,
        humanWorldRevision,
        interactionKind,
      });
    }
    const recipientEntityId = responder.entityId;

    const modelReceipt = await this.#models.characterDialogue({
      worldId: stored.session.worldId,
      entityId: recipientEntityId,
      dialogueId: stored.dialogueExecution.dialogueId,
      latestPlayerTurnId: stored.dialogueExecution.humanTurnId,
      requestId: stored.dialogueExecution.characterModelRequestId,
    });
    assertCharacterModelReceiptIdentity(
      stored,
      recipientEntityId,
      modelReceipt,
    );

    const characterReceipt =
      await this.#rulePlugins.executeRecoverable({
        requestId: stored.dialogueExecution.characterRuleRequestId,
        candidateFactory: async () =>
          this.#createCharacterRulePluginRequest(
            stored,
            recipientEntityId,
            modelReceipt,
          ),
        modelInvocations: [modelReceipt],
      });
    await this.#assertCharacterReceiptIdentity(
      stored,
      recipientEntityId,
      modelReceipt,
      characterReceipt,
    );
    if (characterReceipt.proposal === undefined) {
      throw new EngineFault(
        "dialogue.orchestration.character_append_rejected",
        "Character turn append was rejected after the human packet committed; command remains blocked for explicit repair",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          request_id:
            stored.dialogueExecution.characterRuleRequestId,
          reject_code: readRejectCode(characterReceipt),
        },
      );
    }
    const characterCommit =
      await this.#mutations.commitRulePluginReceipt(characterReceipt);
    const characterWorldRevision = stored.session.worldRevision + 2;
    assertCommittedRevision(
      characterCommit.value,
      characterWorldRevision,
      stored,
      "character",
    );

    const eventObservation = await this.#observeDialogueEvents({
      command: stored,
      dialogueId: stored.dialogueExecution.dialogueId,
      latestPlayerTurnId: stored.dialogueExecution.humanTurnId,
      expectedBasisRevision: characterWorldRevision,
    });
    const finalWorldRevision = await this.#publishDirectorEventCards({
      command: stored,
      run: eventObservation.run,
      modelReceipt: eventObservation.modelReceipt,
      startingWorldRevision: characterWorldRevision,
    });

    return this.#finalizer.completeDialogueAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision,
      responseTurnId: stored.dialogueExecution.characterTurnId,
    });
  }

  async #executeSystemResponse(input: {
    readonly command: StoredReceivedCommand;
    readonly humanWorldRevision: number;
    readonly interactionKind: DialogueInteractionKind;
  }): Promise<readonly ServerEnvelopeDocument[]> {
    const execution = requireDialogueExecution(input.command);
    const run = await this.#directorRuns.prepare({
      command: input.command,
      dialogueId: execution.dialogueId,
      requestKind: "director.system_dialogue",
    });
    const responseTurnId = requireSystemRunIdentity(
      input.command,
      run.responseTurnId,
      "response_turn_id",
    );
    const responseRuleRequestId = requireSystemRunIdentity(
      input.command,
      run.responseRuleRequestId,
      "response_rule_request_id",
    );
    const modelReceipt = await this.#models.directorSystemDialogue({
      worldId: input.command.session.worldId,
      dialogueId: execution.dialogueId,
      playerEntityId: input.command.session.playerEntityId,
      latestPlayerTurnId: execution.humanTurnId,
      requestId: run.modelRequestId,
    });
    assertDirectorSystemReceiptIdentity({
      command: input.command,
      requestId: run.modelRequestId,
      receipt: modelReceipt,
      expectedBasisRevision: input.humanWorldRevision,
    });

    const responseReceipt =
      await this.#rulePlugins.executeRecoverable({
        requestId: responseRuleRequestId,
        candidateFactory: async () =>
          this.#createSystemTurnAppendRequest({
            command: input.command,
            run,
            modelReceipt,
            expectedWorldRevision: input.humanWorldRevision,
          }),
        modelInvocations: [modelReceipt],
      });
    await this.#assertSystemTurnReceiptIdentity({
      command: input.command,
      run,
      modelReceipt,
      receipt: responseReceipt,
      expectedWorldRevision: input.humanWorldRevision,
    });
    if (responseReceipt.proposal === undefined) {
      throw new EngineFault(
        "dialogue.orchestration.system_append_rejected",
        "System turn append was rejected after the human packet committed; command remains blocked for explicit repair",
        {
          session_id: input.command.session.sessionId,
          command_id: input.command.commandId,
          request_id: responseRuleRequestId,
          reject_code: readRejectCode(responseReceipt),
        },
      );
    }
    const responseCommit =
      await this.#mutations.commitRulePluginReceipt(responseReceipt);
    const responseWorldRevision = input.humanWorldRevision + 1;
    assertCommittedRevision(
      responseCommit.value,
      responseWorldRevision,
      input.command,
      "director_system",
    );

    // Observe events at post-reply revision before planning may advance the world.
    const eventObservation = await this.#observeDialogueEvents({
      command: input.command,
      dialogueId: execution.dialogueId,
      latestPlayerTurnId: execution.humanTurnId,
      expectedBasisRevision: responseWorldRevision,
    });
    const planningInvocation =
      await this.#invokeSystemPlanningModel({
        command: input.command,
        interactionKind: input.interactionKind,
        basisRevision: responseWorldRevision,
      });
    const planningWorldRevision =
      await this.#publishSystemPlanningDraft({
        command: input.command,
        planningInvocation,
        startingWorldRevision: responseWorldRevision,
      });
    const finalWorldRevision = await this.#publishDirectorEventCards({
      command: input.command,
      run: eventObservation.run,
      modelReceipt: eventObservation.modelReceipt,
      startingWorldRevision: planningWorldRevision,
    });

    return this.#finalizer.completeDialogueAccepted({
      sessionId: input.command.session.sessionId,
      commandId: input.command.commandId,
      finalWorldRevision,
      responseTurnId,
    });
  }

  async #createSystemTurnAppendRequest(input: {
    readonly command: StoredReceivedCommand;
    readonly run: DialogueDirectorRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<JsonObject> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertWorldRevision(
      binding,
      input.expectedWorldRevision,
      input.command,
      "director_system",
    );
    const snapshot = binding.record.snapshot;
    const worldState = worldStateFromSnapshot(snapshot.value);
    const dialogue = requireDialogue(
      worldState,
      input.run.dialogueId,
    );
    requireSystemDialogueResponder({
      worldState,
      dialogue,
      worldId: input.command.session.worldId,
      playerEntityId: input.command.session.playerEntityId,
    });
    const invocation = resolveDialogueInvocation(
      binding.contentBinding,
      "dialogue.turn.append",
      this.#rulePluginAbi,
    );
    const output = readModelOutput(input.modelReceipt);
    const outputDigest = expectString(
      input.modelReceipt.proof.value,
      "output_digest",
      "VerifiedModelOutputRef",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: input.command.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [
        Object.freeze({
          result_id: "director_system_dialogue_output",
          content_digest: outputDigest,
          payload: output,
        }),
      ],
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: requireSystemRunIdentity(
        input.command,
        input.run.responseRuleRequestId,
        "response_rule_request_id",
      ),
      plugin_lock: invocation.pluginLock,
      operation_id: invocation.operationId,
      operation_kind: "dialogue.turn.append",
      basis_revision: input.expectedWorldRevision,
      readonly_world: snapshot.value,
      deterministic_context: deterministicContext.value,
      input: Object.freeze({
        dialogue_id: input.run.dialogueId,
        expected_revision: expectInteger(
          dialogue,
          "revision",
          "DialogueRecord",
        ),
        control: Object.freeze({
          binding_id: input.command.session.controlBindingId,
        }),
        model_proof: input.modelReceipt.proof.value,
        turn: createDirectorSystemTurn({
          command: input.command,
          run: input.run,
          worldState,
          output,
          outputDigest,
        }),
      }),
    });
  }

  async #assertSystemTurnReceiptIdentity(input: {
    readonly command: StoredReceivedCommand;
    readonly run: DialogueDirectorRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly receipt: VerifiedRulePluginInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<void> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    const invocation = resolveDialogueInvocation(
      binding.contentBinding,
      "dialogue.turn.append",
      this.#rulePluginAbi,
    );
    const responseRuleRequestId = requireSystemRunIdentity(
      input.command,
      input.run.responseRuleRequestId,
      "response_rule_request_id",
    );
    assertRulePluginRequestHeader({
      receipt: input.receipt,
      command: input.command,
      expectedRequestId: responseRuleRequestId,
      expectedBasisRevision: input.expectedWorldRevision,
      operationKind: "dialogue.turn.append",
      invocation,
    });
    const requestInput = rulePluginRequestInput(input.receipt);
    const turn = expectJsonObject(
      expectProperty(
        requestInput,
        "turn",
        "DirectorSystemDialogueTurnAppendInput",
      ),
      "DirectorSystemDialogueTurnAppendInput.turn",
    );
    const source = expectJsonObject(
      expectProperty(turn, "source", "DialogueTurn"),
      "DialogueTurn.source",
    );
    const speaker = expectJsonObject(
      expectProperty(turn, "speaker", "DialogueTurn"),
      "DialogueTurn.speaker",
    );
    const control = expectJsonObject(
      expectProperty(
        requestInput,
        "control",
        "DirectorSystemDialogueTurnAppendInput",
      ),
      "DirectorSystemDialogueTurnAppendInput.control",
    );
    if (
      expectString(
        requestInput,
        "dialogue_id",
        "DirectorSystemDialogueTurnAppendInput",
      ) !== input.run.dialogueId ||
      !jsonEquals(
        expectProperty(
          requestInput,
          "model_proof",
          "DirectorSystemDialogueTurnAppendInput",
        ),
        input.modelReceipt.proof.value,
      ) ||
      expectString(
        control,
        "binding_id",
        "ControlBindingRef",
      ) !== input.command.session.controlBindingId ||
      expectString(turn, "turn_id", "DialogueTurn") !==
        requireSystemRunIdentity(
          input.command,
          input.run.responseTurnId,
          "response_turn_id",
        ) ||
      expectString(
        speaker,
        "participant_kind",
        "DialogueParticipantRef",
      ) !== "system" ||
      expectString(source, "source_kind", "DialogueTurnSource") !==
        "director_system" ||
      expectString(
        source,
        "model_request_id",
        "DialogueTurnSource",
      ) !== input.run.modelRequestId ||
      expectString(
        source,
        "model_output_digest",
        "DialogueTurnSource",
      ) !==
        expectString(
          input.modelReceipt.proof.value,
          "output_digest",
          "VerifiedModelOutputRef",
        )
    ) {
      throw commandIdentityFault(
        input.command,
        "Recovered System turn invocation differs from its Director run identity",
        { request_id: responseRuleRequestId },
      );
    }
  }

  async #invokeSystemPlanningModel(input: {
    readonly command: StoredReceivedCommand;
    readonly interactionKind: DialogueInteractionKind;
    readonly basisRevision: number;
  }): Promise<SystemPlanningInvocation> {
    if (input.interactionKind === "dialogue") {
      return Object.freeze({ interactionKind: "dialogue" });
    }
    const execution = requireDialogueExecution(input.command);
    const requestKind =
      input.interactionKind === "goal_plan"
        ? "director.goal_plan"
        : "director.definition_draft";
    const run = await this.#directorRuns.prepare({
      command: input.command,
      dialogueId: execution.dialogueId,
      requestKind,
    });
    const common = {
      worldId: input.command.session.worldId,
      dialogueId: execution.dialogueId,
      playerEntityId: input.command.session.playerEntityId,
      latestPlayerTurnId: execution.humanTurnId,
      requestId: run.modelRequestId,
    } as const;
    const modelReceipt =
      input.interactionKind === "goal_plan"
        ? await this.#models.directorGoalPlan(common)
        : await this.#models.directorDefinitionDraft({
            ...common,
            purpose: readDialogueCommandText(input.command),
          });
    assertDirectorPlanningReceiptIdentity({
      command: input.command,
      interactionKind: input.interactionKind,
      requestId: run.modelRequestId,
      receipt: modelReceipt,
      expectedBasisRevision: input.basisRevision,
    });
    return Object.freeze({
      interactionKind: input.interactionKind,
      run,
      modelReceipt,
    });
  }

  async #publishSystemPlanningDraft(input: {
    readonly command: StoredReceivedCommand;
    readonly planningInvocation: SystemPlanningInvocation;
    readonly startingWorldRevision: number;
  }): Promise<number> {
    if (input.planningInvocation.interactionKind === "dialogue") {
      return input.startingWorldRevision;
    }
    const output = readModelOutput(
      input.planningInvocation.modelReceipt,
    );
    const draft = expectJsonObject(
      expectProperty(
        output,
        "draft",
        input.planningInvocation.interactionKind === "goal_plan"
          ? "DirectorGoalPlanOutput"
          : "DirectorDefinitionDraftOutput",
      ),
      "Director planning output.draft",
    );
    const identities = await this.#directorRuns.prepareProposals({
      run: input.planningInvocation.run,
    });
    if (input.planningInvocation.interactionKind === "goal_plan") {
      const identity = identities.goalPlans[0];
      if (
        identity === undefined ||
        identity.ordinal !== 0 ||
        identities.goalPlans.length !== 1
      ) {
        throw commandIdentityFault(
          input.command,
          "Goal-plan Director run must own exactly one ordinal-zero proposal identity",
          {},
        );
      }
      return this.#publishSystemGoalPlan({
        command: input.command,
        modelReceipt: input.planningInvocation.modelReceipt,
        draft,
        identity,
        startingWorldRevision: input.startingWorldRevision,
      });
    }
    const identity = identities.definitions[0];
    if (
      identity === undefined ||
      identity.ordinal !== 0 ||
      identities.definitions.length !== 1
    ) {
      throw commandIdentityFault(
        input.command,
        "Definition-draft Director run must own exactly one ordinal-zero proposal identity",
        {},
      );
    }
    return this.#publishSystemDefinition({
      command: input.command,
      modelReceipt: input.planningInvocation.modelReceipt,
      draft,
      identity,
      startingWorldRevision: input.startingWorldRevision,
    });
  }

  async #publishSystemDefinition(input: {
    readonly command: StoredReceivedCommand;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly draft: JsonObject;
    readonly identity: DialogueDefinitionRunRecord;
    readonly startingWorldRevision: number;
  }): Promise<number> {
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: input.identity.ruleRequestId,
      candidateFactory: async () =>
        this.#createDefinitionValidationRequest({
          command: input.command,
          draft: input.draft,
          identity: input.identity,
          modelReceipt: input.modelReceipt,
          expectedWorldRevision: input.startingWorldRevision,
        }),
      modelInvocations: [input.modelReceipt],
    });
    await this.#assertDefinitionReceiptIdentity({
      command: input.command,
      identity: input.identity,
      modelReceipt: input.modelReceipt,
      receipt,
      expectedWorldRevision: input.startingWorldRevision,
    });
    if (receipt.proposal === undefined) {
      return input.startingWorldRevision;
    }
    const committed =
      await this.#mutations.commitRulePluginReceipt(receipt);
    return assertNextCommittedRevision({
      command: input.command,
      committed: committed.value,
      currentWorldRevision: input.startingWorldRevision,
      stage: "definition",
      proposalId: input.identity.proposalId,
    });
  }

  async #publishSystemGoalPlan(input: {
    readonly command: StoredReceivedCommand;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly draft: JsonObject;
    readonly identity: DialogueGoalPlanRunRecord;
    readonly startingWorldRevision: number;
  }): Promise<number> {
    const receipt = await this.#rulePlugins.executeRecoverable({
      requestId: input.identity.ruleRequestId,
      candidateFactory: async () =>
        this.#createGoalPlanValidationRequest({
          command: input.command,
          draft: input.draft,
          identity: input.identity,
          modelReceipt: input.modelReceipt,
          expectedWorldRevision: input.startingWorldRevision,
        }),
      modelInvocations: [input.modelReceipt],
    });
    await this.#assertGoalPlanReceiptIdentity({
      command: input.command,
      identity: input.identity,
      modelReceipt: input.modelReceipt,
      receipt,
      expectedWorldRevision: input.startingWorldRevision,
    });
    if (receipt.proposal === undefined) {
      return input.startingWorldRevision;
    }
    const committed =
      await this.#mutations.commitRulePluginReceipt(receipt);
    return assertNextCommittedRevision({
      command: input.command,
      committed: committed.value,
      currentWorldRevision: input.startingWorldRevision,
      stage: "goal_plan",
      proposalId: input.identity.proposalId,
    });
  }

  async #createDefinitionValidationRequest(input: {
    readonly command: StoredReceivedCommand;
    readonly draft: JsonObject;
    readonly identity: DialogueDefinitionRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<JsonObject> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertWorldRevision(
      binding,
      input.expectedWorldRevision,
      input.command,
      "definition",
    );
    const candidate = materializeDefinitionCandidate({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      command: input.command,
      modelReceipt: input.modelReceipt,
      proposalId: input.identity.proposalId,
      draft: input.draft,
    });
    const type = requireDefinitionProposalType({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      proposal: candidate,
      command: input.command,
    });
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "definition.validate",
      abi: this.#rulePluginAbi,
      sourcePredicate: (candidate) =>
        expectString(
          candidate.source,
          "owner_kind",
          "RulePlugin operation source",
        ) === "type_definition" &&
        expectString(
          candidate.source,
          "owner_id",
          "RulePlugin operation source",
        ) === type.typeId,
      faultOwner: `type_definition:${type.typeId}`,
    });
    const constraints = worldLawRefs(
      this.#catalog,
      binding.contentBinding,
      input.command,
    );
    return this.#createSystemPlanningRequest({
      command: input.command,
      modelReceipt: input.modelReceipt,
      expectedWorldRevision: input.expectedWorldRevision,
      preparedAt: input.identity.preparedAt,
      requestId: input.identity.ruleRequestId,
      invocation,
      operationKind: "definition.validate",
      input: Object.freeze({
        definition_id: input.identity.definitionId,
        draft_ordinal: input.identity.ordinal,
        candidate,
        constraints,
        model_proof: input.modelReceipt.proof.value,
      }),
      binding,
    });
  }

  async #createGoalPlanValidationRequest(input: {
    readonly command: StoredReceivedCommand;
    readonly draft: JsonObject;
    readonly identity: DialogueGoalPlanRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<JsonObject> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertWorldRevision(
      binding,
      input.expectedWorldRevision,
      input.command,
      "goal_plan",
    );
    const candidate = materializeGoalPlanCandidate({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      command: input.command,
      modelReceipt: input.modelReceipt,
      proposalId: input.identity.proposalId,
      ownerActorId: input.command.session.playerEntityId,
      draft: input.draft,
      localIds: this.#localIds,
    });
    assertGoalPlanProposalSemantics({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      proposal: candidate,
      worldState: worldStateFromSnapshot(
        binding.record.snapshot.value,
      ),
      command: input.command,
    });
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "goal_plan.validate",
      abi: this.#rulePluginAbi,
      faultOwner: "WorldDefinition.goal_plan_validator",
    });
    return this.#createSystemPlanningRequest({
      command: input.command,
      modelReceipt: input.modelReceipt,
      expectedWorldRevision: input.expectedWorldRevision,
      preparedAt: input.identity.preparedAt,
      requestId: input.identity.ruleRequestId,
      invocation,
      operationKind: "goal_plan.validate",
      input: Object.freeze({
        plan_id: input.identity.planId,
        draft_ordinal: input.identity.ordinal,
        candidate,
        model_proof: input.modelReceipt.proof.value,
      }),
      binding,
    });
  }

  #createSystemPlanningRequest(input: {
    readonly command: StoredReceivedCommand;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly expectedWorldRevision: number;
    readonly preparedAt: string;
    readonly requestId: string;
    readonly invocation: RuntimeRulePluginInvocationBinding;
    readonly operationKind:
      | "definition.validate"
      | "goal_plan.validate";
    readonly input: JsonObject;
    readonly binding: RuntimeWorldBinding;
  }): JsonObject {
    const snapshot = input.binding.record.snapshot;
    const worldState = worldStateFromSnapshot(snapshot.value);
    const outputDigest = expectString(
      input.modelReceipt.proof.value,
      "output_digest",
      "VerifiedModelOutputRef",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: input.command.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [
        Object.freeze({
          result_id:
            input.operationKind === "goal_plan.validate"
              ? "director_goal_plan_output"
              : "director_definition_draft_output",
          content_digest: outputDigest,
          payload: readModelOutput(input.modelReceipt),
        }),
        Object.freeze({
          result_id: "system_provenance_created_at",
          content_digest: this.#digest.sha256(input.preparedAt),
          payload: input.preparedAt,
        }),
      ],
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: input.requestId,
      plugin_lock: input.invocation.pluginLock,
      operation_id: input.invocation.operationId,
      operation_kind: input.operationKind,
      basis_revision: input.expectedWorldRevision,
      readonly_world: snapshot.value,
      deterministic_context: deterministicContext.value,
      input: input.input,
    });
  }

  async #assertDefinitionReceiptIdentity(input: {
    readonly command: StoredReceivedCommand;
    readonly identity: DialogueDefinitionRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly receipt: VerifiedRulePluginInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<void> {
    const requestInput = rulePluginRequestInput(input.receipt);
    const candidate = expectJsonObject(
      expectProperty(
        requestInput,
        "candidate",
        "DefinitionValidationInput",
      ),
      "DefinitionValidationInput.candidate",
    );
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    const type = requireDefinitionProposalType({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      proposal: candidate,
      command: input.command,
    });
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "definition.validate",
      abi: this.#rulePluginAbi,
      sourcePredicate: (candidate) =>
        expectString(
          candidate.source,
          "owner_kind",
          "RulePlugin operation source",
        ) === "type_definition" &&
        expectString(
          candidate.source,
          "owner_id",
          "RulePlugin operation source",
        ) === type.typeId,
      faultOwner: `type_definition:${type.typeId}`,
    });
    const constraints = worldLawRefs(
      this.#catalog,
      binding.contentBinding,
      input.command,
    );
    assertSystemPlanningReceiptIdentity({
      command: input.command,
      receipt: input.receipt,
      expectedRequestId: input.identity.ruleRequestId,
      expectedBasisRevision: input.expectedWorldRevision,
      operationKind: "definition.validate",
      invocation,
      identityField: "definition_id",
      expectedWorldRecordId: input.identity.definitionId,
      expectedProposalId: input.identity.proposalId,
      expectedDraftOrdinal: input.identity.ordinal,
      expectedModelProof: input.modelReceipt.proof.value,
      expectedPreparedAt: input.identity.preparedAt,
      digest: this.#digest,
      expectedConstraints: constraints,
    });
  }

  async #assertGoalPlanReceiptIdentity(input: {
    readonly command: StoredReceivedCommand;
    readonly identity: DialogueGoalPlanRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly receipt: VerifiedRulePluginInvocationReceipt;
    readonly expectedWorldRevision: number;
  }): Promise<void> {
    const requestInput = rulePluginRequestInput(input.receipt);
    const candidate = expectJsonObject(
      expectProperty(
        requestInput,
        "candidate",
        "GoalPlanValidateInput",
      ),
      "GoalPlanValidateInput.candidate",
    );
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertGoalPlanProposalSemantics({
      catalog: this.#catalog,
      contentBinding: binding.contentBinding,
      proposal: candidate,
      worldState: worldStateFromSnapshot(
        expectJsonObject(
          expectProperty(
            input.receipt.request.value,
            "readonly_world",
            "RulePluginRequest",
          ),
          "RulePluginRequest.readonly_world",
        ),
      ),
      command: input.command,
    });
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "goal_plan.validate",
      abi: this.#rulePluginAbi,
      faultOwner: "WorldDefinition.goal_plan_validator",
    });
    assertSystemPlanningReceiptIdentity({
      command: input.command,
      receipt: input.receipt,
      expectedRequestId: input.identity.ruleRequestId,
      expectedBasisRevision: input.expectedWorldRevision,
      operationKind: "goal_plan.validate",
      invocation,
      identityField: "plan_id",
      expectedWorldRecordId: input.identity.planId,
      expectedProposalId: input.identity.proposalId,
      expectedDraftOrdinal: input.identity.ordinal,
      expectedModelProof: input.modelReceipt.proof.value,
      expectedPreparedAt: input.identity.preparedAt,
      digest: this.#digest,
      expectedConstraints: undefined,
    });
  }

  async #readSessionEventBudgetRemaining(
    command: StoredReceivedCommand,
  ): Promise<number> {
    const binding = await this.#worlds.resolveCurrent(
      command.session.worldId,
    );
    assertWorldRevision(
      binding,
      command.session.worldRevision,
      command,
      "event_budget_gate",
    );
    const worldState = worldStateFromSnapshot(
      binding.record.snapshot.value,
    );
    return readEventBudgetRemaining(
      worldState,
      command.session.controlBindingId,
    );
  }

  /**
   * Observe transcript for EventCards. Entry gate already requires
   * remaining > 0 before any dialogue Token use; this call must still see
   * remaining > 0 and produce exactly one card (Accept+publish, or fail).
   * Dialogue and EventCard are paired: no free reply without a funded card.
   */
  async #observeDialogueEvents(input: {
    readonly command: StoredReceivedCommand;
    readonly dialogueId: string;
    readonly latestPlayerTurnId: string;
    readonly expectedBasisRevision: number;
  }): Promise<{
    readonly run: DialogueDirectorRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
  }> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertWorldRevision(
      binding,
      input.expectedBasisRevision,
      input.command,
      "event_card",
    );
    const worldState = worldStateFromSnapshot(
      binding.record.snapshot.value,
    );
    const remaining = readEventBudgetRemaining(
      worldState,
      input.command.session.controlBindingId,
    );
    if (remaining === 0) {
      throw new EngineFault(
        "dialogue.orchestration.event_budget_exhausted_mid_command",
        "EventBudget remaining became 0 before dialogue_events; dialogue must not consume Token without budget",
        {
          session_id: input.command.session.sessionId,
          command_id: input.command.commandId,
          dialogue_id: input.dialogueId,
        },
      );
    }

    const eventRun = await this.#directorRuns.prepare({
      command: input.command,
      dialogueId: input.dialogueId,
      requestKind: "director.dialogue_events",
    });
    const eventReceipt = await this.#models.directorDialogueEvents({
      worldId: input.command.session.worldId,
      dialogueId: input.dialogueId,
      latestPlayerTurnId: input.latestPlayerTurnId,
      requestId: eventRun.modelRequestId,
    });
    assertDirectorDialogueReceiptIdentity({
      command: input.command,
      requestId: eventRun.modelRequestId,
      receipt: eventReceipt,
      expectedBasisRevision: input.expectedBasisRevision,
    });
    return Object.freeze({
      run: eventRun,
      modelReceipt: eventReceipt,
    });
  }

  async #publishDirectorEventCards(input: {
    readonly command: StoredReceivedCommand;
    readonly run: DialogueDirectorRunRecord;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly startingWorldRevision: number;
  }): Promise<number> {
    const output = readModelOutput(input.modelReceipt);
    const drafts = asObjectArray(
      expectProperty(
        output,
        "event_cards",
        "DirectorDialogueEventsOutput",
      ),
      "DirectorDialogueEventsOutput.event_cards",
    );
    const identities = (
      await this.#directorRuns.prepareProposals({
        run: input.run,
      })
    ).eventCards;

    let expectedWorldRevision = input.startingWorldRevision;
    for (const [ordinal, draft] of drafts.entries()) {
      const identity = identities[ordinal] as
        | DialogueEventCardRunRecord
        | undefined;
      if (
        identity === undefined ||
        identity.ordinal !== ordinal
      ) {
        throw commandIdentityFault(
          input.command,
          "Persisted EventCard RulePlugin identity order differs from the verified Director response",
          { proposal_ordinal: ordinal },
        );
      }
      const receipt = await this.#rulePlugins.executeRecoverable({
        requestId: identity.ruleRequestId,
        candidateFactory: async () =>
          this.#createEventCardPublishRequest({
            command: input.command,
            draft,
            draftOrdinal: ordinal,
            proposalId: identity.proposalId,
            modelReceipt: input.modelReceipt,
            requestId: identity.ruleRequestId,
            expectedWorldRevision,
          }),
        modelInvocations: [input.modelReceipt],
      });
      await this.#assertEventCardPublishReceiptIdentity({
        command: input.command,
        draftOrdinal: ordinal,
        proposalId: identity.proposalId,
        modelReceipt: input.modelReceipt,
        receipt,
        requestId: identity.ruleRequestId,
        expectedWorldRevision,
      });
      // Reject must fail the dialogue command — silent skip would leave
      // remaining>0 talk without a published world card after the model
      // emitted the required single card.
      if (receipt.proposal === undefined) {
        const output = expectJsonObject(
          expectProperty(
            receipt.response.value,
            "output",
            "RulePluginResponse",
          ),
          "RulePluginResponse.output",
        );
        throw new EngineFault(
          "dialogue.orchestration.event_card_publish_rejected",
          "EventCard RulePlugin rejected the dialogue observation card; the command cannot complete without publishing an emitted card",
          {
            session_id: input.command.session.sessionId,
            command_id: input.command.commandId,
            proposal_id: identity.proposalId,
            request_id: identity.ruleRequestId,
            draft_ordinal: ordinal,
            output_kind: expectString(
              output,
              "output_kind",
              "RulePluginResponse.output",
            ),
            reject_code:
              typeof output["code"] === "string"
                ? (output["code"] as string)
                : null,
          },
        );
      }
      const committed =
        await this.#mutations.commitRulePluginReceipt(receipt);
      const nextRevision = expectedWorldRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        throw new EngineFault(
          "dialogue.orchestration.world_revision_exhausted",
          "EventCard publication cannot advance world revision safely",
          {
            session_id: input.command.session.sessionId,
            command_id: input.command.commandId,
            world_revision: expectedWorldRevision,
          },
        );
      }
      const actualRevision = expectInteger(
        committed.value,
        "world_revision",
        "ApplyPacketResult",
      );
      if (actualRevision !== nextRevision) {
        throw commandIdentityFault(
          input.command,
          "EventCard publication returned an unexpected world revision",
          {
            proposal_id: identity.proposalId,
            expected_world_revision: nextRevision,
            actual_world_revision: actualRevision,
          },
        );
      }
      expectedWorldRevision = nextRevision;
    }
    if (drafts.length !== 1) {
      throw new EngineFault(
        "dialogue.orchestration.event_card_count",
        "Dialogue observation must produce exactly one EventCard draft when dialogue_events was called",
        {
          session_id: input.command.session.sessionId,
          command_id: input.command.commandId,
          draft_count: drafts.length,
        },
      );
    }
    if (expectedWorldRevision === input.startingWorldRevision) {
      throw new EngineFault(
        "dialogue.orchestration.event_card_not_published",
        "Dialogue observation produced a card draft but no EventCard was committed",
        {
          session_id: input.command.session.sessionId,
          command_id: input.command.commandId,
          draft_count: drafts.length,
          starting_world_revision: input.startingWorldRevision,
        },
      );
    }
    return expectedWorldRevision;
  }

  async #createEventCardPublishRequest(input: {
    readonly command: StoredReceivedCommand;
    readonly draft: JsonObject;
    readonly draftOrdinal: number;
    readonly proposalId: string;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly requestId: string;
    readonly expectedWorldRevision: number;
  }): Promise<JsonObject> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    assertWorldRevision(
      binding,
      input.expectedWorldRevision,
      input.command,
      "event_card",
    );
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "event_card.publish",
      abi: this.#rulePluginAbi,
      faultOwner: "WorldDefinition.event_budget.card_cost_resolver",
    });
    const snapshot = binding.record.snapshot;
    const worldState = expectJsonObject(
      expectProperty(
        snapshot.value,
        "world_state",
        "WorldSnapshot",
      ),
      "WorldSnapshot.world_state",
    );
    const candidate = materializeEventCardCandidate({
      command: input.command,
      modelReceipt: input.modelReceipt,
      worldState,
      contentBinding: binding.contentBinding,
      proposalId: input.proposalId,
      draft: input.draft,
      localIds: this.#localIds,
    });
    const modelOutputDigest = expectString(
      input.modelReceipt.proof.value,
      "output_digest",
      "VerifiedModelOutputRef",
    );
    const modelOutput = readModelOutput(input.modelReceipt);
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: input.command.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [
        Object.freeze({
          result_id: "director_dialogue_events_output",
          content_digest: modelOutputDigest,
          payload: modelOutput,
        }),
      ],
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: input.requestId,
      plugin_lock: invocation.pluginLock,
      operation_id: invocation.operationId,
      operation_kind: "event_card.publish",
      basis_revision: input.expectedWorldRevision,
      readonly_world: snapshot.value,
      deterministic_context: deterministicContext.value,
      input: Object.freeze({
        draft_ordinal: input.draftOrdinal,
        control: Object.freeze({
          binding_id: input.command.session.controlBindingId,
        }),
        candidate,
        policy: binding.contentBinding.eventBudget,
        model_proof: input.modelReceipt.proof.value,
      }),
    });
  }

  async #assertEventCardPublishReceiptIdentity(input: {
    readonly command: StoredReceivedCommand;
    readonly draftOrdinal: number;
    readonly proposalId: string;
    readonly modelReceipt: VerifiedModelInvocationReceipt;
    readonly receipt: VerifiedRulePluginInvocationReceipt;
    readonly requestId: string;
    readonly expectedWorldRevision: number;
  }): Promise<void> {
    const binding = await this.#worlds.resolveCurrent(
      input.command.session.worldId,
    );
    const invocation = resolveRulePluginInvocationBinding({
      binding: binding.contentBinding,
      operationKind: "event_card.publish",
      abi: this.#rulePluginAbi,
      faultOwner: "WorldDefinition.event_budget.card_cost_resolver",
    });
    const request = input.receipt.request.value;
    const readonlyWorld = expectJsonObject(
      expectProperty(
        request,
        "readonly_world",
        "RulePluginRequest",
      ),
      "RulePluginRequest.readonly_world",
    );
    const requestInput = expectJsonObject(
      expectProperty(request, "input", "RulePluginRequest"),
      "RulePluginRequest.input",
    );
    const control = expectJsonObject(
      expectProperty(
        requestInput,
        "control",
        "EventCardPublishInput",
      ),
      "EventCardPublishInput.control",
    );
    const candidate = expectJsonObject(
      expectProperty(
        requestInput,
        "candidate",
        "EventCardPublishInput",
      ),
      "EventCardPublishInput.candidate",
    );
    if (
      input.receipt.worldId !== input.command.session.worldId ||
      input.receipt.basisRevision !== input.expectedWorldRevision ||
      expectString(request, "request_id", "RulePluginRequest") !==
        input.requestId ||
      expectString(request, "operation_kind", "RulePluginRequest") !==
        "event_card.publish" ||
      expectString(request, "operation_id", "RulePluginRequest") !==
        invocation.operationId ||
      expectInteger(request, "basis_revision", "RulePluginRequest") !==
        input.expectedWorldRevision ||
      expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
        input.command.session.worldId ||
      expectInteger(
        readonlyWorld,
        "world_revision",
        "WorldSnapshot",
      ) !== input.expectedWorldRevision ||
      expectString(control, "binding_id", "ControlBindingRef") !==
        input.command.session.controlBindingId ||
      expectInteger(
        requestInput,
        "draft_ordinal",
        "EventCardPublishInput",
      ) !== input.draftOrdinal ||
      expectString(
        candidate,
        "proposal_id",
        "EventCardPublishCandidate",
      ) !== input.proposalId ||
      !jsonEquals(
        expectProperty(
          requestInput,
          "policy",
          "EventCardPublishInput",
        ),
        binding.contentBinding.eventBudget,
      ) ||
      !jsonEquals(
        expectProperty(
          requestInput,
          "model_proof",
          "EventCardPublishInput",
        ),
        input.modelReceipt.proof.value,
      ) ||
      !jsonEquals(
        expectProperty(request, "plugin_lock", "RulePluginRequest"),
        invocation.pluginLock,
      )
    ) {
      throw commandIdentityFault(
        input.command,
        "Recovered EventCard RulePlugin invocation differs from its Director proposal identity",
        {
          request_id: input.requestId,
          proposal_id: input.proposalId,
          expected_basis_revision: input.expectedWorldRevision,
        },
      );
    }
  }

  async #assertHumanReceiptIdentity(
    command: StoredReceivedCommand,
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<DialogueResponder> {
    const execution = requireDialogueExecution(command);
    const operationKind: DialogueOperationKind =
      command.commandKind === "dialogue.start"
        ? "dialogue.open"
        : "dialogue.turn.append";
    const currentBinding = await this.#worlds.resolveCurrent(
      command.session.worldId,
    );
    const invocation = resolveDialogueInvocation(
      currentBinding.contentBinding,
      operationKind,
      this.#rulePluginAbi,
    );
    assertRulePluginRequestHeader({
      receipt,
      command,
      expectedRequestId: execution.humanRuleRequestId,
      expectedBasisRevision: command.session.worldRevision,
      operationKind,
      invocation,
    });
    const input = expectJsonObject(
      expectProperty(
        receipt.request.value,
        "input",
        "RulePluginRequest",
      ),
      "RulePluginRequest.input",
    );
    const turn = expectJsonObject(
      expectProperty(
        input,
        command.commandKind === "dialogue.start"
          ? "first_turn"
          : "turn",
        operationKind,
      ),
      `${operationKind}.human_turn`,
    );
    const readonlyWorld = expectJsonObject(
      expectProperty(
        receipt.request.value,
        "readonly_world",
        "RulePluginRequest",
      ),
      "RulePluginRequest.readonly_world",
    );
    const worldState = expectJsonObject(
      expectProperty(readonlyWorld, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    assertHumanTurnCommandIdentity(command, turn, worldState);
    const control = expectJsonObject(
      expectProperty(input, "control", operationKind),
      `${operationKind}.control`,
    );
    if (
      expectString(control, "binding_id", "ControlBindingRef") !==
      command.session.controlBindingId
    ) {
      throw commandIdentityFault(
        command,
        "Human dialogue RulePlugin request uses a different ControlBinding",
        { operation_kind: operationKind },
      );
    }
    return resolveRecipientFromHumanInput(input, worldState, command);
  }

  async #assertCharacterReceiptIdentity(
    command: StoredReceivedCommand,
    recipientEntityId: string,
    modelReceipt: Awaited<
      ReturnType<RuntimeModelFacades["characterDialogue"]>
    >,
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<void> {
    const execution = requireDialogueExecution(command);
    const operationKind = "dialogue.turn.append" as const;
    const currentBinding = await this.#worlds.resolveCurrent(
      command.session.worldId,
    );
    const invocation = resolveDialogueInvocation(
      currentBinding.contentBinding,
      operationKind,
      this.#rulePluginAbi,
    );
    assertRulePluginRequestHeader({
      receipt,
      command,
      expectedRequestId: execution.characterRuleRequestId,
      expectedBasisRevision: command.session.worldRevision + 1,
      operationKind,
      invocation,
    });
    const input = expectJsonObject(
      expectProperty(
        receipt.request.value,
        "input",
        "RulePluginRequest",
      ),
      "RulePluginRequest.input",
    );
    if (
      expectString(
        input,
        "dialogue_id",
        "CharacterDialogueTurnAppendInput",
      ) !== execution.dialogueId ||
      !jsonEquals(
        expectProperty(
          input,
          "model_proof",
          "CharacterDialogueTurnAppendInput",
        ),
        modelReceipt.proof.value,
      )
    ) {
      throw commandIdentityFault(
        command,
        "Character dialogue RulePlugin request uses different dialogue or model evidence",
        { operation_kind: operationKind },
      );
    }
    const turn = expectJsonObject(
      expectProperty(
        input,
        "candidate",
        "CharacterDialogueTurnAppendInput",
      ),
      "CharacterDialogueTurnAppendInput.candidate",
    );
    const speaker = requireEntityParticipant(
      expectJsonObject(
        expectProperty(turn, "speaker", "DialogueTurn"),
        "DialogueTurn.speaker",
      ),
      "DialogueTurn.speaker",
    );
    const source = expectJsonObject(
      expectProperty(turn, "source", "DialogueTurn"),
      "DialogueTurn.source",
    );
    if (
      expectString(turn, "turn_id", "DialogueTurn") !==
        execution.characterTurnId ||
      expectString(speaker, "world_id", "EntityRef") !==
        command.session.worldId ||
      expectString(speaker, "entity_id", "EntityRef") !==
        recipientEntityId ||
      expectString(source, "source_kind", "DialogueTurnSource") !==
        "character_mind" ||
      expectString(
        source,
        "model_request_id",
        "DialogueTurnSource",
      ) !== execution.characterModelRequestId ||
      expectString(
        source,
        "model_output_digest",
        "DialogueTurnSource",
      ) !==
        expectString(
          modelReceipt.proof.value,
          "output_digest",
          "VerifiedModelOutputRef",
        )
    ) {
      throw commandIdentityFault(
        command,
        "Character dialogue RulePlugin request differs from its persisted turn or model identity",
        { operation_kind: operationKind },
      );
    }
  }

  async #createHumanRulePluginRequest(
    command: StoredReceivedCommand,
  ): Promise<JsonObject> {
    const execution = requireDialogueExecution(command);
    const context = await this.#loadHumanStageContext(command);
    const operationKind: DialogueOperationKind =
      command.commandKind === "dialogue.start"
        ? "dialogue.open"
        : "dialogue.turn.append";
    const invocation = resolveDialogueInvocation(
      context.binding.contentBinding,
      operationKind,
      this.#rulePluginAbi,
    );
    const snapshot = context.binding.record.snapshot;
    const snapshotValue = snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshotValue, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: command.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [],
    });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: execution.humanRuleRequestId,
      plugin_lock: invocation.pluginLock,
      operation_id: invocation.operationId,
      operation_kind: operationKind,
      basis_revision: command.session.worldRevision,
      readonly_world: snapshotValue,
      deterministic_context: deterministicContext.value,
      input: context.input,
    });
  }

  async #loadHumanStageContext(
    command: StoredReceivedCommand,
  ): Promise<HumanStageContext> {
    const execution = requireDialogueExecution(command);
    const binding = await this.#worlds.resolveCurrent(
      command.session.worldId,
    );
    assertWorldRevision(
      binding,
      command.session.worldRevision,
      command,
      "human",
    );
    const worldState = expectJsonObject(
      expectProperty(
        binding.record.snapshot.value,
        "world_state",
        "WorldSnapshot",
      ),
      "WorldSnapshot.world_state",
    );
    const humanTurn = createHumanTurn(command, worldState);
    if (command.commandKind === "dialogue.start") {
      const recipient = expectJsonObject(
        expectProperty(
          command.message,
          "recipient",
          "DialogueStart",
        ),
        "DialogueStart.recipient",
      );
      const responder = requireDialogueStartResponder({
        worldState,
        participant: recipient,
        worldId: command.session.worldId,
        playerEntityId: command.session.playerEntityId,
      });
      const dayCycle = expectJsonObject(
        expectProperty(worldState, "day_cycle", "WorldState"),
        "WorldState.day_cycle",
      );
      return Object.freeze({
        binding,
        input: Object.freeze({
          dialogue_id: execution.dialogueId,
          day: expectInteger(dayCycle, "day", "DayCycleState"),
          participants: [
            entityParticipant(
              command.session.worldId,
              command.session.playerEntityId,
            ),
            responderParticipant(
              command.session.worldId,
              responder,
            ),
          ],
          first_turn: humanTurn,
          control: Object.freeze({
            binding_id: command.session.controlBindingId,
          }),
        }),
      });
    }

    const dialogue = requireDialogue(
      worldState,
      execution.dialogueId,
    );
    requireDialogueResponder({
      worldState,
      dialogue,
      worldId: command.session.worldId,
      playerEntityId: command.session.playerEntityId,
    });
    return Object.freeze({
      binding,
      input: Object.freeze({
        dialogue_id: execution.dialogueId,
        expected_revision: expectInteger(
          dialogue,
          "revision",
          "DialogueRecord",
        ),
        control: Object.freeze({
          binding_id: command.session.controlBindingId,
        }),
        turn: humanTurn,
      }),
    });
  }

  async #createCharacterRulePluginRequest(
    command: StoredReceivedCommand,
    recipientEntityId: string,
    modelReceipt: Awaited<
      ReturnType<RuntimeModelFacades["characterDialogue"]>
    >,
  ): Promise<JsonObject> {
    const execution = requireDialogueExecution(command);
    const binding = await this.#worlds.resolveCurrent(
      command.session.worldId,
    );
    const expectedWorldRevision = command.session.worldRevision + 1;
    assertWorldRevision(
      binding,
      expectedWorldRevision,
      command,
      "character",
    );
    const snapshot = binding.record.snapshot;
    const worldState = expectJsonObject(
      expectProperty(
        snapshot.value,
        "world_state",
        "WorldSnapshot",
      ),
      "WorldSnapshot.world_state",
    );
    const dialogue = requireDialogue(worldState, execution.dialogueId);
    if (
      expectInteger(dialogue, "revision", "DialogueRecord") <
      1
    ) {
      throw new EngineFault(
        "dialogue.orchestration.dialogue_revision_invalid",
        "Dialogue must have a positive revision after the human packet",
        { dialogue_id: execution.dialogueId },
      );
    }
    requireBasicNpcDialogueResponder(
      worldState,
      dialogue,
      command.session.worldId,
      command.session.playerEntityId,
      recipientEntityId,
    );
    const operationKind = "dialogue.turn.append" as const;
    const invocation = resolveDialogueInvocation(
      binding.contentBinding,
      operationKind,
      this.#rulePluginAbi,
    );
    const output = expectJsonObject(
      expectProperty(
        modelReceipt.response.value,
        "output",
        "ModelResponse",
      ),
      "ModelResponse.output",
    );
    const modelOutputDigest = expectString(
      modelReceipt.proof.value,
      "output_digest",
      "VerifiedModelOutputRef",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: command.session.worldId,
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [
        Object.freeze({
          result_id: "character_dialogue_output",
          content_digest: modelOutputDigest,
          payload: output,
        }),
      ],
    });
    const characterTurn = createCharacterTurnCandidate({
      contracts: this.#contracts,
      command,
      recipientEntityId,
      worldState,
      dialogue,
      output,
      modelRequestId: expectString(
        modelReceipt.proof.value,
        "request_id",
        "VerifiedModelOutputRef",
      ),
      modelOutputDigest,
      localIds: this.#localIds,
    });

    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: execution.characterRuleRequestId,
      plugin_lock: invocation.pluginLock,
      operation_id: invocation.operationId,
      operation_kind: operationKind,
      basis_revision: expectedWorldRevision,
      readonly_world: snapshot.value,
      deterministic_context: deterministicContext.value,
      input: Object.freeze({
        dialogue_id: execution.dialogueId,
        expected_revision: expectInteger(
          dialogue,
          "revision",
          "DialogueRecord",
        ),
        model_proof: modelReceipt.proof.value,
        candidate: characterTurn,
      }),
    });
  }
}

function assertRulePluginRequestHeader(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly command: StoredReceivedCommand;
  readonly expectedRequestId: string;
  readonly expectedBasisRevision: number;
  readonly operationKind: OrchestratedOperationKind;
  readonly invocation: RuntimeRulePluginInvocationBinding;
}): void {
  const request = input.receipt.request.value;
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  const requestPluginLock = expectJsonObject(
    expectProperty(request, "plugin_lock", "RulePluginRequest"),
    "RulePluginRequest.plugin_lock",
  );
  if (
    input.receipt.worldId !== input.command.session.worldId ||
    input.receipt.basisRevision !== input.expectedBasisRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      input.expectedRequestId ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      input.operationKind ||
    expectInteger(request, "basis_revision", "RulePluginRequest") !==
      input.expectedBasisRevision ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.command.session.worldId ||
    expectInteger(
      readonlyWorld,
      "world_revision",
      "WorldSnapshot",
    ) !== input.expectedBasisRevision ||
    !jsonEquals(requestPluginLock, input.invocation.pluginLock)
  ) {
    throw commandIdentityFault(
      input.command,
      "Recovered RulePlugin invocation differs from its command-owned dialogue stage",
      {
        expected_request_id: input.expectedRequestId,
        expected_operation_kind: input.operationKind,
        expected_basis_revision: input.expectedBasisRevision,
      },
    );
  }
}

function assertHumanTurnCommandIdentity(
  command: StoredReceivedCommand,
  turn: JsonObject,
  worldState: JsonObject,
): void {
  const execution = requireDialogueExecution(command);
  const speaker = requireEntityParticipant(
    expectJsonObject(
      expectProperty(turn, "speaker", "DialogueTurn"),
      "DialogueTurn.speaker",
    ),
    "DialogueTurn.speaker",
  );
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (
    expectString(turn, "turn_id", "DialogueTurn") !==
      execution.humanTurnId ||
    expectString(speaker, "world_id", "EntityRef") !==
      command.session.worldId ||
    expectString(speaker, "entity_id", "EntityRef") !==
      command.session.playerEntityId ||
    expectString(source, "source_kind", "DialogueTurnSource") !==
      "human" ||
    expectString(source, "command_id", "DialogueTurnSource") !==
      command.commandId ||
    expectString(turn, "locale", "DialogueTurn") !==
      expectString(command.message, "locale", command.commandKind) ||
    expectString(turn, "text", "DialogueTurn") !==
      expectString(command.message, "text", command.commandKind) ||
    !jsonEquals(
      expectProperty(turn, "occurred_at", "DialogueTurn"),
      expectProperty(worldState, "clock", "WorldState"),
    ) ||
    !jsonEquals(
      expectProperty(
        turn,
        "agency_commitments",
        "DialogueTurn",
      ),
      [],
    ) ||
    turn["emotion_id"] !== undefined
  ) {
    throw commandIdentityFault(
      command,
      "Human dialogue turn differs from its persisted command, player, or turn identity",
      {},
    );
  }
}

function requireEntityParticipant(
  participant: JsonObject,
  path: string,
): JsonObject {
  const participantKind = expectString(
    participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind !== "entity") {
    throw new EngineFault(
      "dialogue.orchestration.entity_participant_required",
      `${path} must be an entity participant`,
      { path, participant_kind: participantKind },
    );
  }
  return expectJsonObject(
    expectProperty(
      participant,
      "entity",
      "DialogueParticipantRef",
    ),
    `${path}.entity`,
  );
}

function commandIdentityFault(
  command: StoredReceivedCommand,
  message: string,
  details: JsonObject,
): EngineFault {
  return new EngineFault(
    "dialogue.orchestration.command_identity_conflict",
    message,
    {
      session_id: command.session.sessionId,
      command_id: command.commandId,
      ...details,
    },
  );
}

function createHumanTurn(
  command: StoredReceivedCommand,
  worldState: JsonObject,
): JsonObject {
  const execution = requireDialogueExecution(command);
  return Object.freeze({
    turn_id: execution.humanTurnId,
    speaker: entityParticipant(
      command.session.worldId,
      command.session.playerEntityId,
    ),
    locale: expectString(
      command.message,
      "locale",
      command.commandKind,
    ),
    text: expectString(
      command.message,
      "text",
      command.commandKind,
    ),
    occurred_at: expectProperty(worldState, "clock", "WorldState"),
    source: Object.freeze({
      source_kind: "human",
      command_id: command.commandId,
    }),
    agency_commitments: [],
  });
}

function createCharacterTurnCandidate(input: {
  readonly contracts: ContractValidator;
  readonly command: StoredReceivedCommand;
  readonly recipientEntityId: string;
  readonly worldState: JsonObject;
  readonly dialogue: JsonObject;
  readonly output: JsonObject;
  readonly modelRequestId: string;
  readonly modelOutputDigest: string;
  readonly localIds: DialogueLocalIdFactory;
}): JsonObject {
  const execution = requireDialogueExecution(input.command);
  const reply = expectJsonObject(
    expectProperty(input.output, "reply", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.reply",
  );
  // commitments always required on model output (use [] when none) so transcript
  // and director.dialogue_events projection carry an explicit empty array.
  const drafts = asObjectArray(
    expectProperty(
      input.output,
      "commitments",
      "CharacterDialogueOutput",
    ),
    "CharacterDialogueOutput.commitments",
  );
  const participantCount = asObjectArray(
    expectProperty(input.dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).length;
  const commitments = materializeAgencyCommitmentsFromCharacterDrafts({
    drafts,
    worldState: input.worldState,
    speakerEntityId: input.recipientEntityId,
    createCommitmentId: () =>
      input.contracts.assert(CONTRACT_REF.uuid, input.localIds.createId())
        .value as string,
    materializeSubjects: (draft) =>
      materializeDialogueParticipantSubjects({
        command: input.command,
        worldState: input.worldState,
        dialogue: input.dialogue,
        indices: readModelIndices(
          draft,
          "subject_participant_indices",
          "AgencyCommitmentSemanticDraft",
          participantCount,
        ),
      }),
    assertCanonicalCommitmentId: (commitmentId, index) => {
      if (commitmentId !== commitmentId.toLowerCase()) {
        throw new EngineFault(
          "dialogue.orchestration.commitment_identity_invalid",
          "Generated commitment IDs must be canonical lowercase and unique within the character turn",
          {
            command_id: input.command.commandId,
            commitment_index: index,
            commitment_id: commitmentId,
          },
        );
      }
    },
  });
  const turn: Record<string, JsonValue> = {
    turn_id: execution.characterTurnId,
    speaker: entityParticipant(
      input.command.session.worldId,
      input.recipientEntityId,
    ),
    locale: expectString(
      input.command.message,
      "locale",
      input.command.commandKind,
    ),
    text: expectString(reply, "text", "DialogueReplyDraft"),
    occurred_at: expectProperty(input.worldState, "clock", "WorldState"),
    source: Object.freeze({
      source_kind: "character_mind",
      model_request_id: input.modelRequestId,
      model_output_digest: input.modelOutputDigest,
    }),
    agency_commitments: commitments,
  };
  if (reply.emotion_id !== undefined) {
    turn["emotion_id"] = expectString(
      reply,
      "emotion_id",
      "DialogueReplyDraft",
    );
  }
  return Object.freeze(turn);
}

function createDirectorSystemTurn(input: {
  readonly command: StoredReceivedCommand;
  readonly run: DialogueDirectorRunRecord;
  readonly worldState: JsonObject;
  readonly output: JsonObject;
  readonly outputDigest: string;
}): JsonObject {
  const reply = expectJsonObject(
    expectProperty(
      input.output,
      "reply",
      "DirectorSystemDialogueOutput",
    ),
    "DirectorSystemDialogueOutput.reply",
  );
  const turn: Record<string, JsonValue> = {
    turn_id: requireSystemRunIdentity(
      input.command,
      input.run.responseTurnId,
      "response_turn_id",
    ),
    speaker: Object.freeze({ participant_kind: "system" }),
    locale: expectString(
      input.command.message,
      "locale",
      input.command.commandKind,
    ),
    text: expectString(reply, "text", "DialogueReplyDraft"),
    occurred_at: expectProperty(
      input.worldState,
      "clock",
      "WorldState",
    ),
    source: Object.freeze({
      source_kind: "director_system",
      model_request_id: input.run.modelRequestId,
      model_output_digest: input.outputDigest,
    }),
    agency_commitments: [],
  };
  if (reply.emotion_id !== undefined) {
    turn.emotion_id = expectString(
      reply,
      "emotion_id",
      "DialogueReplyDraft",
    );
  }
  return Object.freeze(turn);
}

function resolveDialogueInvocation(
  binding: WorldContentBinding,
  operationKind: DialogueOperationKind,
  abi: RulePluginAbiRegistry,
): RuntimeRulePluginInvocationBinding {
  return resolveRulePluginInvocationBinding({
    binding,
    operationKind,
    abi,
    faultOwner: "world_definition",
  });
}

function requireDialogueStartResponder(input: {
  readonly worldState: JsonObject;
  readonly participant: JsonObject;
  readonly worldId: string;
  readonly playerEntityId: string;
}): DialogueResponder {
  const participantKind = expectString(
    input.participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind === "system") {
    return Object.freeze({
      responderKind: "director_system",
    });
  }
  return Object.freeze({
    responderKind: "character_mind",
    entityId: requireBasicNpcRecipient(
      input.worldState,
      input.participant,
      input.worldId,
      input.playerEntityId,
    ),
  });
}

function requireDialogueResponder(input: {
  readonly worldState: JsonObject;
  readonly dialogue: JsonObject;
  readonly worldId: string;
  readonly playerEntityId: string;
}): DialogueResponder {
  const participants = asObjectArray(
    expectProperty(
      input.dialogue,
      "participants",
      "DialogueRecord",
    ),
    "DialogueRecord.participants",
  );
  const hasSystem = participants.some(
    (participant) =>
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) === "system",
  );
  if (hasSystem) {
    requireSystemDialogueResponder(input);
    return Object.freeze({
      responderKind: "director_system",
    });
  }
  return Object.freeze({
    responderKind: "character_mind",
    entityId: requireBasicNpcDialogueResponder(
      input.worldState,
      input.dialogue,
      input.worldId,
      input.playerEntityId,
    ),
  });
}

function requireSystemDialogueResponder(input: {
  readonly worldState: JsonObject;
  readonly dialogue: JsonObject;
  readonly worldId: string;
  readonly playerEntityId: string;
}): void {
  void input.worldState;
  if (
    expectString(input.dialogue, "status", "DialogueRecord") !==
    "active"
  ) {
    throw new EngineFault(
      "dialogue.orchestration.dialogue_not_active",
      "System dialogue can continue only while active",
      {
        dialogue_id: expectString(
          input.dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
      },
    );
  }
  const participants = asObjectArray(
    expectProperty(
      input.dialogue,
      "participants",
      "DialogueRecord",
    ),
    "DialogueRecord.participants",
  );
  if (participants.length !== 2) {
    throw new EngineFault(
      "dialogue.orchestration.system_participants_invalid",
      "System dialogue requires exactly the Session player and System",
      {
        dialogue_id: expectString(
          input.dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        participant_count: participants.length,
      },
    );
  }
  let systemCount = 0;
  let playerCount = 0;
  for (const participant of participants) {
    const participantKind = expectString(
      participant,
      "participant_kind",
      "DialogueParticipantRef",
    );
    if (participantKind === "system") {
      systemCount += 1;
      continue;
    }
    const entity = requireEntityParticipant(
      participant,
      "DialogueParticipantRef",
    );
    if (
      expectString(entity, "world_id", "EntityRef") ===
        input.worldId &&
      expectString(entity, "entity_id", "EntityRef") ===
        input.playerEntityId
    ) {
      playerCount += 1;
    }
  }
  if (systemCount !== 1 || playerCount !== 1) {
    throw new EngineFault(
      "dialogue.orchestration.system_participants_invalid",
      "System dialogue participants must be exactly one System and the Session player",
      {
        dialogue_id: expectString(
          input.dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        system_count: systemCount,
        player_count: playerCount,
      },
    );
  }
}

function responderParticipant(
  worldId: string,
  responder: DialogueResponder,
): JsonObject {
  return responder.responderKind === "director_system"
    ? Object.freeze({ participant_kind: "system" })
    : entityParticipant(worldId, responder.entityId);
}

function requireBasicNpcRecipient(
  worldState: JsonObject,
  participant: JsonObject,
  worldId: string,
  playerEntityId: string,
): string {
  if (
    expectString(
      participant,
      "participant_kind",
      "DialogueParticipantRef",
    ) !== "entity"
  ) {
    throw new EngineFault(
      "dialogue.orchestration.recipient_kind_unsupported",
      "Basic NPC dialogue requires an entity recipient",
      { participant_kind: participant["participant_kind"] as JsonValue },
    );
  }
  const entity = expectJsonObject(
    expectProperty(
      participant,
      "entity",
      "DialogueParticipantRef",
    ),
    "DialogueParticipantRef.entity",
  );
  const recipientWorldId = expectString(
    entity,
    "world_id",
    "EntityRef",
  );
  const recipientEntityId = expectString(
    entity,
    "entity_id",
    "EntityRef",
  );
  if (
    recipientWorldId !== worldId ||
    recipientEntityId === playerEntityId
  ) {
    throw new EngineFault(
      "dialogue.orchestration.recipient_identity_invalid",
      "Basic NPC recipient must be a different entity in the Session world",
      {
        world_id: worldId,
        recipient_world_id: recipientWorldId,
        player_entity_id: playerEntityId,
        recipient_entity_id: recipientEntityId,
      },
    );
  }
  requireActiveEntity(worldState, recipientEntityId);
  requireSingleActiveCharacterMindBinding(
    worldState,
    recipientEntityId,
  );
  return recipientEntityId;
}

function requireBasicNpcDialogueResponder(
  worldState: JsonObject,
  dialogue: JsonObject,
  worldId: string,
  playerEntityId: string,
  expectedRecipientEntityId?: string,
): string {
  if (expectString(dialogue, "status", "DialogueRecord") !== "active") {
    throw new EngineFault(
      "dialogue.orchestration.dialogue_not_active",
      "Basic NPC dialogue can continue only while active",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
      },
    );
  }
  const participants = asObjectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  );
  if (participants.length !== 2) {
    throw new EngineFault(
      "dialogue.orchestration.responder_ambiguous",
      "Basic NPC dialogue requires exactly two entity participants",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        participant_count: participants.length,
      },
    );
  }
  const entityIds = participants.map((participant) => {
    if (
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) !== "entity"
    ) {
      throw new EngineFault(
        "dialogue.orchestration.responder_ambiguous",
        "Basic NPC dialogue does not infer a responder from a System participant",
        {
          dialogue_id: expectString(
            dialogue,
            "dialogue_id",
            "DialogueRecord",
          ),
        },
      );
    }
    const entity = expectJsonObject(
      expectProperty(
        participant,
        "entity",
        "DialogueParticipantRef",
      ),
      "DialogueParticipantRef.entity",
    );
    if (expectString(entity, "world_id", "EntityRef") !== worldId) {
      throw new EngineFault(
        "dialogue.orchestration.participant_world_mismatch",
        "Dialogue participant belongs to a different world",
        {
          dialogue_id: expectString(
            dialogue,
            "dialogue_id",
            "DialogueRecord",
          ),
        },
      );
    }
    return expectString(entity, "entity_id", "EntityRef");
  });
  if (!entityIds.includes(playerEntityId)) {
    throw new EngineFault(
      "dialogue.orchestration.player_not_participant",
      "Engine Session player must be a participant in the dialogue",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        player_entity_id: playerEntityId,
      },
    );
  }
  const responderIds = entityIds.filter(
    (entityId) => entityId !== playerEntityId,
  );
  if (responderIds.length !== 1) {
    throw new EngineFault(
      "dialogue.orchestration.responder_ambiguous",
      "Basic NPC dialogue must have exactly one non-player responder",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
      },
    );
  }
  const responderId = responderIds[0] as string;
  if (
    expectedRecipientEntityId !== undefined &&
    responderId !== expectedRecipientEntityId
  ) {
    throw new EngineFault(
      "dialogue.orchestration.responder_changed",
      "Dialogue responder changed between human and character stages",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        expected_entity_id: expectedRecipientEntityId,
        actual_entity_id: responderId,
      },
    );
  }
  requireActiveEntity(worldState, responderId);
  requireSingleActiveCharacterMindBinding(worldState, responderId);
  return responderId;
}

function requireActiveEntity(
  worldState: JsonObject,
  entityId: string,
): void {
  const matches = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  ).filter(
    (entity) =>
      expectString(entity, "entity_id", "EntityState") === entityId,
  );
  if (
    matches.length !== 1 ||
    expectString(
      matches[0] as JsonObject,
      "state",
      "EntityState",
    ) !== "active"
  ) {
    throw new EngineFault(
      "dialogue.orchestration.recipient_unavailable",
      "NPC recipient must resolve to exactly one active entity",
      { entity_id: entityId, matches: matches.length },
    );
  }
}

function requireSingleActiveCharacterMindBinding(
  worldState: JsonObject,
  entityId: string,
): void {
  const matches = asObjectArray(
    expectProperty(
      worldState,
      "control_bindings",
      "WorldState",
    ),
    "WorldState.control_bindings",
  ).filter(
    (binding) =>
      expectString(binding, "binding_kind", "ControlBinding") ===
        "character_mind" &&
      expectString(binding, "entity_id", "ControlBinding") ===
        entityId &&
      expectString(binding, "status", "ControlBinding") === "active",
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "dialogue.orchestration.character_mind_binding_count",
      "NPC recipient must have exactly one active CharacterMind ControlBinding",
      { entity_id: entityId, matches: matches.length },
    );
  }
}

function requireDialogue(
  worldState: JsonObject,
  dialogueId: string,
): JsonObject {
  const matches = asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  ).filter(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueRecord") ===
      dialogueId,
  );
  if (matches.length !== 1) {
    throw new EngineFault(
      "dialogue.orchestration.dialogue_match",
      "Dialogue identity must resolve to exactly one WorldState record",
      { dialogue_id: dialogueId, matches: matches.length },
    );
  }
  return matches[0] as JsonObject;
}

function resolveRecipientFromHumanInput(
  input: JsonObject,
  worldState: JsonObject,
  command: StoredReceivedCommand,
): DialogueResponder {
  const execution = requireDialogueExecution(command);
  if (
    expectString(
      input,
      "dialogue_id",
      "DialogueOperationInput",
    ) !== execution.dialogueId
  ) {
    throw new EngineFault(
      "dialogue.orchestration.human_receipt_identity_mismatch",
      "Recovered human RulePlugin receipt belongs to a different dialogue",
      {
        command_id: command.commandId,
        dialogue_id: execution.dialogueId,
      },
    );
  }
  if (command.commandKind === "dialogue.start") {
    const recipient = expectJsonObject(
      expectProperty(
        command.message,
        "recipient",
        "DialogueStart",
      ),
      "DialogueStart.recipient",
    );
    const responder = requireDialogueStartResponder({
      worldState,
      participant: recipient,
      worldId: command.session.worldId,
      playerEntityId: command.session.playerEntityId,
    });
    const participantSource = expectProperty(
      input,
      "participants",
      "DialogueOpenInput",
    );
    const expectedParticipants = [
      entityParticipant(
        command.session.worldId,
        command.session.playerEntityId,
      ),
      responderParticipant(
        command.session.worldId,
        responder,
      ),
    ];
    const dayCycle = expectJsonObject(
      expectProperty(worldState, "day_cycle", "WorldState"),
      "WorldState.day_cycle",
    );
    if (
      !jsonEquals(participantSource, expectedParticipants) ||
      expectInteger(input, "day", "DialogueOpenInput") !==
        expectInteger(dayCycle, "day", "DayCycleState")
    ) {
      throw commandIdentityFault(
        command,
        "Recovered DialogueOpen request differs from its command recipient or world day",
        {},
      );
    }
    return responder;
  }

  const dialogue = requireDialogue(worldState, execution.dialogueId);
  if (
    expectInteger(
      input,
      "expected_revision",
      "DialogueTurnAppendInput",
    ) !== expectInteger(dialogue, "revision", "DialogueRecord")
  ) {
    throw commandIdentityFault(
      command,
      "Recovered human append request uses a different dialogue revision",
      {},
    );
  }
  return requireDialogueResponder({
    worldState,
    dialogue,
    worldId: command.session.worldId,
    playerEntityId: command.session.playerEntityId,
  });
}

function assertCharacterModelReceiptIdentity(
  command: StoredReceivedCommand,
  recipientEntityId: string,
  receipt: Awaited<
    ReturnType<RuntimeModelFacades["characterDialogue"]>
  >,
): void {
  const execution = requireDialogueExecution(command);
  const expectedWorldRevision = command.session.worldRevision + 1;
  const request = receipt.request.value;
  const proof = receipt.proof.value;
  const snapshot = receipt.snapshot.value;
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
    expectProperty(
      dynamicInput,
      "dialogue",
      "CharacterDialogueInput",
    ),
    "CharacterDialogueInput.dialogue",
  );
  const dialogueTurns = asObjectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const latestTurn = dialogueTurns[dialogueTurns.length - 1];
  if (
    receipt.worldId !== command.session.worldId ||
    receipt.worldRevision !== expectedWorldRevision ||
    expectString(snapshot, "world_id", "WorldSnapshot") !==
      command.session.worldId ||
    expectInteger(snapshot, "world_revision", "WorldSnapshot") !==
      expectedWorldRevision ||
    expectString(request, "request_id", "ModelRequest") !==
      execution.characterModelRequestId ||
    expectString(request, "request_kind", "ModelRequest") !==
      "character.dialogue" ||
    expectInteger(request, "basis_revision", "ModelRequest") !==
      expectedWorldRevision ||
    expectString(character, "world_id", "EntityRef") !==
      command.session.worldId ||
    expectString(character, "entity_id", "EntityRef") !==
      recipientEntityId ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      execution.dialogueId ||
    latestTurn === undefined ||
    expectString(latestTurn, "turn_id", "DialogueTurn") !==
      execution.humanTurnId ||
    expectString(proof, "request_id", "VerifiedModelOutputRef") !==
      execution.characterModelRequestId ||
    expectString(proof, "request_kind", "VerifiedModelOutputRef") !==
      "character.dialogue" ||
    expectInteger(proof, "basis_revision", "VerifiedModelOutputRef") !==
      expectedWorldRevision
  ) {
    throw commandIdentityFault(
      command,
      "Character model receipt differs from its command-owned dialogue stage",
      {
        expected_request_id: execution.characterModelRequestId,
        expected_world_revision: expectedWorldRevision,
        recipient_entity_id: recipientEntityId,
      },
    );
  }
}

function assertDirectorDialogueReceiptIdentity(input: {
  readonly command: StoredReceivedCommand;
  readonly requestId: string;
  readonly receipt: Awaited<
    ReturnType<RuntimeModelFacades["directorDialogueEvents"]>
  >;
  readonly expectedBasisRevision: number;
}): void {
  const execution = requireDialogueExecution(input.command);
  const request = input.receipt.request.value;
  const proof = input.receipt.proof.value;
  const snapshot = input.receipt.snapshot.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const dialogue = expectJsonObject(
    expectProperty(
      dynamicInput,
      "dialogue",
      "DirectorDialogueEventsInput",
    ),
    "DirectorDialogueEventsInput.dialogue",
  );
  if (
    input.receipt.worldId !== input.command.session.worldId ||
    input.receipt.worldRevision !== input.expectedBasisRevision ||
    expectString(snapshot, "world_id", "WorldSnapshot") !==
      input.command.session.worldId ||
    expectInteger(snapshot, "world_revision", "WorldSnapshot") !==
      input.expectedBasisRevision ||
    expectString(request, "request_id", "ModelRequest") !==
      input.requestId ||
    expectString(request, "request_kind", "ModelRequest") !==
      "director.dialogue_events" ||
    expectInteger(request, "basis_revision", "ModelRequest") !==
      input.expectedBasisRevision ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      execution.dialogueId ||
    expectString(proof, "request_id", "VerifiedModelOutputRef") !==
      input.requestId ||
    expectString(proof, "request_kind", "VerifiedModelOutputRef") !==
      "director.dialogue_events" ||
    expectInteger(proof, "basis_revision", "VerifiedModelOutputRef") !==
      input.expectedBasisRevision
  ) {
    throw commandIdentityFault(
      input.command,
      "Director dialogue-events receipt differs from its command-owned identity",
      {
        expected_request_id: input.requestId,
        expected_world_revision: input.expectedBasisRevision,
        dialogue_id: execution.dialogueId,
      },
    );
  }
}

function readModelOutput(
  receipt: VerifiedModelInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(
      receipt.response.value,
      "output",
      "ModelResponse",
    ),
    "ModelResponse.output",
  );
}

function rulePluginRequestInput(
  receipt: VerifiedRulePluginInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(
      receipt.request.value,
      "input",
      "RulePluginRequest",
    ),
    "RulePluginRequest.input",
  );
}

function worldStateFromSnapshot(snapshot: JsonObject): JsonObject {
  return expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
}

/**
 * EventBudget remaining for the session control on the world's current day.
 * Matches SessionView arithmetic: capacity - sum(charge cost amounts).
 * Missing or ambiguous budget is a hard fault (player phase must own exactly one).
 * Dialogue entry requires remaining > 0; remaining === 0 means day-end only.
 */
function readEventBudgetRemaining(
  worldState: JsonObject,
  controlBindingId: string,
): number {
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const day = expectInteger(dayCycle, "day", "DayCycleState");
  const matches = asObjectArray(
    expectProperty(worldState, "event_budgets", "WorldState"),
    "WorldState.event_budgets",
  ).filter((budget) => {
    const control = expectJsonObject(
      expectProperty(budget, "control", "EventBudgetState"),
      "EventBudgetState.control",
    );
    return (
      expectInteger(budget, "day", "EventBudgetState") === day &&
      expectString(control, "binding_id", "ControlBindingRef") ===
        controlBindingId
    );
  });
  if (matches.length !== 1) {
    throw new EngineFault(
      "dialogue.orchestration.event_budget_match",
      "Current day and control binding must resolve to exactly one event budget before dialogue_events",
      {
        day,
        control_binding_id: controlBindingId,
        matches: matches.length,
      },
    );
  }
  const budget = matches[0] as JsonObject;
  const capacity = expectInteger(budget, "capacity", "EventBudgetState");
  const spent = asObjectArray(
    expectProperty(budget, "charges", "EventBudgetState"),
    "EventBudgetState.charges",
  ).reduce((total, charge) => {
    const cost = expectJsonObject(
      expectProperty(charge, "cost", "EventCharge"),
      "EventCharge.cost",
    );
    return total + expectInteger(cost, "amount", "EventCost");
  }, 0);
  const remaining = capacity - spent;
  if (remaining < 0) {
    throw new EngineFault(
      "dialogue.orchestration.event_budget_negative",
      "Event budget charges exceed its capacity",
      { capacity, spent, remaining },
    );
  }
  return remaining;
}

function requireSystemRunIdentity(
  command: StoredReceivedCommand,
  value: string | undefined,
  identity: string,
): string {
  if (value === undefined) {
    throw commandIdentityFault(
      command,
      "Director System run is missing a required persisted identity",
      { identity },
    );
  }
  return value;
}

function readDialogueInteractionKind(
  command: StoredReceivedCommand,
): DialogueInteractionKind {
  const value = expectString(
    command.message,
    "interaction_kind",
    command.commandKind,
  );
  if (
    value !== "dialogue" &&
    value !== "goal_plan" &&
    value !== "definition_draft"
  ) {
    throw commandIdentityFault(
      command,
      "Dialogue command contains an unknown interaction_kind",
      { interaction_kind: value },
    );
  }
  return value;
}

function readDialogueCommandText(
  command: StoredReceivedCommand,
): string {
  return expectString(command.message, "text", command.commandKind);
}

function readDialogueCommandLocale(
  command: StoredReceivedCommand,
): string {
  return expectString(command.message, "locale", command.commandKind);
}

function assertNextCommittedRevision(input: {
  readonly command: StoredReceivedCommand;
  readonly committed: JsonObject;
  readonly currentWorldRevision: number;
  readonly stage: string;
  readonly proposalId: string;
}): number {
  const nextRevision = input.currentWorldRevision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw new EngineFault(
      "dialogue.orchestration.world_revision_exhausted",
      "System proposal cannot advance world revision safely",
      {
        session_id: input.command.session.sessionId,
        command_id: input.command.commandId,
        stage: input.stage,
        world_revision: input.currentWorldRevision,
      },
    );
  }
  const actualRevision = expectInteger(
    input.committed,
    "world_revision",
    "ApplyPacketResult",
  );
  if (actualRevision !== nextRevision) {
    throw commandIdentityFault(
      input.command,
      "System proposal returned an unexpected committed world revision",
      {
        stage: input.stage,
        proposal_id: input.proposalId,
        expected_world_revision: nextRevision,
        actual_world_revision: actualRevision,
      },
    );
  }
  return nextRevision;
}

function materializeDefinitionCandidate(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly modelReceipt: VerifiedModelInvocationReceipt;
  readonly proposalId: string;
  readonly draft: JsonObject;
}): JsonObject {
  const selectionSpace = requirePlanningSelectionSpace({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    command: input.command,
  });
  const requestInput = modelRequestInput(input.modelReceipt);
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorDefinitionDraftInput",
  );
  const purpose = expectString(
    requestInput,
    "purpose",
    "DirectorDefinitionDraftInput",
  );
  const definitionType = materializePlanningCatalogIndex({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    command: input.command,
    owner: input.draft,
    indexField: "definition_type_index",
    selectorLabel: "DynamicDefinitionSemanticDraft",
    entries: selectionSpace.definitionTypes,
    entryLabel: "TypeDefinition",
    localIdField: "type_id",
    expectedKind: "definition_type",
  });
  const components = asObjectArray(
    expectProperty(
      input.draft,
      "components",
      "DynamicDefinitionSemanticDraft",
    ),
    "DynamicDefinitionSemanticDraft.components",
  ).map((component, ordinal) =>
    Object.freeze({
      component_type: materializePlanningCatalogIndex({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        command: input.command,
        owner: component,
        indexField: "component_type_index",
        selectorLabel: "DefinitionComponentSemanticDraft",
        entries: selectionSpace.componentTypes,
        entryLabel: "TypeDefinition",
        localIdField: "type_id",
        expectedKind: "component_type",
      }),
      ordinal,
      value: expectJsonObject(
        expectProperty(
          component,
          "value",
          "DefinitionComponentSemanticDraft",
        ),
        "DefinitionComponentSemanticDraft.value",
      ),
    }),
  );
  return Object.freeze({
    proposal_id: input.proposalId,
    purpose: localizedText(locale, purpose),
    draft: Object.freeze({
      definition_type: definitionType,
      name: localizedText(
        locale,
        expectString(
          input.draft,
          "name",
          "DynamicDefinitionSemanticDraft",
        ),
      ),
      summary: localizedText(
        locale,
        expectString(
          input.draft,
          "summary",
          "DynamicDefinitionSemanticDraft",
        ),
      ),
      components: Object.freeze(components),
      rationale: expectString(
        input.draft,
        "rationale",
        "DynamicDefinitionSemanticDraft",
      ),
    }),
  });
}

function materializeGoalPlanCandidate(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly modelReceipt: VerifiedModelInvocationReceipt;
  readonly proposalId: string;
  readonly ownerActorId: string;
  readonly draft: JsonObject;
  readonly localIds: DialogueLocalIdFactory;
}): JsonObject {
  const selectionSpace = requirePlanningSelectionSpace({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    command: input.command,
  });
  const requestInput = modelRequestInput(input.modelReceipt);
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorGoalPlanInput",
  );
  const worldView = expectJsonObject(
    expectProperty(
      requestInput,
      "world_view",
      "DirectorGoalPlanInput",
    ),
    "DirectorGoalPlanInput.world_view",
  );
  const knowledgeView = expectJsonObject(
    expectProperty(
      requestInput,
      "knowledge_view",
      "DirectorGoalPlanInput",
    ),
    "DirectorGoalPlanInput.knowledge_view",
  );
  if (
    expectString(
      knowledgeView,
      "viewer_entity_id",
      "KnowledgeView",
    ) !== input.ownerActorId
  ) {
    throw commandIdentityFault(
      input.command,
      "Goal-plan owner must be the exact verified knowledge-view owner",
      { owner_actor_id: input.ownerActorId },
    );
  }
  const nodes = asObjectArray(
    expectProperty(
      input.draft,
      "nodes",
      "GoalPlanSemanticDraft",
    ),
    "GoalPlanSemanticDraft.nodes",
  );
  const nodeKey = (ordinal: number): string => `node_${ordinal}`;
  const materializedNodes = nodes.map((node, ordinal) => {
    const requirement = expectJsonObject(
      expectProperty(
        node,
        "capability_requirement",
        "GoalNodeSemanticDraft",
      ),
      "GoalNodeSemanticDraft.capability_requirement",
    );
    const requirementKind = expectString(
      requirement,
      "requirement_kind",
      "CapabilityRequirementSelector",
    );
    const capabilityRequirement =
      requirementKind === "bound"
        ? Object.freeze({
            requirement_kind: "bound",
            capability: materializePlanningCatalogIndex({
              catalog: input.catalog,
              contentBinding: input.contentBinding,
              command: input.command,
              owner: requirement,
              indexField: "capability_index",
              selectorLabel: "CapabilityRequirementSelector",
              entries: selectionSpace.capabilities,
              entryLabel: "Capability",
              localIdField: "capability_id",
              expectedKind: "capability",
            }),
          })
        : materializeCapabilityDemand({
            catalog: input.catalog,
            contentBinding: input.contentBinding,
            command: input.command,
            selectionSpace,
            locale,
            localIds: input.localIds,
            requirement,
          });
    return Object.freeze({
      node_key: nodeKey(ordinal),
      title: localizedText(
        locale,
        expectString(node, "title", "GoalNodeSemanticDraft"),
      ),
      capability_requirement: capabilityRequirement,
      arguments: expectJsonObject(
        expectProperty(
          node,
          "arguments",
          "GoalNodeSemanticDraft",
        ),
        "GoalNodeSemanticDraft.arguments",
      ),
      depends_on: Object.freeze(
        readModelIndices(
          node,
          "depends_on",
          "GoalNodeSemanticDraft",
          nodes.length,
        ).map(nodeKey),
      ),
      completion_rules: materializeWorldLawIndices({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        command: input.command,
        owner: node,
        indexField: "completion_rule_indices",
        selectorLabel: "GoalNodeSemanticDraft",
        laws: selectionSpace.worldLaws,
      }),
      alternative_node_keys: Object.freeze(
        readModelIndices(
          node,
          "alternatives",
          "GoalNodeSemanticDraft",
          nodes.length,
        ).map(nodeKey),
      ),
    });
  });
  const factRefs = asObjectArray(
    expectProperty(
      input.draft,
      "facts",
      "GoalPlanSemanticDraft",
    ),
    "GoalPlanSemanticDraft.facts",
  ).map((selector, ordinal) =>
    materializeFactSelector({
      selector,
      ordinal,
      worldView,
      knowledgeView,
      command: input.command,
    }),
  );
  if (new Set(factRefs).size !== factRefs.length) {
    throw commandIdentityFault(
      input.command,
      "Goal-plan fact selectors resolve to duplicate authoritative facts",
      {},
    );
  }
  return Object.freeze({
    proposal_id: input.proposalId,
    owner_actor_id: input.ownerActorId,
    draft: Object.freeze({
      goal: localizedText(
        locale,
        expectString(input.draft, "goal", "GoalPlanSemanticDraft"),
      ),
      expected_state: expectJsonObject(
        expectProperty(
          input.draft,
          "expected_state",
          "GoalPlanSemanticDraft",
        ),
        "GoalPlanSemanticDraft.expected_state",
      ),
      fact_refs: Object.freeze(factRefs),
      constraints: materializeWorldLawIndices({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        command: input.command,
        owner: input.draft,
        indexField: "constraint_law_indices",
        selectorLabel: "GoalPlanSemanticDraft",
        laws: selectionSpace.worldLaws,
      }),
      nodes: Object.freeze(materializedNodes),
      knowledge_scope: expectString(
        input.draft,
        "knowledge_scope",
        "GoalPlanSemanticDraft",
      ),
    }),
  });
}

function materializeEventCardCandidate(input: {
  readonly command: StoredReceivedCommand;
  readonly modelReceipt: VerifiedModelInvocationReceipt;
  readonly worldState: JsonObject;
  readonly contentBinding: WorldContentBinding;
  readonly proposalId: string;
  readonly draft: JsonObject;
  readonly localIds: DialogueLocalIdFactory;
}): JsonObject {
  const requestInput = modelRequestInput(input.modelReceipt);
  const worldView = expectJsonObject(
    expectProperty(
      requestInput,
      "world_view",
      "DirectorDialogueEventsInput",
    ),
    "DirectorDialogueEventsInput.world_view",
  );
  const dialogue = expectJsonObject(
    expectProperty(
      requestInput,
      "dialogue",
      "DirectorDialogueEventsInput",
    ),
    "DirectorDialogueEventsInput.dialogue",
  );
  const locale = expectString(
    requestInput,
    "response_locale",
    "DirectorDialogueEventsInput",
  );
  const actors = asObjectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const stages = asObjectArray(
    expectProperty(worldView, "stages", "DirectorWorldView"),
    "DirectorWorldView.stages",
  );
  const situationDraft = expectJsonObject(
    expectProperty(
      input.draft,
      "situation",
      "EventCardSemanticDraft",
    ),
    "EventCardSemanticDraft.situation",
  );
  const situationActorIndices = readModelIndices(
    situationDraft,
    "subject_actor_indices",
    "EventSituationSemanticDraft",
    actors.length,
  );
  const situationActorSet = new Set(situationActorIndices);
  const optionDrafts = asObjectArray(
    expectProperty(
      input.draft,
      "result_options",
      "EventCardSemanticDraft",
    ),
    "EventCardSemanticDraft.result_options",
  );
  // Server: omit → []; zero transcript commitments → [] (drop invented gates).
  const gateDrafts = effectiveEventCardAgencyGates(input.draft, dialogue, {
    actors,
    stages,
  });
  const gateIds = gateDrafts.map((_, ordinal) => `gate_${ordinal}`);
  const flatOutcomeDraftsRaw = optionDrafts.flatMap((option) =>
    asObjectArray(
      expectProperty(
        option,
        "outcomes",
        "EventCardOutcomeSemanticDraft",
      ),
      "EventCardOutcomeSemanticDraft.outcomes",
    ),
  );
  const subjectClosed = withEffectiveOutcomeSubjects(
    flatOutcomeDraftsRaw,
    situationActorIndices,
    actors.length,
  );
  const { outcomes: flatOutcomeDrafts } = closeAgencyGateOutcomeLinks(
    subjectClosed,
    gateDrafts,
  );
  const outcomeIds = flatOutcomeDrafts.map(
    (_, ordinal) => `outcome_${ordinal}`,
  );
  let flatOutcomeOrdinal = 0;
  const resultOptions = optionDrafts.map((option, optionOrdinal) => {
    const rawOptionOutcomes = asObjectArray(
      expectProperty(
        option,
        "outcomes",
        "EventCardOutcomeSemanticDraft",
      ),
      "EventCardOutcomeSemanticDraft.outcomes",
    );
    const outcomes = rawOptionOutcomes.map(() => {
      const outcome = flatOutcomeDrafts[flatOutcomeOrdinal];
      const outcomeId = outcomeIds[flatOutcomeOrdinal];
      if (outcome === undefined || outcomeId === undefined) {
        throw commandIdentityFault(
          input.command,
          "EventCard outcome ordinal cannot be materialized",
          { outcome_ordinal: flatOutcomeOrdinal },
        );
      }
      const candidate = materializeSemanticOutcomeCandidate({
        command: input.command,
        worldId: input.command.session.worldId,
        worldState: input.worldState,
        actors,
        allowedActorIndices: situationActorSet,
        draft: outcome,
        outcomeId,
        gateIds,
      });
      flatOutcomeOrdinal += 1;
      return candidate;
    });
    const presentationDraft = expectJsonObject(
      expectProperty(
        option,
        "presentation",
        "EventCardOutcomeSemanticDraft",
      ),
      "EventCardOutcomeSemanticDraft.presentation",
    );
    return Object.freeze({
      option_id: `option_${optionOrdinal}`,
      outcomes: Object.freeze(outcomes),
      presentation: Object.freeze({
        presentation_id: input.localIds.createId(),
        segments: materializeNarrativeSegments({
          command: input.command,
          dialogue,
          locale,
          value: expectProperty(
            presentationDraft,
            "segments",
            "EventResultPresentationSemanticDraft",
          ),
        }),
      }),
    });
  });
  const agencyGates = gateDrafts.map((gate, gateOrdinal) => {
    const gateId = gateIds[gateOrdinal];
    if (gateId === undefined) {
      throw commandIdentityFault(
        input.command,
        "EventCard gate ordinal cannot be materialized",
        { gate_ordinal: gateOrdinal },
      );
    }
    return Object.freeze({
      gate_id: gateId,
      protected_outcome_ids: Object.freeze(
        readModelIndices(
          gate,
          "protected_outcome_indices",
          "EventCardAgencyGateSemanticDraft",
          outcomeIds.length,
        ).map((ordinal) => outcomeIds[ordinal] as string),
      ),
      participants: materializeActorSubjects({
        command: input.command,
        worldId: input.command.session.worldId,
        worldState: input.worldState,
        actors,
        indices: readModelIndices(
          gate,
          "participant_subject_indices",
          "EventCardAgencyGateSemanticDraft",
          actors.length,
        ),
        allowedActorIndices: situationActorSet,
      }).map(subjectEntityRef),
      requirement: materializeAgencyRequirementCandidate({
        command: input.command,
        worldId: input.command.session.worldId,
        worldState: input.worldState,
        actors,
        allowedActorIndices: situationActorSet,
        draft: expectJsonObject(
          expectProperty(
            gate,
            "requirement",
            "EventCardAgencyGateSemanticDraft",
          ),
          "EventCardAgencyGateSemanticDraft.requirement",
        ),
      }),
      policy: expectJsonObject(
        expectProperty(
          gate,
          "policy",
          "EventCardAgencyGateSemanticDraft",
        ),
        "EventCardAgencyGateSemanticDraft.policy",
      ),
      // Evidence is Server-assembled from transcript only (same ordinals the
      // event model already saw as read-only agency_commitments projection).
      commitment_evidence: materializeCommitmentEvidence({
        command: input.command,
        dialogue,
        value: listDialogueCommitmentSelectors(dialogue),
      }),
    });
  });
  const dayCycle = expectJsonObject(
    expectProperty(input.worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  return Object.freeze({
    proposal_id: input.proposalId,
    source_dialogue_id: requireDialogueExecution(input.command).dialogueId,
    day: expectInteger(dayCycle, "day", "DayCycleState"),
    situation: Object.freeze({
      event_type: expectString(
        situationDraft,
        "event_type",
        "EventSituationSemanticDraft",
      ),
      summary: localizedText(
        locale,
        expectString(
          situationDraft,
          "summary",
          "EventSituationSemanticDraft",
        ),
      ),
      subjects: materializeActorSubjects({
        command: input.command,
        worldId: input.command.session.worldId,
        worldState: input.worldState,
        actors,
        indices: situationActorIndices,
      }),
      // Server-owned empty bag: never take model world_view echo as context.
      context: Object.freeze({}),
    }),
    title: localizedText(
      locale,
      expectString(input.draft, "title", "EventCardSemanticDraft"),
    ),
    summary: localizedText(
      locale,
      expectString(input.draft, "summary", "EventCardSemanticDraft"),
    ),
    result_options: Object.freeze(resultOptions),
    agency_gates: Object.freeze(agencyGates),
    staging: materializeEventCardStaging({
      command: input.command,
      worldId: input.command.session.worldId,
      worldState: input.worldState,
      contentBinding: input.contentBinding,
      actors,
      stages,
      situationActorSet,
      locale,
      draft: expectJsonObject(
        expectProperty(input.draft, "staging", "EventCardSemanticDraft"),
        "EventCardSemanticDraft.staging",
      ),
    }),
  });
}

function materializeEventCardStaging(input: {
  readonly command: StoredReceivedCommand;
  readonly worldId: string;
  readonly worldState: JsonObject;
  readonly contentBinding: WorldContentBinding;
  readonly actors: readonly JsonObject[];
  readonly stages: readonly JsonObject[];
  readonly situationActorSet: ReadonlySet<number>;
  readonly locale: string;
  readonly draft: JsonObject;
}): JsonObject {
  const stagingKind = expectString(
    input.draft,
    "staging_kind",
    "EventCardStagingSemanticDraft",
  );
  if (stagingKind === "none") {
    return Object.freeze({ staging_kind: "none" });
  }
  if (stagingKind === "prefab_bind") {
    const stageIndex = expectInteger(
      input.draft,
      "stage_index",
      "EventCardStagingSemanticDraft",
    );
    if (
      !Number.isSafeInteger(stageIndex) ||
      stageIndex < 0 ||
      stageIndex >= input.stages.length ||
      stageIndex >= input.contentBinding.stages.length
    ) {
      throw commandIdentityFault(
        input.command,
        "EventCard prefab_bind stage_index is outside DirectorWorldView.stages",
        {
          stage_index: stageIndex,
          stage_count: input.stages.length,
        },
      );
    }
    const catalogEntry = input.contentBinding.stages[stageIndex] as JsonObject;
    const projected = input.stages[stageIndex] as JsonObject;
    const entryModeIndex = expectInteger(
      input.draft,
      "entry_mode_index",
      "EventCardStagingSemanticDraft",
    );
    const catalogEntryModes = asObjectArray(
      expectProperty(catalogEntry, "entry_modes", "StageCatalogEntry"),
      "StageCatalogEntry.entry_modes",
    );
    const projectedEntryModes = asObjectArray(
      expectProperty(projected, "entry_modes", "DirectorStageCatalogView"),
      "DirectorStageCatalogView.entry_modes",
    );
    const catalogEntryMode = catalogEntryModes[entryModeIndex];
    const projectedEntryMode = projectedEntryModes[entryModeIndex];
    if (catalogEntryMode === undefined || projectedEntryMode === undefined) {
      throw commandIdentityFault(
        input.command,
        "EventCard prefab_bind entry_mode_index is outside the selected stage",
        { stage_index: stageIndex, entry_mode_index: entryModeIndex },
      );
    }
    if (
      expectString(catalogEntry, "stage_kind", "StageCatalogEntry") !==
        expectString(projected, "stage_kind", "DirectorStageCatalogView") ||
      expectString(
        catalogEntryMode,
        "npc_participation",
        "StageEntryMode",
      ) !==
        expectString(
          projectedEntryMode,
          "npc_participation",
          "DirectorStageEntryModeView",
        )
    ) {
      throw commandIdentityFault(
        input.command,
        "EventCard prefab_bind stage_index does not match locked StageCatalogEntry projection",
        { stage_index: stageIndex },
      );
    }
    const staging: Record<string, JsonValue> = {
      staging_kind: "prefab_bind",
      entry_mode_id: expectString(
        catalogEntryMode,
        "entry_mode_id",
        "StageEntryMode",
      ),
      stage: Object.freeze({
        bundle_id: input.contentBinding.packId,
        bundle_digest: input.contentBinding.bundleDigest,
        catalog_kind: "stage",
        local_id: expectString(catalogEntry, "stage_id", "StageCatalogEntry"),
      }),
    };
    if (input.draft.participant_actor_indices !== undefined) {
      staging.participants = Object.freeze(
        materializeActorSubjects({
          command: input.command,
          worldId: input.worldId,
          worldState: input.worldState,
          actors: input.actors,
          indices: readModelIndices(
            input.draft,
            "participant_actor_indices",
            "EventCardStagingSemanticDraft",
            input.actors.length,
          ),
          allowedActorIndices: input.situationActorSet,
        }).map(subjectEntityRef),
      );
    }
    return Object.freeze(staging);
  }
  if (stagingKind !== "improv") {
    throw commandIdentityFault(
      input.command,
      "EventCard staging_kind is not a closed EventCardStagingSemanticDraft branch",
      { staging_kind: stagingKind },
    );
  }
  const improvStageId = expectString(
    input.contentBinding.worldDefinition,
    "improv_stage_id",
    "WorldDefinition",
  );
  const improvEntry = input.contentBinding.stages.find(
    (stage) =>
      expectString(stage, "stage_id", "StageCatalogEntry") === improvStageId,
  );
  if (improvEntry === undefined) {
    throw commandIdentityFault(
      input.command,
      "WorldDefinition.improv_stage_id is absent from locked StageCatalogEntry list",
      { improv_stage_id: improvStageId },
    );
  }
  const participantIndices = readModelIndices(
    input.draft,
    "participant_actor_indices",
    "ImprovStageSemanticDraft",
    input.actors.length,
  );
  const participantSet = new Set(participantIndices);
  const beats = asObjectArray(
    expectProperty(input.draft, "beats", "ImprovStageSemanticDraft"),
    "ImprovStageSemanticDraft.beats",
  ).map((beat) => {
    const materialized: Record<string, JsonValue> = {
      summary: localizedText(
        input.locale,
        expectString(beat, "summary", "ImprovBeatSemanticDraft"),
      ),
    };
    if (beat.focus_actor_indices !== undefined) {
      materialized.focus = Object.freeze(
        materializeActorSubjects({
          command: input.command,
          worldId: input.worldId,
          worldState: input.worldState,
          actors: input.actors,
          indices: readModelIndices(
            beat,
            "focus_actor_indices",
            "ImprovBeatSemanticDraft",
            input.actors.length,
          ),
          allowedActorIndices: participantSet,
        }).map(subjectEntityRef),
      );
    }
    return Object.freeze(materialized);
  });
  const choices = asObjectArray(
    expectProperty(input.draft, "choices", "ImprovStageSemanticDraft"),
    "ImprovStageSemanticDraft.choices",
  ).map((choice, choiceOrdinal) => {
    const sealedIntents = asObjectArray(
      expectProperty(choice, "sealed_intents", "ImprovChoiceSemanticDraft"),
      "ImprovChoiceSemanticDraft.sealed_intents",
    ).map((intent, intentOrdinal) =>
      materializeSemanticOutcomeCandidate({
        command: input.command,
        worldId: input.worldId,
        worldState: input.worldState,
        actors: input.actors,
        allowedActorIndices: participantSet,
        draft: intent,
        outcomeId: `improv_choice_${choiceOrdinal}_intent_${intentOrdinal}`,
        gateIds: [],
      }),
    );
    return Object.freeze({
      label: localizedText(
        input.locale,
        expectString(choice, "label", "ImprovChoiceSemanticDraft"),
      ),
      sealed_intents: Object.freeze(sealedIntents),
    });
  });
  return Object.freeze({
    staging_kind: "improv",
    stage: Object.freeze({
      bundle_id: input.contentBinding.packId,
      bundle_digest: input.contentBinding.bundleDigest,
      catalog_kind: "stage",
      local_id: improvStageId,
    }),
    premise: localizedText(
      input.locale,
      expectString(input.draft, "premise", "ImprovStageSemanticDraft"),
    ),
    participants: Object.freeze(
      materializeActorSubjects({
        command: input.command,
        worldId: input.worldId,
        worldState: input.worldState,
        actors: input.actors,
        indices: participantIndices,
      }).map(subjectEntityRef),
    ),
    beats: Object.freeze(beats),
    choices: Object.freeze(choices),
  });
}

function materializeSemanticOutcomeCandidate(input: {
  readonly command: StoredReceivedCommand;
  readonly worldId: string;
  readonly worldState: JsonObject;
  readonly actors: readonly JsonObject[];
  readonly allowedActorIndices: ReadonlySet<number>;
  readonly draft: JsonObject;
  readonly outcomeId: string;
  readonly gateIds: readonly string[];
}): JsonObject {
  const gateIndex = input.draft["requires_agency_gate_index"];
  let gateId: string | undefined;
  if (gateIndex !== undefined) {
    if (
      typeof gateIndex !== "number" ||
      !Number.isSafeInteger(gateIndex) ||
      gateIndex < 0 ||
      gateIndex >= input.gateIds.length
    ) {
      throw commandIdentityFault(
        input.command,
        "Outcome agency-gate selector is outside the verified gate collection",
        { gate_index: gateIndex as JsonValue },
      );
    }
    gateId = input.gateIds[gateIndex];
  }
  return Object.freeze({
    outcome_id: input.outcomeId,
    outcome_type: expectString(
      input.draft,
      "outcome_type",
      "SemanticOutcomeDraft",
    ),
    subjects: materializeActorSubjects({
      command: input.command,
      worldId: input.worldId,
      worldState: input.worldState,
      actors: input.actors,
      indices: readModelIndices(
        input.draft,
        "subject_indices",
        "SemanticOutcomeDraft",
        input.actors.length,
      ),
      allowedActorIndices: input.allowedActorIndices,
    }),
    parameters: expectJsonObject(
      expectProperty(
        input.draft,
        "parameters",
        "SemanticOutcomeDraft",
      ),
      "SemanticOutcomeDraft.parameters",
    ),
    ...(gateId === undefined
      ? {}
      : { requires_agency_gate_id: gateId }),
  });
}

function materializeAgencyRequirementCandidate(input: {
  readonly command: StoredReceivedCommand;
  readonly worldId: string;
  readonly worldState: JsonObject;
  readonly actors: readonly JsonObject[];
  readonly allowedActorIndices: ReadonlySet<number>;
  readonly draft: JsonObject;
}): JsonObject {
  return Object.freeze({
    semantic_intent: expectString(
      input.draft,
      "semantic_intent",
      "AgencyRequirementSemanticDraft",
    ),
    subjects: materializeActorSubjects({
      command: input.command,
      worldId: input.worldId,
      worldState: input.worldState,
      actors: input.actors,
      indices: readModelIndices(
        input.draft,
        "subject_indices",
        "AgencyRequirementSemanticDraft",
        input.actors.length,
      ),
      allowedActorIndices: input.allowedActorIndices,
    }),
    terms: expectJsonObject(
      expectProperty(
        input.draft,
        "terms",
        "AgencyRequirementSemanticDraft",
      ),
      "AgencyRequirementSemanticDraft.terms",
    ),
  });
}

function materializeActorSubjects(input: {
  readonly command: StoredReceivedCommand;
  readonly worldId: string;
  readonly worldState: JsonObject;
  readonly actors: readonly JsonObject[];
  readonly indices: readonly number[];
  readonly allowedActorIndices?: ReadonlySet<number>;
}): readonly JsonObject[] {
  const entities = asObjectArray(
    expectProperty(input.worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  return Object.freeze(
    input.indices.map((actorIndex) => {
      if (
        input.allowedActorIndices !== undefined &&
        !input.allowedActorIndices.has(actorIndex)
      ) {
        throw commandIdentityFault(
          input.command,
          "Actor selector is outside the verified situation actor collection",
          { actor_index: actorIndex },
        );
      }
      const actor = input.actors[actorIndex];
      if (actor === undefined) {
        throw commandIdentityFault(
          input.command,
          "Actor selector is outside the verified world-view collection",
          { actor_index: actorIndex },
        );
      }
      const entityId = expectString(
        actor,
        "entity_id",
        "DirectorActorView",
      );
      const matches = entities.filter(
        (entity) =>
          expectString(entity, "entity_id", "EntityState") === entityId,
      );
      const entity = matches[0];
      if (matches.length !== 1 || entity === undefined) {
        throw commandIdentityFault(
          input.command,
          "Verified actor selector does not resolve exactly once in the locked WorldState",
          { actor_index: actorIndex, entity_id: entityId },
        );
      }
      return Object.freeze({
        kind: "entity",
        entity: Object.freeze({
          world_id: input.worldId,
          entity_id: entityId,
          expected_revision: expectInteger(
            entity,
            "revision",
            "EntityState",
          ),
        }),
      });
    }),
  );
}

function materializeDialogueParticipantSubjects(input: {
  readonly command: StoredReceivedCommand;
  readonly worldState: JsonObject;
  readonly dialogue: JsonObject;
  readonly indices: readonly number[];
}): readonly JsonObject[] {
  const participants = asObjectArray(
    expectProperty(
      input.dialogue,
      "participants",
      "DialogueRecord",
    ),
    "DialogueRecord.participants",
  );
  const entities = asObjectArray(
    expectProperty(input.worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  return Object.freeze(
    input.indices.map((participantIndex) => {
      const participant = participants[participantIndex];
      if (participant === undefined) {
        throw commandIdentityFault(
          input.command,
          "Commitment participant selector is outside the verified dialogue collection",
          { participant_index: participantIndex },
        );
      }
      const entityRef = requireEntityParticipant(
        participant,
        `DialogueRecord.participants[${participantIndex}]`,
      );
      const entityId = expectString(
        entityRef,
        "entity_id",
        "EntityRef",
      );
      const matches = entities.filter(
        (entity) =>
          expectString(entity, "entity_id", "EntityState") === entityId,
      );
      const entity = matches[0];
      if (matches.length !== 1 || entity === undefined) {
        throw commandIdentityFault(
          input.command,
          "Commitment participant does not resolve exactly once in locked WorldState",
          { participant_index: participantIndex, entity_id: entityId },
        );
      }
      return Object.freeze({
        kind: "entity",
        entity: Object.freeze({
          world_id: input.command.session.worldId,
          entity_id: entityId,
          expected_revision: expectInteger(
            entity,
            "revision",
            "EntityState",
          ),
        }),
      });
    }),
  );
}

function subjectEntityRef(subject: JsonObject): JsonObject {
  return expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
}

function materializeCommitmentEvidence(input: {
  readonly command: StoredReceivedCommand;
  readonly dialogue: JsonObject;
  readonly value: JsonValue;
}): readonly JsonObject[] {
  const turns = asObjectArray(
    expectProperty(input.dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const dialogueId = expectString(
    input.dialogue,
    "dialogue_id",
    "DialogueRecord",
  );
  return Object.freeze(
    asObjectArray(
      input.value,
      "EventCardAgencyGateSemanticDraft.commitment_evidence",
    ).map((selector, ordinal) => {
      const turnIndex = expectInteger(
        selector,
        "turn_index",
        "DialogueCommitmentSelector",
      );
      const commitmentIndex = expectInteger(
        selector,
        "commitment_index",
        "DialogueCommitmentSelector",
      );
      const turn = turns[turnIndex];
      const commitments =
        turn === undefined
          ? []
          : asObjectArray(
              expectProperty(
                turn,
                "agency_commitments",
                "DialogueTurn",
              ),
              "DialogueTurn.agency_commitments",
            );
      const commitment = commitments[commitmentIndex];
      if (turn === undefined || commitment === undefined) {
        throw commandIdentityFault(
          input.command,
          "Commitment selector is outside the verified dialogue collection",
          {
            selector_ordinal: ordinal,
            turn_index: turnIndex,
            commitment_index: commitmentIndex,
          },
        );
      }
      return Object.freeze({
        dialogue_id: dialogueId,
        turn_id: expectString(turn, "turn_id", "DialogueTurn"),
        commitment_id: expectString(
          commitment,
          "commitment_id",
          "AgencyCommitment",
        ),
      });
    }),
  );
}

function materializeNarrativeSegments(input: {
  readonly command: StoredReceivedCommand;
  readonly dialogue: JsonObject;
  readonly locale: string;
  readonly value: JsonValue;
}): readonly JsonObject[] {
  const turns = asObjectArray(
    expectProperty(input.dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const dialogueId = expectString(
    input.dialogue,
    "dialogue_id",
    "DialogueRecord",
  );
  return Object.freeze(
    asObjectArray(
      input.value,
      "EventResultPresentationSemanticDraft.segments",
    ).map((segment, ordinal) => {
      const segmentKind = expectString(
        segment,
        "segment_kind",
        "NarrativeSegmentSemanticDraft",
      );
      if (segmentKind === "dialogue_quote") {
        const turnIndex = expectInteger(
          segment,
          "turn_index",
          "DialogueTurnQuoteSelector",
        );
        const turn = turns[turnIndex];
        if (turn === undefined) {
          throw commandIdentityFault(
            input.command,
            "Dialogue quote selector is outside the verified dialogue turn collection",
            { segment_ordinal: ordinal, turn_index: turnIndex },
          );
        }
        return Object.freeze({
          segment_kind: "dialogue_quote",
          dialogue_id: dialogueId,
          turn_id: expectString(turn, "turn_id", "DialogueTurn"),
        });
      }
      return Object.freeze({
        segment_kind: segmentKind,
        text: localizedText(
          input.locale,
          expectString(
            segment,
            "text",
            "GeneratedNarrativeSegmentSemanticDraft",
          ),
        ),
      });
    }),
  );
}

function materializeCapabilityDemand(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly selectionSpace: PlanningSelectionSpace;
  readonly locale: string;
  readonly localIds: DialogueLocalIdFactory;
  readonly requirement: JsonObject;
}): JsonObject {
  if (
    expectString(
      input.requirement,
      "requirement_kind",
      "CapabilityRequirementSelector",
    ) !== "demand"
  ) {
    throw commandIdentityFault(
      input.command,
      "Unknown capability requirement selector kind",
      {},
    );
  }
  return Object.freeze({
    requirement_kind: "demand",
    demand: Object.freeze({
      demand_id: input.localIds.createId(),
      semantic_intent: expectString(
        input.requirement,
        "semantic_intent",
        "CapabilityRequirementSelector",
      ),
      description: localizedText(
        input.locale,
        expectString(
          input.requirement,
          "description",
          "CapabilityRequirementSelector",
        ),
      ),
      allowed_archetypes: Object.freeze(
        readModelIndices(
          input.requirement,
          "allowed_archetype_indices",
          "CapabilityRequirementSelector",
          input.selectionSpace.generationArchetypes.length,
        ).map((index) =>
          materializePlanningCatalogEntry({
            catalog: input.catalog,
            contentBinding: input.contentBinding,
            command: input.command,
            entry: input.selectionSpace.generationArchetypes[index] as JsonObject,
            entryLabel: "GenerationArchetype",
            localIdField: "archetype_id",
            expectedKind: "generation_archetype",
          }),
        ),
      ),
      constraints: materializeWorldLawIndices({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        command: input.command,
        owner: input.requirement,
        indexField: "constraint_law_indices",
        selectorLabel: "CapabilityRequirementSelector",
        laws: input.selectionSpace.worldLaws,
      }),
    }),
  });
}

interface PlanningSelectionSpace {
  readonly definitionTypes: readonly JsonObject[];
  readonly componentTypes: readonly JsonObject[];
  readonly capabilities: readonly JsonObject[];
  readonly worldLaws: readonly JsonObject[];
  readonly generationArchetypes: readonly JsonObject[];
}

function requirePlanningSelectionSpace(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
}): PlanningSelectionSpace {
  const registered = input.catalog.listModelSelectionCatalog({
    bundle_id: input.contentBinding.packId,
    bundle_digest: input.contentBinding.bundleDigest,
  });
  if (registered === undefined) {
    throw new EngineFault(
      "dialogue.orchestration.model_selection_catalog_missing",
      "Locked ContentBundle model selection catalog is unavailable",
      {
        command_id: input.command.commandId,
        bundle_id: input.contentBinding.packId,
        bundle_digest: input.contentBinding.bundleDigest,
      },
    );
  }
  const worldDefinitionId = expectString(
    input.contentBinding.worldDefinition,
    "world_id",
    "WorldDefinition",
  );
  const forCurrentWorld = (
    entries: readonly JsonObject[],
    label: string,
  ): readonly JsonObject[] =>
    Object.freeze(
      entries.filter(
        (entry) =>
          expectString(entry, "world_id", label) === worldDefinitionId,
      ),
    );
  return Object.freeze({
    definitionTypes: Object.freeze(
      registered.definitionTypes.filter(
        (entry) =>
          expectString(entry, "type_kind", "TypeDefinition") ===
            "definition" &&
          entry.runtime_creatable === true &&
          entry.validator !== undefined,
      ),
    ),
    componentTypes: Object.freeze(
      registered.componentTypes.filter(
        (entry) =>
          expectString(entry, "type_kind", "TypeDefinition") ===
          "component",
      ),
    ),
    capabilities: forCurrentWorld(registered.capabilities, "Capability"),
    worldLaws: forCurrentWorld(registered.worldLaws, "WorldLaw"),
    generationArchetypes: forCurrentWorld(
      registered.generationArchetypes,
      "GenerationArchetype",
    ),
  });
}

function materializePlanningCatalogIndex(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly owner: JsonObject;
  readonly indexField: string;
  readonly selectorLabel: string;
  readonly entries: readonly JsonObject[];
  readonly entryLabel: string;
  readonly localIdField: string;
  readonly expectedKind:
    | "definition_type"
    | "component_type"
    | "capability"
    | "generation_archetype";
}): JsonObject {
  const index = readModelIndex(
    input.owner,
    input.indexField,
    input.selectorLabel,
    input.entries.length,
  );
  return materializePlanningCatalogEntry({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    command: input.command,
    entry: input.entries[index] as JsonObject,
    entryLabel: input.entryLabel,
    localIdField: input.localIdField,
    expectedKind: input.expectedKind,
  });
}

function materializePlanningCatalogEntry(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly entry: JsonObject;
  readonly entryLabel: string;
  readonly localIdField: string;
  readonly expectedKind:
    | "definition_type"
    | "component_type"
    | "capability"
    | "generation_archetype";
}): JsonObject {
  const ref = Object.freeze({
    bundle_id: input.contentBinding.packId,
    bundle_digest: input.contentBinding.bundleDigest,
    catalog_kind: input.expectedKind,
    local_id: expectString(
      input.entry,
      input.localIdField,
      input.entryLabel,
    ),
  });
  requirePlanningCatalogEntry({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    ref,
    expectedKind: input.expectedKind,
    command: input.command,
  });
  return ref;
}

function materializeWorldLawIndices(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly command: StoredReceivedCommand;
  readonly owner: JsonObject;
  readonly indexField: string;
  readonly selectorLabel: string;
  readonly laws: readonly JsonObject[];
}): readonly JsonObject[] {
  return Object.freeze(
    readModelIndices(
      input.owner,
      input.indexField,
      input.selectorLabel,
      input.laws.length,
    ).map((index) => {
      const law = input.laws[index] as JsonObject;
      const ruleId = expectString(
        law,
        "law_id",
        "WorldLaw",
      );
      const ref = Object.freeze({
        bundle_id: input.contentBinding.packId,
        bundle_digest: input.contentBinding.bundleDigest,
        rule_id: ruleId,
      });
      if (
        input.catalog.resolveRuleEvaluationBinding(ref) === undefined
      ) {
        throw commandIdentityFault(
          input.command,
          "Selected WorldLaw does not resolve in the locked root ContentBundle",
          {
            bundle_id: input.contentBinding.packId,
            rule_id: ruleId,
            field: `${input.selectorLabel}.${input.indexField}`,
          },
        );
      }
      return ref;
    }),
  );
}

function materializeFactSelector(input: {
  readonly selector: JsonObject;
  readonly ordinal: number;
  readonly worldView: JsonObject;
  readonly knowledgeView: JsonObject;
  readonly command: StoredReceivedCommand;
}): string {
  const source = expectString(
    input.selector,
    "source",
    "FactSelector",
  );
  const index = expectInteger(
    input.selector,
    "index",
    "FactSelector",
  );
  const facts =
    source === "knowledge"
      ? asObjectArray(
          expectProperty(
            input.knowledgeView,
            "facts",
            "KnowledgeView",
          ),
          "KnowledgeView.facts",
        )
      : source === "world"
        ? asObjectArray(
            expectProperty(
              input.worldView,
              "facts",
              "DirectorWorldView",
            ),
            "DirectorWorldView.facts",
          )
        : undefined;
  const fact = facts?.[index];
  if (fact === undefined) {
    throw commandIdentityFault(
      input.command,
      "Fact selector is outside its verified request collection",
      {
        selector_ordinal: input.ordinal,
        source,
        index,
      },
    );
  }
  return expectString(fact, "fact_id", "FactRecord");
}

function readModelIndices(
  object: JsonObject,
  field: string,
  label: string,
  collectionLength: number,
): readonly number[] {
  const value = expectProperty(object, field, label);
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "dialogue.orchestration.model_index_array_invalid",
      `${label}.${field} must be an array`,
      { field },
    );
  }
  return Object.freeze(
    value.map((entry, ordinal) => {
      if (
        typeof entry !== "number" ||
        !Number.isSafeInteger(entry) ||
        entry < 0 ||
        entry >= collectionLength
      ) {
        throw new EngineFault(
          "dialogue.orchestration.model_index_out_of_range",
          `${label}.${field} contains an out-of-range model index`,
          {
            field,
            ordinal,
            index: entry as JsonValue,
            collection_length: collectionLength,
          },
        );
      }
      return entry;
    }),
  );
}

function readModelIndex(
  object: JsonObject,
  field: string,
  label: string,
  collectionLength: number,
): number {
  const index = expectInteger(object, field, label);
  if (index >= collectionLength) {
    throw new EngineFault(
      "dialogue.orchestration.model_index_out_of_range",
      `${label}.${field} contains an out-of-range model index`,
      {
        field,
        index,
        collection_length: collectionLength,
      },
    );
  }
  return index;
}

function localizedText(locale: string, text: string): JsonObject {
  return Object.freeze({ [locale]: text });
}

function modelRequestInput(
  receipt: VerifiedModelInvocationReceipt,
): JsonObject {
  return expectJsonObject(
    expectProperty(receipt.request.value, "input", "ModelRequest"),
    "ModelRequest.input",
  );
}

function requireDefinitionProposalType(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly proposal: JsonObject;
  readonly command: StoredReceivedCommand;
}): {
  readonly typeId: string;
  readonly typeDefinition: JsonObject;
} {
  const draft = expectJsonObject(
    expectProperty(
      input.proposal,
      "draft",
      "DynamicDefinitionProposal",
    ),
    "DynamicDefinitionProposal.draft",
  );
  const ref = expectJsonObject(
    expectProperty(
      draft,
      "definition_type",
      "DynamicDefinitionDraft",
    ),
    "DynamicDefinitionDraft.definition_type",
  );
  const entry = requirePlanningCatalogEntry({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    ref,
    expectedKind: "definition_type",
    command: input.command,
  });
  const typeId = expectString(
    entry,
    "type_id",
    "TypeDefinition",
  );
  if (
    entry["runtime_creatable"] !== true ||
    entry.validator === undefined
  ) {
    throw new EngineFault(
      "dialogue.orchestration.definition_type_not_creatable",
      "Dynamic definition proposal requires a runtime-creatable definition type with an explicit validator",
      {
        command_id: input.command.commandId,
        type_id: typeId,
      },
    );
  }
  return Object.freeze({ typeId, typeDefinition: entry });
}

function requirePlanningCatalogEntry(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly ref: JsonObject;
  readonly expectedKind:
    | "definition_type"
    | "component_type"
    | "capability"
    | "generation_archetype";
  readonly command: StoredReceivedCommand;
}): JsonObject {
  const bundleId = expectString(
    input.ref,
    "bundle_id",
    "PlanningCatalogRef",
  );
  const bundleDigest = expectString(
    input.ref,
    "bundle_digest",
    "PlanningCatalogRef",
  );
  const catalogKind = expectString(
    input.ref,
    "catalog_kind",
    "PlanningCatalogRef",
  );
  const localId = expectString(
    input.ref,
    "local_id",
    "PlanningCatalogRef",
  );
  if (
    bundleId !== input.contentBinding.packId ||
    bundleDigest !== input.contentBinding.bundleDigest ||
    catalogKind !== input.expectedKind
  ) {
    throw new EngineFault(
      "dialogue.orchestration.planning_catalog_ref_outside_lock",
      "System planning catalog reference must name the expected kind in the current locked root ContentBundle",
      {
        command_id: input.command.commandId,
        expected_bundle_id: input.contentBinding.packId,
        actual_bundle_id: bundleId,
        expected_bundle_digest:
          input.contentBinding.bundleDigest,
        actual_bundle_digest: bundleDigest,
        expected_catalog_kind: input.expectedKind,
        actual_catalog_kind: catalogKind,
        local_id: localId,
      },
    );
  }
  const entry = input.catalog.findPlanningCatalogEntry({
    bundle_id: bundleId,
    bundle_digest: bundleDigest,
    catalog_kind: input.expectedKind,
    local_id: localId,
  });
  if (entry === undefined) {
    throw new EngineFault(
      "dialogue.orchestration.planning_catalog_ref_missing",
      "System planning catalog reference does not exist in the locked ContentBundle",
      {
        command_id: input.command.commandId,
        bundle_id: bundleId,
        bundle_digest: bundleDigest,
        catalog_kind: input.expectedKind,
        local_id: localId,
      },
    );
  }
  return entry;
}

function worldLawRefs(
  catalog: ContentRuntimeCatalog,
  contentBinding: WorldContentBinding,
  command: StoredReceivedCommand,
): readonly JsonObject[] {
  const laws = requirePlanningSelectionSpace({
    catalog,
    contentBinding,
    command,
  }).worldLaws;
  return Object.freeze(
    laws.map((law) =>
      Object.freeze({
        bundle_id: contentBinding.packId,
        bundle_digest: contentBinding.bundleDigest,
        rule_id: expectString(law, "law_id", "WorldLaw"),
      }),
    ),
  );
}

function assertGoalPlanProposalSemantics(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly proposal: JsonObject;
  readonly worldState: JsonObject;
  readonly command: StoredReceivedCommand;
}): void {
  if (
    expectString(
      input.proposal,
      "owner_actor_id",
      "GoalPlanProposal",
    ) !== input.command.session.playerEntityId
  ) {
    throw new EngineFault(
      "dialogue.orchestration.goal_plan_owner_mismatch",
      "System GoalPlan must belong to the active Session player",
      {
        command_id: input.command.commandId,
        player_entity_id: input.command.session.playerEntityId,
      },
    );
  }
  const draft = expectJsonObject(
    expectProperty(input.proposal, "draft", "GoalPlanProposal"),
    "GoalPlanProposal.draft",
  );
  const factIds = new Set(
    asObjectArray(
      expectProperty(input.worldState, "facts", "WorldState"),
      "WorldState.facts",
    ).map((fact) =>
      expectString(fact, "fact_id", "FactRecord"),
    ),
  );
  for (const factRef of expectStringArray(
    expectProperty(draft, "fact_refs", "GoalPlanDraft"),
    "GoalPlanDraft.fact_refs",
  )) {
    if (!factIds.has(factRef)) {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_fact_missing",
        "GoalPlan draft references a fact absent from the authoritative WorldState",
        {
          command_id: input.command.commandId,
          fact_id: factRef,
        },
      );
    }
  }
  assertPlanningRuleRefs({
    catalog: input.catalog,
    contentBinding: input.contentBinding,
    rules: asObjectArray(
      expectProperty(draft, "constraints", "GoalPlanDraft"),
      "GoalPlanDraft.constraints",
    ),
    command: input.command,
    field: "GoalPlanDraft.constraints",
  });

  const nodes = asObjectArray(
    expectProperty(draft, "nodes", "GoalPlanDraft"),
    "GoalPlanDraft.nodes",
  );
  const nodeByKey = new Map<string, JsonObject>();
  const demandIds = new Set<string>();
  for (const node of nodes) {
    const nodeKey = expectString(
      node,
      "node_key",
      "GoalNodeDraft",
    );
    if (nodeByKey.has(nodeKey)) {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_node_duplicate",
        "GoalPlan draft node_key values must be unique",
        { command_id: input.command.commandId, node_key: nodeKey },
      );
    }
    nodeByKey.set(nodeKey, node);
    assertPlanningRuleRefs({
      catalog: input.catalog,
      contentBinding: input.contentBinding,
      rules: asObjectArray(
        expectProperty(
          node,
          "completion_rules",
          "GoalNodeDraft",
        ),
        "GoalNodeDraft.completion_rules",
      ),
      command: input.command,
      field: `GoalNodeDraft(${nodeKey}).completion_rules`,
    });
    const requirement = expectJsonObject(
      expectProperty(
        node,
        "capability_requirement",
        "GoalNodeDraft",
      ),
      "GoalNodeDraft.capability_requirement",
    );
    const requirementKind = expectString(
      requirement,
      "requirement_kind",
      "CapabilityRequirement",
    );
    if (requirementKind === "bound") {
      requirePlanningCatalogEntry({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        ref: expectJsonObject(
          expectProperty(
            requirement,
            "capability",
            "CapabilityRequirement",
          ),
          "CapabilityRequirement.capability",
        ),
        expectedKind: "capability",
        command: input.command,
      });
      continue;
    }
    if (requirementKind !== "demand") {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_requirement_unknown",
        "GoalPlan draft has an unknown capability requirement kind",
        {
          command_id: input.command.commandId,
          node_key: nodeKey,
          requirement_kind: requirementKind,
        },
      );
    }
    const demand = expectJsonObject(
      expectProperty(
        requirement,
        "demand",
        "CapabilityRequirement",
      ),
      "CapabilityRequirement.demand",
    );
    const demandId = expectString(
      demand,
      "demand_id",
      "CapabilityDemand",
    );
    if (demandIds.has(demandId)) {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_demand_duplicate",
        "GoalPlan CapabilityDemand IDs must be unique",
        { command_id: input.command.commandId, demand_id: demandId },
      );
    }
    demandIds.add(demandId);
    assertPlanningRuleRefs({
      catalog: input.catalog,
      contentBinding: input.contentBinding,
      rules: asObjectArray(
        expectProperty(
          demand,
          "constraints",
          "CapabilityDemand",
        ),
        "CapabilityDemand.constraints",
      ),
      command: input.command,
      field: `CapabilityDemand(${demandId}).constraints`,
    });
    for (const archetypeRef of asObjectArray(
      expectProperty(
        demand,
        "allowed_archetypes",
        "CapabilityDemand",
      ),
      "CapabilityDemand.allowed_archetypes",
    )) {
      const archetype = requirePlanningCatalogEntry({
        catalog: input.catalog,
        contentBinding: input.contentBinding,
        ref: archetypeRef,
        expectedKind: "generation_archetype",
        command: input.command,
      });
      if (
        expectString(
          archetype,
          "world_id",
          "GenerationArchetype",
        ) !==
        expectString(
          input.contentBinding.worldDefinition,
          "world_id",
          "WorldDefinition",
        )
      ) {
        throw new EngineFault(
          "dialogue.orchestration.goal_plan_archetype_world_mismatch",
          "GoalPlan generation archetype belongs to a different WorldDefinition",
          {
            command_id: input.command.commandId,
            demand_id: demandId,
            archetype_id: expectString(
              archetype,
              "archetype_id",
              "GenerationArchetype",
            ),
          },
        );
      }
    }
  }
  assertGoalPlanGraph(nodeByKey, input.command);
}

function assertPlanningRuleRefs(input: {
  readonly catalog: ContentRuntimeCatalog;
  readonly contentBinding: WorldContentBinding;
  readonly rules: readonly JsonObject[];
  readonly command: StoredReceivedCommand;
  readonly field: string;
}): void {
  for (const rule of input.rules) {
    const bundleId = expectString(rule, "bundle_id", "RuleRef");
    const bundleDigest = expectString(
      rule,
      "bundle_digest",
      "RuleRef",
    );
    const ruleId = expectString(rule, "rule_id", "RuleRef");
    if (
      bundleId !== input.contentBinding.packId ||
      bundleDigest !== input.contentBinding.bundleDigest ||
      input.catalog.resolveRuleEvaluationBinding({
        bundle_id: bundleId,
        bundle_digest: bundleDigest,
        rule_id: ruleId,
      }) === undefined
    ) {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_rule_unresolved",
        "GoalPlan RuleRef must resolve in the current locked root ContentBundle",
        {
          command_id: input.command.commandId,
          field: input.field,
          bundle_id: bundleId,
          bundle_digest: bundleDigest,
          rule_id: ruleId,
        },
      );
    }
  }
}

function assertGoalPlanGraph(
  nodeByKey: ReadonlyMap<string, JsonObject>,
  command: StoredReceivedCommand,
): void {
  for (const [nodeKey, node] of nodeByKey) {
    for (const [field, refs] of [
      [
        "depends_on",
        expectStringArray(
          expectProperty(node, "depends_on", "GoalNodeDraft"),
          "GoalNodeDraft.depends_on",
        ),
      ],
      [
        "alternative_node_keys",
        expectStringArray(
          expectProperty(
            node,
            "alternative_node_keys",
            "GoalNodeDraft",
          ),
          "GoalNodeDraft.alternative_node_keys",
        ),
      ],
    ] as const) {
      for (const ref of refs) {
        if (ref === nodeKey || !nodeByKey.has(ref)) {
          throw new EngineFault(
            "dialogue.orchestration.goal_plan_graph_ref_invalid",
            "GoalPlan dependency and alternative references must name a different node in the same draft",
            {
              command_id: command.commandId,
              node_key: nodeKey,
              field,
              referenced_node_key: ref,
            },
          );
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeKey: string): void => {
    if (visiting.has(nodeKey)) {
      throw new EngineFault(
        "dialogue.orchestration.goal_plan_dependency_cycle",
        "GoalPlan depends_on graph must be acyclic",
        { command_id: command.commandId, node_key: nodeKey },
      );
    }
    if (visited.has(nodeKey)) {
      return;
    }
    visiting.add(nodeKey);
    const node = nodeByKey.get(nodeKey) as JsonObject;
    for (const dependency of expectStringArray(
      expectProperty(node, "depends_on", "GoalNodeDraft"),
      "GoalNodeDraft.depends_on",
    )) {
      visit(dependency);
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
  };
  for (const nodeKey of nodeByKey.keys()) {
    visit(nodeKey);
  }
}

function expectStringArray(
  value: JsonValue,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "dialogue.orchestration.array_expected",
      `${label} must be an array`,
      { label },
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string") {
        throw new EngineFault(
          "dialogue.orchestration.string_expected",
          `${label}[${index}] must be a string`,
          { label, index },
        );
      }
      return entry;
    }),
  );
}

function assertSystemPlanningReceiptIdentity(input: {
  readonly command: StoredReceivedCommand;
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly expectedRequestId: string;
  readonly expectedBasisRevision: number;
  readonly operationKind:
    | "definition.validate"
    | "goal_plan.validate";
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly identityField: "definition_id" | "plan_id";
  readonly expectedWorldRecordId: string;
  readonly expectedProposalId: string;
  readonly expectedDraftOrdinal: number;
  readonly expectedModelProof: JsonObject;
  readonly expectedPreparedAt: string;
  readonly digest: JsonDigest;
  readonly expectedConstraints: readonly JsonObject[] | undefined;
}): void {
  assertRulePluginRequestHeader({
    receipt: input.receipt,
    command: input.command,
    expectedRequestId: input.expectedRequestId,
    expectedBasisRevision: input.expectedBasisRevision,
    operationKind: input.operationKind,
    invocation: input.invocation,
  });
  const request = input.receipt.request.value;
  const requestInput = rulePluginRequestInput(input.receipt);
  const candidate = expectJsonObject(
    expectProperty(
      requestInput,
      "candidate",
      input.operationKind,
    ),
    `${input.operationKind}.candidate`,
  );
  const deterministicContext = expectJsonObject(
    expectProperty(
      request,
      "deterministic_context",
      "RulePluginRequest",
    ),
    "RulePluginRequest.deterministic_context",
  );
  const externalResults = asObjectArray(
    expectProperty(
      deterministicContext,
      "external_results",
      "DeterministicContext",
    ),
    "DeterministicContext.external_results",
  ).filter(
    (result) =>
      expectString(
        result,
        "result_id",
        "DeterministicExternalResult",
      ) === "system_provenance_created_at",
  );
  const provenanceResult = externalResults[0];
  if (
    expectString(
      requestInput,
      input.identityField,
      input.operationKind,
    ) !== input.expectedWorldRecordId ||
    expectInteger(
      requestInput,
      "draft_ordinal",
      input.operationKind,
    ) !== input.expectedDraftOrdinal ||
    expectString(candidate, "proposal_id", "SystemProposal") !==
      input.expectedProposalId ||
    !jsonEquals(
      expectProperty(
        requestInput,
        "model_proof",
        input.operationKind,
      ),
      input.expectedModelProof,
    ) ||
    (input.expectedConstraints !== undefined &&
      !jsonEquals(
        expectProperty(
          requestInput,
          "constraints",
          input.operationKind,
        ),
        input.expectedConstraints as JsonValue,
      )) ||
    externalResults.length !== 1 ||
    provenanceResult === undefined ||
    provenanceResult.payload !== input.expectedPreparedAt ||
    expectString(
      provenanceResult,
      "content_digest",
      "DeterministicExternalResult",
    ) !== input.digest.sha256(input.expectedPreparedAt)
  ) {
    throw commandIdentityFault(
      input.command,
      "Recovered System planning RulePlugin request differs from its persisted proposal identity",
      {
        request_id: input.expectedRequestId,
        operation_kind: input.operationKind,
        proposal_id: input.expectedProposalId,
      },
    );
  }
}

function assertDirectorSystemReceiptIdentity(input: {
  readonly command: StoredReceivedCommand;
  readonly requestId: string;
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly expectedBasisRevision: number;
}): void {
  const execution = requireDialogueExecution(input.command);
  const request = input.receipt.request.value;
  const proof = input.receipt.proof.value;
  const snapshot = input.receipt.snapshot.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const dialogue = expectJsonObject(
    expectProperty(
      dynamicInput,
      "dialogue",
      "DirectorSystemDialogueInput",
    ),
    "DirectorSystemDialogueInput.dialogue",
  );
  const knowledgeView = expectJsonObject(
    expectProperty(
      dynamicInput,
      "knowledge_view",
      "DirectorSystemDialogueInput",
    ),
    "DirectorSystemDialogueInput.knowledge_view",
  );
  if (
    input.receipt.worldId !== input.command.session.worldId ||
    input.receipt.worldRevision !== input.expectedBasisRevision ||
    expectString(snapshot, "world_id", "WorldSnapshot") !==
      input.command.session.worldId ||
    expectInteger(snapshot, "world_revision", "WorldSnapshot") !==
      input.expectedBasisRevision ||
    expectString(request, "request_id", "ModelRequest") !==
      input.requestId ||
    expectString(request, "request_kind", "ModelRequest") !==
      "director.system_dialogue" ||
    expectInteger(request, "basis_revision", "ModelRequest") !==
      input.expectedBasisRevision ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      execution.dialogueId ||
    expectString(
      knowledgeView,
      "viewer_entity_id",
      "KnowledgeView",
    ) !== input.command.session.playerEntityId ||
    expectString(proof, "request_id", "VerifiedModelOutputRef") !==
      input.requestId ||
    expectString(proof, "request_kind", "VerifiedModelOutputRef") !==
      "director.system_dialogue" ||
    expectInteger(proof, "basis_revision", "VerifiedModelOutputRef") !==
      input.expectedBasisRevision
  ) {
    throw commandIdentityFault(
      input.command,
      "Director System receipt differs from its command-owned identity",
      {
        expected_request_id: input.requestId,
        expected_world_revision: input.expectedBasisRevision,
        dialogue_id: execution.dialogueId,
        player_entity_id: input.command.session.playerEntityId,
      },
    );
  }
}

function assertDirectorPlanningReceiptIdentity(input: {
  readonly command: StoredReceivedCommand;
  readonly interactionKind: "goal_plan" | "definition_draft";
  readonly requestId: string;
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly expectedBasisRevision: number;
}): void {
  const execution = requireDialogueExecution(input.command);
  const expectedRequestKind =
    input.interactionKind === "goal_plan"
      ? "director.goal_plan"
      : "director.definition_draft";
  const request = input.receipt.request.value;
  const proof = input.receipt.proof.value;
  const snapshot = input.receipt.snapshot.value;
  const dynamicInput = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const dialogue = expectJsonObject(
    expectProperty(
      dynamicInput,
      "dialogue",
      "Director planning input",
    ),
    "Director planning input.dialogue",
  );
  const knowledgeView = expectJsonObject(
    expectProperty(
      dynamicInput,
      "knowledge_view",
      "Director planning input",
    ),
    "Director planning input.knowledge_view",
  );
  const purposeMatches =
    input.interactionKind !== "definition_draft" ||
    expectString(
      dynamicInput,
      "purpose",
      "DirectorDefinitionDraftInput",
    ) === readDialogueCommandText(input.command);
  if (
    input.receipt.worldId !== input.command.session.worldId ||
    input.receipt.worldRevision !== input.expectedBasisRevision ||
    expectString(snapshot, "world_id", "WorldSnapshot") !==
      input.command.session.worldId ||
    expectInteger(snapshot, "world_revision", "WorldSnapshot") !==
      input.expectedBasisRevision ||
    expectString(request, "request_id", "ModelRequest") !==
      input.requestId ||
    expectString(request, "request_kind", "ModelRequest") !==
      expectedRequestKind ||
    expectInteger(request, "basis_revision", "ModelRequest") !==
      input.expectedBasisRevision ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      execution.dialogueId ||
    expectString(
      dynamicInput,
      "response_locale",
      "DirectorDialogueEventsInput",
    ) !== readDialogueCommandLocale(input.command) ||
    expectString(
      knowledgeView,
      "viewer_entity_id",
      "KnowledgeView",
    ) !== input.command.session.playerEntityId ||
    expectString(
      dynamicInput,
      "response_locale",
      "Director planning input",
    ) !== readDialogueCommandLocale(input.command) ||
    !purposeMatches ||
    expectString(proof, "request_id", "VerifiedModelOutputRef") !==
      input.requestId ||
    expectString(proof, "request_kind", "VerifiedModelOutputRef") !==
      expectedRequestKind ||
    expectInteger(proof, "basis_revision", "VerifiedModelOutputRef") !==
      input.expectedBasisRevision
  ) {
    throw commandIdentityFault(
      input.command,
      "Director planning receipt differs from its explicit GUI interaction identity",
      {
        expected_request_id: input.requestId,
        expected_request_kind: expectedRequestKind,
        expected_world_revision: input.expectedBasisRevision,
        dialogue_id: execution.dialogueId,
      },
    );
  }
}

function readRejectCode(
  receipt: VerifiedRulePluginInvocationReceipt,
): string {
  const output = expectJsonObject(
    expectProperty(
      receipt.response.value,
      "output",
      "RulePluginResponse",
    ),
    "RulePluginResponse.output",
  );
  if (expectString(output, "output_kind", "RulePluginOutput") !== "reject") {
    throw new EngineFault(
      "dialogue.orchestration.proposal_missing",
      "Dialogue RulePlugin response has neither a proposal nor a Reject output",
      {
        request_id: expectString(
          receipt.request.value,
          "request_id",
          "RulePluginRequest",
        ),
      },
    );
  }
  return expectString(output, "code", "RejectOutput");
}

function assertCommittedRevision(
  result: JsonObject,
  expectedRevision: number,
  command: StoredReceivedCommand,
  stage: "human" | "character" | "director_system",
): void {
  const actualRevision = expectInteger(
    result,
    "world_revision",
    "ApplyPacketResult",
  );
  if (actualRevision !== expectedRevision) {
    throw new EngineFault(
      "dialogue.orchestration.commit_revision_mismatch",
      "Dialogue packet commit returned an unexpected world revision",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
        stage,
        expected_world_revision: expectedRevision,
        actual_world_revision: actualRevision,
      },
    );
  }
}

function assertWorldRevision(
  binding: RuntimeWorldBinding,
  expectedRevision: number,
  command: StoredReceivedCommand,
  stage:
    | "human"
    | "character"
    | "director_system"
    | "definition"
    | "goal_plan"
    | "event_card"
    | "event_budget_gate",
): void {
  const actualRevision = expectInteger(
    binding.record.snapshot.value,
    "world_revision",
    "WorldSnapshot",
  );
  if (
    expectString(
      binding.record.snapshot.value,
      "world_id",
      "WorldSnapshot",
    ) !== command.session.worldId ||
    actualRevision !== expectedRevision
  ) {
    throw new EngineFault(
      "dialogue.orchestration.world_stage_mismatch",
      "Current world does not match the expected dialogue recovery stage",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
        stage,
        expected_world_revision: expectedRevision,
        actual_world_revision: actualRevision,
      },
    );
  }
}

function requireDialogueExecution(
  command: StoredReceivedCommand,
): NonNullable<StoredReceivedCommand["dialogueExecution"]> {
  if (command.dialogueExecution === undefined) {
    throw new EngineFault(
      "dialogue.orchestration.execution_identity_missing",
      "Dialogue command has no persisted execution identity",
      { command_id: command.commandId },
    );
  }
  return command.dialogueExecution;
}

function entityParticipant(
  worldId: string,
  entityId: string,
): JsonObject {
  return Object.freeze({
    participant_kind: "entity",
    entity: Object.freeze({
      world_id: worldId,
      entity_id: entityId,
    }),
  });
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "dialogue.orchestration.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
