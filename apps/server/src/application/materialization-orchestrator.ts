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
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  DeterministicContextAuthority,
} from "@luoxia/world-core/composition";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";

import type { AssetProviderRegistry } from "./asset-provider-registry.js";
import type {
  AssetAcceptanceDocument,
  AssetCandidateDocument,
  MaterializationLedger,
  MaterializationRequestDocument,
  ReviewReceiptDocument,
  RuntimeWorldReader,
  RuntimeWorldRecord,
  StoredMaterializationReview,
} from "./runtime-persistence.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

export interface MaterializationIdentityFactory {
  createAcceptanceId(): string;
  createBindingId(): string;
}

export interface MaterializationClock {
  now(): string;
}

export type MaterializationGenerationResult =
  | {
      readonly branch: "idle";
    }
  | {
      readonly branch: "superseded";
      readonly request: MaterializationRequestDocument;
    }
  | {
      readonly branch: "candidate";
      readonly request: MaterializationRequestDocument;
      readonly candidate: AssetCandidateDocument;
    };

export type MaterializationAcceptanceResult =
  | {
      readonly branch: "bound";
      readonly acceptance: AssetAcceptanceDocument;
      readonly result: ApplyPacketResultDocument;
    }
  | {
      readonly branch: "superseded";
      readonly request: MaterializationRequestDocument;
      readonly acceptance: AssetAcceptanceDocument;
    };

export type MaterializationReviewResult =
  | {
      readonly branch: "rejected";
      readonly request: MaterializationRequestDocument;
      readonly review: ReviewReceiptDocument;
    }
  | MaterializationAcceptanceResult;

/**
 * Production Materialization path:
 * PostgreSQL outbox request -> exact locked AssetProvider -> persisted candidate
 * -> explicit review -> persisted acceptance -> sole apply_packet binding commit.
 */
export interface MaterializationOrchestrator {
  generateNext(): Promise<MaterializationGenerationResult>;
  submitReview(candidate: unknown): Promise<MaterializationReviewResult>;
  resumeAcceptance(
    acceptanceId: string,
  ): Promise<MaterializationAcceptanceResult>;
}

export interface MaterializationOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly catalog: ContentRuntimeCatalog;
  readonly providers: AssetProviderRegistry;
  readonly ledger: MaterializationLedger;
  readonly worlds: RuntimeWorldReader;
  readonly deterministicContexts: Pick<DeterministicContextAuthority, "issue">;
  readonly identities: MaterializationIdentityFactory;
  readonly clock: MaterializationClock;
  readonly mutations: WorldMutationOrchestrator;
}

export function createMaterializationOrchestrator(
  dependencies: MaterializationOrchestratorDependencies,
): MaterializationOrchestrator {
  return new DefaultMaterializationOrchestrator(dependencies);
}

