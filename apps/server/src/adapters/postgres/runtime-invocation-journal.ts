import { randomUUID } from "node:crypto";

import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonObject,
} from "@luoxia/contracts-runtime/portable";
import type { Pool, PoolClient } from "pg";

import type {
  ModelDispatchAuthorizationIssuer,
  ModelRecoveryAuthorizationIssuer,
} from "../../application/model-dispatch-authorization.js";
import {
  type ModelInvocationProvenanceVerifier,
  type ModelRequestDocument,
  type ModelResponseDocument,
  type ProviderUsageObservation,
  type PreparedModelInvocation,
  type VerifiedModelInvocationReceipt,
  type VerifiedModelOutputDocument,
  type WorldSnapshotDocument,
} from "../../application/model-gateway.js";
import type {
  AuthorizedModelDispatch,
  DailySettlementProposalIdentity,
  DailySettlementRunRecord,
  RecordedModelInvocationVerifier,
  RuntimeModelInvocationJournal,
  StoredAmbiguousModelInvocation,
  StoredFailedDefiniteModelInvocation,
  StoredModelInvocation,
  StoredVerifiedModelInvocation,
} from "../../application/runtime-persistence.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  requireExactlyOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

const DAILY_REQUEST_KIND = "director.daily_settlement";

export interface PostgresRuntimeInvocationJournalDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly dispatchIssuer: ModelDispatchAuthorizationIssuer;
  readonly recoveryIssuer: ModelRecoveryAuthorizationIssuer;
  readonly modelProvenance: ModelInvocationProvenanceVerifier;
  readonly recordedInvocationVerifier: RecordedModelInvocationVerifier;
}

export interface PostgresRuntimeInvocationJournal
  extends RuntimeModelInvocationJournal {}

export function createPostgresRuntimeInvocationJournal(
  dependencies: PostgresRuntimeInvocationJournalDependencies,
): PostgresRuntimeInvocationJournal {
  return new PostgresRuntimeInvocationJournalAdapter(dependencies);
}

