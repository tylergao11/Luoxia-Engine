import {
  CONTRACT_REF,
  EngineFault,
  type ContractValidator,
  type JsonObject,
  type ValidatedJsonObject,
} from "@luoxia/contracts-runtime";

export type MaterializationRequestDocument = ValidatedJsonObject<
  typeof CONTRACT_REF.materializationRequest
>;

/**
 * Identity comes directly from one validated ContentBundle DependencyLock.
 * Provider credentials and transport configuration remain deployment-owned.
 */
export interface AssetProviderDependencyIdentity {
  readonly package_id: string;
  readonly version: string;
  readonly integrity_sha256: string;
}

export interface AssetProviderInvocation {
  readonly request: MaterializationRequestDocument;
  /** Exact active EntityState or DynamicDefinitionState from the same read. */
  readonly subject: JsonObject;
  readonly materializationProfile: JsonObject;
  readonly artProfile: JsonObject;
}

/**
 * Trusted deployment adapter. Its output remains untrusted AssetCandidate JSON.
 */
export interface AssetProviderAdapterV1 {
  readonly identity: AssetProviderDependencyIdentity;
  generate(input: AssetProviderInvocation): Promise<unknown>;
}

export interface RegisteredAssetProvider {
  readonly adapter: AssetProviderAdapterV1;
  readonly identity: AssetProviderDependencyIdentity;
}

export interface AssetProviderRegistry {
  requireAdapterForDependency(
    dependency: AssetProviderDependencyIdentity,
  ): RegisteredAssetProvider;

  readonly registeredProviders: readonly RegisteredAssetProvider[];
}

export interface AssetProviderRegistryDependencies {
  readonly contracts: ContractValidator;
  readonly adapters: readonly AssetProviderAdapterV1[];
}

export function createAssetProviderRegistry(
  dependencies: AssetProviderRegistryDependencies,
): AssetProviderRegistry {
  return new DefaultAssetProviderRegistry(dependencies);
}

class DefaultAssetProviderRegistry implements AssetProviderRegistry {
  readonly #byIntegrityKey = new Map<string, RegisteredAssetProvider>();
  readonly #registeredProviders: readonly RegisteredAssetProvider[];

  public constructor(dependencies: AssetProviderRegistryDependencies) {
    for (const [index, adapter] of dependencies.adapters.entries()) {
      const identity = validateIdentity(
        dependencies.contracts,
        adapter.identity,
      );
      const key = integrityKeyOf(
        identity.package_id,
        identity.integrity_sha256,
      );
      if (this.#byIntegrityKey.has(key)) {
        throw new EngineFault(
          "asset_provider.registry.duplicate_identity",
          "AssetProvider dependency identity appears more than once in deployment registration",
          {
            package_id: identity.package_id,
            version: identity.version,
            integrity_sha256: identity.integrity_sha256,
            adapter_index: index,
          },
        );
      }
      this.#byIntegrityKey.set(
        key,
        Object.freeze({
          adapter,
          identity,
        }),
      );
    }
    this.#registeredProviders = Object.freeze([
      ...this.#byIntegrityKey.values(),
    ]);
  }

  public get registeredProviders(): readonly RegisteredAssetProvider[] {
    return this.#registeredProviders;
  }

  public requireAdapterForDependency(
    dependency: AssetProviderDependencyIdentity,
  ): RegisteredAssetProvider {
    const registered = this.#byIntegrityKey.get(
      integrityKeyOf(
        dependency.package_id,
        dependency.integrity_sha256,
      ),
    );
    if (registered === undefined) {
      throw new EngineFault(
        "asset_provider.registry.adapter_not_registered",
        "No AssetProvider adapter is registered for the ContentBundle dependency lock",
        {
          package_id: dependency.package_id,
          version: dependency.version,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }
    if (registered.identity.version !== dependency.version) {
      throw new EngineFault(
        "asset_provider.registry.dependency_version_mismatch",
        "DependencyLock.version must equal the registered AssetProvider version",
        {
          package_id: dependency.package_id,
          dependency_version: dependency.version,
          registered_version: registered.identity.version,
          integrity_sha256: dependency.integrity_sha256,
        },
      );
    }
    return registered;
  }
}

function validateIdentity(
  contracts: ContractValidator,
  candidate: AssetProviderDependencyIdentity,
): AssetProviderDependencyIdentity {
  contracts.assert(
    CONTRACT_REF.namespacedIdentifier,
    candidate.package_id,
  );
  contracts.assert(CONTRACT_REF.semVer, candidate.version);
  contracts.assert(CONTRACT_REF.sha256, candidate.integrity_sha256);
  return Object.freeze({
    package_id: candidate.package_id,
    version: candidate.version,
    integrity_sha256: candidate.integrity_sha256,
  });
}

function integrityKeyOf(packageId: string, integritySha256: string): string {
  return `${packageId}\u0000${integritySha256}`;
}
