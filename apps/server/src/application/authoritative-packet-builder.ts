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
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import type {
  CommittedEventReader,
  RuntimeWorldReader,
} from "./runtime-persistence.js";
import type {
  RulePluginInvocationProvenanceVerifier,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";

export type ContentPacketDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.contentPacket
>;

export interface EventCardClickPacketInput {
  readonly worldId: string;
  readonly commandId: string;
  readonly eventCardId: string;
}

export interface AuthoritativePacketBuilder {
  fromRulePluginReceipt(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): ContentPacketDocument;

  buildEventCardTrigger(
    input: EventCardClickPacketInput,
  ): Promise<ContentPacketDocument>;

  /**
   * Call only after apply_packet of the matching trigger packet failed with
   * `world.packet.precondition_failed`. Uses the same command_id.
   */
  buildEventCardInvalidate(
    input: EventCardClickPacketInput,
  ): Promise<ContentPacketDocument>;
}

export interface AuthoritativePacketBuilderDependencies {
  readonly contracts: ContractValidator;
  readonly rulePluginProvenance: RulePluginInvocationProvenanceVerifier;
  readonly worlds: RuntimeWorldReader;
  readonly events: CommittedEventReader;
}

export function createAuthoritativePacketBuilder(
  dependencies: AuthoritativePacketBuilderDependencies,
): AuthoritativePacketBuilder {
  return new DefaultAuthoritativePacketBuilder(dependencies);
}

class DefaultAuthoritativePacketBuilder implements AuthoritativePacketBuilder {
  readonly #contracts: ContractValidator;
  readonly #rulePluginProvenance: RulePluginInvocationProvenanceVerifier;
  readonly #worlds: RuntimeWorldReader;
  readonly #events: CommittedEventReader;

  public constructor(dependencies: AuthoritativePacketBuilderDependencies) {
    this.#contracts = dependencies.contracts;
    this.#rulePluginProvenance = dependencies.rulePluginProvenance;
    this.#worlds = dependencies.worlds;
    this.#events = dependencies.events;
  }

  public fromRulePluginReceipt(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): ContentPacketDocument {
    if (!this.#rulePluginProvenance.isVerified(receipt)) {
      throw new EngineFault(
        "runtime.packet_builder.rule_plugin_receipt_required",
        "ContentPacket construction requires this runtime's verified RulePlugin receipt",
      );
    }
    if (receipt.proposal === undefined) {
      throw new EngineFault(
        "runtime.packet_builder.proposal_missing",
        "RulePlugin receipt has no PacketProposal; Reject/non-proposal outputs cannot form a ContentPacket",
        {
          request_id: expectString(
            receipt.request.value,
            "request_id",
            "RulePluginRequest",
          ),
        },
      );
    }

    const proposal = receipt.proposal.value;
    const request = receipt.request.value;
    const world = expectJsonObject(
      expectProperty(request, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const worldId = expectString(world, "world_id", "WorldSnapshot");
    const proposalId = expectString(proposal, "proposal_id", "PacketProposal");
    const causeId = expectString(proposal, "cause_id", "PacketProposal");
    const proposalBasis = expectInteger(
      proposal,
      "basis_revision",
      "PacketProposal",
    );
    const requestBasis = expectInteger(
      request,
      "basis_revision",
      "RulePluginRequest",
    );
    if (
      worldId !== receipt.worldId ||
      proposalBasis !== receipt.basisRevision ||
      requestBasis !== receipt.basisRevision
    ) {
      throw new EngineFault(
        "runtime.packet_builder.identity_mismatch",
        "RulePlugin receipt world/basis identity is inconsistent",
        {
          receipt_world_id: receipt.worldId,
          world_id: worldId,
          receipt_basis_revision: receipt.basisRevision,
          proposal_basis_revision: proposalBasis,
          request_basis_revision: requestBasis,
        },
      );
    }

    const deterministicContext = expectJsonObject(
      expectProperty(request, "deterministic_context", "RulePluginRequest"),
      "RulePluginRequest.deterministic_context",
    );
    assertEqual(
      "deterministic_context_id",
      expectString(deterministicContext, "context_id", "DeterministicContext"),
      expectString(proposal, "deterministic_context_id", "PacketProposal"),
    );
    assertEqual(
      "deterministic_context_digest",
      expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      ),
      expectString(
        proposal,
        "deterministic_context_digest",
        "PacketProposal",
      ),
    );

    return this.#sealPacket({
      contract_version: "world-runtime.v1",
      record_type: "content.packet",
      packet_id: proposalId,
      cause_id: causeId,
      world_id: worldId,
      basis_revision: proposalBasis,
      preconditions: cloneJson(
        expectProperty(proposal, "preconditions", "PacketProposal"),
      ),
      deterministic_context: cloneJsonObject(deterministicContext),
      ops: cloneJson(expectProperty(proposal, "ops", "PacketProposal")),
      source: {
        source_kind: "rule_plugin",
        proposal_id: proposalId,
      },
    });
  }

  public async buildEventCardTrigger(
    input: EventCardClickPacketInput,
  ): Promise<ContentPacketDocument> {
    const loaded = await this.#loadEventCardContext(input);
    const sealedOps = asObjectArray(
      expectProperty(loaded.sealed, "ops", "SealedEventResult"),
      "SealedEventResult.ops",
    );
    const triggerOp: JsonObject = {
      op: "event_card.trigger",
      event_card_id: loaded.eventCardId,
      control: cloneJson(
        expectProperty(loaded.card, "control", "EventCardState"),
      ),
      sealed_result_digest: loaded.resultDigest,
      day: expectInteger(loaded.card, "day", "EventCardState"),
    };

    return this.#sealPacket({
      contract_version: "world-runtime.v1",
      record_type: "content.packet",
      packet_id: input.commandId,
      cause_id: loaded.eventCardId,
      world_id: loaded.worldId,
      basis_revision: loaded.currentRevision,
      preconditions: cloneJson(
        expectProperty(loaded.sealed, "preconditions", "SealedEventResult"),
      ),
      deterministic_context: cloneJsonObject(loaded.deterministicContext),
      ops: [
        ...sealedOps.map((op) => cloneJsonObject(op)),
        triggerOp,
      ],
      source: {
        source_kind: "sealed_event_result",
        event_card_id: loaded.eventCardId,
        result_id: loaded.resultId,
        result_digest: loaded.resultDigest,
      },
    });
  }

  public async buildEventCardInvalidate(
    input: EventCardClickPacketInput,
  ): Promise<ContentPacketDocument> {
    const loaded = await this.#loadEventCardContext(input);
    const invalidateOp: JsonObject = {
      op: "event_card.invalidate",
      event_card_id: loaded.eventCardId,
      control: cloneJson(
        expectProperty(loaded.card, "control", "EventCardState"),
      ),
      reason_code: "event_card.precondition_failed",
    };

    return this.#sealPacket({
      contract_version: "world-runtime.v1",
      record_type: "content.packet",
      packet_id: input.commandId,
      cause_id: loaded.eventCardId,
      world_id: loaded.worldId,
      basis_revision: loaded.currentRevision,
      preconditions: [],
      deterministic_context: cloneJsonObject(loaded.deterministicContext),
      ops: [invalidateOp],
      source: {
        source_kind: "sealed_event_result",
        event_card_id: loaded.eventCardId,
        result_id: loaded.resultId,
        result_digest: loaded.resultDigest,
      },
    });
  }

  async #loadEventCardContext(input: EventCardClickPacketInput): Promise<{
    readonly worldId: string;
    readonly currentRevision: number;
    readonly eventCardId: string;
    readonly card: JsonObject;
    readonly sealed: JsonObject;
    readonly resultId: string;
    readonly resultDigest: string;
    readonly deterministicContext: JsonObject;
  }> {
    const snapshot = await this.#worlds.readCurrent(input.worldId);
    const worldId = expectString(snapshot.value, "world_id", "WorldSnapshot");
    const currentRevision = expectInteger(
      snapshot.value,
      "world_revision",
      "WorldSnapshot",
    );
    const worldState = expectJsonObject(
      expectProperty(snapshot.value, "world_state", "WorldSnapshot"),
      "WorldSnapshot.world_state",
    );
    const cards = asObjectArray(
      expectProperty(worldState, "event_cards", "WorldState"),
      "WorldState.event_cards",
    );
    const matches = cards.filter(
      (card) =>
        expectString(card, "event_card_id", "EventCardState") ===
        input.eventCardId,
    );
    if (matches.length !== 1) {
      throw new EngineFault(
        "runtime.packet_builder.event_card_match",
        "Event card must resolve to exactly one card in the current world",
        {
          world_id: worldId,
          event_card_id: input.eventCardId,
          matches: matches.length,
        },
      );
    }
    const card = matches[0] as JsonObject;
    assertEqual(
      "event_card.status",
      "available",
      expectString(card, "status", "EventCardState"),
    );

    const sealed = expectJsonObject(
      expectProperty(card, "sealed_result", "EventCardState"),
      "EventCardState.sealed_result",
    );
    const resultId = expectString(sealed, "result_id", "SealedEventResult");
    const resultDigest = expectString(
      sealed,
      "result_digest",
      "SealedEventResult",
    );
    const publishedRevision = expectInteger(
      card,
      "published_revision",
      "EventCardState",
    );
    if (publishedRevision < 1) {
      throw new EngineFault(
        "runtime.packet_builder.published_revision_invalid",
        "EventCard published_revision must correspond to a committed event revision_after >= 1",
        {
          event_card_id: input.eventCardId,
          published_revision: publishedRevision,
        },
      );
    }

    const events = await this.#events.readRevisionRange({
      worldId,
      afterRevisionExclusive: publishedRevision - 1,
      throughRevisionInclusive: publishedRevision,
    });
    if (events.length !== 1) {
      throw new EngineFault(
        "runtime.packet_builder.publish_event_missing",
        "Could not recover the unique CommittedEvent for card published_revision",
        {
          world_id: worldId,
          published_revision: publishedRevision,
          event_count: events.length,
        },
      );
    }
    const committed = events[0]!;
    const publishPacket = expectJsonObject(
      expectProperty(committed.value, "packet", "CommittedEvent"),
      "CommittedEvent.packet",
    );
    assertPublishEventMatchesCard(publishPacket, card);
    const deterministicContext = expectJsonObject(
      expectProperty(
        publishPacket,
        "deterministic_context",
        "ContentPacket",
      ),
      "ContentPacket.deterministic_context",
    );

    assertEqual(
      "sealed.deterministic_context_id",
      expectString(deterministicContext, "context_id", "DeterministicContext"),
      expectString(sealed, "deterministic_context_id", "SealedEventResult"),
    );
    assertEqual(
      "sealed.deterministic_context_digest",
      expectString(
        deterministicContext,
        "context_digest",
        "DeterministicContext",
      ),
      expectString(
        sealed,
        "deterministic_context_digest",
        "SealedEventResult",
      ),
    );

    return Object.freeze({
      worldId,
      currentRevision,
      eventCardId: input.eventCardId,
      card,
      sealed,
      resultId,
      resultDigest,
      deterministicContext,
    });
  }

  #sealPacket(candidate: JsonObject): ContentPacketDocument {
    return this.#contracts.assertObject(
      CONTRACT_REF.contentPacket,
      candidate,
    );
  }
}

