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
  type JsonValue,
} from "@luoxia/contracts-runtime/portable";
import type {
  AtomicPacketStore,
  AuthorizedPacketCommit,
  CommittedEventDocument,
  ContentPacketDocument,
  DomainEventDocument,
  LockedWorldTransaction,
  MaterializationRequestDocument,
  PacketCommitIdentityDocument,
  PacketCommitPreparation,
  WorldStateDocument,
} from "@luoxia/world-core/composition";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

const MAX_SAFE_REVISION = BigInt(Number.MAX_SAFE_INTEGER);

export interface PostgresAtomicPacketStoreDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

export function createPostgresAtomicPacketStore(
  dependencies: PostgresAtomicPacketStoreDependencies,
): AtomicPacketStore {
  return new PostgresAtomicPacketStore(dependencies);
}

class PostgresAtomicPacketStore implements AtomicPacketStore {
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;

  public constructor(dependencies: PostgresAtomicPacketStoreDependencies) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
  }

  public async withLockedWorld(
    packet: ContentPacketDocument,
    operation: (
      transaction: LockedWorldTransaction,
    ) => Promise<ApplyPacketResultDocument>,
  ): Promise<ApplyPacketResultDocument> {
    let client: PoolClient | undefined;
    let began = false;
    let completed = false;
    let destroyClient = false;

    try {
      client = await this.#pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;

      const lockedWorld = await lockWorld(client, this.#contracts, packet.value);
      const transaction = new PostgresLockedWorldTransaction({
        client,
        contracts: this.#contracts,
        packet,
        lockedWorld,
      });
      const result = await operation(transaction);
      transaction.assertCallbackCompletion(result);

      await client.query("COMMIT");
      completed = true;
      return result;
    } catch (error: unknown) {
      const originalError = normalizeStoreError(error);
      if (client !== undefined && began && !completed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
        }
      }
      throw originalError;
    } finally {
      if (client !== undefined) {
        if (destroyClient) {
          client.release(new Error("world.atomic_store.rollback_failed"));
        } else {
          client.release();
        }
      }
    }
  }
}

interface LockedWorldRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
}

interface DuplicateEventRow {
  readonly world_id: string;
  readonly event_document: unknown;
  readonly result_document: unknown;
}

interface DatabaseClockRow {
  readonly committed_at: Date | string;
}

interface LockedWorld {
  readonly worldId: string;
  readonly revision: number;
  readonly state: WorldStateDocument;
}

interface PostgresLockedWorldTransactionDependencies {
  readonly client: PoolClient;
  readonly contracts: ContractValidator;
  readonly packet: ContentPacketDocument;
  readonly lockedWorld: LockedWorld;
}

type TransactionStage =
  | "created"
  | "duplicate_checked"
  | "duplicate"
  | "snapshot_read"
  | "identity_created"
  | "prepared"
  | "committed";

interface PreparedArtifacts {
  readonly commitIdentity: PacketCommitIdentityDocument;
  readonly nextWorldState: WorldStateDocument;
  readonly committedEvent: CommittedEventDocument;
  readonly result: ApplyPacketResultDocument;
  readonly materializationRequests: readonly MaterializationRequestDocument[];
}

class PostgresLockedWorldTransaction implements LockedWorldTransaction {
  readonly #client: PoolClient;
  readonly #contracts: ContractValidator;
  readonly #packet: ContentPacketDocument;
  readonly #lockedWorld: LockedWorld;
  #stage: TransactionStage = "created";
  #duplicateResult: ApplyPacketResultDocument | undefined;
  #commitIdentity: PacketCommitIdentityDocument | undefined;
  #prepared: PreparedArtifacts | undefined;

  public constructor(dependencies: PostgresLockedWorldTransactionDependencies) {
    this.#client = dependencies.client;
    this.#contracts = dependencies.contracts;
    this.#packet = dependencies.packet;
    this.#lockedWorld = dependencies.lockedWorld;
  }

