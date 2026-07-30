import type { ValidatedJsonObject } from "./validated-json.js";

export const CONTRACT_ID = Object.freeze({
  common: "https://schemas.luoxia.engine/contracts/common.v1.schema.json",
  contentBundle:
    "https://schemas.luoxia.engine/contracts/content-bundle.v1.schema.json",
  clientBridge:
    "https://schemas.luoxia.engine/contracts/client-bridge.v1.schema.json",
  materialization:
    "https://schemas.luoxia.engine/contracts/materialization.v1.schema.json",
  modelProtocol:
    "https://schemas.luoxia.engine/contracts/model-protocol.v1.schema.json",
  rulePlugin:
    "https://schemas.luoxia.engine/contracts/rule-plugin.v1.schema.json",
  saveSchemaMigration:
    "https://schemas.luoxia.engine/contracts/save-schema-migration.v1.schema.json",
  worldRuntime:
    "https://schemas.luoxia.engine/contracts/world-runtime.v1.schema.json",
} as const);

type ContractId = (typeof CONTRACT_ID)[keyof typeof CONTRACT_ID];

export function definitionRef<
  const TContractId extends ContractId,
  const TDefinition extends string,
>(contractId: TContractId, definition: TDefinition): `${TContractId}#/$defs/${TDefinition}` {
  return `${contractId}#/$defs/${definition}`;
}

export const CONTRACT_REF = Object.freeze({
  identifier: definitionRef(CONTRACT_ID.common, "Identifier"),
  namespacedIdentifier: definitionRef(
    CONTRACT_ID.common,
    "NamespacedIdentifier",
  ),
  uuid: definitionRef(CONTRACT_ID.common, "Uuid"),
  semVer: definitionRef(CONTRACT_ID.common, "SemVer"),
  sha256: definitionRef(CONTRACT_ID.common, "Sha256"),
  packLock: definitionRef(CONTRACT_ID.common, "PackLock"),
  pluginLock: definitionRef(CONTRACT_ID.common, "PluginLock"),
  localizedText: definitionRef(CONTRACT_ID.common, "LocalizedText"),
  dayNumber: definitionRef(CONTRACT_ID.common, "DayNumber"),
  deterministicContext: definitionRef(
    CONTRACT_ID.common,
    "DeterministicContext",
  ),
  decimalString: definitionRef(CONTRACT_ID.worldRuntime, "DecimalString"),
  contentBundle: CONTRACT_ID.contentBundle,
  contentUpgrade: definitionRef(
    CONTRACT_ID.contentBundle,
    "ContentUpgrade",
  ),
  contentUpgradeIdMapping: definitionRef(
    CONTRACT_ID.contentBundle,
    "ContentUpgradeIdMapping",
  ),
  worldState: definitionRef(CONTRACT_ID.worldRuntime, "WorldState"),
  worldSnapshot: definitionRef(CONTRACT_ID.worldRuntime, "WorldSnapshot"),
  worldContentLock: definitionRef(CONTRACT_ID.worldRuntime, "WorldContentLock"),
  saveEnvelope: definitionRef(CONTRACT_ID.worldRuntime, "SaveEnvelope"),
  migrationHistoryEntry: definitionRef(
    CONTRACT_ID.worldRuntime,
    "MigrationHistoryEntry",
  ),
  contentUpgradeApplyOp: definitionRef(
    CONTRACT_ID.worldRuntime,
    "ContentUpgradeApplyOp",
  ),
  contentPacket: definitionRef(CONTRACT_ID.worldRuntime, "ContentPacket"),
  packetProposal: definitionRef(CONTRACT_ID.worldRuntime, "PacketProposal"),
  packetCommitIdentity: definitionRef(
    CONTRACT_ID.worldRuntime,
    "PacketCommitIdentity",
  ),
  applyPacketResult: definitionRef(
    CONTRACT_ID.worldRuntime,
    "ApplyPacketResult",
  ),
  domainEvent: definitionRef(CONTRACT_ID.worldRuntime, "DomainEvent"),
  committedEvent: definitionRef(CONTRACT_ID.worldRuntime, "CommittedEvent"),
  sessionView: definitionRef(CONTRACT_ID.worldRuntime, "SessionView"),
  modelRequest: definitionRef(CONTRACT_ID.modelProtocol, "ModelRequest"),
  modelProviderInputEnvelope: definitionRef(
    CONTRACT_ID.modelProtocol,
    "ModelProviderInputEnvelope",
  ),
  modelResponse: definitionRef(CONTRACT_ID.modelProtocol, "ModelResponse"),
  modelOutput: definitionRef(CONTRACT_ID.modelProtocol, "ModelOutput"),
  verifiedModelOutput: definitionRef(
    CONTRACT_ID.modelProtocol,
    "VerifiedModelOutputRef",
  ),
  rulePluginManifest: definitionRef(
    CONTRACT_ID.rulePlugin,
    "RulePluginManifest",
  ),
  rulePluginRequest: definitionRef(
    CONTRACT_ID.rulePlugin,
    "RulePluginRequest",
  ),
  rulePluginResponse: definitionRef(
    CONTRACT_ID.rulePlugin,
    "RulePluginResponse",
  ),
  choiceSpec: definitionRef(CONTRACT_ID.rulePlugin, "ChoiceSpec"),
  rulePluginChoiceResolution: definitionRef(
    CONTRACT_ID.rulePlugin,
    "ChoiceResolutionEvidence",
  ),
  upgradeAuthorization: definitionRef(
    CONTRACT_ID.rulePlugin,
    "UpgradeAuthorization",
  ),
  contentUpgradeInput: definitionRef(
    CONTRACT_ID.rulePlugin,
    "ContentUpgradeInput",
  ),
  contentUpgradeOutput: definitionRef(
    CONTRACT_ID.rulePlugin,
    "ContentUpgradeOutput",
  ),
  saveSchemaMigrationModuleManifest: definitionRef(
    CONTRACT_ID.saveSchemaMigration,
    "ModuleManifest",
  ),
  saveSchemaMigrationPlan: definitionRef(
    CONTRACT_ID.saveSchemaMigration,
    "MigrationPlan",
  ),
  saveSchemaImportRequest: definitionRef(
    CONTRACT_ID.saveSchemaMigration,
    "ImportRequest",
  ),
  storedSaveSchemaMigrationRequest: definitionRef(
    CONTRACT_ID.saveSchemaMigration,
    "StoredMigrationRequest",
  ),
  clientEnvelope: definitionRef(CONTRACT_ID.clientBridge, "ClientEnvelope"),
  serverEnvelope: definitionRef(CONTRACT_ID.clientBridge, "ServerEnvelope"),
  commandResult: definitionRef(CONTRACT_ID.clientBridge, "CommandResult"),
  contentUpgradeAccept: definitionRef(
    CONTRACT_ID.clientBridge,
    "ContentUpgradeAccept",
  ),
  stageModuleManifest: definitionRef(
    CONTRACT_ID.clientBridge,
    "StageModuleManifest",
  ),
  stageModuleLock: definitionRef(CONTRACT_ID.common, "StageModuleLock"),
  stageOpen: definitionRef(CONTRACT_ID.clientBridge, "StageOpen"),
  stageUpdate: definitionRef(CONTRACT_ID.clientBridge, "StageUpdate"),
  stageClose: definitionRef(CONTRACT_ID.clientBridge, "StageClose"),
  materializationRequest: definitionRef(
    CONTRACT_ID.materialization,
    "MaterializationRequest",
  ),
  assetCandidate: definitionRef(CONTRACT_ID.materialization, "AssetCandidate"),
  reviewReceipt: definitionRef(CONTRACT_ID.materialization, "ReviewReceipt"),
  assetAcceptance: definitionRef(
    CONTRACT_ID.materialization,
    "AssetAcceptance",
  ),
  visualBinding: definitionRef(CONTRACT_ID.materialization, "VisualBinding"),
} as const);

