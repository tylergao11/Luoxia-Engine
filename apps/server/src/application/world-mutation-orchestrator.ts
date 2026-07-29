import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
} from "@luoxia/contracts-runtime";
import type { ApplyPacketResultDocument, WorldAuthority } from "@luoxia/world-core";

import type {
  AssetAcceptancePacketInput,
  AuthoritativePacketBuilder,
  ContentUpgradePacketInput,
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

  commitAssetAcceptance(
    input: AssetAcceptancePacketInput,
  ): Promise<ApplyPacketResultDocument>;

  commitContentUpgrade(
    input: ContentUpgradePacketInput,
  ): Promise<ApplyPacketResultDocument>;
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
      input.packetId,
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

  public async commitAssetAcceptance(
    input: AssetAcceptancePacketInput,
  ): Promise<ApplyPacketResultDocument> {
    const acceptanceId = expectString(
      input.acceptance.value,
      "acceptance_id",
      "AssetAcceptance",
    );
    const duplicate =
      await this.#committedPackets.readByPacketId(acceptanceId);
    if (duplicate !== undefined) {
      return recoverAssetAcceptanceResult(duplicate, input);
    }

    const packet = await this.#packets.buildAssetAcceptance(input);
    return this.#world.applyPacket(packet.value);
  }

  public async commitContentUpgrade(
    input: ContentUpgradePacketInput,
  ): Promise<ApplyPacketResultDocument> {
    if (!this.#rulePluginProvenance.isVerified(input.receipt)) {
      throw new EngineFault(
        "runtime.mutation.rule_plugin_receipt_required",
        "Content Upgrade commit requires this runtime's verified RulePlugin receipt",
      );
    }
    const packet = this.#packets.buildContentUpgrade(input);
    const packetId = expectString(
      packet.value,
      "packet_id",
      "ContentPacket",
    );
    const duplicate = await this.#committedPackets.readByPacketId(packetId);
    if (duplicate !== undefined) {
      const committedPacket = expectJsonObject(
        expectProperty(
          duplicate.event.value,
          "packet",
          "CommittedEvent",
        ),
        "CommittedEvent.packet",
      );
      if (!jsonEquals(committedPacket, packet.value)) {
        throw new EngineFault(
          "runtime.mutation.content_upgrade_identity_conflict",
          "Content Upgrade packet identity is already committed for a different mutation",
          { upgrade_command_id: packetId },
        );
      }
      return duplicate.result;
    }
    return this.#world.applyPacket(packet.value);
  }
}

function recoverAssetAcceptanceResult(
  record: CommittedPacketRecord,
  input: AssetAcceptancePacketInput,
): ApplyPacketResultDocument {
  const acceptance = input.acceptance.value;
  const request = input.request.value;
  const acceptanceId = expectString(
    acceptance,
    "acceptance_id",
    "AssetAcceptance",
  );
  const requestId = expectString(
    request,
    "request_id",
    "MaterializationRequest",
  );
  const worldId = expectString(
    request,
    "world_id",
    "MaterializationRequest",
  );
  const bindingId = expectString(
    acceptance,
    "binding_id",
    "AssetAcceptance",
  );
  const packet = expectJsonObject(
    expectProperty(record.event.value, "packet", "CommittedEvent"),
    "CommittedEvent.packet",
  );
  const source = expectJsonObject(
    expectProperty(packet, "source", "ContentPacket"),
    "ContentPacket.source",
  );
  const ops = asObjectArray(
    expectProperty(packet, "ops", "ContentPacket"),
    "ContentPacket.ops",
  );
  const binding =
    ops.length === 1
      ? expectJsonObject(
          expectProperty(ops[0] as JsonObject, "binding", "EffectOp"),
          "VisualBindingUpsertOp.binding",
        )
      : undefined;

  if (
    expectString(packet, "packet_id", "ContentPacket") !== acceptanceId ||
    expectString(packet, "cause_id", "ContentPacket") !== requestId ||
    expectString(packet, "world_id", "ContentPacket") !== worldId ||
    expectString(source, "source_kind", "PacketSource") !==
      "asset_acceptance" ||
    expectString(source, "acceptance_id", "PacketSource") !== acceptanceId ||
    ops.length !== 1 ||
    expectString(ops[0] as JsonObject, "op", "EffectOp") !==
      "visual_binding.upsert" ||
    binding === undefined ||
    expectString(binding, "binding_id", "VisualBindingDraft") !== bindingId ||
    expectString(
      binding,
      "source_request_id",
      "VisualBindingDraft",
    ) !== requestId ||
    expectString(binding, "acceptance_id", "VisualBindingDraft") !==
      acceptanceId
  ) {
    throw new EngineFault(
      "runtime.mutation.asset_acceptance_identity_conflict",
      "AssetAcceptance packet identity is already committed for a different world mutation",
      {
        acceptance_id: acceptanceId,
        request_id: requestId,
        world_id: worldId,
        binding_id: bindingId,
      },
    );
  }
  return record.result;
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
    expectString(packet, "packet_id", "ContentPacket") !== input.packetId ||
    expectString(packet, "world_id", "ContentPacket") !== input.worldId ||
    expectString(packet, "cause_id", "ContentPacket") !== input.eventCardId ||
    expectString(source, "source_kind", "PacketSource") !==
      "sealed_event_result" ||
    expectString(source, "event_card_id", "PacketSource") !== input.eventCardId
  ) {
    throw new EngineFault(
      "runtime.mutation.command_identity_conflict",
      "EventCard packet identity is already committed for a different world mutation",
      {
        command_id: input.commandId,
        packet_id: input.packetId,
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
      input.eventCardId &&
    readControlBindingId(terminalOp, "EventCardTriggerOp") ===
      input.controlBindingId
  ) {
    return Object.freeze({ branch: "trigger" as const, result: record.result });
  }
  if (
    ops.length === 1 &&
    terminalKind === "event_card.invalidate" &&
    expectString(terminalOp, "event_card_id", "EventCardInvalidateOp") ===
      input.eventCardId &&
    readControlBindingId(terminalOp, "EventCardInvalidateOp") ===
      input.controlBindingId
  ) {
    return Object.freeze({
      branch: "invalidate" as const,
      result: record.result,
    });
  }
  throw committedPacketShapeFault(input);
}

function readControlBindingId(op: JsonObject, scope: string): string {
  const control = expectJsonObject(
    expectProperty(op, "control", scope),
    `${scope}.control`,
  );
  return expectString(control, "binding_id", "ControlBindingRef");
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
      packet_id: input.packetId,
      event_card_id: input.eventCardId,
    },
  );
}

function isPreconditionFailed(error: unknown): error is EngineFault {
  return (
    error instanceof EngineFault && error.code === PRECONDITION_FAILED
  );
}
