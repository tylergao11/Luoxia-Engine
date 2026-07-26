import {
  EngineFault,
  type ContractValidator,
  type JsonDigest,
} from "@luoxia/contracts-runtime";
import {
  createDeterministicContextAuthority,
  createPacketSemanticGate,
  createPacketStateTransition,
  createSessionViewProjector,
  createWorldCore,
  type ContentRuntimeCatalog,
  type ContentRuntimeIdentityMapper,
  type DeterministicContextAuthority,
  type DeterministicContextDocument,
  type DeterministicContextIdFactory,
  type DeterministicContextIssueInput,
  type DeterministicContextTokenCodec,
  type RulePluginProposalReceiptLookup,
} from "@luoxia/world-core/composition";
import type { Pool } from "pg";

import { createNodeCommandExecutionIdFactory } from "../adapters/crypto/command-execution-id-factory.js";
import { createNodeDayCycleExecutionIdFactory } from "../adapters/crypto/day-cycle-execution-id-factory.js";
import { createNodeDialogueCommitmentIdFactory } from "../adapters/crypto/dialogue-commitment-id-factory.js";
import { createNodeEngineSessionIdFactory } from "../adapters/crypto/engine-session-id-factory.js";
import { createNodeRuleHoldRequestIdFactory } from "../adapters/crypto/rule-hold-request-id-factory.js";
import { createNodeRuntimeWorldCreationIdFactory } from "../adapters/crypto/runtime-world-creation-id-factory.js";
import { createNodeServerEnvelopeIdFactory } from "../adapters/crypto/server-envelope-id-factory.js";
import {
  createHmacSessionBasisTokenAuthority,
  type SessionBasisHmacKeyring,
} from "../adapters/crypto/session-basis-hmac-authority.js";
import { createPostgresAtomicPacketStore } from "../adapters/postgres/atomic-packet-store.js";
import { createPostgresCommandJournal } from "../adapters/postgres/command-journal.js";
import { createPostgresDayCycleExecutionIdentityJournal } from "../adapters/postgres/day-cycle-execution-identity.js";
import { createPostgresDialogueDirectorRunJournal } from "../adapters/postgres/dialogue-director-run.js";
import { createPostgresCommandFinalizer } from "../adapters/postgres/command-finalizer.js";
import { createPostgresEngineSessionRepository } from "../adapters/postgres/engine-session-repository.js";
import { createPostgresPlayerDayEndRunJournal } from "../adapters/postgres/player-day-end-run.js";
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
import { createSystemRuntimeSaveClock } from "../adapters/system/runtime-save-clock.js";
import { createSystemRuntimeWorldCreationClock } from "../adapters/system/runtime-world-creation-clock.js";
import {
  createAuthoritativePacketBuilder,
  type AuthoritativePacketBuilder,
} from "./authoritative-packet-builder.js";
import {
  createClientCommandRouter,
  type ClientCommandRouter,
} from "./client-command-router.js";
import type { CommandJournal } from "./command-journal.js";
import {
  createDayCycleOrchestrator,
  type DayCycleOrchestrator,
} from "./day-cycle-orchestrator.js";
import {
  createDialogueCommandOrchestrator,
  type DialogueCommandOrchestrator,
} from "./dialogue-command-orchestrator.js";
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
import {
  createWorldMutationOrchestrator,
  type WorldMutationOrchestrator,
} from "./world-mutation-orchestrator.js";

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
  /** Explicit SaveEnvelope version support; no package-version inference. */
  readonly saveSchemaVersion: string;
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
  /** Recoverable sealed EventCard trigger/invalidation command path. */
  readonly eventCards: EventCardCommandOrchestrator;
  /** Recoverable player_day.end command path. */
  readonly playerDays: PlayerDayCommandOrchestrator;
  /** Closed Client Bridge command dispatch; unsupported kinds fail explicitly. */
  readonly clientCommands: ClientCommandRouter;
  /** Recoverable autonomous → Director → player world-day authority. */
  readonly dayCycle: DayCycleOrchestrator;
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
  const sessionBasisTokens = createHmacSessionBasisTokenAuthority({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    keyring: dependencies.sessionBasisHmacKeyring,
  });
  const sessions = createEngineSessionService({
    repository: createPostgresEngineSessionRepository({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      idFactory: createNodeEngineSessionIdFactory(),
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
  });
  const saves = createRuntimeSaveService({
    contracts: dependencies.contracts,
    compatibility: saveCompatibility,
    repository: createPostgresRuntimeSaveRepository({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
    }),
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
  });

  const ruleHoldEvaluator = createRuleHoldEvaluator({
    catalog: dependencies.contentRuntimeCatalog,
    abi: rulePluginAbi,
    rulePluginExecutor,
    requestIdFactory: createNodeRuleHoldRequestIdFactory(),
  });

  const decimalComparer = createDecimalAmountComparer();
  const ledgerArithmetic = createLedgerPostArithmetic();

  const semanticGate = createPacketSemanticGate({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    decimalComparer,
    ruleHoldEvaluator,
    proposalReceiptLookup: readers.proposalReceipts,
    staticComponentDigestLookup: dependencies.contentRuntimeCatalog,
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
    directorDailySettlementModelProfileId:
      dependencies.directorDailySettlementModelProfileId,
    characterReactModelProfileId:
      dependencies.characterReactModelProfileId,
  });
  const commandFinalizer = createPostgresCommandFinalizer({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
    basisTokens: sessionBasisTokens,
    projector: createSessionViewProjector({
      contracts: dependencies.contracts,
    }),
    idFactory: createNodeServerEnvelopeIdFactory(),
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
  const clientCommands = createClientCommandRouter({
    contracts: dependencies.contracts,
    dialogues,
    eventCards,
    playerDays,
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
    models,
    deterministicContexts,
    sessions,
    commands,
    dialogues,
    eventCards,
    playerDays,
    clientCommands,
    dayCycle,
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
