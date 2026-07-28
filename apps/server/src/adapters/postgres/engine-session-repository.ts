import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime/portable";
import type { WorldContentLockDocument } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

import type {
  EngineSessionIdFactory,
  OpenedEngineSession,
  EngineSessionRecord,
  EngineSessionRepository,
} from "../../application/engine-session.js";
import type { SessionViewAssembler } from "../../application/session-view-assembler.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresEngineSessionRepositoryDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly idFactory: EngineSessionIdFactory;
  readonly views: SessionViewAssembler;
}

interface WorldForSessionRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
  readonly world_content_lock_document: unknown;
}

interface EngineSessionContextRow {
  readonly session_id: string;
  readonly world_id: string;
  readonly control_binding_id: string;
  readonly player_entity_id: string;
  readonly view_revision_text: string;
  readonly session_world_revision_text: string;
  readonly next_server_sequence_text: string;
  readonly nonce: string;
  readonly current_world_revision_text: string;
  readonly state_document: unknown;
  readonly world_content_lock_document: unknown;
}

export interface LockedEngineSessionContext {
  readonly session: EngineSessionRecord;
  readonly currentWorldRevision: number;
  readonly nextServerSequence: number;
  readonly worldState: JsonObject;
  readonly worldContentLock: WorldContentLockDocument;
}

export function createPostgresEngineSessionRepository(
  dependencies: PostgresEngineSessionRepositoryDependencies,
): EngineSessionRepository {
  return new PostgresEngineSessionRepository(dependencies);
}

class PostgresEngineSessionRepository implements EngineSessionRepository {
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #idFactory: EngineSessionIdFactory;
  readonly #views: SessionViewAssembler;

  public constructor(
    dependencies: PostgresEngineSessionRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#idFactory = dependencies.idFactory;
    this.#views = dependencies.views;
  }