  public async readDuplicateResult(
    packet: ContentPacketDocument,
  ): Promise<unknown | undefined> {
    this.#requireStage("created", "readDuplicateResult");
    assertSamePacket(this.#packet, packet, "duplicate query");

    const packetId = expectString(packet.value, "packet_id", "ContentPacket");
    const query = await this.#client.query<DuplicateEventRow>(
      `SELECT world_id::text AS world_id, event_document, result_document
         FROM luoxia_engine.committed_events
        WHERE packet_id = $1::uuid`,
      [packetId],
    );
    const row = requireAtMostOne(query.rows, "packet_id", packetId);
    if (row === undefined) {
      this.#stage = "duplicate_checked";
      return undefined;
    }

    const storedEvent = this.#contracts.assertObject(
      CONTRACT_REF.committedEvent,
      row.event_document,
    );
    const storedResult = this.#contracts.assertObject(
      CONTRACT_REF.applyPacketResult,
      row.result_document,
    );
    const storedPacket = expectJsonObject(
      expectProperty(storedEvent.value, "packet", "CommittedEvent"),
      "CommittedEvent.packet",
    );
    const requestedWorldId = expectString(packet.value, "world_id", "ContentPacket");
    const storedWorldId = expectString(storedEvent.value, "world_id", "CommittedEvent");

    if (
      row.world_id !== requestedWorldId ||
      storedWorldId !== requestedWorldId ||
      !jsonEquals(storedPacket, packet.value)
    ) {
      throw new EngineFault(
        "world.atomic_store.packet_id_conflict",
        "packet_id already belongs to a different world or packet",
        { packet_id: packetId, world_id: requestedWorldId },
      );
    }

    if (expectString(storedResult.value, "status", "ApplyPacketResult") !== "committed") {
      throw new EngineFault(
        "world.atomic_store.database_corrupt",
        "Stored duplicate result is not a committed result",
        { packet_id: packetId },
      );
    }

    const duplicate = this.#contracts.assertObject(
      CONTRACT_REF.applyPacketResult,
      {
        ...storedResult.value,
        status: "duplicate",
      },
    );
    this.#duplicateResult = duplicate;
    this.#stage = "duplicate";
    return duplicate.value;
  }

  public async readSnapshot(): Promise<unknown> {
    this.#requireStage("duplicate_checked", "readSnapshot");
    const snapshot = this.#contracts.assertObject(CONTRACT_REF.worldSnapshot, {
      world_id: this.#lockedWorld.worldId,
      world_revision: this.#lockedWorld.revision,
      world_state: this.#lockedWorld.state.value,
    });
    this.#stage = "snapshot_read";
    return snapshot.value;
  }

  public async createCommitIdentityCandidate(
    packet: ContentPacketDocument,
  ): Promise<unknown> {
    this.#requireStage("snapshot_read", "createCommitIdentityCandidate");
    assertSamePacket(this.#packet, packet, "commit identity");
    const identity = this.#contracts.assertObject(
      CONTRACT_REF.packetCommitIdentity,
      { event_id: randomUUID() },
    );
    this.#commitIdentity = identity;
    this.#stage = "identity_created";
    return identity.value;
  }

  public async prepare(
    packet: ContentPacketDocument,
    commitIdentity: PacketCommitIdentityDocument,
    nextWorldState: WorldStateDocument,
    domainEvents: readonly DomainEventDocument[],
    materializationRequests: readonly MaterializationRequestDocument[],
  ): Promise<PacketCommitPreparation> {
    this.#requireStage("identity_created", "prepare");
    assertSamePacket(this.#packet, packet, "prepare");
    const allocatedIdentity = requireValue(
      this.#commitIdentity,
      "world.atomic_store.commit_identity_missing",
      "Commit identity was not created before prepare",
    );
    assertSameJson(
      allocatedIdentity.value,
      commitIdentity.value,
      "world.atomic_store.commit_identity_mismatch",
      "prepare received a different commit identity",
    );

    const verifiedState = this.#contracts.assertObject(
      CONTRACT_REF.worldState,
      nextWorldState.value,
    );
    const verifiedDomainEvents = Object.freeze(
      domainEvents.map((event) =>
        this.#contracts.assertObject(CONTRACT_REF.domainEvent, event.value),
      ),
    );
    const verifiedRequests = Object.freeze(
      materializationRequests.map((request) =>
        this.#contracts.assertObject(
          CONTRACT_REF.materializationRequest,
          request.value,
        ),
      ),
    );

    const eventId = expectString(
      commitIdentity.value,
      "event_id",
      "PacketCommitIdentity",
    );
    const packetWorldId = expectString(packet.value, "world_id", "ContentPacket");
    const revisionAfter = incrementRevision(this.#lockedWorld.revision);
    for (const request of verifiedRequests) {
      assertMaterializationRequestIdentity(
        request.value,
        packetWorldId,
        eventId,
      );
    }

    const clock = await this.#client.query<DatabaseClockRow>(
      "SELECT clock_timestamp() AS committed_at",
    );
    const clockRow = requireExactlyOne(clock.rows, "database clock");
    const committedAt = formatDatabaseTimestamp(clockRow.committed_at);
    const committedEvent = this.#contracts.assertObject(
      CONTRACT_REF.committedEvent,
      {
        contract_version: "world-runtime.v1",
        record_type: "committed.event",
        event_id: eventId,
        world_id: packetWorldId,
        revision_before: this.#lockedWorld.revision,
        revision_after: revisionAfter,
        committed_at: committedAt,
        packet: packet.value,
        domain_events: verifiedDomainEvents.map((event) => event.value),
      },
    );
    const result = this.#contracts.assertObject(CONTRACT_REF.applyPacketResult, {
      contract_version: "world-runtime.v1",
      record_type: "apply_packet.result",
      packet_id: expectString(packet.value, "packet_id", "ContentPacket"),
      status: "committed",
      world_revision: revisionAfter,
      committed_event_id: eventId,
    });

    this.#prepared = Object.freeze({
      commitIdentity: allocatedIdentity,
      nextWorldState: verifiedState,
      committedEvent,
      result,
      materializationRequests: verifiedRequests,
    });
    this.#stage = "prepared";
    return Object.freeze({
      committedEventCandidate: committedEvent.value,
      resultCandidate: result.value,
    });
  }

  public async commit(prepared: AuthorizedPacketCommit): Promise<void> {
    this.#requireStage("prepared", "commit");
    const artifacts = requireValue(
      this.#prepared,
      "world.atomic_store.preparation_missing",
      "Commit was requested without prepared artifacts",
    );

    const preparedPacket = expectJsonObject(
      expectProperty(artifacts.committedEvent.value, "packet", "CommittedEvent"),
      "CommittedEvent.packet",
    );
    assertSameJson(
      preparedPacket,
      prepared.packet.value,
      "world.atomic_store.packet_mismatch",
      "commit received a packet different from the prepared packet",
    );
    assertSameJson(
      artifacts.nextWorldState.value,
      prepared.nextWorldState.value,
      "world.atomic_store.prepared_state_mismatch",
      "Authorized commit world state differs from prepare",
    );
    assertSameJson(
      artifacts.committedEvent.value,
      prepared.committedEvent.value,
      "world.atomic_store.prepared_event_mismatch",
      "Authorized commit event differs from prepare",
    );
    assertSameJson(
      artifacts.result.value,
      prepared.result.value,
      "world.atomic_store.prepared_result_mismatch",
      "Authorized commit result differs from prepare",
    );
    assertSameDocumentArray(
      artifacts.materializationRequests,
      prepared.materializationRequests,
      "world.atomic_store.prepared_materialization_mismatch",
      "Authorized materialization requests differ from prepare",
    );
    assertCommitRelationships(prepared, artifacts.commitIdentity, this.#lockedWorld);

    const event = prepared.committedEvent.value;
    const result = prepared.result.value;
    const eventId = expectString(event, "event_id", "CommittedEvent");
    const packetId = expectString(prepared.packet.value, "packet_id", "ContentPacket");
    const worldId = expectString(event, "world_id", "CommittedEvent");
    const revisionBefore = expectInteger(event, "revision_before", "CommittedEvent");
    const revisionAfter = expectInteger(event, "revision_after", "CommittedEvent");
    const committedAt = expectString(event, "committed_at", "CommittedEvent");

    await this.#client.query(
      `INSERT INTO luoxia_engine.committed_events (
         event_id, packet_id, world_id, revision_before, revision_after,
         committed_at, event_document, result_document
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
         $6::timestamptz, $7::jsonb, $8::jsonb
       )`,
      [
        eventId,
        packetId,
        worldId,
        revisionBefore.toString(),
        revisionAfter.toString(),
        committedAt,
        JSON.stringify(event),
        JSON.stringify(result),
      ],
    );

    for (const [ordinal, request] of prepared.materializationRequests.entries()) {
      const requestDocument = request.value;
      assertMaterializationRequestIdentity(requestDocument, worldId, eventId);
      await this.#client.query(
        `INSERT INTO luoxia_engine.materialization_requests (
           request_id, world_id, requested_by_event_id, ordinal,
           request_document, inserted_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::integer,
           $5::jsonb, $6::timestamptz
         )`,
        [
          expectString(requestDocument, "request_id", "MaterializationRequest"),
          worldId,
          eventId,
          ordinal,
          JSON.stringify(requestDocument),
          committedAt,
        ],
      );
    }

    const update = await this.#client.query(
      `UPDATE luoxia_engine.worlds
          SET revision = $2::bigint,
              state_document = $3::jsonb,
              updated_at = $4::timestamptz
        WHERE world_id = $1::uuid
          AND revision = $5::bigint`,
      [
        worldId,
        revisionAfter.toString(),
        JSON.stringify(prepared.nextWorldState.value),
        committedAt,
        revisionBefore.toString(),
      ],
    );
    if (update.rowCount !== 1) {
      throw new EngineFault(
        "world.atomic_store.revision_conflict",
        "Locked world revision changed before the compare-and-swap update",
        { world_id: worldId, revision_before: revisionBefore },
      );
    }
    this.#stage = "committed";
  }

  public assertCallbackCompletion(result: ApplyPacketResultDocument): void {
    if (this.#stage === "duplicate") {
      const duplicate = requireValue(
        this.#duplicateResult,
        "world.atomic_store.duplicate_result_missing",
        "Duplicate path did not retain its verified result",
      );
      assertSameJson(
        duplicate.value,
        result.value,
        "world.atomic_store.callback_result_mismatch",
        "Callback returned a result different from the duplicate projection",
      );
      return;
    }

    if (this.#stage === "committed") {
      const artifacts = requireValue(
        this.#prepared,
        "world.atomic_store.preparation_missing",
        "Committed path did not retain prepared artifacts",
      );
      assertSameJson(
        artifacts.result.value,
        result.value,
        "world.atomic_store.callback_result_mismatch",
        "Callback returned a result different from the prepared commit result",
      );
      return;
    }

    throw new EngineFault(
      "world.atomic_store.commit_missing",
      "apply_packet callback returned without an authorized commit",
      { stage: this.#stage },
    );
  }

  #requireStage(expected: TransactionStage, operation: string): void {
    if (this.#stage !== expected) {
      throw new EngineFault(
        "world.atomic_store.stage_violation",
        `${operation} is not allowed during transaction stage ${this.#stage}`,
        { expected_stage: expected, actual_stage: this.#stage, operation },
      );
    }
  }
}

