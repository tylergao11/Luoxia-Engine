import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

/**
 * Removes journal/proof-only identity and provenance from an already validated
 * ModelRequest input. The formal request remains unchanged; only this
 * schema-validated projection crosses the ModelProvider boundary.
 */
export function projectModelProviderInput(
  contracts: ContractValidator,
  requestKind: string,
  input: JsonObject,
): JsonObject {
  const projected = projectByRequestKind(requestKind, input);
  const envelope = contracts.assertObject(
    CONTRACT_REF.modelProviderInputEnvelope,
    Object.freeze({
      request_kind: requestKind,
      input: projected,
    }),
  );
  return expectJsonObject(
    expectProperty(
      envelope.value,
      "input",
      "ModelProviderInputEnvelope",
    ),
    "ModelProviderInputEnvelope.input",
  );
}

function projectByRequestKind(
  requestKind: string,
  input: JsonObject,
): JsonObject {
  switch (requestKind) {
    case "director.daily_settlement": {
      const worldView = expectObjectProperty(
        input,
        "world_view",
        "DirectorDailySettlementInput",
      );
      const projectedWorld = projectDirectorWorldView(worldView);
      return Object.freeze({
        world_view: projectedWorld.worldView,
        objective_traces: Object.freeze(
          expectObjectArrayProperty(
            input,
            "objective_traces",
            "DirectorDailySettlementInput",
          ).map((trace) =>
            projectObjectiveTrace(trace, projectedWorld.actorIndexByEntityId),
          ),
        ),
      });
    }
    case "director.dialogue_events": {
      const worldView = expectObjectProperty(
        input,
        "world_view",
        "DirectorDialogueEventsInput",
      );
      const projectedWorld = projectDirectorWorldView(worldView);
      return Object.freeze({
        world_view: projectedWorld.worldView,
        dialogue: projectDialogue(
          expectObjectProperty(
            input,
            "dialogue",
            "DirectorDialogueEventsInput",
          ),
          {
            actorIndexByEntityId: projectedWorld.actorIndexByEntityId,
          },
        ),
        response_locale: expectString(
          input,
          "response_locale",
          "DirectorDialogueEventsInput",
        ),
      });
    }
    case "director.system_dialogue":
      return Object.freeze({
        knowledge_view: projectKnowledgeView(
          expectObjectProperty(
            input,
            "knowledge_view",
            "DirectorSystemDialogueInput",
          ),
          { includeViewerEntityId: true },
        ),
        dialogue: projectDialogue(
          expectObjectProperty(
            input,
            "dialogue",
            "DirectorSystemDialogueInput",
          ),
        ),
        response_locale: expectString(
          input,
          "response_locale",
          "DirectorSystemDialogueInput",
        ),
      });
    case "director.goal_plan": {
      const worldView = expectObjectProperty(
        input,
        "world_view",
        "DirectorGoalPlanInput",
      );
      const projectedWorld = projectDirectorWorldView(worldView);
      return Object.freeze({
        world_view: projectedWorld.worldView,
        knowledge_view: projectKnowledgeView(
          expectObjectProperty(
            input,
            "knowledge_view",
            "DirectorGoalPlanInput",
          ),
          {
            includeViewerEntityId: true,
            actorIndexByEntityId: projectedWorld.actorIndexByEntityId,
          },
        ),
        dialogue: projectDialogue(
          expectObjectProperty(input, "dialogue", "DirectorGoalPlanInput"),
          {
            actorIndexByEntityId: projectedWorld.actorIndexByEntityId,
          },
        ),
        response_locale: expectString(
          input,
          "response_locale",
          "DirectorGoalPlanInput",
        ),
      });
    }
    case "director.definition_draft":
      return Object.freeze({
        knowledge_view: projectKnowledgeView(
          expectObjectProperty(
            input,
            "knowledge_view",
            "DirectorDefinitionDraftInput",
          ),
          { includeViewerEntityId: true },
        ),
        dialogue: projectDialogue(
          expectObjectProperty(
            input,
            "dialogue",
            "DirectorDefinitionDraftInput",
          ),
        ),
        response_locale: expectString(
          input,
          "response_locale",
          "DirectorDefinitionDraftInput",
        ),
        purpose: expectString(
          input,
          "purpose",
          "DirectorDefinitionDraftInput",
        ),
      });
    case "character.dialogue": {
      const subjective = expectObjectProperty(
        input,
        "subjective_view",
        "CharacterDialogueInput",
      );
      const characterEntityId = expectString(
        expectObjectProperty(subjective, "character", "CharacterSubjectiveView"),
        "entity_id",
        "EntityRef",
      );
      return Object.freeze({
        subjective_view: projectCharacterSubjectiveView(subjective),
        dialogue: projectDialogue(
          expectObjectProperty(input, "dialogue", "CharacterDialogueInput"),
          { characterEntityId },
        ),
        response_locale: expectString(
          input,
          "response_locale",
          "CharacterDialogueInput",
        ),
      });
    }
    case "character.react": {
      const subjective = expectObjectProperty(
        input,
        "subjective_view",
        "CharacterReactInput",
      );
      return Object.freeze({
        day: expectInteger(input, "day", "CharacterReactInput"),
        subjective_view: projectCharacterSubjectiveView(subjective),
        events: Object.freeze(
          expectObjectArrayProperty(
            input,
            "events",
            "CharacterReactInput",
          ).map(projectCharacterReactEvent),
        ),
      });
    }
    default:
      throw new EngineFault(
        "model.provider_input.request_kind_unknown",
        `Cannot project provider input for unknown request_kind ${requestKind}`,
        { request_kind: requestKind },
      );
  }
}

