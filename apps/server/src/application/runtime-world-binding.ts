import type {
  ContentRuntimeCatalog,
  WorldContentBinding,
} from "@luoxia/world-core/composition";

import type {
  RuntimeWorldReader,
  RuntimeWorldRecord,
} from "./runtime-persistence.js";

/**
 * One authoritative world load: PostgreSQL RuntimeWorldRecord + Catalog WorldContentBinding.
 * Snapshot and lock come from a single readCurrent; content identity is never caller-supplied.
 */
export interface RuntimeWorldBinding {
  readonly record: RuntimeWorldRecord;
  readonly contentBinding: WorldContentBinding;
}

export interface RuntimeWorldBindingResolver {
  resolveCurrent(worldId: string): Promise<RuntimeWorldBinding>;
}

export interface RuntimeWorldBindingResolverDependencies {
  readonly worlds: RuntimeWorldReader;
  readonly catalog: ContentRuntimeCatalog;
}

/**
 * Sole Server composition helper that pairs RuntimeWorldReader with ContentRuntimeCatalog.
 * Does not copy snapshot, WorldContentLock, or WorldDefinition documents.
 */
export function createRuntimeWorldBindingResolver(
  dependencies: RuntimeWorldBindingResolverDependencies,
): RuntimeWorldBindingResolver {
  return new DefaultRuntimeWorldBindingResolver(dependencies);
}

class DefaultRuntimeWorldBindingResolver
  implements RuntimeWorldBindingResolver
{
  readonly #worlds: RuntimeWorldReader;
  readonly #catalog: ContentRuntimeCatalog;

  public constructor(dependencies: RuntimeWorldBindingResolverDependencies) {
    this.#worlds = dependencies.worlds;
    this.#catalog = dependencies.catalog;
  }

  public async resolveCurrent(worldId: string): Promise<RuntimeWorldBinding> {
    const record = await this.#worlds.readCurrent(worldId);
    const contentBinding = this.#catalog.resolveWorldContentBinding(
      record.worldContentLock,
    );
    return Object.freeze({
      record,
      contentBinding,
    });
  }
}
