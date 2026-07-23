import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

import type {
  ModelRequestDocument,
  ModelResponseDocument,
} from "./model-gateway.js";

const REQUEST_KINDS = [
  "director.daily_settlement",
  "director.dialogue_events",
  "director.system_dialogue",
  "character.dialogue",
  "character.react",
] as const;

type RequestKind = (typeof REQUEST_KINDS)[number];

export interface ModelOutputSemanticGate {
  assertRequest(request: ModelRequestDocument): void;
  assertResponse(
    request: ModelRequestDocument,
    response: ModelResponseDocument,
  ): void;
}

export function createModelOutputSemanticGate(): ModelOutputSemanticGate {
  return new DefaultModelOutputSemanticGate();
}

class DefaultModelOutputSemanticGate implements ModelOutputSemanticGate {
  public assertRequest(request: ModelRequestDocument): void {
    const requestKind = expectString(
      request.value,
      "request_kind",
      "ModelRequest",
    ) as RequestKind;
    const handler = REQUEST_HANDLERS[requestKind];
    if (handler === undefined) {
      throw fault(
        "model.semantic.request_kind_unknown",
        `Unknown ModelRequest request_kind ${requestKind}`,
        { request_kind: requestKind },
      );
    }
    handler(request.value);
  }

  public assertResponse(
    request: ModelRequestDocument,
    response: ModelResponseDocument,
  ): void {
    const output = expectJsonObject(
      expectProperty(response.value, "output", "ModelResponse"),
      "ModelResponse.output",
    );
    const outputKind = expectString(output, "output_kind", "ModelOutput");
    if (outputKind === "failed") {
      throw fault(
        "model.response.failed",
        "Model provider returned an explicit failed output",
        {
          request_id: expectString(response.value, "request_id", "ModelResponse"),
          request_kind: expectString(
            response.value,
            "request_kind",
            "ModelResponse",
          ),
          provider_code: expectString(output, "code", "FailedModelOutput"),
          provider_message: expectString(
            output,
            "message",
            "FailedModelOutput",
          ),
        },
      );
    }

    const requestKind = expectString(
      request.value,
      "request_kind",
      "ModelRequest",
    ) as RequestKind;
    if (outputKind !== requestKind) {
      throw fault(
        "model.semantic.output_kind_mismatch",
        "Model output_kind does not match request_kind",
        {
          request_kind: requestKind,
          output_kind: outputKind,
        },
      );
    }

    const handler = RESPONSE_HANDLERS[requestKind];
    if (handler === undefined) {
      throw fault(
        "model.semantic.request_kind_unknown",
        `Unknown ModelRequest request_kind ${requestKind}`,
        { request_kind: requestKind },
      );
    }
    handler(request.value, output);
  }
}

type RequestHandler = (request: JsonObject) => void;
type ResponseHandler = (request: JsonObject, output: JsonObject) => void;

const REQUEST_HANDLERS: {
  readonly [K in RequestKind]: RequestHandler;
} = {
  "director.daily_settlement": assertDirectorDailyRequest,
  "director.dialogue_events": assertDirectorDialogueEventsRequest,
  "director.system_dialogue": assertDirectorSystemDialogueRequest,
  "character.dialogue": assertCharacterDialogueRequest,
  "character.react": assertCharacterReactRequest,
};

const RESPONSE_HANDLERS: {
  readonly [K in RequestKind]: ResponseHandler;
} = {
  "director.daily_settlement": assertDirectorDailyResponse,
  "director.dialogue_events": assertDirectorDialogueEventsResponse,
  "director.system_dialogue": assertDirectorSystemDialogueResponse,
  "character.dialogue": assertCharacterDialogueResponse,
  "character.react": assertCharacterReactResponse,
};

function assertDirectorDailyRequest(request: JsonObject): void {
  const input = requestInput(request);
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDailySettlementInput"),
    "DirectorDailySettlementInput.world_view",
  );
  assertUniqueIds(
    objectArray(
      expectProperty(worldView, "actors", "DirectorWorldView"),
      "DirectorWorldView.actors",
    ),
    "entity_id",
    "DirectorWorldView.actors",
  );
}

