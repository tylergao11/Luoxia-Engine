import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime/portable";
import type { AssetAcceptanceAuthorizationRecord } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

import type {
  AssetAcceptanceDocument,
  AssetCandidateDocument,
  MaterializationLedger,
  MaterializationRequestDocument,
  ReviewReceiptDocument,
  StoredMaterializationCandidate,
  StoredMaterializationReview,
} from "../../application/runtime-persistence.js";
import {
  assertUuid,
  requireAtMostOne,
  requireExactlyOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresMaterializationLedgerDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

export function createPostgresMaterializationLedger(
  dependencies: PostgresMaterializationLedgerDependencies,
): MaterializationLedger {
  return new PostgresMaterializationLedger(dependencies);
}

class PostgresMaterializationLedger implements MaterializationLedger {
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;

  public constructor(dependencies: PostgresMaterializationLedgerDependencies) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
  }

  public async claimNextPending(): Promise<
    MaterializationRequestDocument | undefined
  > {
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const query = await client.query<MaterializationRequestRow>(
          `${REQUEST_SELECT}
            WHERE request_document ->> 'status' = 'pending'
            ORDER BY inserted_at ASC, request_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        );
        const row = requireAtMostOne(
          query.rows,
          "materialization.ledger.database_corrupt",
          "Pending MaterializationRequest lookup returned more than one row",
          {},
        );
        if (row === undefined) {
          return undefined;
        }
        const request = validateRequestRow(this.#contracts, row);
        return updateRequestStatus(
          client,
          this.#contracts,
          request,
          "pending",
          "generating",
        );
      },
    );
  }

  public async markFailed(
    requestId: string,
    expectedStatus: "generating" | "reviewing",
  ): Promise<MaterializationRequestDocument> {
    const id = assertUuid(this.#contracts, requestId);
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const request = await readLockedRequest(client, this.#contracts, id);
        const status = expectString(
          request.value,
          "status",
          "MaterializationRequest",
        );
        if (status === "failed") {
          return request;
        }
        return updateRequestStatus(
          client,
          this.#contracts,
          request,
          expectedStatus,
          "failed",
        );
      },
    );
  }

  public async recordCandidate(
    requestId: string,
    candidate: AssetCandidateDocument,
  ): Promise<StoredMaterializationCandidate> {
    const id = assertUuid(this.#contracts, requestId);
    const verifiedCandidate = this.#contracts.assertObject(
      CONTRACT_REF.assetCandidate,
      candidate.value,
    );
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const request = await readLockedRequest(client, this.#contracts, id);
        assertCandidateMatchesRequest(request, verifiedCandidate);
        const existing = await readCandidateByRequestId(
          client,
          this.#contracts,
          id,
        );
        if (existing !== undefined) {
          if (!jsonEquals(existing.value, verifiedCandidate.value)) {
            throw new EngineFault(
              "materialization.ledger.candidate_conflict",
              "MaterializationRequest is already bound to a different AssetCandidate",
              { request_id: id },
            );
          }
          assertRequestStatus(request, "reviewing");
          return Object.freeze({ request, candidate: existing });
        }
        assertRequestStatus(request, "generating");
        await client.query(
          `INSERT INTO luoxia_engine.asset_candidates (
             candidate_id, request_id, candidate_document, inserted_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::jsonb, clock_timestamp()
           )`,
          [
            expectString(
              verifiedCandidate.value,
              "candidate_id",
              "AssetCandidate",
            ),
            id,
            JSON.stringify(verifiedCandidate.value),
          ],
        );
        const nextRequest = await updateRequestStatus(
          client,
          this.#contracts,
          request,
          "generating",
          "reviewing",
        );
        return Object.freeze({
          request: nextRequest,
          candidate: verifiedCandidate,
        });
      },
    );
  }

  public async readByCandidateId(
    candidateId: string,
  ): Promise<StoredMaterializationCandidate | undefined> {
    const id = assertUuid(this.#contracts, candidateId);
    return withPostgresClient(this.#pool, async (client) => {
      const query = await client.query<CandidateJoinRow>(
        `${CANDIDATE_JOIN_SELECT}
          WHERE candidate.candidate_id = $1::uuid`,
        [id],
      );
      const row = requireAtMostOne(
        query.rows,
        "materialization.ledger.database_corrupt",
        "AssetCandidate lookup returned more than one row",
        { candidate_id: id },
      );
      return row === undefined
        ? undefined
        : validateCandidateJoin(this.#contracts, row);
    });
  }

  public async recordReview(
    review: ReviewReceiptDocument,
    acceptance: AssetAcceptanceDocument | undefined,
  ): Promise<StoredMaterializationReview> {
    const verifiedReview = this.#contracts.assertObject(
      CONTRACT_REF.reviewReceipt,
      review.value,
    );
    const candidateId = expectString(
      verifiedReview.value,
      "candidate_id",
      "ReviewReceipt",
    );
    const verifiedAcceptance =
      acceptance === undefined
        ? undefined
        : this.#contracts.assertObject(
            CONTRACT_REF.assetAcceptance,
            acceptance.value,
          );

    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const base = await readLockedCandidateJoin(
          client,
          this.#contracts,
          candidateId,
        );
        const existing = await readReviewByCandidateId(
          client,
          this.#contracts,
          candidateId,
        );
        if (existing !== undefined) {
          if (!jsonEquals(existing.review.value, verifiedReview.value)) {
            throw new EngineFault(
              "materialization.ledger.review_conflict",
              "AssetCandidate is already bound to a different ReviewReceipt",
              { candidate_id: candidateId },
            );
          }
          const existingVerdict = expectString(
            existing.review.value,
            "verdict",
            "ReviewReceipt",
          );
          if (existingVerdict === "accepted") {
            if (existing.acceptance === undefined) {
              throw databaseCorrupt(
                "Accepted ReviewReceipt has no AssetAcceptance",
                { candidate_id: candidateId },
              );
            }
            assertAcceptanceRelationships(
              base.request,
              base.candidate,
              existing.review,
              existing.acceptance,
            );
          } else if (existing.acceptance !== undefined) {
            throw databaseCorrupt(
              "Rejected ReviewReceipt has an AssetAcceptance",
              { candidate_id: candidateId },
            );
          }
          return Object.freeze({
            ...base,
            review: existing.review,
            acceptance: existing.acceptance,
          });
        }

        assertRequestStatus(base.request, "reviewing");
        const verdict = expectString(
          verifiedReview.value,
          "verdict",
          "ReviewReceipt",
        );
        if (verdict === "accepted") {
          if (verifiedAcceptance === undefined) {
            throw new EngineFault(
              "materialization.ledger.acceptance_required",
              "An accepted ReviewReceipt must be recorded atomically with AssetAcceptance",
              { candidate_id: candidateId },
            );
          }
          assertAcceptanceRelationships(
            base.request,
            base.candidate,
            verifiedReview,
            verifiedAcceptance,
          );
        } else if (verifiedAcceptance !== undefined) {
          throw new EngineFault(
            "materialization.ledger.acceptance_for_rejection",
            "A rejected ReviewReceipt cannot carry AssetAcceptance",
            { candidate_id: candidateId },
          );
        }

        await client.query(
          `INSERT INTO luoxia_engine.asset_reviews (
             review_id, candidate_id, review_document, inserted_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::jsonb, clock_timestamp()
           )`,
          [
            expectString(verifiedReview.value, "review_id", "ReviewReceipt"),
            candidateId,
            JSON.stringify(verifiedReview.value),
          ],
        );
        if (verifiedAcceptance !== undefined) {
          await client.query(
            `INSERT INTO luoxia_engine.asset_acceptances (
               acceptance_id, binding_id, request_id, candidate_id, review_id,
               acceptance_document, inserted_at
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6::jsonb, clock_timestamp()
             )`,
            [
              expectString(
                verifiedAcceptance.value,
                "acceptance_id",
                "AssetAcceptance",
              ),
              expectString(
                verifiedAcceptance.value,
                "binding_id",
                "AssetAcceptance",
              ),
              expectString(
                verifiedAcceptance.value,
                "request_id",
                "AssetAcceptance",
              ),
              candidateId,
              expectString(
                verifiedAcceptance.value,
                "review_id",
                "AssetAcceptance",
              ),
              JSON.stringify(verifiedAcceptance.value),
            ],
          );
        }
        const nextRequest = await updateRequestStatus(
          client,
          this.#contracts,
          base.request,
          "reviewing",
          verdict === "accepted" ? "accepted" : "failed",
        );
        return Object.freeze({
          request: nextRequest,
          candidate: base.candidate,
          review: verifiedReview,
          acceptance: verifiedAcceptance,
        });
      },
    );
  }

  public async readAccepted(
    acceptanceId: string,
  ): Promise<StoredMaterializationReview | undefined> {
    const id = assertUuid(this.#contracts, acceptanceId);
    return withPostgresClient(this.#pool, async (client) => {
      const query = await client.query<AcceptanceJoinRow>(
        `${ACCEPTANCE_JOIN_SELECT}
          WHERE acceptance.acceptance_id = $1::uuid`,
        [id],
      );
      const row = requireAtMostOne(
        query.rows,
        "materialization.ledger.database_corrupt",
        "AssetAcceptance lookup returned more than one row",
        { acceptance_id: id },
      );
      return row === undefined
        ? undefined
        : validateAcceptanceJoin(this.#contracts, row);
    });
  }

  public async findByAcceptanceId(
    acceptanceId: string,
  ): Promise<AssetAcceptanceAuthorizationRecord | undefined> {
    const stored = await this.readAccepted(acceptanceId);
    if (stored === undefined || stored.acceptance === undefined) {
      return undefined;
    }
    return Object.freeze({
      request: stored.request.value,
      candidate: stored.candidate.value,
      review: stored.review.value,
      acceptance: stored.acceptance.value,
    });
  }

  public async markSuperseded(
    requestId: string,
    expectedStatus: "generating" | "reviewing" | "accepted",
  ): Promise<MaterializationRequestDocument> {
    const id = assertUuid(this.#contracts, requestId);
    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      async (client) => {
        const request = await readLockedRequest(client, this.#contracts, id);
        const status = expectString(
          request.value,
          "status",
          "MaterializationRequest",
        );
        if (status === "superseded") {
          return request;
        }
        return updateRequestStatus(
          client,
          this.#contracts,
          request,
          expectedStatus,
          "superseded",
        );
      },
    );
  }
}

interface MaterializationRequestRow {
  readonly request_id: string;
  readonly world_id: string;
  readonly request_document: unknown;
}

interface AssetCandidateRow {
  readonly candidate_id: string;
  readonly candidate_request_id: string;
  readonly candidate_document: unknown;
}

interface AssetReviewRow {
  readonly review_id: string;
  readonly review_candidate_id: string;
  readonly review_document: unknown;
}

interface AssetAcceptanceRow {
  readonly acceptance_id: string;
  readonly binding_id: string;
  readonly acceptance_request_id: string;
  readonly acceptance_candidate_id: string;
  readonly acceptance_review_id: string;
  readonly acceptance_document: unknown;
}

interface CandidateJoinRow
  extends MaterializationRequestRow,
    AssetCandidateRow {}

interface AcceptanceJoinRow
  extends CandidateJoinRow,
    AssetReviewRow,
    AssetAcceptanceRow {}

const REQUEST_SELECT = `SELECT
  request_id::text AS request_id,
  world_id::text AS world_id,
  request_document
FROM luoxia_engine.materialization_requests`;

const CANDIDATE_JOIN_SELECT = `SELECT
  request.request_id::text AS request_id,
  request.world_id::text AS world_id,
  request.request_document,
  candidate.candidate_id::text AS candidate_id,
  candidate.request_id::text AS candidate_request_id,
  candidate.candidate_document
FROM luoxia_engine.asset_candidates AS candidate
JOIN luoxia_engine.materialization_requests AS request
  ON request.request_id = candidate.request_id`;

const ACCEPTANCE_JOIN_SELECT = `SELECT
  request.request_id::text AS request_id,
  request.world_id::text AS world_id,
  request.request_document,
  candidate.candidate_id::text AS candidate_id,
  candidate.request_id::text AS candidate_request_id,
  candidate.candidate_document,
  review.review_id::text AS review_id,
  review.candidate_id::text AS review_candidate_id,
  review.review_document,
  acceptance.acceptance_id::text AS acceptance_id,
  acceptance.binding_id::text AS binding_id,
  acceptance.request_id::text AS acceptance_request_id,
  acceptance.candidate_id::text AS acceptance_candidate_id,
  acceptance.review_id::text AS acceptance_review_id,
  acceptance.acceptance_document
FROM luoxia_engine.asset_acceptances AS acceptance
JOIN luoxia_engine.materialization_requests AS request
  ON request.request_id = acceptance.request_id
JOIN luoxia_engine.asset_candidates AS candidate
  ON candidate.candidate_id = acceptance.candidate_id
 AND candidate.request_id = acceptance.request_id
JOIN luoxia_engine.asset_reviews AS review
  ON review.review_id = acceptance.review_id
 AND review.candidate_id = acceptance.candidate_id`;

async function readLockedRequest(
  client: PoolClient,
  contracts: ContractValidator,
  requestId: string,
): Promise<MaterializationRequestDocument> {
  const query = await client.query<MaterializationRequestRow>(
    `${REQUEST_SELECT}
      WHERE request_id = $1::uuid
      FOR UPDATE`,
    [requestId],
  );
  const row = requireExactlyOne(
    query.rows,
    "materialization.ledger.request_missing",
    "MaterializationRequest lookup did not return exactly one row",
    { request_id: requestId },
  );
  return validateRequestRow(contracts, row);
}

async function readCandidateByRequestId(
  client: PoolClient,
  contracts: ContractValidator,
  requestId: string,
): Promise<AssetCandidateDocument | undefined> {
  const query = await client.query<AssetCandidateRow>(
    `SELECT candidate_id::text AS candidate_id,
            request_id::text AS candidate_request_id,
            candidate_document
       FROM luoxia_engine.asset_candidates
      WHERE request_id = $1::uuid`,
    [requestId],
  );
  const row = requireAtMostOne(
    query.rows,
    "materialization.ledger.database_corrupt",
    "MaterializationRequest has more than one AssetCandidate",
    { request_id: requestId },
  );
  return row === undefined ? undefined : validateCandidateRow(contracts, row);
}

async function readLockedCandidateJoin(
  client: PoolClient,
  contracts: ContractValidator,
  candidateId: string,
): Promise<StoredMaterializationCandidate> {
  const query = await client.query<CandidateJoinRow>(
    `${CANDIDATE_JOIN_SELECT}
      WHERE candidate.candidate_id = $1::uuid
      FOR UPDATE OF request, candidate`,
    [candidateId],
  );
  const row = requireExactlyOne(
    query.rows,
    "materialization.ledger.candidate_missing",
    "AssetCandidate lookup did not return exactly one row",
    { candidate_id: candidateId },
  );
  return validateCandidateJoin(contracts, row);
}

async function readReviewByCandidateId(
  client: PoolClient,
  contracts: ContractValidator,
  candidateId: string,
): Promise<
  | {
      readonly review: ReviewReceiptDocument;
      readonly acceptance: AssetAcceptanceDocument | undefined;
    }
  | undefined
> {
  const query = await client.query<
    AssetReviewRow & Partial<AssetAcceptanceRow>
  >(
    `SELECT
       review.review_id::text AS review_id,
       review.candidate_id::text AS review_candidate_id,
       review.review_document,
       acceptance.acceptance_id::text AS acceptance_id,
       acceptance.binding_id::text AS binding_id,
       acceptance.request_id::text AS acceptance_request_id,
       acceptance.candidate_id::text AS acceptance_candidate_id,
       acceptance.review_id::text AS acceptance_review_id,
       acceptance.acceptance_document
     FROM luoxia_engine.asset_reviews AS review
     LEFT JOIN luoxia_engine.asset_acceptances AS acceptance
       ON acceptance.review_id = review.review_id
      AND acceptance.candidate_id = review.candidate_id
     WHERE review.candidate_id = $1::uuid`,
    [candidateId],
  );
  const row = requireAtMostOne(
    query.rows,
    "materialization.ledger.database_corrupt",
    "AssetCandidate has more than one ReviewReceipt",
    { candidate_id: candidateId },
  );
  if (row === undefined) {
    return undefined;
  }
  const review = validateReviewRow(contracts, row);
  if (row.acceptance_document === null || row.acceptance_document === undefined) {
    if (expectString(review.value, "verdict", "ReviewReceipt") === "accepted") {
      throw databaseCorrupt(
        "Accepted ReviewReceipt has no AssetAcceptance",
        { candidate_id: candidateId },
      );
    }
    return Object.freeze({ review, acceptance: undefined });
  }
  if (expectString(review.value, "verdict", "ReviewReceipt") !== "accepted") {
    throw databaseCorrupt(
      "Rejected ReviewReceipt has an AssetAcceptance",
      { candidate_id: candidateId },
    );
  }
  return Object.freeze({
    review,
    acceptance: validateAcceptanceRow(contracts, row as AssetAcceptanceRow),
  });
}

function validateRequestRow(
  contracts: ContractValidator,
  row: MaterializationRequestRow,
): MaterializationRequestDocument {
  const request = contracts.assertObject(
    CONTRACT_REF.materializationRequest,
    row.request_document,
  );
  if (
    expectString(request.value, "request_id", "MaterializationRequest") !==
      row.request_id ||
    expectString(request.value, "world_id", "MaterializationRequest") !==
      row.world_id
  ) {
    throw databaseCorrupt("MaterializationRequest columns differ from document", {
      request_id: row.request_id,
      world_id: row.world_id,
    });
  }
  return request;
}

function validateCandidateRow(
  contracts: ContractValidator,
  row: AssetCandidateRow,
): AssetCandidateDocument {
  const candidate = contracts.assertObject(
    CONTRACT_REF.assetCandidate,
    row.candidate_document,
  );
  if (
    expectString(candidate.value, "candidate_id", "AssetCandidate") !==
      row.candidate_id ||
    expectString(candidate.value, "request_id", "AssetCandidate") !==
      row.candidate_request_id
  ) {
    throw databaseCorrupt("AssetCandidate columns differ from document", {
      candidate_id: row.candidate_id,
      request_id: row.candidate_request_id,
    });
  }
  return candidate;
}

function validateReviewRow(
  contracts: ContractValidator,
  row: AssetReviewRow,
): ReviewReceiptDocument {
  const review = contracts.assertObject(
    CONTRACT_REF.reviewReceipt,
    row.review_document,
  );
  if (
    expectString(review.value, "review_id", "ReviewReceipt") !== row.review_id ||
    expectString(review.value, "candidate_id", "ReviewReceipt") !==
      row.review_candidate_id
  ) {
    throw databaseCorrupt("ReviewReceipt columns differ from document", {
      review_id: row.review_id,
      candidate_id: row.review_candidate_id,
    });
  }
  return review;
}

function validateAcceptanceRow(
  contracts: ContractValidator,
  row: AssetAcceptanceRow,
): AssetAcceptanceDocument {
  const acceptance = contracts.assertObject(
    CONTRACT_REF.assetAcceptance,
    row.acceptance_document,
  );
  if (
    expectString(acceptance.value, "acceptance_id", "AssetAcceptance") !==
      row.acceptance_id ||
    expectString(acceptance.value, "binding_id", "AssetAcceptance") !==
      row.binding_id ||
    expectString(acceptance.value, "request_id", "AssetAcceptance") !==
      row.acceptance_request_id ||
    expectString(acceptance.value, "candidate_id", "AssetAcceptance") !==
      row.acceptance_candidate_id ||
    expectString(acceptance.value, "review_id", "AssetAcceptance") !==
      row.acceptance_review_id
  ) {
    throw databaseCorrupt("AssetAcceptance columns differ from document", {
      acceptance_id: row.acceptance_id,
    });
  }
  return acceptance;
}

function validateCandidateJoin(
  contracts: ContractValidator,
  row: CandidateJoinRow,
): StoredMaterializationCandidate {
  const request = validateRequestRow(contracts, row);
  const candidate = validateCandidateRow(contracts, row);
  assertCandidateMatchesRequest(request, candidate);
  return Object.freeze({ request, candidate });
}

function validateAcceptanceJoin(
  contracts: ContractValidator,
  row: AcceptanceJoinRow,
): StoredMaterializationReview {
  const base = validateCandidateJoin(contracts, row);
  const review = validateReviewRow(contracts, row);
  const acceptance = validateAcceptanceRow(contracts, row);
  assertAcceptanceRelationships(
    base.request,
    base.candidate,
    review,
    acceptance,
  );
  return Object.freeze({ ...base, review, acceptance });
}

function assertCandidateMatchesRequest(
  request: MaterializationRequestDocument,
  candidate: AssetCandidateDocument,
): void {
  if (
    expectString(candidate.value, "request_id", "AssetCandidate") !==
      expectString(request.value, "request_id", "MaterializationRequest") ||
    expectInteger(candidate.value, "subject_revision", "AssetCandidate") !==
      expectInteger(
        request.value,
        "subject_revision",
        "MaterializationRequest",
      ) ||
    expectString(
      candidate.value,
      "generation_spec_digest",
      "AssetCandidate",
    ) !==
      expectString(
        request.value,
        "generation_spec_digest",
        "MaterializationRequest",
      )
  ) {
    throw new EngineFault(
      "materialization.ledger.candidate_identity_mismatch",
      "AssetCandidate does not match its MaterializationRequest",
      {
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
      },
    );
  }
}

function assertAcceptanceRelationships(
  request: MaterializationRequestDocument,
  candidate: AssetCandidateDocument,
  review: ReviewReceiptDocument,
  acceptance: AssetAcceptanceDocument,
): void {
  const requestId = expectString(
    request.value,
    "request_id",
    "MaterializationRequest",
  );
  const candidateId = expectString(
    candidate.value,
    "candidate_id",
    "AssetCandidate",
  );
  const reviewId = expectString(review.value, "review_id", "ReviewReceipt");
  if (
    expectString(review.value, "candidate_id", "ReviewReceipt") !==
      candidateId ||
    expectString(review.value, "verdict", "ReviewReceipt") !== "accepted" ||
    expectString(acceptance.value, "request_id", "AssetAcceptance") !==
      requestId ||
    expectString(acceptance.value, "candidate_id", "AssetAcceptance") !==
      candidateId ||
    expectString(acceptance.value, "review_id", "AssetAcceptance") !==
      reviewId ||
    expectInteger(
      acceptance.value,
      "subject_revision",
      "AssetAcceptance",
    ) !== expectInteger(candidate.value, "subject_revision", "AssetCandidate") ||
    !jsonEquals(
      expectProperty(acceptance.value, "asset", "AssetAcceptance"),
      expectProperty(candidate.value, "asset", "AssetCandidate"),
    )
  ) {
    throw new EngineFault(
      "materialization.ledger.acceptance_identity_mismatch",
      "AssetAcceptance does not match its Request, Candidate, and accepted ReviewReceipt",
      {
        acceptance_id: expectString(
          acceptance.value,
          "acceptance_id",
          "AssetAcceptance",
        ),
        request_id: requestId,
        candidate_id: candidateId,
        review_id: reviewId,
      },
    );
  }
}

function assertRequestStatus(
  request: MaterializationRequestDocument,
  expected: string,
): void {
  const actual = expectString(
    request.value,
    "status",
    "MaterializationRequest",
  );
  if (actual !== expected) {
    throw new EngineFault(
      "materialization.ledger.status_conflict",
      "MaterializationRequest is not at the required lifecycle status",
      {
        request_id: expectString(
          request.value,
          "request_id",
          "MaterializationRequest",
        ),
        expected_status: expected,
        actual_status: actual,
      },
    );
  }
}

async function updateRequestStatus(
  client: PoolClient,
  contracts: ContractValidator,
  request: MaterializationRequestDocument,
  expectedStatus: string,
  nextStatus: string,
): Promise<MaterializationRequestDocument> {
  assertRequestStatus(request, expectedStatus);
  const next = contracts.assertObject(CONTRACT_REF.materializationRequest, {
    ...request.value,
    status: nextStatus,
  });
  const requestId = expectString(
    request.value,
    "request_id",
    "MaterializationRequest",
  );
  const update = await client.query(
    `UPDATE luoxia_engine.materialization_requests
        SET request_document = $2::jsonb,
            updated_at = clock_timestamp()
      WHERE request_id = $1::uuid`,
    [requestId, JSON.stringify(next.value)],
  );
  if (update.rowCount !== 1) {
    throw databaseCorrupt(
      "MaterializationRequest status update did not affect exactly one row",
      { request_id: requestId },
    );
  }
  return next;
}

function databaseCorrupt(message: string, details: JsonObject): EngineFault {
  return new EngineFault(
    "materialization.ledger.database_corrupt",
    message,
    details,
  );
}
