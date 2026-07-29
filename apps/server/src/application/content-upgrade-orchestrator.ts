import {
  CONTRACT_REF,
  EngineFault,
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type JsonDigest,
  type JsonObject,
  type JsonValue,
  type SaveEnvelopeDocument,
  type UpgradeAuthorizationDocument,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  ContentUpgradeAuthorizationAuthority,
  DeterministicContextAuthority,
} from "@luoxia/world-core/composition";
import type { ApplyPacketResultDocument } from "@luoxia/world-core";

import type {
  CommandJournal,
  StoredReceivedCommand,
} from "./command-journal.js";
import type { CommandFinalizer } from "./command-finalizer.js";
import type {
  ContentUpgradeAuthorizationLedger,
  StoredContentUpgradeAuthorization,
} from "./runtime-persistence.js";
import type {
  RuntimeSaveCompatibility,
  RuntimeSaveService,
} from "./runtime-save.js";
import type { RulePluginAbiRegistry } from "./rule-plugin-abi.js";
import {
  resolveContentRulePluginInvocationBinding,
  type RuntimeRulePluginInvocationBinding,
} from "./rule-plugin-operation-binding.js";
import type { RulePluginExecutor } from "./rule-plugin-executor.js";
import type { VerifiedRulePluginInvocationReceipt } from "./rule-plugin-gateway.js";
import type {
  RuntimeWorldBinding,
  RuntimeWorldBindingResolver,
} from "./runtime-world-binding.js";
import type { ServerEnvelopeDocument } from "./server-envelope.js";
import type { WorldMutationOrchestrator } from "./world-mutation-orchestrator.js";

export interface ContentUpgradeWindow {
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ContentUpgradeClock {
  issueWindow(): ContentUpgradeWindow;
  now(): string;
}

export interface ContentUpgradeOrchestrator {
  execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]>;
}

export interface ContentUpgradeOrchestratorDependencies {
  readonly contracts: ContractValidator;
  readonly digest: JsonDigest;
  readonly commands: CommandJournal;
  readonly worlds: RuntimeWorldBindingResolver;
  readonly saves: RuntimeSaveService;
  readonly saveCompatibility: RuntimeSaveCompatibility;
  readonly catalog: ContentRuntimeCatalog;
  readonly rulePluginAbi: RulePluginAbiRegistry;
  readonly rulePlugins: RulePluginExecutor;
  readonly deterministicContexts: DeterministicContextAuthority;
  readonly authorizations: ContentUpgradeAuthorizationAuthority;
  readonly authorizationLedger: ContentUpgradeAuthorizationLedger;
  readonly clock: ContentUpgradeClock;
  readonly mutations: WorldMutationOrchestrator;
  readonly finalizer: CommandFinalizer;
}

export function createContentUpgradeOrchestrator(
  dependencies: ContentUpgradeOrchestratorDependencies,
): ContentUpgradeOrchestrator {
  return new DefaultContentUpgradeOrchestrator(dependencies);
}