function projectDirectorWorldView(world: JsonObject): {
  readonly worldView: JsonObject;
  readonly actorIndexByEntityId: ReadonlyMap<string, number>;
} {
  const actors = expectObjectArrayProperty(
    world,
    "actors",
    "DirectorWorldView",
  );
  const actorIndexByEntityId = uniqueIndex(
    actors.map((actor) =>
      expectString(actor, "entity_id", "DirectorActorView"),
    ),
    "DirectorWorldView.actors.entity_id",
  );
  return Object.freeze({
    worldView: Object.freeze({
      day: expectInteger(world, "day", "DirectorWorldView"),
      actors: Object.freeze(actors.map(projectDirectorActor)),
      relations: Object.freeze(
        expectObjectArrayProperty(
          world,
          "relations",
          "DirectorWorldView",
        ).map((relation) => projectRelation(relation, actorIndexByEntityId)),
      ),
      world_machines: Object.freeze(
        expectObjectArrayProperty(
          world,
          "world_machines",
          "DirectorWorldView",
        ).map(projectStateMachine),
      ),
      facts: Object.freeze(
        expectObjectArrayProperty(world, "facts", "DirectorWorldView").map(
          projectFact,
        ),
      ),
    }),
    actorIndexByEntityId,
  });
}

function projectDirectorActor(actor: JsonObject): JsonObject {
  const projected: Record<string, JsonValue> = {
    entity_id: expectString(actor, "entity_id", "DirectorActorView"),
    status: expectString(actor, "status", "DirectorActorView"),
    objective_components: Object.freeze(
      expectObjectArrayProperty(
        actor,
        "objective_components",
        "DirectorActorView",
      ).map(projectComponent),
    ),
  };
  if (actor.action_machine !== undefined) {
    projected.action_machine = projectStateMachine(
      expectJsonObject(
        actor.action_machine,
        "DirectorActorView.action_machine",
      ),
    );
  }
  return Object.freeze(projected);
}

