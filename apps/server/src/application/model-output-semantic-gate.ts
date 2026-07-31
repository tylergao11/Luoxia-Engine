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
  "director.goal_plan",
  "director.definition_draft",
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
  "director.goal_plan": assertDirectorGoalPlanRequest,
  "director.definition_draft": assertDirectorDefinitionDraftRequest,
  "character.dialogue": assertCharacterDialogueRequest,
  "character.react": assertCharacterReactRequest,
};

const RESPONSE_HANDLERS: {
  readonly [K in RequestKind]: ResponseHandler;
} = {
  "director.daily_settlement": assertDirectorDailyResponse,
  "director.dialogue_events": assertDirectorDialogueEventsResponse,
  "director.system_dialogue": assertDirectorSystemDialogueResponse,
  "director.goal_plan": assertDirectorGoalPlanResponse,
  "director.definition_draft": assertDirectorDefinitionDraftResponse,
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
  assertDirectorStateMachineViews(worldView);
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
  assertDirectorStateMachineViews(worldView);
  assertEqual(
    "model.semantic.dialogue_day_mismatch",
    "Dialogue day does not match Director world day",
    expectInteger(worldView, "day", "DirectorWorldView"),
    expectInteger(dialogue, "day", "DialogueRecord"),
    "day",
  );
  const triggeringHumanTurn =
    assertCompletedDialogueExchange(dialogue, [
      "character_mind",
      "director_system",
    ]);
  assertEqual(
    "model.semantic.response_locale_mismatch",
    "Dialogue-event locale must come from the human turn that triggered the completed exchange",
    expectString(triggeringHumanTurn, "locale", "DialogueTurn"),
    expectString(
      input,
      "response_locale",
      "DirectorDialogueEventsInput",
    ),
    "response_locale",
  );
}

function assertDirectorSystemDialogueRequest(request: JsonObject): void {
  const input = requestInput(request);
  assertDirectorKnowledgeDialogueInput(
    input,
    "DirectorSystemDialogueInput",
    "awaiting_response",
  );
}