function assertDirectorDialogueEventsRequest(request: JsonObject): void {
  const input = requestInput(request);
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDialogueEventsInput"),
    "DirectorDialogueEventsInput.world_view",
  );
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "DirectorDialogueEventsInput"),
    "DirectorDialogueEventsInput.dialogue",
  );
  assertActiveDialogue(dialogue);
  assertEqual(
    "model.semantic.dialogue_day_mismatch",
    "Dialogue day does not match Director world day",
    expectInteger(worldView, "day", "DirectorWorldView"),
    expectInteger(dialogue, "day", "DialogueRecord"),
    "day",
  );
}

function assertDirectorSystemDialogueRequest(request: JsonObject): void {
  const input = requestInput(request);
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorSystemDialogueInput"),
    "DirectorSystemDialogueInput.world_view",
  );
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "DirectorSystemDialogueInput"),
    "DirectorSystemDialogueInput.dialogue",
  );
  assertActiveDialogue(dialogue);
  const finalHumanTurn = assertFinalHumanTurn(dialogue);
  const knowledgeView = expectJsonObject(
    expectProperty(input, "knowledge_view", "DirectorSystemDialogueInput"),
    "DirectorSystemDialogueInput.knowledge_view",
  );
  const viewerId = expectString(
    knowledgeView,
    "viewer_entity_id",
    "KnowledgeView",
  );
  const speakerId = humanTurnSpeakerEntityId(finalHumanTurn);
  assertEqual(
    "model.semantic.system_viewer_mismatch",
    "System knowledge viewer must be the final human speaker",
    speakerId,
    viewerId,
    "knowledge_view.viewer_entity_id",
  );
  assertEntityDialogueParticipant(
    dialogue,
    viewerId,
    "model.semantic.system_viewer_not_participant",
    "System knowledge viewer is not a participant in the dialogue",
  );
  if (!hasSystemDialogueParticipant(dialogue)) {
    throw fault(
      "model.semantic.system_participant_missing",
      "System dialogue input must include the System participant",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
      },
    );
  }
  const actorIds = new Set(
    objectArray(
      expectProperty(worldView, "actors", "DirectorWorldView"),
      "DirectorWorldView.actors",
    ).map((actor) => expectString(actor, "entity_id", "DirectorActorView")),
  );
  if (!actorIds.has(viewerId)) {
    throw fault(
      "model.semantic.system_viewer_missing",
      "System knowledge viewer is absent from the Director world actors",
      { viewer_entity_id: viewerId },
    );
  }
  assertEqual(
    "model.semantic.dialogue_day_mismatch",
    "Dialogue day does not match Director world day",
    expectInteger(worldView, "day", "DirectorWorldView"),
    expectInteger(dialogue, "day", "DialogueRecord"),
    "day",
  );
}

function assertCharacterDialogueRequest(request: JsonObject): void {
  const input = requestInput(request);
  const characterId = assertCharacterIdentity(request, input);
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "CharacterDialogueInput"),
    "CharacterDialogueInput.dialogue",
  );
  assertActiveDialogue(dialogue);
  assertDialogueParticipant(dialogue, characterId);

  const latestTurn = assertFinalHumanTurn(dialogue);
  const humanSpeakerId = humanTurnSpeakerEntityId(latestTurn);
  assertEntityDialogueParticipant(
    dialogue,
    humanSpeakerId,
    "model.semantic.human_speaker_not_participant",
    "Final human speaker is not a participant in the dialogue",
  );
  if (humanSpeakerId === characterId) {
    throw fault(
      "model.semantic.character_self_reply",
      "Character Mind cannot reply to its own human turn",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
        character_id: characterId,
      },
    );
  }
  const latestPlayerTurnId = expectString(
    input,
    "latest_player_turn_id",
    "CharacterDialogueInput",
  );
  if (expectString(latestTurn, "turn_id", "DialogueTurn") !== latestPlayerTurnId) {
    throw fault(
      "model.semantic.latest_player_turn_mismatch",
      "latest_player_turn_id must identify the final human turn",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
        latest_player_turn_id: latestPlayerTurnId,
        final_turn_id: expectString(latestTurn, "turn_id", "DialogueTurn"),
      },
    );
  }
}

function assertCharacterReactRequest(request: JsonObject): void {
  const input = requestInput(request);
  assertCharacterIdentity(request, input);
  const stimuli = objectArray(
    expectProperty(input, "events", "CharacterReactInput"),
    "CharacterReactInput.events",
  );
  assertUniqueIds(stimuli, "proposal_id", "CharacterReactInput.events");
  for (const [index, stimulus] of stimuli.entries()) {
    assertProposalGraph(
      objectArray(
        expectProperty(
          stimulus,
          "candidate_outcomes",
          "CharacterEventStimulus",
        ),
        `CharacterReactInput.events[${index}].candidate_outcomes`,
      ),
      objectArray(
        expectProperty(stimulus, "agency_gates", "CharacterEventStimulus"),
        `CharacterReactInput.events[${index}].agency_gates`,
      ),
      `CharacterReactInput.events[${index}]`,
    );
  }
}

function assertDirectorDailyResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDailySettlementInput"),
    "DirectorDailySettlementInput.world_view",
  );
  const day = expectInteger(worldView, "day", "DirectorWorldView");
  const actorIds = new Set(
    objectArray(
      expectProperty(worldView, "actors", "DirectorWorldView"),
      "DirectorWorldView.actors",
    ).map((actor) => expectString(actor, "entity_id", "DirectorActorView")),
  );
  const proposals = objectArray(
    expectProperty(output, "automatic_events", "DirectorDailySettlementOutput"),
    "DirectorDailySettlementOutput.automatic_events",
  );
  assertUniqueIds(
    proposals,
    "proposal_id",
    "DirectorDailySettlementOutput.automatic_events",
  );

  for (const [index, proposal] of proposals.entries()) {
    assertEqual(
      "model.semantic.automatic_event_day_mismatch",
      "Automatic event proposal day does not match Director world day",
      day,
      expectInteger(proposal, "day", "AutomaticEventProposal"),
      "day",
    );
    const proposalKind = expectString(
      proposal,
      "proposal_kind",
      "AutomaticEventProposal",
    );
    const outcomes = objectArray(
      expectProperty(
        proposal,
        "candidate_outcomes",
        "AutomaticEventProposal",
      ),
      `DirectorDailySettlementOutput.automatic_events[${index}].candidate_outcomes`,
    );
    const gates =
      proposalKind === "automatic.character"
        ? objectArray(
            expectProperty(
              proposal,
              "agency_gates",
              "CharacterAutomaticEventProposal",
            ),
            `DirectorDailySettlementOutput.automatic_events[${index}].agency_gates`,
          )
        : [];
    assertProposalGraph(
      outcomes,
      gates,
      `DirectorDailySettlementOutput.automatic_events[${index}]`,
    );

    if (proposalKind === "automatic.character") {
      const targets = stringArray(
        expectProperty(
          proposal,
          "target_entity_ids",
          "CharacterAutomaticEventProposal",
        ),
        `DirectorDailySettlementOutput.automatic_events[${index}].target_entity_ids`,
      );
      for (const targetId of targets) {
        if (!actorIds.has(targetId)) {
          throw fault(
            "model.semantic.automatic_event_target_unknown",
            "Character automatic event target is absent from Director actors",
            {
              proposal_id: expectString(
                proposal,
                "proposal_id",
                "CharacterAutomaticEventProposal",
              ),
              target_entity_id: targetId,
            },
          );
        }
      }
    } else if (proposalKind !== "automatic.world") {
      throw fault(
        "model.semantic.automatic_event_kind_unknown",
        `Unknown automatic event proposal_kind ${proposalKind}`,
        { proposal_kind: proposalKind },
      );
    }
  }
}

function assertDirectorDialogueEventsResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  assertEventCardsBoundToDialogue(
    output,
    input,
    "DirectorDialogueEventsOutput",
  );
}

function assertDirectorSystemDialogueResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  assertEventCardsBoundToDialogue(
    output,
    input,
    "DirectorSystemDialogueOutput",
  );

  const knowledgeView = expectJsonObject(
    expectProperty(input, "knowledge_view", "DirectorSystemDialogueInput"),
    "DirectorSystemDialogueInput.knowledge_view",
  );
  const viewerId = expectString(
    knowledgeView,
    "viewer_entity_id",
    "KnowledgeView",
  );
  const goalPlans = objectArray(
    expectProperty(output, "goal_plans", "DirectorSystemDialogueOutput"),
    "DirectorSystemDialogueOutput.goal_plans",
  );
  const definitions = objectArray(
    expectProperty(output, "definitions", "DirectorSystemDialogueOutput"),
    "DirectorSystemDialogueOutput.definitions",
  );
  const cards = objectArray(
    expectProperty(output, "event_cards", "DirectorSystemDialogueOutput"),
    "DirectorSystemDialogueOutput.event_cards",
  );
  assertUniqueProposalIdsAcross(
    [
      ...cards.map((value) => ({ value, path: "event_cards" })),
      ...goalPlans.map((value) => ({ value, path: "goal_plans" })),
      ...definitions.map((value) => ({ value, path: "definitions" })),
    ],
    "DirectorSystemDialogueOutput",
  );
  for (const plan of goalPlans) {
    assertEqual(
      "model.semantic.goal_plan_owner_mismatch",
      "System GoalPlan owner must be the knowledge viewer",
      viewerId,
      expectString(plan, "owner_actor_id", "GoalPlanProposal"),
      "owner_actor_id",
    );
  }
}

function assertCharacterDialogueResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "CharacterDialogueInput"),
    "CharacterDialogueInput.dialogue",
  );
  const day = expectInteger(dialogue, "day", "DialogueRecord");
  const commitments = objectArray(
    expectProperty(output, "commitments", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.commitments",
  );
  for (const [index, commitment] of commitments.entries()) {
    const validThrough = expectInteger(
      commitment,
      "valid_through_day",
      "AgencyCommitmentDraft",
    );
    if (validThrough < day) {
      throw fault(
        "model.semantic.commitment_expired_at_creation",
        "Agency commitment cannot expire before the dialogue day",
        {
          commitment_index: index,
          valid_through_day: validThrough,
          dialogue_day: day,
        },
      );
    }
  }
}

function assertCharacterReactResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const characterId = assertCharacterIdentity(request, input);
  const stimuli = objectArray(
    expectProperty(input, "events", "CharacterReactInput"),
    "CharacterReactInput.events",
  );
  const reactions = objectArray(
    expectProperty(output, "reactions", "CharacterReactOutput"),
    "CharacterReactOutput.reactions",
  );
  if (reactions.length !== stimuli.length) {
    throw fault(
      "model.semantic.reaction_count_mismatch",
      "Character reaction output must contain exactly one reaction per stimulus",
      {
        stimulus_count: stimuli.length,
        reaction_count: reactions.length,
      },
    );
  }
  assertUniqueIds(reactions, "reaction_id", "CharacterReactOutput.reactions");

  const stimulusById = new Map(
    stimuli.map((stimulus) => [
      expectString(stimulus, "proposal_id", "CharacterEventStimulus"),
      stimulus,
    ]),
  );
  const seenSources = new Set<string>();
  for (const [index, reaction] of reactions.entries()) {
    const source = expectJsonObject(
      expectProperty(reaction, "source_event", "CharacterReactionProposal"),
      "CharacterReactionProposal.source_event",
    );
    const proposalId = expectString(
      source,
      "proposal_id",
      "CharacterEventRef",
    );
    const stimulus = stimulusById.get(proposalId);
    if (stimulus === undefined) {
      throw fault(
        "model.semantic.reaction_source_unknown",
        "Character reaction references a stimulus not present in the request",
        { reaction_index: index, proposal_id: proposalId },
      );
    }
    if (seenSources.has(proposalId)) {
      throw fault(
        "model.semantic.reaction_source_duplicate",
        "Character output contains more than one reaction for a stimulus",
        { proposal_id: proposalId },
      );
    }
    seenSources.add(proposalId);
    assertReactionAgency(reaction, stimulus, characterId, index);
    assertUniqueIds(
      objectArray(
        expectProperty(
          reaction,
          "self_outcomes",
          "CharacterReactionProposal",
        ),
        `CharacterReactOutput.reactions[${index}].self_outcomes`,
      ),
      "outcome_id",
      `CharacterReactOutput.reactions[${index}].self_outcomes`,
    );
  }
}

