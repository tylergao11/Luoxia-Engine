import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonDigest,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type ModelRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.modelRequest
>;

export type ModelResponseDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.modelResponse
>;

export type VerifiedModelOutputDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.verifiedModelOutput
>;

export interface ModelProvider {
  invoke(request: ModelRequestDocument): Promise<unknown>;
}

export interface ModelInvocation {
  readonly response: ModelResponseDocument;
  readonly proof: VerifiedModelOutputDocument;
}

export class ModelGateway {
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #provider: ModelProvider;

  public constructor(
    contracts: ContractValidator,
    digest: JsonDigest,
    provider: ModelProvider,
  ) {
    this.#contracts = contracts;
    this.#digest = digest;
    this.#provider = provider;
  }

  public async invoke(candidate: unknown): Promise<ModelInvocation> {
    const request = this.#contracts.assertObject(
      CONTRACT_REF.modelRequest,
      candidate,
    );
    assertRequestInputDigest(request, this.#digest);

    const rawResponse = await this.#provider.invoke(request);
    const response = this.#contracts.assertObject(
      CONTRACT_REF.modelResponse,
      rawResponse,
    );

    assertModelCorrelation(request, response);
    assertResponseOutputDigest(response, this.#digest);

    const proof = this.#contracts.assertObject(
      CONTRACT_REF.verifiedModelOutput,
      createProof(response),
    );

    return Object.freeze({ response, proof });
  }
}

function assertRequestInputDigest(
  request: ModelRequestDocument,
  digest: JsonDigest,
): void {
  const declared = expectString(
    request.value,
    "dynamic_input_digest",
    "ModelRequest",
  );
  const actual = digest.sha256(
    expectProperty(request.value, "input", "ModelRequest"),
  );

  if (declared !== actual) {
    throw new EngineFault(
      "model.request.dynamic_input_digest_mismatch",
      "ModelRequest dynamic_input_digest does not match input",
      { declared_digest: declared, actual_digest: actual },
    );
  }
}

function assertResponseOutputDigest(
  response: ModelResponseDocument,
  digest: JsonDigest,
): void {
  const declared = expectString(
    response.value,
    "output_digest",
    "ModelResponse",
  );
  const actual = digest.sha256(
    expectProperty(response.value, "output", "ModelResponse"),
  );

  if (declared !== actual) {
    throw new EngineFault(
      "model.response.output_digest_mismatch",
      "ModelResponse output_digest does not match output",
      { declared_digest: declared, actual_digest: actual },
    );
  }
}

function assertModelCorrelation(
  request: ModelRequestDocument,
  response: ModelResponseDocument,
): void {
  const residentContext = expectJsonObject(
    expectProperty(request.value, "resident_context", "ModelRequest"),
    "ModelRequest.resident_context",
  );

  const pairs: readonly CorrelationPair[] = [
    {
      field: "request_id",
      expected: expectString(request.value, "request_id", "ModelRequest"),
      actual: expectString(response.value, "request_id", "ModelResponse"),
    },
    {
      field: "request_kind",
      expected: expectString(request.value, "request_kind", "ModelRequest"),
      actual: expectString(response.value, "request_kind", "ModelResponse"),
    },
    {
      field: "basis_revision",
      expected: expectInteger(
        request.value,
        "basis_revision",
        "ModelRequest",
      ),
      actual: expectInteger(
        response.value,
        "basis_revision",
        "ModelResponse",
      ),
    },
    {
      field: "dynamic_input_digest",
      expected: expectString(
        request.value,
        "dynamic_input_digest",
        "ModelRequest",
      ),
      actual: expectString(
        response.value,
        "dynamic_input_digest",
        "ModelResponse",
      ),
    },
    {
      field: "resident_context_digest",
      expected: expectString(
        residentContext,
        "resident_digest",
        "ModelRequest.resident_context",
      ),
      actual: expectString(
        response.value,
        "resident_context_digest",
        "ModelResponse",
      ),
    },
  ];

  for (const pair of pairs) {
    if (pair.expected !== pair.actual) {
      throw new EngineFault(
        "model.response.correlation_mismatch",
        `ModelResponse ${pair.field} does not match its pending request`,
        {
          field: pair.field,
          expected: pair.expected,
          actual: pair.actual,
        },
      );
    }
  }
}

function createProof(response: ModelResponseDocument): object {
  return {
    request_id: expectString(response.value, "request_id", "ModelResponse"),
    request_kind: expectString(
      response.value,
      "request_kind",
      "ModelResponse",
    ),
    basis_revision: expectInteger(
      response.value,
      "basis_revision",
      "ModelResponse",
    ),
    resident_context_digest: expectString(
      response.value,
      "resident_context_digest",
      "ModelResponse",
    ),
    dynamic_input_digest: expectString(
      response.value,
      "dynamic_input_digest",
      "ModelResponse",
    ),
    output_digest: expectString(
      response.value,
      "output_digest",
      "ModelResponse",
    ),
  };
}

interface CorrelationPair {
  readonly field: string;
  readonly expected: number | string;
  readonly actual: number | string;
}

