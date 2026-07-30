import {
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  jsonEquals,
  type JsonObject,
  type JsonValue,
  type WorldContentLockDocument,
} from "@luoxia/contracts-runtime/portable";

import type {
  ContentRuntimeCatalog,
  StateMachineCatalogEntry,
  WorldContentBinding,
} from "./content-runtime-catalog.js";

export interface RegisteredStateMachineContract {
  readonly definition: JsonObject;
  readonly initialState: JsonObject;
  requireState(stateId: string): JsonObject;
  resolveTransition(
    instance: JsonObject,
    transitionId: string,
  ): ResolvedStateMachineTransition;
  listOutgoingTransitions(stateId: string): readonly JsonObject[];
}

export interface ResolvedStateMachineTransition {
  readonly transition: JsonObject;
  readonly toState: JsonObject;
}

/**
 * Sole content-aware StateMachine contract authority.
 *
 * It resolves only original ContentBundle objects through ContentRuntimeCatalog;
 * runtime instances never carry or reconstruct a second machine definition.
 */
export interface StateMachineContractAuthority {
  resolveLockedMachine(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly machine: JsonObject;
  }): RegisteredStateMachineContract;
  resolveBoundMachine(input: {
    readonly contentBinding: WorldContentBinding;
    readonly machine: JsonObject;
  }): RegisteredStateMachineContract;
  assertBoundInstance(input: {
    readonly contentBinding: WorldContentBinding;
    readonly worldId: string;
    readonly instance: JsonObject;
  }): RegisteredStateMachineContract;
  assertLockedInstance(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly instance: JsonObject;
  }): RegisteredStateMachineContract;
  resolveLockedTransition(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly instance: JsonObject;
    readonly transitionId: string;
  }): ResolvedStateMachineTransition;
  /**
   * Content-aware save validation hook. RuntimeSaveCompatibility may call this
   * after Schema validation to verify every instance against the exact lock.
   */
  assertLockedWorldStateInstances(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly worldState: JsonObject;
  }): void;
}

export interface StateMachineContractAuthorityDependencies {
  readonly catalog: ContentRuntimeCatalog;
}

export function createStateMachineContractAuthority(
  dependencies: StateMachineContractAuthorityDependencies,
): StateMachineContractAuthority {
  return new DefaultStateMachineContractAuthority(dependencies.catalog);
}

