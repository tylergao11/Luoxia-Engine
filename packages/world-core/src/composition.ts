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
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime/portable";

import type {
  ApplyPacketResultDocument,
  WorldAuthority,
} from "./world-authority.js";

export type ContentPacketDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.contentPacket
>;

export type WorldStateDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.worldState
>;

export type CommittedEventDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.committedEvent
>;

export interface PacketSemanticGate {
  assertApplicable(
    packet: ContentPacketDocument,
    snapshot: WorldStateDocument,
  ): Promise<void>;
}

export interface PacketCommitPreparation {
  readonly nextWorldStateCandidate: unknown;
  readonly committedEventCandidate: unknown;
  readonly resultCandidate: unknown;
}

export interface AuthorizedPacketCommit {
  readonly packet: ContentPacketDocument;
  readonly nextWorldState: WorldStateDocument;
  readonly committedEvent: CommittedEventDocument;
  readonly result: ApplyPacketResultDocument;
}

export interface LockedWorldTransaction {
  readDuplicateResult(packet: ContentPacketDocument): Promise<unknown | undefined>;
  readSnapshot(): Promise<unknown>;
  prepare(packet: ContentPacketDocument): Promise<PacketCommitPreparation>;
  commit(prepared: AuthorizedPacketCommit): Promise<void>;
}

export interface AtomicPacketStore {
  withLockedWorld(
    packet: ContentPacketDocument,
    operation: (
      transaction: LockedWorldTransaction,
    ) => Promise<ApplyPacketResultDocument>,
  ): Promise<ApplyPacketResultDocument>;
}

export interface WorldCoreDependencies {
  readonly contracts: ContractValidator;
  readonly semanticGate: PacketSemanticGate;
  readonly store: AtomicPacketStore;
}

export function createWorldCore(
  dependencies: WorldCoreDependencies,
): WorldAuthority {
  return new DefaultWorldAuthority(dependencies);
}

class DefaultWorldAuthority implements WorldAuthority {
  readonly #contracts: ContractValidator;
  readonly #semanticGate: PacketSemanticGate;
  readonly #store: AtomicPacketStore;

  public constructor(dependencies: WorldCoreDependencies) {
    this.#contracts = dependencies.contracts;
    this.#semanticGate = dependencies.semanticGate;
    this.#store = dependencies.store;
  }

  public async applyPacket(
    candidate: unknown,
  ): Promise<ApplyPacketResultDocument> {
    const packet = this.#contracts.assertObject(
      CONTRACT_REF.contentPacket,
      candidate,
    );

    return this.#store.withLockedWorld(
      packet,
      async (
        transaction: LockedWorldTransaction,
      ): Promise<ApplyPacketResultDocument> => {
        const duplicateCandidate = await transaction.readDuplicateResult(packet);
        if (duplicateCandidate !== undefined) {
          const duplicate = this.#contracts.assertObject(
            CONTRACT_REF.applyPacketResult,
            duplicateCandidate,
          );
          assertPacketResult(packet.value, duplicate.value, "duplicate");
          return duplicate;
        }

        const snapshot = this.#contracts.assertObject(
          CONTRACT_REF.worldState,
          await transaction.readSnapshot(),
        );
        await this.#semanticGate.assertApplicable(packet, snapshot);

        const preparation = await transaction.prepare(packet);
        const nextWorldState = this.#contracts.assertObject(
          CONTRACT_REF.worldState,
          preparation.nextWorldStateCandidate,
        );
        const committedEvent = this.#contracts.assertObject(
          CONTRACT_REF.committedEvent,
          preparation.committedEventCandidate,
        );
        const result = this.#contracts.assertObject(
          CONTRACT_REF.applyPacketResult,
          preparation.resultCandidate,
        );

        assertPacketResult(packet.value, result.value, "committed");
        assertCommittedEvent(packet.value, committedEvent.value, result.value);

        await transaction.commit(
          Object.freeze({
            packet,
            nextWorldState,
            committedEvent,
            result,
          }),
        );
        return result;
      },
    );
  }
}

function assertPacketResult(
  packet: JsonObject,
  result: JsonObject,
  expectedStatus: "committed" | "duplicate",
): void {
  const packetId = expectString(packet, "packet_id", "ContentPacket");
  const resultPacketId = expectString(
    result,
    "packet_id",
    "ApplyPacketResult",
  );
  const status = expectString(result, "status", "ApplyPacketResult");

  if (packetId !== resultPacketId || status !== expectedStatus) {
    throw new EngineFault(
      "world.apply_packet.result_mismatch",
      "ApplyPacketResult does not match the submitted packet and commit path",
      {
        packet_id: packetId,
        result_packet_id: resultPacketId,
        expected_status: expectedStatus,
        actual_status: status,
      },
    );
  }
}

function assertCommittedEvent(
  packet: JsonObject,
  event: JsonObject,
  result: JsonObject,
): void {
  const eventPacket = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const eventId = expectString(event, "event_id", "CommittedEvent");
  const resultEventId = expectString(
    result,
    "committed_event_id",
    "ApplyPacketResult",
  );
  const eventRevision = expectInteger(
    event,
    "revision_after",
    "CommittedEvent",
  );
  const revisionBefore = expectInteger(
    event,
    "revision_before",
    "CommittedEvent",
  );
  const resultRevision = expectInteger(
    result,
    "world_revision",
    "ApplyPacketResult",
  );
  const packetBasisRevision = expectInteger(
    packet,
    "basis_revision",
    "ContentPacket",
  );
  const packetWorldId = expectString(packet, "world_id", "ContentPacket");
  const eventWorldId = expectString(event, "world_id", "CommittedEvent");

  if (
    !jsonEquals(packet, eventPacket) ||
    eventId !== resultEventId ||
    eventRevision !== resultRevision ||
    revisionBefore !== packetBasisRevision ||
    eventRevision !== revisionBefore + 1 ||
    eventWorldId !== packetWorldId
  ) {
    throw new EngineFault(
      "world.apply_packet.commit_artifact_mismatch",
      "Prepared world state, committed event, and result are not one atomic commit",
      {
        event_id: eventId,
        result_event_id: resultEventId,
        event_revision: eventRevision,
        result_revision: resultRevision,
        revision_before: revisionBefore,
        packet_basis_revision: packetBasisRevision,
        event_world_id: eventWorldId,
        packet_world_id: packetWorldId,
      },
    );
  }
}
