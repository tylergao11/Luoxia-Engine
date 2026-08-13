import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

export interface EventCardStageAgencyContext {
  readonly actors: readonly JsonObject[];
  readonly stages: readonly JsonObject[];
}

/**
 * Server-owned structural closure for EventCard model drafts.
 * Does not invent event_type, outcome_type, title/summary, or consent evidence.
 * Shrinks index-graph dual-write the model routinely fails to close.
 */

/**
 * Count agency commitments on the current verified responder turn.
 * Zero ⇒ EventCard cannot open non-empty agency_gates.
 */
export function countDialogueAgencyCommitments(dialogue: JsonObject): number {
  return listDialogueCommitmentSelectors(dialogue).length;
}

/**
 * Server-owned commitment ordinals for the current completed exchange only.
 * Older turns cannot authorize a new EventCard stage. Projection already
 * showed this responder turn to the event model; the model never re-copies
 * selectors.
 */
export function listDialogueCommitmentSelectors(
  dialogue: JsonObject,
): readonly JsonObject[] {
  const current = currentResponderCommitments(dialogue);
  if (current === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(
    current.commitments.map((_, commitmentIndex) =>
      Object.freeze({
        turn_index: current.turnIndex,
        commitment_index: commitmentIndex,
      }),
    ),
  );
}

/**
 * Model gate shell only: strip any legacy commitment_evidence dual-write.
 */
export function modelAgencyGateShell(gate: JsonObject): JsonObject {
  const shell: Record<string, JsonValue> = {
    protected_outcome_indices: expectProperty(
      gate,
      "protected_outcome_indices",
      "EventCardAgencyGateSemanticDraft",
    ),
    participant_subject_indices: expectProperty(
      gate,
      "participant_subject_indices",
      "EventCardAgencyGateSemanticDraft",
    ),
    requirement: expectProperty(
      gate,
      "requirement",
      "EventCardAgencyGateSemanticDraft",
    ),
    policy: expectProperty(gate, "policy", "EventCardAgencyGateSemanticDraft"),
  };
  return Object.freeze(shell);
}

/**
 * Effective agency_gates from model draft: omit → []; zero transcript
 * commitments → [] (no open gate path). Shells only — evidence is Server-side.
 */
export function effectiveEventCardAgencyGates(
  card: JsonObject,
  dialogue: JsonObject,
  stageContext?: EventCardStageAgencyContext,
): readonly JsonObject[] {
  if (stageContext !== undefined) {
    const stageGates = canonicalPrefabStageAgencyGates(
      card,
      dialogue,
      stageContext,
    );
    if (stageGates !== undefined) {
      return stageGates;
    }
  }
  const raw = Object.prototype.hasOwnProperty.call(card, "agency_gates")
    ? expectProperty(card, "agency_gates", "EventCardSemanticDraft")
    : [];
  if (!Array.isArray(raw)) {
    return Object.freeze([]);
  }
  if (raw.length === 0) {
    return Object.freeze([]);
  }
  if (countDialogueAgencyCommitments(dialogue) === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    raw.map((gate) =>
      modelAgencyGateShell(
        expectJsonObject(gate, "EventCardAgencyGateSemanticDraft"),
      ),
    ),
  );
}

/**
 * prefab_bind consent is never model-authored twice. The selected entry mode
 * owns whether consent is required; the current responder commitment owns requirement,
 * subjects and terms. The Server protects every sealed outcome.
 */
function canonicalPrefabStageAgencyGates(
  card: JsonObject,
  dialogue: JsonObject,
  context: EventCardStageAgencyContext,
): readonly JsonObject[] | undefined {
  const staging = expectJsonObject(
    expectProperty(card, "staging", "EventCardSemanticDraft"),
    "EventCardSemanticDraft.staging",
  );
  if (
    expectString(staging, "staging_kind", "EventCardStagingSemanticDraft") !==
    "prefab_bind"
  ) {
    return undefined;
  }
  const stageIndex = expectInteger(
    staging,
    "stage_index",
    "EventCardStagingSemanticDraft",
  );
  const stage = context.stages[stageIndex];
  if (stage === undefined) {
    throw new EngineFault(
      "event_card.stage_index_out_of_range",
      "EventCard prefab stage index is outside the locked stage catalog",
      { stage_index: stageIndex, stage_count: context.stages.length },
    );
  }
  const entryModeIndex = expectInteger(
    staging,
    "entry_mode_index",
    "EventCardStagingSemanticDraft",
  );
  const entryModesValue = expectProperty(
    stage,
    "entry_modes",
    "DirectorStageCatalogView",
  );
  if (
    !Array.isArray(entryModesValue) ||
    entryModeIndex < 0 ||
    entryModeIndex >= entryModesValue.length
  ) {
    throw new EngineFault(
      "event_card.stage_entry_mode_index_out_of_range",
      "EventCard entry mode index is outside the selected stage",
      { entry_mode_index: entryModeIndex },
    );
  }
  const entryMode = expectJsonObject(
    entryModesValue[entryModeIndex],
    "DirectorStageEntryModeView",
  );
  const participation = expectString(
    entryMode,
    "npc_participation",
    "DirectorStageEntryModeView",
  );
  if (participation === "unilateral") {
    return Object.freeze([]);
  }
  if (participation !== "commitment_required") {
    throw new EngineFault(
      "event_card.stage_participation_unknown",
      "EventCard stage has an unknown NPC participation policy",
      { stage_index: stageIndex, npc_participation: participation },
    );
  }

  const current = currentResponderCommitments(dialogue);
  const commitment = current?.commitments[0];
  if (current === undefined || commitment === undefined) {
    return Object.freeze([]);
  }
  const outcomeCount = eventCardOutcomeCount(card);
  return Object.freeze([
    Object.freeze({
      protected_outcome_indices: Object.freeze(
        Array.from({ length: outcomeCount }, (_, index) => index),
      ),
      participant_subject_indices: Object.freeze([
        actorIndexForDialogueSpeaker(current.turn, context.actors),
      ]),
      requirement: Object.freeze({
        semantic_intent: expectString(
          commitment,
          "semantic_intent",
          "AgencyCommitment",
        ),
        subject_indices: commitmentSubjectActorIndices(
          commitment,
          context.actors,
        ),
        terms: expectJsonObject(
          expectProperty(commitment, "terms", "AgencyCommitment"),
          "AgencyCommitment.terms",
        ),
      }),
      policy: Object.freeze({ policy_kind: "all" }),
    }),
  ]);
}

function currentResponderCommitments(dialogue: JsonObject):
  | {
      readonly turnIndex: number;
      readonly turn: JsonObject;
      readonly commitments: readonly JsonObject[];
    }
  | undefined {
  const turnsValue = expectProperty(dialogue, "turns", "DialogueRecord");
  if (!Array.isArray(turnsValue) || turnsValue.length === 0) {
    return undefined;
  }
  const turnIndex = turnsValue.length - 1;
  const turn = expectJsonObject(turnsValue[turnIndex], "DialogueTurn");
  const source = expectJsonObject(
    expectProperty(turn, "source", "DialogueTurn"),
    "DialogueTurn.source",
  );
  if (
    expectString(source, "source_kind", "DialogueTurnSource") !==
    "character_mind"
  ) {
    return undefined;
  }
  const commitmentsValue = expectProperty(
    turn,
    "agency_commitments",
    "DialogueTurn",
  );
  if (!Array.isArray(commitmentsValue)) {
    return undefined;
  }
  return Object.freeze({
    turnIndex,
    turn,
    commitments: Object.freeze(
      commitmentsValue.map((value) =>
        expectJsonObject(value, "AgencyCommitment"),
      ),
    ),
  });
}

function actorIndexForDialogueSpeaker(
  turn: JsonObject,
  actors: readonly JsonObject[],
): number {
  const speaker = expectJsonObject(
    expectProperty(turn, "speaker", "DialogueTurn"),
    "DialogueTurn.speaker",
  );
  if (
    expectString(speaker, "participant_kind", "DialogueParticipantRef") !==
    "entity"
  ) {
    throw new EngineFault(
      "event_card.commitment_speaker_not_entity",
      "A stage commitment must be spoken by an entity participant",
    );
  }
  return actorIndexForEntityRef(
    expectJsonObject(
      expectProperty(speaker, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    ),
    actors,
  );
}

function commitmentSubjectActorIndices(
  commitment: JsonObject,
  actors: readonly JsonObject[],
): readonly number[] {
  const subjects = expectProperty(commitment, "subjects", "AgencyCommitment");
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new EngineFault(
      "event_card.commitment_subjects_empty",
      "A stage commitment must name at least one entity subject",
    );
  }
  const indices = subjects.map((value) => {
    const subject = expectJsonObject(value, "SubjectRef");
    if (expectString(subject, "kind", "SubjectRef") !== "entity") {
      throw new EngineFault(
        "event_card.commitment_subject_not_entity",
        "A stage commitment subject must be an entity",
      );
    }
    return actorIndexForEntityRef(
      expectJsonObject(
        expectProperty(subject, "entity", "SubjectRef"),
        "SubjectRef.entity",
      ),
      actors,
    );
  });
  return Object.freeze([...new Set(indices)]);
}

function actorIndexForEntityRef(
  entity: JsonObject,
  actors: readonly JsonObject[],
): number {
  const entityId = expectString(entity, "entity_id", "EntityRef");
  const indices = actors.flatMap((actor, index) =>
    expectString(actor, "entity_id", "DirectorActorView") === entityId
      ? [index]
      : [],
  );
  if (indices.length !== 1 || indices[0] === undefined) {
    throw new EngineFault(
      "event_card.commitment_actor_unresolved",
      "A stage commitment entity must resolve exactly once in world_view.actors",
      { entity_id: entityId, matches: indices.length },
    );
  }
  return indices[0];
}

function eventCardOutcomeCount(card: JsonObject): number {
  const options = expectProperty(card, "result_options", "EventCardSemanticDraft");
  if (!Array.isArray(options)) {
    return 0;
  }
  return options.reduce((count, value) => {
    const option = expectJsonObject(value, "EventCardOutcomeSemanticDraft");
    const outcomes = expectProperty(
      option,
      "outcomes",
      "EventCardOutcomeSemanticDraft",
    );
    return count + (Array.isArray(outcomes) ? outcomes.length : 0);
  }, 0);
}

export function readModelIndexArray(
  owner: JsonObject,
  field: string,
): number[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(owner, field)) {
    return undefined;
  }
  const raw = expectProperty(owner, field, field);
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const indices: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      continue;
    }
    indices.push(value);
  }
  return indices;
}