class DefaultStateMachineContractAuthority
  implements StateMachineContractAuthority
{
  readonly #catalog: ContentRuntimeCatalog;

  public constructor(catalog: ContentRuntimeCatalog) {
    this.#catalog = catalog;
  }

  public resolveLockedMachine(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly machine: JsonObject;
  }): RegisteredStateMachineContract {
    return this.resolveBoundMachine({
      contentBinding: this.#catalog.resolveWorldContentBinding(
        input.worldContentLock,
      ),
      machine: input.machine,
    });
  }

  public resolveBoundMachine(input: {
    readonly contentBinding: WorldContentBinding;
    readonly machine: JsonObject;
  }): RegisteredStateMachineContract {
    const ref = parseStateMachineRef(input.machine);
    if (
      ref.bundleId !== input.contentBinding.packId ||
      ref.bundleDigest !== input.contentBinding.bundleDigest
    ) {
      throw fault(
        "world.state_machine.bundle_lock_mismatch",
        "State machine CatalogRef must belong to the locked world ContentBundle",
        {
          bundle_id: ref.bundleId,
          bundle_digest: ref.bundleDigest,
          locked_bundle_id: input.contentBinding.packId,
          locked_bundle_digest: input.contentBinding.bundleDigest,
          machine_id: ref.localId,
        },
      );
    }

    const indexed = this.#catalog.findStateMachineCatalogEntry({
      bundle_id: ref.bundleId,
      bundle_digest: ref.bundleDigest,
      catalog_kind: "state_machine",
      local_id: ref.localId,
    });
    if (indexed === undefined) {
      throw fault(
        "world.state_machine.definition_missing",
        "State machine CatalogRef does not resolve in ContentRuntimeCatalog",
        {
          bundle_id: ref.bundleId,
          bundle_digest: ref.bundleDigest,
          machine_id: ref.localId,
        },
      );
    }

    const lockedMatches =
      input.contentBinding.initialization.stateMachines.filter(
        (definition) =>
          expectString(
            definition,
            "machine_id",
            "StateMachineDefinition",
          ) === ref.localId,
      );
    if (
      lockedMatches.length !== 1 ||
      !jsonEquals(lockedMatches[0] as JsonObject, indexed.definition)
    ) {
      throw fault(
        "world.state_machine.definition_not_locked",
        "State machine definition is not an exact member of the locked WorldContentBinding",
        {
          bundle_id: ref.bundleId,
          bundle_digest: ref.bundleDigest,
          machine_id: ref.localId,
          locked_matches: lockedMatches.length,
        },
      );
    }

    const worldDefinitionId = expectString(
      input.contentBinding.worldDefinition,
      "world_id",
      "WorldDefinition",
    );
    const machineWorldId = expectString(
      indexed.definition,
      "world_id",
      "StateMachineDefinition",
    );
    if (machineWorldId !== worldDefinitionId) {
      throw fault(
        "world.state_machine.definition_world_mismatch",
        "State machine definition must belong to the locked WorldDefinition",
        {
          machine_id: ref.localId,
          machine_world_id: machineWorldId,
          world_definition_id: worldDefinitionId,
        },
      );
    }

    return createRegisteredContract(indexed);
  }

  public assertBoundInstance(input: {
    readonly contentBinding: WorldContentBinding;
    readonly worldId: string;
    readonly instance: JsonObject;
  }): RegisteredStateMachineContract {
    const machine = this.resolveBoundMachine({
      contentBinding: input.contentBinding,
      machine: expectJsonObject(
        expectProperty(
          input.instance,
          "machine",
          "StateMachineInstanceState",
        ),
        "StateMachineInstanceState.machine",
      ),
    });
    assertOwnerMatchesMachine(input.instance, machine.definition, input.worldId);
    machine.requireState(
      expectString(input.instance, "state_id", "StateMachineInstanceState"),
    );
    return machine;
  }

  public assertLockedInstance(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly instance: JsonObject;
  }): RegisteredStateMachineContract {
    return this.assertBoundInstance({
      contentBinding: this.#catalog.resolveWorldContentBinding(
        input.worldContentLock,
      ),
      worldId: input.worldId,
      instance: input.instance,
    });
  }

  public resolveLockedTransition(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly instance: JsonObject;
    readonly transitionId: string;
  }): ResolvedStateMachineTransition {
    const machine = this.assertLockedInstance(input);
    return machine.resolveTransition(input.instance, input.transitionId);
  }

  public assertLockedWorldStateInstances(input: {
    readonly worldContentLock: WorldContentLockDocument;
    readonly worldId: string;
    readonly worldState: JsonObject;
  }): void {
    const instances = asObjectArray(
      expectProperty(input.worldState, "state_machines", "WorldState"),
      "WorldState.state_machines",
    );
    for (const instance of instances) {
      this.assertLockedInstance({
        worldContentLock: input.worldContentLock,
        worldId: input.worldId,
        instance,
      });
    }
  }
}

