import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

/**
 * Server-owned AgencyCommitment materialization from Character Mind drafts.
 *
 * Model drafts own semantic_intent / stance / terms / subject indices only.
 * Runtime commitment_id, recovered subjects, and valid_through_day are filled
 * here from locked WorldState / dialogue context. Day comes only from
 * WorldState.day_cycle.day — never a default day or content branch.
 */

export function resolveCommitmentValidThroughDay(
  worldState: JsonObject,
): number {
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const day = expectInteger(dayCycle, "day", "DayCycleState");
  if (!Number.isSafeInteger(day) || day < 1) {
    throw new EngineFault(
      "dialogue.orchestration.commitment_valid_through_day_invalid",
      "Agency commitment valid_through_day requires a positive current world day",
      { day },
    );
  }
  return day;
}

/**
 * Build one runtime AgencyCommitment from a verified semantic draft plus
 * Server-recovered subjects and identity. valid_through_day is the locked
 * current day (same-day validity for dialogue-issued commitments).
 */
export function materializeAgencyCommitmentFromDraft(input: {
  readonly draft: JsonObject;
  readonly commitmentId: string;
  readonly subjects: readonly JsonObject[];
  readonly validThroughDay: number;
  readonly draftLabel?: string;
}): JsonObject {
  const label = input.draftLabel ?? "AgencyCommitmentSemanticDraft";
  if (!Number.isSafeInteger(input.validThroughDay) || input.validThroughDay < 1) {
    throw new EngineFault(
      "dialogue.orchestration.commitment_valid_through_day_invalid",
      "Agency commitment valid_through_day must be a positive day number",
      { valid_through_day: input.validThroughDay },
    );
  }
  if (input.subjects.length < 1) {
    throw new EngineFault(
      "dialogue.orchestration.commitment_subjects_empty",
      "Agency commitment requires at least one recovered subject",
      { commitment_id: input.commitmentId },
    );
  }
  return Object.freeze({
    commitment_id: input.commitmentId,
    semantic_intent: expectString(input.draft, "semantic_intent", label),
    subjects: Object.freeze([...input.subjects]) as JsonValue,
    stance: expectString(input.draft, "stance", label),
    terms: expectJsonObject(
      expectProperty(input.draft, "terms", label),
      `${label}.terms`,
    ),
    valid_through_day: input.validThroughDay,
  });
}

/**
 * Map CharacterDialogueOutput.commitments drafts to runtime AgencyCommitment[].
 * Caller supplies identity generation and subject recovery (dialogue-local).
 */
export function materializeAgencyCommitmentsFromCharacterDrafts(input: {
  readonly drafts: readonly JsonObject[];
  readonly worldState: JsonObject;
  readonly speakerEntityId: string;
  readonly createCommitmentId: () => string;
  readonly materializeSubjects: (
    draft: JsonObject,
    draftIndex: number,
  ) => readonly JsonObject[];
  readonly assertCanonicalCommitmentId?: (
    commitmentId: string,
    draftIndex: number,
  ) => void;
}): readonly JsonObject[] {
  const validThroughDay = resolveCommitmentValidThroughDay(input.worldState);
  const existingCommitments = activeCommitmentsBySpeaker(
    input.worldState,
    input.speakerEntityId,
    validThroughDay,
  );
  const usedIds = new Set<string>();
  const materialized: JsonObject[] = [];
  for (const [index, draft] of input.drafts.entries()) {
    const subjects = input.materializeSubjects(draft, index);
    if (
      [...existingCommitments, ...materialized].some((commitment) =>
        sameCommitmentMeaning(draft, subjects, commitment),
      )
    ) {
      continue;
    }
    const commitmentId = input.createCommitmentId();
    if (input.assertCanonicalCommitmentId !== undefined) {
      input.assertCanonicalCommitmentId(commitmentId, index);
    }
    if (
      commitmentId !== commitmentId.toLowerCase() ||
      usedIds.has(commitmentId)
    ) {
      throw new EngineFault(
        "dialogue.orchestration.commitment_identity_invalid",
        "Generated commitment IDs must be canonical lowercase and unique within the character turn",
        {
          commitment_index: index,
          commitment_id: commitmentId,
        },
      );
    }
    usedIds.add(commitmentId);
    materialized.push(
      materializeAgencyCommitmentFromDraft({
        draft,
        commitmentId,
        subjects,
        validThroughDay,
        draftLabel: "AgencyCommitmentSemanticDraft",
      }),
    );
  }
  return Object.freeze(materialized);
}

