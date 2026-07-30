import type {
  AssetAcceptanceAuthorizationLookup,
  CommittedEventDocument,
  ContentUpgradeAuthorizationLookup,
  RulePluginProposalReceiptLookup,
  WorldSnapshotDocument,
} from "@luoxia/world-core";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";
import {
  CONTRACT_REF,
  type PackLockDocument,
  type RulePluginChoiceResolutionDocument,
  type SaveEnvelopeDocument,
  type StageModuleLockDocument,
  type UpgradeAuthorizationDocument,
  type ValidatedJsonObject,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime/portable";

import type {
  ModelRequestDocument,
  ModelResponseDocument,
  ProviderUsageObservation,
  PreparedModelInvocation,
  VerifiedModelInvocationReceipt,
  VerifiedModelOutputDocument,
} from "./model-gateway.js";
import type {
  ModelDispatchAuthorization,
  ModelRecoveryAuthorization,
} from "./model-dispatch-authorization.js";
import type {
  PacketProposalDocument,
  PreparedRulePluginInvocation,
  RulePluginRequestDocument,
  RulePluginResponseDocument,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";

/**
 * One runtime world row fact: authoritative snapshot + immutable content lock.
 * Both documents come from the same PostgreSQL SELECT.
 */
export interface RuntimeWorldRecord {
  readonly snapshot: WorldSnapshotDocument;
  readonly worldContentLock: WorldContentLockDocument;
  readonly dependencyBundleLocks: readonly PackLockDocument[];
  readonly stageModuleLocks: readonly StageModuleLockDocument[];
  /**
   * Lowest revision for which this PostgreSQL world can provide subsequent
   * CommittedEvents. It is 0 for a locally created world and the imported
   * world revision for an imported world; v1 SaveEnvelope requires its
   * event_cursor to equal that revision.
   */
  readonly eventHistoryFloorRevision: number;
}

export interface RuntimeWorldReader {
  readCurrent(worldId: string): Promise<RuntimeWorldRecord>;
}

/**
 * PostgreSQL owns SaveEnvelope facts as separate columns. Export reconstructs
 * one untrusted candidate; insert atomically decomposes one already validated
 * envelope and reassembles the stored row before commit.
 */
export interface RuntimeSaveRepository {
  exportCandidate(worldId: string): Promise<unknown>;
  insert(
    envelope: SaveEnvelopeDocument,
    persistedAt: string,
  ): Promise<unknown>;
}

/**
 * Save Schema migration is a representation-only lifecycle operation. The
 * PostgreSQL adapter owns the world-row transaction and invokes the supplied
 * synchronous pure transformation while that row is locked.
 */
export interface RuntimeSaveMigrationRepository {
  migrateLocked(
    worldId: string,
    migratedAt: string,
    migrate: (sourceCandidate: unknown) => SaveEnvelopeDocument,
  ): Promise<unknown>;
}

export interface CommittedEventRevisionRange {
  readonly worldId: string;
  readonly afterRevisionExclusive: number;
  readonly throughRevisionInclusive: number;
}

export interface CommittedEventReader {
  readRevisionRange(
    range: CommittedEventRevisionRange,
  ): Promise<readonly CommittedEventDocument[]>;
}

export interface CommittedPacketRecord {
  readonly event: CommittedEventDocument;
  readonly result: ApplyPacketResultDocument;
}

export interface CommittedPacketReader {
  readByPacketId(
    packetId: string,
  ): Promise<CommittedPacketRecord | undefined>;
}

interface StoredModelInvocationBase {
  readonly worldId: string;
  readonly worldRevision: number;
  readonly requestId: string;
  readonly requestKind: string;
  readonly snapshot: WorldSnapshotDocument;
  readonly request: ModelRequestDocument;
}

export interface StoredPreparedModelInvocation
  extends StoredModelInvocationBase {
  readonly phase: "prepared";
}

export interface StoredAmbiguousModelInvocation
  extends StoredModelInvocationBase {
  readonly phase: "dispatched_ambiguous";
}

export interface StoredVerifiedModelInvocation
  extends StoredModelInvocationBase {
  readonly phase: "verified";
  readonly response: ModelResponseDocument;
  readonly proof: VerifiedModelOutputDocument;
}

export type StoredModelInvocation =
  | StoredPreparedModelInvocation
  | StoredAmbiguousModelInvocation
  | StoredVerifiedModelInvocation;

export interface RecordedModelInvocationVerifier {
  verifyRecorded(
    authorization: ModelRecoveryAuthorization,
  ): VerifiedModelInvocationReceipt;
}

export interface ModelInvocationRecordReader {
  readByRequestId(
    requestId: string,
  ): Promise<StoredModelInvocation | undefined>;
  recoverVerifiedByRequestId(
    requestId: string,
  ): Promise<VerifiedModelInvocationReceipt | undefined>;
}

export interface AuthorizedModelDispatch {
  readonly invocation: StoredAmbiguousModelInvocation;
  readonly authorization: ModelDispatchAuthorization;
}

export interface ModelInvocationJournal
  extends ModelInvocationRecordReader {
  persistPrepared(
    invocation: PreparedModelInvocation,
  ): Promise<StoredModelInvocation>;
  markDispatched(
    invocation: PreparedModelInvocation,
  ): Promise<AuthorizedModelDispatch>;
  recordVerified(
    receipt: VerifiedModelInvocationReceipt,
    usage: ProviderUsageObservation,
  ): Promise<StoredVerifiedModelInvocation>;
}

export type DailySettlementRunPhase =
  | "prepared"
  | "blocked_ambiguous"
  | "response_verified";

export interface DailySettlementRunRecord {
  readonly worldId: string;
  readonly day: number;
  readonly phase: DailySettlementRunPhase;
  readonly invocation: StoredModelInvocation;
}

export interface DailySettlementProposalIdentity {
  readonly ordinal: number;
  readonly proposalId: string;
}

export interface DailySettlementRunJournal
  extends ModelInvocationRecordReader {
  prepareDirectorInvocation(
    invocation: PreparedModelInvocation,
  ): Promise<DailySettlementRunRecord>;
  prepareDailyProposals(
    modelRequestId: string,
  ): Promise<readonly DailySettlementProposalIdentity[]>;
  read(
    worldId: string,
    day: number,
  ): Promise<DailySettlementRunRecord | undefined>;
}

export interface RuntimeModelInvocationJournal
  extends ModelInvocationJournal,
    DailySettlementRunJournal {}

export interface StoredPreparedRulePluginInvocation {
  readonly phase: "prepared";
  readonly request: RulePluginRequestDocument;
  readonly continuation: StoredRulePluginChoiceContinuation | undefined;
}

export interface StoredRulePluginChoiceContinuation {
  readonly parentRequestId: string;
  readonly resolution: RulePluginChoiceResolutionDocument;
}

export type MaterializationRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.materializationRequest
>;
export type AssetCandidateDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.assetCandidate
>;
export type ReviewReceiptDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.reviewReceipt
>;
export type AssetAcceptanceDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.assetAcceptance
>;

export interface StoredMaterializationCandidate {
  readonly request: MaterializationRequestDocument;
  readonly candidate: AssetCandidateDocument;
}

export interface StoredMaterializationReview
  extends StoredMaterializationCandidate {
  readonly review: ReviewReceiptDocument;
  readonly acceptance: AssetAcceptanceDocument | undefined;
}

export interface MaterializationLedger
  extends AssetAcceptanceAuthorizationLookup {
  claimNextPending(): Promise<MaterializationRequestDocument | undefined>;
  markFailed(
    requestId: string,
    expectedStatus: "generating" | "reviewing",
  ): Promise<MaterializationRequestDocument>;
  recordCandidate(
    requestId: string,
    candidate: AssetCandidateDocument,
  ): Promise<StoredMaterializationCandidate>;
  readByCandidateId(
    candidateId: string,
  ): Promise<StoredMaterializationCandidate | undefined>;
  recordReview(
    review: ReviewReceiptDocument,
    acceptance: AssetAcceptanceDocument | undefined,
  ): Promise<StoredMaterializationReview>;
  readAccepted(
    acceptanceId: string,
  ): Promise<StoredMaterializationReview | undefined>;
  markSuperseded(
    requestId: string,
    expectedStatus: "generating" | "reviewing" | "accepted",
  ): Promise<MaterializationRequestDocument>;
}

export interface StoredResolvedRulePluginInvocation {
  readonly phase: "resolved";
  readonly request: RulePluginRequestDocument;
  readonly response: RulePluginResponseDocument;
  readonly proposal: PacketProposalDocument | undefined;
  readonly continuation: StoredRulePluginChoiceContinuation | undefined;
}

export type StoredRulePluginInvocation =
  | StoredPreparedRulePluginInvocation
  | StoredResolvedRulePluginInvocation;

export interface RulePluginInvocationJournal
  extends RulePluginProposalReceiptLookup {
  persistPrepared(
    invocation: PreparedRulePluginInvocation,
  ): Promise<StoredRulePluginInvocation>;
  persistChoiceContinuation(input: {
    readonly parent: VerifiedRulePluginInvocationReceipt;
    readonly invocation: PreparedRulePluginInvocation;
    readonly resolution: RulePluginChoiceResolutionDocument;
  }): Promise<StoredRulePluginInvocation>;
  recordResolved(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<StoredResolvedRulePluginInvocation>;
  readByRequestId(
    requestId: string,
  ): Promise<StoredRulePluginInvocation | undefined>;
  readChoiceContinuation(
    parentRequestId: string,
  ): Promise<StoredRulePluginInvocation | undefined>;
}

export interface StoredContentUpgradeAuthorization {
  readonly phase: "authorized" | "commit_ready";
  readonly sessionId: string;
  readonly clientCommandId: string;
  readonly ruleRequestId: string;
  readonly authorization: UpgradeAuthorizationDocument;
  readonly resultDigest?: string;
}

export interface ContentUpgradeAuthorizationLedger
  extends ContentUpgradeAuthorizationLookup {
  persistAuthorized(input: {
    readonly sessionId: string;
    readonly clientCommandId: string;
    readonly ruleRequestId: string;
    readonly authorization: UpgradeAuthorizationDocument;
  }): Promise<StoredContentUpgradeAuthorization>;
  markCommitReady(input: {
    readonly upgradeCommandId: string;
    readonly resultDigest: string;
  }): Promise<StoredContentUpgradeAuthorization>;
  readByUpgradeCommandId(
    upgradeCommandId: string,
  ): Promise<StoredContentUpgradeAuthorization | undefined>;
}
