import {
  EngineFault,
  type ContractValidator,
  type JsonDigest,
} from "@luoxia/contracts-runtime";
import {
  createContentUpgradeAuthorizationAuthority,
  createDeterministicContextAuthority,
  createPacketSemanticGate,
  createPacketStateTransition,
  createRulePluginChoiceAuthority,
  createSessionViewProjector,
  createWorldCore,
  type ContentRuntimeCatalog,
  type ContentRuntimeIdentityMapper,
  type ContentUpgradeAuthorizationAuthority,
  type DeterministicContextAuthority,
  type DeterministicContextDocument,
  type DeterministicContextIdFactory,
  type DeterministicContextIssueInput,
  type DeterministicContextTokenCodec,
  type RulePluginProposalReceiptLookup,
} from "@luoxia/world-core/composition";
import type { Pool } from "pg";

import { createNodeCommandExecutionIdFactory } from "../adapters/crypto/command-execution-id-factory.js";
import {
  createHmacContentUpgradeTokenCodec,
  type ContentUpgradeHmacKeyring,
} from "../adapters/crypto/content-upgrade-hmac-token-codec.js";
import { createNodeDayCycleExecutionIdFactory } from "../adapters/crypto/day-cycle-execution-id-factory.js";
import { createNodeDialogueCommitmentIdFactory } from "../adapters/crypto/dialogue-commitment-id-factory.js";
import { createNodeEngineSessionIdFactory } from "../adapters/crypto/engine-session-id-factory.js";
import { createNodeMaterializationIdentityFactory } from "../adapters/crypto/materialization-identity-factory.js";
import { createNodeRuleHoldRequestIdFactory } from "../adapters/crypto/rule-hold-request-id-factory.js";
import { createNodeRulePluginChoiceContinuationIdFactory } from "../adapters/crypto/rule-plugin-choice-continuation-id-factory.js";
import { createNodeRulePluginChoiceEntropySource } from "../adapters/crypto/rule-plugin-choice-entropy-source.js";
import { createNodeRuntimeWorldCreationIdFactory } from "../adapters/crypto/runtime-world-creation-id-factory.js";
import { createNodeServerEnvelopeIdFactory } from "../adapters/crypto/server-envelope-id-factory.js";
import { createNodeWorldExtensionExecutionIdentityFactory } from "../adapters/crypto/world-extension-execution-id-factory.js";
import {
  createHmacSessionBasisTokenAuthority,
  type SessionBasisHmacKeyring,
} from "../adapters/crypto/session-basis-hmac-authority.js";
import { createPostgresAtomicPacketStore } from "../adapters/postgres/atomic-packet-store.js";
import { createPostgresCommandJournal } from "../adapters/postgres/command-journal.js";
import { createPostgresContentUpgradeAuthorizationLedger } from "../adapters/postgres/content-upgrade-authorization-ledger.js";
import { createPostgresDayCycleExecutionIdentityJournal } from "../adapters/postgres/day-cycle-execution-identity.js";
import { createPostgresDialogueDirectorRunJournal } from "../adapters/postgres/dialogue-director-run.js";
import { createPostgresCommandFinalizer } from "../adapters/postgres/command-finalizer.js";
import { createPostgresEngineSessionRepository } from "../adapters/postgres/engine-session-repository.js";
import { createPostgresMaterializationLedger } from "../adapters/postgres/materialization-ledger.js";
import { createPostgresPlayerDayEndRunJournal } from "../adapters/postgres/player-day-end-run.js";
import { createPostgresSessionSynchronization } from "../adapters/postgres/session-synchronization.js";
import {
  createPostgresRuntimeInvocationJournal,
  type PostgresRuntimeInvocationJournal,
} from "../adapters/postgres/runtime-invocation-journal.js";
import {
  createPostgresRulePluginInvocationJournal,
} from "../adapters/postgres/rule-plugin-invocation-journal.js";
import {
  createPostgresRuntimeReaders,
  type PostgresRuntimeReaders,
} from "../adapters/postgres/runtime-readers.js";
import { createPostgresRuntimeSaveRepository } from "../adapters/postgres/runtime-save-repository.js";
import { createPostgresRuntimeSaveMigrationRepository } from "../adapters/postgres/runtime-save-migration-repository.js";
import { createSystemRuntimeSaveClock } from "../adapters/system/runtime-save-clock.js";
import { createSystemContentUpgradeClock } from "../adapters/system/content-upgrade-clock.js";
import { createSystemMaterializationClock } from "../adapters/system/materialization-clock.js";
import { createSystemRuntimeWorldCreationClock } from "../adapters/system/runtime-world-creation-clock.js";
import { createSystemWorldExtensionProvenanceClock } from "../adapters/system/world-extension-provenance-clock.js";
import {
  createAuthoritativePacketBuilder,
  type AuthoritativePacketBuilder,
} from "./authoritative-packet-builder.js";
import type { AssetProviderRegistry } from "./asset-provider-registry.js";
import {
  createClientCommandRouter,
  type ClientCommandRouter,
} from "./client-command-router.js";
import type { CommandJournal } from "./command-journal.js";
import {
  createContentUpgradeOrchestrator,
  type ContentUpgradeOrchestrator,
} from "./content-upgrade-orchestrator.js";
import {
  createDayCycleOrchestrator,
  type DayCycleOrchestrator,
} from "./day-cycle-orchestrator.js";
import {
  createDialogueCommandOrchestrator,
  type DialogueCommandOrchestrator,
} from "./dialogue-command-orchestrator.js";
import {
  createDialogueCloseCommandOrchestrator,
  type DialogueCloseCommandOrchestrator,
} from "./dialogue-close-command-orchestrator.js";
import {
  createDecimalAmountComparer,
  createLedgerPostArithmetic,
} from "./decimal-ledger.js";
import {
  createEngineSessionService,
  type EngineSessionService,
} from "./engine-session.js";
import {
  createEventCardCommandOrchestrator,
  type EventCardCommandOrchestrator,
} from "./event-card-command-orchestrator.js";
import {
  createMapMoveCommandOrchestrator,
  type MapMoveCommandOrchestrator,
} from "./map-move-command-orchestrator.js";
import {
  createMaterializationOrchestrator,
  type MaterializationOrchestrator,
} from "./materialization-orchestrator.js";
import { createModelInvocationAuthorizationChannel } from "./model-dispatch-authorization.js";
import {
  ModelGateway,
  type ModelProvider,
  type VerifiedModelInvocationReceipt,
} from "./model-gateway.js";
import {
  createRuntimeModelFacades,
  type RuntimeModelFacades,
} from "./model-request-assembly.js";
import { createPromptMaterializer } from "./prompt-materializer.js";
import {
  createPlayerDayCommandOrchestrator,
  type PlayerDayCommandOrchestrator,
} from "./player-day-command-orchestrator.js";
import { createRuleHoldEvaluator } from "./rule-hold-evaluator.js";
import { createRuntimeWorldBindingResolver } from "./runtime-world-binding.js";
import { createServerEnvelopeFactory } from "./server-envelope.js";
import { createSessionRenderNodeProjector } from "./session-render-node-projector.js";
import { createSessionViewAssembler } from "./session-view-assembler.js";
import {
  createRuntimeWorldCreationService,
  type RuntimeWorldCreationService,
} from "./runtime-world-creation.js";
import {
  createRulePluginAbiRegistry,
  type RulePluginDependencyIdentity,
  type RulePluginModuleV1,
} from "./rule-plugin-abi.js";
import type { RulePluginOperationRequirement } from "./rule-plugin-operation-requirement.js";
import {
  createSaveSchemaMigrationRegistry,
  type SaveSchemaMigrationModuleV1,
} from "./save-schema-migration-abi.js";
import { createSaveSchemaMigrationService } from "./save-schema-migration.js";
import { createRulePluginGateway } from "./rule-plugin-composition.js";
import type { VerifiedRulePluginInvocationReceipt } from "./rule-plugin-gateway.js";
import {
  createRuntimeSaveCompatibility,
  createRuntimeSaveService,
  type RuntimeActivatedBundleDescriptor,
  type RuntimeSaveService,
} from "./runtime-save.js";
import type {
  CommittedEventReader,
  CommittedPacketReader,
  RulePluginInvocationJournal,
  RuntimeWorldReader,
} from "./runtime-persistence.js";
import {
  createRulePluginExecutor,
  type RulePluginExecutor,
} from "./rule-plugin-executor.js";
import type { StageModuleRegistry } from "./stage-module-registry.js";
import { createStageContractAuthority } from "./stage-contract-authority.js";
import { createStageOpenMessageProjector } from "./stage-open-message-projector.js";
import {
  createStageOutcomeCommandOrchestrator,
  type StageOutcomeCommandOrchestrator,
} from "./stage-outcome-command-orchestrator.js";
import {
  createWorldMutationOrchestrator,
  type WorldMutationOrchestrator,
} from "./world-mutation-orchestrator.js";
import {
  createWorldExtensionOrchestrator,
  type WorldExtensionOrchestrator,
} from "./world-extension-orchestrator.js";