export const MODEL_OUTPUT_SCHEMA_REF_BY_REQUEST_KIND = Object.freeze({
  "director.daily_settlement": definitionRef(
    CONTRACT_ID.modelProtocol,
    "DirectorDailySettlementOutput",
  ),
  "director.dialogue_events": definitionRef(
    CONTRACT_ID.modelProtocol,
    "DirectorDialogueEventsOutput",
  ),
  "director.system_dialogue": definitionRef(
    CONTRACT_ID.modelProtocol,
    "DirectorSystemDialogueOutput",
  ),
  "director.goal_plan": definitionRef(
    CONTRACT_ID.modelProtocol,
    "DirectorGoalPlanOutput",
  ),
  "director.definition_draft": definitionRef(
    CONTRACT_ID.modelProtocol,
    "DirectorDefinitionDraftOutput",
  ),
  "character.dialogue": definitionRef(
    CONTRACT_ID.modelProtocol,
    "CharacterDialogueOutput",
  ),
  "character.react": definitionRef(
    CONTRACT_ID.modelProtocol,
    "CharacterReactOutput",
  ),
} as const);

export type WorldContentLockDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.worldContentLock
>;

export type PackLockDocument = ValidatedJsonObject<typeof CONTRACT_REF.packLock>;

export type StageModuleLockDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageModuleLock
>;

export type SaveEnvelopeDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.saveEnvelope
>;

export type UpgradeAuthorizationDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.upgradeAuthorization
>;

export type ChoiceSpecDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.choiceSpec
>;

export type RulePluginChoiceResolutionDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginChoiceResolution
>;

export type SaveSchemaMigrationModuleManifestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.saveSchemaMigrationModuleManifest
>;

export type SaveSchemaMigrationPlanDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.saveSchemaMigrationPlan
>;

export type StoredSaveSchemaMigrationRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.storedSaveSchemaMigrationRequest
>;