function assertCharacterIdentity(
  request: JsonObject,
  input: JsonObject,
): string {
  const resident = expectJsonObject(
    expectProperty(request, "resident_context", "ModelRequest"),
    "ModelRequest.resident_context",
  );
  const subjective = expectJsonObject(
    expectProperty(input, "subjective_view", "CharacterModelInput"),
    "CharacterModelInput.subjective_view",
  );
  const character = expectJsonObject(
    expectProperty(subjective, "character", "CharacterSubjectiveView"),
    "CharacterSubjectiveView.character",
  );
  const knowledge = expectJsonObject(
    expectProperty(subjective, "knowledge_view", "CharacterSubjectiveView"),
    "CharacterSubjectiveView.knowledge_view",
  );
  const machine = expectJsonObject(
    expectProperty(subjective, "action_machine", "CharacterSubjectiveView"),
    "CharacterSubjectiveView.action_machine",
  );
  const characterId = expectString(character, "entity_id", "EntityRef");

  for (const pair of [
    {
      field: "resident_context.entity_id",
      actual: expectString(resident, "entity_id", "CharacterResidentContextRef"),
    },
    {
      field: "knowledge_view.viewer_entity_id",
      actual: expectString(knowledge, "viewer_entity_id", "KnowledgeView"),
    },
    {
      field: "action_machine.owner_entity_id",
      actual: expectString(
        machine,
        "owner_entity_id",
        "StateMachineInstanceState",
      ),
    },
  ] as const) {
    assertEqual(
      "model.semantic.character_identity_mismatch",
      "Character model request contains conflicting character identities",
      characterId,
      pair.actual,
      pair.field,
    );
  }
  assertEqual(
    "model.semantic.character_machine_scope",
    "Character action machine must have character scope",
    "character",
    expectString(machine, "machine_scope", "StateMachineInstanceState"),
    "action_machine.machine_scope",
  );
  return characterId;
}

function assertEventCardsBoundToDialogue(
  output: JsonObject,
  input: JsonObject,
  outputPath: string,
): void {
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDialogueInput"),
    "DirectorDialogueInput.world_view",
  );
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "DirectorDialogueInput"),
    "DirectorDialogueInput.dialogue",
  );
  const dialogueId = expectString(dialogue, "dialogue_id", "DialogueRecord");
  const day = expectInteger(worldView, "day", "DirectorWorldView");
  const cards = objectArray(
    expectProperty(output, "event_cards", outputPath),
    `${outputPath}.event_cards`,
  );
  assertUniqueIds(cards, "proposal_id", `${outputPath}.event_cards`);
  for (const [index, card] of cards.entries()) {
    assertEqual(
      "model.semantic.event_card_dialogue_mismatch",
      "EventCard source_dialogue_id does not match the input dialogue",
      dialogueId,
      expectString(card, "source_dialogue_id", "EventCardProposal"),
      "source_dialogue_id",
    );
    assertEqual(
      "model.semantic.event_card_day_mismatch",
      "EventCard day does not match the input world day",
      day,
      expectInteger(card, "day", "EventCardProposal"),
      "day",
    );
    assertEventCardGraph(card, `${outputPath}.event_cards[${index}]`);
  }
}

function assertEventCardGraph(card: JsonObject, path: string): void {
  const options = objectArray(
    expectProperty(card, "result_options", "EventCardProposal"),
    `${path}.result_options`,
  );
  assertUniqueIds(options, "option_id", `${path}.result_options`);
  const outcomes = options.flatMap((option, index) =>
    objectArray(
      expectProperty(option, "outcomes", "EventCardOutcomeDraft"),
      `${path}.result_options[${index}].outcomes`,
    ),
  );
  const gates = objectArray(
    expectProperty(card, "agency_gates", "EventCardProposal"),
    `${path}.agency_gates`,
  );
  assertProposalGraph(outcomes, gates, path);
}