  public async create(input: {
    readonly worldId: string;
    readonly controlBindingId: string;
  }): Promise<OpenedEngineSession> {
    const worldId = assertUuid(this.#contracts, input.worldId);
    const controlBindingId = assertUuid(
      this.#contracts,
      input.controlBindingId,
    );
    const sessionId = assertUuid(
      this.#contracts,
      this.#idFactory.createSessionId(),
    );
    const nonce = assertUuid(
      this.#contracts,
      this.#idFactory.createNonce(),
    );

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const worldQuery = await client.query<WorldForSessionRow>(
            `SELECT world_id::text AS world_id,
                    revision::text AS revision_text,
                    state_document,
                    world_content_lock_document
               FROM luoxia_engine.worlds
              WHERE world_id = $1::uuid
              FOR SHARE`,
            [worldId],
          );
          const worldRow = requireAtMostOne(
            worldQuery.rows,
            "session.database_corrupt",
            "World lookup returned more than one row while opening Session",
            { world_id: worldId },
          );
          if (worldRow === undefined) {
            throw new EngineFault(
              "session.world_missing",
              "Engine Session cannot open for a missing world",
              { world_id: worldId },
            );
          }
          if (
            assertUuid(this.#contracts, worldRow.world_id) !== worldId
          ) {
            throw new EngineFault(
              "session.database_corrupt",
              "World row identity differs from the Session open request",
              { world_id: worldId, row_world_id: worldRow.world_id },
            );
          }
          const worldRevision = parseSafeUnsignedInteger(
            worldRow.revision_text,
            "session.database_corrupt",
            "World revision",
            { world_id: worldId, revision: worldRow.revision_text },
          );
          const worldState = this.#contracts.assertObject(
            CONTRACT_REF.worldState,
            worldRow.state_document,
          );
          const worldContentLock = this.#contracts.assertObject(
            CONTRACT_REF.worldContentLock,
            worldRow.world_content_lock_document,
          );
          const playerEntityId = requireActiveHumanBinding(
            worldState.value,
            controlBindingId,
            "session.open",
          );

          const insert = await client.query(
            `INSERT INTO luoxia_engine.engine_sessions (
               session_id,
               world_id,
               control_binding_id,
               player_entity_id,
               view_revision,
               world_revision,
               next_server_sequence,
               nonce,
               created_at,
               updated_at
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4::uuid,
               0,
               $5::bigint,
               0,
               $6::uuid,
               clock_timestamp(),
               clock_timestamp()
             )`,
            [
              sessionId,
              worldId,
              controlBindingId,
              playerEntityId,
              worldRevision.toString(),
              nonce,
            ],
          );
          if (insert.rowCount !== 1) {
            throw new EngineFault(
              "session.database_corrupt",
              "Engine Session INSERT did not affect exactly one row",
              { session_id: sessionId },
            );
          }
          const session: EngineSessionRecord = Object.freeze({
            sessionId,
            worldId,
            controlBindingId,
            playerEntityId,
            viewRevision: 0,
            worldRevision,
            nonce,
          });
          const view = this.#views.assemble({
            session,
            worldState: worldState.value,
            worldContentLock,
            noticeCandidates: [],
          });
          return Object.freeze({ session, view });
        },
      );
    } catch (error: unknown) {
      throw normalizeSessionError(error, sessionId, worldId);
    }
  }

  public async readCurrent(sessionId: string): Promise<EngineSessionRecord> {
    const verifiedSessionId = assertUuid(this.#contracts, sessionId);
    try {
      return await withPostgresClient(this.#pool, async (client) => {
        const context = await readEngineSessionContext(
          client,
          this.#contracts,
          verifiedSessionId,
          "",
        );
        assertSessionWorldCurrent(context);
        return context.session;
      });
    } catch (error: unknown) {
      throw normalizeSessionError(error, verifiedSessionId);
    }
  }

  public async advanceView(input: {
    readonly sessionId: string;
    readonly expectedViewRevision: number;
  }): Promise<EngineSessionRecord> {
    const sessionId = assertUuid(this.#contracts, input.sessionId);
    assertSafeUnsignedInteger(
      input.expectedViewRevision,
      "session.view_revision_invalid",
      "expectedViewRevision",
      {
        session_id: sessionId,
        expected_view_revision: input.expectedViewRevision,
      },
    );
    if (input.expectedViewRevision === Number.MAX_SAFE_INTEGER) {
      throw new EngineFault(
        "session.view_revision_exhausted",
        "Engine Session view revision cannot be incremented safely",
        { session_id: sessionId },
      );
    }

    try {
      return await withPostgresTransaction(
        this.#pool,
        "BEGIN ISOLATION LEVEL READ COMMITTED",
        async (client) => {
          const context = await readEngineSessionContext(
            client,
            this.#contracts,
            sessionId,
            "FOR UPDATE OF s FOR SHARE OF w",
          );
          if (
            context.session.viewRevision !== input.expectedViewRevision
          ) {
            throw new EngineFault(
              "session.view_revision_conflict",
              "Engine Session view revision changed before advance",
              {
                session_id: sessionId,
                expected_view_revision: input.expectedViewRevision,
                actual_view_revision: context.session.viewRevision,
              },
            );
          }
          const nextViewRevision = input.expectedViewRevision + 1;
          const update = await client.query(
            `UPDATE luoxia_engine.engine_sessions
                SET view_revision = $2::bigint,
                    world_revision = $3::bigint,
                    updated_at = clock_timestamp()
              WHERE session_id = $1::uuid
                AND view_revision = $4::bigint`,
            [
              sessionId,
              nextViewRevision.toString(),
              context.currentWorldRevision.toString(),
              input.expectedViewRevision.toString(),
            ],
          );
          if (update.rowCount !== 1) {
            throw new EngineFault(
              "session.view_revision_conflict",
              "Engine Session view revision changed before compare-and-swap",
              {
                session_id: sessionId,
                expected_view_revision: input.expectedViewRevision,
              },
            );
          }
          return Object.freeze({
            ...context.session,
            viewRevision: nextViewRevision,
            worldRevision: context.currentWorldRevision,
          });
        },
      );
    } catch (error: unknown) {
      throw normalizeSessionError(error, sessionId);
    }
  }
}