function createRegisteredContract(
  indexed: StateMachineCatalogEntry,
): RegisteredStateMachineContract {
  const machineId = expectString(
    indexed.definition,
    "machine_id",
    "StateMachineDefinition",
  );
  const requireState = (stateId: string): JsonObject => {
    const state = indexed.findState(stateId);
    if (state === undefined) {
      throw fault(
        "world.state_machine.state_missing",
        "State ID is not present in the locked StateMachineDefinition",
        { machine_id: machineId, state_id: stateId },
      );
    }
    return state;
  };
  const requireTransition = (transitionId: string): JsonObject => {
    const transition = indexed.findTransition(transitionId);
    if (transition === undefined) {
      throw fault(
        "world.state_machine.transition_missing",
        "Transition ID is not present in the locked StateMachineDefinition",
        { machine_id: machineId, transition_id: transitionId },
      );
    }
    return transition;
  };
  const listOutgoingTransitions = (
    stateId: string,
  ): readonly JsonObject[] => {
    requireState(stateId);
    const outgoing = indexed.listOutgoingTransitions(stateId);
    if (outgoing === undefined) {
      throw fault(
        "world.state_machine.outgoing_index_missing",
        "Locked StateMachineDefinition has no outgoing index for a known state",
        { machine_id: machineId, state_id: stateId },
      );
    }
    return outgoing;
  };
  const resolveRegisteredTransition = (
    instance: JsonObject,
    transitionId: string,
  ): ResolvedStateMachineTransition => {
    const currentStateId = expectString(
      instance,
      "state_id",
      "StateMachineInstanceState",
    );
    requireState(currentStateId);
    const transition = requireTransition(transitionId);
    const transitionFromStateId = expectString(
      transition,
      "from_state_id",
      "MachineTransitionDefinition",
    );
    if (transitionFromStateId !== currentStateId) {
      throw fault(
        "world.state_machine.transition_not_outgoing",
        "State machine transition must leave the instance current state",
        {
          instance_id: expectString(
            instance,
            "instance_id",
            "StateMachineInstanceState",
          ),
          transition_id: transitionId,
          current_state_id: currentStateId,
          transition_from_state_id: transitionFromStateId,
        },
      );
    }
    return Object.freeze({
      transition,
      toState: requireState(
        expectString(
          transition,
          "to_state_id",
          "MachineTransitionDefinition",
        ),
      ),
    });
  };
  const initialStateId = expectString(
    indexed.definition,
    "initial_state_id",
    "StateMachineDefinition",
  );
  return Object.freeze({
    definition: indexed.definition,
    initialState: requireState(initialStateId),
    requireState,
    resolveTransition: resolveRegisteredTransition,
    listOutgoingTransitions,
  });
}

function parseStateMachineRef(machine: JsonObject): {
  readonly bundleId: string;
  readonly bundleDigest: string;
  readonly localId: string;
} {
  const catalogKind = expectString(machine, "catalog_kind", "CatalogRef");
  if (catalogKind !== "state_machine") {
    throw fault(
      "world.state_machine.catalog_kind",
      "State machine reference requires catalog_kind=state_machine",
      { catalog_kind: catalogKind },
    );
  }
  return Object.freeze({
    bundleId: expectString(machine, "bundle_id", "CatalogRef"),
    bundleDigest: expectString(machine, "bundle_digest", "CatalogRef"),
    localId: expectString(machine, "local_id", "CatalogRef"),
  });
}

function assertOwnerMatchesMachine(
  instance: JsonObject,
  definition: JsonObject,
  worldId: string,
): void {
  const owner = expectJsonObject(
    expectProperty(instance, "owner", "StateMachineInstanceState"),
    "StateMachineInstanceState.owner",
  );
  const ownerKind = expectString(owner, "owner_kind", "StateMachineOwner");
  const machineScope = expectString(
    definition,
    "machine_scope",
    "StateMachineDefinition",
  );
  if (ownerKind !== machineScope) {
    throw fault(
      "world.state_machine.owner_scope_mismatch",
      "State machine owner kind must match StateMachineDefinition.machine_scope",
      {
        instance_id: expectString(
          instance,
          "instance_id",
          "StateMachineInstanceState",
        ),
        owner_kind: ownerKind,
        machine_scope: machineScope,
      },
    );
  }
  if (
    ownerKind === "world" &&
    expectString(owner, "world_id", "StateMachineOwner") !== worldId
  ) {
    throw fault(
      "world.state_machine.owner_world_mismatch",
      "World-owned state machine must reference the runtime world",
      {
        instance_id: expectString(
          instance,
          "instance_id",
          "StateMachineInstanceState",
        ),
        owner_world_id: expectString(
          owner,
          "world_id",
          "StateMachineOwner",
        ),
        world_id: worldId,
      },
    );
  }
  if (ownerKind === "character") {
    expectString(owner, "entity_id", "StateMachineOwner");
  }
}

function asObjectArray(
  value: JsonValue,
  path: string,
): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw fault(
      "world.state_machine.array_shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry, `${path}[${index}]`),
  );
}

function fault(code: string, message: string, details: JsonObject): EngineFault {
  return new EngineFault(code, message, details);
}
