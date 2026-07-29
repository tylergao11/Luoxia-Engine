import {
  CONTRACT_REF,
  type SaveEnvelopeDocument,
} from "./references.js";
import { EngineFault } from "./fault.js";
import {
  expectInteger,
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { ContractValidator } from "./contract-validator.js";

/**
 * Intrinsic SaveEnvelope relationships shared by import/export and World Core.
 * Deployment compatibility remains a Server responsibility because exporting
 * an older, digest-locked save must not depend on the active deployment graph.
 */
export function assertSaveEnvelopeRelationships(
  contracts: ContractValidator,
  envelope: SaveEnvelopeDocument,
): void {
  const value = envelope.value;
  const worldId = expectString(value, "world_id", "SaveEnvelope");
  const worldRevision = expectInteger(
    value,
    "world_revision",
    "SaveEnvelope",
  );
  const eventCursor = expectInteger(
    value,
    "event_cursor",
    "SaveEnvelope",
  );
  if (eventCursor !== worldRevision) {
    throw new EngineFault(
      "runtime.save.event_cursor_mismatch",
      "SaveEnvelope v1 requires event_cursor to equal world_revision",
      {
        world_id: worldId,
        world_revision: worldRevision,
        event_cursor: eventCursor,
      },
    );
  }

  contracts.assertObject(CONTRACT_REF.worldSnapshot, {
    world_id: worldId,
    world_revision: worldRevision,
    world_state: expectProperty(value, "world_state", "SaveEnvelope"),
  });
  const worldContentLock = expectJsonObject(
    expectProperty(value, "world_content_lock", "SaveEnvelope"),
    "SaveEnvelope.world_content_lock",
  );
  const rootBundleLock = expectJsonObject(
    expectProperty(
      worldContentLock,
      "root_bundle_lock",
      "WorldContentLock",
    ),
    "WorldContentLock.root_bundle_lock",
  );
  const rootPackId = expectString(rootBundleLock, "pack_id", "PackLock");

  const dependencyLocks = asObjectArray(
    expectProperty(value, "dependency_bundle_locks", "SaveEnvelope"),
    "SaveEnvelope.dependency_bundle_locks",
  );
  const dependenciesById = indexUniqueLocks(
    dependencyLocks,
    "pack_id",
    "PackLock",
    "runtime.save.dependency_bundle_lock_duplicate",
  );
  if (dependenciesById.has(rootPackId)) {
    throw new EngineFault(
      "runtime.save.root_bundle_repeated",
      "SaveEnvelope root bundle must not also appear in dependency_bundle_locks",
      { world_id: worldId, pack_id: rootPackId },
    );
  }
  indexUniqueLocks(
    asObjectArray(
      expectProperty(value, "rule_plugin_locks", "SaveEnvelope"),
      "SaveEnvelope.rule_plugin_locks",
    ),
    "plugin_id",
    "PluginLock",
    "runtime.save.rule_plugin_lock_duplicate",
  );
  indexUniqueLocks(
    asObjectArray(
      expectProperty(value, "stage_module_locks", "SaveEnvelope"),
      "SaveEnvelope.stage_module_locks",
    ),
    "module_id",
    "StageModuleLock",
    "runtime.save.stage_module_lock_duplicate",
  );
}

function indexUniqueLocks(
  locks: readonly JsonObject[],
  identityField: string,
  label: string,
  faultCode: string,
): ReadonlyMap<string, JsonObject> {
  const indexed = new Map<string, JsonObject>();
  for (const lock of locks) {
    const identity = expectString(lock, identityField, label);
    if (indexed.has(identity)) {
      throw new EngineFault(
        faultCode,
        `SaveEnvelope contains more than one ${label} for the same identity`,
        { identity_field: identityField, identity },
      );
    }
    indexed.set(identity, lock);
  }
  return indexed;
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "runtime.save.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
