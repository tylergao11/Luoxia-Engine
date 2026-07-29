import type { ContractValidator } from "./contract-validator.js";
import { EngineFault } from "./fault.js";
import {
  expectJsonObject,
  expectProperty,
  expectString,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import { CONTRACT_REF } from "./references.js";
import type { ValidatedJsonObject } from "./validated-json.js";

export type StageModuleManifestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageModuleManifest
>;

export interface IndexedStageModuleScene {
  readonly document: JsonObject;
  readonly sceneId: string;
  readonly slotIds: readonly string[];
  readonly inputTypes: readonly string[];
  readonly outcomeTypes: readonly string[];
}

/**
 * Frozen single-manifest semantic index derived only from
 * contracts/client-bridge StageModuleManifest via Schema validation.
 * Does not own multi-module uniqueness or dependency DAG.
 */
export interface IndexedStageModuleManifest {
  readonly document: StageModuleManifestDocument;
  readonly moduleId: string;
  readonly apiVersion: string;
  readonly implementationVersion: string;
  readonly implementationDigest: string;
  readonly sceneIds: readonly string[];
  readonly scenes: readonly IndexedStageModuleScene[];
  readonly dependsOnModuleIds: readonly string[];
  hasScene(sceneId: string): boolean;
  requireScene(sceneId: string): IndexedStageModuleScene;
}

/**
 * Validate an untrusted StageModule manifest candidate and extract identity,
 * scene ids, and depends_on_module_ids for reuse by Server and Client Runtime Hosts.
 */
export function indexStageModuleManifest(
  contracts: ContractValidator,
  candidate: unknown,
): IndexedStageModuleManifest {
  const document = contracts.assertObject(
    CONTRACT_REF.stageModuleManifest,
    candidate,
  );
  const value = document.value;

  const moduleId = expectString(value, "module_id", "StageModuleManifest");
  const apiVersion = expectString(value, "api_version", "StageModuleManifest");
  const implementationVersion = expectString(
    value,
    "implementation_version",
    "StageModuleManifest",
  );
  const implementationDigest = expectString(
    value,
    "implementation_digest",
    "StageModuleManifest",
  );

  const scenes = asObjectArray(
    expectProperty(value, "scenes", "StageModuleManifest"),
    "StageModuleManifest.scenes",
  );
  const sceneIdList: string[] = [];
  const sceneIdSet = new Set<string>();
  const indexedScenes: IndexedStageModuleScene[] = [];
  for (const [sceneIndex, scene] of scenes.entries()) {
    const sceneId = expectString(
      scene,
      "scene_id",
      "StageModuleManifest.scenes",
    );
    if (sceneIdSet.has(sceneId)) {
      throw new EngineFault(
        "stage_module.manifest.duplicate_scene_id",
        "scene_id appears more than once within a StageModule manifest",
        {
          module_id: moduleId,
          scene_id: sceneId,
          scene_index: sceneIndex,
        },
      );
    }
    sceneIdSet.add(sceneId);
    sceneIdList.push(sceneId);
    indexedScenes.push(
      Object.freeze({
        document: scene,
        sceneId,
        slotIds: readStringArray(
          expectProperty(scene, "slot_ids", "StageModuleScene"),
          `StageModuleManifest.scenes[${sceneIndex}].slot_ids`,
        ),
        inputTypes: readStringArray(
          expectProperty(scene, "input_types", "StageModuleScene"),
          `StageModuleManifest.scenes[${sceneIndex}].input_types`,
        ),
        outcomeTypes: readStringArray(
          expectProperty(scene, "outcome_types", "StageModuleScene"),
          `StageModuleManifest.scenes[${sceneIndex}].outcome_types`,
        ),
      }),
    );
  }

  const dependsOnModuleIds = readDependsOnModuleIds(value, moduleId);
  const sceneIds = Object.freeze([...sceneIdList]);
  const frozenScenes = Object.freeze([...indexedScenes]);

  const indexed: IndexedStageModuleManifest = {
    document,
    moduleId,
    apiVersion,
    implementationVersion,
    implementationDigest,
    sceneIds,
    scenes: frozenScenes,
    dependsOnModuleIds,
    hasScene(sceneId: string): boolean {
      return sceneIdSet.has(sceneId);
    },
    requireScene(sceneId: string): IndexedStageModuleScene {
      const scene = frozenScenes.find((candidate) => candidate.sceneId === sceneId);
      if (scene === undefined) {
        throw new EngineFault(
          "stage_module.manifest.scene_not_declared",
          "scene_id is not declared on the StageModule manifest",
          {
            module_id: moduleId,
            scene_id: sceneId,
          },
        );
      }
      return scene;
    },
  };

  return Object.freeze(indexed);
}

function readDependsOnModuleIds(
  manifestValue: JsonObject,
  moduleId: string,
): readonly string[] {
  const raw = manifestValue["depends_on_module_ids"];
  if (raw === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(raw)) {
    throw new EngineFault(
      "stage_module.manifest.shape",
      "StageModuleManifest.depends_on_module_ids must be an array when present",
      { module_id: moduleId },
    );
  }

  const ids: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new EngineFault(
        "stage_module.manifest.shape",
        "depends_on_module_ids entries must be non-empty strings",
        {
          module_id: moduleId,
          dependency_index: index,
        },
      );
    }
    ids.push(entry);
  }
  return Object.freeze(ids);
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "stage_module.manifest.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}

function readStringArray(value: JsonValue, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "stage_module.manifest.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new EngineFault(
          "stage_module.manifest.shape",
          `${path}[${index}] must be a non-empty string`,
          { path: `${path}[${index}]` },
        );
      }
      return entry;
    }),
  );
}