function activeCommitmentsBySpeaker(
  worldState: JsonObject,
  speakerEntityId: string,
  currentDay: number,
): readonly JsonObject[] {
  const commitments: JsonObject[] = [];
  for (const dialogue of asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  )) {
    for (const turn of asObjectArray(
      expectProperty(dialogue, "turns", "DialogueRecord"),
      "DialogueRecord.turns",
    )) {
      const source = expectJsonObject(
        expectProperty(turn, "source", "DialogueTurn"),
        "DialogueTurn.source",
      );
      if (
        expectString(source, "source_kind", "DialogueTurnSource") !==
        "character_mind" ||
        participantEntityId(
          expectJsonObject(
            expectProperty(turn, "speaker", "DialogueTurn"),
            "DialogueTurn.speaker",
          ),
        ) !== speakerEntityId
      ) {
        continue;
      }
      for (const commitment of asObjectArray(
        expectProperty(turn, "agency_commitments", "DialogueTurn"),
        "DialogueTurn.agency_commitments",
      )) {
        if (
          expectInteger(
            commitment,
            "valid_through_day",
            "AgencyCommitment",
          ) >= currentDay
        ) {
          commitments.push(commitment);
        }
      }
    }
  }
  return Object.freeze(commitments);
}

function participantEntityId(participant: JsonObject): string | undefined {
  if (
    expectString(
      participant,
      "participant_kind",
      "DialogueParticipantRef",
    ) !== "entity"
  ) {
    return undefined;
  }
  return expectString(
    expectJsonObject(
      expectProperty(participant, "entity", "DialogueParticipantRef"),
      "DialogueParticipantRef.entity",
    ),
    "entity_id",
    "EntityRef",
  );
}

function sameCommitmentMeaning(
  draft: JsonObject,
  subjects: readonly JsonObject[],
  existing: JsonObject,
): boolean {
  return (
    expectString(
      draft,
      "semantic_intent",
      "AgencyCommitmentSemanticDraft",
    ) === expectString(existing, "semantic_intent", "AgencyCommitment") &&
    expectString(draft, "stance", "AgencyCommitmentSemanticDraft") ===
      expectString(existing, "stance", "AgencyCommitment") &&
    jsonEquals(
      expectJsonObject(
        expectProperty(draft, "terms", "AgencyCommitmentSemanticDraft"),
        "AgencyCommitmentSemanticDraft.terms",
      ),
      expectJsonObject(
        expectProperty(existing, "terms", "AgencyCommitment"),
        "AgencyCommitment.terms",
      ),
    ) &&
    sameSubjectSet(
      subjects,
      asObjectArray(
        expectProperty(existing, "subjects", "AgencyCommitment"),
        "AgencyCommitment.subjects",
      ),
    )
  );
}

function sameSubjectSet(
  left: readonly JsonObject[],
  right: readonly JsonObject[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const unmatched = [...right];
  for (const subject of left) {
    const normalized = normalizeSubjectIdentity(subject);
    const index = unmatched.findIndex((candidate) =>
      jsonEquals(normalized, normalizeSubjectIdentity(candidate)),
    );
    if (index < 0) {
      return false;
    }
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function normalizeSubjectIdentity(subject: JsonObject): JsonObject {
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind !== "entity") {
    return subject;
  }
  const entity = expectJsonObject(
    expectProperty(subject, "entity", "SubjectRef"),
    "SubjectRef.entity",
  );
  return Object.freeze({
    kind,
    entity: Object.freeze({
      world_id: expectString(entity, "world_id", "EntityRef"),
      entity_id: expectString(entity, "entity_id", "EntityRef"),
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
