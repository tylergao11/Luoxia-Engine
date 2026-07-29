const STAGE_OUTCOME_PRE_INVOCATION_REJECTION_CODES = Object.freeze([
  "stage_outcome.orchestration.stage_unavailable",
  "stage_outcome.orchestration.stage_basis_mismatch",
  "stage_outcome.orchestration.player_not_participant",
  "stage_outcome.orchestration.outcome_type_not_declared",
] as const);

export type StageOutcomePreInvocationRejectionCode =
  (typeof STAGE_OUTCOME_PRE_INVOCATION_REJECTION_CODES)[number];

const STAGE_OUTCOME_PRE_INVOCATION_REJECTION_CODE_SET: ReadonlySet<string> =
  new Set(STAGE_OUTCOME_PRE_INVOCATION_REJECTION_CODES);

export function isStageOutcomePreInvocationRejectionCode(
  code: string,
): code is StageOutcomePreInvocationRejectionCode {
  return STAGE_OUTCOME_PRE_INVOCATION_REJECTION_CODE_SET.has(code);
}
