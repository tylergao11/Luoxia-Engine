import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  DeterministicContextAuthority,
  WorldContentBinding,
} from "@luoxia/world-core/composition";

import type { CommandJournal, StoredReceivedCommand } from "./command-journal.js";
import type {
  CommandFinalizer,
  ServerEnvelopeDocument,
} from "./command-finalizer.js";
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
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

type DialogueOperationKind = "dialogue.open" | "dialogue.turn.append";

export interface DialogueCommitmentIdFactory {
  createCommitmentId(): string;
}

export interface DialogueCommandOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface DialogueCommandOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly models: RuntimeModelFacades;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
  readonly commitmentIds: DialogueCommitmentIdFactory;
  /** Required deployment selection; never read from content or a client message. */
  readonly characterDialogueModelProfileId: string;
}

interface HumanStageContext {
  readonly binding: RuntimeWorldBinding;
  readonly input: JsonObject;
}

export function createDialogueCommandOrchestrator(
  dependencies: DialogueCommandOrchestratorDependencies,
): DialogueCommandOrchestrator {
  return new DefaultDialogueCommandOrchestrator(dependencies);
}

class DefaultDialogueCommandOrchestrator
  implements DialogueCommandOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #commands: CommandJournal;
  readonly #worlds: RuntimeWorldBindingResolver;
  readonly #rulePluginAbi: RulePluginAbiRegistry;
  readonly #rulePlugins: RulePluginExecutor;
  readonly #deterministicContexts: DeterministicContextAuthority;
  readonly #models: RuntimeModelFacades;
  readonly #mutations: WorldMutationOrchestrator;
  readonly #finalizer: CommandFinalizer;
  readonly #commitmentIds: DialogueCommitmentIdFactory;
  readonly #characterDialogueModelProfileId: string;

  public constructor(
    dependencies: DialogueCommandOrchestratorDependencies,
  ) {
    this.#contracts = dependencies.contracts;
    this.#commands = dependencies.commands;
    this.#worlds = dependencies.worlds;
    this.#rulePluginAbi = dependencies.rulePluginAbi;
    this.#rulePlugins = dependencies.rulePlugins;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#models = dependencies.models;
    this.#mutations = dependencies.mutations;
    this.#finalizer = dependencies.finalizer;
    this.#commitmentIds = dependencies.commitmentIds;
    this.#characterDialogueModelProfileId =
      dependencies.characterDialogueModelProfileId;
    this.#contracts.assert(
      CONTRACT_REF.identifier,
      this.#characterDialogueModelProfileId,
    );
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

    const humanReceipt = await this.#rulePlugins.executeRecoverable({
      requestId: stored.dialogueExecution.humanRuleRequestId,
      candidateFactory: async () =>
        this.#createHumanRulePluginRequest(stored),
      modelInvocations: [],
    });
    const recipientEntityId =
      await this.#assertHumanReceiptIdentity(stored, humanReceipt);
    if (humanReceipt.proposal === undefined) {
      return this.#finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: readRejectCode(humanReceipt),
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

    const modelReceipt = await this.#models.characterDialogue({
      worldId: stored.session.worldId,
      entityId: recipientEntityId,
      dialogueId: stored.dialogueExecution.dialogueId,
      latestPlayerTurnId: stored.dialogueExecution.humanTurnId,
      requestId: stored.dialogueExecution.characterModelRequestId,
      model_profile_id: this.#characterDialogueModelProfileId,
    });
    assertCharacterModelReceiptIdentity(
      stored,
      recipientEntityId,
      this.#characterDialogueModelProfileId,
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
    const finalWorldRevision = stored.session.worldRevision + 2;
    assertCommittedRevision(
      characterCommit.value,
      finalWorldRevision,
      stored,
      "character",
    );

    return this.#finalizer.completeDialogueAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision,
      characterTurnId: stored.dialogueExecution.characterTurnId,
    });
  }

  async #assertHumanReceiptIdentity(
    command: StoredReceivedCommand,
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<string> {
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
        "turn",
        "CharacterDialogueTurnAppendInput",
      ),
      "CharacterDialogueTurnAppendInput.turn",
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
      const recipientEntityId = requireBasicNpcRecipient(
        worldState,
        recipient,
        command.session.worldId,
        command.session.playerEntityId,
      );
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
            entityParticipant(
              command.session.worldId,
              recipientEntityId,
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
    requireBasicNpcDialogueResponder(
      worldState,
      dialogue,
      command.session.worldId,
      command.session.playerEntityId,
    );
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
    const characterTurn = createCharacterTurn({
      contracts: this.#contracts,
      command,
      recipientEntityId,
      worldState,
      output,
      modelRequestId: expectString(
        modelReceipt.proof.value,
        "request_id",
        "VerifiedModelOutputRef",
      ),
      modelOutputDigest,
      commitmentIds: this.#commitmentIds,
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
        turn: characterTurn,
      }),
    });
  }
}

