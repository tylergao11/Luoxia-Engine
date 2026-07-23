import { EngineFault } from "@luoxia/contracts-runtime";

import type { PreparedModelInvocation } from "./model-gateway.js";

declare const modelDispatchAuthorizationBrand: unique symbol;
declare const modelRecoveryAuthorizationBrand: unique symbol;

export interface ModelDispatchAuthorization {
  readonly [modelDispatchAuthorizationBrand]: true;
}

export interface ModelRecoveryAuthorization {
  readonly [modelRecoveryAuthorizationBrand]: true;
}

export interface RecordedModelInvocation {
  readonly snapshot: unknown;
  readonly request: unknown;
  readonly response: unknown;
  readonly proof: unknown;
}

export interface ModelDispatchAuthorizationIssuer {
  issue(invocation: PreparedModelInvocation): ModelDispatchAuthorization;
}

export interface ModelDispatchAuthorizationVerifier {
  consume(authorization: ModelDispatchAuthorization): PreparedModelInvocation;
}

export interface ModelRecoveryAuthorizationIssuer {
  issue(recorded: RecordedModelInvocation): ModelRecoveryAuthorization;
}

export interface ModelRecoveryAuthorizationVerifier {
  consume(authorization: ModelRecoveryAuthorization): RecordedModelInvocation;
}

export interface ModelInvocationAuthorizationChannel {
  readonly dispatchIssuer: ModelDispatchAuthorizationIssuer;
  readonly dispatchVerifier: ModelDispatchAuthorizationVerifier;
  readonly recoveryIssuer: ModelRecoveryAuthorizationIssuer;
  readonly recoveryVerifier: ModelRecoveryAuthorizationVerifier;
}

/**
 * Composition-root capability channel.
 *
 * The dispatch issuer belongs exclusively to the durable invocation Journal,
 * while the dispatch verifier belongs to ModelGateway. The recovery issuer
 * likewise belongs to the Journal and can only bind documents read from a
 * durable verified row. Both capabilities are single-use object identities;
 * no property or Symbol copied from another object can forge membership.
 */
export function createModelInvocationAuthorizationChannel(): ModelInvocationAuthorizationChannel {
  const pendingDispatches = new WeakMap<object, PreparedModelInvocation>();
  const pendingRecoveries = new WeakMap<object, RecordedModelInvocation>();

  return Object.freeze({
    dispatchIssuer: Object.freeze({
      issue(
        invocation: PreparedModelInvocation,
      ): ModelDispatchAuthorization {
        const authorization = Object.freeze(
          {},
        ) as ModelDispatchAuthorization;
        pendingDispatches.set(authorization, invocation);
        return authorization;
      },
    }),
    dispatchVerifier: Object.freeze({
      consume(
        authorization: ModelDispatchAuthorization,
      ): PreparedModelInvocation {
        const invocation = pendingDispatches.get(authorization);
        if (invocation === undefined) {
          throw new EngineFault(
            "model.dispatch.authorization_invalid",
            "Model dispatch authorization is invalid or already consumed",
          );
        }
        pendingDispatches.delete(authorization);
        return invocation;
      },
    }),
    recoveryIssuer: Object.freeze({
      issue(
        recorded: RecordedModelInvocation,
      ): ModelRecoveryAuthorization {
        const authorization = Object.freeze(
          {},
        ) as ModelRecoveryAuthorization;
        pendingRecoveries.set(authorization, recorded);
        return authorization;
      },
    }),
    recoveryVerifier: Object.freeze({
      consume(
        authorization: ModelRecoveryAuthorization,
      ): RecordedModelInvocation {
        const recorded = pendingRecoveries.get(authorization);
        if (recorded === undefined) {
          throw new EngineFault(
            "model.recovery.authorization_invalid",
            "Model recovery authorization is invalid or already consumed",
          );
        }
        pendingRecoveries.delete(authorization);
        return recorded;
      },
    }),
  });
}