/**
 * Shared command/session lock path. The caller controls the constant lock
 * clause; no untrusted value is interpolated into SQL.
 */
export async function readEngineSessionContext(
  client: PoolClient,
  contracts: ContractValidator,
  sessionId: string,
  lockClause: "" | "FOR UPDATE OF s FOR SHARE OF w",
): Promise<LockedEngineSessionContext> {
  const query = await client.query<EngineSessionContextRow>(
    `SELECT s.session_id::text AS session_id,
            s.world_id::text AS world_id,
            s.control_binding_id::text AS control_binding_id,
            s.player_entity_id::text AS player_entity_id,
            s.view_revision::text AS view_revision_text,
            s.world_revision::text AS session_world_revision_text,
            s.next_server_sequence::text AS next_server_sequence_text,
            s.nonce::text AS nonce,
            w.revision::text AS current_world_revision_text,
            w.state_document,
            w.world_content_lock_document
       FROM luoxia_engine.engine_sessions AS s
       JOIN luoxia_engine.worlds AS w
         ON w.world_id = s.world_id
      WHERE s.session_id = $1::uuid
      ${lockClause}`,
    [sessionId],
  );
  const row = requireAtMostOne(
    query.rows,
    "session.database_corrupt",
    "Engine Session lookup returned more than one row",
    { session_id: sessionId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "session.missing",
      "Engine Session does not exist",
      { session_id: sessionId },
    );
  }
  const record = validateSessionContextRow(contracts, row, sessionId);
  const worldState = contracts.assertObject(
    CONTRACT_REF.worldState,
    row.state_document,
  );
  const worldContentLock = contracts.assertObject(
    CONTRACT_REF.worldContentLock,
    row.world_content_lock_document,
  );
  const currentWorldRevision = parseSafeUnsignedInteger(
    row.current_world_revision_text,
    "session.database_corrupt",
    "Current world revision",
    {
      session_id: sessionId,
      world_id: record.worldId,
      revision: row.current_world_revision_text,
    },
  );
  const nextServerSequence = parseSafeUnsignedInteger(
    row.next_server_sequence_text,
    "session.database_corrupt",
    "Next ServerEnvelope sequence",
    {
      session_id: sessionId,
      world_id: record.worldId,
      sequence: row.next_server_sequence_text,
    },
  );
  const boundPlayer = requireActiveHumanBinding(
    worldState.value,
    record.controlBindingId,
    "session.current",
  );
  if (boundPlayer !== record.playerEntityId) {
    throw new EngineFault(
      "session.control_binding_changed",
      "Engine Session human ControlBinding now targets a different entity",
      {
        session_id: sessionId,
        control_binding_id: record.controlBindingId,
        session_player_entity_id: record.playerEntityId,
        current_player_entity_id: boundPlayer,
      },
    );
  }
  return Object.freeze({
    session: record,
    currentWorldRevision,
    nextServerSequence,
    worldState: worldState.value,
    worldContentLock,
  });
}

export function assertSessionWorldCurrent(
  context: LockedEngineSessionContext,
): void {
  if (context.session.worldRevision !== context.currentWorldRevision) {
    throw new EngineFault(
      "session.world_revision_stale",
      "Engine Session basis is stale because the world revision changed",
      {
        session_id: context.session.sessionId,
        session_world_revision: context.session.worldRevision,
        current_world_revision: context.currentWorldRevision,
      },
    );
  }
}