async function lockWorld(
  client: PoolClient,
  contracts: ContractValidator,
  packet: JsonObject,
): Promise<LockedWorld> {
  const worldId = expectString(packet, "world_id", "ContentPacket");
  const query = await client.query<LockedWorldRow>(
    `SELECT world_id::text AS world_id,
            revision::text AS revision_text,
            state_document
       FROM luoxia_engine.worlds
      WHERE world_id = $1::uuid
      FOR UPDATE`,
    [worldId],
  );
  const row = requireAtMostOne(query.rows, "world_id", worldId);
  if (row === undefined) {
    throw new EngineFault(
      "world.atomic_store.world_missing",
      "Cannot apply a packet to a world that does not exist",
      { world_id: worldId },
    );
  }
  if (row.world_id !== worldId) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "Locked world row does not match the requested world",
      { requested_world_id: worldId, locked_world_id: row.world_id },
    );
  }
  return Object.freeze({
    worldId,
    revision: parseSafeRevision(row.revision_text, worldId),
    state: contracts.assertObject(CONTRACT_REF.worldState, row.state_document),
  });
}

function assertSamePacket(
  expected: ContentPacketDocument,
  actual: ContentPacketDocument,
  operation: string,
): void {
  assertSameJson(
    expected.value,
    actual.value,
    "world.atomic_store.packet_mismatch",
    `${operation} received a packet different from the locked packet`,
  );
}