class DefaultContentUpgradeOrchestrator
  implements ContentUpgradeOrchestrator
{
  readonly #dependencies: ContentUpgradeOrchestratorDependencies;

  public constructor(dependencies: ContentUpgradeOrchestratorDependencies) {
    this.#dependencies = dependencies;
  }

  public async execute(
    clientEnvelopeCandidate: unknown,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const envelope = this.#dependencies.contracts.assertObject(
      CONTRACT_REF.clientEnvelope,
      clientEnvelopeCandidate,
    );
    const message = expectJsonObject(
      expectProperty(envelope.value, "message", "ClientEnvelope"),
      "ClientEnvelope.message",
    );
    if (
      expectString(message, "type", "ClientMessage") !==
      "content_upgrade.accept"
    ) {
      throw new EngineFault(
        "content_upgrade.orchestration.command_kind_invalid",
        "Content Upgrade orchestrator accepts only content_upgrade.accept",
      );
    }

    const stored = await this.#dependencies.commands.receive(envelope.value);
    if (stored.commandKind !== "content_upgrade.accept") {
      throw new EngineFault(
        "content_upgrade.orchestration.command_kind_invalid",
        "Content Upgrade orchestrator recovered a command of another kind",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
          command_kind: stored.commandKind,
        },
      );
    }
    if (stored.phase === "completed") {
      const replay = await this.#dependencies.finalizer.readCompleted(
        stored.session.sessionId,
        stored.commandId,
      );
      if (replay === undefined) {
        throw new EngineFault(
          "content_upgrade.orchestration.completed_output_missing",
          "Completed Content Upgrade command has no replayable ServerEnvelope outbox",
          {
            session_id: stored.session.sessionId,
            command_id: stored.commandId,
          },
        );
      }
      return replay;
    }
    const execution = stored.contentUpgradeExecution;
    if (execution === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.execution_identity_missing",
        "Received Content Upgrade command has no persisted execution identities",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }
    const persistedAuthorization =
      await this.#dependencies.authorizationLedger.readByUpgradeCommandId(
        execution.upgradeCommandId,
      );
    if (persistedAuthorization?.phase === "commit_ready") {
      return this.#resumeCommitReady(stored, persistedAuthorization);
    }

    const sourceBinding = await this.#dependencies.worlds.resolveCurrent(
      stored.session.worldId,
    );
    assertAcceptedWorldBasis(sourceBinding, stored);
    const sourceSave = await this.#dependencies.saves.exportSave(
      stored.session.worldId,
    );
    assertSourceSaveMatchesBinding(sourceSave, sourceBinding, stored);

    const targetBundle = expectJsonObject(
      expectProperty(
        stored.message,
        "target_bundle",
        "ContentUpgradeAccept",
      ),
      "ContentUpgradeAccept.target_bundle",
    );
    const migrationId = expectString(
      stored.message,
      "migration_id",
      "ContentUpgradeAccept",
    );
    const upgradeBinding = this.#dependencies.catalog.resolveContentUpgrade({
      bundle_id: expectString(targetBundle, "pack_id", "PackLock"),
      pack_version: expectString(targetBundle, "pack_version", "PackLock"),
      bundle_digest: expectString(
        targetBundle,
        "bundle_digest",
        "PackLock",
      ),
      migration_id: migrationId,
    });
    if (upgradeBinding === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.migration_missing",
        "Target ContentBundle does not declare the selected migration_id",
        {
          migration_id: migrationId,
          pack_id: expectString(targetBundle, "pack_id", "PackLock"),
          bundle_digest: expectString(
            targetBundle,
            "bundle_digest",
            "PackLock",
          ),
        },
      );
    }
    const sourceBundle = readRootBundleLock(sourceSave);
    assertUpgradeSelection(
      this.#dependencies.digest,
      stored,
      sourceBundle,
      targetBundle,
      upgradeBinding.upgrade,
    );
    const invocation = resolveContentRulePluginInvocationBinding({
      binding: upgradeBinding.transformer,
      abi: this.#dependencies.rulePluginAbi,
    });

    let authorization: UpgradeAuthorizationDocument;
    try {
      authorization = await this.#resolveAuthorization({
        stored,
        sourceSave,
        sourceBundle,
        targetBundle,
        migrationId,
      });
    } catch (error: unknown) {
      if (
        error instanceof EngineFault &&
        error.code === "content_upgrade.authorization.expired"
      ) {
        return this.#dependencies.finalizer.completeRejected({
          sessionId: stored.session.sessionId,
          commandId: stored.commandId,
          code: error.code,
        });
      }
      throw error;
    }
    const requestInput = Object.freeze({
      migration_id: migrationId,
      source_bundle: sourceBundle,
      target_bundle: targetBundle,
      source_save: sourceSave.value,
      declared_mapping: expectProperty(
        upgradeBinding.upgrade,
        "declared_mapping",
        "ContentUpgrade",
      ),
      authorization: authorization.value,
    });
    const receipt = await this.#dependencies.rulePlugins.executeRecoverable({
      requestId: execution.ruleRequestId,
      modelInvocations: [],
      candidateFactory: () =>
        this.#createRulePluginRequest({
          stored,
          sourceBinding,
          invocation,
          requestInput,
        }),
    });
    assertRecoveredInvocation({
      receipt,
      stored,
      invocation,
      requestInput,
      sourceBinding,
    });

    const output = expectJsonObject(
      expectProperty(
        receipt.response.value,
        "output",
        "RulePluginResponse",
      ),
      "RulePluginResponse.output",
    );
    const outputKind = expectString(
      output,
      "output_kind",
      "RulePluginResponse.output",
    );
    if (outputKind === "reject") {
      return this.#dependencies.finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: expectString(output, "code", "RejectOutput"),
      });
    }
    if (outputKind !== "content_upgrade.candidate") {
      throw new EngineFault(
        "content_upgrade.orchestration.output_invalid",
        "Content Upgrade transformer returned an unsupported output",
        {
          upgrade_command_id: execution.upgradeCommandId,
          output_kind: outputKind,
        },
      );
    }
    const unresolved = asObjectArray(
      expectProperty(output, "unresolved", "ContentUpgradeOutput"),
      "ContentUpgradeOutput.unresolved",
    );
    if (unresolved.length > 0) {
      return this.#dependencies.finalizer.completeRejected({
        sessionId: stored.session.sessionId,
        commandId: stored.commandId,
        code: expectString(
          unresolved[0] as JsonObject,
          "code",
          "ContentUpgradeOutput.unresolved[0]",
        ),
      });
    }
    const resultDigest = expectString(
      output,
      "result_digest",
      "ContentUpgradeOutput",
    );
    await this.#dependencies.authorizationLedger.markCommitReady({
      upgradeCommandId: execution.upgradeCommandId,
      resultDigest,
    });
    return this.#commitCandidate(stored, authorization, receipt);
  }

  async #resumeCommitReady(
    stored: StoredReceivedCommand,
    persisted: StoredContentUpgradeAuthorization,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const execution = stored.contentUpgradeExecution;
    if (
      execution === undefined ||
      persisted.resultDigest === undefined ||
      persisted.sessionId !== stored.session.sessionId ||
      persisted.clientCommandId !== stored.commandId ||
      persisted.ruleRequestId !== execution.ruleRequestId
    ) {
      throw new EngineFault(
        "content_upgrade.orchestration.commit_ready_identity_conflict",
        "Commit-ready Content Upgrade evidence differs from its Command Journal identity",
        {
          session_id: stored.session.sessionId,
          command_id: stored.commandId,
        },
      );
    }
    const receipt = await this.#dependencies.rulePlugins.executeRecoverable({
      requestId: execution.ruleRequestId,
      modelInvocations: [],
      candidateFactory: () => {
        throw new EngineFault(
          "content_upgrade.orchestration.commit_ready_invocation_missing",
          "Commit-ready Content Upgrade has no recoverable RulePlugin invocation",
          {
            upgrade_command_id: execution.upgradeCommandId,
            rule_request_id: execution.ruleRequestId,
          },
        );
      },
    });
    const request = receipt.request.value;
    const requestInput = expectJsonObject(
      expectProperty(request, "input", "RulePluginRequest"),
      "RulePluginRequest.input",
    );
    const sourceSave = this.#dependencies.contracts.assertObject(
      CONTRACT_REF.saveEnvelope,
      expectProperty(requestInput, "source_save", "ContentUpgradeInput"),
    );
    const sourceBundle = readRootBundleLock(sourceSave);
    const targetBundle = expectJsonObject(
      expectProperty(
        stored.message,
        "target_bundle",
        "ContentUpgradeAccept",
      ),
      "ContentUpgradeAccept.target_bundle",
    );
    const migrationId = expectString(
      stored.message,
      "migration_id",
      "ContentUpgradeAccept",
    );
    const upgradeBinding = this.#dependencies.catalog.resolveContentUpgrade({
      bundle_id: expectString(targetBundle, "pack_id", "PackLock"),
      pack_version: expectString(targetBundle, "pack_version", "PackLock"),
      bundle_digest: expectString(
        targetBundle,
        "bundle_digest",
        "PackLock",
      ),
      migration_id: migrationId,
    });
    if (upgradeBinding === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.migration_missing",
        "Commit-ready Content Upgrade target migration is absent from the active Catalog",
        {
          upgrade_command_id: execution.upgradeCommandId,
          migration_id: migrationId,
        },
      );
    }
    assertUpgradeSelection(
      this.#dependencies.digest,
      stored,
      sourceBundle,
      targetBundle,
      upgradeBinding.upgrade,
    );
    assertStoredAuthorizationIdentity(
      persisted,
      stored,
      execution.ruleRequestId,
      migrationId,
      this.#dependencies.digest.sha256(sourceSave.value),
      sourceBundle,
      targetBundle,
    );
    const invocation = resolveContentRulePluginInvocationBinding({
      binding: upgradeBinding.transformer,
      abi: this.#dependencies.rulePluginAbi,
    });
    assertCommitReadyInvocation({
      receipt,
      stored,
      invocation,
      authorization: persisted.authorization,
      resultDigest: persisted.resultDigest,
    });
    return this.#commitCandidate(
      stored,
      persisted.authorization,
      receipt,
    );
  }

  async #commitCandidate(
    stored: StoredReceivedCommand,
    authorization: UpgradeAuthorizationDocument,
    receipt: VerifiedRulePluginInvocationReceipt,
  ): Promise<readonly ServerEnvelopeDocument[]> {
    const execution = stored.contentUpgradeExecution;
    if (execution === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.execution_identity_missing",
        "Content Upgrade execution identity disappeared before commit",
      );
    }
    const output = expectJsonObject(
      expectProperty(
        receipt.response.value,
        "output",
        "RulePluginResponse",
      ),
      "RulePluginResponse.output",
    );
    if (
      expectString(output, "output_kind", "RulePluginResponse.output") !==
        "content_upgrade.candidate"
    ) {
      throw new EngineFault(
        "content_upgrade.orchestration.commit_output_invalid",
        "Only a verified Content Upgrade candidate can enter apply_packet",
        { upgrade_command_id: execution.upgradeCommandId },
      );
    }
    const candidateSave = this.#dependencies.contracts.assertObject(
      CONTRACT_REF.saveEnvelope,
      expectProperty(output, "candidate_save", "ContentUpgradeOutput"),
    );
    this.#dependencies.saveCompatibility.assertImportCompatible(
      candidateSave,
    );
    let result: ApplyPacketResultDocument;
    try {
      result = await this.#dependencies.mutations.commitContentUpgrade({
        authorization,
        receipt,
      });
    } catch (error: unknown) {
      if (
        error instanceof EngineFault &&
        error.code === "content_upgrade.authorization.expired"
      ) {
        return this.#dependencies.finalizer.completeRejected({
          sessionId: stored.session.sessionId,
          commandId: stored.commandId,
          code: error.code,
        });
      }
      throw error;
    }
    const finalWorldRevision = expectInteger(
      result.value,
      "world_revision",
      "ApplyPacketResult",
    );
    const expectedRevision = stored.session.worldRevision + 1;
    const status = expectString(
      result.value,
      "status",
      "ApplyPacketResult",
    );
    if (
      !Number.isSafeInteger(expectedRevision) ||
      finalWorldRevision !== expectedRevision ||
      expectString(result.value, "packet_id", "ApplyPacketResult") !==
        execution.upgradeCommandId ||
      (status !== "committed" && status !== "duplicate")
    ) {
      throw new EngineFault(
        "content_upgrade.orchestration.commit_identity_mismatch",
        "Content Upgrade apply_packet returned an unexpected authoritative identity",
        {
          upgrade_command_id: execution.upgradeCommandId,
          expected_world_revision: Number.isSafeInteger(expectedRevision)
            ? expectedRevision
            : null,
          actual_world_revision: finalWorldRevision,
          result_status: status,
        },
      );
    }
    return this.#dependencies.finalizer.completeWorldAccepted({
      sessionId: stored.session.sessionId,
      commandId: stored.commandId,
      finalWorldRevision,
    });
  }

  async #resolveAuthorization(input: {
    readonly stored: StoredReceivedCommand;
    readonly sourceSave: SaveEnvelopeDocument;
    readonly sourceBundle: JsonObject;
    readonly targetBundle: JsonObject;
    readonly migrationId: string;
  }): Promise<UpgradeAuthorizationDocument> {
    const execution = input.stored.contentUpgradeExecution;
    if (execution === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.execution_identity_missing",
        "Content Upgrade execution identity disappeared",
      );
    }
    const sourceSaveDigest = this.#dependencies.digest.sha256(
      input.sourceSave.value,
    );
    const existing =
      await this.#dependencies.authorizationLedger.readByUpgradeCommandId(
        execution.upgradeCommandId,
      );
    if (existing !== undefined) {
      assertStoredAuthorizationIdentity(
        existing,
        input.stored,
        execution.ruleRequestId,
        input.migrationId,
        sourceSaveDigest,
        input.sourceBundle,
        input.targetBundle,
      );
      return this.#dependencies.authorizations.assertAuthentic(
        existing.authorization.value,
        this.#dependencies.clock.now(),
      );
    }
    const window = this.#dependencies.clock.issueWindow();
    const authorization = this.#dependencies.authorizations.issue({
      upgradeCommandId: execution.upgradeCommandId,
      worldId: input.stored.session.worldId,
      migrationId: input.migrationId,
      requestedByActorId: input.stored.session.playerEntityId,
      sourceWorldRevision: input.stored.session.worldRevision,
      sourceSaveDigest,
      sourceBundleDigest: expectString(
        input.sourceBundle,
        "bundle_digest",
        "PackLock",
      ),
      targetBundleDigest: expectString(
        input.targetBundle,
        "bundle_digest",
        "PackLock",
      ),
      consentTextDigest: expectString(
        input.stored.message,
        "consent_text_digest",
        "ContentUpgradeAccept",
      ),
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
    });
    const persisted =
      await this.#dependencies.authorizationLedger.persistAuthorized({
        sessionId: input.stored.session.sessionId,
        clientCommandId: input.stored.commandId,
        ruleRequestId: execution.ruleRequestId,
        authorization,
      });
    assertStoredAuthorizationIdentity(
      persisted,
      input.stored,
      execution.ruleRequestId,
      input.migrationId,
      sourceSaveDigest,
      input.sourceBundle,
      input.targetBundle,
    );
    return authorization;
  }

  #createRulePluginRequest(input: {
    readonly stored: StoredReceivedCommand;
    readonly sourceBinding: RuntimeWorldBinding;
    readonly invocation: RuntimeRulePluginInvocationBinding;
    readonly requestInput: JsonObject;
  }): JsonObject {
    const execution = input.stored.contentUpgradeExecution;
    if (execution === undefined) {
      throw new EngineFault(
        "content_upgrade.orchestration.execution_identity_missing",
        "Content Upgrade execution identity disappeared",
      );
    }
    const worldState = expectJsonObject(
      expectProperty(
        input.sourceBinding.record.snapshot.value,
        "world_state",
        "WorldSnapshot",
      ),
      "WorldSnapshot.world_state",
    );
    const deterministicContext =
      this.#dependencies.deterministicContexts.issue({
        worldId: input.stored.session.worldId,
        logicalTime: expectProperty(worldState, "clock", "WorldState"),
        randomChoices: [],
        externalResults: [],
      });
    return Object.freeze({
      contract_version: "rule-plugin.v1",
      record_type: "rule_plugin.request",
      request_id: execution.ruleRequestId,
      plugin_lock: input.invocation.pluginLock,
      operation_id: input.invocation.operationId,
      operation_kind: "content_upgrade.transform",
      basis_revision: input.stored.session.worldRevision,
      readonly_world: input.sourceBinding.record.snapshot.value,
      deterministic_context: deterministicContext.value,
      input: input.requestInput,
    });
  }
}