class PostgresRuntimeInvocationJournalAdapter
  implements PostgresRuntimeInvocationJournal
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #dispatchIssuer: ModelDispatchAuthorizationIssuer;
  readonly #recoveryIssuer: ModelRecoveryAuthorizationIssuer;
  readonly #modelProvenance: ModelInvocationProvenanceVerifier;
  readonly #recordedInvocationVerifier: RecordedModelInvocationVerifier;

  public constructor(
    dependencies: PostgresRuntimeInvocationJournalDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#dispatchIssuer = dependencies.dispatchIssuer;
    this.#recoveryIssuer = dependencies.recoveryIssuer;
    this.#modelProvenance = dependencies.modelProvenance;
    this.#recordedInvocationVerifier =
      dependencies.recordedInvocationVerifier;
  }

  public async persistPrepared(
    invocation: PreparedModelInvocation,
  ): Promise<StoredModelInvocation> {
    assertPrepared(this.#modelProvenance, invocation);
    assertGenericInvocationKind(invocation.request);
    const documents = validatePreparedDocuments(this.#contracts, invocation);
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const requestId = expectString(
            documents.request.value,
            "request_id",
            "ModelRequest",
          );
          const existing = await readOptionalModelInvocationByRequestIdLocked(
            client,
            this.#contracts,
            requestId,
          );
          if (existing !== undefined) {
            assertInvocationMatchesPrepared(existing, invocation);
            return existing;
          }
          await assertCurrentWorldSnapshot(
            client,
            documents.snapshot,
            invocation.worldId,
            invocation.worldRevision,
          );
          return insertOrMatchPreparedInvocation(
            client,
            this.#contracts,
            documents.snapshot,
            documents.request,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async markDispatched(
    invocation: PreparedModelInvocation,
  ): Promise<AuthorizedModelDispatch> {
    assertPrepared(this.#modelProvenance, invocation);
    validatePreparedDocuments(this.#contracts, invocation);
    let stored: StoredAmbiguousModelInvocation;
    try {
      stored = await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const requestId = expectString(
            invocation.request.value,
            "request_id",
            "ModelRequest",
          );
          const run =
            expectString(
              invocation.request.value,
              "request_kind",
              "ModelRequest",
            ) === DAILY_REQUEST_KIND
              ? await readDailyRunByModelRequestIdLocked(
                  client,
                  this.#contracts,
                  requestId,
                )
              : undefined;
          const current =
            run?.invocation ??
            (await readModelInvocationByRequestIdLocked(
              client,
              this.#contracts,
              requestId,
            ));
          if (run === undefined) {
            assertInvocationMatchesPrepared(current, invocation);
          } else {
            assertRunMatchesPrepared(run, invocation);
          }
          return markPreparedInvocationDispatched(
            client,
            this.#contracts,
            current,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }

    return Object.freeze({
      invocation: stored,
      authorization: this.#dispatchIssuer.issue(invocation),
    });
  }

  public async recordVerified(
    receipt: VerifiedModelInvocationReceipt,
    usage: ProviderUsageObservation,
  ): Promise<StoredVerifiedModelInvocation> {
    assertVerified(this.#modelProvenance, receipt);
    const documents = validateVerifiedDocuments(this.#contracts, receipt);
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const requestId = expectString(
            receipt.request.value,
            "request_id",
            "ModelRequest",
          );
          const requestKind = expectString(
            receipt.request.value,
            "request_kind",
            "ModelRequest",
          );
          const run =
            requestKind === DAILY_REQUEST_KIND
              ? await readDailyRunByModelRequestIdLocked(
                  client,
                  this.#contracts,
                  requestId,
                )
              : undefined;
          const current =
            run?.invocation ??
            (await readModelInvocationByRequestIdLocked(
              client,
              this.#contracts,
              requestId,
            ));
          if (run === undefined) {
            assertInvocationMatchesVerified(current, receipt);
          } else {
            assertRunMatchesVerified(run, receipt);
          }
          return persistVerifiedInvocation(
            client,
            this.#contracts,
            current,
            documents,
            usage,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async recordFailedDefinite(input: {
    readonly requestId: string;
    readonly failureCode: string;
    readonly outputSummary: JsonObject;
  }): Promise<StoredFailedDefiniteModelInvocation> {
    const verifiedRequestId = assertUuid(this.#contracts, input.requestId);
    assertFailureCode(input.failureCode, verifiedRequestId);
    const outputSummary = expectJsonObject(
      input.outputSummary,
      "ModelInvocation.failure_output_summary",
    );
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const current = await readModelInvocationByRequestIdLocked(
            client,
            this.#contracts,
            verifiedRequestId,
          );
          return persistFailedDefiniteInvocation(
            client,
            this.#contracts,
            current,
            input.failureCode,
            outputSummary,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async prepareDirectorInvocation(
    invocation: PreparedModelInvocation,
  ): Promise<DailySettlementRunRecord> {
    assertPrepared(this.#modelProvenance, invocation);
    const documents = validatePreparedDocuments(this.#contracts, invocation);
    const day = extractDailySettlementDay(
      documents.request.value,
      documents.snapshot.value,
    );

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const existingRun = await readDailyRunByWorldDayLocked(
            client,
            this.#contracts,
            invocation.worldId,
            day,
          );
          if (existingRun !== undefined) {
            assertRunMatchesPrepared(existingRun, invocation);
            return existingRun;
          }
          await assertCurrentWorldSnapshot(
            client,
            documents.snapshot,
            invocation.worldId,
            invocation.worldRevision,
          );
          const storedInvocation = await insertOrMatchPreparedInvocation(
            client,
            this.#contracts,
            documents.snapshot,
            documents.request,
          );

          await client.query(
            `INSERT INTO luoxia_engine.daily_settlement_runs (
               world_id,
               day,
               model_request_id,
               request_kind,
               created_at
             ) VALUES (
               $1::uuid,
               $2::bigint,
               $3::uuid,
               $4,
               clock_timestamp()
             )
             ON CONFLICT DO NOTHING`,
            [
              invocation.worldId,
              day.toString(),
              storedInvocation.requestId,
              DAILY_REQUEST_KIND,
            ],
          );
          const existing = await readDailyRunByWorldDayLocked(
            client,
            this.#contracts,
            invocation.worldId,
            day,
          );
          if (existing === undefined) {
            throw new EngineFault(
              "runtime.daily_settlement.identity_conflict",
              "Daily settlement run identity conflicts with another run",
              {
                world_id: invocation.worldId,
                day,
                request_id: storedInvocation.requestId,
              },
            );
          }
          assertRunMatchesPrepared(existing, invocation);
          return existing;
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async read(
    worldId: string,
    day: number,
  ): Promise<DailySettlementRunRecord | undefined> {
    const verifiedWorldId = assertUuid(this.#contracts, worldId);
    assertSafeDay(day, verifiedWorldId);
    try {
      return await withPostgresClient(this.#pool, (client) =>
        readDailyRunByWorldDay(
          client,
          this.#contracts,
          verifiedWorldId,
          day,
        ),
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async prepareDailyProposals(
    modelRequestId: string,
  ): Promise<readonly DailySettlementProposalIdentity[]> {
    const verifiedModelRequestId = assertUuid(
      this.#contracts,
      modelRequestId,
    );
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const run = await readDailyRunByModelRequestIdLocked(
            client,
            this.#contracts,
            verifiedModelRequestId,
          );
          if (run.phase !== "response_verified") {
            throw new EngineFault(
              "runtime.daily_settlement.response_not_verified",
              "Daily proposal identities require a verified Director response",
              {
                model_request_id: verifiedModelRequestId,
                phase: run.phase,
              },
            );
          }
          const verifiedProposalCount =
            extractVerifiedDailyProposalCount(run);

          const existing = await readDailyProposalIdentities(
            client,
            verifiedModelRequestId,
          );
          if (existing.length > 0 || verifiedProposalCount === 0) {
            return validateDailyProposalIdentities(
              this.#contracts,
              existing,
              verifiedModelRequestId,
              verifiedProposalCount,
            );
          }

          for (
            let ordinal = 0;
            ordinal < verifiedProposalCount;
            ordinal += 1
          ) {
            const proposalId = assertUuid(
              this.#contracts,
              randomUUID(),
            );
            const insert = await client.query(
              `INSERT INTO luoxia_engine.daily_settlement_proposal_runs (
                 model_request_id,
                 proposal_ordinal,
                 proposal_id
               ) VALUES (
                 $1::uuid,
                 $2::integer,
                 $3::uuid
               )`,
              [
                verifiedModelRequestId,
                ordinal,
                proposalId,
              ],
            );
            if (insert.rowCount !== 1) {
              throw new EngineFault(
                "runtime.daily_settlement.database_corrupt",
                "Daily proposal identity INSERT did not affect exactly one row",
                {
                  model_request_id: verifiedModelRequestId,
                  proposal_ordinal: ordinal,
                },
              );
            }
          }

          return validateDailyProposalIdentities(
            this.#contracts,
            await readDailyProposalIdentities(
              client,
              verifiedModelRequestId,
            ),
            verifiedModelRequestId,
            verifiedProposalCount,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async readByRequestId(
    requestId: string,
  ): Promise<StoredModelInvocation | undefined> {
    const verifiedRequestId = assertUuid(this.#contracts, requestId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const query = await client.query<ModelInvocationRow>(
          `${MODEL_INVOCATION_SELECT}
            WHERE request_id = $1::uuid`,
          [verifiedRequestId],
        );
        const row = requireAtMostOne(
          query.rows,
          "model.invocation.database_corrupt",
          "request_id lookup returned more than one model invocation",
          { request_id: verifiedRequestId },
        );
        return row === undefined
          ? undefined
          : validateModelInvocationRow(this.#contracts, row);
      });
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }
  }

  public async recoverVerifiedByRequestId(
    requestId: string,
  ): Promise<VerifiedModelInvocationReceipt | undefined> {
    const stored = await this.readByRequestId(requestId);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.phase !== "verified") {
      throw new EngineFault(
        "model.invocation.not_verified",
        "Stored model invocation has no durable verified response",
        { request_id: requestId, phase: stored.phase },
      );
    }
    const authorization = this.#recoveryIssuer.issue(
      Object.freeze({
        snapshot: stored.snapshot.value,
        request: stored.request.value,
        response: stored.response.value,
        proof: stored.proof.value,
      }),
    );
    return this.#recordedInvocationVerifier.verifyRecorded(authorization);
  }
}

interface PreparedDocuments {
  readonly snapshot: WorldSnapshotDocument;
  readonly request: ModelRequestDocument;
}

interface ModelInvocationDocumentIdentity {
  readonly worldId: string;
  readonly worldRevision: number;
  readonly snapshot: WorldSnapshotDocument;
  readonly request: ModelRequestDocument;
}

interface VerifiedDocuments extends PreparedDocuments {
  readonly response: ModelResponseDocument;
  readonly proof: VerifiedModelOutputDocument;
}

interface WorldStorageRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
}

interface ModelInvocationRow {
  readonly request_id: string;
  readonly world_id: string;
  readonly world_revision_text: string;
  readonly request_kind: string;
  readonly invocation_status: string;
  readonly snapshot_document: unknown;
  readonly request_document: unknown;
  readonly response_document: unknown | null;
  readonly proof_document: unknown | null;
  readonly provider_kind: string | null;
  readonly provider_model: string | null;
  readonly token_usage_status: string | null;
  readonly input_tokens_text: string | null;
  readonly cached_input_tokens_text: string | null;
  readonly output_tokens_text: string | null;
  readonly failure_code: string | null;
  readonly failure_output_summary: unknown | null;
}

interface DailySettlementRunRow extends ModelInvocationRow {
  readonly run_world_id: string;
  readonly day_text: string;
  readonly model_request_id: string;
  readonly run_request_kind: string;
}

interface DailySettlementProposalIdentityRow {
  readonly proposal_ordinal: number;
  readonly proposal_id: string;
}

const MODEL_INVOCATION_SELECT = `SELECT
  request_id::text AS request_id,
  world_id::text AS world_id,
  world_revision::text AS world_revision_text,
  request_kind,
  invocation_status,
  snapshot_document,
  request_document,
  response_document,
  proof_document,
  provider_kind,
  provider_model,
  token_usage_status,
  input_tokens::text AS input_tokens_text,
  cached_input_tokens::text AS cached_input_tokens_text,
  output_tokens::text AS output_tokens_text,
  failure_code,
  failure_output_summary
FROM luoxia_engine.model_invocations`;

const DAILY_RUN_SELECT = `SELECT
  run.world_id::text AS run_world_id,
  run.day::text AS day_text,
  run.model_request_id::text AS model_request_id,
  run.request_kind AS run_request_kind,
  invocation.request_id::text AS request_id,
  invocation.world_id::text AS world_id,
  invocation.world_revision::text AS world_revision_text,
  invocation.request_kind,
  invocation.invocation_status,
  invocation.snapshot_document,
  invocation.request_document,
  invocation.response_document,
  invocation.proof_document,
  invocation.provider_kind,
  invocation.provider_model,
  invocation.token_usage_status,
  invocation.input_tokens::text AS input_tokens_text,
  invocation.cached_input_tokens::text AS cached_input_tokens_text,
  invocation.output_tokens::text AS output_tokens_text,
  invocation.failure_code,
  invocation.failure_output_summary
FROM luoxia_engine.daily_settlement_runs AS run
JOIN luoxia_engine.model_invocations AS invocation
  ON invocation.request_id = run.model_request_id
 AND invocation.world_id = run.world_id
 AND invocation.request_kind = run.request_kind`;

async function insertOrMatchPreparedInvocation(
  client: PoolClient,
  contracts: ContractValidator,
  snapshot: WorldSnapshotDocument,
  request: ModelRequestDocument,
): Promise<StoredModelInvocation> {
  const worldId = expectString(snapshot.value, "world_id", "WorldSnapshot");
  const worldRevision = expectInteger(
    snapshot.value,
    "world_revision",
    "WorldSnapshot",
  );
  const requestId = expectString(request.value, "request_id", "ModelRequest");
  const requestKind = expectString(
    request.value,
    "request_kind",
    "ModelRequest",
  );
  await client.query(
    `INSERT INTO luoxia_engine.model_invocations (
       request_id,
       world_id,
       world_revision,
       request_kind,
       invocation_status,
       snapshot_document,
       request_document,
       response_document,
       proof_document,
       provider_kind,
       provider_model,
       token_usage_status,
       input_tokens,
       cached_input_tokens,
       output_tokens,
       failure_code,
       failure_output_summary,
       prepared_at,
       dispatched_at,
       failed_at,
       verified_at
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::bigint,
       $4,
       'prepared',
       $5::jsonb,
       $6::jsonb,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       NULL,
       clock_timestamp(),
       NULL,
       NULL,
       NULL
     )
     ON CONFLICT DO NOTHING`,
    [
      requestId,
      worldId,
      worldRevision.toString(),
      requestKind,
      JSON.stringify(snapshot.value),
      JSON.stringify(request.value),
    ],
  );

  const query = await client.query<ModelInvocationRow>(
    `${MODEL_INVOCATION_SELECT}
      WHERE request_id = $1::uuid
      FOR UPDATE`,
    [requestId],
  );
  const row = requireExactlyOne(
    query.rows,
    "model.invocation.database_corrupt",
    "Prepared model invocation could not be read after persistence",
    { request_id: requestId },
  );
  const stored = validateModelInvocationRow(contracts, row);
  if (
    stored.worldId !== worldId ||
    stored.worldRevision !== worldRevision ||
    stored.requestKind !== requestKind ||
    !jsonEquals(stored.snapshot.value, snapshot.value) ||
    !jsonEquals(stored.request.value, request.value)
  ) {
    throw new EngineFault(
      "model.invocation.identity_conflict",
      "request_id is already bound to a different prepared invocation",
      { request_id: requestId },
    );
  }
  return stored;
}

async function readModelInvocationByRequestIdLocked(
  client: PoolClient,
  contracts: ContractValidator,
  requestId: string,
): Promise<StoredModelInvocation> {
  const stored = await readOptionalModelInvocationByRequestIdLocked(
    client,
    contracts,
    requestId,
  );
  if (stored === undefined) {
    throw new EngineFault(
      "model.invocation.missing",
      "Prepared model invocation does not exist",
      { request_id: requestId },
    );
  }
  return stored;
}

async function readOptionalModelInvocationByRequestIdLocked(
  client: PoolClient,
  contracts: ContractValidator,
  requestId: string,
): Promise<StoredModelInvocation | undefined> {
  const query = await client.query<ModelInvocationRow>(
    `${MODEL_INVOCATION_SELECT}
      WHERE request_id = $1::uuid
      FOR UPDATE`,
    [requestId],
  );
  const row = requireAtMostOne(
    query.rows,
    "model.invocation.database_corrupt",
    "request_id lookup returned more than one model invocation",
    { request_id: requestId },
  );
  return row === undefined
    ? undefined
    : validateModelInvocationRow(contracts, row);
}

async function markPreparedInvocationDispatched(
  client: PoolClient,
  contracts: ContractValidator,
  current: StoredModelInvocation,
): Promise<StoredAmbiguousModelInvocation> {
  if (
    current.phase !== "prepared" &&
    current.phase !== "failed_definite"
  ) {
    throw new EngineFault(
      "model.invocation.dispatch_forbidden",
      "Model dispatch is allowed from prepared or failed_definite state",
      {
        request_id: current.requestId,
        phase: current.phase,
      },
    );
  }
  const update =
    current.phase === "prepared"
      ? await client.query(
          `UPDATE luoxia_engine.model_invocations
              SET invocation_status = 'dispatched_ambiguous',
                  dispatched_at = clock_timestamp()
            WHERE request_id = $1::uuid
              AND invocation_status = 'prepared'`,
          [current.requestId],
        )
      : await client.query(
          `UPDATE luoxia_engine.model_invocations
              SET invocation_status = 'dispatched_ambiguous',
                  dispatched_at = clock_timestamp(),
                  failure_code = NULL,
                  failure_output_summary = NULL,
                  failed_at = NULL
            WHERE request_id = $1::uuid
              AND invocation_status = 'failed_definite'`,
          [current.requestId],
        );
  if (update.rowCount !== 1) {
    throw new EngineFault(
      "model.invocation.state_conflict",
      "Model invocation state changed before dispatch",
      { request_id: current.requestId },
    );
  }
  const stored = await readModelInvocationByRequestIdLocked(
    client,
    contracts,
    current.requestId,
  );
  if (stored.phase !== "dispatched_ambiguous") {
    throw new EngineFault(
      "model.invocation.database_corrupt",
      "Dispatched model invocation did not enter ambiguous state",
      { request_id: current.requestId, phase: stored.phase },
    );
  }
  return stored;
}

async function persistFailedDefiniteInvocation(
  client: PoolClient,
  contracts: ContractValidator,
  current: StoredModelInvocation,
  failureCode: string,
  outputSummary: JsonObject,
): Promise<StoredFailedDefiniteModelInvocation> {
  if (current.phase === "failed_definite") {
    if (
      current.failureCode !== failureCode ||
      !jsonEquals(current.outputSummary, outputSummary)
    ) {
      throw new EngineFault(
        "model.invocation.failed_definite_conflict",
        "request_id is already bound to a different definite failure",
        { request_id: current.requestId },
      );
    }
    return current;
  }
  if (current.phase !== "dispatched_ambiguous") {
    throw new EngineFault(
      "model.invocation.failed_definite_forbidden",
      "Definite failure can only be recorded from dispatched_ambiguous state",
      {
        request_id: current.requestId,
        phase: current.phase,
      },
    );
  }
  const update = await client.query(
    `UPDATE luoxia_engine.model_invocations
        SET invocation_status = 'failed_definite',
            failure_code = $2,
            failure_output_summary = $3::jsonb,
            failed_at = clock_timestamp()
      WHERE request_id = $1::uuid
        AND invocation_status = 'dispatched_ambiguous'`,
    [
      current.requestId,
      failureCode,
      JSON.stringify(outputSummary),
    ],
  );
  if (update.rowCount !== 1) {
    throw new EngineFault(
      "model.invocation.state_conflict",
      "Model invocation state changed before definite failure persistence",
      { request_id: current.requestId },
    );
  }
  const stored = await readModelInvocationByRequestIdLocked(
    client,
    contracts,
    current.requestId,
  );
  if (stored.phase !== "failed_definite") {
    throw new EngineFault(
      "model.invocation.database_corrupt",
      "Definite failure did not retain its failure record",
      { request_id: current.requestId, phase: stored.phase },
    );
  }
  if (
    stored.failureCode !== failureCode ||
    !jsonEquals(stored.outputSummary, outputSummary)
  ) {
    throw new EngineFault(
      "model.invocation.failed_definite_conflict",
      "Persisted definite failure does not match the recorded failure",
      { request_id: current.requestId },
    );
  }
  return stored;
}

async function persistVerifiedInvocation(
  client: PoolClient,
  contracts: ContractValidator,
  current: StoredModelInvocation,
  documents: VerifiedDocuments,
  usage: ProviderUsageObservation,
): Promise<StoredVerifiedModelInvocation> {
  if (current.phase === "prepared") {
    throw new EngineFault(
      "model.invocation.response_before_dispatch",
      "A model response cannot be stored before durable dispatch",
      { request_id: current.requestId },
    );
  }
  if (current.phase === "verified") {
    assertStoredVerifiedMatches(
      current,
      documents.response,
      documents.proof,
    );
    return current;
  }

  const update = await client.query(
    `UPDATE luoxia_engine.model_invocations
        SET invocation_status = 'verified',
            response_document = $2::jsonb,
            proof_document = $3::jsonb,
            provider_kind = $4,
            provider_model = $5,
            token_usage_status = $6,
            input_tokens = $7::bigint,
            cached_input_tokens = $8::bigint,
            output_tokens = $9::bigint,
            verified_at = clock_timestamp()
      WHERE request_id = $1::uuid
        AND invocation_status = 'dispatched_ambiguous'`,
    [
      current.requestId,
      JSON.stringify(documents.response.value),
      JSON.stringify(documents.proof.value),
      usage.providerKind,
      usage.providerModel,
      usage.status,
      usage.status === "complete" || usage.status === "partial"
        ? usage.inputTokens.toString()
        : null,
      usage.status === "complete"
        ? usage.cachedInputTokens.toString()
        : null,
      usage.status === "complete" || usage.status === "partial"
        ? usage.outputTokens.toString()
        : null,
    ],
  );
  if (update.rowCount !== 1) {
    throw new EngineFault(
      "model.invocation.state_conflict",
      "Model invocation state changed before receipt persistence",
      { request_id: current.requestId },
    );
  }
  const stored = await readModelInvocationByRequestIdLocked(
    client,
    contracts,
    current.requestId,
  );
  if (stored.phase !== "verified") {
    throw new EngineFault(
      "model.invocation.database_corrupt",
      "Verified model invocation did not retain its response",
      { request_id: current.requestId, phase: stored.phase },
    );
  }
  assertStoredVerifiedMatches(
    stored,
    documents.response,
    documents.proof,
  );
  return stored;
}

async function assertCurrentWorldSnapshot(
  client: PoolClient,
  snapshot: WorldSnapshotDocument,
  worldId: string,
  worldRevision: number,
): Promise<void> {
  const query = await client.query<WorldStorageRow>(
    `SELECT world_id::text AS world_id,
            revision::text AS revision_text,
            state_document
       FROM luoxia_engine.worlds
      WHERE world_id = $1::uuid
      FOR SHARE`,
    [worldId],
  );
  const row = requireAtMostOne(
    query.rows,
    "model.invocation.database_corrupt",
    "World lookup returned more than one row",
    { world_id: worldId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "model.invocation.world_missing",
      "Cannot prepare a model invocation for a missing world",
      { world_id: worldId },
    );
  }
  const rowRevision = parseSafeUnsignedInteger(
    row.revision_text,
    "model.invocation.database_corrupt",
    "World revision",
    { world_id: worldId, revision: row.revision_text },
  );
  const storedState = expectProperty(
    snapshot.value,
    "world_state",
    "WorldSnapshot",
  );
  if (
    row.world_id !== worldId ||
    rowRevision !== worldRevision ||
    !jsonEquals(
      storedState,
      expectJsonObject(
        row.state_document as JsonObject,
        "worlds.state_document",
      ),
    )
  ) {
    throw new EngineFault(
      "model.invocation.snapshot_stale",
      "Model request is not based on the current committed world",
      {
        world_id: worldId,
        requested_revision: worldRevision,
        current_revision: rowRevision,
      },
    );
  }
}

async function readDailyRunByWorldDayLocked(
  client: PoolClient,
  contracts: ContractValidator,
  worldId: string,
  day: number,
): Promise<DailySettlementRunRecord | undefined> {
  const query = await client.query<DailySettlementRunRow>(
    `${DAILY_RUN_SELECT}
      WHERE run.world_id = $1::uuid
        AND run.day = $2::bigint
      FOR UPDATE OF run, invocation`,
    [worldId, day.toString()],
  );
  const row = requireAtMostOne(
    query.rows,
    "runtime.daily_settlement.database_corrupt",
    "world/day lookup returned more than one daily settlement",
    { world_id: worldId, day },
  );
  return row === undefined ? undefined : validateDailyRunRow(contracts, row);
}

async function readDailyRunByModelRequestIdLocked(
  client: PoolClient,
  contracts: ContractValidator,
  modelRequestId: string,
): Promise<DailySettlementRunRecord> {
  const query = await client.query<DailySettlementRunRow>(
    `${DAILY_RUN_SELECT}
      WHERE run.model_request_id = $1::uuid
      FOR UPDATE OF run, invocation`,
    [modelRequestId],
  );
  const row = requireAtMostOne(
    query.rows,
    "runtime.daily_settlement.database_corrupt",
    "model_request_id lookup returned more than one daily settlement",
    { model_request_id: modelRequestId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "runtime.daily_settlement.missing",
      "Daily settlement run does not exist",
      { model_request_id: modelRequestId },
    );
  }
  return validateDailyRunRow(contracts, row);
}

function extractVerifiedDailyProposalCount(
  run: DailySettlementRunRecord,
): number {
  if (
    run.phase !== "response_verified" ||
    run.invocation.phase !== "verified"
  ) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Verified daily settlement run is missing its verified invocation",
      { model_request_id: run.invocation.requestId },
    );
  }
  const output = expectJsonObject(
    expectProperty(
      run.invocation.response.value,
      "output",
      "ModelResponse",
    ),
    "ModelResponse.output",
  );
  const outputKind = expectString(
    output,
    "output_kind",
    "DirectorDailySettlementOutput",
  );
  if (outputKind !== DAILY_REQUEST_KIND) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Verified daily settlement output kind does not match its run",
      {
        model_request_id: run.invocation.requestId,
        output_kind: outputKind,
      },
    );
  }
  const automaticEvents = expectProperty(
    output,
    "automatic_events",
    "DirectorDailySettlementOutput",
  );
  if (!Array.isArray(automaticEvents)) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Verified daily settlement automatic_events must be an array",
      { model_request_id: run.invocation.requestId },
    );
  }
  return automaticEvents.length;
}

async function readDailyProposalIdentities(
  client: PoolClient,
  modelRequestId: string,
): Promise<readonly DailySettlementProposalIdentityRow[]> {
  const query = await client.query<DailySettlementProposalIdentityRow>(
    `SELECT proposal_ordinal,
            proposal_id::text AS proposal_id
       FROM luoxia_engine.daily_settlement_proposal_runs
      WHERE model_request_id = $1::uuid
      ORDER BY proposal_ordinal`,
    [modelRequestId],
  );
  return query.rows;
}

function validateDailyProposalIdentities(
  contracts: ContractValidator,
  rows: readonly DailySettlementProposalIdentityRow[],
  modelRequestId: string,
  expectedCount: number,
): readonly DailySettlementProposalIdentity[] {
  const identities = rows.map((row, ordinal) => {
    if (
      !Number.isSafeInteger(row.proposal_ordinal) ||
      row.proposal_ordinal !== ordinal
    ) {
      throw new EngineFault(
        "runtime.daily_settlement.database_corrupt",
        "Daily proposal identity ordinals must be contiguous from zero",
        {
          model_request_id: modelRequestId,
          expected_ordinal: ordinal,
          stored_ordinal: row.proposal_ordinal,
        },
      );
    }
    return Object.freeze({
      ordinal,
      proposalId: assertUuid(contracts, row.proposal_id),
    });
  });
  if (identities.length !== expectedCount) {
    throw new EngineFault(
      "runtime.daily_settlement.proposal_identity_conflict",
      "Daily settlement proposal identities are already bound to another count",
      {
        model_request_id: modelRequestId,
        expected_count: expectedCount,
        stored_count: identities.length,
      },
    );
  }
  return Object.freeze(identities);
}

async function readDailyRunByWorldDay(
  client: PoolClient,
  contracts: ContractValidator,
  worldId: string,
  day: number,
): Promise<DailySettlementRunRecord | undefined> {
  const query = await client.query<DailySettlementRunRow>(
    `${DAILY_RUN_SELECT}
      WHERE run.world_id = $1::uuid
        AND run.day = $2::bigint`,
    [worldId, day.toString()],
  );
  const row = requireAtMostOne(
    query.rows,
    "runtime.daily_settlement.database_corrupt",
    "world/day lookup returned more than one daily settlement",
    { world_id: worldId, day },
  );
  return row === undefined ? undefined : validateDailyRunRow(contracts, row);
}

function validateDailyRunRow(
  contracts: ContractValidator,
  row: DailySettlementRunRow,
): DailySettlementRunRecord {
  const invocation = validateModelInvocationRow(contracts, row);
  const day = parseSafeUnsignedInteger(
    row.day_text,
    "runtime.daily_settlement.database_corrupt",
    "Daily settlement day",
    { world_id: row.run_world_id, day: row.day_text },
  );
  if (day < 1) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Daily settlement day must be positive",
      { world_id: row.run_world_id, day },
    );
  }
  const requestDay = extractDailySettlementDay(
    invocation.request.value,
    invocation.snapshot.value,
  );
  if (
    row.run_world_id !== invocation.worldId ||
    row.model_request_id !== invocation.requestId ||
    row.run_request_kind !== DAILY_REQUEST_KIND ||
    invocation.requestKind !== DAILY_REQUEST_KIND ||
    requestDay !== day
  ) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Daily settlement run identity does not match its model invocation",
      {
        world_id: row.run_world_id,
        day,
        model_request_id: row.model_request_id,
      },
    );
  }

  if (invocation.phase === "prepared") {
    return Object.freeze({
      worldId: row.run_world_id,
      day,
      phase: "prepared",
      invocation,
    });
  }
  if (invocation.phase === "dispatched_ambiguous") {
    return Object.freeze({
      worldId: row.run_world_id,
      day,
      phase: "blocked_ambiguous",
      invocation,
    });
  }
  if (invocation.phase === "failed_definite") {
    return Object.freeze({
      worldId: row.run_world_id,
      day,
      phase: "failed_definite",
      invocation,
    });
  }
  return Object.freeze({
    worldId: row.run_world_id,
    day,
    phase: "response_verified",
    invocation,
  });
}

function validateModelInvocationRow(
  contracts: ContractValidator,
  row: ModelInvocationRow,
): StoredModelInvocation {
  const snapshot = contracts.assertObject(
    CONTRACT_REF.worldSnapshot,
    row.snapshot_document,
  );
  const request = contracts.assertObject(
    CONTRACT_REF.modelRequest,
    row.request_document,
  );
  const worldRevision = parseSafeUnsignedInteger(
    row.world_revision_text,
    "model.invocation.database_corrupt",
    "Model invocation world revision",
    { request_id: row.request_id, revision: row.world_revision_text },
  );
  if (
    expectString(snapshot.value, "world_id", "WorldSnapshot") !==
      row.world_id ||
    expectInteger(snapshot.value, "world_revision", "WorldSnapshot") !==
      worldRevision ||
    expectString(request.value, "request_id", "ModelRequest") !==
      row.request_id ||
    expectString(request.value, "request_kind", "ModelRequest") !==
      row.request_kind ||
    expectInteger(request.value, "basis_revision", "ModelRequest") !==
      worldRevision
  ) {
    throw new EngineFault(
      "model.invocation.database_corrupt",
      "Model invocation columns and prepared documents do not match",
      { request_id: row.request_id },
    );
  }

  const base = Object.freeze({
    worldId: row.world_id,
    worldRevision,
    requestId: row.request_id,
    requestKind: row.request_kind,
    snapshot,
    request,
  });
  if (row.invocation_status === "prepared") {
    if (
      row.response_document !== null ||
      row.proof_document !== null ||
      hasProviderUsageColumns(row) ||
      hasFailureColumns(row)
    ) {
      throw modelInvocationShapeFault(row);
    }
    return Object.freeze({ ...base, phase: "prepared" as const });
  }
  if (row.invocation_status === "dispatched_ambiguous") {
    if (
      row.response_document !== null ||
      row.proof_document !== null ||
      hasProviderUsageColumns(row) ||
      hasFailureColumns(row)
    ) {
      throw modelInvocationShapeFault(row);
    }
    return Object.freeze({
      ...base,
      phase: "dispatched_ambiguous" as const,
    });
  }
  if (row.invocation_status === "failed_definite") {
    if (
      row.response_document !== null ||
      row.proof_document !== null ||
      hasProviderUsageColumns(row) ||
      row.failure_code === null ||
      row.failure_output_summary === null
    ) {
      throw modelInvocationShapeFault(row);
    }
    assertFailureCode(row.failure_code, row.request_id);
    const outputSummary = expectJsonObject(
      row.failure_output_summary as JsonObject,
      "ModelInvocation.failure_output_summary",
    );
    return Object.freeze({
      ...base,
      phase: "failed_definite" as const,
      failureCode: row.failure_code,
      outputSummary,
    });
  }
  if (row.invocation_status === "verified") {
    if (
      row.response_document === null ||
      row.proof_document === null ||
      hasFailureColumns(row)
    ) {
      throw modelInvocationShapeFault(row);
    }
    const response = contracts.assertObject(
      CONTRACT_REF.modelResponse,
      row.response_document,
    );
    const proof = contracts.assertObject(
      CONTRACT_REF.verifiedModelOutput,
      row.proof_document,
    );
    readStoredProviderUsage(row);
    assertStoredResponseIdentity(row, response, proof, worldRevision);
    return Object.freeze({
      ...base,
      phase: "verified" as const,
      response,
      proof,
    });
  }
  throw modelInvocationShapeFault(row);
}

function assertStoredResponseIdentity(
  row: ModelInvocationRow,
  response: ModelResponseDocument,
  proof: VerifiedModelOutputDocument,
  worldRevision: number,
): void {
  const pairs = [
    expectString(response.value, "request_id", "ModelResponse") ===
      row.request_id,
    expectString(proof.value, "request_id", "VerifiedModelOutputRef") ===
      row.request_id,
    expectString(response.value, "request_kind", "ModelResponse") ===
      row.request_kind,
    expectString(proof.value, "request_kind", "VerifiedModelOutputRef") ===
      row.request_kind,
    expectInteger(response.value, "basis_revision", "ModelResponse") ===
      worldRevision,
    expectInteger(
      proof.value,
      "basis_revision",
      "VerifiedModelOutputRef",
    ) === worldRevision,
  ];
  if (pairs.some((matches) => !matches)) {
    throw modelInvocationShapeFault(row);
  }
}

function modelInvocationShapeFault(row: ModelInvocationRow): EngineFault {
  return new EngineFault(
    "model.invocation.database_corrupt",
    "Model invocation status and stored documents are inconsistent",
    {
      request_id: row.request_id,
      invocation_status: row.invocation_status,
    },
  );
}

function hasProviderUsageColumns(row: ModelInvocationRow): boolean {
  return (
    row.provider_kind !== null ||
    row.provider_model !== null ||
    row.token_usage_status !== null ||
    row.input_tokens_text !== null ||
    row.cached_input_tokens_text !== null ||
    row.output_tokens_text !== null
  );
}

function hasFailureColumns(row: ModelInvocationRow): boolean {
  return (
    row.failure_code !== null ||
    row.failure_output_summary !== null
  );
}

function assertFailureCode(failureCode: string, requestId: string): void {
  if (
    failureCode.length === 0 ||
    failureCode.length > 256 ||
    failureCode !== failureCode.trim() ||
    /[\r\n]/.test(failureCode)
  ) {
    throw new EngineFault(
      "model.invocation.failure_code_invalid",
      "Definite model failure code must be a non-empty trimmed string up to 256 characters",
      { request_id: requestId, failure_code: failureCode },
    );
  }
}

function readStoredProviderUsage(
  row: ModelInvocationRow,
): ProviderUsageObservation {
  const providerKind = readStoredProviderKind(row);
  const providerModel = row.provider_model;
  const status = row.token_usage_status;
  if (
    providerModel === null ||
    providerModel.length === 0 ||
    providerModel.length > 256 ||
    providerModel !== providerModel.trim() ||
    /[\r\n]/u.test(providerModel) ||
    status === null
  ) {
    throw modelInvocationShapeFault(row);
  }
  const inputTokens = readStoredTokenCount(
    row,
    row.input_tokens_text,
    "input_tokens",
  );
  const cachedInputTokens = readStoredTokenCount(
    row,
    row.cached_input_tokens_text,
    "cached_input_tokens",
  );
  const outputTokens = readStoredTokenCount(
    row,
    row.output_tokens_text,
    "output_tokens",
  );

  if (
    status === "complete" &&
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    outputTokens !== undefined &&
    cachedInputTokens <= inputTokens
  ) {
    return Object.freeze({
      providerKind,
      providerModel,
      status,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    });
  }
  if (
    status === "partial" &&
    inputTokens !== undefined &&
    cachedInputTokens === undefined &&
    outputTokens !== undefined
  ) {
    return Object.freeze({
      providerKind,
      providerModel,
      status,
      inputTokens,
      outputTokens,
    });
  }
  if (
    (status === "absent" || status === "invalid") &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined
  ) {
    return Object.freeze({
      providerKind,
      providerModel,
      status,
    });
  }
  throw modelInvocationShapeFault(row);
}

function readStoredProviderKind(
  row: ModelInvocationRow,
): string {
  const providerKind = row.provider_kind;
  if (
    providerKind === null ||
    providerKind.length === 0 ||
    providerKind.length > 64 ||
    providerKind !== providerKind.trim() ||
    /[\r\n\u0000]/u.test(providerKind)
  ) {
    throw modelInvocationShapeFault(row);
  }
  return providerKind;
}

function readStoredTokenCount(
  row: ModelInvocationRow,
  candidate: string | null,
  field: string,
): number | undefined {
  if (candidate === null) {
    return undefined;
  }
  return parseSafeUnsignedInteger(
    candidate,
    "model.invocation.database_corrupt",
    `Model invocation ${field}`,
    { request_id: row.request_id, field, value: candidate },
  );
}

function validatePreparedDocuments(
  contracts: ContractValidator,
  invocation: ModelInvocationDocumentIdentity,
): PreparedDocuments {
  const snapshot = contracts.assertObject(
    CONTRACT_REF.worldSnapshot,
    invocation.snapshot.value,
  );
  const request = contracts.assertObject(
    CONTRACT_REF.modelRequest,
    invocation.request.value,
  );
  if (
    expectString(snapshot.value, "world_id", "WorldSnapshot") !==
      invocation.worldId ||
    expectInteger(snapshot.value, "world_revision", "WorldSnapshot") !==
      invocation.worldRevision ||
    expectInteger(request.value, "basis_revision", "ModelRequest") !==
      invocation.worldRevision
  ) {
    throw new EngineFault(
      "model.invocation.identity_mismatch",
      "Prepared model invocation identity does not match its documents",
      {
        request_id: expectString(
          request.value,
          "request_id",
          "ModelRequest",
        ),
      },
    );
  }
  assertSafeUnsignedInteger(
    invocation.worldRevision,
    "model.invocation.revision_invalid",
    "Model invocation world revision",
    {
      request_id: expectString(
        request.value,
        "request_id",
        "ModelRequest",
      ),
      world_revision: invocation.worldRevision,
    },
  );
  return Object.freeze({ snapshot, request });
}

function validateVerifiedDocuments(
  contracts: ContractValidator,
  receipt: VerifiedModelInvocationReceipt,
): VerifiedDocuments {
  const prepared = validatePreparedDocuments(contracts, receipt);
  const response = contracts.assertObject(
    CONTRACT_REF.modelResponse,
    receipt.response.value,
  );
  const proof = contracts.assertObject(
    CONTRACT_REF.verifiedModelOutput,
    receipt.proof.value,
  );
  return Object.freeze({
    snapshot: prepared.snapshot,
    request: prepared.request,
    response,
    proof,
  });
}

function assertGenericInvocationKind(request: ModelRequestDocument): void {
  const requestKind = expectString(
    request.value,
    "request_kind",
    "ModelRequest",
  );
  if (requestKind === DAILY_REQUEST_KIND) {
    throw new EngineFault(
      "runtime.daily_settlement.journal_required",
      "Director daily settlement must use the world/day-unique journal path",
      {
        request_id: expectString(
          request.value,
          "request_id",
          "ModelRequest",
        ),
      },
    );
  }
}

function extractDailySettlementDay(
  request: JsonObject,
  snapshot: JsonObject,
): number {
  const requestKind = expectString(request, "request_kind", "ModelRequest");
  if (requestKind !== DAILY_REQUEST_KIND) {
    throw new EngineFault(
      "runtime.daily_settlement.request_kind_invalid",
      "Daily settlement journal accepts only Director daily requests",
      { request_kind: requestKind },
    );
  }
  const input = expectJsonObject(
    expectProperty(request, "input", "ModelRequest"),
    "ModelRequest.input",
  );
  const worldView = expectJsonObject(
    expectProperty(input, "world_view", "DirectorDailySettlementInput"),
    "DirectorDailySettlementInput.world_view",
  );
  const requestDay = expectInteger(worldView, "day", "DirectorWorldView");
  const worldState = expectJsonObject(
    expectProperty(snapshot, "world_state", "WorldSnapshot"),
    "WorldSnapshot.world_state",
  );
  const dayCycle = expectJsonObject(
    expectProperty(worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const snapshotDay = expectInteger(dayCycle, "day", "DayCycleState");
  if (requestDay !== snapshotDay) {
    throw new EngineFault(
      "runtime.daily_settlement.day_mismatch",
      "Director daily request day does not match its WorldSnapshot",
      { request_day: requestDay, snapshot_day: snapshotDay },
    );
  }
  assertSafeDay(requestDay, expectString(snapshot, "world_id", "WorldSnapshot"));
  return requestDay;
}

function assertSafeDay(day: number, worldId: string): void {
  assertSafeUnsignedInteger(
    day,
    "runtime.daily_settlement.day_invalid",
    "Daily settlement day",
    { world_id: worldId, day },
  );
  if (day < 1) {
    throw new EngineFault(
      "runtime.daily_settlement.day_invalid",
      "Daily settlement day must be positive",
      { world_id: worldId, day },
    );
  }
}

function assertPrepared(
  provenance: ModelInvocationProvenanceVerifier,
  invocation: PreparedModelInvocation,
): void {
  if (!provenance.isPrepared(invocation)) {
    throw new EngineFault(
      "model.invocation.prepared_receipt_required",
      "Model invocation persistence requires a gateway-prepared invocation",
    );
  }
}

function assertVerified(
  provenance: ModelInvocationProvenanceVerifier,
  receipt: VerifiedModelInvocationReceipt,
): void {
  if (!provenance.isVerified(receipt)) {
    throw new EngineFault(
      "model.invocation.verified_receipt_required",
      "Model response persistence requires a gateway-verified receipt",
    );
  }
}

function assertInvocationMatchesPrepared(
  stored: StoredModelInvocation,
  invocation: PreparedModelInvocation,
): void {
  const requestId = expectString(
    invocation.request.value,
    "request_id",
    "ModelRequest",
  );
  const requestKind = expectString(
    invocation.request.value,
    "request_kind",
    "ModelRequest",
  );
  if (
    stored.worldId !== invocation.worldId ||
    stored.worldRevision !== invocation.worldRevision ||
    stored.requestId !== requestId ||
    stored.requestKind !== requestKind ||
    !jsonEquals(stored.snapshot.value, invocation.snapshot.value) ||
    !jsonEquals(stored.request.value, invocation.request.value)
  ) {
    throw new EngineFault(
      "model.invocation.identity_conflict",
      "Stored model invocation is bound to different prepared documents",
      { request_id: requestId },
    );
  }
}

function assertInvocationMatchesVerified(
  stored: StoredModelInvocation,
  receipt: VerifiedModelInvocationReceipt,
): void {
  const requestId = expectString(
    receipt.request.value,
    "request_id",
    "ModelRequest",
  );
  const requestKind = expectString(
    receipt.request.value,
    "request_kind",
    "ModelRequest",
  );
  if (
    stored.worldId !== receipt.worldId ||
    stored.worldRevision !== receipt.worldRevision ||
    stored.requestId !== requestId ||
    stored.requestKind !== requestKind ||
    !jsonEquals(stored.snapshot.value, receipt.snapshot.value) ||
    !jsonEquals(stored.request.value, receipt.request.value)
  ) {
    throw new EngineFault(
      "model.invocation.identity_conflict",
      "Stored model invocation is bound to a different verified receipt",
      { request_id: requestId },
    );
  }
}

function assertRunMatchesPrepared(
  run: DailySettlementRunRecord,
  invocation: PreparedModelInvocation,
): void {
  assertInvocationMatchesPrepared(run.invocation, invocation);
  if (
    run.worldId !== invocation.worldId ||
    run.invocation.requestKind !== DAILY_REQUEST_KIND
  ) {
    throw new EngineFault(
      "runtime.daily_settlement.identity_conflict",
      "Daily settlement run is bound to a different Director invocation",
      {
        world_id: run.worldId,
        day: run.day,
        model_request_id: run.invocation.requestId,
      },
    );
  }
}

function assertRunMatchesVerified(
  run: DailySettlementRunRecord,
  receipt: VerifiedModelInvocationReceipt,
): void {
  assertInvocationMatchesVerified(run.invocation, receipt);
  if (
    run.worldId !== receipt.worldId ||
    run.invocation.requestKind !== DAILY_REQUEST_KIND
  ) {
    throw new EngineFault(
      "runtime.daily_settlement.identity_conflict",
      "Daily settlement run is bound to a different Director receipt",
      {
        world_id: run.worldId,
        day: run.day,
        model_request_id: run.invocation.requestId,
      },
    );
  }
}

function assertStoredVerifiedMatches(
  stored: StoredVerifiedModelInvocation,
  response: ModelResponseDocument,
  proof: VerifiedModelOutputDocument,
): void {
  if (
    !jsonEquals(stored.response.value, response.value) ||
    !jsonEquals(stored.proof.value, proof.value)
  ) {
    throw new EngineFault(
      "model.invocation.verified_receipt_conflict",
      "request_id is already bound to a different verified response",
      { request_id: stored.requestId },
    );
  }
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeInvocationJournalError(error: unknown): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const constraint =
    typeof error.constraint === "string" ? error.constraint : "";
  if (
    constraint === "model_invocations_pkey" ||
    constraint === "model_invocations_request_world_kind_unique"
  ) {
    return new EngineFault(
      "model.invocation.identity_conflict",
      "PostgreSQL rejected a conflicting model invocation identity",
      { postgres_code: error.code, constraint },
    );
  }
  if (
    constraint === "daily_settlement_runs_pkey" ||
    constraint === "daily_settlement_runs_model_request_unique" ||
    constraint === "daily_settlement_runs_model_invocation_foreign_key"
  ) {
    return new EngineFault(
      "runtime.daily_settlement.identity_conflict",
      "PostgreSQL rejected a conflicting daily settlement identity",
      { postgres_code: error.code, constraint },
    );
  }
  if (
    constraint === "daily_settlement_proposal_runs_pkey" ||
    constraint ===
      "daily_settlement_proposal_runs_proposal_id_unique" ||
    constraint ===
      "daily_settlement_proposal_runs_model_request_foreign_key"
  ) {
    return new EngineFault(
      "runtime.daily_settlement.proposal_identity_conflict",
      "PostgreSQL rejected a conflicting daily proposal identity",
      { postgres_code: error.code, constraint },
    );
  }
  if (constraint === "model_invocations_world_foreign_key") {
    return new EngineFault(
      "model.invocation.world_missing",
      "Model invocation references a missing world",
      { postgres_code: error.code, constraint },
    );
  }
  if (constraint === "daily_settlement_runs_world_foreign_key") {
    return new EngineFault(
      "runtime.daily_settlement.world_missing",
      "Daily settlement references a missing world",
      { postgres_code: error.code, constraint },
    );
  }
  return new EngineFault(
    "runtime.invocation.database_error",
    "PostgreSQL rejected the model invocation journal operation",
    {
      postgres_code: error.code,
      constraint,
      postgres_message:
        typeof error.message === "string" ? error.message : "",
    },
  );
}

function isPostgresError(
  error: unknown,
): error is PostgresErrorLike & { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as PostgresErrorLike).code === "string"
  );
}