function assertDirectorGoalPlanRequest(request: JsonObject): void {
  const input = requestInput(request);
  const { dialogue, viewerId } = assertDirectorKnowledgeDialogueInput(
    input,
    "DirectorGoalPlanInput",
    "completed_system_exchange",
  );
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorGoalPlanInput"),
    "DirectorGoalPlanInput.world_view",
  );
  assertDirectorStateMachineViews(worldView);
  const actorIds = new Set(
    objectArray(
      expectProperty(worldView, "actors", "DirectorWorldView"),
      "DirectorWorldView.actors",
    ).map((actor) => expectString(actor, "entity_id", "DirectorActorView")),
  );
  if (!actorIds.has(viewerId)) {
    throw fault(
      "model.semantic.goal_plan_owner_missing",
      "Goal planning knowledge viewer is absent from the Director world actors",
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

function assertDirectorDefinitionDraftRequest(request: JsonObject): void {
  assertDirectorKnowledgeDialogueInput(
    requestInput(request),
    "DirectorDefinitionDraftInput",
    "completed_system_exchange",
  );
}

function assertDirectorKnowledgeDialogueInput(
  input: JsonObject,
  path: string,
  exchangeState: "awaiting_response" | "completed_system_exchange",
): { readonly dialogue: JsonObject; readonly viewerId: string } {
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", path),
    `${path}.dialogue`,
  );
  assertActiveDialogue(dialogue);
  const triggeringHumanTurn =
    exchangeState === "awaiting_response"
      ? assertFinalHumanTurn(dialogue)
      : assertCompletedDialogueExchange(dialogue, [
          "director_system",
        ]);
  const knowledgeView = expectJsonObject(
    expectProperty(input, "knowledge_view", path),
    `${path}.knowledge_view`,
  );
  const viewerId = expectString(
    knowledgeView,
    "viewer_entity_id",
    "KnowledgeView",
  );
  const speakerId = humanTurnSpeakerEntityId(triggeringHumanTurn);
  assertEqual(
    "model.semantic.director_viewer_mismatch",
    "Director knowledge viewer must be the final human speaker",
    speakerId,
    viewerId,
    "knowledge_view.viewer_entity_id",
  );
  assertEntityDialogueParticipant(
    dialogue,
    viewerId,
    "model.semantic.director_viewer_not_participant",
    "Director knowledge viewer is not a participant in the dialogue",
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
  assertEqual(
    "model.semantic.response_locale_mismatch",
    "Response locale must come from the human turn that triggered the current exchange",
    expectString(triggeringHumanTurn, "locale", "DialogueTurn"),
    expectString(input, "response_locale", path),
    "response_locale",
  );
  return Object.freeze({ dialogue, viewerId });
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
  assertEqual(
    "model.semantic.response_locale_mismatch",
    "Character response locale must come from the final human turn",
    expectString(latestTurn, "locale", "DialogueTurn"),
    expectString(input, "response_locale", "CharacterDialogueInput"),
    "response_locale",
  );
}

function assertCharacterReactRequest(request: JsonObject): void {
  const input = requestInput(request);
  const day = expectInteger(input, "day", "CharacterReactInput");
  if (day < 1) {
    throw fault(
      "model.semantic.character_react_day_invalid",
      "Character reaction batch day must be a positive day number",
      { day },
    );
  }
  assertCharacterIdentity(request, input);
  const events = objectArray(
    expectProperty(input, "events", "CharacterReactInput"),
    "CharacterReactInput.events",
  );
  for (const [eventIndex, event] of events.entries()) {
    assertCharacterReactEventInput(
      event,
      `CharacterReactInput.events[${eventIndex}]`,
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
  const actors = objectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const intents = objectArray(
    expectProperty(output, "automatic_events", "DirectorDailySettlementOutput"),
    "DirectorDailySettlementOutput.automatic_events",
  );

  for (const [draftIndex, intent] of intents.entries()) {
    const path =
      `DirectorDailySettlementOutput.automatic_events[${draftIndex}]`;
    const scope = expectString(intent, "scope", "DailySettlementEventIntent");
    expectString(intent, "event_type", path);
    expectString(intent, "summary", path);
    expectString(intent, "outcome_type", path);
    expectJsonObject(
      expectProperty(intent, "parameters", path),
      `${path}.parameters`,
    );
    if (scope === "world") {
      const indices = assertIndexSelectorsWithin(
        intent,
        "subject_actor_indices",
        actors.length,
        path,
      );
      assertDailyIntentActorsActive(actors, indices, path);
      if (Object.prototype.hasOwnProperty.call(intent, "agency")) {
        throw fault(
          "model.semantic.daily_intent_agency_scope",
          "World daily settlement intent must not carry agency",
          { path },
        );
      }
      continue;
    }
    if (scope === "character") {
      const indices = assertIndexSelectorsWithin(
        intent,
        "target_actor_indices",
        actors.length,
        path,
      );
      assertDailyIntentActorsActive(actors, indices, path);
      const agency = intent["agency"];
      if (agency !== null && agency !== undefined) {
        const agencyObject = expectJsonObject(agency, `${path}.agency`);
        expectString(agencyObject, "semantic_intent", `${path}.agency`);
        expectJsonObject(
          expectProperty(agencyObject, "policy", `${path}.agency`),
          `${path}.agency.policy`,
        );
        expectJsonObject(
          expectProperty(agencyObject, "terms", `${path}.agency`),
          `${path}.agency.terms`,
        );
      }
      continue;
    }
    throw fault(
      "model.semantic.automatic_event_scope_unknown",
      `Unknown daily settlement intent scope ${scope}`,
      { draft_index: draftIndex, scope },
    );
  }
}

function assertDailyIntentActorsActive(
  actors: readonly JsonObject[],
  indices: readonly number[],
  path: string,
): void {
  for (const index of indices) {
    const actor = actors[index];
    if (actor === undefined) {
      throw fault(
        "model.semantic.daily_intent_actor_missing",
        "Daily settlement intent actor index is out of range",
        { path, index },
      );
    }
    const status = expectString(actor, "status", "DirectorActorView");
    if (status !== "active") {
      throw fault(
        "model.semantic.daily_intent_actor_inactive",
        "Daily settlement intent must name active actors only",
        { path, index, status },
      );
    }
  }
}

function assertDirectorDialogueEventsResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDialogueEventsInput"),
    "DirectorDialogueEventsInput.world_view",
  );
  const actors = objectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  );
  const dialogue = expectJsonObject(
    expectProperty(input, "dialogue", "DirectorDialogueEventsInput"),
    "DirectorDialogueEventsInput.dialogue",
  );
  const cards = objectArray(
    expectProperty(output, "event_cards", "DirectorDialogueEventsOutput"),
    "DirectorDialogueEventsOutput.event_cards",
  );
  // Schema + product: one observation → one open-envelope card.
  if (cards.length !== 1) {
    throw fault(
      "model.output.dialogue_events_card_count",
      "director.dialogue_events must return exactly one EventCardSemanticDraft",
      { event_card_count: cards.length },
    );
  }
  for (const [cardIndex, card] of cards.entries()) {
    assertEventCardDraft(
      card,
      actors.length,
      dialogue,
      `DirectorDialogueEventsOutput.event_cards[${cardIndex}]`,
    );
  }
}

function assertDirectorSystemDialogueResponse(
  _request: JsonObject,
  output: JsonObject,
): void {
  const reply = expectJsonObject(
    expectProperty(output, "reply", "DirectorSystemDialogueOutput"),
    "DirectorSystemDialogueOutput.reply",
  );
  expectString(reply, "text", "DialogueReplyDraft");
}

function assertDirectorGoalPlanResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const draft = expectJsonObject(
    expectProperty(output, "draft", "DirectorGoalPlanOutput"),
    "DirectorGoalPlanOutput.draft",
  );
  const nodes = objectArray(
    expectProperty(draft, "nodes", "GoalPlanSemanticDraft"),
    "GoalPlanSemanticDraft.nodes",
  );
  const dependencies: number[][] = [];
  assertUniqueModelIndexArray(
    draft,
    "constraint_law_indices",
    "GoalPlanSemanticDraft",
  );
  for (const [nodeIndex, node] of nodes.entries()) {
    const path = `GoalPlanSemanticDraft.nodes[${nodeIndex}]`;
    assertGoalCapabilityRequirement(node, path);
    assertUniqueModelIndexArray(
      node,
      "completion_rule_indices",
      path,
    );
    dependencies.push(
      assertIndexSelectorsWithin(
        node,
        "depends_on",
        nodes.length,
        path,
        nodeIndex,
      ),
    );
    assertIndexSelectorsWithin(
      node,
      "alternatives",
      nodes.length,
      path,
      nodeIndex,
    );
  }
  assertAcyclicGoalDependencies(dependencies);

  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorGoalPlanInput"),
    "DirectorGoalPlanInput.world_view",
  );
  const knowledgeView = expectJsonObject(
    expectProperty(input, "knowledge_view", "DirectorGoalPlanInput"),
    "DirectorGoalPlanInput.knowledge_view",
  );
  const worldFacts = objectArray(
    expectProperty(worldView, "facts", "DirectorWorldView"),
    "DirectorWorldView.facts",
  );
  const knowledgeFacts = objectArray(
    expectProperty(knowledgeView, "facts", "KnowledgeView"),
    "KnowledgeView.facts",
  );
  const facts = objectArray(
    expectProperty(draft, "facts", "GoalPlanSemanticDraft"),
    "GoalPlanSemanticDraft.facts",
  );
  const seenFacts = new Set<string>();
  for (const [selectorIndex, selector] of facts.entries()) {
    const source = expectString(selector, "source", "FactSelector");
    const index = expectInteger(selector, "index", "FactSelector");
    const limit =
      source === "knowledge" ? knowledgeFacts.length : worldFacts.length;
    if (index < 0 || index >= limit) {
      throw fault(
        "model.semantic.fact_selector_out_of_range",
        "Goal plan fact selector is outside the verified request view",
        {
          selector_index: selectorIndex,
          source,
          index,
          available: limit,
        },
      );
    }
    const key = `${source}:${index}`;
    if (seenFacts.has(key)) {
      throw fault(
        "model.semantic.index_duplicate",
        "Goal plan facts cannot select the same verified fact twice",
        {
          path: "GoalPlanSemanticDraft.facts",
          source,
          index,
        },
      );
    }
    seenFacts.add(key);
  }
}