/**
 * Effective outcome subjects: omit/empty → situation; drop OOB and
 * outside-situation indices; if nothing remains (mis-copied 0,1,…) → situation.
 */
export function effectiveOutcomeSubjectIndices(
  outcome: JsonObject,
  situationActorIndices: readonly number[],
  actorCount: number,
): number[] {
  const situation = uniqueSorted(
    situationActorIndices.filter((i) => i >= 0 && i < actorCount),
  );
  if (situation.length === 0) {
    return [];
  }
  const raw = readModelIndexArray(outcome, "subject_indices");
  if (raw === undefined || raw.length === 0) {
    return situation;
  }
  const situationSet = new Set(situation);
  const kept = uniqueSorted(
    raw.filter((i) => i >= 0 && i < actorCount && situationSet.has(i)),
  );
  return kept.length > 0 ? kept : situation;
}

/**
 * Drop requires_agency_gate_index when there is no gate list (omit, empty, or
 * zero-commitment invent stripped to []). Prevents dangling back-links that
 * fail assertSemanticEventGraph / materialize after gates become [].
 */
export function withoutAgencyGateRequirements(
  outcomes: readonly JsonObject[],
): readonly JsonObject[] {
  return Object.freeze(
    outcomes.map((outcome) => {
      if (
        !Object.prototype.hasOwnProperty.call(
          outcome,
          "requires_agency_gate_index",
        )
      ) {
        return outcome;
      }
      const next: Record<string, JsonValue> = { ...outcome };
      delete next["requires_agency_gate_index"];
      return Object.freeze(next);
    }),
  );
}