function assertAcceptedWorldBasis(
  binding: RuntimeWorldBinding,
  stored: StoredReceivedCommand,
): void {
  const snapshot = binding.record.snapshot.value;
  if (
    expectString(snapshot, "world_id", "WorldSnapshot") !==
      stored.session.worldId ||
    expectInteger(snapshot, "world_revision", "WorldSnapshot") !==
      stored.session.worldRevision
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.accepted_basis_changed",
      "Content Upgrade can only execute from the command's accepted world basis",
      {
        session_id: stored.session.sessionId,
        command_id: stored.commandId,
        expected_world_revision: stored.session.worldRevision,
        actual_world_revision: expectInteger(
          snapshot,
          "world_revision",
          "WorldSnapshot",
        ),
      },
    );
  }
}

function assertSourceSaveMatchesBinding(
  sourceSave: SaveEnvelopeDocument,
  binding: RuntimeWorldBinding,
  stored: StoredReceivedCommand,
): void {
  const value = sourceSave.value;
  const snapshot = binding.record.snapshot.value;
  if (
    expectString(value, "world_id", "SaveEnvelope") !==
      stored.session.worldId ||
    expectInteger(value, "world_revision", "SaveEnvelope") !==
      stored.session.worldRevision ||
    !jsonEquals(
      expectProperty(value, "world_state", "SaveEnvelope"),
      expectProperty(snapshot, "world_state", "WorldSnapshot"),
    ) ||
    !jsonEquals(
      expectProperty(value, "world_content_lock", "SaveEnvelope"),
      binding.record.worldContentLock.value,
    )
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.source_save_mismatch",
      "Exported SaveEnvelope does not match the accepted authoritative world",
      {
        session_id: stored.session.sessionId,
        command_id: stored.commandId,
      },
    );
  }
}