function assertDirectorDefinitionDraftResponse(
  _request: JsonObject,
  output: JsonObject,
): void {
  const draft = expectJsonObject(
    expectProperty(output, "draft", "DirectorDefinitionDraftOutput"),
    "DirectorDefinitionDraftOutput.draft",
  );
  assertModelIndex(
    draft,
    "definition_type_index",
    "DynamicDefinitionSemanticDraft",
  );
  expectString(draft, "name", "DynamicDefinitionSemanticDraft");
  expectString(draft, "summary", "DynamicDefinitionSemanticDraft");
  expectString(draft, "rationale", "DynamicDefinitionSemanticDraft");
  const components = objectArray(
    expectProperty(draft, "components", "DynamicDefinitionSemanticDraft"),
    "DynamicDefinitionSemanticDraft.components",
  );
  const seenComponentTypes = new Set<number>();
  for (const [componentIndex, component] of components.entries()) {
    const path =
      `DynamicDefinitionSemanticDraft.components[${componentIndex}]`;
    const componentTypeIndex = assertModelIndex(
      component,
      "component_type_index",
      path,
    );
    if (seenComponentTypes.has(componentTypeIndex)) {
      throw fault(
        "model.semantic.index_duplicate",
        "Dynamic definition components cannot select the same component type twice",
        {
          path: "DynamicDefinitionSemanticDraft.components",
          component_type_index: componentTypeIndex,
        },
      );
    }
    seenComponentTypes.add(componentTypeIndex);
  }
}

function assertGoalCapabilityRequirement(
  node: JsonObject,
  path: string,
): void {
  const requirement = expectJsonObject(
    expectProperty(node, "capability_requirement", "GoalNodeSemanticDraft"),
    `${path}.capability_requirement`,
  );
  const requirementPath = `${path}.capability_requirement`;
  const requirementKind = expectString(
    requirement,
    "requirement_kind",
    "CapabilityRequirementSelector",
  );
  if (requirementKind === "bound") {
    assertModelIndex(requirement, "capability_index", requirementPath);
    return;
  }
  if (requirementKind === "demand") {
    assertUniqueModelIndexArray(
      requirement,
      "allowed_archetype_indices",
      requirementPath,
    );
    assertUniqueModelIndexArray(
      requirement,
      "constraint_law_indices",
      requirementPath,
    );
    return;
  }
  throw fault(
    "model.semantic.capability_requirement_kind_unknown",
    "Goal node has an unsupported capability requirement kind",
    { path: requirementPath, requirement_kind: requirementKind },
  );
}

function assertModelIndex(
  owner: JsonObject,
  field: string,
  path: string,
): number {
  const index = expectInteger(owner, field, path);
  if (index < 0) {
    throw fault(
      "model.semantic.index_out_of_range",
      "Model index must be a non-negative local selection-space ordinal",
      { path: `${path}.${field}`, index },
    );
  }
  return index;
}

function assertUniqueModelIndexArray(
  owner: JsonObject,
  field: string,
  path: string,
): number[] {
  const values = expectProperty(owner, field, path);
  if (!Array.isArray(values)) {
    throw fault(
      "model.semantic.shape",
      `${path}.${field} must be an array`,
      { path: `${path}.${field}` },
    );
  }
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const [ordinal, value] of values.entries()) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw fault(
        "model.semantic.index_out_of_range",
        "Model index must be a non-negative local selection-space ordinal",
        { path: `${path}.${field}[${ordinal}]`, index: value },
      );
    }
    if (seen.has(value)) {
      throw fault(
        "model.semantic.index_duplicate",
        "Model index collection cannot contain duplicates",
        { path: `${path}.${field}`, index: value },
      );
    }
    seen.add(value);
    indices.push(value);
  }
  return indices;
}