class DefaultMaterializationOrchestrator
  implements MaterializationOrchestrator
{
  readonly #contracts: ContractValidator;
  readonly #digest: JsonDigest;
  readonly #catalog: ContentRuntimeCatalog;
  readonly #providers: AssetProviderRegistry;
  readonly #ledger: MaterializationLedger;
  readonly #worlds: RuntimeWorldReader;
  readonly #deterministicContexts: Pick<
    DeterministicContextAuthority,
    "issue"
  >;
  readonly #identities: MaterializationIdentityFactory;
  readonly #clock: MaterializationClock;
  readonly #mutations: WorldMutationOrchestrator;

  public constructor(dependencies: MaterializationOrchestratorDependencies) {
    this.#contracts = dependencies.contracts;
    this.#digest = dependencies.digest;
    this.#catalog = dependencies.catalog;
    this.#providers = dependencies.providers;
    this.#ledger = dependencies.ledger;
    this.#worlds = dependencies.worlds;
    this.#deterministicContexts = dependencies.deterministicContexts;
    this.#identities = dependencies.identities;
    this.#clock = dependencies.clock;
    this.#mutations = dependencies.mutations;
  }

  public async generateNext(): Promise<MaterializationGenerationResult> {
    const request = await this.#ledger.claimNextPending();
    if (request === undefined) {
      return Object.freeze({ branch: "idle" as const });
    }
    const requestId = expectString(
      request.value,
      "request_id",
      "MaterializationRequest",
    );

    try {
      const world = await this.#readRequestWorld(request);
      const subject = findCurrentSubject(
        request.value,
        world.snapshot.value,
      );
      if (subject === undefined) {
        const superseded = await this.#ledger.markSuperseded(
          requestId,
          "generating",
        );
        return Object.freeze({
          branch: "superseded" as const,
          request: superseded,
        });
      }

      const content = resolveRequestContent(
        this.#catalog,
        request.value,
        world,
      );
      assertRequestFallback(request.value, content.fallbackAsset);
      const dependency = content.assetProviderDependency;
      assertAssetProviderDependency(dependency);
      const provider = this.#providers.requireAdapterForDependency({
        package_id: expectString(
          dependency,
          "package_id",
          "DependencyLock",
        ),
        version: expectString(dependency, "version", "DependencyLock"),
        integrity_sha256: expectString(
          dependency,
          "integrity_sha256",
          "DependencyLock",
        ),
      });

      const output = await provider.adapter.generate({
        request,
        subject,
        materializationProfile: content.materializationProfile,
        artProfile: content.artProfile,
      });
      const candidate = this.#contracts.assertObject(
        CONTRACT_REF.assetCandidate,
        output,
      );
      assertCandidateOutput(request, candidate, provider.identity.package_id);
      const stored = await this.#ledger.recordCandidate(requestId, candidate);
      return Object.freeze({
        branch: "candidate" as const,
        request: stored.request,
        candidate: stored.candidate,
      });
    } catch (error: unknown) {
      await this.#markFailedOrReportLifecycleConflict(
        requestId,
        "generating",
        error,
      );
      throw error;
    }
  }

  public async submitReview(
    candidate: unknown,
  ): Promise<MaterializationReviewResult> {
    const review = this.#contracts.assertObject(
      CONTRACT_REF.reviewReceipt,
      candidate,
    );
    const candidateId = expectString(
      review.value,
      "candidate_id",
      "ReviewReceipt",
    );
    const stored = await this.#ledger.readByCandidateId(candidateId);
    if (stored === undefined) {
      throw new EngineFault(
        "materialization.review.candidate_missing",
        "ReviewReceipt references no persisted AssetCandidate",
        { candidate_id: candidateId },
      );
    }

    const world = await this.#readRequestWorld(stored.request);
    const content = resolveRequestContent(
      this.#catalog,
      stored.request.value,
      world,
    );
    assertRequestFallback(stored.request.value, content.fallbackAsset);
    assertReviewPolicy(content.materializationProfile, review.value);

    if (
      expectString(review.value, "verdict", "ReviewReceipt") === "rejected"
    ) {
      const recorded = await this.#ledger.recordReview(review, undefined);
      return Object.freeze({
        branch: "rejected" as const,
        request: recorded.request,
        review: recorded.review,
      });
    }

    const acceptance = this.#buildAcceptance(
      stored.request,
      stored.candidate,
      review,
      world,
    );
    const recorded = await this.#ledger.recordReview(review, acceptance);
    if (recorded.acceptance === undefined) {
      throw new EngineFault(
        "materialization.ledger.database_corrupt",
        "Accepted ReviewReceipt was persisted without AssetAcceptance",
        { candidate_id: candidateId },
      );
    }
    return this.#commitAcceptance(recorded);
  }

  public async resumeAcceptance(
    acceptanceId: string,
  ): Promise<MaterializationAcceptanceResult> {
    const id = this.#contracts.assert(CONTRACT_REF.uuid, acceptanceId)
      .value as string;
    const stored = await this.#ledger.readAccepted(id);
    if (stored === undefined || stored.acceptance === undefined) {
      throw new EngineFault(
        "materialization.acceptance.missing",
        "No persisted AssetAcceptance exists for recovery",
        { acceptance_id: id },
      );
    }
    return this.#commitAcceptance(stored);
  }

  async #readRequestWorld(
    request: MaterializationRequestDocument,
  ): Promise<RuntimeWorldRecord> {
    const worldId = expectString(
      request.value,
      "world_id",
      "MaterializationRequest",
    );
    const world = await this.#worlds.readCurrent(worldId);
    const actualWorldId = expectString(
      world.snapshot.value,
      "world_id",
      "WorldSnapshot",
    );
    if (actualWorldId !== worldId) {
      throw new EngineFault(
        "materialization.world_identity_mismatch",
        "Runtime world reader returned another world",
        {
          request_id: expectString(
            request.value,
            "request_id",
            "MaterializationRequest",
          ),
          expected_world_id: worldId,
          actual_world_id: actualWorldId,
        },
      );
    }
    return world;
  }

  #buildAcceptance(
    request: MaterializationRequestDocument,
    candidate: AssetCandidateDocument,
    review: ReviewReceiptDocument,
    world: RuntimeWorldRecord,
  ): AssetAcceptanceDocument {
    const acceptanceId = this.#identities.createAcceptanceId();
    const bindingId = this.#identities.createBindingId();
    this.#contracts.assert(CONTRACT_REF.uuid, acceptanceId);
    this.#contracts.assert(CONTRACT_REF.uuid, bindingId);

    const payload: JsonObject = Object.freeze({
      acceptance_id: acceptanceId,
      binding_id: bindingId,
      request: request.value,
      candidate: candidate.value,
      review: review.value,
    });
    const worldState = expectJsonObject(
      expectProperty(
        world.snapshot.value,
        "world_state",
        "WorldSnapshot",
      ),
      "WorldSnapshot.world_state",
    );
    const deterministicContext = this.#deterministicContexts.issue({
      worldId: expectString(
        request.value,
        "world_id",
        "MaterializationRequest",
      ),
      logicalTime: expectProperty(worldState, "clock", "WorldState"),
      randomChoices: [],
      externalResults: [
        {
          result_id: "asset_acceptance_chain",
          content_digest: this.#digest.sha256(payload),
          payload,
        },
      ],
    });

    return this.#contracts.assertObject(CONTRACT_REF.assetAcceptance, {
      contract_version: "materialization.v1",
      record_type: "asset.acceptance",
      acceptance_id: acceptanceId,
      binding_id: bindingId,
      request_id: expectString(
        request.value,
        "request_id",
        "MaterializationRequest",
      ),
      candidate_id: expectString(
        candidate.value,
        "candidate_id",
        "AssetCandidate",
      ),
      subject_revision: expectInteger(
        request.value,
        "subject_revision",
        "MaterializationRequest",
      ),
      asset: expectProperty(candidate.value, "asset", "AssetCandidate"),
      review_id: expectString(review.value, "review_id", "ReviewReceipt"),
      accepted_at: this.#clock.now(),
      deterministic_context: deterministicContext.value,
    });
  }

  async #commitAcceptance(
    stored: StoredMaterializationReview,
  ): Promise<MaterializationAcceptanceResult> {
    const acceptance = stored.acceptance;
    if (acceptance === undefined) {
      throw new EngineFault(
        "materialization.ledger.database_corrupt",
        "Acceptance commit requires a persisted AssetAcceptance",
      );
    }
    const requestId = expectString(
      stored.request.value,
      "request_id",
      "MaterializationRequest",
    );
    const status = expectString(
      stored.request.value,
      "status",
      "MaterializationRequest",
    );
    if (status === "superseded") {
      return Object.freeze({
        branch: "superseded" as const,
        request: stored.request,
        acceptance,
      });
    }
    if (status !== "accepted") {
      throw new EngineFault(
        "materialization.acceptance.status_invalid",
        "AssetAcceptance can be committed only from accepted lifecycle state",
        {
          request_id: requestId,
          actual_status: status,
        },
      );
    }

    try {
      const result = await this.#mutations.commitAssetAcceptance({
        request: stored.request,
        acceptance,
      });
      return Object.freeze({
        branch: "bound" as const,
        acceptance,
        result,
      });
    } catch (error: unknown) {
      if (
        error instanceof EngineFault &&
        error.code === "world.packet.precondition_failed"
      ) {
        const superseded = await this.#ledger.markSuperseded(
          requestId,
          "accepted",
        );
        return Object.freeze({
          branch: "superseded" as const,
          request: superseded,
          acceptance,
        });
      }
      throw error;
    }
  }

  async #markFailedOrReportLifecycleConflict(
    requestId: string,
    expectedStatus: "generating" | "reviewing",
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.#ledger.markFailed(requestId, expectedStatus);
    } catch (lifecycleError: unknown) {
      throw new EngineFault(
        "materialization.lifecycle.persistence_failed",
        "Materialization failed and its terminal lifecycle state could not be persisted",
        {
          request_id: requestId,
          expected_status: expectedStatus,
          operation_error: describeError(originalError),
          lifecycle_error: describeError(lifecycleError),
        },
      );
    }
  }
}

