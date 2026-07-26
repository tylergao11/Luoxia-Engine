export type {
  ApplyPacketResultDocument,
  WorldAuthority,
} from "./world-authority.js";

/**
 * Public, implementation-free runtime ports used by ordinary Server business
 * and infrastructure modules. Composition constructors remain available only
 * from `@luoxia/world-core/composition`.
 */
export type * from "./composition.js";

export {
  CONTENT_RUNTIME_IDENTITY_KINDS,
  type ContentRuntimeIdentityInput,
  type ContentRuntimeIdentityKind,
  type ContentRuntimeIdentityMapper,
} from "./content-runtime-identity.js";

export { materializeContentFieldValues } from "./content-field-values.js";

