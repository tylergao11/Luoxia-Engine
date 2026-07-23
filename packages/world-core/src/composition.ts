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

export type WorldSnapshotDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.worldSnapshot
>;

export type CommittedEventDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.committedEvent
>;

export type PacketCommitIdentityDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.packetCommitIdentity
>;

export type DomainEventDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.domainEvent
>;

export type MaterializationRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.materializationRequest
>;

export type SessionViewDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.sessionView
>;

export interface PacketSemanticGate {
  assertApplicable(
    packet: ContentPacketDocument,
    snapshot: WorldSnapshotDocument,
  ): Promise<void>;
}

export interface PacketTransitionCandidates {
  readonly nextWorldStateCandidate: unknown;
  readonly domainEventCandidates: readonly unknown[];
  readonly materializationRequestCandidates: readonly unknown[];
}

export interface PacketStateTransition {
  apply(
    packet: ContentPacketDocument,
    snapshot: WorldSnapshotDocument,
    commitIdentity: PacketCommitIdentityDocument,
  ): PacketTransitionCandidates;
}

export interface SessionViewProjectionInput {
  readonly snapshot: WorldSnapshotDocument;
  readonly sessionId: string;
  readonly viewRevision: number;
  readonly basisToken: string;
  readonly controlBindingId: string;
  readonly renderNodeCandidates: readonly unknown[];
  readonly noticeCandidates: readonly unknown[];
}

export interface SessionViewProjector {
  project(input: SessionViewProjectionInput): SessionViewDocument;
}

export {
  createPacketSemanticGate,
  type DecimalAmountComparer,
  type PacketContentDigest,
  type PacketSemanticGateDependencies,
  type RuleHoldEvaluator,
  type RulePluginProposalReceiptLookup,
  type StaticComponentDigestLookup,
} from "./packet-semantic-gate.js";

export {
  createPacketStateTransition,
  type LedgerPostArithmetic,
  type PacketStateTransitionDependencies,
} from "./packet-state-transition.js";

export {
  createSessionViewProjector,
  type SessionViewProjectorDependencies,
} from "./session-view-projection.js";

export {
  createContentRuntimeCatalog,
  type BundleLockRef,
  type ContentRuntimeCatalog,
  type ContentRuntimeCatalogDependencies,
  type RuleEvaluationBinding,
  type RuleRefLike,
  type StaticDefinitionRefLike,
  type WorldContentBinding,
  type WorldContentLockDocument,
} from "./content-runtime-catalog.js";

export {
  createDeterministicContextAuthority,
  type DeterministicContextAuthority,
  type DeterministicContextAuthorityDependencies,
  type DeterministicContextDigest,
  type DeterministicContextDocument,
  type DeterministicContextIdFactory,
  type DeterministicContextIssueInput,
  type DeterministicContextTokenCodec,
} from "./deterministic-context-authority.js";

export interface PacketCommitPreparation {
  readonly committedEventCandidate: unknown;
  readonly resultCandidate: unknown;
}

export interface AuthorizedPacketCommit {
  readonly packet: ContentPacketDocument;
  readonly nextWorldState: WorldStateDocument;
  readonly committedEvent: CommittedEventDocument;
  readonly result: ApplyPacketResultDocument;
  readonly materializationRequests: readonly MaterializationRequestDocument[];
}

export interface LockedWorldTransaction {
  readDuplicateResult(packet: ContentPacketDocument): Promise<unknown | undefined>;
  readSnapshot(): Promise<unknown>;
  /**
   * Creates an unpersisted identity candidate for this apply attempt.
   * It must not reserve a row or mutate storage before all candidates validate.
   */
  createCommitIdentityCandidate(
    packet: ContentPacketDocument,
  ): Promise<unknown>;
  prepare(
    packet: ContentPacketDocument,
    commitIdentity: PacketCommitIdentityDocument,
    nextWorldState: WorldStateDocument,
    domainEvents: readonly DomainEventDocument[],
    materializationRequests: readonly MaterializationRequestDocument[],
  ): Promise<PacketCommitPreparation>;
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
  readonly stateTransition: PacketStateTransition;
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
  readonly #stateTransition: PacketStateTransition;
  readonly #store: AtomicPacketStore;

