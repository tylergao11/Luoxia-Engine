import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type { ApplyPacketResultDocument, WorldAuthority } from "@luoxia/world-core";

import type {
  AuthoritativePacketBuilder,
  EventCardClickPacketInput,
} from "./authoritative-packet-builder.js";
import type {
  CommittedPacketReader,
  CommittedPacketRecord,
} from "./runtime-persistence.js";
import type {
  RulePluginInvocationProvenanceVerifier,
  VerifiedRulePluginInvocationReceipt,
} from "./rule-plugin-gateway.js";

const PRECONDITION_FAILED = "world.packet.precondition_failed";

export type EventCardClickCommitResult =
  | {
      readonly branch: "trigger";
      readonly result: ApplyPacketResultDocument;
    }
  | {
      readonly branch: "invalidate";
      readonly result: ApplyPacketResultDocument;
    };

/**
 * Authoritative world mutation paths: ContentPacket construction + applyPacket only.
 * Does not run day settlement, dialogue, or command HTTP.
 */
export interface WorldMutationOrchestrator {
  commitRulePluginReceipt(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<ApplyPacketResultDocument>;

  commitEventCardClick(
    input: EventCardClickPacketInput,
  ): Promise<EventCardClickCommitResult>;
}

export interface WorldMutationOrchestratorDependencies {
  readonly world: WorldAuthority;
  readonly packets: AuthoritativePacketBuilder;
  readonly committedPackets: CommittedPacketReader;
  readonly rulePluginProvenance: RulePluginInvocationProvenanceVerifier;
}

export function createWorldMutationOrchestrator(
  dependencies: WorldMutationOrchestratorDependencies,
): WorldMutationOrchestrator {
  return new DefaultWorldMutationOrchestrator(dependencies);
}

class DefaultWorldMutationOrchestrator implements WorldMutationOrchestrator {
  readonly #world: WorldAuthority;
  readonly #packets: AuthoritativePacketBuilder;
  readonly #committedPackets: CommittedPacketReader;
  readonly #rulePluginProvenance: RulePluginInvocationProvenanceVerifier;

  public constructor(dependencies: WorldMutationOrchestratorDependencies) {
    this.#world = dependencies.world;
    this.#packets = dependencies.packets;
    this.#committedPackets = dependencies.committedPackets;
    this.#rulePluginProvenance = dependencies.rulePluginProvenance;
  }

  public async commitRulePluginReceipt(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<ApplyPacketResultDocument> {
    if (!this.#rulePluginProvenance.isVerified(receipt)) {
      throw new EngineFault(
        "runtime.mutation.rule_plugin_receipt_required",
        "RulePlugin world commit requires this runtime's verified RulePlugin receipt",
      );
    }
    const packet = this.#packets.fromRulePluginReceipt(receipt);
    return this.#world.applyPacket(packet.value);
  }

  public async commitEventCardClick(
    input: EventCardClickPacketInput,
  ): Promise<EventCardClickCommitResult> {
    const duplicate = await this.#committedPackets.readByPacketId(
      input.commandId,
    );
    if (duplicate !== undefined) {
      return recoverEventCardClickResult(duplicate, input);
    }

    const triggerPacket = await this.#packets.buildEventCardTrigger(input);
    try {
      const result = await this.#world.applyPacket(triggerPacket.value);
      return Object.freeze({
        branch: "trigger" as const,
        result,
      });
    } catch (error: unknown) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
      const invalidatePacket =
        await this.#packets.buildEventCardInvalidate(input);
      const result = await this.#world.applyPacket(invalidatePacket.value);
      return Object.freeze({
        branch: "invalidate" as const,
        result,
      });
    }
  }
}

function recoverEventCardClickResult(
  record: CommittedPacketRecord,
  input: EventCardClickPacketInput,
): EventCardClickCommitResult {
  const packet = expectJsonObject(
    expectProperty(record.event.value, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  if (
    expectString(packet, "packet_id", "ContentPacket") !== input.commandId ||
    expectString(packet, "world_id", "ContentPacket") !== input.worldId ||
    expectString(packet, "cause_id", "ContentPacket") !== input.eventCardId ||
    expectString(source, "source_kind", "PacketSource") !==
      "sealed_event_result" ||
    expectString(source, "event_card_id", "PacketSource") !== input.eventCardId
  ) {
    throw new EngineFault(
      "runtime.mutation.command_identity_conflict",
      "command_id is already committed for a different world mutation",
      {
        command_id: input.commandId,
        world_id: input.worldId,
        event_card_id: input.eventCardId,
      },
    );
  }

  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const terminalOp = ops.at(-1);
  if (terminalOp === undefined) {
    throw committedPacketShapeFault(input);
  }
  const terminalKind = expectString(terminalOp, "op", "EffectOp");
  if (
    terminalKind === "event_card.trigger" &&
    expectString(terminalOp, "event_card_id", "EventCardTriggerOp") ===
      input.eventCardId
  ) {
    return Object.freeze({ branch: "trigger" as const, result: record.result });
  }
  if (
    ops.length === 1 &&
    terminalKind === "event_card.invalidate" &&
    expectString(terminalOp, "event_card_id", "EventCardInvalidateOp") ===
      input.eventCardId
  ) {
    return Object.freeze({
      branch: "invalidate" as const,
      result: record.result,
    });
  }
  throw committedPacketShapeFault(input);
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.mutation.committed_packet_corrupt",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function committedPacketShapeFault(
  input: EventCardClickPacketInput,
): EngineFault {
  return new EngineFault(
    "runtime.mutation.committed_packet_corrupt",
    "Committed EventCard command has no recognized terminal operation",
    {
      command_id: input.commandId,
      event_card_id: input.eventCardId,
    },
  );
}

function isPreconditionFailed(error: unknown): error is EngineFault {
  return (
    error instanceof EngineFault && error.code === PRECONDITION_FAILED
  );
}