function projectKnowledgeView(
  knowledge: JsonObject,
  options: {
    readonly includeViewerEntityId: boolean;
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
  },
): JsonObject {
  const projected: Record<string, JsonValue> = {
    facts: Object.freeze(
      expectObjectArrayProperty(knowledge, "facts", "KnowledgeView").map(
        projectFact,
      ),
    ),
    memories: Object.freeze(
      expectObjectArrayProperty(knowledge, "memories", "KnowledgeView").map(
        projectMemory,
      ),
    ),
  };
  if (options.includeViewerEntityId) {
    const viewerEntityId = expectString(
      knowledge,
      "viewer_entity_id",
      "KnowledgeView",
    );
    if (options.actorIndexByEntityId !== undefined) {
      // Viewer identity lives once in world_view.actors; emit only the local index.
      projected.viewer_actor_index = requireMappedIndex(
        viewerEntityId,
        options.actorIndexByEntityId,
        "KnowledgeView.viewer_entity_id",
      );
    } else {
      projected.viewer_entity_id = viewerEntityId;
    }
  }
  return Object.freeze(projected);
}

function projectFact(fact: JsonObject): JsonObject {
  return Object.freeze({
    claim_type: expectString(fact, "claim_type", "FactRecord"),
    claim: expectProperty(fact, "claim", "FactRecord"),
  });
}

function projectMemory(memory: JsonObject): JsonObject {
  return Object.freeze({
    summary: expectProperty(memory, "summary", "KnowledgeView.memory"),
    salience: expectProperty(memory, "salience", "KnowledgeView.memory"),
  });
}

function projectStateMachine(machine: JsonObject): JsonObject {
  return Object.freeze({
    entered_day: expectInteger(
      machine,
      "entered_day",
      "StateMachineModelView",
    ),
    current_state: projectMachineState(
      expectObjectProperty(
        machine,
        "current_state",
        "StateMachineModelView",
      ),
    ),
    outgoing_transitions: Object.freeze(
      expectObjectArrayProperty(
        machine,
        "outgoing_transitions",
        "StateMachineModelView",
      ).map(projectMachineTransition),
    ),
  });
}

function projectMachineState(state: JsonObject): JsonObject {
  return Object.freeze({
    name: expectProperty(state, "name", "MachineStateDefinition"),
    semantic_intent: expectString(
      state,
      "semantic_intent",
      "MachineStateDefinition",
    ),
    fields: expectProperty(state, "fields", "MachineStateDefinition"),
  });
}

function projectMachineTransition(view: JsonObject): JsonObject {
  const transition = expectObjectProperty(
    view,
    "transition",
    "StateMachineTransitionModelView",
  );
  return Object.freeze({
    guarded: transition.guard !== undefined,
    fields: expectProperty(
      transition,
      "fields",
      "MachineTransitionDefinition",
    ),
    target_state: projectMachineState(
      expectObjectProperty(
        view,
        "target_state",
        "StateMachineTransitionModelView",
      ),
    ),
  });
}

function projectComponent(component: JsonObject): JsonObject {
  const componentType = expectObjectProperty(
    component,
    "component_type",
    "ComponentValue",
  );
  return Object.freeze({
    component_type_id: expectString(
      componentType,
      "local_id",
      "ComponentTypeCatalogRef",
    ),
    value: expectProperty(component, "value", "ComponentValue"),
  });
}

function projectRelation(
  relation: JsonObject,
  actorIndexByEntityId: ReadonlyMap<string, number>,
): JsonObject {
  const relationType = expectObjectProperty(
    relation,
    "relation_type",
    "RelationState",
  );
  return Object.freeze({
    relation_type_id: expectString(
      relationType,
      "local_id",
      "RelationTypeCatalogRef",
    ),
    from: projectSubject(
      expectObjectProperty(relation, "from", "RelationState"),
      { actorIndexByEntityId },
    ),
    to: projectSubject(
      expectObjectProperty(relation, "to", "RelationState"),
      { actorIndexByEntityId },
    ),
    data: expectProperty(relation, "data", "RelationState"),
    state: expectString(relation, "state", "RelationState"),
  });
}

