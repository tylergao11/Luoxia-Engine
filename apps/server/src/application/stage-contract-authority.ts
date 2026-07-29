import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type ContractValidator,
  type IndexedStageModuleScene,
  type JsonObject,
  type JsonValue,
  type SaveEnvelopeDocument,
  type StageOutcomeTransitionKind,
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
  assertSaveOpenStagesAllowed(saveEnvelope: SaveEnvelopeDocument): void;

  requireOutcomeTransition(input: {
    readonly stageInstance: JsonObject;
    readonly outcomeType: string;
  }): StageOutcomeTransitionKind;

  assertAllowed(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
    readonly completionRules: readonly JsonObject[];
  }): StagePresentationContract;
}

export interface StageContractAuthorityDependencies {
  readonly contracts: ContractValidator;
  readonly catalog: ContentRuntimeCatalog;
  readonly stageModules: StageModuleRegistry;
}

export function createStageContractAuthority(
  dependencies: StageContractAuthorityDependencies,
): StageContractAuthority {
  return new DefaultStageContractAuthority(dependencies);
}

class DefaultStageContractAuthority implements StageContractAuthority {
  readonly #contracts: ContractValidator;
  readonly #catalog: ContentRuntimeCatalog;
  readonly #stageModules: StageModuleRegistry;

  public constructor(dependencies: StageContractAuthorityDependencies) {
    this.#contracts = dependencies.contracts;
    this.#catalog = dependencies.catalog;
    this.#stageModules = dependencies.stageModules;
  }

  public assertSaveOpenStagesAllowed(
    saveEnvelope: SaveEnvelopeDocument,
  ): void {
    const worldContentLock = this.#contracts.assertObject(
      CONTRACT_REF.worldContentLock,
      expectProperty(
        saveEnvelope.value,
        "world_content_lock",
        "SaveEnvelope",
      ),
    );
    const stageModuleLocks = objectArray(
      expectProperty(
        saveEnvelope.value,
        "stage_module_locks",
        "SaveEnvelope",
      ),
      "SaveEnvelope.stage_module_locks",
    );
    const worldState = expectJsonObject(
      expectProperty(
        saveEnvelope.value,
        "world_state",
        "SaveEnvelope",
      ),
      "SaveEnvelope.world_state",
    );
    for (const stage of objectArray(
      expectProperty(
        worldState,
        "stage_instances",
        "WorldState",
      ),
      "WorldState.stage_instances",
    )) {
      const stageInstanceId = expectString(
        stage,
        "stage_instance_id",
        "StageInstanceState",
      );
      const status = expectString(
        stage,
        "status",
        "StageInstanceState",
      );
      if (status === "closed") {
        continue;
      }
      if (status !== "open") {
        throw new EngineFault(
          "stage_contract.stage_status_invalid",
          "SaveEnvelope StageInstance has an unsupported status",
          {
            stage_instance_id: stageInstanceId,
            stage_status: status,
          },
        );
      }
      this.assertAllowed({
        worldContentLock,
        stageModuleLocks,
        stageModuleLock: expectJsonObject(
          expectProperty(
            stage,
            "stage_module_lock",
            "StageInstanceState",
          ),
          "StageInstanceState.stage_module_lock",
        ),
        sceneId: expectString(
          stage,
          "scene_id",
          "StageInstanceState",
        ),
        completionRules: objectArray(
          expectProperty(
            stage,
            "completion_rules",
            "StageInstanceState",
          ),
          "StageInstanceState.completion_rules",
        ),
      });
    }
  }

  public requireOutcomeTransition(input: {
    readonly stageInstance: JsonObject;
    readonly outcomeType: string;
  }): StageOutcomeTransitionKind {
    const registered = this.#stageModules.requireModuleForLock(
      expectJsonObject(
        expectProperty(
          input.stageInstance,
          "stage_module_lock",
          "StageInstanceState",
        ),
        "StageInstanceState.stage_module_lock",
      ),
    );
    const scene = this.#stageModules.requireScene(
      registered,
      expectString(
        input.stageInstance,
        "scene_id",
        "StageInstanceState",
      ),
    );
    return scene.requireOutcome(input.outcomeType).transitionKind;
  }

  public assertAllowed(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly stageModuleLocks: readonly JsonObject[];
    readonly stageModuleLock: JsonObject;
    readonly sceneId: string;
    readonly completionRules: readonly JsonObject[];
  }): StagePresentationContract {
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
    const presentation = this.#resolvePresentation(input);
    this.#assertCompletionRules(
      input.completionRules,
      presentation.content,
    );
    return presentation;
  }

  #assertCompletionRules(
    completionRules: readonly JsonObject[],
    content: WorldContentBinding,
  ): void {
    for (const [index, rule] of completionRules.entries()) {
      const bundleId = expectString(rule, "bundle_id", "RuleRef");
      const bundleDigest = expectString(
        rule,
        "bundle_digest",
        "RuleRef",
      );
      const ruleId = expectString(rule, "rule_id", "RuleRef");
      if (
        bundleId !== content.packId ||
        bundleDigest !== content.bundleDigest ||
        this.#catalog.resolveRuleEvaluationBinding({
          bundle_id: bundleId,
          bundle_digest: bundleDigest,
          rule_id: ruleId,
        }) === undefined
      ) {
        throw new EngineFault(
          "stage_contract.completion_rule_unresolved",
          "Stage completion RuleRef must resolve in the current locked root ContentBundle",
          {
            completion_rule_index: index,
            expected_bundle_id: content.packId,
            expected_bundle_digest: content.bundleDigest,
            actual_bundle_id: bundleId,
            actual_bundle_digest: bundleDigest,
            rule_id: ruleId,
          },
        );
      }
    }
  }

  #resolvePresentation(input: {
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

function objectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "stage_contract.array_expected",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