function assertIndexSelectorsWithin(
  owner: JsonObject,
  field: string,
  limit: number,
  path: string,
  disallowedIndex?: number,
): number[] {
  const selectors = expectProperty(owner, field, path);
  if (!Array.isArray(selectors)) {
    throw fault(
      "model.semantic.shape",
      `${path}.${field} must be an array`,
      { path: `${path}.${field}` },
    );
  }
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const [selectorIndex, value] of selectors.entries()) {
    const index =
      typeof value === "number" && Number.isInteger(value) ? value : -1;
    if (index < 0 || index >= limit) {
      throw fault(
        "model.semantic.index_out_of_range",
        "Model index is outside the referenced request or draft collection",
        {
          path: `${path}.${field}[${selectorIndex}]`,
          index,
          available: limit,
        },
      );
    }
    if (index === disallowedIndex) {
      throw fault(
        "model.semantic.graph_self_reference",
        "Model graph entry cannot reference itself",
        {
          path: `${path}.${field}[${selectorIndex}]`,
          index,
        },
      );
    }
    if (seen.has(index)) {
      throw fault(
        "model.semantic.index_duplicate",
        "Model index collection cannot contain duplicates",
        {
          path: `${path}.${field}`,
          index,
        },
      );
    }
    seen.add(index);
    indices.push(index);
  }
  return indices;
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
  const reply = expectJsonObject(
    expectProperty(output, "reply", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.reply",
  );
  expectString(reply, "text", "DialogueReplyDraft");
  const participants = objectArray(
    expectProperty(dialogue, "participants", "DialogueRecord"),
    "DialogueRecord.participants",
  );
  const commitments = objectArray(
    expectProperty(output, "commitments", "CharacterDialogueOutput"),
    "CharacterDialogueOutput.commitments",
  );
  for (const [index, commitment] of commitments.entries()) {
    const path = `CharacterDialogueOutput.commitments[${index}]`;
    const subjectParticipantIndices = assertIndexSelectorsWithin(
      commitment,
      "subject_participant_indices",
      participants.length,
      path,
    );
    for (const participantIndex of subjectParticipantIndices) {
      const participant = participants[participantIndex];
      if (
        participant === undefined ||
        expectString(
          participant,
          "participant_kind",
          "DialogueParticipantRef",
        ) !== "entity"
      ) {
        throw fault(
          "model.semantic.commitment_subject_not_entity",
          "Agency commitment subjects must select entity dialogue participants",
          {
            commitment_index: index,
            participant_index: participantIndex,
          },
        );
      }
    }
  }
}

function assertAcyclicGoalDependencies(
  dependencies: readonly (readonly number[])[],
): void {
  const states = new Uint8Array(dependencies.length);
  const visit = (nodeIndex: number): void => {
    if (states[nodeIndex] === 2) {
      return;
    }
    if (states[nodeIndex] === 1) {
      throw fault(
        "model.semantic.goal_dependency_cycle",
        "Goal plan dependency graph must be acyclic",
        { node_index: nodeIndex },
      );
    }
    states[nodeIndex] = 1;
    for (const dependencyIndex of dependencies[nodeIndex] ?? []) {
      visit(dependencyIndex);
    }
    states[nodeIndex] = 2;
  };
  for (let nodeIndex = 0; nodeIndex < dependencies.length; nodeIndex += 1) {
    visit(nodeIndex);
  }
}

function assertCharacterReactResponse(
  request: JsonObject,
  output: JsonObject,
): void {
  const input = requestInput(request);
  const characterId = assertCharacterIdentity(request, input);
  const events = objectArray(
    expectProperty(input, "events", "CharacterReactInput"),
    "CharacterReactInput.events",
  );
  const reactions = objectArray(
    expectProperty(output, "reactions", "CharacterReactOutput"),
    "CharacterReactOutput.reactions",
  );
  const subjective = expectJsonObject(
    expectProperty(input, "subjective_view", "CharacterReactInput"),
    "CharacterReactInput.subjective_view",
  );
  const actionMachine = expectJsonObject(
    expectProperty(
      subjective,
      "action_machine",
      "CharacterSubjectiveView",
    ),
    "CharacterSubjectiveView.action_machine",
  );
  const outgoingTransitions = objectArray(
    expectProperty(
      actionMachine,
      "outgoing_transitions",
      "StateMachineModelView",
    ),
    "StateMachineModelView.outgoing_transitions",
  );
  if (reactions.length !== events.length) {
    throw fault(
      "model.semantic.reaction_count_mismatch",
      "Character reaction output must contain exactly one reaction per input event",
      {
        event_count: events.length,
        reaction_count: reactions.length,
      },
    );
  }

  let transitionDecisionCount = 0;
  for (const [index, reaction] of reactions.entries()) {
    const event = events[index];
    if (event === undefined) {
      throw fault(
        "model.semantic.reaction_ordinal_missing",
        "Character reaction ordinal has no corresponding request event",
        { reaction_index: index },
      );
    }
    assertReactionAgency(reaction, event, characterId, index);
    if (
      assertMachineDecision(
        expectJsonObject(
          expectProperty(
            reaction,
            "machine_decision",
            "CharacterReactionSemanticDraft",
          ),
          "CharacterReactionSemanticDraft.machine_decision",
        ),
        outgoingTransitions.length,
        index,
      )
    ) {
      transitionDecisionCount += 1;
      if (transitionDecisionCount > 1) {
        throw fault(
          "model.semantic.machine_decision_batch_multi_transition",
          "One character.react batch may select at most one state-machine transition from its shared current-state view",
          { transition_decisions: transitionDecisionCount },
        );
      }
    }
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
  const machineView = expectJsonObject(
    expectProperty(subjective, "action_machine", "CharacterSubjectiveView"),
    "CharacterSubjectiveView.action_machine",
  );
  assertStateMachineModelView(machineView);
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
  ] as const) {
    assertEqual(
      "model.semantic.character_identity_mismatch",
      "Character model request contains conflicting character identities",
      characterId,
      pair.actual,
      pair.field,
    );
  }
  return characterId;
}