function projectSubject(
  subject: JsonObject,
  options: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  } = {},
): JsonObject {
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind === "entity") {
    const entity = expectObjectProperty(subject, "entity", "SubjectRef");
    const entityId = expectString(entity, "entity_id", "EntityRef");
    if (
      options.characterEntityId !== undefined &&
      entityId === options.characterEntityId
    ) {
      // Root character identity is already character_entity_id; do not re-copy UUID.
      return Object.freeze({
        kind,
        is_character_subject: true,
      });
    }
    if (options.actorIndexByEntityId !== undefined) {
      return Object.freeze({
        kind,
        actor_index: requireMappedIndex(
          entityId,
          options.actorIndexByEntityId,
          "SubjectRef.entity",
        ),
      });
    }
    return Object.freeze({
      kind,
      entity_id: entityId,
    });
  }
  if (kind === "definition") {
    return Object.freeze({
      kind,
      definition: projectDefinitionRef(
        expectObjectProperty(subject, "definition", "SubjectRef"),
      ),
    });
  }
  throw new EngineFault(
    "model.provider_input.subject_kind_unknown",
    `Cannot project unknown SubjectRef kind ${kind}`,
    { subject_kind: kind },
  );
}

function projectDefinitionRef(definition: JsonObject): JsonObject {
  const kind = expectString(definition, "kind", "DefinitionRef");
  if (kind === "static") {
    return Object.freeze({
      kind,
      local_id: expectString(definition, "local_id", "StaticDefinitionRef"),
    });
  }
  if (kind === "dynamic") {
    return Object.freeze({
      kind,
      definition_id: expectString(
        definition,
        "definition_id",
        "DynamicDefinitionRef",
      ),
    });
  }
  throw new EngineFault(
    "model.provider_input.definition_kind_unknown",
    `Cannot project unknown DefinitionRef kind ${kind}`,
    { definition_kind: kind },
  );
}

function projectObjectiveTrace(
  trace: JsonObject,
  actorIndexByEntityId: ReadonlyMap<string, number>,
): JsonObject {
  return Object.freeze({
    day: expectInteger(trace, "day", "ObjectiveTraceEntry"),
    event_type: expectString(
      trace,
      "event_type",
      "ObjectiveTraceEntry",
    ),
    subjects: Object.freeze(
      expectObjectArrayProperty(
        trace,
        "subjects",
        "ObjectiveTraceEntry",
      ).map((subject) =>
        projectSubject(subject, { actorIndexByEntityId }),
      ),
    ),
    payload: expectProperty(trace, "payload", "ObjectiveTraceEntry"),
  });
}

function projectDialogue(
  dialogue: JsonObject,
  options: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  } = {},
): JsonObject {
  const participants = expectObjectArrayProperty(
    dialogue,
    "participants",
    "DialogueRecord",
  );
  const participantIndices = new Map<string, number>();
  const projectedParticipants = participants.map((participant, index) => {
    const key = dialogueParticipantKey(participant);
    if (participantIndices.has(key)) {
      throw new EngineFault(
        "model.provider_input.dialogue_participant_duplicate",
        "Provider dialogue projection requires unique participants",
        { participant_key: key },
      );
    }
    participantIndices.set(key, index);
    return projectDialogueParticipant(participant, options);
  });
  const subjectOptions: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  } = {
    ...(options.actorIndexByEntityId !== undefined
      ? { actorIndexByEntityId: options.actorIndexByEntityId }
      : {}),
    ...(options.characterEntityId !== undefined
      ? { characterEntityId: options.characterEntityId }
      : {}),
  };
  return Object.freeze({
    day: expectInteger(dialogue, "day", "DialogueRecord"),
    participants: Object.freeze(projectedParticipants),
    turns: Object.freeze(
      expectObjectArrayProperty(dialogue, "turns", "DialogueRecord").map(
        (turn) =>
          projectDialogueTurn(turn, participantIndices, subjectOptions),
      ),
    ),
  });
}