/**
 * Close agency gate ↔ outcome back-links when the model wrote a gate that
 * protects outcomes but omitted requires_agency_gate_index. Does not invent
 * gates or commitment evidence. Empty gates → strip any requires_agency_gate_index
 * (structural noise after zero-commitment gate drop or omit). Ambiguous multi-gate
 * claims on one outcome leave the field unset (still fails closed later if unclosed).
 */
export function closeAgencyGateOutcomeLinks(
  outcomes: readonly JsonObject[],
  gates: readonly JsonObject[],
): {
  readonly outcomes: readonly JsonObject[];
  readonly gates: readonly JsonObject[];
} {
  if (gates.length === 0) {
    return {
      outcomes: withoutAgencyGateRequirements(outcomes),
      gates,
    };
  }
  const assigned = new Map<number, number>();
  for (const [gateIndex, gate] of gates.entries()) {
    const protectedIndices =
      readModelIndexArray(gate, "protected_outcome_indices") ?? [];
    for (const outcomeIndex of protectedIndices) {
      if (outcomeIndex < 0 || outcomeIndex >= outcomes.length) {
        continue;
      }
      const existing = assigned.get(outcomeIndex);
      if (existing !== undefined && existing !== gateIndex) {
        // Conflicting gates protect the same outcome — do not auto-pick.
        assigned.delete(outcomeIndex);
        assigned.set(outcomeIndex, -1);
        continue;
      }
      if (existing === -1) {
        continue;
      }
      assigned.set(outcomeIndex, gateIndex);
    }
  }

  const closedOutcomes = outcomes.map((outcome, outcomeIndex) => {
    const current = outcome["requires_agency_gate_index"];
    if (current !== undefined) {
      // If model pointed at a non-existent gate after filters, drop the link.
      if (
        typeof current !== "number" ||
        !Number.isInteger(current) ||
        current < 0 ||
        current >= gates.length
      ) {
        const next: Record<string, JsonValue> = { ...outcome };
        delete next["requires_agency_gate_index"];
        return Object.freeze(next);
      }
      return outcome;
    }
    const gateIndex = assigned.get(outcomeIndex);
    if (gateIndex === undefined || gateIndex < 0) {
      return outcome;
    }
    return Object.freeze({
      ...outcome,
      requires_agency_gate_index: gateIndex,
    });
  });

  return {
    outcomes: Object.freeze(closedOutcomes),
    gates,
  };
}

/**
 * Apply effective subject_indices onto outcome objects for materialize/receipt.
 */
export function withEffectiveOutcomeSubjects(
  outcomes: readonly JsonObject[],
  situationActorIndices: readonly number[],
  actorCount: number,
): readonly JsonObject[] {
  return Object.freeze(
    outcomes.map((outcome) => {
      const subjects = effectiveOutcomeSubjectIndices(
        outcome,
        situationActorIndices,
        actorCount,
      );
      return Object.freeze({
        ...outcome,
        subject_indices: Object.freeze([...subjects]),
      });
    }),
  );
}

function uniqueSorted(indices: readonly number[]): number[] {
  return [...new Set(indices)].sort((a, b) => a - b);
}

export function asMutableJsonObject(value: JsonValue): JsonObject {
  return expectJsonObject(value, "JsonObject");
}

export function readOptionalIntegerField(
  owner: JsonObject,
  field: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(owner, field)) {
    return undefined;
  }
  return expectInteger(owner, field, field);
}
