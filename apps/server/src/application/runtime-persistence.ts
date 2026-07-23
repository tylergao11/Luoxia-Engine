import type {
  CommittedEventDocument,
  RulePluginProposalReceiptLookup,
  WorldSnapshotDocument,
} from "@luoxia/world-core/composition";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";

import type {
  ModelRequestDocument,
  ModelResponseDocument,
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
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";

export interface RuntimeWorldReader {
  readCurrent(worldId: string): Promise<WorldSnapshotDocument>;
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
  ): Promise<StoredVerifiedModelInvocation>;
}

export type DailySettlementRunPhase =
  | "prepared"
  | "blocked_ambiguous"
  | "response_verified";

export interface DailySettlementRunRecord {
  readonly runId: string;
  readonly worldId: string;
  readonly day: number;
  readonly phase: DailySettlementRunPhase;
  readonly invocation: StoredModelInvocation;
}

export interface AuthorizedDailyDirectorDispatch {
  readonly run: DailySettlementRunRecord;
  readonly authorization: ModelDispatchAuthorization;
}

export interface DailySettlementRunJournal
  extends ModelInvocationRecordReader {
  prepareDirectorInvocation(
    invocation: PreparedModelInvocation,
  ): Promise<DailySettlementRunRecord>;
  read(
    worldId: string,
    day: number,
  ): Promise<DailySettlementRunRecord | undefined>;
  markDirectorDispatched(
    runId: string,
    invocation: PreparedModelInvocation,
  ): Promise<AuthorizedDailyDirectorDispatch>;
  recordDirectorVerified(
    runId: string,
    receipt: VerifiedModelInvocationReceipt,
  ): Promise<DailySettlementRunRecord>;
}

export interface RulePluginProposalReceiptStore
  extends RulePluginProposalReceiptLookup {
  persistPacketProposal(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<PacketProposalDocument | undefined>;
}