function projectDialogueParticipant(
  participant: JsonObject,
  options: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  },
): JsonObject {
  const participantKind = expectString(
    participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind === "system") {
    return Object.freeze({ participant_kind: participantKind });
  }
  if (participantKind === "entity") {
    const entity = expectObjectProperty(
      participant,
      "entity",
      "DialogueParticipantRef",
    );
    const entityId = expectString(entity, "entity_id", "EntityRef");
    if (
      options.characterEntityId !== undefined &&
      entityId === options.characterEntityId
    ) {
      return Object.freeze({
        participant_kind: participantKind,
        is_character_subject: true,
      });
    }
    if (options.actorIndexByEntityId !== undefined) {
      return Object.freeze({
        participant_kind: participantKind,
        actor_index: requireMappedIndex(
          entityId,
          options.actorIndexByEntityId,
          "DialogueParticipantRef.entity",
        ),
      });
    }
    return Object.freeze({
      participant_kind: participantKind,
      entity_id: entityId,
    });
  }
  throw new EngineFault(
    "model.provider_input.dialogue_participant_kind_unknown",
    `Cannot project unknown dialogue participant kind ${participantKind}`,
    { participant_kind: participantKind },
  );
}

function dialogueParticipantKey(participant: JsonObject): string {
  const participantKind = expectString(
    participant,
    "participant_kind",
    "DialogueParticipantRef",
  );
  if (participantKind === "system") {
    return "system";
  }
  if (participantKind === "entity") {
    return `entity:${expectString(
      expectObjectProperty(
        participant,
        "entity",
        "DialogueParticipantRef",
      ),
      "entity_id",
      "EntityRef",
    )}`;
  }
  throw new EngineFault(
    "model.provider_input.dialogue_participant_kind_unknown",
    `Cannot project unknown dialogue participant kind ${participantKind}`,
    { participant_kind: participantKind },
  );
}

function projectDialogueTurn(
  turn: JsonObject,
  participantIndices: ReadonlyMap<string, number>,
  subjectOptions?: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  },
): JsonObject {
  const source = expectObjectProperty(turn, "source", "DialogueTurn");
  const speaker = expectObjectProperty(turn, "speaker", "DialogueTurn");
  const speakerKey = dialogueParticipantKey(speaker);
  const speakerIndex = participantIndices.get(speakerKey);
  if (speakerIndex === undefined) {
    throw new EngineFault(
      "model.provider_input.dialogue_speaker_not_participant",
      "Provider dialogue turn speaker must belong to the dialogue participants",
      { speaker_key: speakerKey },
    );
  }
  const projected: Record<string, JsonValue> = {
    speaker_index: speakerIndex,
    speaker_kind: expectString(source, "source_kind", "DialogueTurnSource"),
    text: expectString(turn, "text", "DialogueTurn"),
    agency_commitments: Object.freeze(
      expectObjectArrayProperty(
        turn,
        "agency_commitments",
        "DialogueTurn",
      ).map((commitment) =>
        projectAgencyCommitment(commitment, subjectOptions),
      ),
    ),
  };
  if (turn.emotion_id !== undefined) {
    projected.emotion_id = expectString(
      turn,
      "emotion_id",
      "DialogueTurn",
    );
  }
  return Object.freeze(projected);
}

function projectAgencyCommitment(
  commitment: JsonObject,
  subjectOptions?: {
    readonly actorIndexByEntityId?: ReadonlyMap<string, number>;
    readonly characterEntityId?: string;
  },
): JsonObject {
  return Object.freeze({
    semantic_intent: expectString(
      commitment,
      "semantic_intent",
      "AgencyCommitment",
    ),
    subjects: Object.freeze(
      expectObjectArrayProperty(
        commitment,
        "subjects",
        "AgencyCommitment",
      ).map((subject) => projectSubject(subject, subjectOptions)),
    ),
    stance: expectString(commitment, "stance", "AgencyCommitment"),
    terms: expectProperty(commitment, "terms", "AgencyCommitment"),
    valid_through_day: expectInteger(
      commitment,
      "valid_through_day",
      "AgencyCommitment",
    ),
  });
}