function resolveRequestContent(
  catalog: ContentRuntimeCatalog,
  request: JsonObject,
  world: RuntimeWorldRecord,
) {
  const materializationProfile = readProfileRef(
    request,
    "materialization_profile",
  );
  const artProfile = readProfileRef(request, "art_profile");
  assertBundleLocked(world, materializationProfile);
  assertBundleLocked(world, artProfile);
  const content = catalog.resolveMaterializationContent(
    materializationProfile,
    artProfile,
  );
  if (content === undefined) {
    throw new EngineFault(
      "materialization.content.profile_missing",
      "MaterializationRequest profile refs do not resolve in the locked Content Runtime Catalog",
      {
        request_id: expectString(
          request,
          "request_id",
          "MaterializationRequest",
        ),
        materialization_bundle_id: materializationProfile.bundle_id,
        materialization_profile_id: materializationProfile.profile_id,
        art_bundle_id: artProfile.bundle_id,
        art_profile_id: artProfile.profile_id,
      },
    );
  }
  return content;
}

function readProfileRef(
  request: JsonObject,
  field: "materialization_profile" | "art_profile",
): {
  readonly bundle_id: string;
  readonly bundle_digest: string;
  readonly profile_id: string;
} {
  const profile = expectJsonObject(
    expectProperty(request, field, "MaterializationRequest"),
    `MaterializationRequest.${field}`,
  );
  return Object.freeze({
    bundle_id: expectString(profile, "bundle_id", "ProfileRef"),
    bundle_digest: expectString(profile, "bundle_digest", "ProfileRef"),
    profile_id: expectString(profile, "profile_id", "ProfileRef"),
  });
}