function readRootBundleLock(sourceSave: SaveEnvelopeDocument): JsonObject {
  const contentLock = expectJsonObject(
    expectProperty(
      sourceSave.value,
      "world_content_lock",
      "SaveEnvelope",
    ),
    "SaveEnvelope.world_content_lock",
  );
  return expectJsonObject(
    expectProperty(contentLock, "root_bundle_lock", "WorldContentLock"),
    "WorldContentLock.root_bundle_lock",
  );
}

function assertUpgradeSelection(
  digest: JsonDigest,
  stored: StoredReceivedCommand,
  sourceBundle: JsonObject,
  targetBundle: JsonObject,
  upgrade: JsonObject,
): void {
  const migrationId = expectString(
    stored.message,
    "migration_id",
    "ContentUpgradeAccept",
  );
  const consentTextDigest = expectString(
    stored.message,
    "consent_text_digest",
    "ContentUpgradeAccept",
  );
  const expectedConsentDigest = digest.sha256(
    expectProperty(upgrade, "description", "ContentUpgrade"),
  );
  if (
    expectString(upgrade, "migration_id", "ContentUpgrade") !==
      migrationId ||
    expectString(sourceBundle, "pack_id", "PackLock") !==
      expectString(targetBundle, "pack_id", "PackLock") ||
    expectString(upgrade, "from_pack_version", "ContentUpgrade") !==
      expectString(sourceBundle, "pack_version", "PackLock") ||
    expectString(upgrade, "from_bundle_digest", "ContentUpgrade") !==
      expectString(sourceBundle, "bundle_digest", "PackLock") ||
    expectString(upgrade, "to_pack_version", "ContentUpgrade") !==
      expectString(targetBundle, "pack_version", "PackLock") ||
    consentTextDigest !== expectedConsentDigest
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.selection_mismatch",
      "Selected migration does not exactly bind the accepted source, target, and consent text",
      {
        migration_id: migrationId,
        source_bundle_digest: expectString(
          sourceBundle,
          "bundle_digest",
          "PackLock",
        ),
        target_bundle_digest: expectString(
          targetBundle,
          "bundle_digest",
          "PackLock",
        ),
        consent_text_digest: consentTextDigest,
        expected_consent_text_digest: expectedConsentDigest,
      },
    );
  }
}

