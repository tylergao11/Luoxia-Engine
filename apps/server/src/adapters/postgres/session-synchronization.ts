import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type { WorldContentLockDocument } from "@luoxia/world-core";
import type { Pool } from "pg";

import type { EngineSessionRecord } from "../../application/engine-session.js";
import type {
  ServerEnvelopeDocument,
  ServerEnvelopeFactory,
} from "../../application/server-envelope.js";
import type { SessionSynchronizationService } from "../../application/session-synchronization.js";
import type { SessionViewAssembler } from "../../application/session-view-assembler.js";
import { readEngineSessionContext } from "./engine-session-repository.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  withPostgresTransaction,
} from "./persistence-support.js";

const CLIENT_BRIDGE_PROTOCOL = "client-bridge.v1";

export interface PostgresSessionSynchronizationDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
  readonly views: SessionViewAssembler;
  readonly envelopes: ServerEnvelopeFactory;
}

export function createPostgresSessionSynchronization(
  dependencies: PostgresSessionSynchronizationDependencies,
): SessionSynchronizationService {
  return new PostgresSessionSynchronization(dependencies);
}

class PostgresSessionSynchronization
  implements SessionSynchronizationService
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;
  readonly #views: SessionViewAssembler;
  readonly #envelopes: ServerEnvelopeFactory;

  public constructor(
    dependencies: PostgresSessionSynchronizationDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
    this.#views = dependencies.views;
    this.#envelopes = dependencies.envelopes;
  }

  public async execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const envelope = this.#contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      clientEnvelopeCandidate,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ClientEnvelope"),
      "ClientEnvelope.message",
    );
    const messageType = expectString(
      message,
      "type",
      "ClientMessage",
    );
    const sessionId = assertUuid(
      this.#contracts,
      expectString(envelope.value, "session_id", "ClientEnvelope"),
    );
    const requestMessageId = assertUuid(
      this.#contracts,
      expectString(envelope.value, "message_id", "ClientEnvelope"),
    );
    const request = readSynchronizationRequest(
      message,
      messageType,
      sessionId,
    );

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
            request.kind === "resync" &&
            request.currentViewRevision >
              context.session.viewRevision
          ) {
            throw new EngineFault(
              "session.resync.client_revision_ahead",
              "Client view revision is ahead of the authoritative Session",
              {
                session_id: sessionId,
                client_view_revision: request.currentViewRevision,
                server_view_revision: context.session.viewRevision,
              },
            );
          }
          if (
            context.session.worldRevision >
            context.currentWorldRevision
          ) {
            throw new EngineFault(
              "session.synchronization.database_corrupt",
              "Engine Session world revision is ahead of its current world",
              {
                session_id: sessionId,
                session_world_revision:
                  context.session.worldRevision,
                current_world_revision:
                  context.currentWorldRevision,
              },
            );
          }

          const publishesView =
            request.kind === "resync" ||
            request.protocolSupported;
          const nextSession = publishesView
            ? refreshSessionRevision(
                context.session,
                context.currentWorldRevision,
              )
            : context.session;
          const messages = publishesView
            ? createSessionViewMessage(
                this.#views,
                nextSession,
                context.worldState,
                context.worldContentLock,
              )
            : createUnsupportedProtocolMessage(request);
          const envelopes = this.#envelopes.createBatch({
            sessionId,
            correlationId: requestMessageId,
            firstSequence: context.nextServerSequence,
            messages,
          });
          const nextServerSequence =
            context.nextServerSequence + envelopes.length;
          const update = await client.query(
            `UPDATE luoxia_engine.engine_sessions
                SET view_revision = $2::bigint,
                    world_revision = $3::bigint,
                    next_server_sequence = $4::bigint,
                    updated_at = clock_timestamp()
              WHERE session_id = $1::uuid
                AND view_revision = $5::bigint
                AND world_revision = $6::bigint
                AND next_server_sequence = $7::bigint`,
            [
              sessionId,
              nextSession.viewRevision.toString(),
              nextSession.worldRevision.toString(),
              nextServerSequence.toString(),
              context.session.viewRevision.toString(),
              context.session.worldRevision.toString(),
              context.nextServerSequence.toString(),
            ],
          );
          if (update.rowCount !== 1) {
            throw new EngineFault(
              "session.synchronization.session_conflict",
              "Engine Session changed before synchronization compare-and-swap",
              { session_id: sessionId },
            );
          }
          return envelopes;
        },
      );
    } catch (error: unknown) {
      throw normalizeSynchronizationError(error, sessionId);
    }
  }
}

