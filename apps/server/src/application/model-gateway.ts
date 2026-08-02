import {
  CONTRACT_REF,
  EngineFault,
  MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND,
  assertJsonValue,
  deepFreezeJson,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import { createModelOutputSemanticGate } from "./model-output-semantic-gate.js";
import type {
  ModelDispatchAuthorization,
  ModelDispatchAuthorizationVerifier,
  ModelRecoveryAuthorization,
  ModelRecoveryAuthorizationVerifier,
} from "./model-dispatch-authorization.js";
import { projectModelProviderInput } from "./model-provider-input-projection.js";

export type ModelRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.modelRequest
>;

export type ModelResponseDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.modelResponse
>;

export type VerifiedModelOutputDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.verifiedModelOutput
>;

export type WorldSnapshotDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.worldSnapshot
>;

/**
 * Minimal internal inference boundary. ModelProvider cannot inspect the
 * journal/proof request, resident/selection-space digests, or response
 * correlations. Only the operation route, ordered prompt text, and operation
 * input cross this boundary. Provider output remains untrusted JSON.
 */
export interface ResolvedModelInvocation {
  readonly modelProfileId: string;
  readonly requestKind: string;
  readonly promptTexts: readonly string[];
  readonly modelInput: JsonObject;
}

interface ProviderUsageObservationBase {
  readonly providerKind: string;
  readonly providerModel: string;
}

export type ProviderUsageObservation =
  | (ProviderUsageObservationBase & {
      readonly status: "complete";
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
    })
  | (ProviderUsageObservationBase & {
      readonly status: "partial";
      readonly inputTokens: number;
      readonly outputTokens: number;
    })
  | (ProviderUsageObservationBase & {
      readonly status: "absent" | "invalid";
    });

export interface ModelProviderInvocationResult {
  readonly output: unknown;
  readonly usage: ProviderUsageObservation;
}

export interface ModelProvider {
  /**
   * Synchronous deploy-time capability gate. Configuration mismatches must
   * fail before a durable model dispatch can make a command ambiguous.
   */
  assertCanInvoke(input: {
    readonly modelProfileId: string;
    readonly requestKind: string;
  }): void;
  invoke(
    resolved: ResolvedModelInvocation,
  ): Promise<ModelProviderInvocationResult>;
}

export interface ValidatedModelWorldScope {
  readonly snapshot: WorldSnapshotDocument;
}

export interface ModelPromptResolution {
  readonly prompt_blocks: readonly {
    readonly block_id: string;
    readonly content_digest: string;
    readonly text: string;
  }[];
}

declare const preparedModelInvocationSeal: unique symbol;

export interface PreparedModelInvocation {
  readonly [preparedModelInvocationSeal]: true;
  readonly worldId: string;
  readonly worldRevision: number;
  readonly snapshot: WorldSnapshotDocument;
  readonly request: ModelRequestDocument;
  readonly resolution: ModelPromptResolution;
}

declare const verifiedModelInvocationReceiptSeal: unique symbol;

export interface VerifiedModelInvocationReceipt {
  readonly [verifiedModelInvocationReceiptSeal]: true;
  readonly worldId: string;
  readonly worldRevision: number;
  readonly snapshot: WorldSnapshotDocument;
  readonly request: ModelRequestDocument;
  readonly response: ModelResponseDocument;
  readonly proof: VerifiedModelOutputDocument;
}

export interface CompletedModelInvocation {
  readonly receipt: VerifiedModelInvocationReceipt;
  readonly usage: ProviderUsageObservation;
}

export interface ModelInvocationProvenanceVerifier {
  isPrepared(value: unknown): value is PreparedModelInvocation;
  isVerified(value: unknown): value is VerifiedModelInvocationReceipt;
}

export class ModelGateway {
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #provider: ModelProvider;
  readonly #dispatchVerifier: ModelDispatchAuthorizationVerifier;
  readonly #recoveryVerifier: ModelRecoveryAuthorizationVerifier;
  readonly #preparedInvocations = new WeakSet<object>();
  readonly #providerInputs = new WeakMap<object, JsonObject>();
  readonly #verifiedReceipts = new WeakSet<object>();
  readonly #semanticGate = createModelOutputSemanticGate();
  public readonly provenance: ModelInvocationProvenanceVerifier;

  public constructor(
    contracts: ContractValidator,
    digest: JsonDigest,
    provider: ModelProvider,
    dispatchVerifier: ModelDispatchAuthorizationVerifier,
    recoveryVerifier: ModelRecoveryAuthorizationVerifier,
  ) {
    this.#contracts = contracts;
    this.#digest = digest;
    this.#provider = provider;
    this.#dispatchVerifier = dispatchVerifier;
    this.#recoveryVerifier = recoveryVerifier;
    this.provenance = Object.freeze({
      isPrepared: (
        value: unknown,
      ): value is PreparedModelInvocation =>
        typeof value === "object" &&
        value !== null &&
        this.#preparedInvocations.has(value),
      isVerified: (
        value: unknown,
      ): value is VerifiedModelInvocationReceipt =>
        typeof value === "object" &&
        value !== null &&
        this.#verifiedReceipts.has(value),
    });
  }

  public prepare(
    scope: ValidatedModelWorldScope,
    candidate: unknown,
    resolution: ModelPromptResolution,
    options?: { readonly requirePromptTexts?: boolean },
  ): PreparedModelInvocation {
    const requirePromptTexts = options?.requirePromptTexts !== false;
    const request = this.#contracts.assertObject(
      CONTRACT_REF.modelRequest,
      candidate,
    );
    const worldId = expectString(
      scope.snapshot.value,
      "world_id",
      "WorldSnapshot",
    );
    const worldRevision = expectInteger(
      scope.snapshot.value,
      "world_revision",
      "WorldSnapshot",
    );
    const requestBasisRevision = expectInteger(
      request.value,
      "basis_revision",
      "ModelRequest",
    );
    if (requestBasisRevision !== worldRevision) {
      throw new EngineFault(
        "model.request.world_scope_revision_mismatch",
        "ModelRequest basis_revision does not match its validated WorldSnapshot",
        {
          world_id: worldId,
          world_revision: worldRevision,
          basis_revision: requestBasisRevision,
        },
      );
    }
    assertRequestInputDigest(request, this.#digest);
    this.#semanticGate.assertRequest(request);
    const requestKind = expectString(
      request.value,
      "request_kind",
      "ModelRequest",
    );
    const providerInput = projectModelProviderInput(
      this.#contracts,
      requestKind,
      expectJsonObject(
        expectProperty(request.value, "input", "ModelRequest"),
        "ModelRequest.input",
      ),
    );
    if (requirePromptTexts) {
      assertPromptResolutionMatchesResident(request, resolution, this.#digest);
    }

    const frozenResolution: ModelPromptResolution = Object.freeze({
      prompt_blocks: Object.freeze([
        ...resolution.prompt_blocks,
      ]),
    });

    const invocation = Object.freeze({
      worldId,
      worldRevision,
      snapshot: scope.snapshot,
      request,
      resolution: frozenResolution,
    }) as PreparedModelInvocation;
    this.#preparedInvocations.add(invocation);
    this.#providerInputs.set(invocation, providerInput);
    return invocation;
  }

  public async invokePrepared(
    authorization: ModelDispatchAuthorization,
  ): Promise<CompletedModelInvocation> {
    const invocation = this.#dispatchVerifier.consume(authorization);
    this.#assertPreparedInvocation(invocation);
    const providerInput = this.#providerInputs.get(invocation);
    if (providerInput === undefined) {
      throw new EngineFault(
        "model.provider_input.prepared_projection_missing",
        "Prepared model invocation has no validated provider input projection",
      );
    }
    this.#providerInputs.delete(invocation);
    const request = invocation.request.value;
    const resolved: ResolvedModelInvocation = Object.freeze({
      modelProfileId: expectString(
        request,
        "model_profile_id",
        "ModelRequest",
      ),
      requestKind: expectString(
        request,
        "request_kind",
        "ModelRequest",
      ),
      promptTexts: Object.freeze(
        invocation.resolution.prompt_blocks.map((block) => block.text),
      ),
      modelInput: providerInput,
    });
    const providerResult = await this.#provider.invoke(resolved);
    const rawOutput = providerResult.output;
    assertJsonValue(rawOutput, "ModelOutput");
    const output = deepFreezeJson(
      expectJsonObject(rawOutput, "ModelOutput"),
    );
    const residentContext = expectJsonObject(
      expectProperty(request, "resident_context", "ModelRequest"),
      "ModelRequest.resident_context",
    );
    const rawResponse = Object.freeze({
      contract_version: "model-protocol.v1",
      record_type: "model.response",
      request_id: expectString(request, "request_id", "ModelRequest"),
      request_kind: resolved.requestKind,
      basis_revision: expectInteger(
        request,
        "basis_revision",
        "ModelRequest",
      ),
      resident_context_digest: expectString(
        residentContext,
        "resident_digest",
        "ResidentContextRef",
      ),
      dynamic_input_digest: expectString(
        request,
        "dynamic_input_digest",
        "ModelRequest",
      ),
      output_digest: this.#digest.sha256(output),
      output,
    });
    const verified = this.#validateResponse(invocation, rawResponse);
    const receipt = this.#createVerifiedReceipt(
      invocation,
      verified.response,
      verified.proof,
    );
    return Object.freeze({
      receipt,
      usage: providerResult.usage,
    });
  }

  public verifyRecorded(
    authorization: ModelRecoveryAuthorization,
  ): VerifiedModelInvocationReceipt {
    const recorded = this.#recoveryVerifier.consume(authorization);
    const snapshot = this.#contracts.assertObject(
      CONTRACT_REF.worldSnapshot,
      recorded.snapshot,
    );
    // Prompt texts are not journaled; recovery re-validates request/response only.
    const invocation = this.prepare(
      Object.freeze({ snapshot }),
      recorded.request,
      Object.freeze({ prompt_blocks: Object.freeze([]) }),
      Object.freeze({ requirePromptTexts: false }),
    );
    const verified = this.#validateResponse(invocation, recorded.response);
    const recordedProof = this.#contracts.assertObject(
      CONTRACT_REF.verifiedModelOutput,
      recorded.proof,
    );
    if (!jsonEquals(recordedProof.value, verified.proof.value)) {
      throw new EngineFault(
        "model.recorded.proof_mismatch",
        "Recorded VerifiedModelOutputRef does not match the recorded response",
        {
          request_id: expectString(
            invocation.request.value,
            "request_id",
            "ModelRequest",
          ),
        },
      );
    }
    return this.#createVerifiedReceipt(
      invocation,
      verified.response,
      recordedProof,
    );
  }

  #assertPreparedInvocation(
    invocation: PreparedModelInvocation,
  ): void {
    if (!this.provenance.isPrepared(invocation)) {
      throw new EngineFault(
        "model.invocation.prepared_receipt_required",
        "Model provider invocation requires this gateway's prepared request",
      );
    }
  }

  #createVerifiedReceipt(
    invocation: PreparedModelInvocation,
    response: ModelResponseDocument,
    proof: VerifiedModelOutputDocument,
  ): VerifiedModelInvocationReceipt {
    this.#assertPreparedInvocation(invocation);
    const receipt = Object.freeze({
      worldId: invocation.worldId,
      worldRevision: invocation.worldRevision,
      snapshot: invocation.snapshot,
      request: invocation.request,
      response,
      proof,
    }) as VerifiedModelInvocationReceipt;
    this.#verifiedReceipts.add(receipt);
    return receipt;
  }

  #validateResponse(
    invocation: PreparedModelInvocation,
    candidate: unknown,
  ): ValidatedModelResponse {
    let response: ModelResponseDocument;
    try {
      response = this.#contracts.assertObject(
        CONTRACT_REF.modelResponse,
        candidate,
      );
    } catch (error: unknown) {
      if (
        error instanceof EngineFault &&
        error.code === "contract.value.invalid" &&
        typeof candidate === "object" &&
        candidate !== null
      ) {
        const output = (candidate as JsonObject).output;
        if (
          typeof output === "object" &&
          output !== null &&
          !Array.isArray(output)
        ) {
          const outputKind = (output as JsonObject).output_kind;
          const requestKind = expectString(
            invocation.request.value,
            "request_kind",
            "ModelRequest",
          );
          const kindSchema =
            MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND[
              requestKind as keyof typeof MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND
            ];
          if (kindSchema !== undefined) {
            try {
              this.#contracts.assert(kindSchema, output);
            } catch (kindError: unknown) {
              if (kindError instanceof EngineFault) {
                throw markProviderOutputGateFailure(
                  new EngineFault(kindError.code, kindError.message, {
                    ...(kindError.details !== undefined
                      ? { output_validation: kindError.details }
                      : {}),
                    ...(error.details !== undefined
                      ? { response_validation: error.details }
                      : {}),
                    ...(typeof outputKind === "string"
                      ? { output_kind: outputKind }
                      : {}),
                    request_kind: requestKind,
                    output_schema: kindSchema,
                  }),
                );
              }
              throw kindError;
            }
          }
          try {
            this.#contracts.assert(CONTRACT_REF.modelOutput, output);
          } catch (outputError: unknown) {
            if (outputError instanceof EngineFault) {
              throw markProviderOutputGateFailure(
                new EngineFault(outputError.code, outputError.message, {
                  ...(outputError.details !== undefined
                    ? { output_validation: outputError.details }
                    : {}),
                  ...(error.details !== undefined
                    ? { response_validation: error.details }
                    : {}),
                  ...(typeof outputKind === "string"
                    ? { output_kind: outputKind }
                    : {}),
                  request_kind: requestKind,
                }),
              );
            }
            throw outputError;
          }
          const responseRequestKind = (candidate as JsonObject).request_kind;
          throw markProviderOutputGateFailure(
            new EngineFault(error.code, error.message, {
              ...(error.details !== undefined
                ? { response_validation: error.details }
                : {}),
              output_validated: true,
              ...(typeof outputKind === "string"
                ? { output_kind: outputKind }
                : {}),
              request_kind: requestKind,
              ...(typeof responseRequestKind === "string"
                ? { response_request_kind: responseRequestKind }
                : {}),
            }),
          );
        }
      }
      if (error instanceof EngineFault) {
        throw markProviderOutputGateFailure(error);
      }
      throw error;
    }

    assertModelCorrelation(invocation.request, response);
    assertResponseOutputDigest(response, this.#digest);
    this.#semanticGate.assertResponse(invocation.request, response);

    // Proof is locally constructed after a valid provider output gate; its
    // Schema failure is not a provider-output-gate definite failure.
    const proof = this.#contracts.assertObject(
      CONTRACT_REF.verifiedModelOutput,
      createProof(response),
    );
    return Object.freeze({ response, proof });
  }
}

