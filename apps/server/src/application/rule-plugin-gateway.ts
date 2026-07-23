import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonDigest,
  type JsonValue,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type RulePluginRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginRequest
>;

export type RulePluginResponseDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginResponse
>;

export interface RulePluginAdapter {
  resolve(request: RulePluginRequestDocument): Promise<unknown>;
}

export interface RulePluginSemanticGate {
  assertValid(
    request: RulePluginRequestDocument,
    response: RulePluginResponseDocument,
  ): Promise<void>;
}

export class RulePluginGateway {
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #adapter: RulePluginAdapter;
  readonly #semanticGate: RulePluginSemanticGate;

  public constructor(
    contracts: ContractValidator,
    digest: JsonDigest,
    adapter: RulePluginAdapter,
    semanticGate: RulePluginSemanticGate,
  ) {
    this.#contracts = contracts;
    this.#digest = digest;
    this.#adapter = adapter;
    this.#semanticGate = semanticGate;
  }

  public async resolve(candidate: unknown): Promise<RulePluginResponseDocument> {
    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      candidate,
    );
    const rawResponse = await this.#adapter.resolve(request);
    const response = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginResponse,
      rawResponse,
    );

    assertRulePluginCorrelation(request, response, this.#digest);
    await this.#semanticGate.assertValid(request, response);
    return response;
  }
}

function assertRulePluginCorrelation(
  request: RulePluginRequestDocument,
  response: RulePluginResponseDocument,
  digest: JsonDigest,
): void {
  const deterministicContext = expectJsonObject(
    expectProperty(request.value, "deterministic_context", "RulePluginRequest"),
    "RulePluginRequest.deterministic_context",
  );

  const pairs: readonly CorrelationPair[] = [
    stringPair(request, response, "request_id"),
    stringPair(request, response, "operation_id"),
    stringPair(request, response, "operation_kind"),
    {
      field: "basis_revision",
      expected: expectInteger(
        request.value,
        "basis_revision",
        "RulePluginRequest",
      ),
      actual: expectInteger(
        response.value,
        "basis_revision",
        "RulePluginResponse",
      ),
    },
    {
      field: "deterministic_context_id",
      expected: expectString(
        deterministicContext,
        "context_id",
        "RulePluginRequest.deterministic_context",
      ),
      actual: expectString(
        response.value,
        "deterministic_context_id",
        "RulePluginResponse",
      ),
    },
    {
      field: "deterministic_context_digest",
      expected: expectString(
        deterministicContext,
        "context_digest",
        "RulePluginRequest.deterministic_context",
      ),
      actual: expectString(
        response.value,
        "deterministic_context_digest",
        "RulePluginResponse",
      ),
    },
  ];

  for (const pair of pairs) {
    if (pair.expected !== pair.actual) {
      throw new EngineFault(
        "rule_plugin.response.correlation_mismatch",
        `RulePluginResponse ${pair.field} does not match its request`,
        {
          field: pair.field,
          expected: pair.expected,
          actual: pair.actual,
        },
      );
    }
  }

  const requestLock = expectProperty(
    request.value,
    "plugin_lock",
    "RulePluginRequest",
  );
  const responseLock = expectProperty(
    response.value,
    "plugin_lock",
    "RulePluginResponse",
  );
  if (!sameJson(requestLock, responseLock, digest)) {
    throw new EngineFault(
      "rule_plugin.response.plugin_lock_mismatch",
      "RulePluginResponse plugin_lock does not match its request",
    );
  }
}

function stringPair(
  request: RulePluginRequestDocument,
  response: RulePluginResponseDocument,
  field: string,
): CorrelationPair {
  return {
    field,
    expected: expectString(request.value, field, "RulePluginRequest"),
    actual: expectString(response.value, field, "RulePluginResponse"),
  };
}

function sameJson(left: JsonValue, right: JsonValue, digest: JsonDigest): boolean {
  return digest.canonicalize(left) === digest.canonicalize(right);
}

interface CorrelationPair {
  readonly field: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