function validateSessionContextRow(
  contracts: ContractValidator,
  row: EngineSessionContextRow,
  expectedSessionId: string,
): EngineSessionRecord {
  const sessionId = assertUuid(contracts, row.session_id);
  const worldId = assertUuid(contracts, row.world_id);
  const controlBindingId = assertUuid(contracts, row.control_binding_id);
  const playerEntityId = assertUuid(contracts, row.player_entity_id);
  const nonce = assertUuid(contracts, row.nonce);
  const viewRevision = parseSafeUnsignedInteger(
    row.view_revision_text,
    "session.database_corrupt",
    "Session view revision",
    { session_id: expectedSessionId, revision: row.view_revision_text },
  );
  const worldRevision = parseSafeUnsignedInteger(
    row.session_world_revision_text,
    "session.database_corrupt",
    "Session world revision",
    {
      session_id: expectedSessionId,
      revision: row.session_world_revision_text,
    },
  );
  if (sessionId !== expectedSessionId) {
    throw new EngineFault(
      "session.database_corrupt",
      "Engine Session row identity differs from its lookup key",
      { session_id: expectedSessionId, row_session_id: sessionId },
    );
  }
  return Object.freeze({
    sessionId,
    worldId,
    controlBindingId,
    playerEntityId,
    viewRevision,
    worldRevision,
    nonce,
  });
}

function requireActiveHumanBinding(
  worldState: JsonObject,
  controlBindingId: string,
  phase: string,
): string {
  const bindings = asObjectArray(
    expectProperty(worldState, "control_bindings", "WorldState"),
    "WorldState.control_bindings",
  );
  const matches = bindings.filter(
    (binding) =>
      expectString(binding, "binding_id", "ControlBinding") ===
      controlBindingId,
  );
  const binding = requireAtMostOne(
    matches,
    "session.world_state_corrupt",
    "WorldState contains duplicate ControlBinding identities",
    { control_binding_id: controlBindingId, phase },
  );
  if (binding === undefined) {
    throw new EngineFault(
      "session.control_binding_missing",
      "Engine Session human ControlBinding is absent from WorldState",
      { control_binding_id: controlBindingId, phase },
    );
  }
  const bindingKind = expectString(
    binding,
    "binding_kind",
    "ControlBinding",
  );
  const status = expectString(binding, "status", "ControlBinding");
  if (bindingKind !== "human" || status !== "active") {
    throw new EngineFault(
      "session.control_binding_unavailable",
      "Engine Session requires an active human ControlBinding",
      {
        control_binding_id: controlBindingId,
        binding_kind: bindingKind,
        status,
        phase,
      },
    );
  }
  const entityId = expectString(binding, "entity_id", "ControlBinding");
  const entities = asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  );
  const entityMatches = entities.filter(
    (entity) =>
      expectString(entity, "entity_id", "EntityState") === entityId,
  );
  const entity = requireAtMostOne(
    entityMatches,
    "session.world_state_corrupt",
    "WorldState contains duplicate player Entity identities",
    { entity_id: entityId, phase },
  );
  if (
    entity === undefined ||
    expectString(entity, "state", "EntityState") !== "active"
  ) {
    throw new EngineFault(
      "session.player_entity_unavailable",
      "Engine Session player entity must exist and be active",
      { entity_id: entityId, phase },
    );
  }
  return entityId;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "session.world_state_corrupt",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeSessionError(
  error: unknown,
  sessionId: string,
  worldId?: string,
): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const constraint =
    typeof error.constraint === "string" ? error.constraint : "";
  if (constraint === "engine_sessions_pkey") {
    return new EngineFault(
      "session.session_id_conflict",
      "Generated Engine Session identity already exists",
      { session_id: sessionId },
    );
  }
  if (constraint === "engine_sessions_world_id_fkey") {
    return new EngineFault(
      "session.world_missing",
      "Engine Session references a missing world",
      {
        session_id: sessionId,
        ...(worldId === undefined ? {} : { world_id: worldId }),
      },
    );
  }
  return new EngineFault(
    "session.database_error",
    "PostgreSQL rejected the Engine Session operation",
    {
      session_id: sessionId,
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
