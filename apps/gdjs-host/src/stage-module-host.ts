import {
  CONTRACT_REF,
  EngineFault,
  expectString,
  indexStageModuleManifest,
  type ContractValidator,
  type IndexedStageModuleManifest,
} from "@luoxia/contracts-runtime/portable";

import type { StageModuleRuntime } from "./stage-module.js";

export interface GdjsStageModuleHostDependencies {
  readonly contracts: ContractValidator;
  /**
   * Explicit composition-root StageModule runtimes only.
   * No directory scan, dynamic import, download, default, or built-in modules.
   */
  readonly modules: readonly StageModuleRuntime[];
}

export interface GdjsStageModuleHost {
  open(candidate: unknown): Promise<void>;
  update(candidate: unknown): Promise<void>;
  close(candidate: unknown): Promise<void>;
}

interface IndexedStageModule {
  readonly runtime: StageModuleRuntime;
  readonly indexed: IndexedStageModuleManifest;
}

type StageInstancePhase = "opening" | "open" | "updating" | "closing";

interface StageInstanceRegistration {
  readonly module: IndexedStageModule;
  readonly phase: StageInstancePhase;
}

/**
 * Client-side StageModule lifecycle scheduler for the GDJS Host adapter.
 * Uses portable indexStageModuleManifest for single-manifest semantics.
 * Does not load artifacts, interpret visible state, write WorldState, or own DAG.
 */
export function createGdjsStageModuleHost(
  dependencies: GdjsStageModuleHostDependencies,
): GdjsStageModuleHost {
  return new DefaultGdjsStageModuleHost(dependencies);
}

class DefaultGdjsStageModuleHost implements GdjsStageModuleHost {
  readonly #contracts: ContractValidator;
  readonly #byModuleId = new Map<string, IndexedStageModule>();
  readonly #instances = new Map<string, StageInstanceRegistration>();

  public constructor(dependencies: GdjsStageModuleHostDependencies) {
    this.#contracts = dependencies.contracts;
    for (const [index, runtime] of dependencies.modules.entries()) {
      this.#indexModule(runtime, index);
    }
  }

  public async open(candidate: unknown): Promise<void> {
    const message = this.#contracts.assertObject(
      CONTRACT_REF.stageOpen,
      candidate,
    );
    const value = message.value;
    const moduleId = expectString(value, "module_id", "StageOpen");
    const sceneId = expectString(value, "scene_id", "StageOpen");
    const stageInstanceId = expectString(
      value,
      "stage_instance_id",
      "StageOpen",
    );

    const indexed = this.#byModuleId.get(moduleId);
    if (indexed === undefined) {
      throw new EngineFault(
        "gdjs_host.stage.module_not_registered",
        "No StageModuleRuntime is registered for StageOpen.module_id",
        { module_id: moduleId, stage_instance_id: stageInstanceId },
      );
    }

    if (!indexed.indexed.hasScene(sceneId)) {
      throw new EngineFault(
        "gdjs_host.stage.scene_not_declared",
        "StageOpen.scene_id is not declared on the registered StageModule manifest",
        {
          module_id: moduleId,
          scene_id: sceneId,
          stage_instance_id: stageInstanceId,
        },
      );
    }

    if (this.#instances.has(stageInstanceId)) {
      throw new EngineFault(
        "gdjs_host.stage.duplicate_stage_instance",
        "stage_instance_id is already registered on this host",
        {
          module_id: moduleId,
          stage_instance_id: stageInstanceId,
        },
      );
    }

    const opening = registration(indexed, "opening");
    this.#instances.set(stageInstanceId, opening);
    try {
      await indexed.runtime.open(message);
      this.#instances.set(stageInstanceId, registration(indexed, "open"));
    } catch (error: unknown) {
      if (this.#instances.get(stageInstanceId) === opening) {
        this.#instances.delete(stageInstanceId);
      }
      throw error;
    }
  }

  public async update(candidate: unknown): Promise<void> {
    const message = this.#contracts.assertObject(
      CONTRACT_REF.stageUpdate,
      candidate,
    );
    const stageInstanceId = expectString(
      message.value,
      "stage_instance_id",
      "StageUpdate",
    );
    const registered = this.#requireOpenInstance(stageInstanceId);
    const updating = registration(registered.module, "updating");
    this.#instances.set(stageInstanceId, updating);
    try {
      await registered.module.runtime.update(message);
      if (this.#instances.get(stageInstanceId) === updating) {
        this.#instances.set(stageInstanceId, registered);
      }
    } catch (error: unknown) {
      if (this.#instances.get(stageInstanceId) === updating) {
        this.#instances.set(stageInstanceId, registered);
      }
      throw error;
    }
  }

  public async close(candidate: unknown): Promise<void> {
    const message = this.#contracts.assertObject(
      CONTRACT_REF.stageClose,
      candidate,
    );
    const stageInstanceId = expectString(
      message.value,
      "stage_instance_id",
      "StageClose",
    );
    const registered = this.#requireOpenInstance(stageInstanceId);
    const closing = registration(registered.module, "closing");
    this.#instances.set(stageInstanceId, closing);
    try {
      await registered.module.runtime.close(message);
      if (this.#instances.get(stageInstanceId) === closing) {
        this.#instances.delete(stageInstanceId);
      }
    } catch (error: unknown) {
      if (this.#instances.get(stageInstanceId) === closing) {
        this.#instances.set(stageInstanceId, registered);
      }
      throw error;
    }
  }

  #requireOpenInstance(stageInstanceId: string): StageInstanceRegistration {
    const registered = this.#instances.get(stageInstanceId);
    if (registered === undefined || registered.phase !== "open") {
      throw new EngineFault(
        "gdjs_host.stage.stage_instance_not_open",
        "stage_instance_id is not open on this GDJS StageModule host",
        {
          stage_instance_id: stageInstanceId,
          phase: registered?.phase ?? "absent",
        },
      );
    }
    return registered;
  }

  #indexModule(runtime: StageModuleRuntime, moduleIndex: number): void {
    const indexed = indexStageModuleManifest(
      this.#contracts,
      runtime.manifest.value,
    );

    if (this.#byModuleId.has(indexed.moduleId)) {
      throw new EngineFault(
        "gdjs_host.stage.duplicate_module_id",
        "StageModuleRuntime module_id appears more than once in host input",
        {
          module_id: indexed.moduleId,
          module_index: moduleIndex,
        },
      );
    }

    this.#byModuleId.set(
      indexed.moduleId,
      Object.freeze({
        runtime,
        indexed,
      }),
    );
  }
}

function registration(
  module: IndexedStageModule,
  phase: StageInstancePhase,
): StageInstanceRegistration {
  return Object.freeze({ module, phase });
}