function assertBundleLocked(
  world: RuntimeWorldRecord,
  ref: {
    readonly bundle_id: string;
    readonly bundle_digest: string;
  },
): void {
  const rootLock = expectJsonObject(
    expectProperty(
      world.worldContentLock.value,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  const locks = [
    rootLock,
    ...world.dependencyBundleLocks.map((lock) => lock.value),
  ];
  if (
    !locks.some(
      (lock) =>
        expectString(lock, "pack_id", "PackLock") === ref.bundle_id &&
        expectString(lock, "bundle_digest", "PackLock") === ref.bundle_digest,
    )
  ) {
    throw new EngineFault(
      "materialization.content.bundle_not_locked",
      "MaterializationRequest profile bundle is not locked to the runtime world",
      {
        bundle_id: ref.bundle_id,
        bundle_digest: ref.bundle_digest,
      },
    );
  }
}

function assertAssetProviderDependency(dependency: JsonObject): void {
  if (
    expectString(dependency, "dependency_kind", "DependencyLock") !==
      "asset_provider" ||
    dependency.required !== true
  ) {
    throw new EngineFault(
      "materialization.content.provider_dependency_invalid",
      "MaterializationProfile must select a required asset_provider DependencyLock",
      {
        dependency_id: expectString(
          dependency,
          "dependency_id",
          "DependencyLock",
        ),
      },
    );
  }
}

function assertRequestFallback(
  request: JsonObject,
  fallbackAsset: JsonObject,
): void {
  if (
    !jsonEquals(
      expectProperty(request, "fallback", "MaterializationRequest"),
      expectProperty(fallbackAsset, "content", "PackAsset"),
    )
  ) {
    throw new EngineFault(
      "materialization.content.fallback_mismatch",
      "MaterializationRequest fallback must equal the selected profile's locked PackAsset content",
      {
        request_id: expectString(
          request,
          "request_id",
          "MaterializationRequest",
        ),
        fallback_asset_id: expectString(
          fallbackAsset,
          "asset_id",
          "PackAsset",
        ),
      },
    );
  }
}

function assertCandidateOutput(
  request: MaterializationRequestDocument,
  candidate: AssetCandidateDocument,
  providerPackageId: string,
): void {
  const requestValue = request.value;
  const candidateValue = candidate.value;
  if (
    expectString(candidateValue, "request_id", "AssetCandidate") !==
      expectString(
        requestValue,
        "request_id",
        "MaterializationRequest",
      ) ||
    expectInteger(candidateValue, "subject_revision", "AssetCandidate") !==
      expectInteger(
        requestValue,
        "subject_revision",
        "MaterializationRequest",
      ) ||
    expectString(
      candidateValue,
      "generation_spec_digest",
      "AssetCandidate",
    ) !==
      expectString(
        requestValue,
        "generation_spec_digest",
        "MaterializationRequest",
      )
  ) {
    throw new EngineFault(
      "materialization.provider.candidate_identity_mismatch",
      "AssetProvider output does not match the claimed MaterializationRequest",
      {
        request_id: expectString(
          requestValue,
          "request_id",
          "MaterializationRequest",
        ),
        candidate_id: expectString(
          candidateValue,
          "candidate_id",
          "AssetCandidate",
        ),
      },
    );
  }
  const provenance = expectJsonObject(
    expectProperty(candidateValue, "provenance", "AssetCandidate"),
    "AssetCandidate.provenance",
  );
  if (
    expectString(provenance, "origin_kind", "Provenance") !==
      "asset_provider" ||
    expectString(provenance, "origin_id", "Provenance") !== providerPackageId
  ) {
    throw new EngineFault(
      "materialization.provider.provenance_mismatch",
      "AssetCandidate provenance must name the exact locked AssetProvider",
      {
        expected_origin_kind: "asset_provider",
        expected_origin_id: providerPackageId,
      },
    );
  }
}

function assertReviewPolicy(
  materializationProfile: JsonObject,
  review: JsonObject,
): void {
  const policy = expectString(
    materializationProfile,
    "review_policy",
    "MaterializationProfile",
  );
  const expectedReviewerKind = policy === "automatic" ? "policy" : "human";
  const actualReviewerKind = expectString(
    review,
    "reviewer_kind",
    "ReviewReceipt",
  );
  if (actualReviewerKind !== expectedReviewerKind) {
    throw new EngineFault(
      "materialization.review.policy_mismatch",
      "ReviewReceipt reviewer_kind does not match MaterializationProfile.review_policy",
      {
        review_policy: policy,
        expected_reviewer_kind: expectedReviewerKind,
        actual_reviewer_kind: actualReviewerKind,
      },
    );
  }

  const verdict = expectString(review, "verdict", "ReviewReceipt");
  const checks = asObjectArray(
    expectProperty(review, "checks", "ReviewReceipt"),
    "ReviewReceipt.checks",
  );
  const failedChecks = checks.filter(
    (check) => expectString(check, "verdict", "ReviewCheck") === "fail",
  ).length;
  if (
    (verdict === "accepted" && failedChecks !== 0) ||
    (verdict === "rejected" && failedChecks === 0)
  ) {
    throw new EngineFault(
      "materialization.review.verdict_inconsistent",
      "ReviewReceipt verdict is inconsistent with its check verdicts",
      {
        verdict,
        failed_checks: failedChecks,
      },
    );
  }
}

function findCurrentSubject(
  request: JsonObject,
  snapshot: JsonObject,
): JsonObject | undefined {
  const worldId = expectString(snapshot, "world_id", "WorldSnapshot");
  const subjectRevision = expectInteger(
    request,
    "subject_revision",
    "MaterializationRequest",
  );
  const subject = expectJsonObject(
    expectProperty(request, "subject", "MaterializationRequest"),
    "MaterializationRequest.subject",
  );
  const worldState = expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const kind = expectString(subject, "kind", "SubjectRef");
  if (kind === "entity") {
    const entityRef = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    if (
      expectString(entityRef, "world_id", "EntityRef") !== worldId ||
      (entityRef.expected_revision !== undefined &&
        expectInteger(entityRef, "expected_revision", "EntityRef") !==
          subjectRevision)
    ) {
      return undefined;
    }
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    return asObjectArray(
      expectProperty(worldState, "entities", "WorldState"),
      "WorldState.entities",
    ).find(
      (entity) =>
        expectString(entity, "entity_id", "EntityState") === entityId &&
        expectInteger(entity, "revision", "EntityState") === subjectRevision &&
        expectString(entity, "state", "EntityState") === "active",
    );
  }
  if (kind === "definition") {
    const definitionRef = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (
      expectString(definitionRef, "kind", "DefinitionRef") !== "dynamic"
    ) {
      throw new EngineFault(
        "materialization.subject.immutable",
        "On-demand materialization can target only Entity or DynamicDefinition subjects",
        {
          request_id: expectString(
            request,
            "request_id",
            "MaterializationRequest",
          ),
        },
      );
    }
    if (
      expectString(
        definitionRef,
        "world_id",
        "DynamicDefinitionRef",
      ) !== worldId ||
      expectInteger(
        definitionRef,
        "revision",
        "DynamicDefinitionRef",
      ) !== subjectRevision
    ) {
      return undefined;
    }
    const definitionId = expectString(
      definitionRef,
      "definition_id",
      "DynamicDefinitionRef",
    );
    return asObjectArray(
      expectProperty(worldState, "dynamic_definitions", "WorldState"),
      "WorldState.dynamic_definitions",
    ).find(
      (definition) =>
        expectString(
          definition,
          "definition_id",
          "DynamicDefinitionState",
        ) === definitionId &&
        expectInteger(
          definition,
          "revision",
          "DynamicDefinitionState",
        ) === subjectRevision &&
        expectString(
          definition,
          "state",
          "DynamicDefinitionState",
        ) === "active",
    );
  }
  throw new EngineFault(
    "materialization.subject.kind_unsupported",
    "MaterializationRequest contains an unsupported subject kind",
    { subject_kind: kind },
  );
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "materialization.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