type SynchronizationRequest =
  | {
      readonly kind: "ready";
      readonly clientBuildDigest: string;
      readonly protocolSupported: boolean;
      readonly supportedProtocols: readonly string[];
    }
  | {
      readonly kind: "resync";
      readonly currentViewRevision: number;
    };

function readSynchronizationRequest(
  message: JsonObject,
  messageType: string,
  sessionId: string,
): SynchronizationRequest {
  if (messageType === "client.ready") {
    const supportedProtocols = readStringArray(
      expectProperty(message, "supported_protocols", "ClientReady"),
      "ClientReady.supported_protocols",
    );
    return Object.freeze({
      kind: "ready",
      clientBuildDigest: expectString(
        message,
        "client_build_digest",
        "ClientReady",
      ),
      protocolSupported: supportedProtocols.includes(
        CLIENT_BRIDGE_PROTOCOL,
      ),
      supportedProtocols,
    });
  }
  if (messageType === "session.resync_request") {
    const currentViewRevision = expectInteger(
      message,
      "current_view_revision",
      "ResyncRequest",
    );
    assertSafeUnsignedInteger(
      currentViewRevision,
      "session.resync.view_revision_invalid",
      "ResyncRequest.current_view_revision",
      {
        session_id: sessionId,
        current_view_revision: currentViewRevision,
      },
    );
    return Object.freeze({
      kind: "resync",
      currentViewRevision,
    });
  }
  throw new EngineFault(
    "session.synchronization.message_type_invalid",
    "Session synchronization accepts only client.ready or session.resync_request",
    { message_type: messageType },
  );
}

function createSessionViewMessage(
  views: SessionViewAssembler,
  session: EngineSessionRecord,
  worldState: JsonObject,
  worldContentLock: WorldContentLockDocument,
): readonly JsonObject[] {
  const view = views.assemble({
    session,
    worldState,
    worldContentLock,
    noticeCandidates: [],
  });
  return Object.freeze([
    Object.freeze({
      type: "session.view",
      view: view.value,
    }),
  ]);
}

function createUnsupportedProtocolMessage(
  request: Extract<SynchronizationRequest, { readonly kind: "ready" }>,
): readonly JsonObject[] {
  return Object.freeze([
    Object.freeze({
      type: "protocol.error",
      code: "client.protocol.unsupported",
      message:
        "Client does not support the Server Client Bridge protocol",
      recoverability: "fatal",
      details: Object.freeze({
        required_protocol: CLIENT_BRIDGE_PROTOCOL,
        client_build_digest: request.clientBuildDigest,
        supported_protocols: request.supportedProtocols,
      }),
    }),
  ]);
}

function readStringArray(
  value: JsonValue,
  path: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "session.synchronization.message_shape_invalid",
      `${path} must be an array`,
      { path },
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string") {
        throw new EngineFault(
          "session.synchronization.message_shape_invalid",
          `${path}[${index}] must be a string`,
          { path: `${path}[${index}]` },
        );
      }
      return entry;
    }),
  );
}

function refreshSessionRevision(
  session: EngineSessionRecord,
  currentWorldRevision: number,
): EngineSessionRecord {
  if (session.worldRevision === currentWorldRevision) {
    return session;
  }
  if (session.viewRevision === Number.MAX_SAFE_INTEGER) {
    throw new EngineFault(
      "session.synchronization.view_revision_exhausted",
      "Engine Session view revision cannot be incremented safely",
      { session_id: session.sessionId },
    );
  }
  return Object.freeze({
    ...session,
    viewRevision: session.viewRevision + 1,
    worldRevision: currentWorldRevision,
  });
}

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function normalizeSynchronizationError(
  error: unknown,
  sessionId: string,
): Error {
  if (error instanceof EngineFault) {
    return error;
  }
  if (!isPostgresError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new EngineFault(
    "session.synchronization.database_error",
    "PostgreSQL rejected the Session synchronization operation",
    {
      session_id: sessionId,
      postgres_code: error.code,
      constraint:
        typeof error.constraint === "string" ? error.constraint : "",
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
