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
  worldRuntime:
    "https://schemas.luoxia.engine/contracts/world-runtime.v1.schema.json",
} as const);

export type ContractId = (typeof CONTRACT_ID)[keyof typeof CONTRACT_ID];

export function definitionRef<
  const TContractId extends ContractId,
  const TDefinition extends string,
>(contractId: TContractId, definition: TDefinition): `${TContractId}#/$defs/${TDefinition}` {
  return `${contractId}#/$defs/${definition}`;
}

export const CONTRACT_REF = Object.freeze({
  uuid: definitionRef(CONTRACT_ID.common, "Uuid"),
  dayNumber: definitionRef(CONTRACT_ID.common, "DayNumber"),
  contentBundle: CONTRACT_ID.contentBundle,
  worldState: definitionRef(CONTRACT_ID.worldRuntime, "WorldState"),
  worldSnapshot: definitionRef(CONTRACT_ID.worldRuntime, "WorldSnapshot"),
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
  modelResponse: definitionRef(CONTRACT_ID.modelProtocol, "ModelResponse"),
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
  clientEnvelope: definitionRef(CONTRACT_ID.clientBridge, "ClientEnvelope"),
  serverEnvelope: definitionRef(CONTRACT_ID.clientBridge, "ServerEnvelope"),
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
} as const);