/**
 * Kernel composition inputs. Decimal/ledger strategies and the sole RulePlugin ABI
 * registry are built inside the kernel; they are not injectable.
 */
export interface RuntimeExecutionKernelDependencies {
  readonly pool: Pool;
  /**
   * Dedicated pool for RulePlugin request journaling. It must target the same
   * PostgreSQL database but must not be the world-transaction Pool object:
   * rule.holds journals while the world row is locked.
   */
  readonly rulePluginJournalPool: Pool;
  /**
   * Dedicated same-database Pool for Materialization authorization lookups
   * made while apply_packet holds a world row lock.
   */
  readonly materializationLedgerPool: Pool;
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly modelProvider: ModelProvider;
  /** Explicit trusted RulePlugin modules for the in-process ABI host. */
  readonly rulePluginModules: readonly RulePluginModuleV1[];
  /**
   * Required rule_plugin DependencyLock identities collected at activation.
   * Validated against the kernel's unique ABI registry at construction.
   */
  readonly requiredRulePluginDependencies: readonly RulePluginDependencyIdentity[];
  /**
   * Exhaustive content-derived operation requirements.
   * Validated against the sole ABI registry before Gateway construction.
   */
  readonly rulePluginOperationRequirements: readonly RulePluginOperationRequirement[];
  /** Locked ContentBundle index; also supplies StaticComponentDigestLookup. */
  readonly contentRuntimeCatalog: ContentRuntimeCatalog;
  /** Sole RFC 9562 content-local identity mapper shared with the Catalog. */
  readonly contentRuntimeIdentityMapper: ContentRuntimeIdentityMapper;
  /** Activation-owned exact AssetProvider registry; no default provider. */
  readonly assetProviders: AssetProviderRegistry;
  /** Explicit SaveEnvelope version support; no package-version inference. */
  readonly saveSchemaVersion: string;
  /** Explicit trusted pure modules; an empty array means no old version is accepted. */
  readonly saveSchemaMigrationModules: readonly SaveSchemaMigrationModuleV1[];
  /** Explicit untrusted plan manifests; no inferred or default migration chain. */
  readonly saveSchemaMigrationPlanCandidates: readonly unknown[];
  readonly engineContractVersion: string;
  /** Validated activation records used only to derive exact save lock sets. */
  readonly activatedBundles: readonly RuntimeActivatedBundleDescriptor[];
  /** Sole activation-owned registry used to resolve StageModule locks. */
  readonly stageModuleRegistry: StageModuleRegistry;
  /**
   * Server HMAC TokenCodec for DeterministicContext.issuer_token.
   * Built at composition root from an explicit keyring; no defaults.
   */
  readonly deterministicContextTokenCodec: DeterministicContextTokenCodec;
  /** Server-owned context_id factory; Authority is the only caller. */
  readonly deterministicContextIdFactory: DeterministicContextIdFactory;
  /** Independent, explicit basis_token keyring; never reused for contexts. */
  readonly sessionBasisHmacKeyring: SessionBasisHmacKeyring;
  /** Independent keyring for World Core Content Upgrade authorization. */
  readonly contentUpgradeHmacKeyring: ContentUpgradeHmacKeyring;
  /** Explicit lifetime for a player-approved upgrade authorization. */
  readonly contentUpgradeAuthorizationLifetimeSeconds: number;
  /** Explicit deployment selection for CharacterMind dialogue calls. */
  readonly characterDialogueModelProfileId: string;
  /** Explicit deployment selection for Director daily settlement calls. */
  readonly directorDailySettlementModelProfileId: string;
  /** Explicit deployment selection for Director NPC dialogue event calls. */
  readonly directorDialogueEventsModelProfileId: string;
  /** Explicit deployment selection for Director System dialogue calls. */
  readonly directorSystemDialogueModelProfileId: string;
  /** Explicit deployment selection for CharacterMind reaction calls. */
  readonly characterReactModelProfileId: string;
}