  public constructor(dependencies: WorldCoreDependencies) {
    this.#contracts = dependencies.contracts;
    this.#semanticGate = dependencies.semanticGate;
    this.#stateTransition = dependencies.stateTransition;
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
          CONTRACT_REF.worldSnapshot,
          await transaction.readSnapshot(),
        );
        assertSnapshotMatchesPacket(packet.value, snapshot.value);
        await this.#semanticGate.assertApplicable(packet, snapshot);

        const commitIdentity = this.#contracts.assertObject(
          CONTRACT_REF.packetCommitIdentity,
          await transaction.createCommitIdentityCandidate(packet),
        );
        const transition = this.#stateTransition.apply(
          packet,
          snapshot,
          commitIdentity,
        );
        const nextWorldState = this.#contracts.assertObject(
          CONTRACT_REF.worldState,
          transition.nextWorldStateCandidate,
        );
        const domainEvents = Object.freeze(
          transition.domainEventCandidates.map((candidate) =>
            this.#contracts.assertObject(CONTRACT_REF.domainEvent, candidate),
          ),
        );
        const materializationRequests = Object.freeze(
          transition.materializationRequestCandidates.map((candidate) =>
            this.#contracts.assertObject(
              CONTRACT_REF.materializationRequest,
              candidate,
            ),
          ),
        );
        const preparation = await transaction.prepare(
          packet,
          commitIdentity,
          nextWorldState,
          domainEvents,
          materializationRequests,
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
        assertCommittedEvent(
          packet.value,
          commitIdentity.value,
          domainEvents,
          committedEvent.value,
          result.value,
        );

        await transaction.commit(
          Object.freeze({
            packet,
            nextWorldState,
            committedEvent,
            result,
            materializationRequests,
          }),
        );
        return result;
      },
    );
  }
}

function assertSnapshotMatchesPacket(
  packet: JsonObject,
  snapshot: JsonObject,
): void {
  const packetWorldId = expectString(packet, "world_id", "ContentPacket");
  const snapshotWorldId = expectString(snapshot, "world_id", "WorldSnapshot");
  const packetBasisRevision = expectInteger(
    packet,
    "basis_revision",
    "ContentPacket",
  );
  const snapshotWorldRevision = expectInteger(
    snapshot,
    "world_revision",
    "WorldSnapshot",
  );

  if (
    snapshotWorldId !== packetWorldId ||
    snapshotWorldRevision !== packetBasisRevision
  ) {
    throw new EngineFault(
      "world.apply_packet.snapshot_mismatch",
      "Locked world snapshot does not match the submitted packet",
      {
        packet_world_id: packetWorldId,
        snapshot_world_id: snapshotWorldId,
        packet_basis_revision: packetBasisRevision,
        snapshot_world_revision: snapshotWorldRevision,
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
  commitIdentity: JsonObject,
  domainEvents: readonly DomainEventDocument[],
  event: JsonObject,
  result: JsonObject,
): void {
  const eventPacket = expectJsonObject(
    expectProperty(event, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const eventId = expectString(event, "event_id", "CommittedEvent");
  const allocatedEventId = expectString(
    commitIdentity,
    "event_id",
    "PacketCommitIdentity",
  );
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
  const eventDomainEvents = expectProperty(
    event,
    "domain_events",
    "CommittedEvent",
  );
  const expectedDomainEvents = domainEvents.map(
    (domainEvent) => domainEvent.value,
  );

  if (
    !jsonEquals(packet, eventPacket) ||
    eventId !== allocatedEventId ||
    eventId !== resultEventId ||
    eventRevision !== resultRevision ||
    revisionBefore !== packetBasisRevision ||
    eventRevision !== revisionBefore + 1 ||
    eventWorldId !== packetWorldId ||
    !jsonEquals(eventDomainEvents, expectedDomainEvents)
  ) {
    throw new EngineFault(
      "world.apply_packet.commit_artifact_mismatch",
      "Prepared world state, committed event, and result are not one atomic commit",
      {
        event_id: eventId,
        allocated_event_id: allocatedEventId,
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