function assertStoredAuthorizationIdentity(
  stored: StoredContentUpgradeAuthorization,
  command: StoredReceivedCommand,
  ruleRequestId: string,
  migrationId: string,
  sourceSaveDigest: string,
  sourceBundle: JsonObject,
  targetBundle: JsonObject,
): void {
  const authorization = stored.authorization.value;
  if (
    stored.sessionId !== command.session.sessionId ||
    stored.clientCommandId !== command.commandId ||
    stored.ruleRequestId !== ruleRequestId ||
    expectString(
      authorization,
      "upgrade_command_id",
      "UpgradeAuthorization",
    ) !== command.contentUpgradeExecution?.upgradeCommandId ||
    expectString(authorization, "world_id", "UpgradeAuthorization") !==
      command.session.worldId ||
    expectString(
      authorization,
      "requested_by_actor_id",
      "UpgradeAuthorization",
    ) !== command.session.playerEntityId ||
    expectInteger(
      authorization,
      "source_world_revision",
      "UpgradeAuthorization",
    ) !== command.session.worldRevision ||
    expectString(authorization, "migration_id", "UpgradeAuthorization") !==
      migrationId ||
    expectString(
      authorization,
      "source_save_digest",
      "UpgradeAuthorization",
    ) !== sourceSaveDigest ||
    expectString(
      authorization,
      "source_bundle_digest",
      "UpgradeAuthorization",
    ) !== expectString(sourceBundle, "bundle_digest", "PackLock") ||
    expectString(
      authorization,
      "target_bundle_digest",
      "UpgradeAuthorization",
    ) !== expectString(targetBundle, "bundle_digest", "PackLock") ||
    expectString(
      authorization,
      "consent_text_digest",
      "UpgradeAuthorization",
    ) !==
      expectString(
        command.message,
        "consent_text_digest",
        "ContentUpgradeAccept",
      )
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.authorization_conflict",
      "Persisted Content Upgrade authorization differs from its command and source SaveEnvelope",
      {
        session_id: command.session.sessionId,
        command_id: command.commandId,
      },
    );
  }
}