function assertDirectorStateMachineViews(worldView: JsonObject): void {
  for (const actor of objectArray(
    expectProperty(worldView, "actors", "DirectorWorldView"),
    "DirectorWorldView.actors",
  )) {
    if (actor.action_machine === undefined) {
      continue;
    }
    assertStateMachineModelView(
      expectJsonObject(
        actor.action_machine,
        "DirectorActorView.action_machine",
      ),
    );
  }
  for (const view of objectArray(
    expectProperty(worldView, "world_machines", "DirectorWorldView"),
    "DirectorWorldView.world_machines",
  )) {
    assertStateMachineModelView(view);
  }
}

function assertStateMachineModelView(view: JsonObject): void {
  const currentState = expectJsonObject(
    expectProperty(view, "current_state", "StateMachineModelView"),
    "StateMachineModelView.current_state",
  );
  const stateId = expectString(
    currentState,
    "state_id",
    "MachineStateDefinition",
  );
  const transitionIds = new Set<string>();
  for (const outgoing of objectArray(
    expectProperty(view, "outgoing_transitions", "StateMachineModelView"),
    "StateMachineModelView.outgoing_transitions",
  )) {
    const transition = expectJsonObject(
      expectProperty(
        outgoing,
        "transition",
        "StateMachineTransitionModelView",
      ),
      "StateMachineTransitionModelView.transition",
    );
    const targetState = expectJsonObject(
      expectProperty(
        outgoing,
        "target_state",
        "StateMachineTransitionModelView",
      ),
      "StateMachineTransitionModelView.target_state",
    );
    const transitionId = expectString(
      transition,
      "transition_id",
      "MachineTransitionDefinition",
    );
    if (transitionIds.has(transitionId)) {
      throw fault(
        "model.semantic.state_machine_transition_duplicate",
        "StateMachineModelView contains a duplicate outgoing transition",
        { transition_id: transitionId },
      );
    }
    transitionIds.add(transitionId);
    assertEqual(
      "model.semantic.state_machine_transition_from_mismatch",
      "Outgoing transition must leave the exact current state",
      stateId,
      expectString(
        transition,
        "from_state_id",
        "MachineTransitionDefinition",
      ),
      "outgoing.transition.from_state_id",
    );
    assertEqual(
      "model.semantic.state_machine_transition_target_mismatch",
      "Outgoing transition target state must match transition.to_state_id",
      expectString(
        transition,
        "to_state_id",
        "MachineTransitionDefinition",
      ),
      expectString(targetState, "state_id", "MachineStateDefinition"),
      "outgoing.target_state.state_id",
    );
  }
}

function assertCharacterReactEventInput(
  event: JsonObject,
  path: string,
): void {
  const situation = expectJsonObject(
    expectProperty(event, "situation", "CharacterReactEventInput"),
    `${path}.situation`,
  );
  const situationSubjectIds = new Set(
    assertUniqueStringField(
      situation,
      "subject_entity_ids",
      `${path}.situation`,
    ),
  );
  const outcomes = objectArray(
    expectProperty(
      event,
      "candidate_outcomes",
      "CharacterReactEventInput",
    ),
    `${path}.candidate_outcomes`,
  );
  const gates = objectArray(
    expectProperty(event, "agency_gates", "CharacterReactEventInput"),
    `${path}.agency_gates`,
  );
  assertCharacterReactEventGraph(outcomes, gates, path);

  for (const [outcomeIndex, outcome] of outcomes.entries()) {
    assertEntityReferencesWithin(
      outcome,
      "subject_entity_ids",
      situationSubjectIds,
      `${path}.candidate_outcomes[${outcomeIndex}]`,
    );
  }
  for (const [gateIndex, gate] of gates.entries()) {
    const gatePath = `${path}.agency_gates[${gateIndex}]`;
    assertEntityReferencesWithin(
      gate,
      "participant_entity_ids",
      situationSubjectIds,
      gatePath,
    );
    const requirement = expectJsonObject(
      expectProperty(
        gate,
        "requirement",
        "CharacterReactAgencyGateInput",
      ),
      `${gatePath}.requirement`,
    );
    assertEntityReferencesWithin(
      requirement,
      "subject_entity_ids",
      situationSubjectIds,
      `${gatePath}.requirement`,
    );
  }
}

function assertMachineDecision(
  decision: JsonObject,
  outgoingTransitionCount: number,
  reactionIndex: number,
): boolean {
  const decisionKind = expectString(
    decision,
    "decision_kind",
    "MachineDecisionSelector",
  );
  if (decisionKind === "keep") {
    return false;
  }
  if (decisionKind !== "transition") {
    throw fault(
      "model.semantic.machine_decision_kind_unknown",
      "Character reaction has an unsupported machine decision kind",
      { reaction_index: reactionIndex, decision_kind: decisionKind },
    );
  }
  assertModelIndexWithin(
    decision,
    "transition_index",
    outgoingTransitionCount,
    `CharacterReactOutput.reactions[${reactionIndex}].machine_decision`,
  );
  return true;
}

