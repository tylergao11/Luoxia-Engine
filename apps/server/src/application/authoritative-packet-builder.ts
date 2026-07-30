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
  type UpgradeAuthorizationDocument,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import type { RuntimeWorldReader } from "./runtime-persistence.js";
import type {
  AssetAcceptanceDocument,
  MaterializationRequestDocument,
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
  readonly controlBindingId: string;
  readonly commandId: string;
  readonly packetId: string;
  readonly eventCardId: string;
}

export interface AssetAcceptancePacketInput {
  readonly request: MaterializationRequestDocument;
  readonly acceptance: AssetAcceptanceDocument;
}

export interface ContentUpgradePacketInput {
  readonly authorization: UpgradeAuthorizationDocument;
  readonly receipt: VerifiedRulePluginInvocationReceipt;
}

export interface AuthoritativePacketBuilder {
  fromRulePluginReceipt(
    receipt: VerifiedRulePluginInvocationReceipt,
  ): ContentPacketDocument;

  buildAssetAcceptance(
    input: AssetAcceptancePacketInput,
  ): Promise<ContentPacketDocument>;

  buildContentUpgrade(
    input: ContentUpgradePacketInput,
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

  public constructor(dependencies: AuthoritativePacketBuilderDependencies) {
    this.#contracts = dependencies.contracts;
    this.#rulePluginProvenance = dependencies.rulePluginProvenance;
    this.#worlds = dependencies.worlds;
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

  public async buildAssetAcceptance(
    input: AssetAcceptancePacketInput,
  ): Promise<ContentPacketDocument> {
    const request = this.#contracts.assertObject(
      CONTRACT_REF.materializationRequest,
      input.request.value,
    ).value;
    const acceptance = this.#contracts.assertObject(
      CONTRACT_REF.assetAcceptance,
      input.acceptance.value,
    ).value;
    const requestId = expectString(
      request,
      "request_id",
      "MaterializationRequest",
    );
    const acceptanceId = expectString(
      acceptance,
      "acceptance_id",
      "AssetAcceptance",
    );
    assertEqual(
      "asset_acceptance.request_id",
      requestId,
      expectString(acceptance, "request_id", "AssetAcceptance"),
    );
    assertEqual(
      "asset_acceptance.request_status",
      "accepted",
      expectString(request, "status", "MaterializationRequest"),
    );
    const subjectRevision = expectInteger(
      request,
      "subject_revision",
      "MaterializationRequest",
    );
    assertEqual(
      "asset_acceptance.subject_revision",
      subjectRevision,
      expectInteger(
        acceptance,
        "subject_revision",
        "AssetAcceptance",
      ),
    );
    const worldId = expectString(
      request,
      "world_id",
      "MaterializationRequest",
    );
    const { snapshot } = await this.#worlds.readCurrent(worldId);
    assertEqual(
      "asset_acceptance.world_id",
      worldId,
      expectString(snapshot.value, "world_id", "WorldSnapshot"),
    );
    const basisRevision = expectInteger(
      snapshot.value,
      "world_revision",
      "WorldSnapshot",
    );
    const preconditions = buildAssetAcceptancePreconditions(
      request,
      subjectRevision,
    );
    return this.#sealPacket({
      contract_version: "world-runtime.v1",
      record_type: "content.packet",
      packet_id: acceptanceId,
      cause_id: requestId,
      world_id: worldId,
      basis_revision: basisRevision,
      preconditions,
      deterministic_context: cloneJson(
        expectProperty(
          acceptance,
          "deterministic_context",
          "AssetAcceptance",
        ),
      ),
      ops: [
        {
          op: "visual_binding.upsert",
          binding: {
            binding_id: expectString(
              acceptance,
              "binding_id",
              "AssetAcceptance",
            ),
            world_id: worldId,
            subject: cloneJson(
              expectProperty(request, "subject", "MaterializationRequest"),
            ),
            subject_revision: subjectRevision,
            slot_id: expectString(
              request,
              "slot_id",
              "MaterializationRequest",
            ),
            asset: cloneJson(
              expectProperty(acceptance, "asset", "AssetAcceptance"),
            ),
            source_request_id: requestId,
            acceptance_id: acceptanceId,
          },
        },
      ],
      source: {
        source_kind: "asset_acceptance",
        acceptance_id: acceptanceId,
      },
    });
  }

  public buildContentUpgrade(
    input: ContentUpgradePacketInput,
  ): ContentPacketDocument {
    if (!this.#rulePluginProvenance.isVerified(input.receipt)) {
      throw new EngineFault(
        "runtime.packet_builder.rule_plugin_receipt_required",
        "Content Upgrade packet construction requires this runtime's verified RulePlugin receipt",
      );
    }
    const authorization = this.#contracts.assertObject(
      CONTRACT_REF.upgradeAuthorization,
      input.authorization.value,
    ).value;
    const request = input.receipt.request.value;
    const response = input.receipt.response.value;
    const requestInput = expectJsonObject(
      expectProperty(request, "input", "RulePluginRequest"),
      "RulePluginRequest.input",
    );
    const output = expectJsonObject(
      expectProperty(response, "output", "RulePluginResponse"),
      "RulePluginResponse.output",
    );
    if (
      expectString(request, "operation_kind", "RulePluginRequest") !==
        "content_upgrade.transform" ||
      expectString(response, "operation_kind", "RulePluginResponse") !==
        "content_upgrade.transform" ||
      expectString(output, "output_kind", "ContentUpgradeOutput") !==
        "content_upgrade.candidate" ||
      !jsonEquals(
        expectProperty(
          requestInput,
          "authorization",
          "ContentUpgradeInput",
        ),
        authorization,
      )
    ) {
      throw new EngineFault(
        "runtime.packet_builder.content_upgrade_receipt_mismatch",
        "Verified RulePlugin receipt is not the authorized Content Upgrade candidate",
        {
          upgrade_command_id: expectString(
            authorization,
            "upgrade_command_id",
            "UpgradeAuthorization",
          ),
        },
      );
    }
    const unresolved = expectProperty(
      output,
      "unresolved",
      "ContentUpgradeOutput",
    );
    if (!Array.isArray(unresolved) || unresolved.length !== 0) {
      throw new EngineFault(
        "runtime.packet_builder.content_upgrade_unresolved",
        "Content Upgrade output cannot form a packet while unresolved items remain",
        {
          upgrade_command_id: expectString(
            authorization,
            "upgrade_command_id",
            "UpgradeAuthorization",
          ),
        },
      );
    }
    const readonlyWorld = expectJsonObject(
      expectProperty(request, "readonly_world", "RulePluginRequest"),
      "RulePluginRequest.readonly_world",
    );
    const sourceSave = expectJsonObject(
      expectProperty(requestInput, "source_save", "ContentUpgradeInput"),
      "ContentUpgradeInput.source_save",
    );
    const migrationId = expectString(
      authorization,
      "migration_id",
      "UpgradeAuthorization",
    );
    assertEqual(
      "content_upgrade.migration_id.input",
      migrationId,
      expectString(requestInput, "migration_id", "ContentUpgradeInput"),
    );
    assertEqual(
      "content_upgrade.migration_id.output",
      migrationId,
      expectString(output, "migration_id", "ContentUpgradeOutput"),
    );
    assertEqual(
      "content_upgrade.world_id.source_save",
      expectString(readonlyWorld, "world_id", "WorldSnapshot"),
      expectString(sourceSave, "world_id", "SaveEnvelope"),
    );
    assertEqual(
      "content_upgrade.world_id.authorization",
      expectString(readonlyWorld, "world_id", "WorldSnapshot"),
      expectString(authorization, "world_id", "UpgradeAuthorization"),
    );
    assertEqual(
      "content_upgrade.revision.source_save",
      expectInteger(readonlyWorld, "world_revision", "WorldSnapshot"),
      expectInteger(sourceSave, "world_revision", "SaveEnvelope"),
    );
    assertEqual(
      "content_upgrade.revision.authorization",
      expectInteger(readonlyWorld, "world_revision", "WorldSnapshot"),
      expectInteger(
        authorization,
        "source_world_revision",
        "UpgradeAuthorization",
      ),
    );
    return this.#sealPacket({
      contract_version: "world-runtime.v1",
      record_type: "content.packet",
      packet_id: expectString(
        authorization,
        "upgrade_command_id",
        "UpgradeAuthorization",
      ),
      cause_id: migrationId,
      world_id: expectString(readonlyWorld, "world_id", "WorldSnapshot"),
      basis_revision: expectInteger(
        readonlyWorld,
        "world_revision",
        "WorldSnapshot",
      ),
      preconditions: [],
      deterministic_context: cloneJson(
        expectProperty(
          request,
          "deterministic_context",
          "RulePluginRequest",
        ),
      ),
      ops: [
        {
          op: "content_upgrade.apply",
          candidate_save: cloneJson(
            expectProperty(
              output,
              "candidate_save",
              "ContentUpgradeOutput",
            ),
          ),
        },
      ],
      source: {
        source_kind: "content_upgrade",
        upgrade_command_id: expectString(
          authorization,
          "upgrade_command_id",
          "UpgradeAuthorization",
        ),
        migration_id: migrationId,
        source_save_digest: expectString(
          authorization,
          "source_save_digest",
          "UpgradeAuthorization",
        ),
        authorization_digest: expectString(
          authorization,
          "authorization_digest",
          "UpgradeAuthorization",
        ),
        result_digest: expectString(
          output,
          "result_digest",
          "ContentUpgradeOutput",
        ),
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
      packet_id: input.packetId,
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
      packet_id: input.packetId,
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
    const { snapshot } = await this.#worlds.readCurrent(input.worldId);
    const worldId = expectString(snapshot.value, "world_id", "WorldSnapshot");
    if (worldId !== input.worldId) {
      throw new EngineFault(
        "runtime.packet_builder.world_identity_mismatch",
        "Runtime world reader returned a snapshot for another world",
        {
          requested_world_id: input.worldId,
          actual_world_id: worldId,
        },
      );
    }
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
    const status = expectString(card, "status", "EventCardState");
    if (status !== "available") {
      throw new EngineFault(
        "runtime.packet_builder.event_card_unavailable",
        "Only an available EventCard can be triggered",
        {
          world_id: worldId,
          event_card_id: input.eventCardId,
          status,
        },
      );
    }
    const control = expectJsonObject(
      expectProperty(card, "control", "EventCardState"),
      "EventCardState.control",
    );
    const cardControlBindingId = expectString(
      control,
      "binding_id",
      "ControlBindingRef",
    );
    if (cardControlBindingId !== input.controlBindingId) {
      throw new EngineFault(
        "runtime.packet_builder.event_card_control_mismatch",
        "EventCard is not owned by the command Session control binding",
        {
          world_id: worldId,
          event_card_id: input.eventCardId,
          session_control_binding_id: input.controlBindingId,
          card_control_binding_id: cardControlBindingId,
        },
      );
    }

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
    if (publishedRevision > currentRevision) {
      throw new EngineFault(
        "runtime.packet_builder.published_revision_invalid",
        "EventCard published_revision cannot exceed the current world revision",
        {
          world_id: worldId,
          published_revision: publishedRevision,
          current_revision: currentRevision,
        },
      );
    }
    const deterministicContext = this.#contracts.assertObject(
      CONTRACT_REF.deterministicContext,
      expectProperty(
        sealed,
        "deterministic_context",
        "SealedEventResult",
      ),
    ).value;

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