function assertPublishEventMatchesCard(
  publishPacket: JsonObject,
  card: JsonObject,
): void {
  const eventCardId = expectString(
    card,
    "event_card_id",
    "EventCardState",
  );
  const publishOps = asObjectArray(
    expectProperty(publishPacket, "ops", "ContentPacket"),
    "ContentPacket.ops",
  ).filter(
    (op) =>
      expectString(op, "op", "EffectOp") === "event_card.publish" &&
      expectString(op, "event_card_id", "EventCardPublishOp") === eventCardId,
  );
  if (publishOps.length !== 1) {
    throw new EngineFault(
      "runtime.packet_builder.publish_event_mismatch",
      "Card published_revision must point to exactly one matching event_card.publish op",
      { event_card_id: eventCardId, matches: publishOps.length },
    );
  }

  const publishOp = publishOps[0]!;
  const fields = [
    "source_proposal_id",
    "source_dialogue_id",
    "day",
    "title",
    "summary",
    "sealed_result",
    "control",
    "charge_id",
    "cost",
  ] as const;
  for (const field of fields) {
    if (
      !jsonEquals(
        expectProperty(publishOp, field, "EventCardPublishOp"),
        expectProperty(card, field, "EventCardState"),
      )
    ) {
      throw new EngineFault(
        "runtime.packet_builder.publish_event_mismatch",
        `Published EventCard field ${field} does not match current card state`,
        { event_card_id: eventCardId, field },
      );
    }
  }
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.packet_builder.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value) as JsonObject;
}

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry as JsonValue));
  }
  const next: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = cloneJson(entry);
  }
  return next;
}

function assertEqual(
  field: string,
  expected: number | string,
  actual: number | string,
): void {
  if (expected !== actual) {
    throw new EngineFault(
      "runtime.packet_builder.field_mismatch",
      `Packet builder field ${field} mismatch`,
      { field, expected, actual },
    );
  }
}