function assertSameJson(
  expected: JsonValue,
  actual: JsonValue,
  code: string,
  message: string,
): void {
  if (!jsonEquals(expected, actual)) {
    throw new EngineFault(code, message);
  }
}

function assertSameDocumentArray(
  expected: readonly MaterializationRequestDocument[],
  actual: readonly MaterializationRequestDocument[],
  code: string,
  message: string,
): void {
  if (
    expected.length !== actual.length ||
    !expected.every((entry, index) =>
      jsonEquals(entry.value, actual[index]?.value ?? null),
    )
  ) {
    throw new EngineFault(code, message);
  }
}

function assertCommitRelationships(
  prepared: AuthorizedPacketCommit,
  identity: PacketCommitIdentityDocument,
  lockedWorld: LockedWorld,
): void {
  const packet = prepared.packet.value;
  const event = prepared.committedEvent.value;
  const result = prepared.result.value;
  const packetId = expectString(packet, "packet_id", "ContentPacket");
  const packetWorldId = expectString(packet, "world_id", "ContentPacket");
  const eventId = expectString(event, "event_id", "CommittedEvent");
  const identityEventId = expectString(identity.value, "event_id", "PacketCommitIdentity");
  const eventPacket = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const revisionBefore = expectInteger(event, "revision_before", "CommittedEvent");
  const revisionAfter = expectInteger(event, "revision_after", "CommittedEvent");

  if (
    !jsonEquals(packet, eventPacket) ||
    expectString(event, "world_id", "CommittedEvent") !== packetWorldId ||
    packetWorldId !== lockedWorld.worldId ||
    eventId !== identityEventId ||
    expectString(result, "packet_id", "ApplyPacketResult") !== packetId ||
    expectString(result, "committed_event_id", "ApplyPacketResult") !== eventId ||
    expectInteger(result, "world_revision", "ApplyPacketResult") !== revisionAfter ||
    expectString(result, "status", "ApplyPacketResult") !== "committed" ||
    revisionBefore !== lockedWorld.revision ||
    revisionAfter !== incrementRevision(revisionBefore)
  ) {
    throw new EngineFault(
      "world.atomic_store.commit_artifact_mismatch",
      "Authorized commit artifacts do not represent the locked packet and revision",
      { packet_id: packetId, world_id: packetWorldId },
    );
  }
}

