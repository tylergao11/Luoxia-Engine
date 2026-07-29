import {
  EngineFault,
  expectJsonObject,
  expectString,
  jsonEquals,
  type IndexedStageModuleScene,
  type JsonObject,
} from "@luoxia/contracts-runtime";
import type {
  ContentRuntimeCatalog,
  WorldContentBinding,
  WorldContentLockDocument,
} from "@luoxia/world-core/composition";

import type {
  RegisteredStageModule,
  StageModuleRegistry,
} from "./stage-module-registry.js";

export interface StagePresentationContract {
  readonly content: WorldContentBinding;
  readonly module: RegisteredStageModule;
  readonly scene: IndexedStageModuleScene;
  readonly bindings: readonly JsonObject[];
}

/**
 * Structurally compatible with World Core's StageOpenContractLookup port.
 * It also exposes the same proven content/manifest relationship to the
 * Server-only StageOpen presentation projector.
 */
export interface StageContractAuthority {
  assertAllowed(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
  }): void;

  resolvePresentation(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
  }): StagePresentationContract;
}

export interface StageContractAuthorityDependencies {
  readonly catalog: ContentRuntimeCatalog;
  readonly stageModules: StageModuleRegistry;
}

export function createStageContractAuthority(
  dependencies: StageContractAuthorityDependencies,
): StageContractAuthority {
  return new DefaultStageContractAuthority(dependencies);
}

class DefaultStageContractAuthority implements StageContractAuthority {
  readonly #catalog: ContentRuntimeCatalog;
  readonly #stageModules: StageModuleRegistry;

  public constructor(dependencies: StageContractAuthorityDependencies) {
    this.#catalog = dependencies.catalog;
    this.#stageModules = dependencies.stageModules;
  }

  public assertAllowed(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
  }): void {
    const matchingLocks = input.stageModuleLocks.filter((candidate) =>
      jsonEquals(candidate, input.stageModuleLock),
    );
    if (matchingLocks.length !== 1) {
      throw new EngineFault(
        "stage_contract.lock_not_saved",
        "StageOpenOp stage_module_lock must match exactly one lock in the current SaveEnvelope",
        {
          module_id: expectString(
            input.stageModuleLock,
            "module_id",
            "StageModuleLock",
          ),
          scene_id: input.sceneId,
          matches: matchingLocks.length,
        },
      );
    }
    this.resolvePresentation(input);
  }

  public resolvePresentation(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
  }): StagePresentationContract {
    const content = this.#catalog.resolveWorldContentBinding(
      input.worldContentLock,
    );
    const registered = this.#stageModules.requireModuleForLock(
      input.stageModuleLock,
    );
    const scene = this.#stageModules.requireScene(
      registered,
      input.sceneId,
    );
    const matchingBindings: JsonObject[] = [];
    let allowedByContent = false;

    const defaultStageValue = content.worldDefinition["default_stage"];
    if (defaultStageValue !== undefined) {
      allowedByContent = this.#stageRefMatches({
        worldContentLock: input.worldContentLock,
        stageRef: expectJsonObject(
          defaultStageValue,
          "WorldDefinition.default_stage",
        ),
        registered,
        sceneId: input.sceneId,
      });
    }

    for (const binding of content.presentation.bindings) {
      const stageRefValue = binding["stage"];
      if (stageRefValue === undefined) {
        continue;
      }
      const stageRef = expectJsonObject(stageRefValue, "PackBinding.stage");
      if (
        !this.#stageRefMatches({
          worldContentLock: input.worldContentLock,
          stageRef,
          registered,
          sceneId: input.sceneId,
        })
      ) {
        continue;
      }
      allowedByContent = true;
      const slotId = expectString(binding, "slot_id", "PackBinding");
      if (!scene.slotIds.includes(slotId)) {
        throw new EngineFault(
          "stage_contract.binding_slot_not_declared",
          "Stage PackBinding slot_id is not declared by the exact StageModule scene",
          {
            module_id: registered.indexed.moduleId,
            scene_id: input.sceneId,
            binding_id: expectString(
              binding,
              "binding_id",
              "PackBinding",
            ),
            slot_id: slotId,
          },
        );
      }
      matchingBindings.push(binding);
    }

    if (!allowedByContent) {
      throw new EngineFault(
        "stage_contract.scene_not_allowed",
        "Stage module and scene are not referenced by the current locked world content",
        {
          module_id: registered.indexed.moduleId,
          scene_id: input.sceneId,
        },
      );
    }

    return Object.freeze({
      content,
      module: registered,
      scene,
      bindings: Object.freeze(matchingBindings),
    });
  }

  #stageRefMatches(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageRef: JsonObject;
    readonly registered: RegisteredStageModule;
    readonly sceneId: string;
  }): boolean {
    if (
      expectString(input.stageRef, "scene_id", "StageRef") !==
      input.sceneId
    ) {
      return false;
    }
    const dependency =
      this.#catalog.resolveRequiredStageModuleDependency(
        input.worldContentLock,
        expectString(
          input.stageRef,
          "stage_module_dependency_id",
          "StageRef",
        ),
      );
    return (
      this.#stageModules.requireModuleForDependency({
        package_id: expectString(
          dependency,
          "package_id",
          "DependencyLock",
        ),
        version: expectString(dependency, "version", "DependencyLock"),
        integrity_sha256: expectString(
          dependency,
          "integrity_sha256",
          "DependencyLock",
        ),
      }) === input.registered
    );
  }
}
