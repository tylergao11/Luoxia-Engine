import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime/portable";
import type { CommittedEventDocument } from "@luoxia/world-core/composition";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";
import type { Pool, PoolClient } from "pg";

import type {
  CommittedEventReader,
  CommittedEventRevisionRange,
  CommittedPacketReader,
  CommittedPacketRecord,
  RuntimeWorldReader,
  RuntimeWorldRecord,
} from "../../application/runtime-persistence.js";
import {
  assertSafeUnsignedInteger,
  assertUuid,
  parseSafeUnsignedInteger,
  requireAtMostOne,
  withPostgresClient,
  withPostgresTransaction,
} from "./persistence-support.js";

export interface PostgresRuntimeReadersDependencies {
  readonly pool: Pool;
  readonly contracts: ContractValidator;
}

export interface PostgresRuntimeReaders {
  readonly worlds: RuntimeWorldReader;
  readonly committedEvents: CommittedEventReader;
  readonly committedPackets: CommittedPacketReader;
}

export function createPostgresRuntimeReaders(
  dependencies: PostgresRuntimeReadersDependencies,
): PostgresRuntimeReaders {
  const readers = new PostgresRuntimeReadersAdapter(dependencies);
  return Object.freeze({
    worlds: readers,
    committedEvents: readers,
    committedPackets: readers,
  });
}