function buildAssetAcceptancePreconditions(
  request: JsonObject,
  subjectRevision: number,
): readonly JsonObject[] {
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
    if (entity.expected_revision !== undefined) {
      assertEqual(
        "asset_acceptance.entity_revision",
        subjectRevision,
        expectInteger(entity, "expected_revision", "EntityRef"),
      );
    }
    return Object.freeze([
      {
        kind: "entity.revision_is",
        entity_id: expectString(entity, "entity_id", "EntityRef"),
        revision: subjectRevision,
      },
    ]);
  }
  if (subjectKind === "definition") {
    const definition = expectJsonObject(
      expectProperty(subject, "definition", "SubjectRef"),
      "SubjectRef.definition",
    );
    if (expectString(definition, "kind", "DefinitionRef") !== "dynamic") {
      throw new EngineFault(
        "runtime.packet_builder.asset_acceptance_subject_immutable",
        "AssetAcceptance can bind only runtime Entity or DynamicDefinition subjects",
        { request_id: expectString(request, "request_id", "MaterializationRequest") },
      );
    }
    assertEqual(
      "asset_acceptance.definition_revision",
      subjectRevision,
      expectInteger(definition, "revision", "DynamicDefinitionRef"),
    );
    return Object.freeze([
      {
        kind: "definition.revision_is",
        definition_id: expectString(
          definition,
          "definition_id",
          "DynamicDefinitionRef",
        ),
        revision: subjectRevision,
      },
    ]);
  }
  throw new EngineFault(
    "runtime.packet_builder.asset_acceptance_subject_kind",
    "AssetAcceptance references an unsupported subject kind",
    { subject_kind: subjectKind },
  );
}