function assertCommitReadyInvocation(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly stored: StoredReceivedCommand;
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly authorization: UpgradeAuthorizationDocument;
  readonly resultDigest: string;
}): void {
  const execution = input.stored.contentUpgradeExecution;
  if (execution === undefined) {
    throw new EngineFault(
      "content_upgrade.orchestration.execution_identity_missing",
      "Commit-ready Content Upgrade lost its execution identities",
    );
  }
  const request = input.receipt.request.value;
  const response = input.receipt.response.value;
  const requestInput = expectJsonObject(
    expectProperty(request, "input", "RulePluginRequest"),
    "RulePluginRequest.input",
  );
  const sourceSave = expectJsonObject(
    expectProperty(requestInput, "source_save", "ContentUpgradeInput"),
    "ContentUpgradeInput.source_save",
  );
  const output = expectJsonObject(
    expectProperty(response, "output", "RulePluginResponse"),
    "RulePluginResponse.output",
  );
  const readonlyWorld = expectJsonObject(
    expectProperty(request, "readonly_world", "RulePluginRequest"),
    "RulePluginRequest.readonly_world",
  );
  if (
    input.receipt.proposal !== undefined ||
    input.receipt.worldId !== input.stored.session.worldId ||
    input.receipt.basisRevision !== input.stored.session.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      execution.ruleRequestId ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "content_upgrade.transform" ||
    expectString(response, "operation_kind", "RulePluginResponse") !==
      "content_upgrade.transform" ||
    expectString(output, "output_kind", "ContentUpgradeOutput") !==
      "content_upgrade.candidate" ||
    expectString(output, "result_digest", "ContentUpgradeOutput") !==
      input.resultDigest ||
    expectString(
      output,
      "upgrade_command_id",
      "ContentUpgradeOutput",
    ) !== execution.upgradeCommandId ||
    expectString(readonlyWorld, "world_id", "WorldSnapshot") !==
      input.stored.session.worldId ||
    expectInteger(readonlyWorld, "world_revision", "WorldSnapshot") !==
      input.stored.session.worldRevision ||
    expectString(sourceSave, "world_id", "SaveEnvelope") !==
      input.stored.session.worldId ||
    expectInteger(sourceSave, "world_revision", "SaveEnvelope") !==
      input.stored.session.worldRevision ||
    !jsonEquals(
      expectProperty(request, "plugin_lock", "RulePluginRequest"),
      input.invocation.pluginLock,
    ) ||
    !jsonEquals(
      expectProperty(requestInput, "authorization", "ContentUpgradeInput"),
      input.authorization.value,
    )
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.commit_ready_invocation_conflict",
      "Commit-ready RulePlugin invocation differs from its persisted Content Upgrade authorization",
      {
        upgrade_command_id: execution.upgradeCommandId,
        rule_request_id: execution.ruleRequestId,
      },
    );
  }
}