function projectCharacterSubjectiveView(subjective: JsonObject): JsonObject {
  const character = expectObjectProperty(
    subjective,
    "character",
    "CharacterSubjectiveView",
  );
  const characterEntityId = expectString(character, "entity_id", "EntityRef");
  const knowledge = expectObjectProperty(
    subjective,
    "knowledge_view",
    "CharacterSubjectiveView",
  );
  const viewerEntityId = expectString(
    knowledge,
    "viewer_entity_id",
    "KnowledgeView",
  );
  if (viewerEntityId !== characterEntityId) {
    throw new EngineFault(
      "model.provider_input.character_viewer_mismatch",
      "Character subjective knowledge viewer must equal the subject character",
      {
        character_entity_id: characterEntityId,
        viewer_entity_id: viewerEntityId,
      },
    );
  }
  return Object.freeze({
    character_entity_id: characterEntityId,
    // Viewer is the subject character; do not re-emit the same UUID.
    knowledge_view: projectKnowledgeView(knowledge, {
      includeViewerEntityId: false,
    }),
    action_machine: projectStateMachine(
      expectObjectProperty(
        subjective,
        "action_machine",
        "CharacterSubjectiveView",
      ),
    ),
  });
}

function projectCharacterReactEvent(event: JsonObject): JsonObject {
  const situation = expectObjectProperty(
    event,
    "situation",
    "CharacterReactEventInput",
  );
  const subjectEntityIds = expectStringArrayProperty(
    situation,
    "subject_entity_ids",
    "CharacterReactSituationInput",
  );
  const subjectIndexById = uniqueIndex(
    subjectEntityIds,
    "CharacterReactSituationInput.subject_entity_ids",
  );
  const outcomes = expectObjectArrayProperty(
    event,
    "candidate_outcomes",
    "CharacterReactEventInput",
  );
  const outcomeIds = outcomes.map((outcome) =>
    expectString(outcome, "outcome_id", "CharacterReactOutcomeInput"),
  );
  const outcomeIndexById = uniqueIndex(
    outcomeIds,
    "CharacterReactEventInput.candidate_outcomes.outcome_id",
  );
  const gates = expectObjectArrayProperty(
    event,
    "agency_gates",
    "CharacterReactEventInput",
  );
  const gateIds = gates.map((gate) =>
    expectString(gate, "gate_id", "CharacterReactAgencyGateInput"),
  );
  const gateIndexById = uniqueIndex(
    gateIds,
    "CharacterReactEventInput.agency_gates.gate_id",
  );

  return Object.freeze({
    situation: Object.freeze({
      event_type: expectString(
        situation,
        "event_type",
        "CharacterReactSituationInput",
      ),
      summary: expectProperty(
        situation,
        "summary",
        "CharacterReactSituationInput",
      ),
      subject_entity_ids: Object.freeze([...subjectEntityIds]),
      context: expectProperty(
        situation,
        "context",
        "CharacterReactSituationInput",
      ),
    }),
    candidate_outcomes: Object.freeze(
      outcomes.map((outcome) =>
        projectCharacterReactOutcome(
          outcome,
          subjectIndexById,
          gateIndexById,
        ),
      ),
    ),
    agency_gates: Object.freeze(
      gates.map((gate) =>
        projectCharacterReactAgencyGate(
          gate,
          subjectIndexById,
          outcomeIndexById,
        ),
      ),
    ),
  });
}

function projectCharacterReactOutcome(
  outcome: JsonObject,
  subjectIndexById: ReadonlyMap<string, number>,
  gateIndexById: ReadonlyMap<string, number>,
): JsonObject {
  const projected: Record<string, JsonValue> = {
    outcome_type: expectString(
      outcome,
      "outcome_type",
      "CharacterReactOutcomeInput",
    ),
    subject_indices: Object.freeze(
      mapIdsToIndices(
        expectStringArrayProperty(
          outcome,
          "subject_entity_ids",
          "CharacterReactOutcomeInput",
        ),
        subjectIndexById,
        "CharacterReactOutcomeInput.subject_entity_ids",
      ),
    ),
    parameters: expectProperty(
      outcome,
      "parameters",
      "CharacterReactOutcomeInput",
    ),
  };
  if (outcome.requires_agency_gate_id !== undefined) {
    projected.requires_agency_gate_index = requireMappedIndex(
      expectString(
        outcome,
        "requires_agency_gate_id",
        "CharacterReactOutcomeInput",
      ),
      gateIndexById,
      "CharacterReactOutcomeInput.requires_agency_gate_id",
    );
  }
  return Object.freeze(projected);
}