function assertEventSituationDraft(
  situation: JsonObject,
  actorCount: number,
  path: string,
): number[] {
  return assertIndexSelectorsWithin(
    situation,
    "subject_actor_indices",
    actorCount,
    path,
  );
}

function assertEventCardDraft(
  card: JsonObject,
  actorCount: number,
  dialogue: JsonObject,
  path: string,
): void {
  const situation = expectJsonObject(
    expectProperty(card, "situation", "EventCardSemanticDraft"),
    `${path}.situation`,
  );
  const situationActorIndices = assertEventSituationDraft(
    situation,
    actorCount,
    `${path}.situation`,
  );
  const options = objectArray(
    expectProperty(card, "result_options", "EventCardSemanticDraft"),
    `${path}.result_options`,
  );
  // One sealed result path; multi effects → outcomes[], not multi options.
  if (options.length !== 1) {
    throw fault(
      "model.semantic.event_card_result_options_count",
      "EventCardSemanticDraft.result_options must contain exactly one result option",
      {
        path: `${path}.result_options`,
        result_option_count: options.length,
      },
    );
  }
  const outcomes: JsonObject[] = [];
  for (const [optionIndex, option] of options.entries()) {
    outcomes.push(
      ...objectArray(
        expectProperty(
          option,
          "outcomes",
          "EventCardOutcomeSemanticDraft",
        ),
        `${path}.result_options[${optionIndex}].outcomes`,
      ),
    );
    const presentation = expectJsonObject(
      expectProperty(
        option,
        "presentation",
        "EventCardOutcomeSemanticDraft",
      ),
      `${path}.result_options[${optionIndex}].presentation`,
    );
    assertNarrativeSegments(
      presentation,
      dialogue,
      `${path}.result_options[${optionIndex}].presentation`,
    );
  }
  const gates = objectArray(
    expectProperty(card, "agency_gates", "EventCardSemanticDraft"),
    `${path}.agency_gates`,
  );
  // Non-empty gate requires commitment_evidence; else use agency_gates: [].
  for (const [gateIndex, gate] of gates.entries()) {
    const evidence = objectArray(
      expectProperty(
        gate,
        "commitment_evidence",
        "EventCardAgencyGateSemanticDraft",
      ),
      `${path}.agency_gates[${gateIndex}].commitment_evidence`,
    );
    if (evidence.length === 0) {
      throw fault(
        "model.semantic.agency_gate_without_commitment_evidence",
        "EventCard agency_gates must cite at least one dialogue commitment_evidence entry; use an empty agency_gates array when no NPC commitment applies",
        {
          path: `${path}.agency_gates[${gateIndex}]`,
          gate_index: gateIndex,
        },
      );
    }
  }
  assertSemanticEventGraph(
    outcomes,
    gates,
    actorCount,
    situationActorIndices,
    path,
  );
  for (const [gateIndex, gate] of gates.entries()) {
    assertDialogueCommitmentSelectors(
      gate,
      dialogue,
      `${path}.agency_gates[${gateIndex}]`,
    );
  }
}

function assertNarrativeSegments(
  presentation: JsonObject,
  dialogue: JsonObject,
  path: string,
): void {
  const turns = objectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const segments = objectArray(
    expectProperty(
      presentation,
      "segments",
      "EventResultPresentationSemanticDraft",
    ),
    `${path}.segments`,
  );
  for (const [segmentIndex, segment] of segments.entries()) {
    if (
      expectString(
        segment,
        "segment_kind",
        "NarrativeSegmentSemanticDraft",
      ) === "dialogue_quote"
    ) {
      assertModelIndexWithin(
        segment,
        "turn_index",
        turns.length,
        `${path}.segments[${segmentIndex}]`,
      );
    }
  }
}

function assertDialogueCommitmentSelectors(
  gate: JsonObject,
  dialogue: JsonObject,
  path: string,
): void {
  const turns = objectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const selectors = objectArray(
    expectProperty(
      gate,
      "commitment_evidence",
      "EventCardAgencyGateSemanticDraft",
    ),
    `${path}.commitment_evidence`,
  );
  const seen = new Set<string>();
  for (const [selectorIndex, selector] of selectors.entries()) {
    const selectorPath = `${path}.commitment_evidence[${selectorIndex}]`;
    const turnIndex = assertModelIndexWithin(
      selector,
      "turn_index",
      turns.length,
      selectorPath,
    );
    const turn = turns[turnIndex];
    if (turn === undefined) {
      throw fault(
        "model.semantic.index_out_of_range",
        "Dialogue commitment selector turn is outside the verified dialogue",
        { path: `${selectorPath}.turn_index`, index: turnIndex },
      );
    }
    const commitments = objectArray(
      expectProperty(turn, "agency_commitments", "DialogueTurn"),
      `DialogueRecord.turns[${turnIndex}].agency_commitments`,
    );
    const commitmentIndex = assertModelIndexWithin(
      selector,
      "commitment_index",
      commitments.length,
      selectorPath,
    );
    const key = `${turnIndex}:${commitmentIndex}`;
    if (seen.has(key)) {
      throw fault(
        "model.semantic.commitment_selector_duplicate",
        "EventCard agency gate cannot cite the same dialogue commitment twice",
        {
          path: `${path}.commitment_evidence`,
          turn_index: turnIndex,
          commitment_index: commitmentIndex,
        },
      );
    }
    seen.add(key);
  }
}

