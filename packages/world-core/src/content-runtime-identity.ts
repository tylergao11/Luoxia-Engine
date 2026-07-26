export const CONTENT_RUNTIME_IDENTITY_KINDS = [
  "entity",
  "relation",
  "state_machine_binding",
] as const;

export type ContentRuntimeIdentityKind =
  (typeof CONTENT_RUNTIME_IDENTITY_KINDS)[number];

export interface ContentRuntimeIdentityInput {
  readonly worldId: string;
  readonly packId: string;
  readonly kind: ContentRuntimeIdentityKind;
  readonly localId: string;
}

/**
 * Sole deterministic ContentBundle-local Identifier → runtime UUID authority.
 * Implementations must use the RFC 9562 UUIDv5 algorithm fixed by the v1
 * architecture contract; persisted mapping tables are not permitted.
 */
export interface ContentRuntimeIdentityMapper {
  toRuntimeUuid(input: ContentRuntimeIdentityInput): string;
}
