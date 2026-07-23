import {
  EngineFault,
  type ContractValidator,
  type JsonDigest,
} from "@luoxia/contracts-runtime";
import {
  createDeterministicContextAuthority,
  createPacketSemanticGate,
  createPacketStateTransition,
  createWorldCore,
  type ContentRuntimeCatalog,
  type DeterministicContextAuthority,
  type DeterministicContextDocument,
  type DeterministicContextIdFactory,
  type DeterministicContextIssueInput,
  type DeterministicContextTokenCodec,
  type RulePluginProposalReceiptLookup,
} from "@luoxia/world-core/composition";
import type { Pool } from "pg";

import { createPostgresAtomicPacketStore } from "../adapters/postgres/atomic-packet-store.js";
import {
  createPostgresRuntimeInvocationJournal,
  type PostgresRuntimeInvocationJournal,
} from "../adapters/postgres/runtime-invocation-journal.js";
import {
  createPostgresRulePluginProposalReceiptStore,
} from "../adapters/postgres/rule-plugin-proposal-receipt-store.js";
import {
  createPostgresRuntimeReaders,
  type PostgresRuntimeReaders,
} from "../adapters/postgres/runtime-readers.js";
import {
  createAuthoritativePacketBuilder,
  type AuthoritativePacketBuilder,
} from "./authoritative-packet-builder.js";
import {
  createDecimalAmountComparer,
  createLedgerPostArithmetic,
} from "./decimal-ledger.js";
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
import { createRuleHoldEvaluator } from "./rule-hold-evaluator.js";
import { createRuntimeWorldBindingResolver } from "./runtime-world-binding.js";
import {
  createRulePluginAbiRegistry,
  type RulePluginDependencyIdentity,
  type RulePluginModuleV1,
} from "./rule-plugin-abi.js";
import type { RulePluginOperationRequirement } from "./rule-plugin-operation-requirement.js";
import { createRulePluginGateway } from "./rule-plugin-composition.js";
import type { VerifiedRulePluginInvocationReceipt } from "./rule-plugin-gateway.js";
import type {
  CommittedEventReader,
  CommittedPacketReader,
  RulePluginProposalReceiptStore,
  RuntimeWorldReader,
} from "./runtime-persistence.js";
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
   * Content-derived operation requirements (WorldLaw.evaluator, navigation_resolver).
   * Validated against the sole ABI registry before Gateway construction.
   */
  readonly rulePluginOperationRequirements: readonly RulePluginOperationRequirement[];
  /** Locked ContentBundle index; also supplies StaticComponentDigestLookup. */
  readonly contentRuntimeCatalog: ContentRuntimeCatalog;
  /**
   * Server HMAC TokenCodec for DeterministicContext.issuer_token.
   * Built at composition root from an explicit keyring; no defaults.
   */
  readonly deterministicContextTokenCodec: DeterministicContextTokenCodec;
  /** Server-owned context_id factory; Authority is the only caller. */
  readonly deterministicContextIdFactory: DeterministicContextIdFactory;
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
   * Sole DeterministicContext issue entry for future day-cycle / dialogue orchestration.
   * Does not implement orchestration itself.
   */
  readonly deterministicContexts: DeterministicContextIssuePort;
  executeRulePlugin(
    candidate: unknown,
    modelInvocations: readonly VerifiedModelInvocationReceipt[],
  ): Promise<VerifiedRulePluginInvocationReceipt>;
}

export function createRuntimeExecutionKernel(
  dependencies: RuntimeExecutionKernelDependencies,
): RuntimeExecutionKernel {
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
  const rulePluginAdapter = rulePluginAbi.createAdapter();

  const rulePluginGateway = createRulePluginGateway({
    contracts: dependencies.contracts,
    digest: dependencies.digest,
    adapter: rulePluginAdapter,
    modelProvenance: modelGateway.provenance,
    deterministicContextAuthority,
  });

  const proposalReceiptStore: RulePluginProposalReceiptStore =
    createPostgresRulePluginProposalReceiptStore({
      pool: dependencies.pool,
      contracts: dependencies.contracts,
      rulePluginProvenance: rulePluginGateway.provenance,
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
        return proposalReceiptStore.findByProposalId(proposalId);
      },
    }),
  });

  const packets = createAuthoritativePacketBuilder({
    contracts: dependencies.contracts,
    rulePluginProvenance: rulePluginGateway.provenance,
    worlds: readers.worlds,
    events: readers.events,
  });

  const store = createPostgresAtomicPacketStore({
    pool: dependencies.pool,
    contracts: dependencies.contracts,
  });

  const ruleHoldEvaluator = createRuleHoldEvaluator({
    catalog: dependencies.contentRuntimeCatalog,
    abi: rulePluginAbi,
    rulePluginGateway,
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
    executeRulePlugin(
      candidate: unknown,
      modelInvocations: readonly VerifiedModelInvocationReceipt[],
    ): Promise<VerifiedRulePluginInvocationReceipt> {
      return executeRulePluginInvocation({
        rulePluginGateway,
        proposalReceiptStore,
        candidate,
        modelInvocations,
      });
    },
  };
  return Object.freeze(kernel);
}

async function executeRulePluginInvocation(input: {
  readonly rulePluginGateway: ReturnType<typeof createRulePluginGateway>;
  readonly proposalReceiptStore: RulePluginProposalReceiptStore;
  readonly candidate: unknown;
  readonly modelInvocations: readonly VerifiedModelInvocationReceipt[];
}): Promise<VerifiedRulePluginInvocationReceipt> {
  const receipt = await input.rulePluginGateway.resolve(
    input.candidate,
    input.modelInvocations,
  );
  await input.proposalReceiptStore.persistPacketProposal(receipt);
  return receipt;
}
