import {
  CONTRACT_REF,
  EngineFault,
  expectJsonObject,
  expectProperty,
  expectString,
  type ContractValidator,
  type JsonObject,
  type JsonValue,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

import type {
  RulePluginAdapter,
  RulePluginRequestDocument,
} from "./rule-plugin-gateway.js";

export type RulePluginManifestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.rulePluginManifest
>;

/**
 * Trusted in-process RulePlugin module. Composition root must register explicitly.
 * No directory scan, download, default, or content-hardcoded modules.
 */
export interface RulePluginModuleV1 {
  readonly manifest: unknown;
  resolve(request: RulePluginRequestDocument): Promise<unknown>;
}

export interface RegisteredRulePluginModule {
  readonly module: RulePluginModuleV1;
  readonly manifest: RulePluginManifestDocument;
  readonly pluginLock: JsonObject;
  readonly implementationVersion: string;
}

export interface RulePluginDependencyIdentity {
  readonly package_id: string;
  readonly version: string;
  readonly integrity_sha256: string;
}

export interface RulePluginAbiRegistry {
  /**
   * Resolve ContentBundle DependencyLock identity to a registered module.
   * PluginLock.api_version comes only from the verified manifest (not DependencyLock).
   */
  requireModuleForDependency(
    dependency: RulePluginDependencyIdentity,
  ): RegisteredRulePluginModule;

  requireOperation(input: {
    readonly module: RegisteredRulePluginModule;
    readonly operationId: string;
    readonly operationKind: string;
  }): void;

  createAdapter(): RulePluginAdapter;
}

export interface RulePluginAbiRegistryDependencies {
  readonly contracts: ContractValidator;
  readonly modules: readonly RulePluginModuleV1[];
}

export function createRulePluginAbiRegistry(
  dependencies: RulePluginAbiRegistryDependencies,
): RulePluginAbiRegistry {
  return new DefaultRulePluginAbiRegistry(dependencies);
}

class DefaultRulePluginAbiRegistry implements RulePluginAbiRegistry {
  readonly #byPluginLockKey = new Map<string, RegisteredRulePluginModule>();
  readonly #byIntegrityKey = new Map<string, RegisteredRulePluginModule>();
  readonly #operationsByModule = new Map<
    RegisteredRulePluginModule,
    ReadonlyMap<string, string>
  >();

  public constructor(dependencies: RulePluginAbiRegistryDependencies) {
    for (const module of dependencies.modules) {
      this.#register(dependencies.contracts, module);
    }
  }

  public requireModuleForDependency(
    dependency: RulePluginDependencyIdentity,
  ): RegisteredRulePluginModule {
    const integrityKey = integrityKeyOf(
      dependency.package_id,
      dependency.integrity_sha256,
    );
    const registered = this.#byIntegrityKey.get(integrityKey);
    if (registered === undefined) {
      throw new EngineFault(
        "rule_plugin.abi.module_not_registered",
        "No RulePlugin module is registered for the ContentBundle dependency lock",
        {
          package_id: dependency.package_id,
          version: dependency.version,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }

    if (registered.implementationVersion !== dependency.version) {
      throw new EngineFault(
        "rule_plugin.abi.dependency_version_mismatch",
        "DependencyLock.version must equal registered manifest.implementation_version",
        {
          package_id: dependency.package_id,
          dependency_version: dependency.version,
          implementation_version: registered.implementationVersion,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }

    return registered;
  }

  public requireOperation(input: {
    readonly module: RegisteredRulePluginModule;
    readonly operationId: string;
    readonly operationKind: string;
  }): void {
    const operations = this.#operationsByModule.get(input.module);
    if (operations === undefined) {
      throw new EngineFault(
        "rule_plugin.abi.module_not_registered",
        "RulePlugin module must be the registered object returned by this ABI registry",
        {
          plugin_id: expectString(
            input.module.pluginLock,
            "plugin_id",
            "PluginLock",
          ),
        },
      );
    }

    const declaredKind = operations.get(input.operationId);
    if (declaredKind === undefined) {
      throw new EngineFault(
        "rule_plugin.abi.operation_not_declared",
        "operation_id is not declared on the registered RulePlugin manifest",
        {
          plugin_id: expectString(
            input.module.pluginLock,
            "plugin_id",
            "PluginLock",
          ),
          operation_id: input.operationId,
          expected_operation_kind: input.operationKind,
        },
      );
    }
    if (declaredKind !== input.operationKind) {
      throw new EngineFault(
        "rule_plugin.abi.operation_kind_mismatch",
        "Declared operation_kind does not match the required kind",
        {
          plugin_id: expectString(
            input.module.pluginLock,
            "plugin_id",
            "PluginLock",
          ),
          operation_id: input.operationId,
          declared_operation_kind: declaredKind,
          expected_operation_kind: input.operationKind,
        },
      );
    }
  }

  public createAdapter(): RulePluginAdapter {
    return {
      resolve: (request: RulePluginRequestDocument): Promise<unknown> => {
        return this.#resolve(request);
      },
    };
  }

  #register(
    contracts: ContractValidator,
    module: RulePluginModuleV1,
  ): void {
    const manifest = contracts.assertObject(
      CONTRACT_REF.rulePluginManifest,
      module.manifest,
    );
    const manifestValue = manifest.value;
    const pluginId = expectString(manifestValue, "plugin_id", "RulePluginManifest");
    const apiVersion = expectString(
      manifestValue,
      "api_version",
      "RulePluginManifest",
    );
    const implementationVersion = expectString(
      manifestValue,
      "implementation_version",
      "RulePluginManifest",
    );
    const implementationDigest = expectString(
      manifestValue,
      "implementation_digest",
      "RulePluginManifest",
    );

    const pluginLock: JsonObject = Object.freeze({
      plugin_id: pluginId,
      api_version: apiVersion,
      implementation_digest: implementationDigest,
    });

    const operationsList = asObjectArray(
      expectProperty(manifestValue, "operations", "RulePluginManifest"),
      "RulePluginManifest.operations",
    );
    const operations = new Map<string, string>();
    for (const operation of operationsList) {
      const operationId = expectString(
        operation,
        "operation_id",
        "RulePluginManifest.operations",
      );
      const operationKind = expectString(
        operation,
        "operation_kind",
        "RulePluginManifest.operations",
      );
      if (operations.has(operationId)) {
        throw new EngineFault(
          "rule_plugin.abi.duplicate_operation",
          `Duplicate operation_id ${operationId} in RulePlugin manifest`,
          { plugin_id: pluginId, operation_id: operationId },
        );
      }
      operations.set(operationId, operationKind);
    }

    const registered: RegisteredRulePluginModule = Object.freeze({
      module,
      manifest,
      pluginLock,
      implementationVersion,
    });

    const lockKey = pluginLockKeyOf(pluginLock);
    if (this.#byPluginLockKey.has(lockKey)) {
      throw new EngineFault(
        "rule_plugin.abi.duplicate_plugin_lock",
        "RulePlugin module already registered with the same PluginLock",
        pluginLock,
      );
    }

    const integrityKey = integrityKeyOf(pluginId, implementationDigest);
    if (this.#byIntegrityKey.has(integrityKey)) {
      throw new EngineFault(
        "rule_plugin.abi.duplicate_implementation",
        "RulePlugin module already registered with the same plugin_id and implementation_digest",
        {
          plugin_id: pluginId,
          implementation_digest: implementationDigest,
        },
      );
    }

    this.#byPluginLockKey.set(lockKey, registered);
    this.#byIntegrityKey.set(integrityKey, registered);
    this.#operationsByModule.set(registered, operations);
  }

  async #resolve(request: RulePluginRequestDocument): Promise<unknown> {
    const pluginLock = expectJsonObject(
      expectProperty(request.value, "plugin_lock", "RulePluginRequest"),
      "RulePluginRequest.plugin_lock",
    );
    const operationId = expectString(
      request.value,
      "operation_id",
      "RulePluginRequest",
    );
    const operationKind = expectString(
      request.value,
      "operation_kind",
      "RulePluginRequest",
    );

    const lockKey = pluginLockKeyOf(pluginLock);
    const registered = this.#byPluginLockKey.get(lockKey);
    if (registered === undefined) {
      throw new EngineFault(
        "rule_plugin.abi.plugin_lock_unregistered",
        "RulePluginRequest.plugin_lock is not registered in the ABI host",
        {
          plugin_id: expectString(pluginLock, "plugin_id", "PluginLock"),
          api_version: expectString(pluginLock, "api_version", "PluginLock"),
          implementation_digest: expectString(
            pluginLock,
            "implementation_digest",
            "PluginLock",
          ),
        },
      );
    }

    this.requireOperation({
      module: registered,
      operationId,
      operationKind,
    });

    return registered.module.resolve(request);
  }
}

function pluginLockKeyOf(pluginLock: JsonObject): string {
  return [
    expectString(pluginLock, "plugin_id", "PluginLock"),
    expectString(pluginLock, "api_version", "PluginLock"),
    expectString(pluginLock, "implementation_digest", "PluginLock"),
  ].join("\u0000");
}

function integrityKeyOf(pluginId: string, implementationDigest: string): string {
  return `${pluginId}\u0000${implementationDigest}`;
}

function asObjectArray(value: JsonValue, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EngineFault(
      "rule_plugin.abi.shape",
      `${path} must be an array`,
      { path },
    );
  }
  return value.map((entry, index) =>
    expectJsonObject(entry as JsonValue, `${path}[${index}]`),
  );
}
