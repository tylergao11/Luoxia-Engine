import { EngineFault, type JsonObject } from "@luoxia/contracts-runtime";

import type {
  ModelInvocationJournal,
  StoredFailedDefiniteModelInvocation,
} from "./runtime-persistence.js";

/**
 * Operator-adjudicated void of a dispatched_ambiguous model invocation.
 * Internal journal failure code only — not a public protocol field.
 */
export const MODEL_OPERATOR_ADJUDICATED_VOID_CODE =
  "model.operator.adjudicated_void";

/**
 * Deployment-owned operator attestation for voidAmbiguous.
 * Not a Client Bridge field and not a public protocol schema.
 */
export interface ModelInvocationOperatorAttestation {
  readonly reason: string;
}

export interface ModelInvocationOperatorVoidInput {
  readonly requestId: string;
  readonly operatorAttestation: ModelInvocationOperatorAttestation;
}

/**
 * Trusted deployment-api surface for model invocation operator actions.
 * Not exposed on Client Bridge. Never auto-retries ambiguous dispatches.
 */
export interface ModelInvocationOperatorFacade {
  /**
   * Adjudicate a dispatched_ambiguous invocation as failed_definite so the
   * world is no longer poisoned as unknown. Reuses journal.recordFailedDefinite
   * with model.operator.adjudicated_void. Does not call the provider.
   */
  voidAmbiguous(
    input: ModelInvocationOperatorVoidInput,
  ): Promise<StoredFailedDefiniteModelInvocation>;
}

export function createModelInvocationOperatorFacade(input: {
  readonly journal: ModelInvocationJournal;
}): ModelInvocationOperatorFacade {
  const journal = input.journal;
  return Object.freeze({
    async voidAmbiguous(
      voidInput: ModelInvocationOperatorVoidInput,
    ): Promise<StoredFailedDefiniteModelInvocation> {
      const requestId = expectNonEmptyTrimmedId(
        voidInput.requestId,
        "requestId",
      );
      const operatorAttestation = validateOperatorAttestation(
        voidInput.operatorAttestation,
        requestId,
      );
      const stored = await journal.readByRequestId(requestId);
      if (stored === undefined) {
        throw new EngineFault(
          "model.operator.invocation_not_found",
          "Model invocation request_id was not found for operator void",
          { request_id: requestId },
        );
      }
      if (stored.phase !== "dispatched_ambiguous") {
        throw new EngineFault(
          "model.operator.void_not_ambiguous",
          "Operator voidAmbiguous is allowed only from dispatched_ambiguous",
          {
            request_id: requestId,
            phase: stored.phase,
          },
        );
      }
      const outputSummary: JsonObject = Object.freeze({
        failure_code: MODEL_OPERATOR_ADJUDICATED_VOID_CODE,
        operator_attestation: Object.freeze({
          reason: operatorAttestation.reason,
        }),
      });
      return journal.recordFailedDefinite({
        requestId,
        failureCode: MODEL_OPERATOR_ADJUDICATED_VOID_CODE,
        outputSummary,
      });
    },
  });
}

function validateOperatorAttestation(
  candidate: ModelInvocationOperatorAttestation,
  requestId: string,
): ModelInvocationOperatorAttestation {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new EngineFault(
      "model.operator.attestation_invalid",
      "operator_attestation must be a JSON object",
      { request_id: requestId },
    );
  }
  const keys = Object.keys(candidate);
  if (keys.length !== 1 || keys[0] !== "reason") {
    throw new EngineFault(
      "model.operator.attestation_invalid",
      "operator_attestation must contain only the closed reason field",
      { request_id: requestId, keys },
    );
  }
  const reason = candidate.reason;
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason !== reason.trim() ||
    reason.length > 2048 ||
    /[\r\n]/.test(reason)
  ) {
    throw new EngineFault(
      "model.operator.attestation_invalid",
      "operator_attestation.reason must be a non-empty trimmed string up to 2048 characters without newlines",
      { request_id: requestId },
    );
  }
  return Object.freeze({ reason });
}

function expectNonEmptyTrimmedId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new EngineFault(
      "model.operator.request_id_invalid",
      `${field} must be a non-empty trimmed string`,
      { field },
    );
  }
  return value;
}