function assertProposalGraph(
  outcomes: readonly JsonObject[],
  gates: readonly JsonObject[],
  path: string,
): void {
  assertUniqueIds(outcomes, "outcome_id", `${path}.outcomes`);
  assertUniqueIds(gates, "gate_id", `${path}.agency_gates`);
  const outcomeById = new Map(
    outcomes.map((outcome) => [
      expectString(outcome, "outcome_id", "SemanticOutcomeProposal"),
      outcome,
    ]),
  );
  const gateById = new Map(
    gates.map((gate) => [
      expectString(gate, "gate_id", "AgencyGate"),
      gate,
    ]),
  );
  const protectedByGate = new Map<string, Set<string>>();

  for (const gate of gates) {
    const gateId = expectString(gate, "gate_id", "AgencyGate");
    const protectedIds = new Set(
      stringArray(
        expectProperty(gate, "protected_outcome_ids", "AgencyGate"),
        `${path}.agency_gates.${gateId}.protected_outcome_ids`,
      ),
    );
    protectedByGate.set(gateId, protectedIds);
    for (const outcomeId of protectedIds) {
      const outcome = outcomeById.get(outcomeId);
      if (outcome === undefined) {
        throw fault(
          "model.semantic.agency_gate_outcome_unknown",
          "Agency gate references an outcome absent from its proposal",
          { gate_id: gateId, outcome_id: outcomeId },
        );
      }
      const requiredGate = outcome.requires_agency_gate_id;
      if (requiredGate !== gateId) {
        throw fault(
          "model.semantic.agency_gate_not_bidirectional",
          "Agency gate and protected outcome references are not bidirectionally closed",
          {
            gate_id: gateId,
            outcome_id: outcomeId,
            outcome_gate_id:
              typeof requiredGate === "string" ? requiredGate : null,
          },
        );
      }
    }
  }

  for (const outcome of outcomes) {
    if (outcome.requires_agency_gate_id === undefined) {
      continue;
    }
    const outcomeId = expectString(
      outcome,
      "outcome_id",
      "SemanticOutcomeProposal",
    );
    const gateId = expectString(
      outcome,
      "requires_agency_gate_id",
      "SemanticOutcomeProposal",
    );
    if (!gateById.has(gateId)) {
      throw fault(
        "model.semantic.outcome_agency_gate_unknown",
        "Outcome references an agency gate absent from its proposal",
        { outcome_id: outcomeId, gate_id: gateId },
      );
    }
    if (!(protectedByGate.get(gateId)?.has(outcomeId) ?? false)) {
      throw fault(
        "model.semantic.agency_gate_not_bidirectional",
        "Outcome and agency gate references are not bidirectionally closed",
        { outcome_id: outcomeId, gate_id: gateId },
      );
    }
  }
}

function assertReactionAgency(
  reaction: JsonObject,
  stimulus: JsonObject,
  characterId: string,
  reactionIndex: number,
): void {
  const gates = objectArray(
    expectProperty(stimulus, "agency_gates", "CharacterEventStimulus"),
    "CharacterEventStimulus.agency_gates",
  );
  const eligibleGateIds = new Set(
    gates
      .filter((gate) =>
        objectArray(
          expectProperty(gate, "participants", "AgencyGate"),
          "AgencyGate.participants",
        ).some(
          (participant) =>
            expectString(participant, "entity_id", "EntityRef") === characterId,
        ),
      )
      .map((gate) => expectString(gate, "gate_id", "AgencyGate")),
  );
  const decisions = objectArray(
    expectProperty(
      reaction,
      "agency_decisions",
      "CharacterReactionProposal",
    ),
    `CharacterReactOutput.reactions[${reactionIndex}].agency_decisions`,
  );
  assertUniqueIds(
    decisions,
    "gate_id",
    `CharacterReactOutput.reactions[${reactionIndex}].agency_decisions`,
  );
  const decisionGateIds = new Set(
    decisions.map((decision) =>
      expectString(decision, "gate_id", "AgencyDecision"),
    ),
  );
  if (
    decisionGateIds.size !== eligibleGateIds.size ||
    [...decisionGateIds].some((gateId) => !eligibleGateIds.has(gateId))
  ) {
    throw fault(
      "model.semantic.reaction_agency_coverage_mismatch",
      "Reaction agency decisions must exactly cover stimulus gates involving the character",
      {
        character_id: characterId,
        proposal_id: expectString(
          stimulus,
          "proposal_id",
          "CharacterEventStimulus",
        ),
        expected_gate_ids: [...eligibleGateIds],
        actual_gate_ids: [...decisionGateIds],
      },
    );
  }
}

function assertActiveDialogue(dialogue: JsonObject): void {
  if (expectString(dialogue, "status", "DialogueRecord") !== "active") {
    throw fault(
      "model.semantic.dialogue_not_active",
      "Model dialogue input must reference an active dialogue",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
      },
    );
  }
}

function assertFinalHumanTurn(dialogue: JsonObject): JsonObject {
  const turns = objectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const finalTurn = turns[turns.length - 1];
  if (finalTurn === undefined) {
    throw fault(
      "model.semantic.latest_player_turn_missing",
      "Model dialogue input has no final human turn",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
      },
    );
  }
  const source = expectJsonObject(
    expectProperty(finalTurn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (expectString(source, "source_kind", "DialogueTurnSource") !== "human") {
    throw fault(
      "model.semantic.latest_player_turn_mismatch",
      "Model reply input must end at the current human turn",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
        final_turn_id: expectString(finalTurn, "turn_id", "DialogueTurn"),
        final_source_kind: expectString(
          source,
          "source_kind",
          "DialogueTurnSource",
        ),
      },
    );
  }
  humanTurnSpeakerEntityId(finalTurn);
  return finalTurn;
}

