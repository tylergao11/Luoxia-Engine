import {
  expectInteger,
  expectJsonObject,
  expectProperty,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";

/**
 * Server-owned structural closure for EventCard model drafts.
 * Does not invent event_type, outcome_type, title/summary, or consent evidence.
 * Shrinks index-graph dual-write the model routinely fails to close.
 */

/**
 * Count agency commitments on a verified dialogue record (all turns).
 * Zero ⇒ EventCard cannot open non-empty agency_gates.
 */
export function countDialogueAgencyCommitments(dialogue: JsonObject): number {
  return listDialogueCommitmentSelectors(dialogue).length;
}

/**
 * Server-owned complete set of dialogue commitment ordinals.
 * Projection already showed these to the event model; materialize binds
 * gate evidence from this list — model must not re-copy selectors.
 */
export function listDialogueCommitmentSelectors(
  dialogue: JsonObject,
): readonly JsonObject[] {
  const turns = expectProperty(dialogue, "turns", "DialogueRecord");
  if (!Array.isArray(turns)) {
    return Object.freeze([]);
  }
  const selectors: JsonObject[] = [];
  for (const [turnIndex, turnValue] of turns.entries()) {
    const turn = expectJsonObject(turnValue, "DialogueTurn");
    if (!Object.prototype.hasOwnProperty.call(turn, "agency_commitments")) {
      continue;
    }
    const commitments = expectProperty(
      turn,
      "agency_commitments",
      "DialogueTurn",
    );
    if (!Array.isArray(commitments)) {
      continue;
    }
    for (let commitmentIndex = 0; commitmentIndex < commitments.length; commitmentIndex += 1) {
      selectors.push(
        Object.freeze({
          turn_index: turnIndex,
          commitment_index: commitmentIndex,
        }),
      );
    }
  }
  return Object.freeze(selectors);
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
): readonly JsonObject[] {
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