function assertSemanticEventGraph(
  outcomes: readonly JsonObject[],
  gates: readonly JsonObject[],
  actorCount: number,
  situationActorIndices: readonly number[],
  path: string,
): void {
  const situationActorSet = new Set(situationActorIndices);
  const requiredGateByOutcome: Array<number | undefined> = [];
  for (const [outcomeIndex, outcome] of outcomes.entries()) {
    const outcomePath = `${path}.outcomes[${outcomeIndex}]`;
    assertActorIndicesWithinSituation(
      outcome,
      "subject_indices",
      actorCount,
      situationActorSet,
      outcomePath,
    );
    requiredGateByOutcome.push(
      outcome.requires_agency_gate_index === undefined
        ? undefined
        : assertModelIndexWithin(
            outcome,
            "requires_agency_gate_index",
            gates.length,
            outcomePath,
          ),
    );
  }

  const protectedByGate: Array<ReadonlySet<number>> = [];
  for (const [gateIndex, gate] of gates.entries()) {
    const gatePath = `${path}.agency_gates[${gateIndex}]`;
    const protectedOutcomeIndices = assertIndexSelectorsWithin(
      gate,
      "protected_outcome_indices",
      outcomes.length,
      gatePath,
    );
    protectedByGate.push(new Set(protectedOutcomeIndices));
    assertActorIndicesWithinSituation(
      gate,
      "participant_subject_indices",
      actorCount,
      situationActorSet,
      gatePath,
    );
    const requirement = expectJsonObject(
      expectProperty(
        gate,
        "requirement",
        "AgencyGateSemanticDraft",
      ),
      `${gatePath}.requirement`,
    );
    assertActorIndicesWithinSituation(
      requirement,
      "subject_indices",
      actorCount,
      situationActorSet,
      `${gatePath}.requirement`,
    );
    for (const outcomeIndex of protectedOutcomeIndices) {
      if (requiredGateByOutcome[outcomeIndex] !== gateIndex) {
        throw fault(
          "model.semantic.agency_gate_not_bidirectional",
          "Agency gate and protected outcome indices must be bidirectionally closed",
          {
            gate_index: gateIndex,
            outcome_index: outcomeIndex,
            outcome_gate_index:
              requiredGateByOutcome[outcomeIndex] ?? null,
          },
        );
      }
    }
  }

  for (const [outcomeIndex, gateIndex] of requiredGateByOutcome.entries()) {
    if (gateIndex === undefined) {
      continue;
    }
    if (!(protectedByGate[gateIndex]?.has(outcomeIndex) ?? false)) {
      throw fault(
        "model.semantic.agency_gate_not_bidirectional",
        "Outcome and agency gate indices must be bidirectionally closed",
        { outcome_index: outcomeIndex, gate_index: gateIndex },
      );
    }
  }
}

function assertActorIndicesWithinSituation(
  owner: JsonObject,
  field: string,
  actorCount: number,
  situationActorSet: ReadonlySet<number>,
  path: string,
): readonly number[] {
  const indices = assertIndexSelectorsWithin(owner, field, actorCount, path);
  for (const index of indices) {
    if (!situationActorSet.has(index)) {
      throw fault(
        "model.semantic.subject_outside_situation",
        "Event subject index must name a world_view actor already selected by the situation",
        {
          path: `${path}.${field}`,
          index,
          situation_actor_indices: [...situationActorSet].sort((a, b) => a - b),
        },
      );
    }
  }
  return indices;
}

function assertModelIndexWithin(
  owner: JsonObject,
  field: string,
  limit: number,
  path: string,
): number {
  const index = expectInteger(owner, field, path);
  if (index < 0 || index >= limit) {
    throw fault(
      "model.semantic.index_out_of_range",
      "Model index is outside the referenced request or draft collection",
      {
        path: `${path}.${field}`,
        index,
        available: limit,
      },
    );
  }
  return index;
}