function assertMaterializationRequestIdentity(
  request: JsonObject,
  worldId: string,
  eventId: string,
): void {
  if (
    expectString(request, "world_id", "MaterializationRequest") !== worldId ||
    expectString(
      request,
      "requested_by_event_id",
      "MaterializationRequest",
    ) !== eventId
  ) {
    throw new EngineFault(
      "world.atomic_store.materialization_request_mismatch",
      "Materialization request does not belong to this committed event",
      { world_id: worldId, event_id: eventId },
    );
  }
}

function parseSafeRevision(value: string, worldId: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "World revision is not an unsigned integer",
      { world_id: worldId, revision: value },
    );
  }
  const revision = BigInt(value);
  if (revision > MAX_SAFE_REVISION) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "World revision exceeds the JavaScript safe integer range",
      { world_id: worldId, revision: value },
    );
  }
  return Number(revision);
}

function incrementRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new EngineFault(
      "world.atomic_store.revision_overflow",
      "World revision cannot exceed the JavaScript safe integer range",
      { revision },
    );
  }
  return revision + 1;
}

function formatDatabaseTimestamp(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "Database clock did not return a valid timestamp",
    );
  }
  return date.toISOString();
}

function requireAtMostOne<TRow>(
  rows: readonly TRow[],
  label: string,
  value: string,
): TRow | undefined {
  if (rows.length > 1) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "Database query returned more than one row for a unique lookup",
      { lookup: label, value },
    );
  }
  return rows[0];
}

function requireExactlyOne<TRow>(rows: readonly TRow[], label: string): TRow {
  if (rows.length !== 1) {
    throw new EngineFault(
      "world.atomic_store.database_corrupt",
      "Database query did not return exactly one row",
      { query: label, row_count: rows.length },
    );
  }
  return rows[0] as TRow;
}

function requireValue<TValue>(
  value: TValue | undefined,
  code: string,
  message: string,
): TValue {
  if (value === undefined) {
    throw new EngineFault(code, message);
  }
  return value;
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeStoreError(error: unknown): Error {
  if (error instanceof EngineFault || !isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const code = error.code;
  if (code === "40001" || code === "40P01") {
    return new EngineFault(
      "world.atomic_store.transient_fault",
      "PostgreSQL aborted the transaction as a transient fault",
      { postgres_code: code },
    );
  }
  if (
    code.startsWith("08") ||
    code === "57P01" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return new EngineFault(
      "world.atomic_store.unavailable",
      "PostgreSQL connection is unavailable",
      { postgres_code: code },
    );
  }

  const constraint = error.constraint;
  const mappedCode = constraintFaultCode(constraint);
  if (mappedCode !== undefined) {
    return new EngineFault(mappedCode, "PostgreSQL rejected the atomic packet write", {
      postgres_code: code,
      constraint: typeof constraint === "string" ? constraint : "",
    });
  }
  return new EngineFault(
    "world.atomic_store.database_error",
    "PostgreSQL rejected the atomic packet operation",
    {
      postgres_code: code,
      postgres_message: typeof error.message === "string" ? error.message : "",
    },
  );
}

function isPostgresError(error: unknown): error is PostgresErrorLike & { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as PostgresErrorLike).code === "string"
  );
}

function constraintFaultCode(constraint: unknown): string | undefined {
  switch (constraint) {
    case "committed_events_packet_id_unique":
      return "world.atomic_store.packet_id_conflict";
    case "committed_events_pkey":
    case "committed_events_world_event_unique":
      return "world.atomic_store.event_id_conflict";
    case "materialization_requests_pkey":
    case "materialization_requests_event_ordinal_unique":
      return "world.atomic_store.materialization_request_conflict";
    case "committed_events_world_revision_before_unique":
    case "committed_events_world_revision_after_unique":
      return "world.atomic_store.revision_conflict";
    default:
      return undefined;
  }
}
