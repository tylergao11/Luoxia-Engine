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
} from "@luoxia/contracts-runtime/portable";

import type {
  ContentPacketDocument,
  PacketSemanticGate,
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

export interface PacketSemanticGateDependencies {
  readonly contracts: ContractValidator;
  readonly digest: PacketContentDigest;
  readonly decimalComparer: DecimalAmountComparer;
  readonly ruleHoldEvaluator: RuleHoldEvaluator;
  readonly proposalReceiptLookup: RulePluginProposalReceiptLookup;
  readonly staticComponentDigestLookup: StaticComponentDigestLookup;
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

const SOURCE_KINDS = ["rule_plugin", "sealed_event_result"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

interface EvaluationContext {
  readonly packet: JsonObject;
  readonly snapshot: JsonObject;
  readonly worldId: string;
  readonly worldRevision: number;
  readonly worldState: JsonObject;
  readonly dependencies: PacketSemanticGateDependencies;
}

type PreconditionHandler = (
  precondition: JsonObject,
  context: EvaluationContext,
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
      dependencies: this.#dependencies,
    };

    assertPacketIdentity(context);
    assertDeterministicContextShape(context);
    await assertPacketSource(context);
    await assertAllPreconditions(
      asObjectArray(
        expectProperty(packetValue, "preconditions", "ContentPacket"),
        "ContentPacket.preconditions",
      ),
      context,
    );
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

function assertDeterministicContextShape(context: EvaluationContext): void {
  const deterministicContext = expectJsonObject(
    expectProperty(
      context.packet,
      "deterministic_context",
      "ContentPacket",
    ),
    "ContentPacket.deterministic_context",
  );
  assertEqual(
    "deterministic_context.issuer",
    "world_core",
    expectString(deterministicContext, "issuer", "DeterministicContext"),
  );
  expectString(deterministicContext, "context_id", "DeterministicContext");
  expectString(deterministicContext, "context_digest", "DeterministicContext");
  expectString(deterministicContext, "issuer_token", "DeterministicContext");
  expectJsonObject(
    expectProperty(deterministicContext, "logical_time", "DeterministicContext"),
    "DeterministicContext.logical_time",
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
    await handler(precondition, context);
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
  "rule.holds": async (precondition, context) => {
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
  assertEqual(
    "sealed_event_result.deterministic_context_id",
    expectString(deterministicContext, "context_id", "DeterministicContext"),
    expectString(sealed, "deterministic_context_id", "SealedEventResult"),
  );
  assertEqual(
    "sealed_event_result.deterministic_context_digest",
    expectString(deterministicContext, "context_digest", "DeterministicContext"),
    expectString(sealed, "deterministic_context_digest", "SealedEventResult"),
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
  for (const precondition of sealedPreconditions) {
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
      await handler(precondition, context);
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
};
void _sourceExhaustive;
