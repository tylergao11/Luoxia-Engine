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

import type { DeterministicContextAuthority } from "@luoxia/world-core/composition";

import type {
  ModelInvocationProvenanceVerifier,
  VerifiedModelInvocationReceipt,
} from "./model-gateway.js";

export type RulePluginRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginRequest
>;

export type RulePluginResponseDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginResponse
>;

export type PacketProposalDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.packetProposal
>;

declare const verifiedRulePluginInvocationReceiptSeal: unique symbol;

export interface VerifiedRulePluginInvocationReceipt {
  readonly [verifiedRulePluginInvocationReceiptSeal]: true;
  readonly worldId: string;
  readonly basisRevision: number;
  readonly request: RulePluginRequestDocument;
  readonly response: RulePluginResponseDocument;
  readonly proposal: PacketProposalDocument | undefined;
}

export interface RulePluginInvocationProvenanceVerifier {
  isVerified(
    value: unknown,
  ): value is VerifiedRulePluginInvocationReceipt;
}

export interface RulePluginAdapter {
  resolve(request: RulePluginRequestDocument): Promise<unknown>;
}

export interface RulePluginSemanticGate {
  assertRequestEvidence(
    request: RulePluginRequestDocument,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<void>;
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
  readonly #modelProvenance: ModelInvocationProvenanceVerifier;
  readonly #deterministicContextAuthority: DeterministicContextAuthority;
  readonly #verifiedReceipts = new WeakSet<object>();
  public readonly provenance: RulePluginInvocationProvenanceVerifier;

  public constructor(
    contracts: ContractValidator,
    digest: JsonDigest,
    adapter: RulePluginAdapter,
    semanticGate: RulePluginSemanticGate,
    modelProvenance: ModelInvocationProvenanceVerifier,
    deterministicContextAuthority: DeterministicContextAuthority,
  ) {
    this.#contracts = contracts;
    this.#digest = digest;
    this.#adapter = adapter;
    this.#semanticGate = semanticGate;
    this.#modelProvenance = modelProvenance;
    this.#deterministicContextAuthority = deterministicContextAuthority;
    this.provenance = Object.freeze({
      isVerified: (
        value: unknown,
      ): value is VerifiedRulePluginInvocationReceipt =>
        typeof value === "object" &&
        value !== null &&
        this.#verifiedReceipts.has(value),
    });
  }

  public async resolve(
    candidate: unknown,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt> {
    const scopedModelInvocations = Object.freeze(
      Array.from(modelInvocations),
    );
    const request = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginRequest,
      candidate,
    );
    this.#assertVerifiedModelInvocations(scopedModelInvocations);
    await this.#semanticGate.assertRequestEvidence(
      request,
      scopedModelInvocations,
    );

    const readonlyWorld = expectJsonObject(
      expectProperty(request.value, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const worldId = expectString(readonlyWorld, "world_id", "WorldSnapshot");
    this.#deterministicContextAuthority.assertAuthentic(
      expectProperty(
        request.value,
        "deterministic_context",
        "RulePluginRequest",
      ),
      worldId,
    );

    const rawResponse = await this.#adapter.resolve(request);
    const response = this.#contracts.assertObject(
      CONTRACT_REF.rulePluginResponse,
      rawResponse,
    );

    assertRulePluginCorrelation(request, response, this.#digest);
    await this.#semanticGate.assertValid(request, response);
    return this.#createVerifiedReceipt(
      request,
      response,
    );
  }

  #createVerifiedReceipt(
    request: RulePluginRequestDocument,
    response: RulePluginResponseDocument,
  ): VerifiedRulePluginInvocationReceipt {
    const world = expectJsonObject(
      expectProperty(request.value, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const output = expectJsonObject(
      expectProperty(response.value, "output", "RulePluginResponse"),
      "RulePluginResponse.output",
    );
    const outputKind = expectString(
      output,
      "output_kind",
      "RulePluginResponse.output",
    );
    const proposal =
      outputKind === "packet.proposal"
        ? this.#contracts.assertObject(
            CONTRACT_REF.packetProposal,
            expectProperty(output, "proposal", "RulePluginResponse.output"),
          )
        : undefined;

    const receipt = Object.freeze({
      worldId: expectString(world, "world_id", "WorldSnapshot"),
      basisRevision: expectInteger(
        request.value,
        "basis_revision",
        "RulePluginRequest",
      ),
      request,
      response,
      proposal,
    }) as VerifiedRulePluginInvocationReceipt;
    this.#verifiedReceipts.add(receipt);
    return receipt;
  }

  #assertVerifiedModelInvocations(
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): void {
    for (const [index, receipt] of modelInvocations.entries()) {
      if (!this.#modelProvenance.isVerified(receipt)) {
        throw new EngineFault(
          "rule_plugin.request.verified_model_receipt_required",
          "RulePlugin model evidence requires this runtime's verified receipts",
          { receipt_index: index },
        );
      }
    }
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