export type { RulePluginModuleV1 } from "./rule-plugin-abi.js";
export type { RulePluginDependencyIdentity } from "./rule-plugin-abi.js";

export interface RuntimeExecutionKernelReaders {
  readonly worlds: RuntimeWorldReader;
  readonly events: CommittedEventReader;
  readonly packets: CommittedPacketReader;
  readonly proposalReceipts: RulePluginProposalReceiptLookup;
}

/**
 * Unique runtime execution entry for model and RulePlugin work.
 * Provenance is locked inside one composition and is not caller-assemblable.
 */
export type DeterministicContextIssuePort = Pick<
  DeterministicContextAuthority,
  "issue"
>;

export interface RuntimeExecutionKernel {
  readonly readers: RuntimeExecutionKernelReaders;
  /** Authoritative ContentPacket construction; does not apply packets. */
  readonly packets: AuthoritativePacketBuilder;
  /** Authoritative applyPacket paths only (RulePlugin receipt / EventCard click). */
  readonly mutations: WorldMutationOrchestrator;
  /** Recoverable outbox -> provider -> review -> acceptance -> binding path. */
  readonly materializations: MaterializationOrchestrator;
  /** Recoverable player-authorized Content Upgrade commit path. */
  readonly contentUpgrades: ContentUpgradeOrchestrator;
  /**
   * Closed model invocation surfaces only. No arbitrary ModelRequest candidate bypass.
   */
  readonly models: RuntimeModelFacades;
  /**
   * Sole DeterministicContext issue entry for additional day-cycle and
   * non-basic orchestration. Basic NPC dialogue uses the same internal
   * authority through kernel.dialogues.
   */
  readonly deterministicContexts: DeterministicContextIssuePort;
  /** Engine Session lifecycle; login/account authentication remains external. */
  readonly sessions: EngineSessionService;
  /** Idempotent command intake and final-result recovery. */
  readonly commands: CommandJournal;
  /** Recoverable two-packet Human → CharacterMind dialogue command path. */
  readonly dialogues: DialogueCommandOrchestrator;
  readonly dialogueCloses: DialogueCloseCommandOrchestrator;
  /** Recoverable sealed EventCard trigger/invalidation command path. */
  readonly eventCards: EventCardCommandOrchestrator;
  /** Recoverable model-free map.move -> navigation.resolve command path. */
  readonly mapMoves: MapMoveCommandOrchestrator;
  /** Recoverable player_day.end command path. */
  readonly playerDays: PlayerDayCommandOrchestrator;
  /** Closed Client Bridge command dispatch; unsupported kinds fail explicitly. */
  readonly clientCommands: ClientCommandRouter;
  /** Recoverable autonomous → Director → player world-day authority. */
  readonly dayCycle: DayCycleOrchestrator;
  /** Resolves committed, archetype-selected expansion requests in autonomous phase. */
  readonly worldExtensions: WorldExtensionOrchestrator;
  /** Recoverable StageOutcomeProposal -> RulePlugin -> apply_packet path. */
  readonly stageOutcomes: StageOutcomeCommandOrchestrator;
  /** Schema-closed revision-zero world bootstrap and atomic persistence. */
  readonly worldCreation: RuntimeWorldCreationService;
  /** PostgreSQL-backed SaveEnvelope export and create-only import boundary. */
  readonly saves: RuntimeSaveService;
  executeRulePlugin(
    candidate: unknown,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt>;
}

export function createRuntimeExecutionKernel(
  dependencies: RuntimeExecutionKernelDependencies,
): RuntimeExecutionKernel {
  if (dependencies.rulePluginJournalPool === dependencies.pool) {
    throw new EngineFault(
      "runtime.composition.rule_plugin_journal_pool_shared",
      "RulePlugin Journal requires a dedicated Pool to avoid world-lock connection starvation",
    );
  }
  if (
    dependencies.materializationLedgerPool === dependencies.pool ||
    dependencies.materializationLedgerPool ===
      dependencies.rulePluginJournalPool
  ) {
    throw new EngineFault(
      "runtime.composition.materialization_ledger_pool_shared",
      "Materialization Ledger requires a dedicated Pool to avoid world-lock connection starvation",
    );
  }
  const channel = createModelInvocationAuthorizationChannel();

  const modelGateway = new ModelGateway(
    dependencies.contracts,
    dependencies.digest,
    dependencies.modelProvider,
    channel.dispatchVerifier,
    channel.recoveryVerifier,
  );

  const journal: PostgresRuntimeInvocationJournal =
    createPostgresRuntimeInvocationJournal({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      dispatchIssuer: channel.dispatchIssuer,
      recoveryIssuer: channel.recoveryIssuer,
      modelProvenance: modelGateway.provenance,
      recordedInvocationVerifier: modelGateway,
    });

  // Sole DeterministicContext Authority for this kernel (Gate + RulePlugin share it).
  const deterministicContextAuthority = createDeterministicContextAuthority({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    tokenCodec: dependencies.deterministicContextTokenCodec,
    contextIdFactory: dependencies.deterministicContextIdFactory,
  });
  const rulePluginChoiceAuthority = createRulePluginChoiceAuthority({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    deterministicContexts: deterministicContextAuthority,
  });
  const contentUpgradeClock = createSystemContentUpgradeClock(
    dependencies.contentUpgradeAuthorizationLifetimeSeconds,
  );
  const contentUpgradeAuthorizationAuthority:
    ContentUpgradeAuthorizationAuthority =
      createContentUpgradeAuthorizationAuthority({
        contracts: dependencies.contracts,
        digest: dependencies.digest,
        tokenCodec: createHmacContentUpgradeTokenCodec({
          keyring: dependencies.contentUpgradeHmacKeyring,
        }),
      });
  const sessionBasisTokens = createHmacSessionBasisTokenAuthority({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    keyring: dependencies.sessionBasisHmacKeyring,
  });
  const stageContracts = createStageContractAuthority({
    contracts: dependencies.contracts,
    catalog: dependencies.contentRuntimeCatalog,
    stageModules: dependencies.stageModuleRegistry,
  });
  const stageOpens = createStageOpenMessageProjector({
    contracts: dependencies.contracts,
    identityMapper: dependencies.contentRuntimeIdentityMapper,
    stageContracts,
  });
  const sessionViews = createSessionViewAssembler({
    contracts: dependencies.contracts,
    basisTokens: sessionBasisTokens,
    renderNodes: createSessionRenderNodeProjector({
      catalog: dependencies.contentRuntimeCatalog,
      identityMapper: dependencies.contentRuntimeIdentityMapper,
      digest: dependencies.digest,
    }),
    projector: createSessionViewProjector({
      contracts: dependencies.contracts,
    }),
  });
  const sessions = createEngineSessionService({
    repository: createPostgresEngineSessionRepository({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      idFactory: createNodeEngineSessionIdFactory(),
      views: sessionViews,
    }),
    basisTokens: sessionBasisTokens,
  });
  const commands = createPostgresCommandJournal({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    basisTokens: sessionBasisTokens,
    idFactory: createNodeCommandExecutionIdFactory(),
  });
  // Sole RulePlugin ABI instance for this kernel (activation does not create another).
  const rulePluginAbi = createRulePluginAbiRegistry({
    contracts: dependencies.contracts,
    modules: dependencies.rulePluginModules,
  });
  for (const required of dependencies.requiredRulePluginDependencies) {
    rulePluginAbi.requireModuleForDependency(required);
  }
  for (const requirement of dependencies.rulePluginOperationRequirements) {
    try {
      rulePluginAbi.requireOperationForDependency({
        dependency: requirement.dependency,
        operationId: requirement.operationId,
        operationKind: requirement.operationKind,
      });
    } catch (error: unknown) {
      if (error instanceof EngineFault) {
        throw new EngineFault(error.code, error.message, {
          ...(error.details ?? {}),
          ...requirement.source,
          operation_id: requirement.operationId,
          operation_kind: requirement.operationKind,
          package_id: requirement.dependency.package_id,
          version: requirement.dependency.version,
          integrity_sha256: requirement.dependency.integrity_sha256,
        });
      }
      throw error;
    }
  }
  const saveCompatibility = createRuntimeSaveCompatibility({
    contracts: dependencies.contracts,
    catalog: dependencies.contentRuntimeCatalog,
    saveSchemaVersion: dependencies.saveSchemaVersion,
    engineContractVersion: dependencies.engineContractVersion,
    bundles: dependencies.activatedBundles,
    rulePlugins: rulePluginAbi,
    stageModules: dependencies.stageModuleRegistry,
    stageContracts,
  });
  const saveSchemaMigrationRegistry =
    createSaveSchemaMigrationRegistry({
      contracts: dependencies.contracts,
      modules: dependencies.saveSchemaMigrationModules,
      planCandidates: dependencies.saveSchemaMigrationPlanCandidates,
      currentSaveSchemaVersion: dependencies.saveSchemaVersion,
    });
  const saveSchemaMigrations = createSaveSchemaMigrationService({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    registry: saveSchemaMigrationRegistry,
    currentSaveSchemaVersion: dependencies.saveSchemaVersion,
  });
  const saves = createRuntimeSaveService({
    contracts: dependencies.contracts,
    compatibility: saveCompatibility,
    repository: createPostgresRuntimeSaveRepository({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
    }),
    migrationRepository:
      createPostgresRuntimeSaveMigrationRepository({
        pool: dependencies.pool,
        contracts: dependencies.contracts,
      }),
    migrations: saveSchemaMigrations,
    clock: createSystemRuntimeSaveClock(),
  });
  const worldCreation = createRuntimeWorldCreationService({
    contracts: dependencies.contracts,
    catalog: dependencies.contentRuntimeCatalog,
    identityMapper: dependencies.contentRuntimeIdentityMapper,
    idFactory: createNodeRuntimeWorldCreationIdFactory(),
    clock: createSystemRuntimeWorldCreationClock(),
    saves,
  });
  const rulePluginAdapter = rulePluginAbi.createAdapter();

  const rulePluginGateway = createRulePluginGateway({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    adapter: rulePluginAdapter,
    modelProvenance: modelGateway.provenance,
    deterministicContextAuthority,
    contentUpgradeAuthorizationAuthority,
    contentUpgradeClock,
    stageContracts,
  });

  const rulePluginJournal: RulePluginInvocationJournal =
    createPostgresRulePluginInvocationJournal({
      pool: dependencies.rulePluginJournalPool,
      contracts: dependencies.contracts,
      digest: dependencies.digest,
      preparationProvenance: rulePluginGateway.preparationProvenance,
      invocationProvenance: rulePluginGateway.provenance,
    });
  const rulePluginExecutor: RulePluginExecutor = createRulePluginExecutor({
    gateway: rulePluginGateway,
    journal: rulePluginJournal,
    choices: rulePluginChoiceAuthority,
    entropySource: createNodeRulePluginChoiceEntropySource(),
    continuationIds:
      createNodeRulePluginChoiceContinuationIdFactory(),
  });
  const contentUpgradeAuthorizationLedger =
    createPostgresContentUpgradeAuthorizationLedger({
      pool: dependencies.rulePluginJournalPool,
      contracts: dependencies.contracts,
    });

  const postgresReaders: PostgresRuntimeReaders = createPostgresRuntimeReaders({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
  });

  const readers: RuntimeExecutionKernelReaders = Object.freeze({
    worlds: postgresReaders.worlds,
    events: postgresReaders.committedEvents,
    packets: postgresReaders.committedPackets,
    proposalReceipts: Object.freeze({
      findByProposalId(proposalId: string): Promise<unknown | undefined> {
        return rulePluginJournal.findByProposalId(proposalId);
      },
    }),
  });

  const packets = createAuthoritativePacketBuilder({
    contracts: dependencies.contracts,
    rulePluginProvenance: rulePluginGateway.provenance,
    worlds: readers.worlds,
  });

  const store = createPostgresAtomicPacketStore({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
    digest: dependencies.digest,
  });

  const ruleHoldEvaluator = createRuleHoldEvaluator({
    catalog: dependencies.contentRuntimeCatalog,
    abi: rulePluginAbi,
    rulePluginExecutor,
    requestIdFactory: createNodeRuleHoldRequestIdFactory(),
  });

  const decimalComparer = createDecimalAmountComparer();
  const ledgerArithmetic = createLedgerPostArithmetic();
  const materializationLedger = createPostgresMaterializationLedger({
    pool: dependencies.materializationLedgerPool,
    contracts: dependencies.contracts,
  });

  const semanticGate = createPacketSemanticGate({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    decimalComparer,
    ruleHoldEvaluator,
    proposalReceiptLookup: readers.proposalReceipts,
    assetAcceptanceLookup: materializationLedger,
    contentUpgradeAuthorizationLookup:
      contentUpgradeAuthorizationLedger,
    contentUpgradeAuthorizationAuthority,
    contentUpgradeClock,
    staticComponentDigestLookup: dependencies.contentRuntimeCatalog,
    stageOpenContractLookup: stageContracts,
    deterministicContextAuthority,
  });
  const stateTransition = createPacketStateTransition({
    ledgerArithmetic,
  });
  const world = createWorldCore({
    contracts: dependencies.contracts,
    semanticGate,
    stateTransition,
    store,
  });
  const mutations = createWorldMutationOrchestrator({
    world,
    packets,
    committedPackets: readers.packets,
    rulePluginProvenance: rulePluginGateway.provenance,
  });
  const materializations = createMaterializationOrchestrator({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    catalog: dependencies.contentRuntimeCatalog,
    providers: dependencies.assetProviders,
    ledger: materializationLedger,
    worlds: readers.worlds,
    deterministicContexts: deterministicContextAuthority,
    identities: createNodeMaterializationIdentityFactory(),
    clock: createSystemMaterializationClock(),
    mutations,
  });

  const worldBindingResolver = createRuntimeWorldBindingResolver({
    worlds: readers.worlds,
    catalog: dependencies.contentRuntimeCatalog,
  });
  const materializer = createPromptMaterializer({
    catalog: dependencies.contentRuntimeCatalog,
    digest: dependencies.digest,
  });
  const models = createRuntimeModelFacades({
    digest: dependencies.digest,
    worldBindingResolver,
    materializer,
    modelGateway,
    journal,
    events: readers.events,
  });
  const worldExtensions = createWorldExtensionOrchestrator({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    worlds: worldBindingResolver,
    identities: createNodeWorldExtensionExecutionIdentityFactory(),
    provenanceClock: createSystemWorldExtensionProvenanceClock(),
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    mutations,
  });
  const dayCycle = createDayCycleOrchestrator({
    worlds: worldBindingResolver,
    identities: createPostgresDayCycleExecutionIdentityJournal({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      idFactory: createNodeDayCycleExecutionIdFactory(),
    }),
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    models,
    mutations,
    worldExtensions,
    directorDailySettlementModelProfileId:
      dependencies.directorDailySettlementModelProfileId,
    characterReactModelProfileId:
      dependencies.characterReactModelProfileId,
  });
  const serverEnvelopeIds = createNodeServerEnvelopeIdFactory();
  const serverEnvelopes = createServerEnvelopeFactory({
    contracts: dependencies.contracts,
    idFactory: serverEnvelopeIds,
  });
  const commandFinalizer = createPostgresCommandFinalizer({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
    views: sessionViews,
    envelopes: serverEnvelopes,
    idFactory: serverEnvelopeIds,
    stageOpens,
  });
  const dialogues = createDialogueCommandOrchestrator({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    catalog: dependencies.contentRuntimeCatalog,
    commands,
    worlds: worldBindingResolver,
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    models,
    mutations,
    finalizer: commandFinalizer,
    directorRuns: createPostgresDialogueDirectorRunJournal({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      idFactory: createNodeCommandExecutionIdFactory(),
    }),
    commitmentIds: createNodeDialogueCommitmentIdFactory(),
    characterDialogueModelProfileId:
      dependencies.characterDialogueModelProfileId,
    directorDialogueEventsModelProfileId:
      dependencies.directorDialogueEventsModelProfileId,
    directorSystemDialogueModelProfileId:
      dependencies.directorSystemDialogueModelProfileId,
  });
  const eventCards = createEventCardCommandOrchestrator({
    contracts: dependencies.contracts,
    commands,
    mutations,
    finalizer: commandFinalizer,
  });
  const dialogueCloses = createDialogueCloseCommandOrchestrator({
    contracts: dependencies.contracts,
    commands,
    worlds: worldBindingResolver,
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    mutations,
    finalizer: commandFinalizer,
  });
  const playerDays = createPlayerDayCommandOrchestrator({
    contracts: dependencies.contracts,
    commands,
    runs: createPostgresPlayerDayEndRunJournal({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
    }),
    dayCycle,
    finalizer: commandFinalizer,
  });
  const mapMoves = createMapMoveCommandOrchestrator({
    contracts: dependencies.contracts,
    commands,
    worlds: worldBindingResolver,
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    mutations,
    finalizer: commandFinalizer,
  });
  const stageOutcomes = createStageOutcomeCommandOrchestrator({
    contracts: dependencies.contracts,
    commands,
    worlds: worldBindingResolver,
    stageContracts,
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    mutations,
    finalizer: commandFinalizer,
  });
  const contentUpgrades = createContentUpgradeOrchestrator({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    commands,
    worlds: worldBindingResolver,
    saves,
    saveCompatibility,
    catalog: dependencies.contentRuntimeCatalog,
    rulePluginAbi,
    rulePlugins: rulePluginExecutor,
    deterministicContexts: deterministicContextAuthority,
    authorizations: contentUpgradeAuthorizationAuthority,
    authorizationLedger: contentUpgradeAuthorizationLedger,
    clock: contentUpgradeClock,
    mutations,
    finalizer: commandFinalizer,
  });
  const sessionSynchronization =
    createPostgresSessionSynchronization({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      views: sessionViews,
      envelopes: serverEnvelopes,
      stageOpens,
    });
  const clientCommands = createClientCommandRouter({
    contracts: dependencies.contracts,
    dialogues,
    dialogueCloses,
    eventCards,
    mapMoves,
    playerDays,
    stageOutcomes,
    contentUpgrades,
    sessionSynchronization,
  });

  const deterministicContexts: DeterministicContextIssuePort = Object.freeze({
    issue(
      input: DeterministicContextIssueInput,
    ): DeterministicContextDocument {
      return deterministicContextAuthority.issue(input);
    },
  });

  const kernel: RuntimeExecutionKernel = {
    readers,
    packets,
    mutations,
    materializations,
    contentUpgrades,
    models,
    deterministicContexts,
    sessions,
    commands,
    dialogues,
    dialogueCloses,
    eventCards,
    mapMoves,
    playerDays,
    clientCommands,
    dayCycle,
    worldExtensions,
    stageOutcomes,
    worldCreation,
    saves,
    executeRulePlugin(
      candidate: unknown,
      modelInvocations: readonly VerifiedModelInvocationReceipt[],
    ): Promise<VerifiedRulePluginInvocationReceipt> {
      return executeRulePluginInvocation({
        rulePluginExecutor,
        candidate,
        modelInvocations,
      });
    },
  };
  return Object.freeze(kernel);
}

async function executeRulePluginInvocation(input: {
  readonly rulePluginExecutor: RulePluginExecutor;
  readonly candidate: unknown;
  readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
}): Promise<VerifiedRulePluginInvocationReceipt> {
  return input.rulePluginExecutor.execute(
    input.candidate,
    input.modelInvocations,
  );
}