/**
 * Internal provenance for journal definite-failure classification.
 * Only Schema/output-gate failures on the completed provider response may
 * carry this marker; journal/proof re-validation must not.
 */
const PROVIDER_OUTPUT_GATE_PROVENANCE = "provider_output_gate";

function markProviderOutputGateFailure(error: EngineFault): EngineFault {
  if (
    error.details !== undefined &&
    error.details.failure_provenance === PROVIDER_OUTPUT_GATE_PROVENANCE
  ) {
    return error;
  }
  return new EngineFault(error.code, error.message, {
    ...(error.details !== undefined ? error.details : {}),
    failure_provenance: PROVIDER_OUTPUT_GATE_PROVENANCE,
  });
}

interface ValidatedModelResponse {
  readonly response: ModelResponseDocument;
  readonly proof: VerifiedModelOutputDocument;
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

function assertPromptResolutionMatchesResident(
  request: ModelRequestDocument,
  resolution: ModelPromptResolution,
  digest: JsonDigest,
): void {
  const resident = expectJsonObject(
    expectProperty(request.value, "resident_context", "ModelRequest"),
    "ModelRequest.resident_context",
  );
  const refs: JsonObject[] = [];
  const contextKind = expectString(
    resident,
    "context_kind",
    "ResidentContextRef",
  );
  if (contextKind === "director") {
    const core = expectProperty(
      resident,
      "core_blocks",
      "DirectorResidentContextRef",
    );
    if (!Array.isArray(core)) {
      throw new EngineFault(
        "model.prompt.core_blocks_shape",
        "director resident_context.core_blocks must be an array",
      );
    }
    for (const entry of core) {
      refs.push(expectJsonObject(entry as never, "CacheBlockRef"));
    }
    if (resident.system_persona_block !== undefined) {
      refs.push(
        expectJsonObject(
          resident.system_persona_block,
          "DirectorResidentContextRef.system_persona_block",
        ),
      );
    }
    if (resident.selection_space_block !== undefined) {
      refs.push(
        expectJsonObject(
          resident.selection_space_block,
          "DirectorResidentContextRef.selection_space_block",
        ),
      );
    }
  } else if (contextKind === "character") {
    const persona = expectProperty(
      resident,
      "persona_blocks",
      "CharacterResidentContextRef",
    );
    if (!Array.isArray(persona)) {
      throw new EngineFault(
        "model.prompt.persona_blocks_shape",
        "resident_context.persona_blocks must be an array",
      );
    }
    for (const entry of persona) {
      refs.push(expectJsonObject(entry as never, "CacheBlockRef"));
    }
  } else {
    throw new EngineFault(
      "model.prompt.context_kind_unknown",
      "ResidentContextRef context_kind is not supported",
      { context_kind: contextKind },
    );
  }
  refs.push(
    expectJsonObject(
      expectProperty(resident, "mode_block", "ResidentContextRef"),
      "mode_block",
    ),
  );

  if (resolution.prompt_blocks.length !== refs.length) {
    throw new EngineFault(
      "model.prompt.block_count_mismatch",
      "Resolved prompt_blocks count does not match resident_context CacheBlockRef sequence",
      {
        expected: refs.length,
        actual: resolution.prompt_blocks.length,
      },
    );
  }

  for (const [index, ref] of refs.entries()) {
    const block = resolution.prompt_blocks[index];
    if (block === undefined) {
      throw new EngineFault(
        "model.prompt.block_missing",
        "Resolved prompt block missing at index",
        { index },
      );
    }
    const refId = expectString(ref, "block_id", "CacheBlockRef");
    const refDigest = expectString(ref, "content_digest", "CacheBlockRef");
    if (block.block_id !== refId || block.content_digest !== refDigest) {
      throw new EngineFault(
        "model.prompt.block_ref_mismatch",
        "Resolved prompt block does not match resident CacheBlockRef",
        {
          index,
          expected_block_id: refId,
          actual_block_id: block.block_id,
          expected_digest: refDigest,
          actual_digest: block.content_digest,
        },
      );
    }
    const textDigest = digest.sha256(block.text);
    if (textDigest !== block.content_digest) {
      throw new EngineFault(
        "model.prompt.text_digest_mismatch",
        "Prompt block text does not match content_digest",
        {
          block_id: block.block_id,
          content_digest: block.content_digest,
          text_digest: textDigest,
        },
      );
    }
  }

}
