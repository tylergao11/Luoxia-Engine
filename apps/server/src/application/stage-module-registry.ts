import {
  CONTRACT_REF,
  EngineFault,
  indexStageModuleManifest,
  type ContractValidator,
  type IndexedStageModuleManifest,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type StageModuleLockDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.stageModuleLock
>;

/**
 * Identity derived only from a validated ContentBundle DependencyLock.
 * Not an external input model or second protocol surface.
 */
export interface StageModuleDependencyIdentity {
  readonly package_id: string;
  readonly version: string;
  readonly integrity_sha256: string;
}

export interface RegisteredStageModule {
  readonly indexed: IndexedStageModuleManifest;
  readonly stageModuleLock: StageModuleLockDocument;
}

export interface StageModuleRegistry {
  /**
   * Resolve ContentBundle DependencyLock identity to a registered module.
   * package_id → module_id, version → implementation_version,
   * integrity_sha256 → implementation_digest.
   */
  requireModuleForDependency(
    dependency: StageModuleDependencyIdentity,
  ): RegisteredStageModule;

  requireScene(module: RegisteredStageModule, sceneId: string): void;

  /**
   * Expand required root modules into a dependency-first activation plan.
   * Each root must be an object returned by this registry. Result elements are
   * the same RegisteredStageModule instances (no copied manifests/locks/indexes).
   * Modules ready in the same step keep manifestCandidates registration order.
   */
  planRequiredModules(
    roots: readonly RegisteredStageModule[],
  ): readonly RegisteredStageModule[];

  /** Same registered objects; frozen list, not a second mutable copy. */
  readonly registeredModules: readonly RegisteredStageModule[];
}

export interface StageModuleRegistryDependencies {
  readonly contracts: ContractValidator;
  readonly manifestCandidates: readonly unknown[];
}

/**
 * Schema-validated StageModule manifest registry for Content Activation.
 * Proves dependency + scene contract availability only; does not load entrypoints
 * or execute StageModule artifacts.
 * Single-manifest field extraction uses portable indexStageModuleManifest.
 * Graph rules read only #byModuleId + indexed.dependsOnModuleIds (no second adjacency truth).
 */
export function createStageModuleRegistry(
  dependencies: StageModuleRegistryDependencies,
): StageModuleRegistry {
  return new DefaultStageModuleRegistry(dependencies);
}

class DefaultStageModuleRegistry implements StageModuleRegistry {
  readonly #byModuleId = new Map<string, RegisteredStageModule>();
  readonly #byIntegrityKey = new Map<string, RegisteredStageModule>();
  readonly #registeredModules: readonly RegisteredStageModule[];

  public constructor(dependencies: StageModuleRegistryDependencies) {
    for (const [index, candidate] of dependencies.manifestCandidates.entries()) {
      this.#register(dependencies.contracts, candidate, index);
    }
    this.#assertDependencyGraph();
    this.#registeredModules = Object.freeze([...this.#byModuleId.values()]);
  }

  public get registeredModules(): readonly RegisteredStageModule[] {
    return this.#registeredModules;
  }

  public requireModuleForDependency(
    dependency: StageModuleDependencyIdentity,
  ): RegisteredStageModule {
    const integrityKey = integrityKeyOf(
      dependency.package_id,
      dependency.integrity_sha256,
    );
    const registered = this.#byIntegrityKey.get(integrityKey);
    if (registered === undefined) {
      throw new EngineFault(
        "stage_module.registry.module_not_registered",
        "No StageModule manifest is registered for the ContentBundle dependency lock",
        {
          package_id: dependency.package_id,
          version: dependency.version,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }

    if (registered.indexed.implementationVersion !== dependency.version) {
      throw new EngineFault(
        "stage_module.registry.dependency_version_mismatch",
        "DependencyLock.version must equal registered manifest.implementation_version",
        {
          package_id: dependency.package_id,
          dependency_version: dependency.version,
          implementation_version: registered.indexed.implementationVersion,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }

    return registered;
  }

  public requireScene(module: RegisteredStageModule, sceneId: string): void {
    const registered = this.#requireRegisteredObject(module);
    const moduleId = registered.indexed.moduleId;

    if (!registered.indexed.hasScene(sceneId)) {
      throw new EngineFault(
        "stage_module.registry.scene_not_declared",
        "scene_id is not declared on the registered StageModule manifest",
        {
          module_id: moduleId,
          scene_id: sceneId,
        },
      );
    }
  }

  public planRequiredModules(
    roots: readonly RegisteredStageModule[],
  ): readonly RegisteredStageModule[] {
    if (roots.length === 0) {
      return Object.freeze([]);
    }

    const planIds = new Set<string>();
    for (const root of roots) {
      const registered = this.#requireRegisteredObject(root);
      this.#collectTransitiveModuleIds(registered.indexed.moduleId, planIds);
    }

    return Object.freeze(this.#topologicalPlan(planIds));
  }

  #register(
    contracts: ContractValidator,
    candidate: unknown,
    candidateIndex: number,
  ): void {
    const indexed = indexStageModuleManifest(contracts, candidate);

    if (this.#byModuleId.has(indexed.moduleId)) {
      throw new EngineFault(
        "stage_module.registry.duplicate_module_id",
        "StageModule module_id appears more than once in activation input",
        {
          module_id: indexed.moduleId,
          candidate_index: candidateIndex,
        },
      );
    }

    const stageModuleLock = contracts.assertObject(
      CONTRACT_REF.stageModuleLock,
      Object.freeze({
        module_id: indexed.moduleId,
        api_version: indexed.apiVersion,
        implementation_version: indexed.implementationVersion,
        implementation_digest: indexed.implementationDigest,
      }),
    );

    const registered: RegisteredStageModule = Object.freeze({
      indexed,
      stageModuleLock,
    });

    const integrityKey = integrityKeyOf(
      indexed.moduleId,
      indexed.implementationDigest,
    );
    this.#byModuleId.set(indexed.moduleId, registered);
    this.#byIntegrityKey.set(integrityKey, registered);
  }

  #requireRegisteredObject(module: RegisteredStageModule): RegisteredStageModule {
    if (!this.#registeredModules.includes(module)) {
      throw new EngineFault(
        "stage_module.registry.module_not_registered",
        "StageModule must be the registered object returned by this registry",
      );
    }
    return module;
  }

  #collectTransitiveModuleIds(
    moduleId: string,
    into: Set<string>,
  ): void {
    if (into.has(moduleId)) {
      return;
    }
    into.add(moduleId);
    const registered = this.#byModuleId.get(moduleId);
    if (registered === undefined) {
      throw new EngineFault(
        "stage_module.registry.unknown_dependency",
        "depends_on_module_ids references a module_id that is not registered",
        { depends_on_module_id: moduleId },
      );
    }
    for (const dependencyId of registered.indexed.dependsOnModuleIds) {
      this.#collectTransitiveModuleIds(dependencyId, into);
    }
  }

  /**
   * Construction-time gate over the full registered set.
   * Reads only #byModuleId + indexed.dependsOnModuleIds (no stored adjacency map).
   */
  #assertDependencyGraph(): void {
    for (const [moduleId, registered] of this.#byModuleId) {
      for (const dependencyId of registered.indexed.dependsOnModuleIds) {
        if (dependencyId === moduleId) {
          throw new EngineFault(
            "stage_module.registry.self_dependency",
            "StageModule depends_on_module_ids must not include the module itself",
            { module_id: moduleId },
          );
        }
        if (!this.#byModuleId.has(dependencyId)) {
          throw new EngineFault(
            "stage_module.registry.unknown_dependency",
            "depends_on_module_ids references a module_id that is not registered",
            {
              module_id: moduleId,
              depends_on_module_id: dependencyId,
            },
          );
        }
      }
    }

    this.#assertNoCycles(new Set(this.#byModuleId.keys()));
  }

  #assertNoCycles(moduleIds: ReadonlySet<string>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];

    const visit = (moduleId: string): void => {
      if (visited.has(moduleId) || !moduleIds.has(moduleId)) {
        return;
      }
      if (visiting.has(moduleId)) {
        const cycleStart = path.indexOf(moduleId);
        const cycle =
          cycleStart === -1
            ? [...path, moduleId]
            : [...path.slice(cycleStart), moduleId];
        throw new EngineFault(
          "stage_module.registry.dependency_cycle",
          "StageModule depends_on_module_ids graph contains a cycle",
          {
            cycle: Object.freeze([...cycle]),
          },
        );
      }

      visiting.add(moduleId);
      path.push(moduleId);
      const registered = this.#byModuleId.get(moduleId);
      if (registered !== undefined) {
        for (const dependencyId of registered.indexed.dependsOnModuleIds) {
          if (moduleIds.has(dependencyId)) {
            visit(dependencyId);
          }
        }
      }
      path.pop();
      visiting.delete(moduleId);
      visited.add(moduleId);
    };

    for (const moduleId of this.#byModuleId.keys()) {
      if (moduleIds.has(moduleId)) {
        visit(moduleId);
      }
    }
  }

  /**
   * Dependency-first plan for a module-id set.
   * Registration order breaks ties between modules ready in the same step.
   * Elements are the original RegisteredStageModule objects.
   */
  #topologicalPlan(
    planIds: ReadonlySet<string>,
  ): RegisteredStageModule[] {
    const remaining = new Set(planIds);
    const inDegree = new Map<string, number>();
    for (const moduleId of remaining) {
      const registered = this.#byModuleId.get(moduleId);
      if (registered === undefined) {
        throw new EngineFault(
          "stage_module.registry.module_not_registered",
          "No StageModule manifest is registered for module_id",
          { module_id: moduleId },
        );
      }
      let dependencyCount = 0;
      for (const dependencyId of registered.indexed.dependsOnModuleIds) {
        if (remaining.has(dependencyId)) {
          dependencyCount += 1;
        }
      }
      inDegree.set(moduleId, dependencyCount);
    }

    const plan: RegisteredStageModule[] = [];
    while (remaining.size > 0) {
      const ready = this.#registeredModules.filter((registered) => {
        const moduleId = registered.indexed.moduleId;
        return remaining.has(moduleId) && inDegree.get(moduleId) === 0;
      });
      if (ready.length === 0) {
        this.#assertNoCycles(remaining);
        throw new EngineFault(
          "stage_module.registry.dependency_cycle",
          "StageModule depends_on_module_ids graph contains a cycle",
          { remaining: Object.freeze([...remaining]) },
        );
      }

      for (const registered of ready) {
        const moduleId = registered.indexed.moduleId;
        remaining.delete(moduleId);
        plan.push(registered);
        for (const other of this.#registeredModules) {
          const otherId = other.indexed.moduleId;
          if (
            remaining.has(otherId) &&
            other.indexed.dependsOnModuleIds.includes(moduleId)
          ) {
            inDegree.set(otherId, (inDegree.get(otherId) ?? 0) - 1);
          }
        }
      }
    }

    return plan;
  }
}

function integrityKeyOf(moduleId: string, implementationDigest: string): string {
  return `${moduleId}\u0000${implementationDigest}`;
}