function assertRulePluginRequestHeader(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly command: StoredReceivedCommand;
  readonly expectedRequestId: string;
  readonly expectedBasisRevision: number;
  readonly operationKind: DialogueOperationKind;
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

function createCharacterTurn(input: {
  readonly contracts: ContractValidator;
  readonly command: StoredReceivedCommand;
  readonly recipientEntityId: string;
  readonly worldState: JsonObject;
  readonly output: JsonObject;
  readonly modelRequestId: string;
  readonly modelOutputDigest: string;
  readonly commitmentIds: DialogueCommitmentIdFactory;
}): JsonObject {
  const execution = requireDialogueExecution(input.command);
  const reply = expectJsonObject(
    expectProperty(input.output, "reply", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.reply",
  );
  const drafts = asObjectArray(
    expectProperty(
      input.output,
      "commitments",
      "CharacterDialogueOutput",
    ),
    "CharacterDialogueOutput.commitments",
  );
  const usedIds = new Set<string>();
  const commitments = drafts.map((draft, index) => {
    const commitmentId = input.contracts.assert(
      CONTRACT_REF.uuid,
      input.commitmentIds.createCommitmentId(),
    ).value as string;
    if (
      commitmentId !== commitmentId.toLowerCase() ||
      usedIds.has(commitmentId)
    ) {
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
    usedIds.add(commitmentId);
    return Object.freeze({ ...draft, commitment_id: commitmentId });
  });
  const turn: Record<string, JsonValue> = {
    turn_id: execution.characterTurnId,
    speaker: entityParticipant(
      input.command.session.worldId,
      input.recipientEntityId,
    ),
    locale: expectString(reply, "locale", "DialogueReplyDraft"),
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
): string {
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
    const recipientEntityId = requireBasicNpcRecipient(
      worldState,
      recipient,
      command.session.worldId,
      command.session.playerEntityId,
    );
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
      entityParticipant(
        command.session.worldId,
        recipientEntityId,
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
    return recipientEntityId;
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
  return requireBasicNpcDialogueResponder(
    worldState,
    dialogue,
    command.session.worldId,
    command.session.playerEntityId,
  );
}

function assertCharacterModelReceiptIdentity(
  command: StoredReceivedCommand,
  recipientEntityId: string,
  modelProfileId: string,
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
    expectString(request, "model_profile_id", "ModelRequest") !==
      modelProfileId ||
    expectInteger(request, "basis_revision", "ModelRequest") !==
      expectedWorldRevision ||
    expectString(character, "world_id", "EntityRef") !==
      command.session.worldId ||
    expectString(character, "entity_id", "EntityRef") !==
      recipientEntityId ||
    expectString(dialogue, "dialogue_id", "DialogueRecord") !==
      execution.dialogueId ||
    expectString(
      dynamicInput,
      "latest_player_turn_id",
      "CharacterDialogueInput",
    ) !== execution.humanTurnId ||
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
  stage: "human" | "character",
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
  stage: "human" | "character",
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
