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
  type PreparedModelInvocation,
  type VerifiedModelInvocationReceipt,
  type VerifiedModelOutputDocument,
  type WorldSnapshotDocument,
} from "../../application/model-gateway.js";
import type {
  AuthorizedModelDispatch,
  AuthorizedDailyDirectorDispatch,
  DailySettlementRunJournal,
  DailySettlementRunRecord,
  ModelInvocationJournal,
  RecordedModelInvocationVerifier,
  StoredAmbiguousModelInvocation,
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
  extends ModelInvocationJournal,
    DailySettlementRunJournal {}

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
    assertGenericInvocationKind(invocation.request);
    validatePreparedDocuments(this.#contracts, invocation);
    let stored: StoredAmbiguousModelInvocation;
    try {
      stored = await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const current = await readModelInvocationByRequestIdLocked(
            client,
            this.#contracts,
            expectString(
              invocation.request.value,
              "request_id",
              "ModelRequest",
            ),
          );
          assertInvocationMatchesPrepared(current, invocation);
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
  ): Promise<StoredVerifiedModelInvocation> {
    assertVerified(this.#modelProvenance, receipt);
    assertGenericInvocationKind(receipt.request);
    const documents = validateVerifiedDocuments(this.#contracts, receipt);
    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const current = await readModelInvocationByRequestIdLocked(
            client,
            this.#contracts,
            expectString(receipt.request.value, "request_id", "ModelRequest"),
          );
          assertInvocationMatchesVerified(current, receipt);
          return persistVerifiedInvocation(
            client,
            this.#contracts,
            current,
            documents,
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
    const runId = randomUUID();

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

          const inserted = await client.query<{ readonly run_id: string }>(
            `INSERT INTO luoxia_engine.daily_settlement_runs (
               run_id,
               world_id,
               day,
               model_request_id,
               request_kind,
               created_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::bigint,
               $4::uuid,
               $5,
               clock_timestamp()
             )
             ON CONFLICT DO NOTHING
             RETURNING run_id::text AS run_id`,
            [
              runId,
              invocation.worldId,
              day.toString(),
              storedInvocation.requestId,
              DAILY_REQUEST_KIND,
            ],
          );
          if (inserted.rowCount === 1) {
            return readDailyRunByIdLocked(
              client,
              this.#contracts,
              runId,
            );
          }

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

  public async markDirectorDispatched(
    runId: string,
    invocation: PreparedModelInvocation,
  ): Promise<AuthorizedDailyDirectorDispatch> {
    const verifiedRunId = assertUuid(this.#contracts, runId);
    assertPrepared(this.#modelProvenance, invocation);
    validatePreparedDocuments(this.#contracts, invocation);

    let run: DailySettlementRunRecord;
    try {
      run = await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const current = await readDailyRunByIdLocked(
            client,
            this.#contracts,
            verifiedRunId,
          );
          assertRunMatchesPrepared(current, invocation);
          await markPreparedInvocationDispatched(
            client,
            this.#contracts,
            current.invocation,
          );
          return readDailyRunByIdLocked(
            client,
            this.#contracts,
            verifiedRunId,
          );
        },
      );
    } catch (error: unknown) {
      throw normalizeInvocationJournalError(error);
    }

    const authorization = this.#dispatchIssuer.issue(invocation);
    return Object.freeze({ run, authorization });
  }

  public async recordDirectorVerified(
    runId: string,
    receipt: VerifiedModelInvocationReceipt,
  ): Promise<DailySettlementRunRecord> {
    const verifiedRunId = assertUuid(this.#contracts, runId);
    assertVerified(this.#modelProvenance, receipt);
    const documents = validateVerifiedDocuments(this.#contracts, receipt);

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const current = await readDailyRunByIdLocked(
            client,
            this.#contracts,
            verifiedRunId,
          );
          assertRunMatchesVerified(current, receipt);
          await persistVerifiedInvocation(
            client,
            this.#contracts,
            current.invocation,
            documents,
          );
          return readDailyRunByIdLocked(
            client,
            this.#contracts,
            verifiedRunId,
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
}

interface DailySettlementRunRow extends ModelInvocationRow {
  readonly run_id: string;
  readonly run_world_id: string;
  readonly day_text: string;
  readonly model_request_id: string;
  readonly run_request_kind: string;
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
  proof_document
FROM luoxia_engine.model_invocations`;

const DAILY_RUN_SELECT = `SELECT
  run.run_id::text AS run_id,
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
  invocation.proof_document
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
       prepared_at,
       dispatched_at,
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
       clock_timestamp(),
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
  if (current.phase !== "prepared") {
    throw new EngineFault(
      "model.invocation.dispatch_forbidden",
      "Model dispatch is allowed exactly once from prepared state",
      {
        request_id: current.requestId,
        phase: current.phase,
      },
    );
  }
  const update = await client.query(
    `UPDATE luoxia_engine.model_invocations
        SET invocation_status = 'dispatched_ambiguous',
            dispatched_at = clock_timestamp()
      WHERE request_id = $1::uuid
        AND invocation_status = 'prepared'`,
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

async function persistVerifiedInvocation(
  client: PoolClient,
  contracts: ContractValidator,
  current: StoredModelInvocation,
  documents: VerifiedDocuments,
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
            verified_at = clock_timestamp()
      WHERE request_id = $1::uuid
        AND invocation_status = 'dispatched_ambiguous'`,
    [
      current.requestId,
      JSON.stringify(documents.response.value),
      JSON.stringify(documents.proof.value),
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

async function readDailyRunByIdLocked(
  client: PoolClient,
  contracts: ContractValidator,
  runId: string,
): Promise<DailySettlementRunRecord> {
  const query = await client.query<DailySettlementRunRow>(
    `${DAILY_RUN_SELECT}
      WHERE run.run_id = $1::uuid
      FOR UPDATE OF run, invocation`,
    [runId],
  );
  const row = requireAtMostOne(
    query.rows,
    "runtime.daily_settlement.database_corrupt",
    "run_id lookup returned more than one daily settlement",
    { run_id: runId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "runtime.daily_settlement.missing",
      "Daily settlement run does not exist",
      { run_id: runId },
    );
  }
  return validateDailyRunRow(contracts, row);
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
    { run_id: row.run_id, day: row.day_text },
  );
  if (day < 1) {
    throw new EngineFault(
      "runtime.daily_settlement.database_corrupt",
      "Daily settlement day must be positive",
      { run_id: row.run_id, day },
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
      { run_id: row.run_id },
    );
  }

  if (invocation.phase === "prepared") {
    return Object.freeze({
      runId: row.run_id,
      worldId: row.run_world_id,
      day,
      phase: "prepared",
      invocation,
    });
  }
  if (invocation.phase === "dispatched_ambiguous") {
    return Object.freeze({
      runId: row.run_id,
      worldId: row.run_world_id,
      day,
      phase: "blocked_ambiguous",
      invocation,
    });
  }
  return Object.freeze({
    runId: row.run_id,
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
    if (row.response_document !== null || row.proof_document !== null) {
      throw modelInvocationShapeFault(row);
    }
    return Object.freeze({ ...base, phase: "prepared" as const });
  }
  if (row.invocation_status === "dispatched_ambiguous") {
    if (row.response_document !== null || row.proof_document !== null) {
      throw modelInvocationShapeFault(row);
    }
    return Object.freeze({
      ...base,
      phase: "dispatched_ambiguous" as const,
    });
  }
  if (row.invocation_status === "verified") {
    if (row.response_document === null || row.proof_document === null) {
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
      { run_id: run.runId },
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
      { run_id: run.runId },
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
    constraint === "daily_settlement_runs_world_day_unique" ||
    constraint === "daily_settlement_runs_model_request_unique" ||
    constraint === "daily_settlement_runs_model_invocation_foreign_key"
  ) {
    return new EngineFault(
      "runtime.daily_settlement.identity_conflict",
      "PostgreSQL rejected a conflicting daily settlement identity",
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