class PostgresRuntimeReadersAdapter
  implements RuntimeWorldReader, CommittedEventReader, CommittedPacketReader
{
  readonly #pool: Pool;
  readonly #contracts: ContractValidator;

  public constructor(dependencies: PostgresRuntimeReadersDependencies) {
    this.#pool = dependencies.pool;
    this.#contracts = dependencies.contracts;
  }

  public async readCurrent(worldId: string): Promise<RuntimeWorldRecord> {
    const verifiedWorldId = assertUuid(this.#contracts, worldId);
    return withPostgresClient(this.#pool, (client) =>
      readWorldRecord(client, this.#contracts, verifiedWorldId),
    );
  }

  public async readRevisionRange(
    range: CommittedEventRevisionRange,
  ): Promise<readonly CommittedEventDocument[]> {
    const worldId = assertUuid(this.#contracts, range.worldId);
    assertSafeUnsignedInteger(
      range.afterRevisionExclusive,
      "runtime.committed_event.range_invalid",
      "afterRevisionExclusive",
      {
        world_id: worldId,
        after_revision_exclusive: range.afterRevisionExclusive,
      },
    );
    assertSafeUnsignedInteger(
      range.throughRevisionInclusive,
      "runtime.committed_event.range_invalid",
      "throughRevisionInclusive",
      {
        world_id: worldId,
        through_revision_inclusive: range.throughRevisionInclusive,
      },
    );
    if (range.throughRevisionInclusive < range.afterRevisionExclusive) {
      throw new EngineFault(
        "runtime.committed_event.range_invalid",
        "Committed event revision range is reversed",
        {
          world_id: worldId,
          after_revision_exclusive: range.afterRevisionExclusive,
          through_revision_inclusive: range.throughRevisionInclusive,
        },
      );
    }

    return withPostgresTransaction(
      this.#pool,
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      async (client) => {
        const record = await readWorldRecord(
          client,
          this.#contracts,
          worldId,
        );
        const currentRevision = expectInteger(
          record.snapshot.value,
          "world_revision",
          "WorldSnapshot",
        );
        if (range.throughRevisionInclusive > currentRevision) {
          throw new EngineFault(
            "runtime.committed_event.range_uncommitted",
            "Committed event range extends beyond the current world revision",
            {
              world_id: worldId,
              current_revision: currentRevision,
              through_revision_inclusive: range.throughRevisionInclusive,
            },
          );
        }

        const query = await client.query<CommittedEventRow>(
          `SELECT event_id::text AS event_id,
                  packet_id::text AS packet_id,
                  world_id::text AS world_id,
                  revision_before::text AS revision_before_text,
                  revision_after::text AS revision_after_text,
                  committed_at,
                  event_document
             FROM luoxia_engine.committed_events
            WHERE world_id = $1::uuid
              AND revision_after > $2::bigint
              AND revision_after <= $3::bigint
            ORDER BY revision_after ASC`,
          [
            worldId,
            range.afterRevisionExclusive.toString(),
            range.throughRevisionInclusive.toString(),
          ],
        );

        const expectedCount =
          range.throughRevisionInclusive - range.afterRevisionExclusive;
        if (query.rows.length !== expectedCount) {
          throw new EngineFault(
            "runtime.committed_event.log_corrupt",
            "Committed event log is not contiguous for the requested range",
            {
              world_id: worldId,
              expected_count: expectedCount,
              actual_count: query.rows.length,
            },
          );
        }

        const events = query.rows.map((row, index) =>
          validateCommittedEventRow(
            this.#contracts,
            row,
            worldId,
            range.afterRevisionExclusive + index + 1,
          ),
        );
        return Object.freeze(events);
      },
    );
  }

  public async readByPacketId(
    packetId: string,
  ): Promise<CommittedPacketRecord | undefined> {
    const verifiedPacketId = assertUuid(this.#contracts, packetId);
    return withPostgresClient(this.#pool, async (client) => {
      const query = await client.query<CommittedPacketRow>(
        `SELECT event_id::text AS event_id,
                packet_id::text AS packet_id,
                world_id::text AS world_id,
                revision_before::text AS revision_before_text,
                revision_after::text AS revision_after_text,
                committed_at,
                event_document,
                result_document
           FROM luoxia_engine.committed_events
          WHERE packet_id = $1::uuid`,
        [verifiedPacketId],
      );
      const row = requireAtMostOne(
        query.rows,
        "runtime.committed_packet.database_corrupt",
        "packet_id lookup returned more than one committed packet",
        { packet_id: verifiedPacketId },
      );
      if (row === undefined) {
        return undefined;
      }

      const revisionAfter = parseSafeUnsignedInteger(
        row.revision_after_text,
        "runtime.committed_packet.database_corrupt",
        "Committed packet revision_after",
        { packet_id: verifiedPacketId, revision: row.revision_after_text },
      );
      const event = validateCommittedEventRow(
        this.#contracts,
        row,
        row.world_id,
        revisionAfter,
      );
      const result = validateCommittedPacketResult(
        this.#contracts,
        row,
        event,
        revisionAfter,
      );
      return Object.freeze({ event, result });
    });
  }
}

interface WorldRow {
  readonly world_id: string;
  readonly revision_text: string;
  readonly state_document: unknown;
  readonly world_content_lock_document: unknown;
}

interface CommittedEventRow {
  readonly event_id: string;
  readonly packet_id: string;
  readonly world_id: string;
  readonly revision_before_text: string;
  readonly revision_after_text: string;
  readonly committed_at: Date | string;
  readonly event_document: unknown;
}

interface CommittedPacketRow extends CommittedEventRow {
  readonly result_document: unknown;
}

/**
 * One SELECT yields both WorldSnapshot and WorldContentLock for the same row.
 * apply_packet never mutates world_content_lock_document.
 */
async function readWorldRecord(
  client: PoolClient,
  contracts: ContractValidator,
  worldId: string,
): Promise<RuntimeWorldRecord> {
  const query = await client.query<WorldRow>(
    `SELECT world_id::text AS world_id,
            revision::text AS revision_text,
            state_document,
            world_content_lock_document
       FROM luoxia_engine.worlds
      WHERE world_id = $1::uuid`,
    [worldId],
  );
  const row = requireAtMostOne(
    query.rows,
    "runtime.world.database_corrupt",
    "World lookup returned more than one row",
    { world_id: worldId },
  );
  if (row === undefined) {
    throw new EngineFault(
      "runtime.world.missing",
      "Requested world does not exist",
      { world_id: worldId },
    );
  }
  if (row.world_id !== worldId) {
    throw new EngineFault(
      "runtime.world.database_corrupt",
      "World row identity does not match the requested world",
      { world_id: worldId, row_world_id: row.world_id },
    );
  }

  const revision = parseSafeUnsignedInteger(
    row.revision_text,
    "runtime.world.database_corrupt",
    "World revision",
    { world_id: worldId, revision: row.revision_text },
  );
  const worldState = contracts.assertObject(
    CONTRACT_REF.worldState,
    row.state_document,
  );
  const snapshot = contracts.assertObject(CONTRACT_REF.worldSnapshot, {
    world_id: row.world_id,
    world_revision: revision,
    world_state: worldState.value,
  });
  if (
    expectString(snapshot.value, "world_id", "WorldSnapshot") !== worldId ||
    expectInteger(snapshot.value, "world_revision", "WorldSnapshot") !==
      revision
  ) {
    throw new EngineFault(
      "runtime.world.database_corrupt",
      "Validated WorldSnapshot identity does not match its database row",
      { world_id: worldId, revision },
    );
  }

  const worldContentLock: WorldContentLockDocument = contracts.assertObject(
    CONTRACT_REF.worldContentLock,
    row.world_content_lock_document,
  );

  return Object.freeze({
    snapshot,
    worldContentLock,
  });
}

function validateCommittedEventRow(
  contracts: ContractValidator,
  row: CommittedEventRow,
  worldId: string,
  expectedRevisionAfter: number,
): CommittedEventDocument {
  const revisionBefore = parseSafeUnsignedInteger(
    row.revision_before_text,
    "runtime.committed_event.database_corrupt",
    "Committed event revision_before",
    { event_id: row.event_id, revision: row.revision_before_text },
  );
  const revisionAfter = parseSafeUnsignedInteger(
    row.revision_after_text,
    "runtime.committed_event.database_corrupt",
    "Committed event revision_after",
    { event_id: row.event_id, revision: row.revision_after_text },
  );
  const event = contracts.assertObject(
    CONTRACT_REF.committedEvent,
    row.event_document,
  );
  const committedAt = formatDatabaseTimestamp(row.committed_at, row.event_id);
  const packet = expectJsonObject(
    expectProperty(event.value, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );

  if (
    row.world_id !== worldId ||
    revisionAfter !== expectedRevisionAfter ||
    revisionBefore !== expectedRevisionAfter - 1 ||
    expectString(event.value, "event_id", "CommittedEvent") !== row.event_id ||
    expectString(event.value, "world_id", "CommittedEvent") !== worldId ||
    expectInteger(event.value, "revision_before", "CommittedEvent") !==
      revisionBefore ||
    expectInteger(event.value, "revision_after", "CommittedEvent") !==
      revisionAfter ||
    expectString(event.value, "committed_at", "CommittedEvent") !==
      committedAt ||
    expectString(packet, "packet_id", "ContentPacket") !== row.packet_id ||
    expectString(packet, "world_id", "ContentPacket") !== worldId
  ) {
    throw new EngineFault(
      "runtime.committed_event.database_corrupt",
      "Committed event document identity does not match its database row",
      {
        event_id: row.event_id,
        world_id: worldId,
        revision_after: revisionAfter,
      },
    );
  }
  return event;
}

function validateCommittedPacketResult(
  contracts: ContractValidator,
  row: CommittedPacketRow,
  event: CommittedEventDocument,
  revisionAfter: number,
): ApplyPacketResultDocument {
  const result = contracts.assertObject(
    CONTRACT_REF.applyPacketResult,
    row.result_document,
  );
  if (
    expectString(result.value, "packet_id", "ApplyPacketResult") !==
      row.packet_id ||
    expectString(result.value, "committed_event_id", "ApplyPacketResult") !==
      row.event_id ||
    expectInteger(result.value, "world_revision", "ApplyPacketResult") !==
      revisionAfter ||
    expectString(result.value, "status", "ApplyPacketResult") !==
      "committed" ||
    expectString(event.value, "event_id", "CommittedEvent") !== row.event_id
  ) {
    throw new EngineFault(
      "runtime.committed_packet.database_corrupt",
      "Committed packet result does not match its event row",
      { packet_id: row.packet_id, event_id: row.event_id },
    );
  }
  return result;
}

function formatDatabaseTimestamp(
  value: Date | string,
  eventId: string,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new EngineFault(
      "runtime.committed_event.database_corrupt",
      "Committed event timestamp is invalid",
      { event_id: eventId },
    );
  }
  return date.toISOString();
}