function assertRecoveredInvocation(input: {
  readonly receipt: VerifiedRulePluginInvocationReceipt;
  readonly stored: StoredReceivedCommand;
  readonly invocation: RuntimeRulePluginInvocationBinding;
  readonly requestInput: JsonObject;
  readonly sourceBinding: RuntimeWorldBinding;
}): void {
  const execution = input.stored.contentUpgradeExecution;
  if (execution === undefined) {
    throw new EngineFault(
      "content_upgrade.orchestration.execution_identity_missing",
      "Recovered Content Upgrade command lost its execution identities",
    );
  }
  const request = input.receipt.request.value;
  if (
    input.receipt.proposal !== undefined ||
    input.receipt.worldId !== input.stored.session.worldId ||
    input.receipt.basisRevision !== input.stored.session.worldRevision ||
    expectString(request, "request_id", "RulePluginRequest") !==
      execution.ruleRequestId ||
    expectString(request, "operation_id", "RulePluginRequest") !==
      input.invocation.operationId ||
    expectString(request, "operation_kind", "RulePluginRequest") !==
      "content_upgrade.transform" ||
    !jsonEquals(
      expectProperty(request, "plugin_lock", "RulePluginRequest"),
      input.invocation.pluginLock,
    ) ||
    !jsonEquals(
      expectProperty(request, "readonly_world", "RulePluginRequest"),
      input.sourceBinding.record.snapshot.value,
    ) ||
    !jsonEquals(
      expectProperty(request, "input", "RulePluginRequest"),
      input.requestInput,
    )
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.execution_identity_conflict",
      "Recovered RulePlugin invocation differs from its Content Upgrade command",
      {
        session_id: input.stored.session.sessionId,
        command_id: input.stored.commandId,
        request_id: execution.ruleRequestId,
      },
    );
  }
  const deterministicContext = expectJsonObject(
    expectProperty(request, "deterministic_context", "RulePluginRequest"),
    "RulePluginRequest.deterministic_context",
  );
  const worldState = expectJsonObject(
    expectProperty(
      input.sourceBinding.record.snapshot.value,
      "world_state",
      "WorldSnapshot",
    ),
    "WorldSnapshot.world_state",
  );
  if (
    !jsonEquals(
      expectProperty(
        deterministicContext,
        "logical_time",
        "DeterministicContext",
      ),
      expectProperty(worldState, "clock", "WorldState"),
    ) ||
    !isEmptyArray(
      expectProperty(
        deterministicContext,
        "random_choices",
        "DeterministicContext",
      ),
    ) ||
    !isEmptyArray(
      expectProperty(
        deterministicContext,
        "external_results",
        "DeterministicContext",
      ),
    )
  ) {
    throw new EngineFault(
      "content_upgrade.orchestration.deterministic_context_conflict",
      "Content Upgrade deterministic context must contain only the accepted world's logical clock",
      { upgrade_command_id: execution.upgradeCommandId },
    );
  }
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "content_upgrade.orchestration.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function isEmptyArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.length === 0;
}
