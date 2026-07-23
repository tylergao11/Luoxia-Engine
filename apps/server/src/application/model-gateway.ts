import {
  CONTRACT_REF,
  EngineFault,
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
 * Internal provider payload: validated request + ordered prompt texts matching resident refs.
 * Provider output remains untrusted JSON.
 */
export interface ResolvedModelInvocation {
  readonly request: ModelRequestDocument;
  readonly prompt_blocks: readonly {
    readonly block_id: string;
    readonly content_digest: string;
    readonly text: string;
  }[];
  readonly event_context?: {
    readonly capability_catalog_digest: string;
    readonly world_law_catalog_digest: string;
    readonly content_bundle_digest: string;
    readonly event_contract_digest: string;
    readonly context_digest: string;
  };
}

export interface ModelProvider {
  invoke(resolved: ResolvedModelInvocation): Promise<unknown>;
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
  readonly event_context?: ResolvedModelInvocation["event_context"];
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
    if (requirePromptTexts) {
      assertPromptResolutionMatchesResident(request, resolution, this.#digest);
    }

    const frozenResolution: ModelPromptResolution =
      resolution.event_context === undefined
        ? Object.freeze({
            prompt_blocks: Object.freeze([...resolution.prompt_blocks]),
          })
        : Object.freeze({
            prompt_blocks: Object.freeze([...resolution.prompt_blocks]),
            event_context: resolution.event_context,
          });

    const invocation = Object.freeze({
      worldId,
      worldRevision,
      snapshot: scope.snapshot,
      request,
      resolution: frozenResolution,
    }) as PreparedModelInvocation;
    this.#preparedInvocations.add(invocation);
    return invocation;
  }

  public async invokePrepared(
    authorization: ModelDispatchAuthorization,
  ): Promise<VerifiedModelInvocationReceipt> {
    const invocation = this.#dispatchVerifier.consume(authorization);
    this.#assertPreparedInvocation(invocation);
    const resolved: ResolvedModelInvocation =
      invocation.resolution.event_context === undefined
        ? Object.freeze({
            request: invocation.request,
            prompt_blocks: invocation.resolution.prompt_blocks,
          })
        : Object.freeze({
            request: invocation.request,
            prompt_blocks: invocation.resolution.prompt_blocks,
            event_context: invocation.resolution.event_context,
          });
    const rawResponse = await this.#provider.invoke(resolved);
    const verified = this.#validateResponse(invocation, rawResponse);
    return this.#createVerifiedReceipt(
      invocation,
      verified.response,
      verified.proof,
    );
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
    const response = this.#contracts.assertObject(
      CONTRACT_REF.modelResponse,
      candidate,
    );

    assertModelCorrelation(invocation.request, response);
    assertResponseOutputDigest(response, this.#digest);
    this.#semanticGate.assertResponse(invocation.request, response);

    const proof = this.#contracts.assertObject(
      CONTRACT_REF.verifiedModelOutput,
      createProof(response),
    );
    return Object.freeze({ response, proof });
  }
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
  const common = expectProperty(resident, "common_blocks", "ResidentContextRef");
  if (!Array.isArray(common)) {
    throw new EngineFault(
      "model.prompt.common_blocks_shape",
      "resident_context.common_blocks must be an array",
    );
  }
  for (const entry of common) {
    refs.push(expectJsonObject(entry as never, "CacheBlockRef"));
  }
  if (expectString(resident, "context_kind", "ResidentContextRef") === "character") {
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

  if (expectString(resident, "context_kind", "ResidentContextRef") === "director") {
    const eventContext = expectJsonObject(
      expectProperty(resident, "event_context", "DirectorResidentContextRef"),
      "event_context",
    );
    const payload = resolution.event_context;
    if (payload === undefined) {
      throw new EngineFault(
        "model.prompt.event_context_missing",
        "Director resolution requires event_context payload",
      );
    }
    const fields = [
      "context_digest",
      "event_contract_digest",
      "content_bundle_digest",
      "capability_catalog_digest",
      "world_law_catalog_digest",
    ] as const;
    for (const field of fields) {
      if (
        expectString(eventContext, field, "EventInvocationContextRef") !==
        payload[field]
      ) {
        throw new EngineFault(
          "model.prompt.event_context_mismatch",
          `event_context.${field} does not match resolved payload`,
          { field },
        );
      }
    }
  }
}
