import { EngineFault } from "@luoxia/contracts-runtime";
import {
  CONTENT_RUNTIME_IDENTITY_KINDS,
  type ContentRuntimeIdentityInput,
  type ContentRuntimeIdentityMapper,
} from "@luoxia/world-core";

import { createUuidV5 } from "./uuid-v5.js";

/**
 * RFC 9562 UUIDv5 mapper for ContentBundle-local runtime identities.
 *
 * namespace = runtime world UUID
 * name      = UTF-8 pack_id + NUL + kind + NUL + local_id
 */
export function createNodeContentRuntimeIdentityMapper(): ContentRuntimeIdentityMapper {
  return Object.freeze({
    toRuntimeUuid(input: ContentRuntimeIdentityInput): string {
      assertClosedKind(input);
      return createUuidV5(
        input.worldId,
        `${input.packId}\u0000${input.kind}\u0000${input.localId}`,
      );
    },
  });
}

function assertClosedKind(input: ContentRuntimeIdentityInput): void {
  if (CONTENT_RUNTIME_IDENTITY_KINDS.some((kind) => kind === input.kind)) {
    return;
  }
  throw new EngineFault(
    "content.identity.kind_unknown",
    "Content runtime identity kind is not part of the v1 closed set",
    { kind: input.kind },
  );
}
