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
  type JsonValue,
  type SaveEnvelopeDocument,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime/portable";

import type {
  ContentUpgradeAuthorizationAuthority,
  ContentPacketDocument,
  DeterministicContextAuthority,
  PacketSemanticGate,
  StateMachineContractAuthority,
  WorldSnapshotDocument,
} from "./composition.js";

/**
 * RFC 8785 JCS UTF-8 SHA-256 digest of a JSON value.
 * Owned by the composition root (typically contracts-runtime Rfc8785JsonDigest).
 */
export interface PacketContentDigest {
  sha256(value: JsonValue): string;
}

/**
 * Authoritative comparison of DecimalString ledger amounts.
 * Precision and rounding policy are owned by the composition root.
 * Returns true when `balance` is greater than or equal to `minimum`.
 */
export interface DecimalAmountComparer {
  isAtLeast(balance: string, minimum: string): boolean;
}

/**
 * Authoritative evaluation of a RuleRef against a locked world snapshot.
 * Content-rule semantics and Catalog resolution are owned by the composition root.
 */
export interface RuleHoldEvaluator {
  holds(input: {
    readonly rule: JsonObject;
    readonly worldId: string;
    readonly worldRevision: number;
    readonly worldState: JsonObject;
    /** Full ContentPacket.deterministic_context; not inventing Schema fields. */
    readonly deterministicContext: JsonObject;
    /** Stable path of this exact rule.holds occurrence within the packet. */
    readonly packetId: string;
    readonly preconditionPath: string;
  }): Promise<boolean>;
}

/**
 * Lookup of authorized rule_plugin proposal receipts by proposal_id.
 * Returned values remain untrusted until validated as the canonical PacketProposal Schema.
 */
export interface RulePluginProposalReceiptLookup {
  findByProposalId(proposalId: string): Promise<unknown | undefined>;
}

/**
 * Authoritative Materialization Ledger record behind one AssetAcceptance.
 * Every returned JSON value remains untrusted until validated against its
 * owning materialization contract.
 */
export interface AssetAcceptanceAuthorizationRecord {
  readonly request: unknown;
  readonly candidate: unknown;
  readonly review: unknown;
  readonly acceptance: unknown;
}

export interface AssetAcceptanceAuthorizationLookup {
  findByAcceptanceId(
    acceptanceId: string,
  ): Promise<AssetAcceptanceAuthorizationRecord | undefined>;
}

/**
 * Commit-ready Content Upgrade evidence. The Server adapter may reconstruct
 * the RulePlugin request/response from its invocation journal, but World Core
 * treats every returned document as untrusted until its Schema and identities
 * are rechecked here.
 */
export interface ContentUpgradeAuthorizationRecord {
  readonly authorization: unknown;
  readonly request: unknown;
  readonly response: unknown;
}

export interface ContentUpgradeAuthorizationLookup {
  findByUpgradeCommandId(
    upgradeCommandId: string,
  ): Promise<ContentUpgradeAuthorizationRecord | undefined>;
}

export interface ContentUpgradeAuthorizationClock {
  now(): string;
}

/**
 * Resolves the authoritative value digest of a component on a locked static definition.
 * The implementation owns ContentBundle lock and Catalog lookup; World Core owns comparison.
 */
export interface StaticComponentDigestLookup {
  findValueDigest(input: {
    readonly definition: JsonObject;
    readonly componentType: JsonValue;
    readonly ordinal: number;
  }): Promise<string | undefined>;
}

/**
 * Exact content/deployment authority for one StageOpenOp. The caller supplies
 * only facts validated from the same locked SaveEnvelope as the WorldSnapshot.
 * Implementations must resolve the WorldContentLock through the registered
 * ContentBundle and the exact StageModuleLock through the deployment registry.
 */
export interface StageOpenContractLookup {
  assertAllowed(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
    readonly completionRules: readonly JsonObject[];
  }): void;
}

export interface PacketSemanticGateDependencies {
  readonly contracts: ContractValidator;
  readonly digest: PacketContentDigest;
  readonly decimalComparer: DecimalAmountComparer;
  readonly ruleHoldEvaluator: RuleHoldEvaluator;
  readonly proposalReceiptLookup: RulePluginProposalReceiptLookup;
  readonly assetAcceptanceLookup: AssetAcceptanceAuthorizationLookup;
  readonly contentUpgradeAuthorizationLookup:
    ContentUpgradeAuthorizationLookup;
  readonly contentUpgradeAuthorizationAuthority:
    ContentUpgradeAuthorizationAuthority;
  readonly contentUpgradeClock: ContentUpgradeAuthorizationClock;
  readonly staticComponentDigestLookup: StaticComponentDigestLookup;
  readonly stageOpenContractLookup: StageOpenContractLookup;
  readonly stateMachineContracts: StateMachineContractAuthority;
  /** Sole DeterministicContext authenticity authority for this composition. */
  readonly deterministicContextAuthority: DeterministicContextAuthority;
}

const PRECONDITION_KINDS = [
  "world.revision_is",
  "entity.revision_is",
  "definition.revision_is",
  "component.value_digest_is",
  "relation.exists",
  "ledger.balance_at_least",
  "rule.holds",
  "stage.revision_is",
  "day_cycle.is",
  "event_card.status_is",
  "agency.commitment_valid",
] as const;

type PreconditionKind = (typeof PRECONDITION_KINDS)[number];

const SOURCE_KINDS = [
  "rule_plugin",
  "sealed_event_result",
  "asset_acceptance",
  "content_upgrade",
] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

interface EvaluationContext {
  readonly packet: JsonObject;
  readonly snapshot: JsonObject;
  readonly worldId: string;
  readonly worldRevision: number;
  readonly worldState: JsonObject;
  readonly authorityEnvelope: JsonObject;
  readonly dependencies: PacketSemanticGateDependencies;
}

type PreconditionHandler = (
  precondition: JsonObject,
  context: EvaluationContext,
  preconditionPath: string,
) => Promise<void>;

type SourceHandler = (
  source: JsonObject,
  context: EvaluationContext,
) => Promise<void>;

class PreconditionUnsatisfiedFault extends EngineFault {
  public constructor(message: string, details: JsonObject) {
    super("world.packet.precondition_failed", message, details);
  }
}

export function createPacketSemanticGate(
  dependencies: PacketSemanticGateDependencies,
): PacketSemanticGate {
  return new DefaultPacketSemanticGate(dependencies);
}

class DefaultPacketSemanticGate implements PacketSemanticGate {
  readonly #dependencies: PacketSemanticGateDependencies;

  public constructor(dependencies: PacketSemanticGateDependencies) {
    this.#dependencies = dependencies;
  }

