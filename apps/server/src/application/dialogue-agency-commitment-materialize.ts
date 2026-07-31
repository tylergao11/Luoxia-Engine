import {
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
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
  const usedIds = new Set<string>();
  return Object.freeze(
    input.drafts.map((draft, index) => {
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
      return materializeAgencyCommitmentFromDraft({
        draft,
        commitmentId,
        subjects: input.materializeSubjects(draft, index),
        validThroughDay,
        draftLabel: "AgencyCommitmentSemanticDraft",
      });
    }),
  );
}