function projectCharacterReactAgencyGate(
  gate: JsonObject,
  subjectIndexById: ReadonlyMap<string, number>,
  outcomeIndexById: ReadonlyMap<string, number>,
): JsonObject {
  const requirement = expectObjectProperty(
    gate,
    "requirement",
    "CharacterReactAgencyGateInput",
  );
  return Object.freeze({
    protected_outcome_indices: Object.freeze(
      mapIdsToIndices(
        expectStringArrayProperty(
          gate,
          "protected_outcome_ids",
          "CharacterReactAgencyGateInput",
        ),
        outcomeIndexById,
        "CharacterReactAgencyGateInput.protected_outcome_ids",
      ),
    ),
    participant_subject_indices: Object.freeze(
      mapIdsToIndices(
        expectStringArrayProperty(
          gate,
          "participant_entity_ids",
          "CharacterReactAgencyGateInput",
        ),
        subjectIndexById,
        "CharacterReactAgencyGateInput.participant_entity_ids",
      ),
    ),
    requirement: Object.freeze({
      semantic_intent: expectString(
        requirement,
        "semantic_intent",
        "CharacterReactRequirementInput",
      ),
      subject_indices: Object.freeze(
        mapIdsToIndices(
          expectStringArrayProperty(
            requirement,
            "subject_entity_ids",
            "CharacterReactRequirementInput",
          ),
          subjectIndexById,
          "CharacterReactRequirementInput.subject_entity_ids",
        ),
      ),
      terms: expectProperty(
        requirement,
        "terms",
        "CharacterReactRequirementInput",
      ),
    }),
    policy: expectProperty(
      gate,
      "policy",
      "CharacterReactAgencyGateInput",
    ),
  });
}

function uniqueIndex(
  values: readonly string[],
  path: string,
): ReadonlyMap<string, number> {
  const indexed = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    if (indexed.has(value)) {
      throw new EngineFault(
        "model.provider_input.identity_duplicate",
        `${path} must not contain duplicate identities`,
        { path, identity: value },
      );
    }
    indexed.set(value, index);
  }
  return indexed;
}

function mapIdsToIndices(
  values: readonly string[],
  indexed: ReadonlyMap<string, number>,
  path: string,
): readonly number[] {
  return values.map((value) => requireMappedIndex(value, indexed, path));
}

function requireMappedIndex(
  value: string,
  indexed: ReadonlyMap<string, number>,
  path: string,
): number {
  const index = indexed.get(value);
  if (index === undefined) {
    throw new EngineFault(
      "model.provider_input.identity_not_in_scope",
      `${path} references an identity outside its provider input scope`,
      { path, identity: value },
    );
  }
  return index;
}

function expectObjectProperty(
  object: JsonObject,
  property: string,
  label: string,
): JsonObject {
  return expectJsonObject(
    expectProperty(object, property, label),
    `${label}.${property}`,
  );
}

function expectObjectArrayProperty(
  object: JsonObject,
  property: string,
  label: string,
): readonly JsonObject[] {
  const value = expectProperty(object, property, label);
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "model.provider_input.array_shape",
      `${label}.${property} must be an array`,
      { path: `${label}.${property}` },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(
      entry as JsonValue,
      `${label}.${property}[${index}]`,
    ),
  );
}

function expectStringArrayProperty(
  object: JsonObject,
  property: string,
  label: string,
): readonly string[] {
  const value = expectProperty(object, property, label);
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "model.provider_input.array_shape",
      `${label}.${property} must be an array`,
      { path: `${label}.${property}` },
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new EngineFault(
        "model.provider_input.string_shape",
        `${label}.${property}[${index}] must be a string`,
        { path: `${label}.${property}[${index}]` },
      );
    }
    return entry;
  });
}