function humanTurnSpeakerEntityId(turn: JsonObject): string {
  const speaker = expectJsonObject(
    expectProperty(turn, "speaker", "DialogueTurn"),
    "DialogueTurn.speaker",
  );
  if (
    expectString(speaker, "participant_kind", "DialogueParticipantRef") !==
    "entity"
  ) {
    throw fault(
      "model.semantic.human_speaker_invalid",
      "Human dialogue turn speaker must be an entity",
      {
        turn_id: expectString(turn, "turn_id", "DialogueTurn"),
      },
    );
  }
  const entity = expectJsonObject(
    expectProperty(speaker, "entity", "DialogueParticipantRef"),
    "DialogueParticipantRef.entity",
  );
  return expectString(entity, "entity_id", "EntityRef");
}

function assertEntityDialogueParticipant(
  dialogue: JsonObject,
  entityId: string,
  code: string,
  message: string,
): void {
  if (hasEntityDialogueParticipant(dialogue, entityId)) {
    return;
  }
  throw fault(code, message, {
    dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
    entity_id: entityId,
  });
}

function hasEntityDialogueParticipant(
  dialogue: JsonObject,
  entityId: string,
): boolean {
  return objectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).some((participant) => {
    if (
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) !== "entity"
    ) {
      return false;
    }
    const entity = expectJsonObject(
      expectProperty(participant, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    );
    return expectString(entity, "entity_id", "EntityRef") === entityId;
  });
}

function hasSystemDialogueParticipant(dialogue: JsonObject): boolean {
  return objectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  ).some(
    (participant) =>
      expectString(
        participant,
        "participant_kind",
        "DialogueParticipantRef",
      ) === "system",
  );
}

function assertDialogueParticipant(
  dialogue: JsonObject,
  characterId: string,
): void {
  if (!hasEntityDialogueParticipant(dialogue, characterId)) {
    throw fault(
      "model.semantic.character_not_dialogue_participant",
      "Character model resident is not a participant in the dialogue",
      {
        dialogue_id: expectString(dialogue, "dialogue_id", "DialogueRecord"),
        character_id: characterId,
      },
    );
  }
}

function assertUniqueProposalIdsAcross(
  proposals: readonly {
    readonly value: JsonObject;
    readonly path: string;
  }[],
  path: string,
): void {
  const seen = new Map<string, string>();
  for (const proposal of proposals) {
    const id = expectString(proposal.value, "proposal_id", proposal.path);
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw fault(
        "model.semantic.id_duplicate",
        `Duplicate proposal_id ${id}`,
        {
          path,
          field: "proposal_id",
          id,
          first_collection: previous,
          duplicate_collection: proposal.path,
        },
      );
    }
    seen.set(id, proposal.path);
  }
}

function assertUniqueIds(
  values: readonly JsonObject[],
  field: string,
  path: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const id = expectString(value, field, `${path}[${index}]`);
    if (seen.has(id)) {
      throw fault(
        "model.semantic.id_duplicate",
        `Duplicate ${field} ${id}`,
        { path, field, id },
      );
    }
    seen.add(id);
  }
}

function requestInput(request: JsonObject): JsonObject {
  return expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
}

function objectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault("model.semantic.shape", `${path} must be an array`, { path });
  }
  return value.map((entry, index) => {
    if (!isObject(entry as JsonValue)) {
      throw fault(
        "model.semantic.shape",
        `${path}[${index}] must be an object`,
        { path: `${path}[${index}]` },
      );
    }
    return entry as JsonObject;
  });
}

function stringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw fault(
      "model.semantic.shape",
      `${path} must be a string array`,
      { path },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw fault(
        "model.semantic.shape",
        `${path}[${index}] must be a string`,
        { path: `${path}[${index}]` },
      );
    }
    return entry;
  });
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEqual(
  code: string,
  message: string,
  expected: number | string,
  actual: number | string,
  field: string,
): void {
  if (expected !== actual) {
    throw fault(code, message, { field, expected, actual });
  }
}

function fault(
  code: string,
  message: string,
  details: JsonObject,
): EngineFault {
  return new EngineFault(code, message, details);
}

const _requestExhaustive: {
  readonly [K in RequestKind]: true;
} = {
  "director.daily_settlement": true,
  "director.dialogue_events": true,
  "director.system_dialogue": true,
  "character.dialogue": true,
  "character.react": true,
};
void _requestExhaustive;