  public async assertApplicable(
    packet: ContentPacketDocument,
    snapshot: WorldSnapshotDocument,
    authorityEnvelope: SaveEnvelopeDocument,
  ): Promise<void> {
    const packetValue = packet.value;
    const snapshotValue = snapshot.value;
    const worldState = expectJsonObject(
      expectProperty(snapshotValue, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const context: EvaluationContext = {
      packet: packetValue,
      snapshot: snapshotValue,
      worldId: expectString(snapshotValue, "world_id", "WorldSnapshot"),
      worldRevision: expectInteger(
        snapshotValue,
        "world_revision",
        "WorldSnapshot",
      ),
      worldState,
      authorityEnvelope: authorityEnvelope.value,
      dependencies: this.#dependencies,
    };

    assertPacketIdentity(context);
    this.#dependencies.deterministicContextAuthority.assertAuthentic(
      expectProperty(
        packetValue,
        "deterministic_context",
        "ContentPacket",
      ),
      context.worldId,
    );
    await assertPacketSource(context);
    await assertAllPreconditions(
      asObjectArray(
        expectProperty(packetValue, "preconditions", "ContentPacket"),
        "ContentPacket.preconditions",
      ),
      context,
    );
    assertStateMachineContracts(context);
    assertStageOpenContracts(context);
  }
}

function assertStateMachineContracts(context: EvaluationContext): void {
  const ops = asObjectArray(
    expectProperty(context.packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  if (
    !ops.some((op) =>
      expectString(op, "op", "EffectOp").startsWith("state_machine."),
    )
  ) {
    return;
  }
  const worldContentLock = context.dependencies.contracts.assertObject(
    CONTRACT_REF.worldContentLock,
    expectProperty(
      context.authorityEnvelope,
      "world_content_lock",
      "SaveEnvelope",
    ),
  );
  const preconditions = asObjectArray(
    expectProperty(context.packet, "preconditions", "ContentPacket"),
    "ContentPacket.preconditions",
  );
  const shadowInstances = new Map(
    asObjectArray(
      expectProperty(context.worldState, "state_machines", "WorldState"),
      "WorldState.state_machines",
    ).map((instance) => [
      expectString(
        instance,
        "instance_id",
        "StateMachineInstanceState",
      ),
      instance,
    ]),
  );

  for (const op of ops) {
    const opName = expectString(op, "op", "EffectOp");
    if (opName === "state_machine.create") {
      const machineRef = expectJsonObject(
        expectProperty(op, "machine", "StateMachineCreateOp"),
        "StateMachineCreateOp.machine",
      );
      const machine =
        context.dependencies.stateMachineContracts.resolveLockedMachine({
          worldContentLock,
          machine: machineRef,
        });
      const instanceId = expectString(
        op,
        "instance_id",
        "StateMachineCreateOp",
      );
      if (shadowInstances.has(instanceId)) {
        throw fault(
          "world.packet.state_machine_instance_duplicate",
          "State machine create reuses an existing instance ID",
          { instance_id: instanceId },
        );
      }
      const instance: JsonObject = {
        instance_id: instanceId,
        machine: machineRef,
        owner: expectJsonObject(
          expectProperty(op, "owner", "StateMachineCreateOp"),
          "StateMachineCreateOp.owner",
        ),
        state_id: expectString(
          machine.initialState,
          "state_id",
          "MachineStateDefinition",
        ),
        entered_day: expectInteger(
          expectJsonObject(
            expectProperty(context.worldState, "day_cycle", "WorldState"),
            "WorldState.day_cycle",
          ),
          "day",
          "DayCycleState",
        ),
      };
      context.dependencies.stateMachineContracts.assertLockedInstance({
        worldContentLock,
        worldId: context.worldId,
        instance,
      });
      shadowInstances.set(instanceId, instance);
      continue;
    }
    if (opName !== "state_machine.transition") {
      continue;
    }

    const instanceId = expectString(
      op,
      "machine_instance_id",
      "StateMachineTransitionOp",
    );
    const instance = shadowInstances.get(instanceId);
    if (instance === undefined) {
      throw fault(
        "world.packet.state_machine_instance_missing",
        "State machine transition references an absent instance",
        { instance_id: instanceId },
      );
    }
    const transitionId = expectString(
      op,
      "transition_id",
      "StateMachineTransitionOp",
    );
    const resolved =
      context.dependencies.stateMachineContracts.resolveLockedTransition({
        worldContentLock,
        worldId: context.worldId,
        instance,
        transitionId,
      });
    shadowInstances.set(instanceId, {
      ...instance,
      state_id: expectString(
        resolved.toState,
        "state_id",
        "MachineStateDefinition",
      ),
    });
    const guard = resolved.transition["guard"];
    if (guard === undefined) {
      continue;
    }
    const guardRule = expectJsonObject(
      guard,
      "MachineTransitionDefinition.guard",
    );
    const matchingGuardEvidence = preconditions.filter(
      (precondition) =>
        expectString(precondition, "kind", "PacketPrecondition") ===
          "rule.holds" &&
        jsonEquals(
          expectProperty(precondition, "rule", "PacketPrecondition"),
          guardRule,
        ),
    );
    if (matchingGuardEvidence.length !== 1) {
      throw fault(
        "world.packet.state_machine_guard_evidence",
        "Guarded state machine transition requires exactly one matching rule.holds precondition",
        {
          instance_id: instanceId,
          transition_id: transitionId,
          matching_preconditions: matchingGuardEvidence.length,
        },
      );
    }
  }
}

function assertStageOpenContracts(context: EvaluationContext): void {
  const stageOpenOps = asObjectArray(
    expectProperty(context.packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  ).filter((op) => expectString(op, "op", "EffectOp") === "stage.open");
  if (stageOpenOps.length === 0) {
    return;
  }

  const worldContentLock = context.dependencies.contracts.assertObject(
    CONTRACT_REF.worldContentLock,
    expectProperty(
      context.authorityEnvelope,
      "world_content_lock",
      "SaveEnvelope",
    ),
  );
  const stageModuleLocks = asObjectArray(
    expectProperty(
      context.authorityEnvelope,
      "stage_module_locks",
      "SaveEnvelope",
    ),
    "SaveEnvelope.stage_module_locks",
  );

  for (const op of stageOpenOps) {
    context.dependencies.stageOpenContractLookup.assertAllowed({
      worldContentLock,
      stageModuleLocks,
      stageModuleLock: expectJsonObject(
        expectProperty(op, "stage_module_lock", "StageOpenOp"),
        "StageOpenOp.stage_module_lock",
      ),
      sceneId: expectString(op, "scene_id", "StageOpenOp"),
      completionRules: asObjectArray(
        expectProperty(op, "completion_rules", "StageOpenOp"),
        "StageOpenOp.completion_rules",
      ),
    });
  }
}

function assertPacketIdentity(context: EvaluationContext): void {
  assertEqual(
    "packet.world_id",
    context.worldId,
    expectString(context.packet, "world_id", "ContentPacket"),
  );
  assertEqual(
    "packet.basis_revision",
    context.worldRevision,
    expectInteger(context.packet, "basis_revision", "ContentPacket"),
  );
}

async function assertAllPreconditions(
  preconditions: readonly JsonObject[],
  context: EvaluationContext,
): Promise<void> {
  for (const [index, precondition] of preconditions.entries()) {
    const kind = expectString(
      precondition,
      "kind",
      `ContentPacket.preconditions[${index}]`,
    ) as PreconditionKind;
    const handler = PRECONDITION_HANDLERS[kind];
    if (handler === undefined) {
      throw fault(
        "world.packet.precondition_unknown",
        `Unknown PacketPrecondition kind ${kind}`,
        {
          kind,
          path: `ContentPacket.preconditions[${index}]`,
        },
      );
    }
    await handler(
      precondition,
      context,
      `ContentPacket.preconditions[${index}]`,
    );
  }
}

async function assertPacketSource(context: EvaluationContext): Promise<void> {
  const source = expectJsonObject(
    expectProperty(context.packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const sourceKind = expectString(
    source,
    "source_kind",
    "PacketSource",
  ) as SourceKind;
  const handler = SOURCE_HANDLERS[sourceKind];
  if (handler === undefined) {
    throw fault(
      "world.packet.source_unknown",
      `Unknown PacketSource source_kind ${sourceKind}`,
      { source_kind: sourceKind },
    );
  }
  await handler(source, context);
}

const PRECONDITION_HANDLERS: {
  readonly [K in PreconditionKind]: PreconditionHandler;
} = {
  "world.revision_is": async (precondition, context) => {
    assertPreconditionEqual(
      "world.revision_is",
      "world.revision_is",
      expectInteger(precondition, "revision", "PacketPrecondition"),
      context.worldRevision,
    );
  },
  "entity.revision_is": async (precondition, context) => {
    const entityId = expectString(precondition, "entity_id", "PacketPrecondition");
    const expected = expectInteger(precondition, "revision", "PacketPrecondition");
    const entity = findEntity(context.worldState, entityId);
    if (entity === undefined) {
      throw preconditionFailure(
        "entity.revision_is",
        `Entity ${entityId} is absent from world state`,
        { entity_id: entityId },
      );
    }
    assertPreconditionEqual(
      "entity.revision_is",
      "entity.revision_is",
      expected,
      expectInteger(entity, "revision", "EntityState"),
    );
  },
  "definition.revision_is": async (precondition, context) => {
    const definitionId = expectString(
      precondition,
      "definition_id",
      "PacketPrecondition",
    );
    const expected = expectInteger(precondition, "revision", "PacketPrecondition");
    const definition = findDynamicDefinition(context.worldState, definitionId);
    if (definition === undefined) {
      throw preconditionFailure(
        "definition.revision_is",
        `Dynamic definition ${definitionId} is absent from world state`,
        { definition_id: definitionId },
      );
    }
    assertPreconditionEqual(
      "definition.revision_is",
      "definition.revision_is",
      expected,
      expectInteger(definition, "revision", "DynamicDefinitionState"),
    );
  },
  "component.value_digest_is": async (precondition, context) => {
    const subject = expectJsonObject(
      expectProperty(precondition, "subject", "PacketPrecondition"),
      "PacketPrecondition.subject",
    );
    const componentType = expectProperty(
      precondition,
      "component_type",
      "PacketPrecondition",
    );
    const ordinal = expectInteger(precondition, "ordinal", "PacketPrecondition");
    const expectedDigest = expectString(
      precondition,
      "value_digest",
      "PacketPrecondition",
    );
    const actualDigest = await resolveComponentValueDigest(
      context,
      subject,
      componentType,
      ordinal,
    );
    if (actualDigest === undefined) {
      throw preconditionFailure(
        "component.value_digest_is",
        "Component referenced by precondition is absent",
        { ordinal },
      );
    }
    assertPreconditionEqual(
      "component.value_digest_is",
      "component.value_digest_is",
      expectedDigest,
      actualDigest,
    );
  },
  "relation.exists": async (precondition, context) => {
    const relationId = expectString(
      precondition,
      "relation_id",
      "PacketPrecondition",
    );
    const expectedExists = precondition.exists;
    if (typeof expectedExists !== "boolean") {
      throw fault(
        "world.packet.precondition_shape",
        "relation.exists precondition requires boolean exists",
        { kind: "relation.exists" },
      );
    }
    const relation = findRelation(context.worldState, relationId);
    const actualExists =
      relation !== undefined &&
      expectString(relation, "state", "RelationState") === "active";
    if (actualExists !== expectedExists) {
      throw preconditionFailure(
        "relation.exists",
        `relation.exists precondition failed for ${relationId}`,
        {
          relation_id: relationId,
          expected_exists: expectedExists,
          actual_exists: actualExists,
        },
      );
    }
  },
  "ledger.balance_at_least": async (precondition, context) => {
    const ledgerId = expectString(precondition, "ledger_id", "PacketPrecondition");
    const account = expectProperty(precondition, "account", "PacketPrecondition");
    const minimumAmount = expectString(
      precondition,
      "minimum_amount",
      "PacketPrecondition",
    );
    const ledger = findLedger(context.worldState, ledgerId);
    if (ledger === undefined) {
      throw preconditionFailure(
        "ledger.balance_at_least",
        `Ledger ${ledgerId} is absent from world state`,
        { ledger_id: ledgerId },
      );
    }
    const balances = asObjectArray(
      expectProperty(ledger, "balances", "LedgerState"),
      "LedgerState.balances",
    );
    const balanceEntry = balances.find((entry) =>
      jsonEquals(
        expectProperty(entry, "account", "LedgerBalance"),
        account,
      ),
    );
    if (balanceEntry === undefined) {
      throw preconditionFailure(
        "ledger.balance_at_least",
        `Ledger ${ledgerId} has no balance for the requested account`,
        { ledger_id: ledgerId },
      );
    }
    const balance = expectString(balanceEntry, "amount", "LedgerBalance");
    if (!context.dependencies.decimalComparer.isAtLeast(balance, minimumAmount)) {
      throw preconditionFailure(
        "ledger.balance_at_least",
        `ledger.balance_at_least failed for ledger ${ledgerId}`,
        {
          ledger_id: ledgerId,
          balance,
          minimum_amount: minimumAmount,
        },
      );
    }
  },
  "rule.holds": async (precondition, context, preconditionPath) => {
    const rule = expectJsonObject(
      expectProperty(precondition, "rule", "PacketPrecondition"),
      "PacketPrecondition.rule",
    );
    const deterministicContext = expectJsonObject(
      expectProperty(
        context.packet,
        "deterministic_context",
        "ContentPacket",
      ),
      "ContentPacket.deterministic_context",
    );
    const holds = await context.dependencies.ruleHoldEvaluator.holds({
      rule,
      worldId: context.worldId,
      worldRevision: context.worldRevision,
      worldState: context.worldState,
      deterministicContext,
      packetId: expectString(
        context.packet,
        "packet_id",
        "ContentPacket",
      ),
      preconditionPath,
    });
    if (!holds) {
      throw preconditionFailure(
        "rule.holds",
        "rule.holds precondition evaluated to false",
        {
          rule_id: expectString(rule, "rule_id", "RuleRef"),
        },
      );
    }
  },
  "stage.revision_is": async (precondition, context) => {
    const stageInstanceId = expectString(
      precondition,
      "stage_instance_id",
      "PacketPrecondition",
    );
    const expected = expectInteger(precondition, "revision", "PacketPrecondition");
    const stage = findStage(context.worldState, stageInstanceId);
    if (stage === undefined) {
      throw preconditionFailure(
        "stage.revision_is",
        `Stage instance ${stageInstanceId} is absent from world state`,
        {
          stage_instance_id: stageInstanceId,
        },
      );
    }
    assertPreconditionEqual(
      "stage.revision_is",
      "stage.revision_is",
      expected,
      expectInteger(stage, "revision", "StageInstanceState"),
    );
  },
  "day_cycle.is": async (precondition, context) => {
    const dayCycle = expectJsonObject(
      expectProperty(context.worldState, "day_cycle", "WorldState"),
      "WorldState.day_cycle",
    );
    assertPreconditionEqual(
      "day_cycle.is",
      "day_cycle.is.day",
      expectInteger(precondition, "day", "PacketPrecondition"),
      expectInteger(dayCycle, "day", "DayCycleState"),
    );
    assertPreconditionEqual(
      "day_cycle.is",
      "day_cycle.is.phase",
      expectString(precondition, "phase", "PacketPrecondition"),
      expectString(dayCycle, "phase", "DayCycleState"),
    );
  },
  "event_card.status_is": async (precondition, context) => {
    const eventCardId = expectString(
      precondition,
      "event_card_id",
      "PacketPrecondition",
    );
    const expectedStatus = expectString(
      precondition,
      "status",
      "PacketPrecondition",
    );
    const card = findEventCard(context.worldState, eventCardId);
    if (card === undefined) {
      throw preconditionFailure(
        "event_card.status_is",
        `Event card ${eventCardId} is absent from world state`,
        {
          event_card_id: eventCardId,
        },
      );
    }
    assertPreconditionEqual(
      "event_card.status_is",
      "event_card.status_is",
      expectedStatus,
      expectString(card, "status", "EventCardState"),
    );
  },
  "agency.commitment_valid": async (precondition, context) => {
    const commitmentRef = expectJsonObject(
      expectProperty(precondition, "commitment", "PacketPrecondition"),
      "PacketPrecondition.commitment",
    );
    assertAgencyCommitmentValid(context, commitmentRef);
  },
};

const SOURCE_HANDLERS: {
  readonly [K in SourceKind]: SourceHandler;
} = {
  rule_plugin: assertRulePluginSource,
  sealed_event_result: assertSealedEventResultSource,
  asset_acceptance: assertAssetAcceptanceSource,
  content_upgrade: assertContentUpgradeSource,
};

async function assertRulePluginSource(
  source: JsonObject,
  context: EvaluationContext,
): Promise<void> {
  const proposalId = expectString(source, "proposal_id", "PacketSource");
  const receiptCandidate =
    await context.dependencies.proposalReceiptLookup.findByProposalId(proposalId);
  if (receiptCandidate === undefined) {
    throw fault(
      "world.packet.source_receipt_missing",
      `No authorized RulePlugin proposal receipt for proposal_id ${proposalId}`,
      {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    );
  }
  const receipt = context.dependencies.contracts.assertObject(
    CONTRACT_REF.packetProposal,
    receiptCandidate,
  ).value;

  assertEqual(
    "source.proposal_id",
    proposalId,
    expectString(receipt, "proposal_id", "PacketProposal"),
  );
  assertEqual(
    "source.cause_id",
    expectString(context.packet, "cause_id", "ContentPacket"),
    expectString(receipt, "cause_id", "PacketProposal"),
  );
  assertEqual(
    "source.basis_revision",
    expectInteger(context.packet, "basis_revision", "ContentPacket"),
    expectInteger(receipt, "basis_revision", "PacketProposal"),
  );

  const deterministicContext = expectJsonObject(
    expectProperty(
      context.packet,
      "deterministic_context",
      "ContentPacket",
    ),
    "ContentPacket.deterministic_context",
  );
  assertEqual(
    "source.deterministic_context_id",
    expectString(deterministicContext, "context_id", "DeterministicContext"),
    expectString(receipt, "deterministic_context_id", "PacketProposal"),
  );
  assertEqual(
    "source.deterministic_context_digest",
    expectString(deterministicContext, "context_digest", "DeterministicContext"),
    expectString(receipt, "deterministic_context_digest", "PacketProposal"),
  );

  const packetPreconditions = expectProperty(
    context.packet,
    "preconditions",
    "ContentPacket",
  );
  const packetOps = expectProperty(context.packet, "ops", "ContentPacket");
  if (
    !jsonEquals(
      packetPreconditions,
      expectProperty(receipt, "preconditions", "PacketProposal"),
    )
  ) {
    throw fault(
      "world.packet.source_preconditions_mismatch",
      "ContentPacket preconditions do not match authorized proposal receipt",
      {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    );
  }
  if (
    !jsonEquals(
      packetOps,
      expectProperty(receipt, "ops", "PacketProposal"),
    )
  ) {
    throw fault(
      "world.packet.source_ops_mismatch",
      "ContentPacket ops do not match authorized proposal receipt",
      {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    );
  }
  if (
    asObjectArray(packetOps, "ContentPacket.ops").some(
      (op) => expectString(op, "op", "EffectOp") === "visual_binding.upsert",
    )
  ) {
    throw fault(
      "world.packet.visual_binding_source_forbidden",
      "RulePlugin packet source cannot authorize visual_binding.upsert",
      {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    );
  }
  if (
    asObjectArray(packetOps, "ContentPacket.ops").some(
      (op) => expectString(op, "op", "EffectOp") === "content_upgrade.apply",
    )
  ) {
    throw fault(
      "world.packet.content_upgrade_source_forbidden",
      "RulePlugin packet source cannot authorize content_upgrade.apply",
      {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    );
  }
}

async function assertContentUpgradeSource(
  source: JsonObject,
  context: EvaluationContext,
): Promise<void> {
  const upgradeCommandId = expectString(
    source,
    "upgrade_command_id",
    "PacketSource",
  );
  const record =
    await context.dependencies.contentUpgradeAuthorizationLookup
      .findByUpgradeCommandId(upgradeCommandId);
  if (record === undefined) {
    throw fault(
      "world.packet.content_upgrade_authorization_missing",
      "No commit-ready Content Upgrade authorization exists for this packet",
      {
        source_kind: "content_upgrade",
        upgrade_command_id: upgradeCommandId,
      },
    );
  }

  const authorization =
    context.dependencies.contentUpgradeAuthorizationAuthority
      .assertAuthentic(
        record.authorization,
        context.dependencies.contentUpgradeClock.now(),
      ).value;
  const request = context.dependencies.contracts.assertObject(
    CONTRACT_REF.rulePluginRequest,
    record.request,
  ).value;
  const response = context.dependencies.contracts.assertObject(
    CONTRACT_REF.rulePluginResponse,
    record.response,
  ).value;
  const input = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const sourceSave = context.dependencies.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    expectProperty(input, "source_save", "ContentUpgradeInput"),
  ).value;
  const candidateSave = context.dependencies.contracts.assertObject(
    CONTRACT_REF.saveEnvelope,
    expectProperty(output, "candidate_save", "ContentUpgradeOutput"),
  ).value;
  const migrationId = expectString(
    source,
    "migration_id",
    "PacketSource",
  );
  const sourceSaveDigest = expectString(
    source,
    "source_save_digest",
    "PacketSource",
  );
  const authorizationDigest = expectString(
    source,
    "authorization_digest",
    "PacketSource",
  );
  const resultDigest = expectString(
    source,
    "result_digest",
    "PacketSource",
  );

  assertEqual(
    "content_upgrade.request.operation_kind",
    "content_upgrade.transform",
    expectString(request, "operation_kind", "RulePluginRequest"),
  );
  assertEqual(
    "content_upgrade.response.operation_kind",
    "content_upgrade.transform",
    expectString(response, "operation_kind", "RulePluginResponse"),
  );
  assertEqual(
    "content_upgrade.output.output_kind",
    "content_upgrade.candidate",
    expectString(output, "output_kind", "ContentUpgradeOutput"),
  );
  const unresolved = expectProperty(
    output,
    "unresolved",
    "ContentUpgradeOutput",
  );
  if (!Array.isArray(unresolved) || unresolved.length !== 0) {
    throw fault(
      "world.packet.content_upgrade_unresolved",
      "Content Upgrade cannot commit while its verified output has unresolved items",
      { upgrade_command_id: upgradeCommandId },
    );
  }

  for (const [field, expected, actual] of [
    [
      "content_upgrade.packet_id",
      upgradeCommandId,
      expectString(context.packet, "packet_id", "ContentPacket"),
    ],
    [
      "content_upgrade.cause_id",
      migrationId,
      expectString(context.packet, "cause_id", "ContentPacket"),
    ],
    [
      "content_upgrade.authorization.command_id",
      upgradeCommandId,
      expectString(
        authorization,
        "upgrade_command_id",
        "UpgradeAuthorization",
      ),
    ],
    [
      "content_upgrade.authorization.migration_id",
      migrationId,
      expectString(authorization, "migration_id", "UpgradeAuthorization"),
    ],
    [
      "content_upgrade.input.migration_id",
      migrationId,
      expectString(input, "migration_id", "ContentUpgradeInput"),
    ],
    [
      "content_upgrade.output.migration_id",
      migrationId,
      expectString(output, "migration_id", "ContentUpgradeOutput"),
    ],
    [
      "content_upgrade.source_save_digest",
      sourceSaveDigest,
      context.dependencies.digest.sha256(sourceSave),
    ],
    [
      "content_upgrade.authorization.source_save_digest",
      sourceSaveDigest,
      expectString(
        authorization,
        "source_save_digest",
        "UpgradeAuthorization",
      ),
    ],
    [
      "content_upgrade.authorization_digest",
      authorizationDigest,
      expectString(
        authorization,
        "authorization_digest",
        "UpgradeAuthorization",
      ),
    ],
    [
      "content_upgrade.output.authorization_digest",
      authorizationDigest,
      expectString(output, "authorization_digest", "ContentUpgradeOutput"),
    ],
    [
      "content_upgrade.result_digest",
      resultDigest,
      expectString(output, "result_digest", "ContentUpgradeOutput"),
    ],
    [
      "content_upgrade.result_digest.recomputed",
      resultDigest,
      context.dependencies.digest.sha256(omitField(output, "result_digest")),
    ],
    [
      "content_upgrade.world_id",
      context.worldId,
      expectString(sourceSave, "world_id", "SaveEnvelope"),
    ],
    [
      "content_upgrade.authorization.world_id",
      context.worldId,
      expectString(authorization, "world_id", "UpgradeAuthorization"),
    ],
  ] as const) {
    assertEqual(field, expected, actual);
  }
  assertEqual(
    "content_upgrade.source_revision",
    context.worldRevision,
    expectInteger(sourceSave, "world_revision", "SaveEnvelope"),
  );
  assertEqual(
    "content_upgrade.authorization.source_revision",
    context.worldRevision,
    expectInteger(
      authorization,
      "source_world_revision",
      "UpgradeAuthorization",
    ),
  );
  assertJsonEqual(
    "content_upgrade.authorization.input",
    authorization,
    expectProperty(input, "authorization", "ContentUpgradeInput"),
  );
  assertJsonEqual(
    "content_upgrade.source_world_state",
    context.worldState,
    expectProperty(sourceSave, "world_state", "SaveEnvelope"),
  );
  assertJsonEqual(
    "content_upgrade.readonly_world",
    context.snapshot,
    expectProperty(request, "readonly_world", "RulePluginRequest"),
  );
  assertJsonEqual(
    "content_upgrade.deterministic_context",
    expectProperty(
      context.packet,
      "deterministic_context",
      "ContentPacket",
    ),
    expectProperty(request, "deterministic_context", "RulePluginRequest"),
  );
  assertRulePluginRequestResponseIdentity(request, response);

  const preconditions = asObjectArray(
    expectProperty(context.packet, "preconditions", "ContentPacket"),
    "ContentPacket.preconditions",
  );
  if (preconditions.length !== 0) {
    throw fault(
      "world.packet.content_upgrade_preconditions_forbidden",
      "Content Upgrade packet preconditions must be empty; its exact basis and authorization are closed by the special source",
      {
        upgrade_command_id: upgradeCommandId,
        precondition_count: preconditions.length,
      },
    );
  }
  const ops = asObjectArray(
    expectProperty(context.packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  if (
    ops.length !== 1 ||
    expectString(ops[0] as JsonObject, "op", "EffectOp") !==
      "content_upgrade.apply" ||
    !jsonEquals(
      expectProperty(
        ops[0] as JsonObject,
        "candidate_save",
        "ContentUpgradeApplyOp",
      ),
      candidateSave,
    )
  ) {
    throw fault(
      "world.packet.content_upgrade_ops_mismatch",
      "Content Upgrade packet must contain only the exact verified candidate SaveEnvelope",
      { upgrade_command_id: upgradeCommandId },
    );
  }
}

function assertRulePluginRequestResponseIdentity(
  request: JsonObject,
  response: JsonObject,
): void {
  for (const [field, expected, actual] of [
    [
      "content_upgrade.response.request_id",
      expectString(request, "request_id", "RulePluginRequest"),
      expectString(response, "request_id", "RulePluginResponse"),
    ],
    [
      "content_upgrade.response.operation_id",
      expectString(request, "operation_id", "RulePluginRequest"),
      expectString(response, "operation_id", "RulePluginResponse"),
    ],
    [
      "content_upgrade.response.operation_kind",
      expectString(request, "operation_kind", "RulePluginRequest"),
      expectString(response, "operation_kind", "RulePluginResponse"),
    ],
    [
      "content_upgrade.response.basis_revision",
      expectInteger(request, "basis_revision", "RulePluginRequest"),
      expectInteger(response, "basis_revision", "RulePluginResponse"),
    ],
  ] as const) {
    assertEqual(field, expected, actual);
  }
  assertJsonEqual(
    "content_upgrade.response.plugin_lock",
    expectProperty(request, "plugin_lock", "RulePluginRequest"),
    expectProperty(response, "plugin_lock", "RulePluginResponse"),
  );
  const deterministicContext = expectJsonObject(
    expectProperty(request, "deterministic_context", "RulePluginRequest"),
    "RulePluginRequest.deterministic_context",
  );
  assertEqual(
    "content_upgrade.response.deterministic_context_id",
    expectString(
      deterministicContext,
      "context_id",
      "DeterministicContext",
    ),
    expectString(
      response,
      "deterministic_context_id",
      "RulePluginResponse",
    ),
  );
  assertEqual(
    "content_upgrade.response.deterministic_context_digest",
    expectString(
      deterministicContext,
      "context_digest",
      "DeterministicContext",
    ),
    expectString(
      response,
      "deterministic_context_digest",
      "RulePluginResponse",
    ),
  );
}

async function assertSealedEventResultSource(
  source: JsonObject,
  context: EvaluationContext,
): Promise<void> {
  const eventCardId = expectString(source, "event_card_id", "PacketSource");
  const resultId = expectString(source, "result_id", "PacketSource");
  const resultDigest = expectString(source, "result_digest", "PacketSource");

  const card = findEventCard(context.worldState, eventCardId);
  if (card === undefined) {
    throw fault(
      "world.packet.sealed_card_missing",
      `Sealed event source references missing event card ${eventCardId}`,
      {
        source_kind: "sealed_event_result",
        event_card_id: eventCardId,
      },
    );
  }

  assertEqual(
    "sealed_event_result.card_status",
    "available",
    expectString(card, "status", "EventCardState"),
  );

  const sealed = expectJsonObject(
    expectProperty(card, "sealed_result", "EventCardState"),
    "EventCardState.sealed_result",
  );
  assertEqual(
    "sealed_event_result.result_id",
    resultId,
    expectString(sealed, "result_id", "SealedEventResult"),
  );
  assertEqual(
    "sealed_event_result.result_digest.source",
    resultDigest,
    expectString(sealed, "result_digest", "SealedEventResult"),
  );

  const recomputed = context.dependencies.digest.sha256(
    omitField(sealed, "result_digest"),
  );
  assertEqual("sealed_event_result.result_digest.recomputed", resultDigest, recomputed);

  const dayCycle = expectJsonObject(
    expectProperty(context.worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  assertEqual(
    "sealed_event_result.day_cycle.phase",
    "player",
    expectString(dayCycle, "phase", "DayCycleState"),
  );
  assertEqual(
    "sealed_event_result.card.day",
    expectInteger(dayCycle, "day", "DayCycleState"),
    expectInteger(card, "day", "EventCardState"),
  );

  const deterministicContext = expectJsonObject(
    expectProperty(
      context.packet,
      "deterministic_context",
      "ContentPacket",
    ),
    "ContentPacket.deterministic_context",
  );
  assertJsonEqual(
    "sealed_event_result.deterministic_context",
    deterministicContext,
    expectProperty(
      sealed,
      "deterministic_context",
      "SealedEventResult",
    ),
  );

  const sealedPreconditions = asObjectArray(
    expectProperty(sealed, "preconditions", "SealedEventResult"),
    "SealedEventResult.preconditions",
  );
  const packetPreconditions = asObjectArray(
    expectProperty(context.packet, "preconditions", "ContentPacket"),
    "ContentPacket.preconditions",
  );
  const packetOps = asObjectArray(
    expectProperty(context.packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const firstOp = packetOps[0] as JsonObject;
  const lastOp = packetOps[packetOps.length - 1] as JsonObject;
  const isInvalidate =
    packetOps.length === 1 &&
    expectString(firstOp, "op", "EffectOp") === "event_card.invalidate";
  const isTrigger =
    expectString(lastOp, "op", "EffectOp") === "event_card.trigger";

  if (isTrigger) {
    if (!jsonEquals(packetPreconditions, sealedPreconditions)) {
      throw fault(
        "world.packet.sealed_preconditions_mismatch",
        "Trigger packet preconditions must exactly match the sealed result preconditions",
        { event_card_id: eventCardId },
      );
    }
    assertSealedTriggerPacketOps(context, card, sealed, resultDigest);
    return;
  }

  if (isInvalidate) {
    if (packetPreconditions.length !== 0) {
      throw fault(
        "world.packet.sealed_invalidate_preconditions",
        "Invalidation packet preconditions must be empty",
        {
          event_card_id: eventCardId,
          precondition_count: packetPreconditions.length,
        },
      );
    }
    await assertSealedPreconditionFailure(sealedPreconditions, context);
    assertSealedInvalidateOp(firstOp, card);
    return;
  }

  throw fault(
    "world.packet.sealed_branch_invalid",
    "sealed_event_result packet must be either an exact trigger or exact invalidation",
    {
      event_card_id: eventCardId,
      op_count: packetOps.length,
    },
  );
}

async function assertAssetAcceptanceSource(
  source: JsonObject,
  context: EvaluationContext,
): Promise<void> {
  const acceptanceId = expectString(
    source,
    "acceptance_id",
    "PacketSource",
  );
  const authorization =
    await context.dependencies.assetAcceptanceLookup.findByAcceptanceId(
      acceptanceId,
    );
  if (authorization === undefined) {
    throw fault(
      "world.packet.asset_acceptance_missing",
      "No authoritative AssetAcceptance record exists for this packet source",
      {
        source_kind: "asset_acceptance",
        acceptance_id: acceptanceId,
      },
    );
  }

  const request = context.dependencies.contracts.assertObject(
    CONTRACT_REF.materializationRequest,
    authorization.request,
  ).value;
  const candidate = context.dependencies.contracts.assertObject(
    CONTRACT_REF.assetCandidate,
    authorization.candidate,
  ).value;
  const review = context.dependencies.contracts.assertObject(
    CONTRACT_REF.reviewReceipt,
    authorization.review,
  ).value;
  const acceptance = context.dependencies.contracts.assertObject(
    CONTRACT_REF.assetAcceptance,
    authorization.acceptance,
  ).value;

  assertEqual(
    "asset_acceptance.acceptance_id",
    acceptanceId,
    expectString(acceptance, "acceptance_id", "AssetAcceptance"),
  );
  assertEqual(
    "asset_acceptance.packet_id",
    acceptanceId,
    expectString(context.packet, "packet_id", "ContentPacket"),
  );

  const requestId = expectString(
    acceptance,
    "request_id",
    "AssetAcceptance",
  );
  const candidateId = expectString(
    acceptance,
    "candidate_id",
    "AssetAcceptance",
  );
  const reviewId = expectString(acceptance, "review_id", "AssetAcceptance");
  assertEqual(
    "asset_acceptance.request_id",
    requestId,
    expectString(request, "request_id", "MaterializationRequest"),
  );
  assertEqual(
    "asset_acceptance.cause_id",
    requestId,
    expectString(context.packet, "cause_id", "ContentPacket"),
  );
  assertEqual(
    "asset_acceptance.world_id",
    expectString(request, "world_id", "MaterializationRequest"),
    expectString(context.packet, "world_id", "ContentPacket"),
  );
  assertEqual(
    "asset_acceptance.candidate_id",
    candidateId,
    expectString(candidate, "candidate_id", "AssetCandidate"),
  );
  assertEqual(
    "asset_acceptance.candidate_request_id",
    requestId,
    expectString(candidate, "request_id", "AssetCandidate"),
  );
  assertEqual(
    "asset_acceptance.review_id",
    reviewId,
    expectString(review, "review_id", "ReviewReceipt"),
  );
  assertEqual(
    "asset_acceptance.review_candidate_id",
    candidateId,
    expectString(review, "candidate_id", "ReviewReceipt"),
  );
  assertEqual(
    "asset_acceptance.review_verdict",
    "accepted",
    expectString(review, "verdict", "ReviewReceipt"),
  );
  assertEqual(
    "asset_acceptance.request_status",
    "accepted",
    expectString(request, "status", "MaterializationRequest"),
  );

  const subjectRevision = expectInteger(
    acceptance,
    "subject_revision",
    "AssetAcceptance",
  );
  assertEqual(
    "asset_acceptance.request_subject_revision",
    subjectRevision,
    expectInteger(request, "subject_revision", "MaterializationRequest"),
  );
  assertEqual(
    "asset_acceptance.candidate_subject_revision",
    subjectRevision,
    expectInteger(candidate, "subject_revision", "AssetCandidate"),
  );
  assertEqual(
    "asset_acceptance.generation_spec_digest",
    expectString(
      request,
      "generation_spec_digest",
      "MaterializationRequest",
    ),
    expectString(
      candidate,
      "generation_spec_digest",
      "AssetCandidate",
    ),
  );
  assertJsonEqual(
    "asset_acceptance.asset",
    expectProperty(acceptance, "asset", "AssetAcceptance"),
    expectProperty(candidate, "asset", "AssetCandidate"),
  );
  assertJsonEqual(
    "asset_acceptance.deterministic_context",
    expectProperty(acceptance, "deterministic_context", "AssetAcceptance"),
    expectProperty(
      context.packet,
      "deterministic_context",
      "ContentPacket",
    ),
  );

  const expectedPreconditions = buildAssetAcceptancePreconditions(
    request,
    subjectRevision,
  );
  assertJsonEqual(
    "asset_acceptance.preconditions",
    expectedPreconditions,
    expectProperty(context.packet, "preconditions", "ContentPacket"),
  );

  const expectedOp: JsonObject = {
    op: "visual_binding.upsert",
    binding: {
      binding_id: expectString(
        acceptance,
        "binding_id",
        "AssetAcceptance",
      ),
      world_id: expectString(request, "world_id", "MaterializationRequest"),
      subject: expectProperty(request, "subject", "MaterializationRequest"),
      subject_revision: subjectRevision,
      slot_id: expectString(request, "slot_id", "MaterializationRequest"),
      asset: expectProperty(acceptance, "asset", "AssetAcceptance"),
      source_request_id: requestId,
      acceptance_id: acceptanceId,
    },
  };
  assertJsonEqual(
    "asset_acceptance.ops",
    [expectedOp],
    expectProperty(context.packet, "ops", "ContentPacket"),
  );
}

function buildAssetAcceptancePreconditions(
  request: JsonObject,
  subjectRevision: number,
): JsonObject[] {
  const subject = expectJsonObject(
    expectProperty(request, "subject", "MaterializationRequest"),
    "MaterializationRequest.subject",
  );
  const subjectKind = expectString(subject, "kind", "SubjectRef");
  if (subjectKind === "entity") {
    const entity = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    if (
      entity.expected_revision !== undefined &&
      expectInteger(entity, "expected_revision", "EntityRef") !==
        subjectRevision
    ) {
      throw fault(
        "world.packet.asset_acceptance_subject_revision_mismatch",
        "MaterializationRequest EntityRef.expected_revision must match subject_revision",
        {
          request_id: expectString(
            request,
            "request_id",
            "MaterializationRequest",
          ),
        },
      );
    }
    return [
      {
        kind: "entity.revision_is",
        entity_id: expectString(entity, "entity_id", "EntityRef"),
        revision: subjectRevision,
      },
    ];
  }
  if (subjectKind === "definition") {
    const definition = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (expectString(definition, "kind", "DefinitionRef") !== "dynamic") {
      throw fault(
        "world.packet.asset_acceptance_subject_immutable",
        "AssetAcceptance can bind only runtime Entity or DynamicDefinition subjects",
        {
          request_id: expectString(
            request,
            "request_id",
            "MaterializationRequest",
          ),
        },
      );
    }
    assertEqual(
      "asset_acceptance.definition_revision",
      subjectRevision,
      expectInteger(definition, "revision", "DynamicDefinitionRef"),
    );
    return [
      {
        kind: "definition.revision_is",
        definition_id: expectString(
          definition,
          "definition_id",
          "DynamicDefinitionRef",
        ),
        revision: subjectRevision,
      },
    ];
  }
  throw fault(
    "world.packet.asset_acceptance_subject_kind",
    "AssetAcceptance references an unsupported Materialization subject kind",
    { subject_kind: subjectKind },
  );
}

function assertSealedTriggerPacketOps(
  context: EvaluationContext,
  card: JsonObject,
  sealed: JsonObject,
  resultDigest: string,
): void {
  const packetOps = asObjectArray(
    expectProperty(context.packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const sealedOps = asObjectArray(
    expectProperty(sealed, "ops", "SealedEventResult"),
    "SealedEventResult.ops",
  );

  if (packetOps.length !== sealedOps.length + 1) {
    throw fault(
      "world.packet.sealed_ops_count",
      "sealed_event_result packet ops must be sealed ops plus one event_card.trigger",
      {
        sealed_ops: sealedOps.length,
        packet_ops: packetOps.length,
      },
    );
  }

  for (const [index, sealedOp] of sealedOps.entries()) {
    if (!jsonEquals(packetOps[index] as JsonValue, sealedOp)) {
      throw fault(
        "world.packet.sealed_ops_mismatch",
        `Packet op at index ${index} does not match sealed EventOutcomeOp`,
        { index },
      );
    }
  }

  const trigger = packetOps[packetOps.length - 1] as JsonObject;
  assertEqual(
    "sealed_event_result.trigger.op",
    "event_card.trigger",
    expectString(trigger, "op", "EffectOp"),
  );
  assertEqual(
    "sealed_event_result.trigger.event_card_id",
    expectString(card, "event_card_id", "EventCardState"),
    expectString(trigger, "event_card_id", "EventCardTriggerOp"),
  );
  assertEqual(
    "sealed_event_result.trigger.sealed_result_digest",
    resultDigest,
    expectString(trigger, "sealed_result_digest", "EventCardTriggerOp"),
  );
  assertEqual(
    "sealed_event_result.trigger.day",
    expectInteger(card, "day", "EventCardState"),
    expectInteger(trigger, "day", "EventCardTriggerOp"),
  );
  assertJsonEqual(
    "sealed_event_result.trigger.control",
    expectProperty(card, "control", "EventCardState"),
    expectProperty(trigger, "control", "EventCardTriggerOp"),
  );
}

async function assertSealedPreconditionFailure(
  sealedPreconditions: readonly JsonObject[],
  context: EvaluationContext,
): Promise<void> {
  let semanticFailureCount = 0;
  for (const [index, precondition] of sealedPreconditions.entries()) {
    const kind = expectString(
      precondition,
      "kind",
      "SealedEventResult.preconditions",
    ) as PreconditionKind;
    const handler = PRECONDITION_HANDLERS[kind];
    if (handler === undefined) {
      throw fault(
        "world.packet.precondition_unknown",
        `Unknown PacketPrecondition kind ${kind}`,
        {
          kind,
          path: "SealedEventResult.preconditions",
        },
      );
    }
    try {
      await handler(
        precondition,
        context,
        `SealedEventResult.preconditions[${index}]`,
      );
    } catch (error) {
      if (error instanceof PreconditionUnsatisfiedFault) {
        semanticFailureCount += 1;
        continue;
      }
      throw error;
    }
  }
  if (semanticFailureCount === 0) {
    throw fault(
      "world.packet.sealed_invalidate_without_failure",
      "EventCard invalidation requires at least one failed sealed precondition",
      {},
    );
  }
}

function assertSealedInvalidateOp(
  invalidate: JsonObject,
  card: JsonObject,
): void {
  assertEqual(
    "sealed_event_result.invalidate.event_card_id",
    expectString(card, "event_card_id", "EventCardState"),
    expectString(invalidate, "event_card_id", "EventCardInvalidateOp"),
  );
  assertJsonEqual(
    "sealed_event_result.invalidate.control",
    expectProperty(card, "control", "EventCardState"),
    expectProperty(invalidate, "control", "EventCardInvalidateOp"),
  );
  assertEqual(
    "sealed_event_result.invalidate.reason_code",
    "event_card.precondition_failed",
    expectString(invalidate, "reason_code", "EventCardInvalidateOp"),
  );
}

async function resolveComponentValueDigest(
  context: EvaluationContext,
  subject: JsonObject,
  componentType: JsonValue,
  ordinal: number,
): Promise<string | undefined> {
  if (expectString(subject, "kind", "SubjectRef") === "definition") {
    const definition = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (expectString(definition, "kind", "DefinitionRef") === "static") {
      return context.dependencies.staticComponentDigestLookup.findValueDigest({
        definition,
        componentType,
        ordinal,
      });
    }
  }

  const component = findComponent(
    context.worldState,
    subject,
    componentType,
    ordinal,
  );
  if (component === undefined) {
    return undefined;
  }
  return context.dependencies.digest.sha256(
    expectProperty(component, "value", "ComponentValue"),
  );
}

function assertAgencyCommitmentValid(
  context: EvaluationContext,
  commitmentRef: JsonObject,
): void {
  const dialogueId = expectString(
    commitmentRef,
    "dialogue_id",
    "AgencyCommitmentRef",
  );
  const turnId = expectString(commitmentRef, "turn_id", "AgencyCommitmentRef");
  const commitmentId = expectString(
    commitmentRef,
    "commitment_id",
    "AgencyCommitmentRef",
  );

  const dialogue = findDialogue(context.worldState, dialogueId);
  if (dialogue === undefined) {
    throw preconditionFailure(
      "agency.commitment_valid",
      `Agency commitment dialogue ${dialogueId} is absent`,
      {
        dialogue_id: dialogueId,
      },
    );
  }

  const turns = asObjectArray(
    expectProperty(dialogue, "turns", "DialogueRecord"),
    "DialogueRecord.turns",
  );
  const turn = turns.find(
    (entry) => expectString(entry, "turn_id", "DialogueTurn") === turnId,
  );
  if (turn === undefined) {
    throw preconditionFailure(
      "agency.commitment_valid",
      `Agency commitment turn ${turnId} is absent`,
      {
        dialogue_id: dialogueId,
        turn_id: turnId,
      },
    );
  }

  const commitments = asObjectArray(
    expectProperty(turn, "agency_commitments", "DialogueTurn"),
    "DialogueTurn.agency_commitments",
  );
  const commitment = commitments.find(
    (entry) =>
      expectString(entry, "commitment_id", "AgencyCommitment") === commitmentId,
  );
  if (commitment === undefined) {
    throw preconditionFailure(
      "agency.commitment_valid",
      `Agency commitment ${commitmentId} is absent`,
      {
        dialogue_id: dialogueId,
        turn_id: turnId,
        commitment_id: commitmentId,
      },
    );
  }

  const dayCycle = expectJsonObject(
    expectProperty(context.worldState, "day_cycle", "WorldState"),
    "WorldState.day_cycle",
  );
  const currentDay = expectInteger(dayCycle, "day", "DayCycleState");
  const validThrough = expectInteger(
    commitment,
    "valid_through_day",
    "AgencyCommitment",
  );
  if (validThrough < currentDay) {
    throw preconditionFailure(
      "agency.commitment_valid",
      `Agency commitment ${commitmentId} is expired`,
      {
        commitment_id: commitmentId,
        valid_through_day: validThrough,
        current_day: currentDay,
      },
    );
  }
}

function findEntity(worldState: JsonObject, entityId: string): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "entities", "WorldState"),
    "WorldState.entities",
  ).find((entity) => expectString(entity, "entity_id", "EntityState") === entityId);
}

function findDynamicDefinition(
  worldState: JsonObject,
  definitionId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "dynamic_definitions", "WorldState"),
    "WorldState.dynamic_definitions",
  ).find(
    (definition) =>
      expectString(definition, "definition_id", "DynamicDefinitionState") ===
      definitionId,
  );
}

function findRelation(
  worldState: JsonObject,
  relationId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "relations", "WorldState"),
    "WorldState.relations",
  ).find(
    (relation) =>
      expectString(relation, "relation_id", "RelationState") === relationId,
  );
}

function findLedger(
  worldState: JsonObject,
  ledgerId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "ledgers", "WorldState"),
    "WorldState.ledgers",
  ).find((ledger) => expectString(ledger, "ledger_id", "LedgerState") === ledgerId);
}

function findStage(
  worldState: JsonObject,
  stageInstanceId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "stage_instances", "WorldState"),
    "WorldState.stage_instances",
  ).find(
    (stage) =>
      expectString(stage, "stage_instance_id", "StageInstanceState") ===
      stageInstanceId,
  );
}

function findEventCard(
  worldState: JsonObject,
  eventCardId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "event_cards", "WorldState"),
    "WorldState.event_cards",
  ).find(
    (card) =>
      expectString(card, "event_card_id", "EventCardState") === eventCardId,
  );
}

function findDialogue(
  worldState: JsonObject,
  dialogueId: string,
): JsonObject | undefined {
  return asObjectArray(
    expectProperty(worldState, "dialogues", "WorldState"),
    "WorldState.dialogues",
  ).find(
    (dialogue) =>
      expectString(dialogue, "dialogue_id", "DialogueRecord") === dialogueId,
  );
}

function findComponent(
  worldState: JsonObject,
  subject: JsonObject,
  componentType: JsonValue,
  ordinal: number,
): JsonObject | undefined {
  const kind = expectString(subject, "kind", "SubjectRef");
  let components: readonly JsonObject[];
  if (kind === "entity") {
    const entityRef = expectJsonObject(
      expectProperty(subject, "entity", "SubjectRef"),
      "SubjectRef.entity",
    );
    const entityId = expectString(entityRef, "entity_id", "EntityRef");
    const entity = findEntity(worldState, entityId);
    if (entity === undefined) {
      return undefined;
    }
    components = asObjectArray(
      expectProperty(entity, "components", "EntityState"),
      "EntityState.components",
    );
  } else if (kind === "definition") {
    const definitionRef = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    const definitionKind = expectString(definitionRef, "kind", "DefinitionRef");
    if (definitionKind !== "dynamic") {
      return undefined;
    }
    const definitionId = expectString(
      definitionRef,
      "definition_id",
      "DynamicDefinitionRef",
    );
    const definition = findDynamicDefinition(worldState, definitionId);
    if (definition === undefined) {
      return undefined;
    }
    components = asObjectArray(
      expectProperty(definition, "components", "DynamicDefinitionState"),
      "DynamicDefinitionState.components",
    );
  } else {
    throw fault(
      "world.packet.precondition_component_subject",
      `Unsupported SubjectRef kind ${kind}`,
      { kind: "component.value_digest_is", subject_kind: kind },
    );
  }

  return components.find((component) => {
    const type = expectProperty(component, "component_type", "ComponentValue");
    const componentOrdinal = expectInteger(component, "ordinal", "ComponentValue");
    return jsonEquals(type, componentType) && componentOrdinal === ordinal;
  });
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault("world.packet.shape", `${path} must be an array`, { path });
  }
  return value.map((entry, index) => {
    if (!isJsonObject(entry as JsonValue)) {
      throw fault(
        "world.packet.shape",
        `${path}[${index}] must be an object`,
        { path: `${path}[${index}]` },
      );
    }
    return entry as JsonObject;
  });
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitField(object: JsonObject, field: string): JsonObject {
  const next: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== field) {
      next[key] = value;
    }
  }
  return next;
}

function assertEqual(
  field: string,
  expected: number | string,
  actual: number | string,
): void {
  if (expected !== actual) {
    throw fault(
      "world.packet.field_mismatch",
      `Packet semantic field ${field} mismatch`,
      {
        field,
        expected,
        actual,
      },
    );
  }
}

function assertJsonEqual(
  field: string,
  expected: JsonValue,
  actual: JsonValue,
): void {
  if (!jsonEquals(expected, actual)) {
    throw fault(
      "world.packet.field_mismatch",
      `Packet semantic field ${field} mismatch`,
      { field },
    );
  }
}

function assertPreconditionEqual(
  kind: PreconditionKind,
  field: string,
  expected: number | string,
  actual: number | string,
): void {
  if (expected !== actual) {
    throw preconditionFailure(
      kind,
      `${kind} precondition is not satisfied`,
      { field, expected, actual },
    );
  }
}

function preconditionFailure(
  kind: PreconditionKind,
  message: string,
  details: JsonObject,
): PreconditionUnsatisfiedFault {
  return new PreconditionUnsatisfiedFault(message, {
    ...details,
    kind,
  });
}

function fault(code: string, message: string, details: JsonObject): EngineFault {
  return new EngineFault(code, message, details);
}

const _preconditionExhaustive: {
  readonly [K in PreconditionKind]: true;
} = {
  "world.revision_is": true,
  "entity.revision_is": true,
  "definition.revision_is": true,
  "component.value_digest_is": true,
  "relation.exists": true,
  "ledger.balance_at_least": true,
  "rule.holds": true,
  "stage.revision_is": true,
  "day_cycle.is": true,
  "event_card.status_is": true,
  "agency.commitment_valid": true,
};
void _preconditionExhaustive;

const _sourceExhaustive: {
  readonly [K in SourceKind]: true;
} = {
  rule_plugin: true,
  sealed_event_result: true,
  asset_acceptance: true,
  content_upgrade: true,
};
void _sourceExhaustive;