function assertCharacterReactEventGraph(
  outcomes: readonly JsonObject[],
  gates: readonly JsonObject[],
  path: string,
): void {
  assertUniqueIds(outcomes, "outcome_id", `${path}.candidate_outcomes`);
  assertUniqueIds(gates, "gate_id", `${path}.agency_gates`);
  const outcomeById = new Map(
    outcomes.map((outcome) => [
      expectString(outcome, "outcome_id", "CharacterReactOutcomeInput"),
      outcome,
    ]),
  );
  const gateById = new Map(
    gates.map((gate) => [
      expectString(gate, "gate_id", "CharacterReactAgencyGateInput"),
      gate,
    ]),
  );
  const protectedByGate = new Map<string, Set<string>>();

  for (const [gateIndex, gate] of gates.entries()) {
    const gateId = expectString(
      gate,
      "gate_id",
      "CharacterReactAgencyGateInput",
    );
    const protectedIds = new Set(
      assertUniqueStringField(
        gate,
        "protected_outcome_ids",
        `${path}.agency_gates[${gateIndex}]`,
      ),
    );
    protectedByGate.set(gateId, protectedIds);
    for (const outcomeId of protectedIds) {
      const outcome = outcomeById.get(outcomeId);
      if (outcome === undefined) {
        throw fault(
          "model.semantic.agency_gate_outcome_unknown",
          "Agency gate references an outcome absent from its event input",
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
      "CharacterReactOutcomeInput",
    );
    const gateId = expectString(
      outcome,
      "requires_agency_gate_id",
      "CharacterReactOutcomeInput",
    );
    if (!gateById.has(gateId)) {
      throw fault(
        "model.semantic.outcome_agency_gate_unknown",
        "Outcome references an agency gate absent from its event input",
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
  event: JsonObject,
  characterId: string,
  reactionIndex: number,
): void {
  const gates = objectArray(
    expectProperty(event, "agency_gates", "CharacterReactEventInput"),
    "CharacterReactEventInput.agency_gates",
  );
  const eligibleGateIndices = new Set(
    gates
      .map((gate, gateIndex) => ({ gate, gateIndex }))
      .filter(({ gate }) =>
        stringArray(
          expectProperty(
            gate,
            "participant_entity_ids",
            "CharacterReactAgencyGateInput",
          ),
          "CharacterReactAgencyGateInput.participant_entity_ids",
        ).includes(characterId),
      )
      .map(({ gateIndex }) => gateIndex),
  );
  const decisions = objectArray(
    expectProperty(
      reaction,
      "agency_decisions",
      "CharacterReactionSemanticDraft",
    ),
    `CharacterReactOutput.reactions[${reactionIndex}].agency_decisions`,
  );
  const decisionGateIndices = new Set<number>();
  for (const [decisionIndex, decision] of decisions.entries()) {
    const decisionPath =
      `CharacterReactOutput.reactions[${reactionIndex}]` +
      `.agency_decisions[${decisionIndex}]`;
    const gateIndex = assertModelIndexWithin(
      decision,
      "gate_index",
      gates.length,
      decisionPath,
    );
    if (decisionGateIndices.has(gateIndex)) {
      throw fault(
        "model.semantic.index_duplicate",
        "Reaction agency decisions cannot select the same gate twice",
        {
          reaction_index: reactionIndex,
          gate_index: gateIndex,
        },
      );
    }
    decisionGateIndices.add(gateIndex);
  }
  if (
    decisionGateIndices.size !== eligibleGateIndices.size ||
    [...decisionGateIndices].some(
      (gateIndex) => !eligibleGateIndices.has(gateIndex),
    )
  ) {
    throw fault(
      "model.semantic.reaction_agency_coverage_mismatch",
      "Reaction agency decisions must exactly cover event gates involving the character",
      {
        character_id: characterId,
        event_index: reactionIndex,
        expected_gate_indices: [...eligibleGateIndices],
        actual_gate_indices: [...decisionGateIndices],
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

function assertCompletedDialogueExchange(
  dialogue: JsonObject,
  allowedResponderKinds: readonly (
    | "character_mind"
    | "director_system"
  )[],
): JsonObject {
  const turns = objectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const responderTurn = turns.at(-1);
  const humanTurn = turns.at(-2);
  if (responderTurn === undefined || humanTurn === undefined) {
    throw fault(
      "model.semantic.completed_exchange_missing",
      "Post-response model input requires one completed human and responder exchange",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        turn_count: turns.length,
      },
    );
  }
  const responderSource = expectJsonObject(
    expectProperty(responderTurn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  const responderKind = expectString(
    responderSource,
    "source_kind",
    "DialogueTurnSource",
  );
  if (!allowedResponderKinds.includes(
    responderKind as "character_mind" | "director_system",
  )) {
    throw fault(
      "model.semantic.completed_exchange_responder_mismatch",
      "Post-response model input must end at an allowed responder turn",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        final_turn_id: expectString(
          responderTurn,
          "turn_id",
          "DialogueTurn",
        ),
        final_source_kind: responderKind,
        allowed_source_kinds: [...allowedResponderKinds],
      },
    );
  }
  const humanSource = expectJsonObject(
    expectProperty(humanTurn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (
    expectString(
      humanSource,
      "source_kind",
      "DialogueTurnSource",
    ) !== "human"
  ) {
    throw fault(
      "model.semantic.completed_exchange_human_mismatch",
      "Responder turn must immediately follow the human turn that triggered it",
      {
        dialogue_id: expectString(
          dialogue,
          "dialogue_id",
          "DialogueRecord",
        ),
        triggering_turn_id: expectString(
          humanTurn,
          "turn_id",
          "DialogueTurn",
        ),
      },
    );
  }
  humanTurnSpeakerEntityId(humanTurn);
  return humanTurn;
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

function assertUniqueStringField(
  owner: JsonObject,
  field: string,
  path: string,
): readonly string[] {
  const values = stringArray(
    expectProperty(owner, field, path),
    `${path}.${field}`,
  );
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw fault(
        "model.semantic.id_duplicate",
        `Duplicate ${field} value`,
        { path: `${path}.${field}`, field, id: value },
      );
    }
    seen.add(value);
  }
  return values;
}

function assertEntityReferencesWithin(
  owner: JsonObject,
  field: string,
  allowedEntityIds: ReadonlySet<string>,
  path: string,
): void {
  for (const entityId of assertUniqueStringField(owner, field, path)) {
    if (!allowedEntityIds.has(entityId)) {
      throw fault(
        "model.semantic.event_subject_unknown",
        "Character reaction event field references an entity outside its situation subjects",
        {
          path: `${path}.${field}`,
          entity_id: entityId,
        },
      );
    }
  }
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
  "director.goal_plan": true,
  "director.definition_draft": true,
  "character.dialogue": true,
  "character.react": true,
};
void _requestExhaustive;
