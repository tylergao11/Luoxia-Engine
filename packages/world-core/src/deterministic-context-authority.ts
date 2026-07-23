import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime/portable";

export type DeterministicContextDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.deterministicContext
>;

/**
 * Digest port for DeterministicContext. Implemented by composition root
 * (typically Rfc8785JsonDigest). Cryptography remains outside World Core.
 */
export interface DeterministicContextDigest {
  sha256(value: JsonValue): string;
}

/**
 * Narrow token port. HMAC (or other MAC) lives in Server adapters only.
 */
export interface DeterministicContextTokenCodec {
  issue(input: {
    readonly worldId: string;
    readonly contextDigest: string;
  }): string;
  assertAuthentic(input: {
    readonly worldId: string;
    readonly contextDigest: string;
    readonly issuerToken: string;
  }): void;
}

/**
 * Supplies context_id values. Callers of Authority.issue cannot choose the id.
 */
export interface DeterministicContextIdFactory {
  createContextId(): string;
}

export interface DeterministicContextIssueInput {
  readonly worldId: string;
  readonly logicalTime: JsonValue;
  readonly randomChoices: JsonValue;
  readonly externalResults: JsonValue;
}

export interface DeterministicContextAuthority {
  issue(input: DeterministicContextIssueInput): DeterministicContextDocument;
  assertAuthentic(
    candidate: unknown,
    worldId: string,
  ): DeterministicContextDocument;
}

export interface DeterministicContextAuthorityDependencies {
  readonly contracts: ContractValidator;
  readonly digest: DeterministicContextDigest;
  readonly tokenCodec: DeterministicContextTokenCodec;
  readonly contextIdFactory: DeterministicContextIdFactory;
}

const ISSUER = "world_core";

/**
 * World Core sole owner of DeterministicContext issue and authenticity checks.
 * Digest covers every validated context field except context_digest and issuer_token.
 * Token binds world_id + context_digest; no basis_revision, no TTL.
 */
export function createDeterministicContextAuthority(
  dependencies: DeterministicContextAuthorityDependencies,
): DeterministicContextAuthority {
  return new DefaultDeterministicContextAuthority(dependencies);
}

class DefaultDeterministicContextAuthority
  implements DeterministicContextAuthority
{
  readonly #contracts: ContractValidator;
  readonly #digest: DeterministicContextDigest;
  readonly #tokenCodec: DeterministicContextTokenCodec;
  readonly #contextIdFactory: DeterministicContextIdFactory;

  public constructor(dependencies: DeterministicContextAuthorityDependencies) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#tokenCodec = dependencies.tokenCodec;
    this.#contextIdFactory = dependencies.contextIdFactory;
  }

  public issue(
    input: DeterministicContextIssueInput,
  ): DeterministicContextDocument {
    const contextId = this.#contextIdFactory.createContextId();
    assertExternalResultsDigests(
      input.externalResults,
      this.#digest,
      "issue",
    );

    const digestBody = Object.freeze({
      context_id: contextId,
      issuer: ISSUER,
      logical_time: input.logicalTime,
      random_choices: input.randomChoices,
      external_results: input.externalResults,
    });
    const contextDigest = this.#digest.sha256(digestBody);
    const issuerToken = this.#tokenCodec.issue({
      worldId: input.worldId,
      contextDigest,
    });

    const candidate = Object.freeze({
      context_id: contextId,
      issuer: ISSUER,
      context_digest: contextDigest,
      issuer_token: issuerToken,
      logical_time: input.logicalTime,
      random_choices: input.randomChoices,
      external_results: input.externalResults,
    });

    return this.#contracts.assertObject(
      CONTRACT_REF.deterministicContext,
      candidate,
    );
  }

  public assertAuthentic(
    candidate: unknown,
    worldId: string,
  ): DeterministicContextDocument {
    const document = this.#contracts.assertObject(
      CONTRACT_REF.deterministicContext,
      candidate,
    );
    const value = document.value;

    const contextId = expectString(value, "context_id", "DeterministicContext");
    const issuer = expectString(value, "issuer", "DeterministicContext");
    if (issuer !== ISSUER) {
      throw new EngineFault(
        "deterministic_context.issuer_mismatch",
        "DeterministicContext.issuer must be world_core",
        { issuer },
      );
    }

    const externalResults = expectProperty(
      value,
      "external_results",
      "DeterministicContext",
    );
    const claimedDigest = expectString(
      value,
      "context_digest",
      "DeterministicContext",
    );
    const issuerToken = expectString(
      value,
      "issuer_token",
      "DeterministicContext",
    );

    assertExternalResultsDigests(externalResults, this.#digest, "verify");

    const digestBody = contextDigestBodyFromValidatedContext(value);
    const expectedDigest = this.#digest.sha256(digestBody);
    if (expectedDigest !== claimedDigest) {
      throw new EngineFault(
        "deterministic_context.digest_mismatch",
        "DeterministicContext.context_digest does not match recomputed digest body",
        {
          context_id: contextId,
        },
      );
    }

    this.#tokenCodec.assertAuthentic({
      worldId,
      contextDigest: claimedDigest,
      issuerToken,
    });

    return document;
  }
}

/**
 * The validated Schema remains the field truth. Only the two self-referential
 * proof fields are excluded, so future Schema fields are authenticated
 * automatically instead of requiring a second allow-list here.
 */
function contextDigestBodyFromValidatedContext(context: JsonObject): JsonObject {
  const body: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(context)) {
    if (field !== "context_digest" && field !== "issuer_token") {
      body[field] = value;
    }
  }
  return Object.freeze(body);
}

function assertExternalResultsDigests(
  externalResults: JsonValue,
  digest: DeterministicContextDigest,
  phase: "issue" | "verify",
): void {
  if (!Array.isArray(externalResults)) {
    throw new EngineFault(
      "deterministic_context.external_results_shape",
      "DeterministicContext.external_results must be an array",
      { phase },
    );
  }

  for (const [index, entry] of externalResults.entries()) {
    const result = expectJsonObject(
      entry as JsonValue,
      `DeterministicContext.external_results[${index}]`,
    );
    const claimed = expectString(
      result,
      "content_digest",
      `DeterministicContext.external_results[${index}]`,
    );
    const payload = expectProperty(
      result,
      "payload",
      `DeterministicContext.external_results[${index}]`,
    );
    const actual = digest.sha256(payload);
    if (actual !== claimed) {
      throw new EngineFault(
        "deterministic_context.external_result_digest_mismatch",
        "external_results content_digest does not match payload digest",
        Object.freeze({
          phase,
          result_index: index,
        }),
      );
    }
  }
}
