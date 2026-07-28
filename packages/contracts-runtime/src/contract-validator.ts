import type { ValidatedJson, ValidatedJsonObject } from "./validated-json.js";
import type { JsonObject } from "./json.js";

export interface ContractValidator {
  readonly schemaIds: readonly string[];

  assert<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJson<TSchemaRef>;

  assertObject<const TSchemaRef extends string>(
    schemaRef: TSchemaRef,
    candidate: unknown,
  ): ValidatedJsonObject<TSchemaRef>;
}

/**
 * Read-only schema projection used by deployment adapters that must derive a
 * provider-native grammar from the formal contracts. The returned document is
 * standalone: every reachable external reference is rewritten into its local
 * `$defs`, so callers never maintain a second field model.
 */
export interface ContractSchemaExporter {
  exportStandaloneSchema(schemaRef: string): JsonObject;
}
