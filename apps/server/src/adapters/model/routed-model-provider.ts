import { EngineFault } from "@luoxia/contracts-runtime";

import type {
  ModelProviderInvocationResult,
  ModelProvider,
  ResolvedModelInvocation,
} from "../../application/model-gateway.js";

export interface RoutedModelProviderBinding {
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly provider: ModelProvider;
}

export interface RoutedModelProviderDependencies {
  readonly bindings: readonly RoutedModelProviderBinding[];
}

/**
 * Deployment-owned exact ModelProfile + operation router. Every route is
 * explicit and closed; there is no default provider, model, or request kind.
 */
export function createRoutedModelProvider(
  dependencies: RoutedModelProviderDependencies,
): ModelProvider {
  return new RoutedModelProvider(dependencies.bindings);
}

class RoutedModelProvider implements ModelProvider {
  readonly #bindings: ReadonlyMap<string, RoutedModelProviderBinding>;

  public constructor(
    candidates: readonly RoutedModelProviderBinding[],
  ) {
    if (candidates.length === 0) {
      throw new EngineFault(
        "model.provider.routes_empty",
        "Routed ModelProvider requires at least one explicit binding",
      );
    }
    const bindings = new Map<string, RoutedModelProviderBinding>();
    for (const candidate of candidates) {
      const binding = Object.freeze({
        modelProfileId: requireCleanText(
          candidate.modelProfileId,
          "model_profile_id",
        ),
        requestKind: requireCleanText(
          candidate.requestKind,
          "request_kind",
        ),
        provider: candidate.provider,
      });
      const key = routeKey(
        binding.modelProfileId,
        binding.requestKind,
      );
      if (bindings.has(key)) {
        throw new EngineFault(
          "model.provider.route_duplicate",
          "Deployment registered more than one provider for the same ModelProfile operation",
          {
            model_profile_id: binding.modelProfileId,
            request_kind: binding.requestKind,
          },
        );
      }
      binding.provider.assertCanInvoke({
        modelProfileId: binding.modelProfileId,
        requestKind: binding.requestKind,
      });
      bindings.set(key, binding);
    }
    this.#bindings = bindings;
  }

  public assertCanInvoke(input: {
    readonly modelProfileId: string;
    readonly requestKind: string;
  }): void {
    this.#requireBinding(
      input.modelProfileId,
      input.requestKind,
    ).provider.assertCanInvoke(input);
  }

  public invoke(
    resolved: ResolvedModelInvocation,
  ): Promise<ModelProviderInvocationResult> {
    return this.#requireBinding(
      resolved.modelProfileId,
      resolved.requestKind,
    ).provider.invoke(resolved);
  }

  #requireBinding(
    modelProfileId: string,
    requestKind: string,
  ): RoutedModelProviderBinding {
    const binding = this.#bindings.get(
      routeKey(modelProfileId, requestKind),
    );
    if (binding === undefined) {
      throw new EngineFault(
        "model.provider.route_not_configured",
        "Deployment has no provider for the requested ModelProfile operation",
        { model_profile_id: modelProfileId, request_kind: requestKind },
      );
    }
    return binding;
  }
}

function routeKey(
  modelProfileId: string,
  requestKind: string,
): string {
  return `${modelProfileId}\u0000${requestKind}`;
}

function requireCleanText(
  value: string,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new EngineFault(
      "model.provider.route_invalid",
      `ModelProvider route ${field} must be one clean nonempty value`,
      { field },
    );
  }
  return value;
}
